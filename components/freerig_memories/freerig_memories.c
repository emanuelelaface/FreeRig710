#include "freerig_memories.h"

#include <ctype.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "ft710_cat.h"

static const char *TAG = "freerig_mem";
static SemaphoreHandle_t s_mutex;
static freerig_memory_t s_cache[99];

static const char *mode_name(char code)
{
    switch (code) {
    case '1': return "LSB";
    case '2': return "USB";
    case '3': return "CW-U";
    case '4': return "FM";
    case '5': return "AM";
    case '6': return "RTTY-L";
    case '7': return "CW-L";
    case '8': return "DATA-L";
    case '9': return "RTTY-U";
    case 'A': return "DATA-FM";
    case 'B': return "FM-N";
    case 'C': return "DATA-U";
    case 'D': return "AM-N";
    case 'E': return "PSK";
    case 'F': return "DATA-FM-N";
    default: return NULL;
    }
}

static char mode_code(const char *name)
{
    static const struct {
        const char *name;
        char code;
    } map[] = {
        {"LSB", '1'}, {"USB", '2'}, {"CW-U", '3'}, {"FM", '4'}, {"AM", '5'},
        {"RTTY-L", '6'}, {"CW-L", '7'}, {"DATA-L", '8'}, {"RTTY-U", '9'},
        {"DATA-FM", 'A'}, {"FM-N", 'B'}, {"DATA-U", 'C'}, {"AM-N", 'D'},
        {"PSK", 'E'}, {"DATA-FM-N", 'F'},
    };
    if (name == NULL) return 0;
    for (size_t i = 0; i < sizeof(map) / sizeof(map[0]); ++i) {
        if (strcasecmp(name, map[i].name) == 0) return map[i].code;
    }
    return 0;
}

static bool parse_digits(const char *p, size_t n, int *out)
{
    int value = 0;
    for (size_t i = 0; i < n; ++i) {
        if (p[i] < '0' || p[i] > '9') return false;
        value = value * 10 + (p[i] - '0');
    }
    *out = value;
    return true;
}

static bool parse_memory_reply(int slot, const char *reply, freerig_memory_t *memory)
{
    if (reply == NULL || memory == NULL || strcmp(reply, "?;") == 0 ||
        strncmp(reply, "MR", 2) != 0 || strlen(reply) < 28) {
        return false;
    }

    memset(memory, 0, sizeof(*memory));
    memory->slot = slot;
    memcpy(memory->radio_channel, reply + 2, 3);
    memory->radio_channel[3] = '\0';

    int value = 0;
    if (!parse_digits(reply + 5, 9, &value) || value == 0) return false;
    memory->frequency_hz = (uint32_t)value;

    if ((reply[14] != '+' && reply[14] != '-') || !parse_digits(reply + 15, 4, &value)) {
        return false;
    }
    memory->clarifier_offset_hz = reply[14] == '-' ? -value : value;
    memory->rx_clarifier = reply[19] == '1';
    memory->tx_clarifier = reply[20] == '1';

    const char *mode = mode_name(reply[21]);
    if (mode == NULL || reply[21] == '0') return false;
    snprintf(memory->mode, sizeof(memory->mode), "%s", mode);

    if (!isdigit((unsigned char)reply[22]) || !isdigit((unsigned char)reply[23]) ||
        !parse_digits(reply + 24, 2, &value) || !isdigit((unsigned char)reply[26])) {
        return false;
    }
    memory->operating_state = reply[22] - '0';
    memory->ctcss_mode = reply[23] - '0';
    memory->ctcss_number = value;
    memory->repeater_shift = reply[26] - '0';
    memory->present = true;
    return true;
}

static void load_metadata(freerig_memory_t *memory)
{
    (void)freerig_config_get_memory_metadata(memory->slot,
                                              memory->category,
                                              sizeof(memory->category),
                                              memory->note,
                                              sizeof(memory->note));
}

static esp_err_t read_tag(int slot, freerig_memory_t *memory)
{
    char command[16];
    char reply[64];
    snprintf(command, sizeof(command), "MT%03d;", slot);
    esp_err_t err = ft710_cat_query(command, reply, sizeof(reply), 1500);
    if (err != ESP_OK) return err;
    if (strncmp(reply, "MT", 2) != 0 || strlen(reply) < 19) return ESP_FAIL;

    memory->tag_enabled = reply[5] == '1';
    memcpy(memory->tag, reply + 6, 12);
    memory->tag[12] = '\0';
    for (int i = 11; i >= 0 && memory->tag[i] == ' '; --i) {
        memory->tag[i] = '\0';
    }
    return ESP_OK;
}

