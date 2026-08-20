#include "freerig_config.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "freerig_config";
static bool s_initialized;

static bool valid_callsign(const char *value)
{
    if (value == NULL) return false;
    size_t n = strlen(value);
    if (n < 3 || n >= FREERIG_QRZ_CALLSIGN_MAX) return false;
    for (size_t i = 0; i < n; ++i) {
        unsigned char c = (unsigned char)value[i];
        if (!(isalnum(c) || c == '/')) return false;
    }
    return true;
}

static void uppercase_copy(char *dst, size_t dst_size, const char *src)
{
    if (dst == NULL || dst_size == 0) return;
    dst[0] = '\0';
    if (src == NULL) return;
    size_t j = 0;
    while (*src && isspace((unsigned char)*src)) src++;
    for (; *src && j + 1 < dst_size; ++src) {
        dst[j++] = (char)toupper((unsigned char)*src);
    }
    while (j > 0 && isspace((unsigned char)dst[j - 1])) j--;
    dst[j] = '\0';
}

esp_err_t freerig_config_init(void)
{
    if (s_initialized) return ESP_OK;
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "NVS requires erase/reinitialize: %s", esp_err_to_name(err));
        err = nvs_flash_erase();
        if (err == ESP_OK) err = nvs_flash_init();
    }
    if (err == ESP_OK) {
        s_initialized = true;
        ESP_LOGI(TAG, "NVS configuration ready");
    }
    return err;
}

esp_err_t freerig_config_get_qrz(freerig_qrz_config_t *out)
{
    if (out == NULL) return ESP_ERR_INVALID_ARG;
    memset(out, 0, sizeof(*out));
    esp_err_t err = freerig_config_init();
    if (err != ESP_OK) return err;
    nvs_handle_t h;
    err = nvs_open("freerig", NVS_READONLY, &h);
    if (err == ESP_ERR_NVS_NOT_FOUND) return ESP_OK;
    if (err != ESP_OK) return err;
    size_t size = sizeof(out->station_callsign);
    if (nvs_get_str(h, "qrz_call", out->station_callsign, &size) != ESP_OK) out->station_callsign[0] = '\0';
    size = sizeof(out->api_key);
    if (nvs_get_str(h, "qrz_key", out->api_key, &size) != ESP_OK) out->api_key[0] = '\0';
    out->api_key_set = out->api_key[0] != '\0';
    nvs_close(h);
    return ESP_OK;
}

esp_err_t freerig_config_set_qrz(const char *station_callsign, const char *api_key_or_null)
{
    char call[FREERIG_QRZ_CALLSIGN_MAX];
    uppercase_copy(call, sizeof(call), station_callsign);
    if (!valid_callsign(call)) return ESP_ERR_INVALID_ARG;
    if (api_key_or_null != NULL && strlen(api_key_or_null) >= FREERIG_QRZ_API_KEY_MAX) return ESP_ERR_INVALID_SIZE;
    esp_err_t err = freerig_config_init();
    if (err != ESP_OK) return err;
    nvs_handle_t h;
    err = nvs_open("freerig", NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_str(h, "qrz_call", call);
    if (err == ESP_OK && api_key_or_null != NULL) {
        if (api_key_or_null[0] == '\0') err = nvs_erase_key(h, "qrz_key");
        else err = nvs_set_str(h, "qrz_key", api_key_or_null);
        if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
    }
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

static bool metadata_key(char *out, size_t out_size, int slot, const char *suffix)
{
    if (out == NULL || suffix == NULL || slot < 1 || slot > 99) return false;
    int n = snprintf(out, out_size, "m%02d_%s", slot, suffix);
    return n > 0 && (size_t)n < out_size;
}

esp_err_t freerig_config_get_memory_metadata(int slot, char *category, size_t category_size, char *note, size_t note_size)
{
    if (slot < 1 || slot > 99 || category == NULL || category_size == 0 || note == NULL || note_size == 0) return ESP_ERR_INVALID_ARG;
    category[0] = '\0'; note[0] = '\0';
    esp_err_t err = freerig_config_init();
    if (err != ESP_OK) return err;
    nvs_handle_t h;
    err = nvs_open("freerig", NVS_READONLY, &h);
    if (err == ESP_ERR_NVS_NOT_FOUND) return ESP_OK;
    if (err != ESP_OK) return err;
    char key[16]; size_t size;
    if (metadata_key(key, sizeof(key), slot, "cat")) {
        size = category_size;
        if (nvs_get_str(h, key, category, &size) != ESP_OK) category[0] = '\0';
    }
    if (metadata_key(key, sizeof(key), slot, "note")) {
        size = note_size;
        if (nvs_get_str(h, key, note, &size) != ESP_OK) note[0] = '\0';
    }
    nvs_close(h);
    return ESP_OK;
}

esp_err_t freerig_config_set_memory_metadata(int slot, const char *category_or_null, const char *note_or_null)
{
    if (slot < 1 || slot > 99) return ESP_ERR_INVALID_ARG;
    if (category_or_null && strlen(category_or_null) >= FREERIG_MEMORY_CATEGORY_MAX) return ESP_ERR_INVALID_SIZE;
    if (note_or_null && strlen(note_or_null) >= FREERIG_MEMORY_NOTE_MAX) return ESP_ERR_INVALID_SIZE;
    esp_err_t err = freerig_config_init();
    if (err != ESP_OK) return err;
    nvs_handle_t h;
    err = nvs_open("freerig", NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    char key[16];
    if (category_or_null && metadata_key(key, sizeof(key), slot, "cat")) {
        err = category_or_null[0] ? nvs_set_str(h, key, category_or_null) : nvs_erase_key(h, key);
        if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
    }
    if (err == ESP_OK && note_or_null && metadata_key(key, sizeof(key), slot, "note")) {
        err = note_or_null[0] ? nvs_set_str(h, key, note_or_null) : nvs_erase_key(h, key);
        if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
    }
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}