esp_err_t freerig_memories_init(void)
{
    if (s_mutex != NULL) return ESP_OK;
    s_mutex = xSemaphoreCreateMutex();
    if (s_mutex == NULL) return ESP_ERR_NO_MEM;
    memset(s_cache, 0, sizeof(s_cache));
    return freerig_config_init();
}

esp_err_t freerig_memory_read_radio(int slot, freerig_memory_t *out)
{
    if (slot < 1 || slot > 99 || out == NULL) return ESP_ERR_INVALID_ARG;

    char command[16];
    char reply[FT710_CAT_RESPONSE_MAX];
    snprintf(command, sizeof(command), "MR%03d;", slot);
    esp_err_t err = ft710_cat_query(command, reply, sizeof(reply), 1800);
    if (err != ESP_OK) return err;
    if (strcmp(reply, "?;") == 0) {
        memset(out, 0, sizeof(*out));
        out->slot = slot;
        return ESP_ERR_NOT_FOUND;
    }
    if (!parse_memory_reply(slot, reply, out)) return ESP_FAIL;
    (void)read_tag(slot, out);
    load_metadata(out);
    return ESP_OK;
}

size_t freerig_memories_list(freerig_memory_t *out, size_t capacity)
{
    if (s_mutex == NULL) (void)freerig_memories_init();
    if (s_mutex == NULL) return 0;

    size_t count = 0;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    for (int i = 0; i < 99; ++i) {
        if (!s_cache[i].present) continue;
        if (out != NULL && count < capacity) out[count] = s_cache[i];
        count++;
    }
    xSemaphoreGive(s_mutex);
    return count;
}

esp_err_t freerig_memories_sync(freerig_memory_sync_result_t *summary)
{
    if (summary == NULL) return ESP_ERR_INVALID_ARG;
    memset(summary, 0, sizeof(*summary));
    if (s_mutex == NULL) (void)freerig_memories_init();
    if (s_mutex == NULL) return ESP_ERR_NO_MEM;

    for (int slot = 1; slot <= 99; ++slot) {
        freerig_memory_t memory;
        esp_err_t err = freerig_memory_read_radio(slot, &memory);
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        if (err == ESP_OK) {
            s_cache[slot - 1] = memory;
            summary->present++;
        } else if (err == ESP_ERR_NOT_FOUND) {
            memset(&s_cache[slot - 1], 0, sizeof(s_cache[slot - 1]));
            s_cache[slot - 1].slot = slot;
            summary->empty++;
        } else {
            summary->errors++;
            summary->last_error_slot = slot;
            summary->last_error = (int)err;
        }
        xSemaphoreGive(s_mutex);

        if (summary->errors >= 5) {
            ESP_LOGW(TAG, "memory sync stopped after 5 errors; last slot=%d", slot);
            return ESP_FAIL;
        }
        vTaskDelay(pdMS_TO_TICKS(8));
    }
    return ESP_OK;
}

static bool valid_name(const char *name)
{
    if (name == NULL) return true;
    size_t length = strlen(name);
    if (length > 12) return false;
    for (size_t i = 0; i < length; ++i) {
        const unsigned char c = (unsigned char)name[i];
        if (c < 32 || c > 126 || c == ';') return false;
    }
    return true;
}

static esp_err_t write_record(const freerig_memory_t *memory, const char *name)
{
    char code = mode_code(memory->mode);
    if (code == 0 || !valid_name(name)) return ESP_ERR_INVALID_ARG;

    int clarifier = memory->clarifier_offset_hz;
    if (clarifier < -9990) clarifier = -9990;
    if (clarifier > 9990) clarifier = 9990;

    char command[96];
    snprintf(command,
             sizeof(command),
             "MW%03d%09" PRIu32 "%+05d%d%d%c1%d%02d%d;",
             memory->slot,
             memory->frequency_hz,
             clarifier,
             memory->rx_clarifier ? 1 : 0,
             memory->tx_clarifier ? 1 : 0,
             code,
             memory->ctcss_mode,
             memory->ctcss_number,
             memory->repeater_shift);
    esp_err_t err = ft710_cat_set(command, 1800);
    if (err != ESP_OK) return err;
    vTaskDelay(pdMS_TO_TICKS(100));

    char tag[13] = {0};
    if (name != NULL) snprintf(tag, sizeof(tag), "%s", name);
    snprintf(command, sizeof(command), "MT%03d%d%-12.12s;", memory->slot, tag[0] ? 1 : 0, tag);
    err = ft710_cat_set(command, 1800);
    if (err == ESP_OK) vTaskDelay(pdMS_TO_TICKS(120));
    return err;
}

esp_err_t freerig_memory_save_current(int requested_slot,
                                      const char *name,
                                      const char *category,
                                      const char *note,
                                      bool overwrite,
                                      freerig_memory_t *out)
{
    ft710_cat_status_t status;
    ft710_cat_get_status(&status);
    if (!status.state_valid || !status.radio_power_on) return ESP_ERR_INVALID_STATE;

    int slot = requested_slot;
    if (slot == 0) {
        for (int candidate = 1; candidate <= 99; ++candidate) {
            freerig_memory_t existing;
            if (freerig_memory_read_radio(candidate, &existing) == ESP_ERR_NOT_FOUND) {
                slot = candidate;
                break;
            }
        }
        if (slot == 0) return ESP_ERR_NO_MEM;
    }
    if (slot < 1 || slot > 99) return ESP_ERR_INVALID_ARG;

    freerig_memory_t existing;
    esp_err_t existing_err = freerig_memory_read_radio(slot, &existing);
    if (existing_err == ESP_OK && !overwrite) return ESP_ERR_INVALID_STATE;

    freerig_memory_t memory = {0};
    memory.present = true;
    memory.slot = slot;
    memory.frequency_hz = status.frequency_hz;
    snprintf(memory.mode, sizeof(memory.mode), "%s", status.mode);
    memory.operating_state = 1;

    esp_err_t err = write_record(&memory, name);
    if (err != ESP_OK) return err;
    if (category != NULL || note != NULL) {
        (void)freerig_config_set_memory_metadata(slot, category ? category : "", note ? note : "");
    }
    err = freerig_memory_read_radio(slot, &memory);
    if (err != ESP_OK) return err;

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_cache[slot - 1] = memory;
    xSemaphoreGive(s_mutex);
    if (out != NULL) *out = memory;
    return ESP_OK;
}

esp_err_t freerig_memory_edit(int slot,
                              uint32_t frequency_hz,
                              const char *mode,
                              const char *name,
                              const char *category,
                              const char *note,
                              freerig_memory_t *out)
{
    freerig_memory_t memory;
    esp_err_t err = freerig_memory_read_radio(slot, &memory);
    if (err != ESP_OK) return err;

    if (frequency_hz != 0) memory.frequency_hz = frequency_hz;
    if (mode != NULL && mode[0] != '\0') {
        if (mode_code(mode) == 0) return ESP_ERR_INVALID_ARG;
        snprintf(memory.mode, sizeof(memory.mode), "%s", mode);
    }
    const char *use_name = name ? name : memory.tag;
    err = write_record(&memory, use_name);
    if (err != ESP_OK) return err;

    if (category != NULL || note != NULL) {
        (void)freerig_config_set_memory_metadata(slot, category, note);
    }
    err = freerig_memory_read_radio(slot, &memory);
    if (err != ESP_OK) return err;

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_cache[slot - 1] = memory;
    xSemaphoreGive(s_mutex);
    if (out != NULL) *out = memory;
    return ESP_OK;
}

esp_err_t freerig_memory_recall(int slot, const char *action)
{
    freerig_memory_t memory;
    esp_err_t err = freerig_memory_read_radio(slot, &memory);
    if (err != ESP_OK) return err;

    if (action == NULL || strcmp(action, "memory") == 0) {
        char command[16];
        (void)ft710_cat_set("VM;", 1500);
        vTaskDelay(pdMS_TO_TICKS(80));
        snprintf(command, sizeof(command), "MC%03d;", slot);
        return ft710_cat_set(command, 1500);
    }

    const char *vfo = strcmp(action, "vfo_b") == 0 ? "B" : (strcmp(action, "vfo_a") == 0 ? "A" : NULL);
    if (vfo == NULL) return ESP_ERR_INVALID_ARG;

    char command[32];
    snprintf(command, sizeof(command), "F%c%09" PRIu32 ";", vfo[0], memory.frequency_hz);
    err = ft710_cat_set(command, 1500);
    if (err != ESP_OK) return err;

    ft710_cat_status_t status;
    ft710_cat_get_status(&status);
    bool active = status.active_vfo[0] == vfo[0];
    char code = mode_code(memory.mode);
    snprintf(command, sizeof(command), "MD%c%c;", active ? '0' : '1', code);
    return ft710_cat_set(command, 1500);
}
