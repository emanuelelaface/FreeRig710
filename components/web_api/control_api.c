#include "control_api.h"

#include <ctype.h>
#include <errno.h>
#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>
#include <sys/time.h>
#include <unistd.h>
#include <stdarg.h>

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "ft710_audio.h"
#include "ft710_audio_tx.h"
#include "ft710_cat.h"
#include "freerig_config.h"
#include "freerig_memories.h"
#include "freerig_wireguard.h"
#include "lwip/netdb.h"
#include "lwip/sockets.h"
#include "network_eth.h"
#include "video_jpeg.h"

static const char *TAG = "control_api";

#define API_TIMEOUT_MS 1800U
#define AUDIO_WS_RX_CHUNK 1920U
#define AUDIO_WS_TASK_STACK 5120U
#define AUDIO_WS_TASK_PRIO 4

static httpd_handle_t s_server;
static portMUX_TYPE s_ws_mux = portMUX_INITIALIZER_UNLOCKED;
static int s_audio_ws_fd = -1;
static uint32_t s_audio_ws_sessions;
static uint32_t s_audio_ws_disconnects;
static uint64_t s_audio_ws_rx_bytes;
static uint64_t s_audio_ws_tx_bytes;
static uint64_t s_audio_ws_tx_microphone_bytes;
static uint64_t s_audio_ws_tx_ft8_bytes;
static uint64_t s_audio_ws_tx_digital_bytes;
static uint64_t s_audio_ws_tx_rejected_bytes;

typedef enum {
    AUDIO_TX_SOURCE_NONE = 0,
    AUDIO_TX_SOURCE_MICROPHONE,
    AUDIO_TX_SOURCE_FT8,
    AUDIO_TX_SOURCE_DIGITAL,
} audio_tx_source_t;
static audio_tx_source_t s_audio_tx_source = AUDIO_TX_SOURCE_NONE;

/* FT8.5.16: the ESP32-P4 DWC host exhibits RF-audible ISO OUT discontinuities
 * while the CP2105 BULK IN transfer is continuously pending.  Manual voice
 * PTT therefore uses the same TX isolation as automatic FT8: suspend UAC RX,
 * key TX, halt/flush CAT BULK IN, then restore both after TX0. */
static SemaphoreHandle_t s_manual_tx_mutex;
static bool s_manual_tx_isolated;
static bool s_manual_tx_rx_paused;
static bool s_manual_tx_cat_quiet;
static bool s_manual_tx_recovery_started;

#define FT8_TUNE_POWER_W 5
#define FT8_TUNE_LEASE_MS 1600U
#define FT8_TUNE_MAX_MS 12000U
#define FT8_TUNE_METER_PERIOD_MS 250U

typedef struct {
    bool task_running;
    bool active;
    bool stop_requested;
    uint64_t started_ms;
    uint64_t deadline_ms;
    int original_power_w;
    int restored_power_w;
    int alc_raw;
    int po_raw;
    float level_dbfs;
    uint32_t meter_reads;
    uint32_t meter_errors;
    bool metering_enabled;
    bool usb_quiet;
    uint32_t frequency_hz;
    char phase[20];
    char last_reason[96];
} ft8_tune_snapshot_t;

static portMUX_TYPE s_ft8_tune_mux = portMUX_INITIALIZER_UNLOCKED;
static bool s_ft8_tune_task_running;
static bool s_ft8_tune_active;
static bool s_ft8_tune_stop_requested;
static uint64_t s_ft8_tune_started_ms;
static uint64_t s_ft8_tune_deadline_ms;
static int s_ft8_tune_original_power_w;
static int s_ft8_tune_restored_power_w;
static int s_ft8_tune_alc_raw;
static int s_ft8_tune_po_raw;
static float s_ft8_tune_level_dbfs = -32.0f;
static uint32_t s_ft8_tune_meter_reads;
static uint32_t s_ft8_tune_meter_errors;
static bool s_ft8_tune_metering_enabled = true;
static bool s_ft8_tune_usb_quiet = false;
static uint32_t s_ft8_tune_frequency_hz = 1500U;
static char s_ft8_tune_phase[20] = "IDLE";
static char s_ft8_tune_last_reason[96] = "";

static cJSON *ft8_tune_status_json(void);
static void ft8_tune_request_stop(const char *reason);

#define FT8_TX_LEASE_MS 1600U
#define FT8_TX_PTT_OFFSET_MS 80U
#define FT8_TX_HARD_STOP_OFFSET_MS 14650U
#define FT8_TX_ARM_MIN_LEAD_MS 350U
#define FT8_TX_ARM_MAX_LEAD_MS 5000U
#define FT8_TX_ARM_MAX_LATE_MS 1650U
#define FT8_TX_STATE_CONFIRM_GRACE_MS 1800U

/*
 * Same-slot late entry. The canonical staged FT8 waveform is 12.64 s. The
 * browser targets at most +1.45 s; the ESP32 accepts up to +1.65 s to absorb
 * HTTP/CAT validation latency. The hard stop at +14.65 s remains authoritative
 * and still forces TX0 before the following 15 s UTC slot.
 */

/*
 * FT8 automatic QSO audio is staged in PSRAM before the UTC slot.  The
 * browser is therefore not in the real-time audio path once RF starts.
 * 12.64 s * 48000 mono S16LE = 1,213,440 bytes.
 */
#define FT8_TX_WAVEFORM_MAX_BYTES       1300000U
#define FT8_TX_STAGE_RATE_HZ              48000U
#define FT8_TX_WAVEFORM_FEED_CHUNK        3840U   /* 40 ms mono S16LE at 48 kHz */
#define FT8_TX_WAVEFORM_QUEUE_LOW          8000U   /* ~83 ms at 48 kHz mono */
#define FT8_TX_WAVEFORM_QUEUE_HIGH        18000U   /* ~188 ms; below stream capacity */

#define DIGITAL_TX_WAVEFORM_MAX_BYTES   (12U * 1024U * 1024U)
#define DIGITAL_TX_STAGE_RATE_HZ           48000U
#define DIGITAL_TX_WAVEFORM_FEED_CHUNK      3840U
#define DIGITAL_TX_WAVEFORM_QUEUE_LOW        8000U
#define DIGITAL_TX_WAVEFORM_QUEUE_HIGH      18000U
#define DIGITAL_TX_MAX_LABEL_LEN              48U
#define DIGITAL_TX_MAX_PTT_DELAY_MS         1500U
#define DIGITAL_TX_MAX_TAIL_MS              1200U
#define DIGITAL_TX_MIN_LEASE_MS             2500U
#define DIGITAL_TX_MAX_LEASE_MS          135000U

typedef struct {
    bool task_running;
    bool active;
    bool stop_requested;
    uint64_t target_slot_index;
    uint64_t target_unix_ms;
    uint64_t ptt_started_unix_ms;
    uint64_t lease_deadline_ms;
    uint64_t hard_stop_unix_ms;
    uint32_t keepalives;
    uint32_t sessions_started;
    uint32_t sessions_completed;
    uint32_t sessions_aborted;
    uint32_t expected_vfo_a_hz;
    uint32_t expected_vfo_b_hz;
    uint32_t waveform_id;
    bool streamed_audio;
    int expected_power_w;
    char phase[20];
    char last_reason[96];
} ft8_tx_snapshot_t;

static portMUX_TYPE s_ft8_tx_mux = portMUX_INITIALIZER_UNLOCKED;
static bool s_ft8_tx_task_running;
static bool s_ft8_tx_active;
static bool s_ft8_tx_stop_requested;
static uint64_t s_ft8_tx_target_slot_index;
static uint64_t s_ft8_tx_target_unix_ms;
static uint64_t s_ft8_tx_ptt_started_unix_ms;
static uint64_t s_ft8_tx_lease_deadline_ms;
static uint64_t s_ft8_tx_hard_stop_unix_ms;
static uint32_t s_ft8_tx_keepalives;
static uint32_t s_ft8_tx_sessions_started;
static uint32_t s_ft8_tx_sessions_completed;
static uint32_t s_ft8_tx_sessions_aborted;
static uint32_t s_ft8_tx_expected_vfo_a_hz;
static uint32_t s_ft8_tx_expected_vfo_b_hz;
static uint32_t s_ft8_tx_waveform_id;
static bool s_ft8_tx_streamed_audio;
static int s_ft8_tx_expected_power_w;
static char s_ft8_tx_phase[20] = "IDLE";

/* Browser-uploaded FT8 waveform staging buffer.  Upload is only allowed while
 * no FT8 RF operation is running, and the buffer is consumed only by the
 * ESP32 FT8 slot task. */
static SemaphoreHandle_t s_ft8_wave_mutex;
static uint8_t *s_ft8_wave_data;
static size_t s_ft8_wave_expected_bytes;
static size_t s_ft8_wave_received_bytes;
static size_t s_ft8_wave_consumed_bytes;
static uint32_t s_ft8_wave_id;
static uint32_t s_ft8_wave_sample_rate_hz;
static int s_ft8_wave_owner_fd = -1;
static bool s_ft8_wave_uploading;
static bool s_ft8_wave_ready;
static uint64_t s_ft8_wave_upload_started_ms;
static char s_ft8_tx_last_reason[96] = "";

static SemaphoreHandle_t s_digital_wave_mutex;
static uint8_t *s_digital_wave_data;
static size_t s_digital_wave_expected_bytes;
static size_t s_digital_wave_received_bytes;
static size_t s_digital_wave_consumed_bytes;
static uint32_t s_digital_wave_id;
static uint32_t s_digital_wave_sample_rate_hz;
static int s_digital_wave_owner_fd = -1;
static bool s_digital_wave_uploading;
static bool s_digital_wave_ready;
static uint64_t s_digital_wave_upload_started_ms;

static portMUX_TYPE s_digital_tx_mux = portMUX_INITIALIZER_UNLOCKED;
static bool s_digital_tx_task_running;
static bool s_digital_tx_active;
static bool s_digital_tx_stop_requested;
static uint32_t s_digital_tx_waveform_id;
static uint64_t s_digital_tx_started_ms;
static uint64_t s_digital_tx_deadline_ms;
static char s_digital_tx_phase[20] = "IDLE";
static char s_digital_tx_last_reason[96] = "";

static cJSON *ft8_tx_status_json(void);
static void ft8_tx_request_stop(const char *reason);
static bool ft8_tx_is_running(void);
static uint64_t monotonic_ms(void);
static bool digital_tx_is_running(void);
static void digital_tx_request_stop(const char *reason);
static void digital_waveform_clear(void);

static const char *audio_tx_source_name(audio_tx_source_t source)
{
    switch (source) {
        case AUDIO_TX_SOURCE_MICROPHONE: return "MICROPHONE";
        case AUDIO_TX_SOURCE_FT8: return "FT8";
        case AUDIO_TX_SOURCE_DIGITAL: return "DIGITAL";
        default: return "NONE";
    }
}

static audio_tx_source_t audio_ws_get_tx_source(void)
{
    audio_tx_source_t source;
    portENTER_CRITICAL(&s_ws_mux);
    source = s_audio_tx_source;
    portEXIT_CRITICAL(&s_ws_mux);
    return source;
}

static bool audio_ws_set_tx_source(int fd, audio_tx_source_t source)
{
    bool active = false;
    portENTER_CRITICAL(&s_ws_mux);
    if (s_audio_ws_fd == fd) {
        s_audio_tx_source = source;
        active = true;
    }
    portEXIT_CRITICAL(&s_ws_mux);
    if (active) {
        ft710_audio_tx_input_reset();
        ESP_LOGI(TAG, "audio WS fd=%d TX source -> %s", fd, audio_tx_source_name(source));
    }
    return active;
}

static portMUX_TYPE s_jog_mux = portMUX_INITIALIZER_UNLOCKED;
static float s_jog_position;
static float s_jog_speed_hz_s;
static uint32_t s_jog_frequency;
static char s_jog_vfo = 'A';

static portMUX_TYPE s_cw_mux = portMUX_INITIALIZER_UNLOCKED;
static bool s_cw_sending;
static char s_cw_message[51];
static int s_cw_wpm = 25;
static int s_cw_slot = 5;
static uint64_t s_cw_started_ms;
static uint64_t s_cw_expected_end_ms;

static void cors(httpd_req_t *req)
{
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,OPTIONS");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", "Content-Type,Authorization");
    /* Chrome/Edge Local Network Access / Private Network Access preflights. */
    httpd_resp_set_hdr(req, "Access-Control-Allow-Private-Network", "true");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
}

static esp_err_t send_json(httpd_req_t *req, cJSON *root)
{
    if (!root) return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "json allocation failed");
    char *text = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!text) return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "json render failed");
    cors(req);
    httpd_resp_set_type(req, "application/json");
    esp_err_t err = httpd_resp_sendstr(req, text);
    free(text);
    return err;
}

static esp_err_t send_error(httpd_req_t *req, const char *status, const char *detail)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddFalseToObject(root, "ok");
    cJSON_AddStringToObject(root, "detail", detail ? detail : "error");
    httpd_resp_set_status(req, status);
    return send_json(req, root);
}

static cJSON *read_json(httpd_req_t *req)
{
    if (req->content_len <= 0 || req->content_len > 8192) return NULL;
    char *buf = calloc(1, (size_t)req->content_len + 1U);
    if (!buf) return NULL;
    int received = 0;
    while (received < req->content_len) {
        int n = httpd_req_recv(req, buf + received, req->content_len - received);
        if (n <= 0) { free(buf); return NULL; }
        received += n;
    }
    cJSON *json = cJSON_Parse(buf);
    free(buf);
    return json;
}

static const char *json_string(cJSON *root, const char *key, const char *def)
{
    cJSON *v = cJSON_GetObjectItemCaseSensitive(root, key);
    return cJSON_IsString(v) && v->valuestring ? v->valuestring : def;
}

static int json_int(cJSON *root, const char *key, int def)
{
    cJSON *v = cJSON_GetObjectItemCaseSensitive(root, key);
    return cJSON_IsNumber(v) ? v->valueint : def;
}

static bool json_bool(cJSON *root, const char *key, bool def, bool *present)
{
    cJSON *v = cJSON_GetObjectItemCaseSensitive(root, key);
    if (present) *present = v != NULL;
    if (cJSON_IsBool(v)) return cJSON_IsTrue(v);
    return def;
}

static char mode_code(const char *name)
{
    static const struct { const char *name; char code; int width; } map[] = {
        {"LSB",'1',0},{"USB",'2',0},{"CW-U",'3',0},{"FM",'4',3},{"AM",'5',2},
        {"RTTY-L",'6',0},{"CW-L",'7',0},{"DATA-L",'8',0},{"RTTY-U",'9',0},{"DATA-FM",'A',3},
        {"FM-N",'B',2},{"DATA-U",'C',0},{"AM-N",'D',1},{"PSK",'E',0},{"DATA-FM-N",'F',2},
    };
    if (!name) return 0;
    for (size_t i=0;i<sizeof(map)/sizeof(map[0]);++i) if (!strcasecmp(name,map[i].name)) return map[i].code;
    return 0;
}

static int default_width(const char *name)
{
    if (!name) return 0;
    if (!strcasecmp(name,"AM-N")) return 1;
    if (!strcasecmp(name,"AM")) return 2;
    if (!strcasecmp(name,"FM-N") || !strcasecmp(name,"DATA-FM-N")) return 2;
    if (!strcasecmp(name,"FM") || !strcasecmp(name,"DATA-FM")) return 3;
    return 0;
}

static cJSON *state_json(void)
{
    ft710_cat_status_t st; ft710_cat_get_status(&st);
    cJSON *o=cJSON_CreateObject();
    cJSON_AddBoolToObject(o,"connected",st.device_open&&st.interface_claimed);
    cJSON_AddStringToObject(o,"radio_power",st.power_starting?"STARTING":(st.power_known?(st.radio_power_on?"ON":"OFF"):"UNKNOWN"));
    cJSON_AddStringToObject(o,"radio_id",st.radio_id[0]?st.radio_id:"0800");
    cJSON_AddStringToObject(o,"cat_device","CP2105 / AUX");
    /* Kept for compatibility with early M12 frontends. */
    cJSON_AddStringToObject(o,"cat2_device","CP2105 / AUX");
    cJSON_AddNumberToObject(o,"frequency_hz",st.frequency_hz);
    cJSON_AddNumberToObject(o,"vfo_a_hz",st.vfo_a_hz);
    cJSON_AddNumberToObject(o,"vfo_b_hz",st.vfo_b_hz);
    cJSON_AddStringToObject(o,"active_vfo",st.active_vfo[0]?st.active_vfo:"A");
    cJSON_AddStringToObject(o,"rx_vfo",st.active_vfo[0]?st.active_vfo:"A");
    char txvfo[2]={st.active_vfo[0]?st.active_vfo[0]:'A','\0'};
    if(st.split_enabled) txvfo[0]=txvfo[0]=='A'?'B':'A';
    cJSON_AddStringToObject(o,"tx_vfo",txvfo);
    cJSON_AddBoolToObject(o,"split_enabled",st.split_enabled);
    cJSON_AddStringToObject(o,"mode",st.mode[0]?st.mode:"USB");
    cJSON_AddStringToObject(o,"vfo_a_mode",st.vfo_a_mode[0]?st.vfo_a_mode:"USB");
    cJSON_AddStringToObject(o,"vfo_b_mode",st.vfo_b_mode[0]?st.vfo_b_mode:"USB");
    cJSON_AddNumberToObject(o,"tx_power_w",st.tx_power_w);
    cJSON_AddStringToObject(o,"rf_sql_vr",st.rf_sql_vr[0]?st.rf_sql_vr:"RF");
    cJSON_AddNumberToObject(o,"rf_gain",st.rf_gain);
    cJSON_AddNumberToObject(o,"squelch_level",st.squelch_level);
    cJSON_AddStringToObject(o,"agc",st.agc[0]?st.agc:"AUTO");
    cJSON_AddStringToObject(o,"tuner",st.tuner[0]?st.tuner:"OFF");
    cJSON_AddBoolToObject(o,"hi_swr",st.hi_swr);
    cJSON_AddStringToObject(o,"tx_state",st.tx_state[0]?st.tx_state:"RX");
    cJSON_AddBoolToObject(o,"ptt_active",st.ptt_active);
    cJSON_AddBoolToObject(o,"tuner_busy",st.tuner_busy);
    cJSON_AddBoolToObject(o,"squelch_open",st.squelch_open);
    cJSON_AddStringToObject(o,"preamp",st.preamp[0]?st.preamp:"IPO");
    cJSON_AddNumberToObject(o,"attenuator_db",st.attenuator_db);
    cJSON_AddNumberToObject(o,"width_code",st.width_code);
    cJSON_AddNumberToObject(o,"if_shift_hz",st.if_shift_hz);
    cJSON_AddBoolToObject(o,"manual_notch",st.manual_notch);
    cJSON_AddNumberToObject(o,"manual_notch_hz",st.manual_notch_hz);
    cJSON_AddBoolToObject(o,"contour",st.contour);
    cJSON_AddNumberToObject(o,"contour_hz",st.contour_hz);
    cJSON_AddBoolToObject(o,"dnr",st.dnr);
    cJSON_AddNumberToObject(o,"dnr_level",st.dnr_level);
    cJSON_AddBoolToObject(o,"noise_blanker",st.noise_blanker);
    cJSON_AddNumberToObject(o,"noise_blanker_level",st.noise_blanker_level);
    cJSON_AddBoolToObject(o,"auto_notch",st.auto_notch);
    cJSON_AddStringToObject(o,"meter_display",st.meter_display[0]?st.meter_display:"PO");
    cJSON_AddStringToObject(o,"scope_mode",st.scope_mode[0]?st.scope_mode:"3DSS CENTER");
    cJSON_AddStringToObject(o,"scope_speed",st.scope_speed[0]?st.scope_speed:"FAST 2");
    cJSON_AddStringToObject(o,"scope_span",st.scope_span[0]?st.scope_span:"100 kHz");
    portENTER_CRITICAL(&s_jog_mux); float pos=s_jog_position, speed=s_jog_speed_hz_s; portEXIT_CRITICAL(&s_jog_mux);
    cJSON_AddNumberToObject(o,"jog_position",pos); cJSON_AddNumberToObject(o,"jog_speed_hz_s",speed);
    cJSON_AddStringToObject(o,"last_error",st.last_error==ESP_OK?"":esp_err_to_name((esp_err_t)st.last_error));
    return o;
}

static esp_err_t ok_state(httpd_req_t *req)
{
    cJSON *o=cJSON_CreateObject(); cJSON_AddTrueToObject(o,"ok"); cJSON_AddItemToObject(o,"state",state_json()); return send_json(req,o);
}

static esp_err_t state_handler(httpd_req_t *req){ return send_json(req,state_json()); }

static esp_err_t capabilities_handler(httpd_req_t *req)
{
    cJSON *o=cJSON_CreateObject();cJSON_AddTrueToObject(o,"ok");cJSON_AddStringToObject(o,"platform","ESP32-P4");cJSON_AddStringToObject(o,"hostname","ft710.local");cJSON_AddStringToObject(o,"version","1.0");
    cJSON_AddBoolToObject(o,"ft8",true);cJSON_AddStringToObject(o,"ft8_stage","FreeRig710_1.0");cJSON_AddBoolToObject(o,"ft8_decode",true);cJSON_AddBoolToObject(o,"ft8_tx",true);cJSON_AddBoolToObject(o,"ft8_tx_audio",true);cJSON_AddBoolToObject(o,"ft8_tune",true);cJSON_AddBoolToObject(o,"ft8_auto_ptt",true);cJSON_AddBoolToObject(o,"video",true);cJSON_AddBoolToObject(o,"cat",true);cJSON_AddBoolToObject(o,"audio_rx",true);cJSON_AddBoolToObject(o,"audio_tx",true);cJSON_AddBoolToObject(o,"ptt_latching",true);cJSON_AddNumberToObject(o,"ptt_watchdog_ms",1500);
    return send_json(req,o);
}

static esp_err_t cat_set_checked(httpd_req_t *req,const char *cmd)
{
    esp_err_t err=ft710_cat_set(cmd,API_TIMEOUT_MS); if(err!=ESP_OK) return send_error(req,"502 Bad Gateway",esp_err_to_name(err)); return ok_state(req);
}

static bool ft8_tune_is_running(void)
{
    bool running;
    portENTER_CRITICAL(&s_ft8_tune_mux);
    running = s_ft8_tune_task_running;
    portEXIT_CRITICAL(&s_ft8_tune_mux);
    return running;
}

static bool ft8_tx_is_running(void)
{
    bool running;
    portENTER_CRITICAL(&s_ft8_tx_mux);
    running = s_ft8_tx_task_running;
    portEXIT_CRITICAL(&s_ft8_tx_mux);
    return running;
}

static bool ft8_rf_operation_is_running(void)
{
    return ft8_tune_is_running() || ft8_tx_is_running();
}

typedef struct {
    bool uploading;
    bool ready;
    uint32_t id;
    uint32_t sample_rate_hz;
    int owner_fd;
    size_t expected_bytes;
    size_t received_bytes;
    size_t consumed_bytes;
    uint64_t upload_started_ms;
    uint8_t *data;
} ft8_wave_snapshot_t;

static void ft8_waveform_get_snapshot(ft8_wave_snapshot_t *out)
{
    if (!out) return;
    memset(out, 0, sizeof(*out));
    if (s_ft8_wave_mutex == NULL || xSemaphoreTake(s_ft8_wave_mutex, pdMS_TO_TICKS(50)) != pdTRUE) return;
    out->uploading = s_ft8_wave_uploading;
    out->ready = s_ft8_wave_ready;
    out->id = s_ft8_wave_id;
    out->sample_rate_hz = s_ft8_wave_sample_rate_hz;
    out->owner_fd = s_ft8_wave_owner_fd;
    out->expected_bytes = s_ft8_wave_expected_bytes;
    out->received_bytes = s_ft8_wave_received_bytes;
    out->consumed_bytes = s_ft8_wave_consumed_bytes;
    out->upload_started_ms = s_ft8_wave_upload_started_ms;
    out->data = s_ft8_wave_data;
    xSemaphoreGive(s_ft8_wave_mutex);
}

static void ft8_waveform_clear(void)
{
    if (s_ft8_wave_mutex == NULL) return;
    uint8_t *old = NULL;
    if (xSemaphoreTake(s_ft8_wave_mutex, pdMS_TO_TICKS(100)) != pdTRUE) return;
    old = s_ft8_wave_data;
    s_ft8_wave_data = NULL;
    s_ft8_wave_expected_bytes = 0;
    s_ft8_wave_received_bytes = 0;
    s_ft8_wave_consumed_bytes = 0;
    s_ft8_wave_id = 0;
    s_ft8_wave_sample_rate_hz = 0;
    s_ft8_wave_owner_fd = -1;
    s_ft8_wave_uploading = false;
    s_ft8_wave_ready = false;
    s_ft8_wave_upload_started_ms = 0;
    xSemaphoreGive(s_ft8_wave_mutex);
    if (old) heap_caps_free(old);
}

static bool ft8_waveform_begin_upload(int fd, uint32_t id, size_t bytes, uint32_t sample_rate_hz, char *reason, size_t reason_len)
{
    if (fd < 0 || id == 0 || bytes == 0 || bytes > FT8_TX_WAVEFORM_MAX_BYTES || (bytes & 1U)) {
        snprintf(reason, reason_len, "invalid FT8 waveform size/id");
        return false;
    }
    if (sample_rate_hz != FT8_TX_STAGE_RATE_HZ) {
        snprintf(reason, reason_len, "FT8 staged sample rate must be 48000 Hz");
        return false;
    }
    if (ft8_rf_operation_is_running()) {
        snprintf(reason, reason_len, "cannot upload FT8 waveform during TX/Tune");
        return false;
    }
    if (s_ft8_wave_mutex == NULL) {
        snprintf(reason, reason_len, "FT8 waveform mutex unavailable");
        return false;
    }
    uint8_t *data = heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!data) data = heap_caps_malloc(bytes, MALLOC_CAP_8BIT);
    if (!data) {
        snprintf(reason, reason_len, "could not allocate FT8 waveform buffer");
        return false;
    }
    if (xSemaphoreTake(s_ft8_wave_mutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        heap_caps_free(data);
        snprintf(reason, reason_len, "FT8 waveform staging lock timeout");
        return false;
    }
    uint8_t *old = s_ft8_wave_data;
    s_ft8_wave_data = data;
    s_ft8_wave_expected_bytes = bytes;
    s_ft8_wave_received_bytes = 0;
    s_ft8_wave_consumed_bytes = 0;
    s_ft8_wave_id = id;
    s_ft8_wave_sample_rate_hz = sample_rate_hz;
    s_ft8_wave_owner_fd = fd;
    s_ft8_wave_uploading = true;
    s_ft8_wave_ready = false;
    s_ft8_wave_upload_started_ms = monotonic_ms();
    xSemaphoreGive(s_ft8_wave_mutex);
    if (old) heap_caps_free(old);
    return true;
}

static bool ft8_waveform_append(int fd, const uint8_t *data, size_t bytes, bool *became_ready)
{
    if (became_ready) *became_ready = false;
    if (!data || bytes == 0 || s_ft8_wave_mutex == NULL) return false;
    if (xSemaphoreTake(s_ft8_wave_mutex, pdMS_TO_TICKS(100)) != pdTRUE) return false;
    bool ok = false;
    if (s_ft8_wave_uploading && s_ft8_wave_data && s_ft8_wave_owner_fd == fd &&
        s_ft8_wave_received_bytes + bytes <= s_ft8_wave_expected_bytes) {
        memcpy(s_ft8_wave_data + s_ft8_wave_received_bytes, data, bytes);
        s_ft8_wave_received_bytes += bytes;
        if (s_ft8_wave_received_bytes == s_ft8_wave_expected_bytes) {
            s_ft8_wave_uploading = false;
            s_ft8_wave_ready = true;
            if (became_ready) *became_ready = true;
        }
        ok = true;
    }
    xSemaphoreGive(s_ft8_wave_mutex);
    return ok;
}

static bool ft8_waveform_ready_for(int fd, uint32_t id, size_t *bytes_out, uint32_t *sample_rate_out)
{
    if (s_ft8_wave_mutex == NULL || xSemaphoreTake(s_ft8_wave_mutex, pdMS_TO_TICKS(50)) != pdTRUE) return false;
    const bool ready = s_ft8_wave_ready && s_ft8_wave_data && s_ft8_wave_owner_fd == fd && s_ft8_wave_id == id &&
                       s_ft8_wave_received_bytes == s_ft8_wave_expected_bytes && s_ft8_wave_expected_bytes > 0 &&
                       s_ft8_wave_sample_rate_hz == FT8_TX_STAGE_RATE_HZ;
    if (ready && bytes_out) *bytes_out = s_ft8_wave_expected_bytes;
    if (ready && sample_rate_out) *sample_rate_out = s_ft8_wave_sample_rate_hz;
    xSemaphoreGive(s_ft8_wave_mutex);
    return ready;
}

typedef struct {
    bool uploading;
    bool ready;
    uint32_t id;
    uint32_t sample_rate_hz;
    int owner_fd;
    size_t expected_bytes;
    size_t received_bytes;
    size_t consumed_bytes;
    uint64_t upload_started_ms;
    uint8_t *data;
} digital_wave_snapshot_t;

typedef struct {
    int fd;
    uint32_t id;
    uint32_t ptt_delay_ms;
    uint32_t tail_ms;
    uint32_t lease_ms;
    char label[DIGITAL_TX_MAX_LABEL_LEN];
} digital_tx_params_t;

static void digital_waveform_get_snapshot(digital_wave_snapshot_t *out)
{
    if (!out) return;
    memset(out, 0, sizeof(*out));
    if (s_digital_wave_mutex == NULL || xSemaphoreTake(s_digital_wave_mutex, pdMS_TO_TICKS(50)) != pdTRUE) return;
    out->uploading = s_digital_wave_uploading;
    out->ready = s_digital_wave_ready;
    out->id = s_digital_wave_id;
    out->sample_rate_hz = s_digital_wave_sample_rate_hz;
    out->owner_fd = s_digital_wave_owner_fd;
    out->expected_bytes = s_digital_wave_expected_bytes;
    out->received_bytes = s_digital_wave_received_bytes;
    out->consumed_bytes = s_digital_wave_consumed_bytes;
    out->upload_started_ms = s_digital_wave_upload_started_ms;
    out->data = s_digital_wave_data;
    xSemaphoreGive(s_digital_wave_mutex);
}

static void digital_waveform_clear(void)
{
    if (s_digital_wave_mutex == NULL) return;
    uint8_t *old = NULL;
    if (xSemaphoreTake(s_digital_wave_mutex, pdMS_TO_TICKS(100)) != pdTRUE) return;
    old = s_digital_wave_data;
    s_digital_wave_data = NULL;
    s_digital_wave_expected_bytes = 0;
    s_digital_wave_received_bytes = 0;
    s_digital_wave_consumed_bytes = 0;
    s_digital_wave_id = 0;
    s_digital_wave_sample_rate_hz = 0;
    s_digital_wave_owner_fd = -1;
    s_digital_wave_uploading = false;
    s_digital_wave_ready = false;
    s_digital_wave_upload_started_ms = 0;
    xSemaphoreGive(s_digital_wave_mutex);
    if (old) heap_caps_free(old);
}

static bool digital_waveform_begin_upload(int fd, uint32_t id, size_t bytes, uint32_t sample_rate_hz, char *reason, size_t reason_len)
{
    if (fd < 0 || id == 0 || bytes == 0 || bytes > DIGITAL_TX_WAVEFORM_MAX_BYTES || (bytes & 1U)) {
        snprintf(reason, reason_len, "invalid staged digital waveform size/id");
        return false;
    }
    if (sample_rate_hz != DIGITAL_TX_STAGE_RATE_HZ) {
        snprintf(reason, reason_len, "staged digital sample rate must be 48000 Hz");
        return false;
    }
    if (digital_tx_is_running() || ft8_rf_operation_is_running()) {
        snprintf(reason, reason_len, "cannot upload staged digital waveform during RF TX");
        return false;
    }
    if (s_digital_wave_mutex == NULL) {
        snprintf(reason, reason_len, "digital waveform mutex unavailable");
        return false;
    }
    uint8_t *data = heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!data) data = heap_caps_malloc(bytes, MALLOC_CAP_8BIT);
    if (!data) {
        snprintf(reason, reason_len, "could not allocate staged digital waveform buffer");
        return false;
    }
    if (xSemaphoreTake(s_digital_wave_mutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        heap_caps_free(data);
        snprintf(reason, reason_len, "digital waveform staging lock timeout");
        return false;
    }
    uint8_t *old = s_digital_wave_data;
    s_digital_wave_data = data;
    s_digital_wave_expected_bytes = bytes;
    s_digital_wave_received_bytes = 0;
    s_digital_wave_consumed_bytes = 0;
    s_digital_wave_id = id;
    s_digital_wave_sample_rate_hz = sample_rate_hz;
    s_digital_wave_owner_fd = fd;
    s_digital_wave_uploading = true;
    s_digital_wave_ready = false;
    s_digital_wave_upload_started_ms = monotonic_ms();
    xSemaphoreGive(s_digital_wave_mutex);
    if (old) heap_caps_free(old);
    return true;
}

static bool digital_waveform_append(int fd, const uint8_t *data, size_t bytes, bool *became_ready)
{
    if (became_ready) *became_ready = false;
    if (!data || bytes == 0 || s_digital_wave_mutex == NULL) return false;
    if (xSemaphoreTake(s_digital_wave_mutex, pdMS_TO_TICKS(100)) != pdTRUE) return false;
    bool ok = false;
    if (s_digital_wave_uploading && s_digital_wave_data && s_digital_wave_owner_fd == fd &&
        s_digital_wave_received_bytes + bytes <= s_digital_wave_expected_bytes) {
        memcpy(s_digital_wave_data + s_digital_wave_received_bytes, data, bytes);
        s_digital_wave_received_bytes += bytes;
        if (s_digital_wave_received_bytes == s_digital_wave_expected_bytes) {
            s_digital_wave_uploading = false;
            s_digital_wave_ready = true;
            if (became_ready) *became_ready = true;
        }
        ok = true;
    }
    xSemaphoreGive(s_digital_wave_mutex);
    return ok;
}

static bool digital_waveform_ready_for(int fd, uint32_t id, size_t *bytes_out, uint32_t *sample_rate_out)
{
    if (s_digital_wave_mutex == NULL || xSemaphoreTake(s_digital_wave_mutex, pdMS_TO_TICKS(50)) != pdTRUE) return false;
    const bool ready = s_digital_wave_ready && s_digital_wave_data && s_digital_wave_owner_fd == fd && s_digital_wave_id == id &&
                       s_digital_wave_received_bytes == s_digital_wave_expected_bytes && s_digital_wave_expected_bytes > 0 &&
                       s_digital_wave_sample_rate_hz == DIGITAL_TX_STAGE_RATE_HZ;
    if (ready && bytes_out) *bytes_out = s_digital_wave_expected_bytes;
    if (ready && sample_rate_out) *sample_rate_out = s_digital_wave_sample_rate_hz;
    xSemaphoreGive(s_digital_wave_mutex);
    return ready;
}

static bool digital_tx_is_running(void)
{
    bool running;
    portENTER_CRITICAL(&s_digital_tx_mux);
    running = s_digital_tx_task_running;
    portEXIT_CRITICAL(&s_digital_tx_mux);
    return running;
}

static void digital_tx_set_phase(const char *phase, const char *reason)
{
    portENTER_CRITICAL(&s_digital_tx_mux);
    if (phase) snprintf(s_digital_tx_phase, sizeof(s_digital_tx_phase), "%s", phase);
    if (reason) snprintf(s_digital_tx_last_reason, sizeof(s_digital_tx_last_reason), "%s", reason);
    portEXIT_CRITICAL(&s_digital_tx_mux);
}

static void digital_tx_request_stop(const char *reason)
{
    portENTER_CRITICAL(&s_digital_tx_mux);
    if (s_digital_tx_task_running) {
        s_digital_tx_stop_requested = true;
        if (reason && reason[0]) snprintf(s_digital_tx_last_reason, sizeof(s_digital_tx_last_reason), "%s", reason);
    }
    portEXIT_CRITICAL(&s_digital_tx_mux);
}

static esp_err_t reject_radio_reconfigure_during_ft8_tune(httpd_req_t *req)
{
    return ft8_rf_operation_is_running()
        ? send_error(req, "409 Conflict", "radio frequency/mode/VFO controls are locked during FT8 TX/Tune")
        : ESP_OK;
}

static esp_err_t power_handler(httpd_req_t *req)
{
    cJSON *j=read_json(req); if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON"); bool p=false;bool en=json_bool(j,"enabled",false,&p);cJSON_Delete(j);if(!p)return send_error(req,"422 Unprocessable Entity","enabled is required");
    if (!en && ft8_rf_operation_is_running()) {
        /* Radio OFF is always allowed, but first force every bounded FT8 RF
         * operation back to RX so PS0 cannot race a live PTT lease. */
        ft8_tx_request_stop("radio power OFF requested");
        ft8_tune_request_stop("radio power OFF requested");
        (void)ft710_cat_force_ptt_off(API_TIMEOUT_MS);
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    esp_err_t err = ft710_cat_set_power(en, API_TIMEOUT_MS);
    if (err != ESP_OK) return send_error(req, "502 Bad Gateway", esp_err_to_name(err));
    return ok_state(req);
}

static esp_err_t frequency_handler(httpd_req_t *req)
{
    if (ft8_rf_operation_is_running()) return reject_radio_reconfigure_during_ft8_tune(req);
    cJSON *j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");int hz=json_int(j,"frequency_hz",0);const char *v=json_string(j,"vfo","ACTIVE");ft710_cat_status_t st;ft710_cat_get_status(&st);char target=!strcasecmp(v,"B")?'B':(!strcasecmp(v,"A")?'A':(st.active_vfo[0]?st.active_vfo[0]:'A'));cJSON_Delete(j);
    if (hz < 30000 || hz > 75000000) {
        return send_error(req, "422 Unprocessable Entity", "frequency_hz outside FT-710 range");
    }
    char cmd[32];
    snprintf(cmd, sizeof(cmd), "F%c%09d;", target, hz);
    return cat_set_checked(req, cmd);
}

static esp_err_t mode_handler(httpd_req_t *req)
{
    if (ft8_rf_operation_is_running()) return reject_radio_reconfigure_during_ft8_tune(req);
    cJSON *j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");const char *name=json_string(j,"mode",NULL);const char *v=json_string(j,"vfo","ACTIVE");char code=mode_code(name);ft710_cat_status_t st;ft710_cat_get_status(&st);char target=!strcasecmp(v,"B")?'B':(!strcasecmp(v,"A")?'A':(st.active_vfo[0]?st.active_vfo[0]:'A'));bool active=target==(st.active_vfo[0]?st.active_vfo[0]:'A');if(!code){cJSON_Delete(j);return send_error(req,"422 Unprocessable Entity","unsupported mode");}char cmd[32];snprintf(cmd,sizeof(cmd),"MD%c%c;",active?'0':'1',code);esp_err_t err=ft710_cat_set(cmd,API_TIMEOUT_MS);
    if(err==ESP_OK&&active){vTaskDelay(pdMS_TO_TICKS(60));snprintf(cmd,sizeof(cmd),"SH00%02d;",default_width(name));err=ft710_cat_set(cmd,API_TIMEOUT_MS);if(err==ESP_OK)err=ft710_cat_set("IS00+0000;",API_TIMEOUT_MS);if(err==ESP_OK)err=ft710_cat_set("BP00000;",API_TIMEOUT_MS);if(err==ESP_OK)err=ft710_cat_set("CO000000;",API_TIMEOUT_MS);}cJSON_Delete(j);if(err!=ESP_OK)return send_error(req,"502 Bad Gateway",esp_err_to_name(err));return ok_state(req);
}

static esp_err_t tx_power_handler(httpd_req_t *req){if(ft8_rf_operation_is_running())return send_error(req,"409 Conflict","RF power is locked during FT8 TX/Tune");cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");int w=json_int(j,"watts",0);cJSON_Delete(j);if(w<5||w>100)return send_error(req,"422 Unprocessable Entity","watts must be 5..100");char c[16];snprintf(c,sizeof(c),"PC%03d;",w);return cat_set_checked(req,c);}
static esp_err_t rf_sql_handler(httpd_req_t *req){cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");const char*v=json_string(j,"value","");char code=!strcasecmp(v,"RF")?'0':(!strcasecmp(v,"SQL")?'1':(!strcasecmp(v,"SQL_FM")?'2':0));cJSON_Delete(j);if(!code)return send_error(req,"422 Unprocessable Entity","unsupported RF/SQL mode");char c[20];snprintf(c,sizeof(c),"EX030102%c;",code);return cat_set_checked(req,c);}
static esp_err_t rf_gain_handler(httpd_req_t *req){cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");int v=json_int(j,"value",-1);cJSON_Delete(j);if(v<0||v>255)return send_error(req,"422 Unprocessable Entity","value must be 0..255");char c[16];snprintf(c,sizeof(c),"RG0%03d;",v);return cat_set_checked(req,c);}
static esp_err_t squelch_handler(httpd_req_t *req){cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");int v=json_int(j,"value",-1);cJSON_Delete(j);if(v<0||v>100)return send_error(req,"422 Unprocessable Entity","value must be 0..100");char c[16];snprintf(c,sizeof(c),"SQ0%03d;",v);return cat_set_checked(req,c);}
static esp_err_t agc_handler(httpd_req_t *req){cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");const char*v=json_string(j,"value","");char code=!strcasecmp(v,"OFF")?'0':(!strcasecmp(v,"FAST")?'1':(!strcasecmp(v,"MID")?'2':(!strcasecmp(v,"SLOW")?'3':(!strcasecmp(v,"AUTO")?'4':0))));cJSON_Delete(j);if(!code&&strcasecmp(v,"OFF"))return send_error(req,"422 Unprocessable Entity","unsupported AGC");char c[16];snprintf(c,sizeof(c),"GT0%c;",code);return cat_set_checked(req,c);}
static esp_err_t tuner_handler(httpd_req_t *req){if(ft8_rf_operation_is_running())return send_error(req,"409 Conflict","antenna tuner control is locked during FT8 TX/Tune");cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");const char*a=json_string(j,"action","");const char*c=!strcasecmp(a,"enable")?"AC001;":(!strcasecmp(a,"disable")?"AC000;":(!strcasecmp(a,"tune")?"AC003;":NULL));cJSON_Delete(j);if(!c)return send_error(req,"422 Unprocessable Entity","unsupported tuner action");return cat_set_checked(req,c);}
static esp_err_t vfo_select_handler(httpd_req_t *req){if(ft8_rf_operation_is_running())return reject_radio_reconfigure_during_ft8_tune(req);cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");const char*v=json_string(j,"vfo","");const char*c=!strcasecmp(v,"A")?"VS0;":(!strcasecmp(v,"B")?"VS1;":NULL);cJSON_Delete(j);if(!c)return send_error(req,"422 Unprocessable Entity","vfo must be A or B");return cat_set_checked(req,c);}
static esp_err_t vfo_split_handler(httpd_req_t *req){if(ft8_rf_operation_is_running())return reject_radio_reconfigure_during_ft8_tune(req);cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");const char*m=json_string(j,"mode","");esp_err_t e=ESP_OK;if(!strcasecmp(m,"OFF"))e=ft710_cat_set("ST0;",API_TIMEOUT_MS);else if(!strcasecmp(m,"A_TO_B")){e=ft710_cat_set("VS0;",API_TIMEOUT_MS);if(e==ESP_OK)e=ft710_cat_set("ST1;",API_TIMEOUT_MS);}else if(!strcasecmp(m,"B_TO_A")){e=ft710_cat_set("VS1;",API_TIMEOUT_MS);if(e==ESP_OK)e=ft710_cat_set("ST1;",API_TIMEOUT_MS);}else e=ESP_ERR_INVALID_ARG;cJSON_Delete(j);if(e==ESP_ERR_INVALID_ARG)return send_error(req,"422 Unprocessable Entity","unsupported split mode");if(e!=ESP_OK)return send_error(req,"502 Bad Gateway",esp_err_to_name(e));return ok_state(req);}
static esp_err_t vfo_operation_handler(httpd_req_t *req){if(ft8_rf_operation_is_running())return reject_radio_reconfigure_during_ft8_tune(req);cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");const char*a=json_string(j,"action","");const char*c=!strcasecmp(a,"swap")?"SV;":(!strcasecmp(a,"copy_a_to_b")?"AB;":(!strcasecmp(a,"copy_b_to_a")?"BA;":NULL));cJSON_Delete(j);if(!c)return send_error(req,"422 Unprocessable Entity","unsupported VFO operation");return cat_set_checked(req,c);}
static esp_err_t preamp_handler(httpd_req_t *req){cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");const char*v=json_string(j,"value","");char code=!strcasecmp(v,"IPO")?'0':(!strcasecmp(v,"AMP1")?'1':(!strcasecmp(v,"AMP2")?'2':0));cJSON_Delete(j);if(!code&&strcasecmp(v,"IPO"))return send_error(req,"422 Unprocessable Entity","unsupported preamp");char c[16];snprintf(c,sizeof(c),"PA0%c;",code);return cat_set_checked(req,c);}
static esp_err_t attenuator_handler(httpd_req_t *req){cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");int db=json_int(j,"db",-1);cJSON_Delete(j);char code=db==0?'0':db==6?'1':db==12?'2':db==18?'3':0;if(!code)return send_error(req,"422 Unprocessable Entity","db must be 0,6,12,18");char c[16];snprintf(c,sizeof(c),"RA0%c;",code);return cat_set_checked(req,c);}

static esp_err_t dnr_handler(httpd_req_t *req)
{
    cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");bool pe=false;bool en=json_bool(j,"enabled",false,&pe);cJSON*lv=cJSON_GetObjectItemCaseSensitive(j,"level");esp_err_t e=ESP_OK;char c[16];if(pe){snprintf(c,sizeof(c),"NR0%d;",en?1:0);e=ft710_cat_set(c,API_TIMEOUT_MS);}if(e==ESP_OK&&cJSON_IsNumber(lv)){int n=lv->valueint;if(n<1||n>15)e=ESP_ERR_INVALID_ARG;else{snprintf(c,sizeof(c),"RL0%02d;",n);e=ft710_cat_set(c,API_TIMEOUT_MS);}}cJSON_Delete(j);if(e==ESP_ERR_INVALID_ARG)return send_error(req,"422 Unprocessable Entity","DNR level must be 1..15");if(e!=ESP_OK)return send_error(req,"502 Bad Gateway",esp_err_to_name(e));return ok_state(req);
}
static esp_err_t nb_handler(httpd_req_t *req)
{
    cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");bool pe=false;bool en=json_bool(j,"enabled",false,&pe);cJSON*lv=cJSON_GetObjectItemCaseSensitive(j,"level");esp_err_t e=ESP_OK;char c[16];if(pe){snprintf(c,sizeof(c),"NB0%d;",en?1:0);e=ft710_cat_set(c,API_TIMEOUT_MS);}if(e==ESP_OK&&cJSON_IsNumber(lv)){int n=lv->valueint;if(n<0||n>10)e=ESP_ERR_INVALID_ARG;else{snprintf(c,sizeof(c),"NL0%03d;",n);e=ft710_cat_set(c,API_TIMEOUT_MS);}}cJSON_Delete(j);if(e==ESP_ERR_INVALID_ARG)return send_error(req,"422 Unprocessable Entity","NB level must be 0..10");if(e!=ESP_OK)return send_error(req,"502 Bad Gateway",esp_err_to_name(e));return ok_state(req);
}
static esp_err_t auto_notch_handler(httpd_req_t *req){cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");bool p=false,en=json_bool(j,"enabled",false,&p);cJSON_Delete(j);if(!p)return send_error(req,"422 Unprocessable Entity","enabled required");return cat_set_checked(req,en?"BC01;":"BC00;");}

static esp_err_t filter_handler(httpd_req_t *req)
{
    cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");esp_err_t e=ESP_OK;char c[24];cJSON*v;
    v=cJSON_GetObjectItemCaseSensitive(j,"width_code");if(cJSON_IsNumber(v)){int n=v->valueint;if(n<0||n>23)e=ESP_ERR_INVALID_ARG;else{snprintf(c,sizeof(c),"SH00%02d;",n);e=ft710_cat_set(c,API_TIMEOUT_MS);}}
    v=cJSON_GetObjectItemCaseSensitive(j,"shift_hz");if(e==ESP_OK&&cJSON_IsNumber(v)){int n=v->valueint;if(n<-1200||n>1200)e=ESP_ERR_INVALID_ARG;else{n=(int)lround((double)n/20.0)*20;snprintf(c,sizeof(c),"IS00%c%04d;",n<0?'-':'+',abs(n));e=ft710_cat_set(c,API_TIMEOUT_MS);}}
    v=cJSON_GetObjectItemCaseSensitive(j,"manual_notch_hz");if(e==ESP_OK&&cJSON_IsNumber(v)){int n=v->valueint;if(n<10||n>3200)e=ESP_ERR_INVALID_ARG;else{snprintf(c,sizeof(c),"BP01%03d;",n/10);e=ft710_cat_set(c,API_TIMEOUT_MS);}}
    bool p=false;bool b=json_bool(j,"manual_notch_enabled",false,&p);if(e==ESP_OK&&p)e=ft710_cat_set(b?"BP00001;":"BP00000;",API_TIMEOUT_MS);
    v=cJSON_GetObjectItemCaseSensitive(j,"contour_hz");if(e==ESP_OK&&cJSON_IsNumber(v)){int n=v->valueint;if(n<10||n>3200)e=ESP_ERR_INVALID_ARG;else{snprintf(c,sizeof(c),"CO01%04d;",n);e=ft710_cat_set(c,API_TIMEOUT_MS);}}
    p=false;b=json_bool(j,"contour_enabled",false,&p);if(e==ESP_OK&&p)e=ft710_cat_set(b?"CO000001;":"CO000000;",API_TIMEOUT_MS);
    cJSON_Delete(j);if(e==ESP_ERR_INVALID_ARG)return send_error(req,"422 Unprocessable Entity","invalid filter value");if(e!=ESP_OK)return send_error(req,"502 Bad Gateway",esp_err_to_name(e));return ok_state(req);
}

static esp_err_t meter_handler(httpd_req_t *req){cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");const char*v=json_string(j,"value","");char code=!strcasecmp(v,"PO")?'0':!strcasecmp(v,"COMP")?'1':!strcasecmp(v,"ALC")?'2':!strcasecmp(v,"VDD")?'3':!strcasecmp(v,"ID")?'4':!strcasecmp(v,"SWR")?'5':0;cJSON_Delete(j);if(!code&&strcasecmp(v,"PO"))return send_error(req,"422 Unprocessable Entity","unsupported meter");char c[12];snprintf(c,sizeof(c),"MS%c0;",code);return cat_set_checked(req,c);}

static char scope_mode_code(const char*n){static const struct{const char*n;char c;}m[]={{"3DSS CENTER",'0'},{"3DSS CURSOR",'1'},{"3DSS FIX",'2'},{"WATERFALL CENTER EXPAND",'3'},{"WATERFALL CENTER NORMAL",'4'},{"WATERFALL CURSOR EXPAND",'6'},{"WATERFALL CURSOR NORMAL",'7'},{"WATERFALL FIX EXPAND",'9'},{"WATERFALL FIX NORMAL",'A'}};for(size_t i=0;i<sizeof(m)/sizeof(m[0]);i++)if(n&&!strcasecmp(n,m[i].n))return m[i].c;return 0;}
static char scope_speed_code(const char*n){static const char*names[]={"SLOW 1","SLOW 2","FAST 1","FAST 2","FAST 3","STOP"};for(int i=0;i<6;i++)if(n&&!strcasecmp(n,names[i]))return(char)('0'+i);return 0;}
static char scope_span_code(const char*n){static const char*names[]={"1 kHz","2 kHz","5 kHz","10 kHz","20 kHz","50 kHz","100 kHz","200 kHz","500 kHz","1 MHz"};for(int i=0;i<10;i++)if(n&&!strcasecmp(n,names[i]))return(char)('0'+i);return 0;}
static esp_err_t scope_handler(httpd_req_t *req){cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");esp_err_t e=ESP_OK;char c[20];const char*n=json_string(j,"mode",NULL);if(n){char k=scope_mode_code(n);if(!k)e=ESP_ERR_INVALID_ARG;else{snprintf(c,sizeof(c),"SS06%c0000;",k);e=ft710_cat_set(c,API_TIMEOUT_MS);}}n=json_string(j,"speed",NULL);if(e==ESP_OK&&n){char k=scope_speed_code(n);if(!k&&strcasecmp(n,"SLOW 1"))e=ESP_ERR_INVALID_ARG;else{snprintf(c,sizeof(c),"SS00%c0000;",k);e=ft710_cat_set(c,API_TIMEOUT_MS);}}n=json_string(j,"span",NULL);if(e==ESP_OK&&n){char k=scope_span_code(n);if(!k&&strcasecmp(n,"1 kHz"))e=ESP_ERR_INVALID_ARG;else{snprintf(c,sizeof(c),"SS05%c0000;",k);e=ft710_cat_set(c,API_TIMEOUT_MS);}}cJSON_Delete(j);if(e==ESP_ERR_INVALID_ARG)return send_error(req,"422 Unprocessable Entity","unsupported scope setting");if(e!=ESP_OK)return send_error(req,"502 Bad Gateway",esp_err_to_name(e));return ok_state(req);}

static void jog_task(void *arg)
{
    (void)arg;
    for(;;){float pos;portENTER_CRITICAL(&s_jog_mux);pos=s_jog_position;portEXIT_CRITICAL(&s_jog_mux);if(fabsf(pos)>0.06f){float norm=(fabsf(pos)-0.06f)/0.94f;float speed=10.0f*powf(10000.0f,norm);if(pos<0)speed=-speed;ft710_cat_status_t st;ft710_cat_get_status(&st);char vfo=st.active_vfo[0]?st.active_vfo[0]:'A';portENTER_CRITICAL(&s_jog_mux);if(s_jog_frequency==0||s_jog_vfo!=vfo){s_jog_frequency=vfo=='A'?st.vfo_a_hz:st.vfo_b_hz;s_jog_vfo=vfo;}int delta=(int)lroundf(speed*0.2f);if(delta==0)delta=speed>0?1:-1;int64_t nh=(int64_t)s_jog_frequency+delta;if(nh<30000)nh=30000;if(nh>75000000)nh=75000000;s_jog_frequency=(uint32_t)nh;s_jog_speed_hz_s=speed;uint32_t f=s_jog_frequency;portEXIT_CRITICAL(&s_jog_mux);char c[32];snprintf(c,sizeof(c),"F%c%09" PRIu32 ";",vfo,f);(void)ft710_cat_set(c,API_TIMEOUT_MS);}else{portENTER_CRITICAL(&s_jog_mux);s_jog_speed_hz_s=0;s_jog_frequency=0;portEXIT_CRITICAL(&s_jog_mux);}vTaskDelay(pdMS_TO_TICKS(200));}
}
static esp_err_t jog_handler(httpd_req_t *req){if(ft8_rf_operation_is_running())return reject_radio_reconfigure_during_ft8_tune(req);cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");cJSON*v=cJSON_GetObjectItemCaseSensitive(j,"position");if(!cJSON_IsNumber(v)||v->valuedouble<-1||v->valuedouble>1){cJSON_Delete(j);return send_error(req,"422 Unprocessable Entity","position must be -1..1");}float p=(float)v->valuedouble;if(fabsf(p)<=0.06f)p=0;portENTER_CRITICAL(&s_jog_mux);s_jog_position=p;portEXIT_CRITICAL(&s_jog_mux);cJSON_Delete(j);cJSON*o=cJSON_CreateObject();cJSON_AddTrueToObject(o,"ok");portENTER_CRITICAL(&s_jog_mux);cJSON_AddNumberToObject(o,"speed_hz_s",s_jog_speed_hz_s);portEXIT_CRITICAL(&s_jog_mux);cJSON_AddItemToObject(o,"state",state_json());return send_json(req,o);}

static esp_err_t manual_audio_tx_set(bool enabled)
{
    if (s_manual_tx_mutex == NULL) return ESP_ERR_INVALID_STATE;
    if (xSemaphoreTake(s_manual_tx_mutex, pdMS_TO_TICKS(3000)) != pdTRUE) return ESP_ERR_TIMEOUT;

    esp_err_t result = ESP_OK;
    if (enabled) {
        if (s_manual_tx_isolated) {
            ft710_cat_ptt_keepalive();
            xSemaphoreGive(s_manual_tx_mutex);
            return ESP_OK;
        }

        ft710_cat_status_t cat;
        ft710_cat_get_status(&cat);
        if (cat.ptt_active || !strcasecmp(cat.tx_state, "TX")) {
            xSemaphoreGive(s_manual_tx_mutex);
            return ESP_ERR_INVALID_STATE;
        }

        esp_err_t rx_err = ft710_audio_set_tx_half_duplex(true, 900U);
        if (rx_err != ESP_OK) {
            xSemaphoreGive(s_manual_tx_mutex);
            return rx_err;
        }
        s_manual_tx_rx_paused = true;

        esp_err_t ptt_err = ft710_cat_set_ptt(true, API_TIMEOUT_MS);
        if (ptt_err != ESP_OK) {
            (void)ft710_audio_set_tx_half_duplex(false, 1200U);
            s_manual_tx_rx_paused = false;
            xSemaphoreGive(s_manual_tx_mutex);
            return ptt_err;
        }

        esp_err_t quiet_err = ft710_cat_set_tx_quiet(true, 900U);
        if (quiet_err != ESP_OK) {
            (void)ft710_cat_force_ptt_off(API_TIMEOUT_MS);
            (void)ft710_cat_set_tx_quiet(false, 900U);
            (void)ft710_audio_set_tx_half_duplex(false, 1200U);
            s_manual_tx_rx_paused = false;
            s_manual_tx_cat_quiet = false;
            xSemaphoreGive(s_manual_tx_mutex);
            return quiet_err;
        }

        s_manual_tx_cat_quiet = true;
        s_manual_tx_isolated = true;
        ESP_LOGI(TAG, "manual/staged TX isolation active: UAC RX suspended, CAT BULK IN halted");
    } else {
        /* TX0 must be attempted first.  Only resources owned by the manual PTT
         * path are restored here; automatic FT8/Tune tasks own their cleanup. */
        esp_err_t ptt_err = ft710_cat_force_ptt_off(API_TIMEOUT_MS);
        if (ptt_err != ESP_OK) result = ptt_err;

        if (s_manual_tx_isolated || s_manual_tx_cat_quiet || s_manual_tx_rx_paused) {
            if (s_manual_tx_cat_quiet) {
                esp_err_t quiet_err = ft710_cat_set_tx_quiet(false, 1000U);
                if (result == ESP_OK && quiet_err != ESP_OK) result = quiet_err;
            }
            if (s_manual_tx_rx_paused) {
                esp_err_t rx_err = ft710_audio_set_tx_half_duplex(false, 1400U);
                if (result == ESP_OK && rx_err != ESP_OK) result = rx_err;
            }
            s_manual_tx_isolated = false;
            s_manual_tx_cat_quiet = false;
            s_manual_tx_rx_paused = false;
            ESP_LOGI(TAG, "manual/staged TX isolation released: CAT BULK IN and UAC RX restored");
        }
    }

    xSemaphoreGive(s_manual_tx_mutex);
    return result;
}

static void manual_tx_recovery_task(void *arg)
{
    (void)arg;
    for (;;) {
        bool owned = false;
        if (s_manual_tx_mutex != NULL && xSemaphoreTake(s_manual_tx_mutex, pdMS_TO_TICKS(20)) == pdTRUE) {
            owned = s_manual_tx_isolated || s_manual_tx_cat_quiet || s_manual_tx_rx_paused;
            xSemaphoreGive(s_manual_tx_mutex);
        }
        if (owned) {
            ft710_cat_status_t cat;
            ft710_cat_get_status(&cat);
            if (!cat.ptt_active) {
                ESP_LOGW(TAG, "manual PTT ended outside normal handler; restoring TX isolation resources");
                (void)manual_audio_tx_set(false);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

static esp_err_t ptt_handler(httpd_req_t *req)
{
    cJSON *j = read_json(req);
    if (!j) return send_error(req, "422 Unprocessable Entity", "invalid JSON");
    bool present = false;
    const bool enabled = json_bool(j, "enabled", false, &present);
    cJSON_Delete(j);
    if (!present) return send_error(req, "422 Unprocessable Entity", "enabled is required");
    if (enabled) {
        if (ft8_rf_operation_is_running()) return send_error(req, "409 Conflict", "manual PTT is blocked during FT8 automatic TX/Tune");
        if (digital_tx_is_running()) return send_error(req, "409 Conflict", "manual PTT is blocked during staged digital TX");
        ft710_audio_tx_status_t tx;
        ft710_audio_tx_get_status(&tx);
        if (!tx.streaming) return send_error(req, "409 Conflict", "TX audio is not ready");
    }
    if (!enabled && ft8_tx_is_running()) ft8_tx_request_stop("manual PTT OFF / operator halt");
    if (!enabled && digital_tx_is_running()) digital_tx_request_stop("manual PTT OFF / operator halt");
    esp_err_t err = manual_audio_tx_set(enabled);
    if (err != ESP_OK) return send_error(req, "502 Bad Gateway", esp_err_to_name(err));
    return ok_state(req);
}

static esp_err_t ptt_keepalive_handler(httpd_req_t *req)
{
    ft710_cat_status_t st;
    ft710_cat_get_status(&st);
    if (!st.ptt_active) return send_error(req, "409 Conflict", "PTT is not active");
    ft710_cat_ptt_keepalive();
    cJSON *o = cJSON_CreateObject();
    cJSON_AddTrueToObject(o, "ok");
    cJSON_AddTrueToObject(o, "ptt_active");
    cJSON_AddNumberToObject(o, "watchdog_ms", 1500);
    return send_json(req, o);
}

static esp_err_t raw_cat_handler(httpd_req_t *req){if(ft8_rf_operation_is_running())return send_error(req,"409 Conflict","raw CAT is locked during FT8 TX/Tune; Radio OFF remains available through /api/v1/radio/power");cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");const char*c=json_string(j,"command",NULL);bool p=false,reply=json_bool(j,"expect_reply",false,&p);if(!c){cJSON_Delete(j);return send_error(req,"422 Unprocessable Entity","command required");}while(*c&&isspace((unsigned char)*c))c++;if((toupper((unsigned char)c[0])=='T')&&(toupper((unsigned char)c[1])=='X')){cJSON_Delete(j);return send_error(req,"409 Conflict","raw TX/PTT commands are blocked; use the latching audio WebSocket PTT so the watchdog remains active");}char r[FT710_CAT_RESPONSE_MAX]={0};esp_err_t e=reply?ft710_cat_query(c,r,sizeof(r),API_TIMEOUT_MS):ft710_cat_set(c,API_TIMEOUT_MS);cJSON_Delete(j);if(e!=ESP_OK)return send_error(req,"502 Bad Gateway",esp_err_to_name(e));cJSON*o=cJSON_CreateObject();cJSON_AddTrueToObject(o,"ok");if(reply)cJSON_AddStringToObject(o,"response",r);else cJSON_AddNullToObject(o,"response");return send_json(req,o);}

static cJSON *memory_json(const freerig_memory_t *m)
{
    cJSON*o=cJSON_CreateObject();cJSON_AddNumberToObject(o,"slot",m->slot);cJSON_AddStringToObject(o,"radio_channel",m->radio_channel);cJSON_AddNumberToObject(o,"frequency_hz",m->frequency_hz);cJSON_AddStringToObject(o,"mode",m->mode);cJSON_AddBoolToObject(o,"tag_enabled",m->tag_enabled);cJSON_AddStringToObject(o,"tag",m->tag);cJSON_AddStringToObject(o,"category",m->category);cJSON_AddStringToObject(o,"note",m->note);return o;
}
static esp_err_t memories_list_handler(httpd_req_t *req){freerig_memory_t*m=calloc(99,sizeof(*m));if(!m)return send_error(req,"500 Internal Server Error","out of memory");size_t n=freerig_memories_list(m,99);cJSON*o=cJSON_CreateObject();cJSON_AddTrueToObject(o,"ok");cJSON*a=cJSON_AddArrayToObject(o,"memories");for(size_t i=0;i<n;i++)cJSON_AddItemToArray(a,memory_json(&m[i]));cJSON_AddFalseToObject(o,"physical_delete_supported");free(m);return send_json(req,o);}
static esp_err_t memories_sync_handler(httpd_req_t *req){freerig_memory_sync_result_t s;esp_err_t e=freerig_memories_sync(&s);freerig_memory_t*m=calloc(99,sizeof(*m));if(!m)return send_error(req,"500 Internal Server Error","out of memory");size_t n=freerig_memories_list(m,99);cJSON*o=cJSON_CreateObject();cJSON_AddBoolToObject(o,"ok",e==ESP_OK);cJSON*sum=cJSON_AddObjectToObject(o,"summary");cJSON_AddNumberToObject(sum,"present",s.present);cJSON_AddNumberToObject(sum,"empty",s.empty);cJSON*errs=cJSON_AddArrayToObject(sum,"errors");if(s.errors){cJSON*x=cJSON_CreateObject();cJSON_AddNumberToObject(x,"slot",s.last_error_slot);cJSON_AddStringToObject(x,"error",esp_err_to_name((esp_err_t)s.last_error));cJSON_AddItemToArray(errs,x);}cJSON*a=cJSON_AddArrayToObject(o,"memories");for(size_t i=0;i<n;i++)cJSON_AddItemToArray(a,memory_json(&m[i]));cJSON_AddFalseToObject(o,"physical_delete_supported");free(m);return send_json(req,o);}
static esp_err_t memory_save_handler(httpd_req_t *req){cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");cJSON*sv=cJSON_GetObjectItemCaseSensitive(j,"slot");int slot=cJSON_IsNumber(sv)?sv->valueint:0;const char*name=json_string(j,"name","");const char*cat=json_string(j,"category","");const char*note=json_string(j,"note","");bool p=false,ow=json_bool(j,"overwrite",false,&p);freerig_memory_t m;esp_err_t e=freerig_memory_save_current(slot,name,cat,note,ow,&m);cJSON_Delete(j);if(e==ESP_ERR_INVALID_STATE)return send_error(req,"409 Conflict","memory occupied or radio state unavailable");if(e!=ESP_OK)return send_error(req,"502 Bad Gateway",esp_err_to_name(e));cJSON*o=cJSON_CreateObject();cJSON_AddTrueToObject(o,"ok");cJSON_AddItemToObject(o,"memory",memory_json(&m));cJSON_AddItemToObject(o,"state",state_json());return send_json(req,o);}
static bool parse_memory_path(const char*uri,int*slot,const char**tail){const char*p=strstr(uri,"/api/v1/memories/");if(!p)return false;p+=17;if(!isdigit((unsigned char)*p))return false;int v=0;while(isdigit((unsigned char)*p)){v=v*10+(*p-'0');p++;}if(v<1||v>99)return false;*slot=v;if(tail)*tail=p;return true;}
static esp_err_t memory_wild_handler(httpd_req_t *req){if(ft8_rf_operation_is_running())return send_error(req,"409 Conflict","memory operations are locked during FT8 TX/Tune");int slot=0;const char*tail=NULL;if(!parse_memory_path(req->uri,&slot,&tail))return send_error(req,"404 Not Found","invalid memory path");if(req->method==HTTP_POST&&tail&&!strcmp(tail,"/recall")){cJSON*j=read_json(req);const char*a=j?json_string(j,"action","memory"):"memory";char act[16];snprintf(act,sizeof(act),"%s",a);if(j)cJSON_Delete(j);esp_err_t e=freerig_memory_recall(slot,act);if(e!=ESP_OK)return send_error(req,e==ESP_ERR_NOT_FOUND?"404 Not Found":"502 Bad Gateway",esp_err_to_name(e));cJSON*o=cJSON_CreateObject();cJSON_AddTrueToObject(o,"ok");cJSON_AddStringToObject(o,"action",act);cJSON_AddNumberToObject(o,"slot",slot);cJSON_AddItemToObject(o,"state",state_json());return send_json(req,o);}if(req->method==HTTP_PUT&&(tail==NULL||*tail=='\0')){cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");int hz=json_int(j,"frequency_hz",0);const char*mode=json_string(j,"mode",NULL);const char*name=json_string(j,"name",NULL);const char*cat=json_string(j,"category",NULL);const char*note=json_string(j,"note",NULL);freerig_memory_t m;esp_err_t e=freerig_memory_edit(slot,(uint32_t)hz,mode,name,cat,note,&m);cJSON_Delete(j);if(e!=ESP_OK)return send_error(req,e==ESP_ERR_NOT_FOUND?"404 Not Found":"502 Bad Gateway",esp_err_to_name(e));cJSON*o=cJSON_CreateObject();cJSON_AddTrueToObject(o,"ok");cJSON_AddItemToObject(o,"memory",memory_json(&m));cJSON_AddItemToObject(o,"state",state_json());return send_json(req,o);}return send_error(req,"404 Not Found","unsupported memory action");}

static double cw_estimate_seconds(const char *msg,int wpm){size_t n=strlen(msg);return fmax(0.4,(double)n*6.0*1.2/(double)(wpm<4?4:wpm));}
static void cw_finish_task(void*arg){uint32_t ms=(uint32_t)(uintptr_t)arg;vTaskDelay(pdMS_TO_TICKS(ms));portENTER_CRITICAL(&s_cw_mux);s_cw_sending=false;portEXIT_CRITICAL(&s_cw_mux);vTaskDelete(NULL);}
static cJSON*cw_json(void){portENTER_CRITICAL(&s_cw_mux);bool sending=s_cw_sending;char msg[51];snprintf(msg,sizeof(msg),"%s",s_cw_message);int w=s_cw_wpm,slot=s_cw_slot;uint64_t start=s_cw_started_ms,end=s_cw_expected_end_ms;portEXIT_CRITICAL(&s_cw_mux);cJSON*o=cJSON_CreateObject();cJSON_AddBoolToObject(o,"sending",sending);cJSON_AddStringToObject(o,"message",msg);cJSON_AddNumberToObject(o,"wpm",w);cJSON_AddNumberToObject(o,"memory_slot",slot);cJSON_AddNumberToObject(o,"started_ms",(double)start);cJSON_AddNumberToObject(o,"expected_end_ms",(double)end);return o;}
static esp_err_t cw_status_handler(httpd_req_t*req){cJSON*o=cJSON_CreateObject();cJSON_AddTrueToObject(o,"ok");cJSON_AddItemToObject(o,"cw",cw_json());return send_json(req,o);}
static esp_err_t cw_send_handler(httpd_req_t*req){cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");const char*src=json_string(j,"message","");int w=json_int(j,"wpm",25),slot=json_int(j,"memory_slot",5);char msg[51];size_t k=0;bool space=false;for(const char*p=src;*p&&k<50;p++){unsigned char ch=(unsigned char)*p;if(ch==';'||ch=='\r'||ch=='\n'){cJSON_Delete(j);return send_error(req,"422 Unprocessable Entity","invalid CW character");}if(isspace(ch)){space=true;continue;}if(space&&k>0)msg[k++]=' ';space=false;msg[k++]=(char)toupper(ch);}msg[k]='\0';cJSON_Delete(j);if(k==0||w<4||w>60||slot<1||slot>5)return send_error(req,"422 Unprocessable Entity","invalid CW message/wpm/slot");ft710_cat_status_t st;ft710_cat_get_status(&st);if(strcmp(st.mode,"CW-U")&&strcmp(st.mode,"CW-L"))return send_error(req,"409 Conflict","Select CW-U or CW-L before sending CW");if(st.ptt_active)return send_error(req,"409 Conflict","Release voice PTT before sending CW");char c[96];esp_err_t e;snprintf(c,sizeof(c),"KS%03d;",w);e=ft710_cat_set(c,API_TIMEOUT_MS);if(e==ESP_OK){vTaskDelay(pdMS_TO_TICKS(40));e=ft710_cat_set("KR1;",API_TIMEOUT_MS);}if(e==ESP_OK){vTaskDelay(pdMS_TO_TICKS(40));e=ft710_cat_set("BI1;",API_TIMEOUT_MS);}if(e==ESP_OK){vTaskDelay(pdMS_TO_TICKS(40));e=ft710_cat_set("SD13;",API_TIMEOUT_MS);}if(e==ESP_OK){vTaskDelay(pdMS_TO_TICKS(40));snprintf(c,sizeof(c),"KM%d%s;",slot,msg);e=ft710_cat_set(c,API_TIMEOUT_MS);}if(e==ESP_OK){vTaskDelay(pdMS_TO_TICKS(80));snprintf(c,sizeof(c),"KY0%d;",slot);e=ft710_cat_set(c,API_TIMEOUT_MS);}if(e!=ESP_OK)return send_error(req,"502 Bad Gateway",esp_err_to_name(e));uint32_t ms=(uint32_t)((cw_estimate_seconds(msg,w)+0.8)*1000.0);portENTER_CRITICAL(&s_cw_mux);s_cw_sending=true;snprintf(s_cw_message,sizeof(s_cw_message),"%s",msg);s_cw_wpm=w;s_cw_slot=slot;s_cw_started_ms=(uint64_t)(esp_timer_get_time()/1000);s_cw_expected_end_ms=s_cw_started_ms+ms;portEXIT_CRITICAL(&s_cw_mux);(void)xTaskCreate(cw_finish_task,"cw_finish",2048,(void*)(uintptr_t)ms,2,NULL);cJSON*o=cJSON_CreateObject();cJSON_AddTrueToObject(o,"ok");cJSON_AddItemToObject(o,"cw",cw_json());return send_json(req,o);}
static esp_err_t cw_stop_handler(httpd_req_t*req){esp_err_t e=ft710_cat_set("KY00;",API_TIMEOUT_MS);portENTER_CRITICAL(&s_cw_mux);s_cw_sending=false;portEXIT_CRITICAL(&s_cw_mux);if(e!=ESP_OK)return send_error(req,"502 Bad Gateway",esp_err_to_name(e));cJSON*o=cJSON_CreateObject();cJSON_AddTrueToObject(o,"ok");cJSON_AddItemToObject(o,"cw",cw_json());return send_json(req,o);}

static esp_err_t video_settings_get(httpd_req_t*req){video_jpeg_status_t v;video_jpeg_get_status(&v);cJSON*o=cJSON_CreateObject();cJSON_AddTrueToObject(o,"ok");cJSON*x=cJSON_AddObjectToObject(o,"settings");cJSON_AddNumberToObject(x,"fps",v.fps_limit);cJSON_AddNumberToObject(x,"jpeg_quality",v.quality);return send_json(req,o);}
static esp_err_t video_settings_post(httpd_req_t*req){video_jpeg_status_t v;video_jpeg_get_status(&v);cJSON*j=read_json(req);if(!j)return send_error(req,"422 Unprocessable Entity","invalid JSON");int fps=json_int(j,"fps",v.fps_limit),q=json_int(j,"jpeg_quality",v.quality);cJSON_Delete(j);esp_err_t e=video_jpeg_set_settings((uint8_t)q,(uint8_t)fps);if(e!=ESP_OK)return send_error(req,"422 Unprocessable Entity","fps 1..30, jpeg_quality 20..95");return video_settings_get(req);}

static void log_config_json(cJSON *x, const freerig_qrz_config_t *q)
{
    const bool has_call = q && q->station_callsign[0];
    const bool qrz_ready = has_call && q->api_key_set;
    const bool gt_ready = q && q->gridtracker_host[0] && q->gridtracker_port > 0;
    const bool any_destination = q && (q->qrz_enabled || q->gridtracker_enabled);
    const bool selected_ready = q &&
        (!q->qrz_enabled || q->api_key_set) &&
        (!q->gridtracker_enabled || gt_ready);
    const bool log_ready = has_call && any_destination && selected_ready;
    cJSON_AddBoolToObject(x, "configured", qrz_ready);
    cJSON_AddBoolToObject(x, "log_configured", log_ready);
    if (has_call) cJSON_AddStringToObject(x, "station_callsign", q->station_callsign);
    else cJSON_AddNullToObject(x, "station_callsign");
    cJSON_AddBoolToObject(x, "api_key_set", q && q->api_key_set);
    cJSON_AddBoolToObject(x, "qrz_enabled", q ? q->qrz_enabled : true);
    cJSON_AddBoolToObject(x, "qrz_configured", qrz_ready);
    cJSON_AddBoolToObject(x, "gridtracker_enabled", q && q->gridtracker_enabled);
    cJSON_AddBoolToObject(x, "gridtracker_configured", gt_ready);
    cJSON_AddStringToObject(x, "gridtracker_host", q ? q->gridtracker_host : "");
    cJSON_AddNumberToObject(x, "gridtracker_port", q && q->gridtracker_port ? q->gridtracker_port : FREERIG_GRIDTRACKER_DEFAULT_PORT);
    cJSON_AddStringToObject(x, "endpoint", "https://logbook.qrz.com/api");
}

static esp_err_t qrz_status_handler(httpd_req_t *req)
{
    freerig_qrz_config_t q;
    esp_err_t e = freerig_config_get_qrz(&q);
    if (e != ESP_OK) return send_error(req, "500 Internal Server Error", esp_err_to_name(e));
    cJSON *o = cJSON_CreateObject();
    cJSON_AddTrueToObject(o, "ok");
    cJSON *x = cJSON_AddObjectToObject(o, "qrz");
    log_config_json(x, &q);
    cJSON *log = cJSON_Duplicate(x, true);
    if (log) cJSON_AddItemToObject(o, "log", log);
    return send_json(req, o);
}

static esp_err_t qrz_config_handler(httpd_req_t *req)
{
    freerig_qrz_config_t current;
    memset(&current, 0, sizeof(current));
    current.qrz_enabled = true;
    current.gridtracker_port = FREERIG_GRIDTRACKER_DEFAULT_PORT;
    (void)freerig_config_get_qrz(&current);

    cJSON *j = read_json(req);
    if (!j) return send_error(req, "422 Unprocessable Entity", "invalid JSON");
    const char *call = json_string(j, "station_callsign", NULL);
    cJSON *kv = cJSON_GetObjectItemCaseSensitive(j, "api_key");
    const char *key = cJSON_IsString(kv) ? kv->valuestring : NULL;
    bool qrz_present = false;
    bool gt_present = false;
    bool qrz_enabled = json_bool(j, "qrz_enabled", current.qrz_enabled, &qrz_present);
    bool gridtracker_enabled = json_bool(j, "gridtracker_enabled", current.gridtracker_enabled, &gt_present);
    const char *gridtracker_host = json_string(j, "gridtracker_host", current.gridtracker_host);
    int gridtracker_port_in = json_int(j, "gridtracker_port", current.gridtracker_port ? current.gridtracker_port : FREERIG_GRIDTRACKER_DEFAULT_PORT);
    if (!qrz_present) qrz_enabled = current.qrz_enabled;
    if (!gt_present) gridtracker_enabled = current.gridtracker_enabled;
    if (gridtracker_port_in <= 0 || gridtracker_port_in > 65535) {
        cJSON_Delete(j);
        return send_error(req, "422 Unprocessable Entity", "invalid GridTracker UDP port");
    }
    esp_err_t e = freerig_config_set_log(call, key, qrz_enabled, gridtracker_enabled,
                                         gridtracker_host, (uint16_t)gridtracker_port_in);
    cJSON_Delete(j);
    if (e != ESP_OK) return send_error(req, "422 Unprocessable Entity", "invalid Log configuration");
    return qrz_status_handler(req);
}

static void wireguard_status_to_json(cJSON *x, const freerig_wireguard_config_t *cfg, const freerig_wireguard_status_t *st)
{
    cJSON_AddBoolToObject(x, "configured", cfg && cfg->config_set);
    cJSON_AddBoolToObject(x, "enable_on_boot", cfg && cfg->enable_on_boot);
    cJSON_AddBoolToObject(x, "starting", st && st->starting);
    cJSON_AddBoolToObject(x, "active", st && st->active);
    cJSON_AddBoolToObject(x, "peer_up", st && st->peer_up);
    cJSON_AddStringToObject(x, "config_text", cfg ? cfg->config_text : "");
    cJSON_AddStringToObject(x, "interface_ip", st ? st->interface_ip : "");
    cJSON_AddStringToObject(x, "netmask", st ? st->netmask : "");
    cJSON_AddStringToObject(x, "allowed_ip", st ? st->allowed_ip : "");
    cJSON_AddStringToObject(x, "allowed_mask", st ? st->allowed_mask : "");
    cJSON_AddStringToObject(x, "endpoint_host", st ? st->endpoint_host : "");
    cJSON_AddStringToObject(x, "endpoint_ip", st ? st->endpoint_ip : "");
    cJSON_AddNumberToObject(x, "endpoint_port", st ? st->endpoint_port : 0);
    cJSON_AddNumberToObject(x, "listen_port", st ? st->listen_port : 0);
    cJSON_AddNumberToObject(x, "keepalive_s", st ? st->keepalive_s : 0);
    cJSON_AddNumberToObject(x, "starts", st ? st->starts : 0);
    cJSON_AddNumberToObject(x, "stops", st ? st->stops : 0);
    cJSON_AddStringToObject(x, "last_error", st ? esp_err_to_name(st->last_error) : "ESP_OK");
    cJSON_AddStringToObject(x, "last_error_text", st ? st->last_error_text : "");
}

static esp_err_t wireguard_status_handler(httpd_req_t *req)
{
    freerig_wireguard_config_t *cfg = calloc(1, sizeof(*cfg));
    if (!cfg) return send_error(req, "500 Internal Server Error", "WireGuard config allocation failed");
    esp_err_t e = freerig_config_get_wireguard(cfg);
    if (e != ESP_OK) {
        free(cfg);
        return send_error(req, "500 Internal Server Error", esp_err_to_name(e));
    }
    freerig_wireguard_status_t st;
    freerig_wireguard_get_status(&st);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddTrueToObject(o, "ok");
    cJSON *x = cJSON_AddObjectToObject(o, "wireguard");
    wireguard_status_to_json(x, cfg, &st);
    free(cfg);
    return send_json(req, o);
}

static esp_err_t wireguard_config_handler(httpd_req_t *req)
{
    cJSON *j = read_json(req);
    if (!j) return send_error(req, "422 Unprocessable Entity", "invalid JSON");
    const char *text = json_string(j, "config_text", "");
    bool boot_present = false;
    bool enable_on_boot = json_bool(j, "enable_on_boot", false, &boot_present);
    if (!boot_present) enable_on_boot = false;
    bool has_nonspace = false;
    for (const char *p = text; p && *p; ++p) {
        if (!isspace((unsigned char)*p)) {
            has_nonspace = true;
            break;
        }
    }
    if (enable_on_boot && !has_nonspace) {
        cJSON_Delete(j);
        return send_error(req, "422 Unprocessable Entity", "WireGuard config is required when enable on boot is active");
    }
    esp_err_t e = freerig_config_set_wireguard(text, enable_on_boot);
    cJSON_Delete(j);
    if (e == ESP_ERR_INVALID_SIZE) return send_error(req, "422 Unprocessable Entity", "WireGuard config text is too long");
    if (e != ESP_OK) return send_error(req, "500 Internal Server Error", esp_err_to_name(e));
    e = enable_on_boot ? freerig_wireguard_apply_saved_config_async() : freerig_wireguard_stop();
    if (e != ESP_OK) return send_error(req, "500 Internal Server Error", esp_err_to_name(e));
    return wireguard_status_handler(req);
}

static const char *band_for(uint32_t hz)
{
    struct B { uint32_t lo, hi; const char *n; };
    static const struct B b[] = {
        {135700,137800,"2190m"},{472000,479000,"630m"},{1800000,2000000,"160m"},
        {3500000,4000000,"80m"},{5060000,5450000,"60m"},{7000000,7300000,"40m"},
        {10100000,10150000,"30m"},{14000000,14350000,"20m"},{18068000,18168000,"17m"},
        {21000000,21450000,"15m"},{24890000,24990000,"12m"},{28000000,29700000,"10m"},
        {50000000,54000000,"6m"},{70000000,71000000,"4m"}
    };
    for (size_t i = 0; i < sizeof(b) / sizeof(b[0]); ++i) {
        if (hz >= b[i].lo && hz <= b[i].hi) return b[i].n;
    }
    return NULL;
}

static bool adif_mode(const char *radio, const char *override, const char *sub_override, char *mode, size_t ms, char *sub, size_t ss)
{
    sub[0] = '\0';
    if (override && strcasecmp(override, "AUTO")) {
        if (!strcasecmp(override, "FT8")) snprintf(mode, ms, "FT8");
        else if (!strcasecmp(override, "FT4")) { snprintf(mode, ms, "MFSK"); snprintf(sub, ss, "FT4"); }
        else if (!strcasecmp(override, "JS8")) { snprintf(mode, ms, "MFSK"); snprintf(sub, ss, "JS8"); }
        else if (!strcasecmp(override, "MFSK") && sub_override && !strcasecmp(sub_override, "JS8")) { snprintf(mode, ms, "MFSK"); snprintf(sub, ss, "JS8"); }
        else if (!strcasecmp(override, "PSK31")) { snprintf(mode, ms, "PSK"); snprintf(sub, ss, "PSK31"); }
        else if (!strcasecmp(override, "RTTY")) snprintf(mode, ms, "RTTY");
        else if (!strcasecmp(override, "SSB")) { snprintf(mode, ms, "SSB"); if (!strcasecmp(radio, "USB") || !strcasecmp(radio, "LSB")) snprintf(sub, ss, "%s", radio); }
        else if (!strcasecmp(override, "CW") || !strcasecmp(override, "AM") || !strcasecmp(override, "FM") || !strcasecmp(override, "SSTV")) snprintf(mode, ms, "%s", override);
        else return false;
        return true;
    }
    if (!strcasecmp(radio, "USB") || !strcasecmp(radio, "LSB")) { snprintf(mode, ms, "SSB"); snprintf(sub, ss, "%s", radio); return true; }
    if (!strcasecmp(radio, "CW-U") || !strcasecmp(radio, "CW-L")) { snprintf(mode, ms, "CW"); return true; }
    if (!strcasecmp(radio, "AM") || !strcasecmp(radio, "AM-N")) { snprintf(mode, ms, "AM"); return true; }
    if (!strcasecmp(radio, "FM") || !strcasecmp(radio, "FM-N")) { snprintf(mode, ms, "FM"); return true; }
    if (!strcasecmp(radio, "RTTY-L") || !strcasecmp(radio, "RTTY-U")) { snprintf(mode, ms, "RTTY"); return true; }
    return false;
}

static void form_encode(const char *src, char *dst, size_t cap)
{
    static const char hex[] = "0123456789ABCDEF";
    size_t j = 0;
    for (const unsigned char *p = (const unsigned char *)src; *p && j + 4 < cap; ++p) {
        unsigned char c = *p;
        if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') dst[j++] = (char)c;
        else if (c == ' ') dst[j++] = '+';
        else { dst[j++] = '%'; dst[j++] = hex[c >> 4]; dst[j++] = hex[c & 15]; }
    }
    dst[j] = '\0';
}

typedef struct { char *buf; size_t cap; size_t len; bool truncated; } http_accum_t;

static esp_err_t qrz_http_event(esp_http_client_event_t *evt)
{
    http_accum_t *a = (http_accum_t *)evt->user_data;
    if (evt->event_id == HTTP_EVENT_ON_DATA && a && evt->data_len > 0 && a->cap > 0) {
        size_t n = (size_t)evt->data_len;
        if (a->len + n >= a->cap) { a->truncated = true; n = a->cap - a->len - 1; }
        if (n) {
            memcpy(a->buf + a->len, evt->data, n);
            a->len += n;
            a->buf[a->len] = '\0';
        }
    }
    return ESP_OK;
}

typedef struct {
    uint32_t id;
    freerig_qrz_config_t config;
    char call[17];
    char band[8];
    char mode[16];
    char submode[16];
    char date[9];
    char time_on[7];
    char time_off[7];
    char grid[9];
    char my_grid[9];
    char rst_sent[8];
    char rst_rcvd[8];
    char comment[160];
    char my_rig[48];
    uint32_t frequency_hz;
    uint32_t rx_frequency_hz;
    int tx_power_w;
} qrz_job_t;

typedef struct {
    bool busy;
    uint32_t job_id;
    char state[16];
    char detail[192];
    char call[17];
    char station_callsign[FREERIG_QRZ_CALLSIGN_MAX];
    char band[8];
    char mode[16];
    char submode[16];
    char date[9];
    char time_on[7];
    char logid[32];
    uint32_t frequency_hz;
    uint32_t rx_frequency_hz;
    int tx_power_w;
    char adif_preview[768];
    bool qrz_enabled;
    bool gridtracker_enabled;
    bool qrz_sent;
    bool gridtracker_sent;
    char gridtracker_host[FREERIG_GRIDTRACKER_HOST_MAX];
    uint16_t gridtracker_port;
    char qrz_detail[128];
    char gridtracker_detail[128];
} qrz_job_status_t;

static portMUX_TYPE s_qrz_mux = portMUX_INITIALIZER_UNLOCKED;
static qrz_job_status_t s_qrz_status = { .state = "idle" };
static uint32_t s_qrz_next_job_id = 1;
static qrz_job_status_t qrz_status_snapshot(void);

static void qrz_status_from_job(const qrz_job_t *job, const char *state, const char *detail, const char *logid, bool busy)
{
    qrz_job_status_t next = qrz_status_snapshot();
    next.busy = busy;
    next.job_id = job ? job->id : next.job_id;
    snprintf(next.state, sizeof(next.state), "%s", state ? state : "idle");
    snprintf(next.detail, sizeof(next.detail), "%s", detail ? detail : "");
    snprintf(next.logid, sizeof(next.logid), "%s", logid ? logid : "");
    if (job) {
        snprintf(next.call, sizeof(next.call), "%s", job->call);
        snprintf(next.station_callsign, sizeof(next.station_callsign), "%s", job->config.station_callsign);
        snprintf(next.band, sizeof(next.band), "%s", job->band);
        snprintf(next.mode, sizeof(next.mode), "%s", job->mode);
        snprintf(next.submode, sizeof(next.submode), "%s", job->submode);
        snprintf(next.date, sizeof(next.date), "%s", job->date);
        snprintf(next.time_on, sizeof(next.time_on), "%s", job->time_on);
        next.frequency_hz = job->frequency_hz;
        next.rx_frequency_hz = job->rx_frequency_hz;
        next.tx_power_w = job->tx_power_w;
        next.qrz_enabled = job->config.qrz_enabled;
        next.gridtracker_enabled = job->config.gridtracker_enabled;
        snprintf(next.gridtracker_host, sizeof(next.gridtracker_host), "%s", job->config.gridtracker_host);
        next.gridtracker_port = job->config.gridtracker_port;
        next.qrz_sent = false;
        next.gridtracker_sent = false;
        next.qrz_detail[0] = '\0';
        next.gridtracker_detail[0] = '\0';
    }
    portENTER_CRITICAL(&s_qrz_mux);
    s_qrz_status = next;
    portEXIT_CRITICAL(&s_qrz_mux);
}

static qrz_job_status_t qrz_status_snapshot(void)
{
    qrz_job_status_t out;
    portENTER_CRITICAL(&s_qrz_mux);
    out = s_qrz_status;
    portEXIT_CRITICAL(&s_qrz_mux);
    return out;
}

static void qrz_status_set_adif(const char *adif)
{
    qrz_job_status_t next = qrz_status_snapshot();
    snprintf(next.adif_preview, sizeof(next.adif_preview), "%s", adif ? adif : "");
    portENTER_CRITICAL(&s_qrz_mux);
    s_qrz_status = next;
    portEXIT_CRITICAL(&s_qrz_mux);
}

static void qrz_status_set_destinations(bool qrz_sent, const char *qrz_detail,
                                        bool gridtracker_sent, const char *gridtracker_detail)
{
    qrz_job_status_t next = qrz_status_snapshot();
    next.qrz_sent = qrz_sent;
    next.gridtracker_sent = gridtracker_sent;
    snprintf(next.qrz_detail, sizeof(next.qrz_detail), "%s", qrz_detail ? qrz_detail : "");
    snprintf(next.gridtracker_detail, sizeof(next.gridtracker_detail), "%s", gridtracker_detail ? gridtracker_detail : "");
    portENTER_CRITICAL(&s_qrz_mux);
    s_qrz_status = next;
    portEXIT_CRITICAL(&s_qrz_mux);
}

static void *qrz_alloc(size_t size)
{
    void *p = heap_caps_calloc(1, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    return p ? p : calloc(1, size);
}

static bool qrz_append(char *buf, size_t cap, size_t *used, const char *fmt, ...)
{
    if (!buf || !used || *used >= cap) return false;
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf + *used, cap - *used, fmt, ap);
    va_end(ap);
    if (n < 0 || (size_t)n >= cap - *used) return false;
    *used += (size_t)n;
    return true;
}

static void log_join_destination_detail(char *buf, size_t cap,
                                        bool qrz_selected, const char *qrz_detail,
                                        bool gridtracker_selected, const char *gridtracker_detail)
{
    if (!buf || cap == 0) return;
    buf[0] = '\0';
    size_t used = 0;
    bool wrote = false;
    if (qrz_selected && qrz_detail && qrz_detail[0]) {
        if (qrz_append(buf, cap, &used, "%s", qrz_detail)) wrote = true;
    }
    if (gridtracker_selected && gridtracker_detail && gridtracker_detail[0]) {
        if (wrote) (void)qrz_append(buf, cap, &used, " / ");
        (void)qrz_append(buf, cap, &used, "%s", gridtracker_detail);
    }
}

static bool qrz_adif_field(char *buf, size_t cap, size_t *used, const char *name, const char *value)
{
    if (!name || !value) return false;
    return qrz_append(buf, cap, used, "<%s:%zu>%s", name, strlen(value), value);
}

static bool qrz_adif_frequency(char *buf, size_t cap, size_t *used, const char *name, uint32_t hz)
{
    char value[24];
    int n = snprintf(value, sizeof(value), "%" PRIu32 ".%06" PRIu32, hz / 1000000U, hz % 1000000U);
    if (n <= 0 || (size_t)n >= sizeof(value)) return false;
    return qrz_adif_field(buf, cap, used, name, value);
}

static bool qrz_adif_int(char *buf, size_t cap, size_t *used, const char *name, int value)
{
    char text[24];
    int n = snprintf(text, sizeof(text), "%d", value);
    if (n <= 0 || (size_t)n >= sizeof(text)) return false;
    return qrz_adif_field(buf, cap, used, name, text);
}

static esp_err_t gridtracker_send_adif(const freerig_qrz_config_t *cfg, const char *adif,
                                       char *detail, size_t detail_size)
{
    if (!cfg || !cfg->gridtracker_host[0] || cfg->gridtracker_port == 0 || !adif) {
        if (detail && detail_size) snprintf(detail, detail_size, "GridTracker is not configured");
        return ESP_ERR_INVALID_ARG;
    }
    char port[8];
    snprintf(port, sizeof(port), "%u", (unsigned)cfg->gridtracker_port);
    struct addrinfo hints = {
        .ai_family = AF_INET,
        .ai_socktype = SOCK_DGRAM,
        .ai_protocol = IPPROTO_UDP,
    };
    struct addrinfo *res = NULL;
    int rc = getaddrinfo(cfg->gridtracker_host, port, &hints, &res);
    if (rc != 0 || !res) {
        if (detail && detail_size) snprintf(detail, detail_size, "GridTracker address lookup failed");
        return ESP_FAIL;
    }
    int sock = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (sock < 0) {
        if (detail && detail_size) snprintf(detail, detail_size, "GridTracker UDP socket failed: errno %d", errno);
        freeaddrinfo(res);
        return ESP_FAIL;
    }
    ssize_t sent = sendto(sock, adif, strlen(adif), 0, res->ai_addr, res->ai_addrlen);
    close(sock);
    freeaddrinfo(res);
    if (sent < 0 || (size_t)sent != strlen(adif)) {
        if (detail && detail_size) snprintf(detail, detail_size, "GridTracker UDP send failed: errno %d", errno);
        return ESP_FAIL;
    }
    if (detail && detail_size) {
        snprintf(detail, detail_size, "GridTracker UDP sent to %s:%u",
                 cfg->gridtracker_host, (unsigned)cfg->gridtracker_port);
    }
    return ESP_OK;
}

static void qrz_response_value(const char *response, const char *key, char *out, size_t out_size)
{
    if (!out || out_size == 0) return;
    out[0] = '\0';
    if (!response || !key) return;
    size_t key_len = strlen(key);
    const char *p = response;
    while ((p = strstr(p, key)) != NULL) {
        if ((p == response || p[-1] == '&') && p[key_len] == '=') {
            p += key_len + 1;
            size_t n = strcspn(p, "&\r\n");
            if (n >= out_size) n = out_size - 1;
            memcpy(out, p, n);
            out[n] = '\0';
            return;
        }
        p += key_len;
    }
}


#define QRZ_FETCH_MAX_RECORDS 250U
#define QRZ_FETCH_RESPONSE_CAP (512U * 1024U)

typedef struct {
    uint32_t id;
    freerig_qrz_config_t config;
    uint64_t after_logid;
    unsigned max_records;
    char modsince[24];
} qrz_fetch_job_t;

typedef struct {
    bool busy;
    bool cancel_requested;
    uint32_t job_id;
    char state[16];
    char detail[192];
    uint64_t after_logid;
    uint64_t next_after_logid;
    unsigned count;
    bool has_more;
    bool page_ready;
    size_t page_bytes;
} qrz_fetch_status_t;

static portMUX_TYPE s_qrz_fetch_mux = portMUX_INITIALIZER_UNLOCKED;
static qrz_fetch_status_t s_qrz_fetch_status = { .state = "idle" };
static uint32_t s_qrz_fetch_next_job_id = 1;
static SemaphoreHandle_t s_qrz_fetch_page_mutex;
static char *s_qrz_fetch_page;
static size_t s_qrz_fetch_page_len;

static qrz_fetch_status_t qrz_fetch_status_snapshot(void)
{
    qrz_fetch_status_t out;
    portENTER_CRITICAL(&s_qrz_fetch_mux);
    out = s_qrz_fetch_status;
    portEXIT_CRITICAL(&s_qrz_fetch_mux);
    return out;
}

static void qrz_fetch_status_set(const qrz_fetch_job_t *job, const char *state, const char *detail,
                                 bool busy, unsigned count, uint64_t next_after, bool has_more,
                                 bool page_ready, size_t page_bytes)
{
    qrz_fetch_status_t next = qrz_fetch_status_snapshot();
    next.busy = busy;
    if (job) {
        next.job_id = job->id;
        next.after_logid = job->after_logid;
    }
    snprintf(next.state, sizeof(next.state), "%s", state ? state : "idle");
    snprintf(next.detail, sizeof(next.detail), "%s", detail ? detail : "");
    next.count = count;
    next.next_after_logid = next_after;
    next.has_more = has_more;
    next.page_ready = page_ready;
    next.page_bytes = page_bytes;
    portENTER_CRITICAL(&s_qrz_fetch_mux);
    /* Preserve a cancel request raised by the HTTP handler while a job is running. */
    if (s_qrz_fetch_status.cancel_requested && busy) next.cancel_requested = true;
    s_qrz_fetch_status = next;
    portEXIT_CRITICAL(&s_qrz_fetch_mux);
}

static bool qrz_fetch_cancel_requested(void)
{
    bool cancelled;
    portENTER_CRITICAL(&s_qrz_fetch_mux);
    cancelled = s_qrz_fetch_status.cancel_requested;
    portEXIT_CRITICAL(&s_qrz_fetch_mux);
    return cancelled;
}

static int qrz_hex_value(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

static void form_decode_inplace(char *text)
{
    if (!text) return;
    char *src = text, *dst = text;
    while (*src) {
        if (*src == '+') {
            *dst++ = ' ';
            src++;
        } else if (*src == '%' && src[1] && src[2]) {
            int hi = qrz_hex_value(src[1]), lo = qrz_hex_value(src[2]);
            if (hi >= 0 && lo >= 0) {
                *dst++ = (char)((hi << 4) | lo);
                src += 3;
            } else {
                *dst++ = *src++;
            }
        } else {
            *dst++ = *src++;
        }
    }
    *dst = '\0';
}

static char *qrz_response_value_alloc(const char *response, const char *key)
{
    if (!response || !key) return NULL;
    const size_t key_len = strlen(key);
    const char *p = response;
    while ((p = strstr(p, key)) != NULL) {
        if ((p == response || p[-1] == '&') && p[key_len] == '=') {
            p += key_len + 1;
            size_t n = strcspn(p, "&\r\n");
            char *out = qrz_alloc(n + 1U);
            if (!out) return NULL;
            memcpy(out, p, n);
            out[n] = '\0';
            form_decode_inplace(out);
            return out;
        }
        p += key_len;
    }
    return NULL;
}

/*
 * QRZ's FETCH ADIF payload is special: the ADIF value may contain literal
 * ampersands as HTML entities (for example &lt;CALL:...&gt;).  Generic
 * name=value extraction stops at '&' and therefore turns a perfectly valid
 * page into an empty ADIF string.  Keep the complete ADIF tail, URL-decode
 * it, then decode the small HTML entity set QRZ uses for the ADIF document.
 */
static void qrz_html_decode_inplace(char *text)
{
    if (!text) return;
    char *src = text, *dst = text;
    while (*src) {
        if (!strncasecmp(src, "&lt;", 4)) { *dst++ = '<'; src += 4; }
        else if (!strncasecmp(src, "&gt;", 4)) { *dst++ = '>'; src += 4; }
        else if (!strncasecmp(src, "&amp;", 5)) { *dst++ = '&'; src += 5; }
        else if (!strncasecmp(src, "&quot;", 6)) { *dst++ = '"'; src += 6; }
        else if (!strncasecmp(src, "&apos;", 6)) { *dst++ = '\''; src += 6; }
        else { *dst++ = *src++; }
    }
    *dst = '\0';
}

static char *qrz_response_adif_alloc(const char *response)
{
    if (!response) return NULL;
    const char *p = response;
    while ((p = strstr(p, "ADIF=")) != NULL) {
        if (p == response || p[-1] == '&') {
            p += 5;
            size_t n = strlen(p);
            while (n && (p[n - 1] == '\r' || p[n - 1] == '\n')) n--;
            char *out = qrz_alloc(n + 1U);
            if (!out) return NULL;
            memcpy(out, p, n);
            out[n] = '\0';
            form_decode_inplace(out);
            qrz_html_decode_inplace(out);
            return out;
        }
        p += 5;
    }
    return NULL;
}

static void qrz_adif_page_stats(const char *adif, unsigned *records, uint64_t *max_logid)
{
    unsigned count = 0;
    uint64_t max_id = 0;
    if (adif) {
        for (const char *p = adif; *p; ++p) {
            if (*p == '<' && !strncasecmp(p, "<EOR>", 5)) count++;
            if (*p == '<' && !strncasecmp(p, "<APP_QRZLOG_LOGID:", 18)) {
                char *len_end = NULL;
                unsigned long field_len = strtoul(p + 18, &len_end, 10);
                if (!len_end || len_end == p + 18 || field_len == 0 || field_len > 32) continue;
                const char *gt = strchr(len_end, '>');
                if (!gt) continue;
                const char *value = gt + 1;
                uint64_t id = 0;
                unsigned used = 0;
                while (used < field_len && value[used] >= '0' && value[used] <= '9') {
                    id = id * 10U + (uint64_t)(value[used] - '0');
                    used++;
                }
                if (used && id > max_id) max_id = id;
            }
        }
    }
    if (records) *records = count;
    if (max_logid) *max_logid = max_id;
}

static void qrz_fetch_task(void *arg)
{
    qrz_fetch_job_t *job = (qrz_fetch_job_t *)arg;
    qrz_fetch_status_set(job, "running", "Fetching QRZ Logbook ADIF page", true, 0, job->after_logid, false, false, 0);

    char *response = qrz_alloc(QRZ_FETCH_RESPONSE_CAP);
    char *encoded_key = NULL;
    char *encoded_option = NULL;
    char *post = NULL;
    char *adif = NULL;
    const char *error_detail = NULL;
    char error_buf[384] = {0};
    unsigned page_count = 0;
    uint64_t max_logid = 0;
    uint64_t next_after = job->after_logid;
    bool has_more = false;

    if (!response) { error_detail = "QRZ FETCH worker out of memory"; goto done; }
    if (qrz_fetch_cancel_requested()) goto cancelled;

    /*
     * Keep FETCH options deliberately minimal. QRZ documents TYPE=ADIF and
     * STATUS=ALL as defaults, so do not send redundant selectors. On the
     * first page omit AFTERLOGID:0 as well; MAX keeps the request bounded.
     * Subsequent pages use AFTERLOGID:<cursor>.
     */
    char option[160];
    if (job->modsince[0]) {
        if (job->after_logid > 0) {
            snprintf(option, sizeof(option), "MAX:%u,AFTERLOGID:%" PRIu64 ",MODSINCE:%s",
                     job->max_records, job->after_logid, job->modsince);
        } else {
            snprintf(option, sizeof(option), "MAX:%u,MODSINCE:%s",
                     job->max_records, job->modsince);
        }
    } else if (job->after_logid > 0) {
        snprintf(option, sizeof(option), "MAX:%u,AFTERLOGID:%" PRIu64,
                 job->max_records, job->after_logid);
    } else {
        snprintf(option, sizeof(option), "MAX:%u", job->max_records);
    }
    size_t key_cap = strlen(job->config.api_key) * 3U + 1U;
    size_t option_cap = strlen(option) * 3U + 1U;
    encoded_key = qrz_alloc(key_cap);
    encoded_option = qrz_alloc(option_cap);
    if (!encoded_key || !encoded_option) { error_detail = "QRZ FETCH worker out of memory"; goto done; }
    form_encode(job->config.api_key, encoded_key, key_cap);
    form_encode(option, encoded_option, option_cap);
    size_t post_cap = strlen(encoded_key) + strlen(encoded_option) + 40U;
    post = qrz_alloc(post_cap);
    if (!post) { error_detail = "QRZ FETCH worker out of memory"; goto done; }
    snprintf(post, post_cap, "KEY=%s&ACTION=FETCH&OPTION=%s", encoded_key, encoded_option);

    http_accum_t acc = {
        .buf = response,
        .cap = QRZ_FETCH_RESPONSE_CAP,
        .len = 0,
        .truncated = false,
    };
    char user_agent[96];
    snprintf(user_agent, sizeof(user_agent), "FreeRig710/1.0 (%s)", job->config.station_callsign);
    esp_http_client_config_t cfg = {
        .url = "https://logbook.qrz.com/api",
        .event_handler = qrz_http_event,
        .user_data = &acc,
        .timeout_ms = 15000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .user_agent = user_agent,
    };
    esp_http_client_handle_t h = esp_http_client_init(&cfg);
    if (!h) { error_detail = "QRZ FETCH HTTP client init failed"; goto done; }
    esp_http_client_set_method(h, HTTP_METHOD_POST);
    esp_http_client_set_header(h, "Content-Type", "application/x-www-form-urlencoded");
    esp_http_client_set_post_field(h, post, (int)strlen(post));
    esp_err_t err = esp_http_client_perform(h);
    int http_status = esp_http_client_get_status_code(h);
    esp_http_client_cleanup(h);

    if (qrz_fetch_cancel_requested()) goto cancelled;
    if (acc.truncated) { error_detail = "QRZ FETCH response exceeded page buffer"; goto done; }
    if (err != ESP_OK) {
        snprintf(error_buf, sizeof(error_buf), "QRZ FETCH HTTPS failed: %s", esp_err_to_name(err));
        error_detail = error_buf; goto done;
    }
    if (http_status < 200 || http_status >= 300) {
        snprintf(error_buf, sizeof(error_buf), "QRZ FETCH HTTP status %d", http_status);
        error_detail = error_buf; goto done;
    }
    char *result = qrz_response_value_alloc(response, "RESULT");
    if (!result || strcasecmp(result, "OK") != 0) {
        char *reason = qrz_response_value_alloc(response, "REASON");
        char *count_text = qrz_response_value_alloc(response, "COUNT");
        if (result && strcasecmp(result, "AUTH") == 0) {
            snprintf(error_buf, sizeof(error_buf),
                     "QRZ RESULT=AUTH: FETCH not authorized (subscription/logbook access); OPTION=%s", option);
        } else if (result && result[0] && reason && reason[0]) {
            snprintf(error_buf, sizeof(error_buf), "QRZ RESULT=%s: %s; OPTION=%s", result, reason, option);
        } else if (result && result[0] && count_text && count_text[0]) {
            snprintf(error_buf, sizeof(error_buf), "QRZ RESULT=%s COUNT=%s; OPTION=%s", result, count_text, option);
        } else if (result && result[0]) {
            snprintf(error_buf, sizeof(error_buf), "QRZ RESULT=%s; OPTION=%s", result, option);
        } else if (reason && reason[0]) {
            snprintf(error_buf, sizeof(error_buf), "QRZ FETCH rejected: %s; OPTION=%s", reason, option);
        } else {
            snprintf(error_buf, sizeof(error_buf), "QRZ FETCH response missing RESULT; OPTION=%s", option);
        }
        if (count_text) free(count_text);
        if (reason) free(reason);
        if (result) free(result);
        error_detail = error_buf; goto done;
    }
    free(result);
    char *count_text = qrz_response_value_alloc(response, "COUNT");
    unsigned long qrz_reported_count = count_text ? strtoul(count_text, NULL, 10) : 0UL;
    if (count_text) free(count_text);
    adif = qrz_response_adif_alloc(response);
    if (!adif) {
        /* A valid empty page may omit ADIF. */
        adif = qrz_alloc(1);
        if (!adif) { error_detail = "QRZ FETCH worker out of memory"; goto done; }
    }
    qrz_adif_page_stats(adif, &page_count, &max_logid);
    if (qrz_reported_count > 0UL && page_count == 0U) {
        snprintf(error_buf, sizeof(error_buf),
                 "QRZ reported %lu QSO but ADIF contained no parsable records", qrz_reported_count);
        error_detail = error_buf; goto done;
    }
    if (page_count && max_logid == 0) {
        error_detail = "QRZ page lacks APP_QRZLOG_LOGID; cannot advance cursor safely";
        goto done;
    }
    if (max_logid) next_after = max_logid + 1U;
    has_more = page_count >= job->max_records;

    if (xSemaphoreTake(s_qrz_fetch_page_mutex, pdMS_TO_TICKS(2000)) != pdTRUE) {
        error_detail = "QRZ page store busy"; goto done;
    }
    if (s_qrz_fetch_page) free(s_qrz_fetch_page);
    s_qrz_fetch_page = adif;
    s_qrz_fetch_page_len = strlen(adif);
    adif = NULL;
    xSemaphoreGive(s_qrz_fetch_page_mutex);
    qrz_fetch_status_set(job, "ok", "QRZ ADIF page ready", false, page_count, next_after, has_more, true, s_qrz_fetch_page_len);
    goto cleanup;

cancelled:
    qrz_fetch_status_set(job, "cancelled", "QRZ sync cancelled", false, 0, job->after_logid, false, false, 0);
    goto cleanup;

done:
    ESP_LOGW(TAG, "QRZ FETCH job %" PRIu32 " failed: %s", job->id, error_detail ? error_detail : "unknown error");
    qrz_fetch_status_set(job, "error", error_detail ? error_detail : "QRZ FETCH failed", false, 0, job->after_logid, false, false, 0);

cleanup:
    if (post) { memset(post, 0, strlen(post)); free(post); }
    if (encoded_key) { memset(encoded_key, 0, strlen(encoded_key)); free(encoded_key); }
    if (encoded_option) free(encoded_option);
    if (response) free(response);
    if (adif) free(adif);
    memset(job->config.api_key, 0, sizeof(job->config.api_key));
    free(job);
    vTaskDelete(NULL);
}

static cJSON *qrz_fetch_job_json(const qrz_fetch_status_t *st)
{
    cJSON *o = cJSON_CreateObject();
    cJSON_AddNumberToObject(o, "job_id", st->job_id);
    cJSON_AddStringToObject(o, "state", st->state);
    cJSON_AddBoolToObject(o, "busy", st->busy);
    cJSON_AddStringToObject(o, "detail", st->detail);
    cJSON_AddStringToObject(o, "after_logid", "");
    cJSON *after = cJSON_GetObjectItemCaseSensitive(o, "after_logid");
    char cursor[32];
    snprintf(cursor, sizeof(cursor), "%" PRIu64, st->after_logid);
    cJSON_SetValuestring(after, cursor);
    cJSON_AddStringToObject(o, "next_after_logid", "");
    cJSON *next = cJSON_GetObjectItemCaseSensitive(o, "next_after_logid");
    snprintf(cursor, sizeof(cursor), "%" PRIu64, st->next_after_logid);
    cJSON_SetValuestring(next, cursor);
    cJSON_AddNumberToObject(o, "count", st->count);
    cJSON_AddBoolToObject(o, "has_more", st->has_more);
    cJSON_AddBoolToObject(o, "page_ready", st->page_ready);
    cJSON_AddNumberToObject(o, "page_bytes", (double)st->page_bytes);
    return o;
}

static esp_err_t qrz_fetch_status_handler(httpd_req_t *req)
{
    qrz_fetch_status_t st = qrz_fetch_status_snapshot();
    cJSON *o = cJSON_CreateObject();
    cJSON_AddTrueToObject(o, "ok");
    cJSON_AddItemToObject(o, "job", qrz_fetch_job_json(&st));
    return send_json(req, o);
}

static esp_err_t qrz_fetch_page_handler(httpd_req_t *req)
{
    qrz_fetch_status_t st = qrz_fetch_status_snapshot();
    if (!st.page_ready) return send_error(req, "404 Not Found", "QRZ ADIF page is not ready");
    if (xSemaphoreTake(s_qrz_fetch_page_mutex, pdMS_TO_TICKS(2000)) != pdTRUE) {
        return send_error(req, "503 Service Unavailable", "QRZ page store busy");
    }
    cors(req);
    httpd_resp_set_type(req, "text/plain; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t out = httpd_resp_send(req, s_qrz_fetch_page ? s_qrz_fetch_page : "", s_qrz_fetch_page ? (ssize_t)s_qrz_fetch_page_len : 0);
    xSemaphoreGive(s_qrz_fetch_page_mutex);
    return out;
}

static esp_err_t qrz_fetch_cancel_handler(httpd_req_t *req)
{
    portENTER_CRITICAL(&s_qrz_fetch_mux);
    s_qrz_fetch_status.cancel_requested = true;
    portEXIT_CRITICAL(&s_qrz_fetch_mux);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddTrueToObject(o, "ok");
    cJSON_AddStringToObject(o, "detail", "cancel requested");
    return send_json(req, o);
}

static esp_err_t qrz_fetch_handler(httpd_req_t *req)
{
    freerig_qrz_config_t q;
    if (freerig_config_get_qrz(&q) != ESP_OK || !q.station_callsign[0] || !q.api_key_set) {
        return send_error(req, "503 Service Unavailable", "QRZ Logbook is not configured");
    }
    qrz_fetch_status_t current = qrz_fetch_status_snapshot();
    if (current.busy) return send_error(req, "409 Conflict", "a QRZ FETCH request is already running");

    cJSON *j = read_json(req);
    if (!j) return send_error(req, "422 Unprocessable Entity", "invalid JSON");
    qrz_fetch_job_t *job = calloc(1, sizeof(*job));
    if (!job) { cJSON_Delete(j); return send_error(req, "500 Internal Server Error", "out of memory"); }
    job->config = q;
    job->max_records = QRZ_FETCH_MAX_RECORDS;
    cJSON *max_item = cJSON_GetObjectItemCaseSensitive(j, "max");
    if (cJSON_IsNumber(max_item)) {
        int max = max_item->valueint;
        if (max > 0 && max <= (int)QRZ_FETCH_MAX_RECORDS) job->max_records = (unsigned)max;
    }
    cJSON *after = cJSON_GetObjectItemCaseSensitive(j, "after_logid");
    if (cJSON_IsString(after) && after->valuestring) job->after_logid = strtoull(after->valuestring, NULL, 10);
    else if (cJSON_IsNumber(after) && after->valuedouble > 0) job->after_logid = (uint64_t)after->valuedouble;
    const char *modsince = json_string(j, "modsince", NULL);
    if (modsince) snprintf(job->modsince, sizeof(job->modsince), "%s", modsince);
    cJSON_Delete(j);

    if (xSemaphoreTake(s_qrz_fetch_page_mutex, pdMS_TO_TICKS(2000)) == pdTRUE) {
        if (s_qrz_fetch_page) { free(s_qrz_fetch_page); s_qrz_fetch_page = NULL; }
        s_qrz_fetch_page_len = 0;
        xSemaphoreGive(s_qrz_fetch_page_mutex);
    }

    portENTER_CRITICAL(&s_qrz_fetch_mux);
    if (s_qrz_fetch_status.busy) {
        portEXIT_CRITICAL(&s_qrz_fetch_mux);
        memset(job->config.api_key, 0, sizeof(job->config.api_key)); free(job);
        return send_error(req, "409 Conflict", "a QRZ FETCH request is already running");
    }
    job->id = s_qrz_fetch_next_job_id++;
    if (s_qrz_fetch_next_job_id == 0) s_qrz_fetch_next_job_id = 1;
    s_qrz_fetch_status.busy = true;
    s_qrz_fetch_status.cancel_requested = false;
    portEXIT_CRITICAL(&s_qrz_fetch_mux);
    qrz_fetch_status_set(job, "queued", "QRZ FETCH queued", true, 0, job->after_logid, false, false, 0);

    if (xTaskCreate(qrz_fetch_task, "qrz_fetch", 12288, job, 3, NULL) != pdPASS) {
        qrz_fetch_status_set(job, "error", "unable to start QRZ FETCH worker", false, 0, job->after_logid, false, false, 0);
        memset(job->config.api_key, 0, sizeof(job->config.api_key)); free(job);
        return send_error(req, "503 Service Unavailable", "unable to start QRZ FETCH worker");
    }
    qrz_fetch_status_t accepted = qrz_fetch_status_snapshot();
    cJSON *o = cJSON_CreateObject();
    cJSON_AddTrueToObject(o, "ok");
    cJSON_AddBoolToObject(o, "accepted", true);
    cJSON_AddItemToObject(o, "job", qrz_fetch_job_json(&accepted));
    httpd_resp_set_status(req, "202 Accepted");
    return send_json(req, o);
}

static void qrz_log_task(void *arg)
{
    qrz_job_t *job = (qrz_job_t *)arg;
    qrz_status_from_job(job, "running", "Sending QSO to configured logs", NULL, true);

    const size_t adif_cap = 1024;
    char *adif = qrz_alloc(adif_cap);
    char *response = NULL;
    char *encoded_key = NULL;
    char *encoded_adif = NULL;
    char *post = NULL;
    const char *fatal_error = NULL;
    char logid[32] = {0};
    char qrz_detail[128] = {0};
    char gridtracker_detail[128] = {0};
    char final_detail[192] = {0};
    bool qrz_sent = false;
    bool gridtracker_sent = false;
    bool destination_error = false;
    const bool qrz_selected = job->config.qrz_enabled;
    const bool gridtracker_selected = job->config.gridtracker_enabled;
    const bool qrz_active = qrz_selected && job->config.api_key_set;
    const bool gridtracker_active = gridtracker_selected &&
        job->config.gridtracker_host[0] && job->config.gridtracker_port > 0;

    if (!qrz_selected && !gridtracker_selected) {
        fatal_error = "No log destination is configured";
        goto done;
    }

    if (!adif) {
        fatal_error = "Log worker out of memory";
        goto done;
    }

    size_t used = 0;
    bool ok = qrz_adif_field(adif, adif_cap, &used, "CALL", job->call);
    if (ok) ok = qrz_adif_field(adif, adif_cap, &used, "STATION_CALLSIGN", job->config.station_callsign);
    if (ok) ok = qrz_adif_field(adif, adif_cap, &used, "QSO_DATE", job->date);
    if (ok) ok = qrz_adif_field(adif, adif_cap, &used, "TIME_ON", job->time_on);
    if (ok && job->time_off[0]) ok = qrz_adif_field(adif, adif_cap, &used, "TIME_OFF", job->time_off);
    if (ok) ok = qrz_adif_field(adif, adif_cap, &used, "BAND", job->band);
    if (ok) ok = qrz_adif_frequency(adif, adif_cap, &used, "FREQ", job->frequency_hz);
    if (ok && job->rx_frequency_hz) ok = qrz_adif_frequency(adif, adif_cap, &used, "FREQ_RX", job->rx_frequency_hz);
    if (ok) ok = qrz_adif_field(adif, adif_cap, &used, "MODE", job->mode);
    if (ok && job->submode[0]) ok = qrz_adif_field(adif, adif_cap, &used, "SUBMODE", job->submode);
    if (ok && job->rst_sent[0]) ok = qrz_adif_field(adif, adif_cap, &used, "RST_SENT", job->rst_sent);
    if (ok && job->rst_rcvd[0]) ok = qrz_adif_field(adif, adif_cap, &used, "RST_RCVD", job->rst_rcvd);
    if (ok && job->grid[0]) ok = qrz_adif_field(adif, adif_cap, &used, "GRIDSQUARE", job->grid);
    if (ok && job->my_grid[0]) ok = qrz_adif_field(adif, adif_cap, &used, "MY_GRIDSQUARE", job->my_grid);
    if (ok && job->tx_power_w > 0) ok = qrz_adif_int(adif, adif_cap, &used, "TX_PWR", job->tx_power_w);
    if (ok && job->comment[0]) ok = qrz_adif_field(adif, adif_cap, &used, "COMMENT", job->comment);
    if (ok) ok = qrz_adif_field(adif, adif_cap, &used, "MY_RIG", job->my_rig[0] ? job->my_rig : "Yaesu FT-710");
    if (ok) ok = qrz_append(adif, adif_cap, &used, "<EOR>");
    if (!ok) {
        fatal_error = "Log ADIF record is too large";
        goto done;
    }

    qrz_status_set_adif(adif);
    ESP_LOGI(TAG, "LOG job %" PRIu32 " prepared ADIF for %s", job->id, job->call);

    if (qrz_active) {
        response = qrz_alloc(1024);
        if (!response) {
            snprintf(qrz_detail, sizeof(qrz_detail), "QRZ worker out of memory");
            destination_error = true;
        } else {
            size_t key_cap = strlen(job->config.api_key) * 3U + 1U;
            size_t adif_encoded_cap = strlen(adif) * 3U + 1U;
            encoded_key = qrz_alloc(key_cap);
            encoded_adif = qrz_alloc(adif_encoded_cap);
            if (!encoded_key || !encoded_adif) {
                snprintf(qrz_detail, sizeof(qrz_detail), "QRZ worker out of memory");
                destination_error = true;
            } else {
                form_encode(job->config.api_key, encoded_key, key_cap);
                form_encode(adif, encoded_adif, adif_encoded_cap);

                size_t post_cap = strlen(encoded_key) + strlen(encoded_adif) + 32U;
                post = qrz_alloc(post_cap);
                if (!post) {
                    snprintf(qrz_detail, sizeof(qrz_detail), "QRZ worker out of memory");
                    destination_error = true;
                } else {
                    snprintf(post, post_cap, "KEY=%s&ACTION=INSERT&ADIF=%s", encoded_key, encoded_adif);

                    http_accum_t acc = {
                        .buf = response,
                        .cap = 1024,
                        .len = 0,
                        .truncated = false,
                    };
                    char user_agent[96];
                    snprintf(user_agent, sizeof(user_agent), "FreeRig710/1.0 (%s)", job->config.station_callsign);
                    esp_http_client_config_t cfg = {
                        .url = "https://logbook.qrz.com/api",
                        .event_handler = qrz_http_event,
                        .user_data = &acc,
                        .timeout_ms = 10000,
                        .crt_bundle_attach = esp_crt_bundle_attach,
                        .user_agent = user_agent,
                    };
                    esp_http_client_handle_t h = esp_http_client_init(&cfg);
                    if (!h) {
                        snprintf(qrz_detail, sizeof(qrz_detail), "QRZ HTTP client init failed");
                        destination_error = true;
                    } else {
                        esp_http_client_set_method(h, HTTP_METHOD_POST);
                        esp_http_client_set_header(h, "Content-Type", "application/x-www-form-urlencoded");
                        esp_http_client_set_post_field(h, post, (int)strlen(post));
                        esp_err_t err = esp_http_client_perform(h);
                        int http_status = esp_http_client_get_status_code(h);
                        esp_http_client_cleanup(h);

                        if (err != ESP_OK) {
                            snprintf(qrz_detail, sizeof(qrz_detail), "QRZ HTTPS failed: %s", esp_err_to_name(err));
                            destination_error = true;
                        } else if (http_status < 200 || http_status >= 300) {
                            snprintf(qrz_detail, sizeof(qrz_detail), "QRZ HTTP status %d", http_status);
                            destination_error = true;
                        } else if (!strstr(response, "RESULT=OK") && !strstr(response, "RESULT=REPLACE")) {
                            snprintf(qrz_detail, sizeof(qrz_detail), "%s", response[0] ? response : "QRZ rejected QSO");
                            destination_error = true;
                        } else {
                            qrz_response_value(response, "LOGID", logid, sizeof(logid));
                            if (!logid[0]) qrz_response_value(response, "LOGIDS", logid, sizeof(logid));
                            snprintf(qrz_detail, sizeof(qrz_detail), "QRZ logged%s%s", logid[0] ? " LOGID " : "", logid);
                            qrz_sent = true;
                        }
                    }
                }
            }
        }
    } else if (qrz_selected) {
        snprintf(qrz_detail, sizeof(qrz_detail), "QRZ API key missing");
        destination_error = true;
    } else {
        snprintf(qrz_detail, sizeof(qrz_detail), "QRZ disabled");
    }

    if (gridtracker_active) {
        esp_err_t gt_err = gridtracker_send_adif(&job->config, adif, gridtracker_detail, sizeof(gridtracker_detail));
        if (gt_err == ESP_OK) {
            gridtracker_sent = true;
        } else {
            destination_error = true;
        }
    } else if (gridtracker_selected) {
        snprintf(gridtracker_detail, sizeof(gridtracker_detail), "GridTracker address or port missing");
        destination_error = true;
    } else {
        snprintf(gridtracker_detail, sizeof(gridtracker_detail), "GridTracker disabled");
    }
    qrz_status_set_destinations(qrz_sent, qrz_detail, gridtracker_sent, gridtracker_detail);

 done:
    if (fatal_error) {
        ESP_LOGW(TAG, "LOG job %" PRIu32 " failed: %s", job->id, fatal_error);
        qrz_status_from_job(job, "error", fatal_error, NULL, false);
    } else if (destination_error) {
        log_join_destination_detail(final_detail, sizeof(final_detail),
                                    qrz_selected, qrz_detail,
                                    gridtracker_selected, gridtracker_detail);
        ESP_LOGW(TAG, "LOG job %" PRIu32 " partially failed: %s", job->id, final_detail);
        qrz_status_from_job(job, "error", final_detail, logid, false);
        qrz_status_set_destinations(qrz_sent, qrz_detail, gridtracker_sent, gridtracker_detail);
    } else {
        log_join_destination_detail(final_detail, sizeof(final_detail),
                                    qrz_selected, qrz_detail,
                                    gridtracker_selected, gridtracker_detail);
        ESP_LOGI(TAG, "LOG job %" PRIu32 " logged %s on %s %s: %s", job->id, job->call, job->band, job->mode, final_detail);
        qrz_status_from_job(job, "ok", final_detail[0] ? final_detail : "QSO logged", logid, false);
        qrz_status_set_destinations(qrz_sent, qrz_detail, gridtracker_sent, gridtracker_detail);
    }

    if (post) { memset(post, 0, strlen(post)); free(post); }
    if (encoded_key) { memset(encoded_key, 0, strlen(encoded_key)); free(encoded_key); }
    if (encoded_adif) free(encoded_adif);
    if (adif) free(adif);
    if (response) free(response);
    memset(job->config.api_key, 0, sizeof(job->config.api_key));
    free(job);
    vTaskDelete(NULL);
}

static cJSON *qrz_job_json(const qrz_job_status_t *st)
{
    cJSON *o = cJSON_CreateObject();
    cJSON_AddNumberToObject(o, "job_id", st->job_id);
    cJSON_AddStringToObject(o, "state", st->state);
    cJSON_AddBoolToObject(o, "busy", st->busy);
    cJSON_AddStringToObject(o, "detail", st->detail);
    if (st->job_id) {
        cJSON *q = cJSON_AddObjectToObject(o, "qso");
        cJSON_AddStringToObject(q, "call", st->call);
        cJSON_AddStringToObject(q, "station_callsign", st->station_callsign);
        cJSON_AddStringToObject(q, "band", st->band);
        cJSON_AddNumberToObject(q, "frequency_hz", st->frequency_hz);
        cJSON_AddNumberToObject(q, "rx_frequency_hz", st->rx_frequency_hz);
        if (st->tx_power_w > 0) cJSON_AddNumberToObject(q, "tx_power_w", st->tx_power_w);
        cJSON_AddStringToObject(q, "mode", st->mode);
        if (st->submode[0]) cJSON_AddStringToObject(q, "submode", st->submode);
        cJSON_AddStringToObject(q, "qso_date", st->date);
        cJSON_AddStringToObject(q, "time_on", st->time_on);
        if (st->logid[0]) cJSON_AddStringToObject(q, "logid", st->logid);
        if (st->adif_preview[0]) cJSON_AddStringToObject(q, "adif", st->adif_preview);
        cJSON *dest = cJSON_AddObjectToObject(q, "destinations");
        cJSON *qrz = cJSON_AddObjectToObject(dest, "qrz");
        cJSON_AddBoolToObject(qrz, "enabled", st->qrz_enabled);
        cJSON_AddBoolToObject(qrz, "sent", st->qrz_sent);
        cJSON_AddStringToObject(qrz, "detail", st->qrz_detail);
        if (st->logid[0]) cJSON_AddStringToObject(qrz, "logid", st->logid);
        cJSON *gt = cJSON_AddObjectToObject(dest, "gridtracker");
        cJSON_AddBoolToObject(gt, "enabled", st->gridtracker_enabled);
        cJSON_AddBoolToObject(gt, "sent", st->gridtracker_sent);
        cJSON_AddStringToObject(gt, "host", st->gridtracker_host);
        cJSON_AddNumberToObject(gt, "port", st->gridtracker_port);
        cJSON_AddStringToObject(gt, "detail", st->gridtracker_detail);
    }
    return o;
}

static esp_err_t qrz_log_status_handler(httpd_req_t *req)
{
    qrz_job_status_t st = qrz_status_snapshot();
    cJSON *o = cJSON_CreateObject();
    cJSON_AddTrueToObject(o, "ok");
    cJSON_AddItemToObject(o, "job", qrz_job_json(&st));
    return send_json(req, o);
}

static esp_err_t log_gridtracker_adif_handler(httpd_req_t *req)
{
    freerig_qrz_config_t q;
    esp_err_t cfg_err = freerig_config_get_qrz(&q);
    if (cfg_err != ESP_OK) return send_error(req, "500 Internal Server Error", esp_err_to_name(cfg_err));
    if (!q.gridtracker_enabled) return send_error(req, "503 Service Unavailable", "GridTracker logging is disabled");
    if (!q.gridtracker_host[0] || q.gridtracker_port == 0) {
        return send_error(req, "503 Service Unavailable", "GridTracker UDP target is not configured");
    }

    cJSON *j = read_json(req);
    if (!j) return send_error(req, "422 Unprocessable Entity", "invalid JSON");
    const char *adif = json_string(j, "adif", NULL);
    if (!adif || !adif[0]) {
        cJSON_Delete(j);
        return send_error(req, "422 Unprocessable Entity", "ADIF payload is required");
    }
    char detail[128] = {0};
    esp_err_t err = gridtracker_send_adif(&q, adif, detail, sizeof(detail));
    size_t bytes = strlen(adif);
    cJSON_Delete(j);
    if (err != ESP_OK) return send_error(req, "502 Bad Gateway", detail[0] ? detail : esp_err_to_name(err));

    cJSON *o = cJSON_CreateObject();
    cJSON_AddTrueToObject(o, "ok");
    cJSON_AddNumberToObject(o, "bytes", (double)bytes);
    cJSON_AddStringToObject(o, "detail", detail);
    return send_json(req, o);
}

static void qrz_copy_upper(char *dst, size_t cap, const char *src)
{
    if (!dst || cap == 0) return;
    snprintf(dst, cap, "%s", src ? src : "");
    for (char *p = dst; *p; ++p) *p = (char)toupper((unsigned char)*p);
}

static void qrz_iso_to_adif(const char *iso, char date[9], char time_value[7])
{
    if (iso && strlen(iso) >= 19) {
        snprintf(date, 9, "%.4s%.2s%.2s", iso, iso + 5, iso + 8);
        snprintf(time_value, 7, "%.2s%.2s%.2s", iso + 11, iso + 14, iso + 17);
    }
}

static esp_err_t qrz_log_handler(httpd_req_t *req)
{
    freerig_qrz_config_t q;
    esp_err_t cfg_err = freerig_config_get_qrz(&q);
    if (cfg_err != ESP_OK) return send_error(req, "500 Internal Server Error", esp_err_to_name(cfg_err));
    if (!q.station_callsign[0]) return send_error(req, "503 Service Unavailable", "Station callsign is not configured");
    if (!q.qrz_enabled && !q.gridtracker_enabled) return send_error(req, "503 Service Unavailable", "No log destination is enabled");
    if (q.qrz_enabled && !q.api_key_set) return send_error(req, "503 Service Unavailable", "QRZ Logbook API key is not configured");
    if (q.gridtracker_enabled && (!q.gridtracker_host[0] || q.gridtracker_port == 0)) return send_error(req, "503 Service Unavailable", "GridTracker UDP target is not configured");

    qrz_job_status_t current = qrz_status_snapshot();
    if (current.busy) return send_error(req, "409 Conflict", "a Log request is already running");

    cJSON *j = read_json(req);
    if (!j) return send_error(req, "422 Unprocessable Entity", "invalid JSON");
    const char *call = json_string(j, "call", NULL);
    const char *override = json_string(j, "mode", "AUTO");
    const char *sub_override = json_string(j, "submode", NULL);
    const char *iso = json_string(j, "timestamp_utc", NULL);
    const char *iso_off = json_string(j, "timestamp_off_utc", NULL);
    if (!call || strlen(call) < 3 || strlen(call) > 16) {
        cJSON_Delete(j);
        return send_error(req, "422 Unprocessable Entity", "invalid callsign");
    }

    qrz_job_t *job = calloc(1, sizeof(*job));
    if (!job) { cJSON_Delete(j); return send_error(req, "500 Internal Server Error", "out of memory"); }
    job->config = q;
    qrz_copy_upper(job->call, sizeof(job->call), call);

    ft710_cat_status_t radio;
    ft710_cat_get_status(&radio);
    char txv = radio.active_vfo[0] ? radio.active_vfo[0] : 'A';
    if (radio.split_enabled) txv = txv == 'A' ? 'B' : 'A';
    uint32_t radio_tx_hz = txv == 'A' ? radio.vfo_a_hz : radio.vfo_b_hz;
    uint32_t radio_rx_hz = radio.active_vfo[0] == 'B' ? radio.vfo_b_hz : radio.vfo_a_hz;
    int requested_tx_hz = json_int(j, "frequency_hz", 0);
    int requested_rx_hz = json_int(j, "rx_frequency_hz", 0);
    int requested_power = json_int(j, "tx_power_w", 0);
    job->frequency_hz = requested_tx_hz > 0 ? (uint32_t)requested_tx_hz : radio_tx_hz;
    job->rx_frequency_hz = requested_rx_hz > 0 ? (uint32_t)requested_rx_hz : radio_rx_hz;
    job->tx_power_w = requested_power > 0 ? requested_power : radio.tx_power_w;

    const char *band_override = json_string(j, "band", NULL);
    const char *band = band_override && band_override[0] ? band_override : band_for(job->frequency_hz);
    if (!band || strlen(band) >= sizeof(job->band) ||
        !adif_mode(radio.mode, override, sub_override, job->mode, sizeof(job->mode), job->submode, sizeof(job->submode))) {
        cJSON_Delete(j); memset(job->config.api_key, 0, sizeof(job->config.api_key)); free(job);
        return send_error(req, "422 Unprocessable Entity", "frequency/mode cannot be mapped to QRZ ADIF");
    }
    snprintf(job->band, sizeof(job->band), "%s", band);

    const char *grid = json_string(j, "grid", NULL);
    const char *my_grid = json_string(j, "my_grid", NULL);
    const char *rst_sent = json_string(j, "rst_sent", NULL);
    const char *rst_rcvd = json_string(j, "rst_rcvd", NULL);
    const char *comment = json_string(j, "comment", NULL);
    const char *my_rig = json_string(j, "my_rig", "Yaesu FT-710");
    qrz_copy_upper(job->grid, sizeof(job->grid), grid);
    qrz_copy_upper(job->my_grid, sizeof(job->my_grid), my_grid);
    snprintf(job->rst_sent, sizeof(job->rst_sent), "%s", rst_sent ? rst_sent : "");
    snprintf(job->rst_rcvd, sizeof(job->rst_rcvd), "%s", rst_rcvd ? rst_rcvd : "");
    snprintf(job->comment, sizeof(job->comment), "%s", comment ? comment : "");
    snprintf(job->my_rig, sizeof(job->my_rig), "%s", my_rig ? my_rig : "Yaesu FT-710");

    if (iso && strlen(iso) >= 19) qrz_iso_to_adif(iso, job->date, job->time_on);
    else {
        time_t now = time(NULL); struct tm t; gmtime_r(&now, &t);
        strftime(job->date, sizeof(job->date), "%Y%m%d", &t);
        strftime(job->time_on, sizeof(job->time_on), "%H%M%S", &t);
    }
    if (iso_off && strlen(iso_off) >= 19) {
        char ignored_date[9] = {0}; qrz_iso_to_adif(iso_off, ignored_date, job->time_off);
    }
    cJSON_Delete(j);

    portENTER_CRITICAL(&s_qrz_mux);
    if (s_qrz_status.busy) {
        portEXIT_CRITICAL(&s_qrz_mux);
        memset(job->config.api_key, 0, sizeof(job->config.api_key)); free(job);
        return send_error(req, "409 Conflict", "a Log request is already running");
    }
    job->id = s_qrz_next_job_id++;
    if (s_qrz_next_job_id == 0) s_qrz_next_job_id = 1;
    s_qrz_status.busy = true;
    portEXIT_CRITICAL(&s_qrz_mux);
    qrz_status_from_job(job, "queued", "Log request queued", NULL, true);

    if (xTaskCreate(qrz_log_task, "qrz_log", 10240, job, 3, NULL) != pdPASS) {
        qrz_status_from_job(job, "error", "unable to start Log worker", NULL, false);
        memset(job->config.api_key, 0, sizeof(job->config.api_key)); free(job);
        return send_error(req, "503 Service Unavailable", "unable to start Log worker");
    }

    qrz_job_status_t accepted = qrz_status_snapshot();
    cJSON *o = cJSON_CreateObject();
    cJSON_AddTrueToObject(o, "ok");
    cJSON_AddBoolToObject(o, "accepted", true);
    cJSON_AddItemToObject(o, "job", qrz_job_json(&accepted));
    httpd_resp_set_status(req, "202 Accepted");
    return send_json(req, o);
}

static uint64_t unix_time_ms(bool *valid)
{
    struct timeval tv = {0};
    gettimeofday(&tv, NULL);
    /* 2024-01-01 UTC. Values before this are treated as unsynchronized. */
    const bool ok = tv.tv_sec >= 1704067200LL;
    if (valid) *valid = ok;
    if (!ok) return 0;
    return (uint64_t)tv.tv_sec * 1000ULL + (uint64_t)tv.tv_usec / 1000ULL;
}

static cJSON *ft8_status_json(void)
{
    ft710_audio_status_t rx;
    ft710_audio_get_status(&rx);
    ft710_audio_tx_status_t tx;
    ft710_audio_tx_get_status(&tx);
    network_eth_status_t net;
    network_eth_get_status(&net);

    bool clock_valid = false;
    const uint64_t now_ms = unix_time_ms(&clock_valid);
    const uint64_t mono_us = (uint64_t)esp_timer_get_time();

    cJSON *f = cJSON_CreateObject();
    cJSON_AddStringToObject(f, "version", "1.0");
    cJSON_AddStringToObject(f, "architecture", "browser FT8 RX/QSO + WSJT-X-port encoder; ESP32 owns UTC/PTT safety and staged 48 kHz FT8 playback over raw UAC1 TX");
    cJSON_AddBoolToObject(f, "decode_enabled", true);
    cJSON_AddBoolToObject(f, "tx_enabled", true);
    cJSON_AddNumberToObject(f, "sample_rate_hz", 48000);
    cJSON_AddNumberToObject(f, "tx_sample_rate_hz", 48000);
    cJSON_AddNumberToObject(f, "slot_ms", 15000);
    cJSON_AddNumberToObject(f, "server_monotonic_ms", (double)(mono_us / 1000ULL));
    cJSON_AddBoolToObject(f, "clock_valid", clock_valid);
    if (clock_valid) {
        cJSON_AddNumberToObject(f, "server_unix_ms", (double)now_ms);
        cJSON_AddNumberToObject(f, "slot_index", (double)(now_ms / 15000ULL));
        cJSON_AddNumberToObject(f, "slot_phase_ms", (double)(now_ms % 15000ULL));
    } else {
        cJSON_AddNullToObject(f, "server_unix_ms");
        cJSON_AddNullToObject(f, "slot_index");
        cJSON_AddNullToObject(f, "slot_phase_ms");
    }

    cJSON *sync = cJSON_AddObjectToObject(f, "time_sync");
    cJSON_AddBoolToObject(sync, "initialized", net.time_sync_initialized);
    cJSON_AddBoolToObject(sync, "started", net.time_sync_started);
    cJSON_AddBoolToObject(sync, "synced", net.time_synced);
    cJSON_AddNumberToObject(sync, "sync_count", net.time_sync_count);
    if (net.time_last_sync_unix_ms) cJSON_AddNumberToObject(sync, "last_sync_unix_ms", (double)net.time_last_sync_unix_ms);
    else cJSON_AddNullToObject(sync, "last_sync_unix_ms");

    cJSON *audio = cJSON_AddObjectToObject(f, "audio_rx");
    cJSON_AddBoolToObject(audio, "streaming", rx.streaming);
    cJSON_AddNumberToObject(audio, "rx_samples", (double)rx.rx_samples);
    cJSON_AddNumberToObject(audio, "packets_total", rx.packets_total);
    cJSON_AddNumberToObject(audio, "packets_skipped", rx.packets_skipped);
    cJSON_AddNumberToObject(audio, "packets_error", rx.packets_error);
    cJSON_AddNumberToObject(audio, "pcm_stream_bytes", (double)rx.pcm_stream_bytes);
    cJSON_AddNumberToObject(audio, "pcm_stream_dropped_bytes", (double)rx.pcm_stream_dropped_bytes);
    cJSON_AddNumberToObject(audio, "peak_abs", rx.peak_abs);
    cJSON_AddNumberToObject(audio, "mean_abs", rx.mean_abs);

    cJSON *audio_tx = cJSON_AddObjectToObject(f, "audio_tx");
    cJSON_AddBoolToObject(audio_tx, "streaming", tx.streaming);
    cJSON_AddNumberToObject(audio_tx, "input_buffered_bytes", tx.input_buffered_bytes);
    cJSON_AddNumberToObject(audio_tx, "input_pushes", tx.input_pushes);
    cJSON_AddNumberToObject(audio_tx, "input_bytes_received", (double)tx.input_bytes_received);
    cJSON_AddNumberToObject(audio_tx, "input_bytes_dropped_old", (double)tx.input_bytes_dropped_old);
    cJSON_AddNumberToObject(audio_tx, "input_peak_abs", tx.input_peak_abs);
    cJSON_AddNumberToObject(audio_tx, "source_frames_sent", (double)tx.source_frames_sent);
    cJSON_AddNumberToObject(audio_tx, "silence_frames_sent", (double)tx.silence_frames_sent);
    cJSON_AddNumberToObject(audio_tx, "sample_rate_hz", tx.sample_rate_hz);
    cJSON_AddNumberToObject(audio_tx, "packet_bytes_min", tx.packet_bytes_min);
    cJSON_AddNumberToObject(audio_tx, "packet_bytes_max", tx.packet_bytes_max);
    cJSON_AddNumberToObject(audio_tx, "packets_48_frames", tx.packets_48_frames);

    portENTER_CRITICAL(&s_ws_mux);
    cJSON_AddStringToObject(f, "tx_source", audio_tx_source_name(s_audio_tx_source));
    cJSON_AddBoolToObject(f, "audio_ws_connected", s_audio_ws_fd >= 0);
    cJSON_AddNumberToObject(f, "audio_ws_sessions", s_audio_ws_sessions);
    cJSON_AddNumberToObject(f, "audio_ws_disconnects", s_audio_ws_disconnects);
    cJSON_AddNumberToObject(f, "audio_ws_rx_bytes", (double)s_audio_ws_rx_bytes);
    cJSON_AddNumberToObject(f, "audio_ws_tx_bytes", (double)s_audio_ws_tx_bytes);
    cJSON_AddNumberToObject(f, "audio_ws_tx_microphone_bytes", (double)s_audio_ws_tx_microphone_bytes);
    cJSON_AddNumberToObject(f, "audio_ws_tx_ft8_bytes", (double)s_audio_ws_tx_ft8_bytes);
    cJSON_AddNumberToObject(f, "audio_ws_tx_digital_bytes", (double)s_audio_ws_tx_digital_bytes);
    cJSON_AddNumberToObject(f, "audio_ws_tx_rejected_bytes", (double)s_audio_ws_tx_rejected_bytes);
    portEXIT_CRITICAL(&s_ws_mux);
    ft8_wave_snapshot_t wave;
    ft8_waveform_get_snapshot(&wave);
    cJSON *wave_json = cJSON_AddObjectToObject(f, "tx_waveform");
    cJSON_AddBoolToObject(wave_json, "uploading", wave.uploading);
    cJSON_AddBoolToObject(wave_json, "ready", wave.ready);
    cJSON_AddNumberToObject(wave_json, "id", wave.id);
    cJSON_AddNumberToObject(wave_json, "sample_rate_hz", wave.sample_rate_hz);
    cJSON_AddNumberToObject(wave_json, "expected_bytes", (double)wave.expected_bytes);
    cJSON_AddNumberToObject(wave_json, "received_bytes", (double)wave.received_bytes);
    cJSON_AddNumberToObject(wave_json, "consumed_bytes", (double)wave.consumed_bytes);

    digital_wave_snapshot_t digital_wave;
    digital_waveform_get_snapshot(&digital_wave);
    cJSON *digital_json = cJSON_AddObjectToObject(f, "digital_tx_waveform");
    cJSON_AddBoolToObject(digital_json, "uploading", digital_wave.uploading);
    cJSON_AddBoolToObject(digital_json, "ready", digital_wave.ready);
    cJSON_AddNumberToObject(digital_json, "id", digital_wave.id);
    cJSON_AddNumberToObject(digital_json, "sample_rate_hz", digital_wave.sample_rate_hz);
    cJSON_AddNumberToObject(digital_json, "expected_bytes", (double)digital_wave.expected_bytes);
    cJSON_AddNumberToObject(digital_json, "received_bytes", (double)digital_wave.received_bytes);
    cJSON_AddNumberToObject(digital_json, "consumed_bytes", (double)digital_wave.consumed_bytes);
    portENTER_CRITICAL(&s_digital_tx_mux);
    cJSON_AddBoolToObject(digital_json, "tx_running", s_digital_tx_task_running);
    cJSON_AddBoolToObject(digital_json, "tx_active", s_digital_tx_active);
    cJSON_AddNumberToObject(digital_json, "tx_waveform_id", s_digital_tx_waveform_id);
    cJSON_AddStringToObject(digital_json, "tx_phase", s_digital_tx_phase);
    cJSON_AddStringToObject(digital_json, "tx_last_reason", s_digital_tx_last_reason);
    portEXIT_CRITICAL(&s_digital_tx_mux);
    cJSON_AddNumberToObject(wave_json, "upload_started_ms", (double)wave.upload_started_ms);
    cJSON_AddNumberToObject(digital_json, "upload_started_ms", (double)digital_wave.upload_started_ms);
    cJSON_AddItemToObject(f, "tune", ft8_tune_status_json());
    cJSON_AddItemToObject(f, "tx", ft8_tx_status_json());
    return f;
}

static esp_err_t ft8_status_handler(httpd_req_t *req)
{
    cJSON *o = cJSON_CreateObject();
    cJSON_AddTrueToObject(o, "ok");
    cJSON_AddItemToObject(o, "ft8", ft8_status_json());
    return send_json(req, o);
}

static bool audio_ws_is_active(int fd)
{
    bool active;
    portENTER_CRITICAL(&s_ws_mux);
    active = s_audio_ws_fd == fd;
    portEXIT_CRITICAL(&s_ws_mux);
    return active;
}

static uint64_t monotonic_ms(void)
{
    return (uint64_t)(esp_timer_get_time() / 1000ULL);
}

static void ft8_tune_get_snapshot(ft8_tune_snapshot_t *out)
{
    if (!out) return;
    portENTER_CRITICAL(&s_ft8_tune_mux);
    out->task_running = s_ft8_tune_task_running;
    out->active = s_ft8_tune_active;
    out->stop_requested = s_ft8_tune_stop_requested;
    out->started_ms = s_ft8_tune_started_ms;
    out->deadline_ms = s_ft8_tune_deadline_ms;
    out->original_power_w = s_ft8_tune_original_power_w;
    out->restored_power_w = s_ft8_tune_restored_power_w;
    out->alc_raw = s_ft8_tune_alc_raw;
    out->po_raw = s_ft8_tune_po_raw;
    out->level_dbfs = s_ft8_tune_level_dbfs;
    out->meter_reads = s_ft8_tune_meter_reads;
    out->meter_errors = s_ft8_tune_meter_errors;
    out->metering_enabled = s_ft8_tune_metering_enabled;
    out->usb_quiet = s_ft8_tune_usb_quiet;
    out->frequency_hz = s_ft8_tune_frequency_hz;
    memcpy(out->phase, s_ft8_tune_phase, sizeof(out->phase));
    memcpy(out->last_reason, s_ft8_tune_last_reason, sizeof(out->last_reason));
    portEXIT_CRITICAL(&s_ft8_tune_mux);
    out->phase[sizeof(out->phase) - 1] = '\0';
    out->last_reason[sizeof(out->last_reason) - 1] = '\0';
}

static void ft8_tune_set_phase(const char *phase, const char *reason)
{
    portENTER_CRITICAL(&s_ft8_tune_mux);
    if (phase) snprintf(s_ft8_tune_phase, sizeof(s_ft8_tune_phase), "%s", phase);
    if (reason) snprintf(s_ft8_tune_last_reason, sizeof(s_ft8_tune_last_reason), "%s", reason);
    portEXIT_CRITICAL(&s_ft8_tune_mux);
}

static void ft8_tune_request_stop(const char *reason)
{
    portENTER_CRITICAL(&s_ft8_tune_mux);
    if (s_ft8_tune_task_running) {
        s_ft8_tune_stop_requested = true;
        if (reason && reason[0]) snprintf(s_ft8_tune_last_reason, sizeof(s_ft8_tune_last_reason), "%s", reason);
    }
    portEXIT_CRITICAL(&s_ft8_tune_mux);
}

static void ft8_tune_keepalive(void)
{
    bool running = false;
    bool active = false;
    const uint64_t now = monotonic_ms();
    portENTER_CRITICAL(&s_ft8_tune_mux);
    running = s_ft8_tune_task_running;
    active = s_ft8_tune_active;
    if (running) s_ft8_tune_deadline_ms = now + FT8_TUNE_LEASE_MS;
    portEXIT_CRITICAL(&s_ft8_tune_mux);
    if (active) ft710_cat_ptt_keepalive();
}

static bool parse_pc_reply_local(const char *response, int *watts)
{
    if (!response || !watts || strlen(response) != 6 || strncmp(response, "PC", 2) != 0 || response[5] != ';') return false;
    int v = 0;
    for (int i = 2; i < 5; ++i) {
        if (response[i] < '0' || response[i] > '9') return false;
        v = v * 10 + (response[i] - '0');
    }
    *watts = v;
    return true;
}

static bool parse_rm_reply_local(const char *response, char meter, int *value)
{
    if (!response || !value || strlen(response) != 10 || response[0] != 'R' || response[1] != 'M' || response[2] != meter || response[9] != ';') return false;
    int v = 0;
    for (int i = 3; i < 6; ++i) {
        if (response[i] < '0' || response[i] > '9') return false;
        v = v * 10 + (response[i] - '0');
    }
    *value = v;
    return true;
}


static void ft8_tx_get_snapshot(ft8_tx_snapshot_t *out)
{
    if (!out) return;
    portENTER_CRITICAL(&s_ft8_tx_mux);
    out->task_running = s_ft8_tx_task_running;
    out->active = s_ft8_tx_active;
    out->stop_requested = s_ft8_tx_stop_requested;
    out->target_slot_index = s_ft8_tx_target_slot_index;
    out->target_unix_ms = s_ft8_tx_target_unix_ms;
    out->ptt_started_unix_ms = s_ft8_tx_ptt_started_unix_ms;
    out->lease_deadline_ms = s_ft8_tx_lease_deadline_ms;
    out->hard_stop_unix_ms = s_ft8_tx_hard_stop_unix_ms;
    out->keepalives = s_ft8_tx_keepalives;
    out->sessions_started = s_ft8_tx_sessions_started;
    out->sessions_completed = s_ft8_tx_sessions_completed;
    out->sessions_aborted = s_ft8_tx_sessions_aborted;
    out->expected_vfo_a_hz = s_ft8_tx_expected_vfo_a_hz;
    out->expected_vfo_b_hz = s_ft8_tx_expected_vfo_b_hz;
    out->waveform_id = s_ft8_tx_waveform_id;
    out->streamed_audio = s_ft8_tx_streamed_audio;
    out->expected_power_w = s_ft8_tx_expected_power_w;
    memcpy(out->phase, s_ft8_tx_phase, sizeof(out->phase));
    memcpy(out->last_reason, s_ft8_tx_last_reason, sizeof(out->last_reason));
    portEXIT_CRITICAL(&s_ft8_tx_mux);
    out->phase[sizeof(out->phase) - 1] = '\0';
    out->last_reason[sizeof(out->last_reason) - 1] = '\0';
}

static void ft8_tx_set_phase(const char *phase, const char *reason)
{
    portENTER_CRITICAL(&s_ft8_tx_mux);
    if (phase) snprintf(s_ft8_tx_phase, sizeof(s_ft8_tx_phase), "%s", phase);
    if (reason) snprintf(s_ft8_tx_last_reason, sizeof(s_ft8_tx_last_reason), "%s", reason);
    portEXIT_CRITICAL(&s_ft8_tx_mux);
}

static void ft8_tx_request_stop(const char *reason)
{
    portENTER_CRITICAL(&s_ft8_tx_mux);
    if (s_ft8_tx_task_running) {
        s_ft8_tx_stop_requested = true;
        if (reason && reason[0]) snprintf(s_ft8_tx_last_reason, sizeof(s_ft8_tx_last_reason), "%s", reason);
    }
    portEXIT_CRITICAL(&s_ft8_tx_mux);
}

static void ft8_tx_keepalive(void)
{
    const uint64_t now = monotonic_ms();
    bool active = false;
    portENTER_CRITICAL(&s_ft8_tx_mux);
    if (s_ft8_tx_task_running) {
        s_ft8_tx_lease_deadline_ms = now + FT8_TX_LEASE_MS;
        s_ft8_tx_keepalives++;
        active = s_ft8_tx_active;
    }
    portEXIT_CRITICAL(&s_ft8_tx_mux);
    if (active) ft710_cat_ptt_keepalive();
}

/*
 * The normal CAT status snapshot is intentionally polled at 1 Hz.  Immediately
 * after a frontend FB/ST setter, that cache can therefore still contain the
 * previous VFO B for almost one second even though the FT-710 has already
 * accepted the new value.  A pre-key mismatch must distinguish that harmless
 * cache lag from a real radio/VFO change.  These tiny parsers are local to the
 * FT8 arm path so we can refresh only the four safety-critical values without
 * changing the quiet-TX architecture or the normal CAT poll cadence.
 */
static bool ft8_parse_cat_bool(const char *response, const char *prefix, bool *value)
{
    if (!response || !prefix || !value) return false;
    const size_t plen = strlen(prefix);
    if (strlen(response) != plen + 2 || strncmp(response, prefix, plen) != 0 ||
        response[plen + 1] != ';' || (response[plen] != '0' && response[plen] != '1')) return false;
    *value = response[plen] == '1';
    return true;
}

static bool ft8_parse_cat_frequency(const char *response, const char *prefix, uint32_t *frequency_hz)
{
    if (!response || !prefix || !frequency_hz) return false;
    const size_t plen = strlen(prefix);
    if (strlen(response) != plen + 10 || strncmp(response, prefix, plen) != 0 || response[plen + 9] != ';') return false;
    uint32_t value = 0;
    for (size_t i = 0; i < 9; ++i) {
        const char ch = response[plen + i];
        if (ch < '0' || ch > '9') return false;
        value = value * 10U + (uint32_t)(ch - '0');
    }
    *frequency_hz = value;
    return true;
}

static bool ft8_tx_refresh_prekey_vfo(ft710_cat_status_t *cat, char *reason, size_t reason_len)
{
    if (!cat) return false;
    char response[FT710_CAT_RESPONSE_MAX];
    bool active_b = false;
    bool split_enabled = false;
    uint32_t vfo_a_hz = 0;
    uint32_t vfo_b_hz = 0;

    esp_err_t err = ft710_cat_query("VS;", response, sizeof(response), API_TIMEOUT_MS);
    if (err != ESP_OK || !ft8_parse_cat_bool(response, "VS", &active_b)) {
        snprintf(reason, reason_len, "fresh CAT VS query failed before FT8 TX");
        return false;
    }
    err = ft710_cat_query("ST;", response, sizeof(response), API_TIMEOUT_MS);
    if (err != ESP_OK || !ft8_parse_cat_bool(response, "ST", &split_enabled)) {
        snprintf(reason, reason_len, "fresh CAT ST query failed before FT8 TX");
        return false;
    }
    err = ft710_cat_query("FA;", response, sizeof(response), API_TIMEOUT_MS);
    if (err != ESP_OK || !ft8_parse_cat_frequency(response, "FA", &vfo_a_hz)) {
        snprintf(reason, reason_len, "fresh CAT FA query failed before FT8 TX");
        return false;
    }
    err = ft710_cat_query("FB;", response, sizeof(response), API_TIMEOUT_MS);
    if (err != ESP_OK || !ft8_parse_cat_frequency(response, "FB", &vfo_b_hz)) {
        snprintf(reason, reason_len, "fresh CAT FB query failed before FT8 TX");
        return false;
    }

    cat->split_known = true;
    cat->split_enabled = split_enabled;
    cat->active_vfo[0] = active_b ? 'B' : 'A';
    cat->active_vfo[1] = '\0';
    cat->vfo_a_hz = vfo_a_hz;
    cat->vfo_b_hz = vfo_b_hz;
    cat->frequency_hz = active_b ? vfo_b_hz : vfo_a_hz;
    return true;
}

static bool ft8_tx_radio_matches_prekey(const ft710_cat_status_t *cat, const ft8_tx_snapshot_t *tx, char *reason, size_t reason_len)
{
    if (!cat || !tx) return false;
    if (!cat->device_open || !cat->interface_claimed || !cat->rx_running || !cat->state_valid) {
        snprintf(reason, reason_len, "CAT state unavailable"); return false;
    }
    if (!cat->power_known || !cat->radio_power_on || cat->power_starting) {
        snprintf(reason, reason_len, "radio is not stably ON"); return false;
    }
    if (!cat->split_known || !cat->split_enabled || cat->active_vfo[0] != 'A') {
        snprintf(reason, reason_len, "split A->B is not active"); return false;
    }
    if (strcasecmp(cat->vfo_a_mode, "DATA-U") || strcasecmp(cat->vfo_b_mode, "DATA-U")) {
        snprintf(reason, reason_len, "both VFOs must be DATA-U"); return false;
    }
    if (tx->expected_vfo_a_hz && llabs((long long)cat->vfo_a_hz - (long long)tx->expected_vfo_a_hz) > 5) {
        snprintf(reason, reason_len, "VFO A changed before FT8 TX (expected %" PRIu32 " observed %" PRIu32 ")", tx->expected_vfo_a_hz, cat->vfo_a_hz); return false;
    }
    if (tx->expected_vfo_b_hz && llabs((long long)cat->vfo_b_hz - (long long)tx->expected_vfo_b_hz) > 5) {
        snprintf(reason, reason_len, "VFO B changed before FT8 TX (expected %" PRIu32 " observed %" PRIu32 ")", tx->expected_vfo_b_hz, cat->vfo_b_hz); return false;
    }
    if (tx->expected_power_w >= 5 && cat->tx_power_w != tx->expected_power_w) {
        snprintf(reason, reason_len, "RF power changed before FT8 TX (expected %d observed %d)", tx->expected_power_w, cat->tx_power_w); return false;
    }
    if (cat->hi_swr) { snprintf(reason, reason_len, "HI-SWR detected"); return false; }
    return true;
}

/*
 * Once TX1 has been accepted, the FT-710 CAT snapshot is not a reliable place
 * to enforce per-VFO frequency identity on every 25 ms loop.  In split TX the
 * MAIN/SUB/VFO reporting can transiently move while the transmitter changes
 * state, even though the actual programmed A/B registers were validated just
 * before keying.  All FreeRig710 frequency/mode/VFO/split/power mutation APIs
 * are locked while an FT8 RF operation is running, so re-checking FA/FB here
 * adds false aborts rather than useful protection.
 *
 * During ACTIVE we therefore retain the safety signals that are meaningful
 * and stable while transmitting: CAT transport/state availability, radio ON,
 * split still enabled, RF power unchanged, HI-SWR, plus the independent PTT
 * ownership/watchdog, audio-source ownership, lease and UTC hard deadline in
 * ft8_tx_task().
 */
static bool ft8_tx_radio_safe_active(const ft710_cat_status_t *cat, const ft8_tx_snapshot_t *tx, char *reason, size_t reason_len)
{
    if (!cat || !tx) return false;
    if (!cat->device_open || !cat->interface_claimed || !cat->rx_running || !cat->state_valid) {
        snprintf(reason, reason_len, "CAT state unavailable during FT8 TX"); return false;
    }
    if (!cat->power_known || !cat->radio_power_on || cat->power_starting) {
        snprintf(reason, reason_len, "radio left stable ON state during FT8 TX"); return false;
    }
    if (!cat->split_known || !cat->split_enabled) {
        snprintf(reason, reason_len, "split disabled during FT8 TX"); return false;
    }
    if (tx->expected_power_w >= 5 && cat->tx_power_w != tx->expected_power_w) {
        snprintf(reason, reason_len, "RF power changed during FT8 TX (expected %d observed %d)", tx->expected_power_w, cat->tx_power_w); return false;
    }
    if (cat->hi_swr) { snprintf(reason, reason_len, "HI-SWR detected"); return false; }
    return true;
}

static void ws_send_text_async_fd(int fd, const char *text)
{
    if (!text || !audio_ws_is_active(fd) || !s_server) return;
    httpd_ws_frame_t frame = {
        .type = HTTPD_WS_TYPE_TEXT,
        .payload = (uint8_t *)text,
        .len = strlen(text),
    };
    (void)httpd_ws_send_data(s_server, fd, &frame);
}

static void digital_tx_task(void *arg)
{
    digital_tx_params_t *params = (digital_tx_params_t *)arg;
    const int fd = params ? params->fd : -1;
    const uint32_t id = params ? params->id : 0;
    const uint32_t ptt_delay_ms = params ? params->ptt_delay_ms : 100U;
    const uint32_t tail_ms = params ? params->tail_ms : 180U;
    const uint32_t lease_ms = params ? params->lease_ms : DIGITAL_TX_MIN_LEASE_MS;
    char reason[96] = "completed";
    bool completed = false;
    bool keyed = false;
    size_t wave_pos = 0;
    uint64_t output_empty_since_ms = 0;
    uint64_t last_keepalive_ms = 0;
    uint64_t audio_source_start = 0;
    uint64_t audio_source_end = 0;
    uint64_t audio_silence_start = 0;
    uint64_t audio_silence_end = 0;
    uint64_t audio_drop_start = 0;
    uint64_t audio_drop_end = 0;
    uint32_t audio_error_start = 0;
    uint64_t lossless_backpressure_retries = 0;

    digital_wave_snapshot_t wave;
    digital_waveform_get_snapshot(&wave);
    if (!params || !wave.ready || !wave.data || wave.id != id || wave.owner_fd != fd ||
        wave.received_bytes != wave.expected_bytes || wave.sample_rate_hz != DIGITAL_TX_STAGE_RATE_HZ) {
        snprintf(reason, sizeof(reason), "staged digital waveform vanished before TX");
        goto cleanup;
    }

    portENTER_CRITICAL(&s_digital_tx_mux);
    s_digital_tx_started_ms = monotonic_ms();
    s_digital_tx_deadline_ms = s_digital_tx_started_ms + lease_ms;
    snprintf(s_digital_tx_phase, sizeof(s_digital_tx_phase), "%s", "KEYING");
    portEXIT_CRITICAL(&s_digital_tx_mux);

    if (!audio_ws_is_active(fd)) { snprintf(reason, sizeof(reason), "audio WebSocket disconnected"); goto cleanup; }
    if (audio_ws_get_tx_source() != AUDIO_TX_SOURCE_DIGITAL) { snprintf(reason, sizeof(reason), "digital TX source was not armed"); goto cleanup; }

    ft710_audio_tx_status_t audio_start;
    ft710_audio_tx_get_status(&audio_start);
    if (!audio_start.streaming) { snprintf(reason, sizeof(reason), "TX audio is not ready"); goto cleanup; }

    esp_err_t err = manual_audio_tx_set(true);
    if (err != ESP_OK) { snprintf(reason, sizeof(reason), "PTT start failed: %s", esp_err_to_name(err)); goto cleanup; }
    keyed = true;
    last_keepalive_ms = monotonic_ms();
    ft710_audio_tx_input_reset();
    ft710_audio_tx_get_status(&audio_start);
    audio_source_start = audio_start.source_frames_sent;
    audio_silence_start = audio_start.silence_frames_sent;
    audio_drop_start = audio_start.input_bytes_dropped_old;
    audio_error_start = audio_start.transfer_errors;
    if (s_digital_wave_mutex && xSemaphoreTake(s_digital_wave_mutex, pdMS_TO_TICKS(10)) == pdTRUE) {
        s_digital_wave_consumed_bytes = 0;
        xSemaphoreGive(s_digital_wave_mutex);
    }

    portENTER_CRITICAL(&s_digital_tx_mux);
    s_digital_tx_active = true;
    snprintf(s_digital_tx_phase, sizeof(s_digital_tx_phase), "%s", "ACTIVE");
    portEXIT_CRITICAL(&s_digital_tx_mux);
    char active_msg[192];
    snprintf(active_msg, sizeof(active_msg), "{\"type\":\"digital_tx_state\",\"state\":\"ACTIVE\",\"id\":%" PRIu32 ",\"bytes\":%u,\"sample_rate_hz\":%" PRIu32 "}", id, (unsigned)wave.expected_bytes, wave.sample_rate_hz);
    ws_send_text_async_fd(fd, active_msg);

    const uint64_t delay_until = monotonic_ms() + ptt_delay_ms;
    while (monotonic_ms() < delay_until) {
        if (!audio_ws_is_active(fd)) { snprintf(reason, sizeof(reason), "audio WebSocket disconnected"); goto cleanup; }
        bool stop = false;
        portENTER_CRITICAL(&s_digital_tx_mux);
        stop = s_digital_tx_stop_requested || monotonic_ms() >= s_digital_tx_deadline_ms;
        portEXIT_CRITICAL(&s_digital_tx_mux);
        if (stop) { snprintf(reason, sizeof(reason), "digital TX stopped before audio"); goto cleanup; }
        ft710_cat_ptt_keepalive();
        vTaskDelay(pdMS_TO_TICKS(20));
    }

    while (true) {
        const uint64_t now = monotonic_ms();
        bool stop = false;
        uint64_t deadline = 0;
        portENTER_CRITICAL(&s_digital_tx_mux);
        stop = s_digital_tx_stop_requested;
        deadline = s_digital_tx_deadline_ms;
        portEXIT_CRITICAL(&s_digital_tx_mux);
        if (stop) { snprintf(reason, sizeof(reason), "digital TX stopped"); break; }
        if (now >= deadline) { snprintf(reason, sizeof(reason), "digital TX lease expired"); break; }
        if (!audio_ws_is_active(fd)) { snprintf(reason, sizeof(reason), "audio WebSocket disconnected"); break; }
        if (audio_ws_get_tx_source() != AUDIO_TX_SOURCE_DIGITAL) { snprintf(reason, sizeof(reason), "digital TX source changed"); break; }
        if (now - last_keepalive_ms >= 500U) {
            ft710_cat_ptt_keepalive();
            last_keepalive_ms = now;
        }

        ft710_cat_status_t cat;
        ft710_cat_get_status(&cat);
        if (!cat.ptt_active) { snprintf(reason, sizeof(reason), "PTT watchdog/safety released TX"); break; }

        ft710_audio_tx_status_t audio_now;
        ft710_audio_tx_get_status(&audio_now);
        if (!audio_now.streaming) { snprintf(reason, sizeof(reason), "UAC1 TX stream stopped during digital TX"); break; }
        if (audio_now.transfer_errors > audio_error_start) { snprintf(reason, sizeof(reason), "UAC TX transfer error during digital TX"); break; }

        if (wave_pos < wave.expected_bytes && audio_now.input_buffered_bytes < DIGITAL_TX_WAVEFORM_QUEUE_LOW) {
            while (wave_pos < wave.expected_bytes && audio_now.input_buffered_bytes < DIGITAL_TX_WAVEFORM_QUEUE_HIGH) {
                size_t room = DIGITAL_TX_WAVEFORM_QUEUE_HIGH - audio_now.input_buffered_bytes;
                size_t left = wave.expected_bytes - wave_pos;
                size_t chunk = left < DIGITAL_TX_WAVEFORM_FEED_CHUNK ? left : DIGITAL_TX_WAVEFORM_FEED_CHUNK;
                if (chunk > room) chunk = room;
                chunk &= ~(size_t)1U;
                if (chunk == 0) break;

                const size_t accepted = ft710_audio_tx_push_mono_s16_lossless(wave.data + wave_pos, chunk);
                if (accepted != 0 && accepted != chunk) {
                    snprintf(reason, sizeof(reason), "ESP32 UAC1 queue partially accepted staged digital PCM");
                    goto cleanup;
                }
                if (accepted == 0) {
                    lossless_backpressure_retries++;
                    break;
                }
                wave_pos += accepted;
                if (s_digital_wave_mutex && xSemaphoreTake(s_digital_wave_mutex, pdMS_TO_TICKS(10)) == pdTRUE) {
                    s_digital_wave_consumed_bytes = wave_pos;
                    xSemaphoreGive(s_digital_wave_mutex);
                }
                portENTER_CRITICAL(&s_ws_mux);
                s_audio_ws_tx_bytes += accepted;
                s_audio_ws_tx_digital_bytes += accepted;
                portEXIT_CRITICAL(&s_ws_mux);
                ft710_audio_tx_get_status(&audio_now);
            }
        }

        if (wave_pos >= wave.expected_bytes) {
            ft710_audio_tx_get_status(&audio_now);
            if (audio_now.input_buffered_bytes == 0U) {
                if (output_empty_since_ms == 0U) output_empty_since_ms = now;
                if (now - output_empty_since_ms >= tail_ms) {
                    snprintf(reason, sizeof(reason), "staged digital waveform complete");
                    completed = true;
                    break;
                }
            } else {
                output_empty_since_ms = 0U;
            }
        }
        vTaskDelay(pdMS_TO_TICKS(2));
    }

cleanup:
    if (keyed) {
        ft710_audio_tx_status_t audio_rf_end;
        ft710_audio_tx_get_status(&audio_rf_end);
        audio_source_end = audio_rf_end.source_frames_sent;
        audio_silence_end = audio_rf_end.silence_frames_sent;
        audio_drop_end = audio_rf_end.input_bytes_dropped_old;
    }
    digital_tx_set_phase("STOPPING", reason);
    if (keyed) (void)manual_audio_tx_set(false);
    if (audio_ws_is_active(fd)) (void)audio_ws_set_tx_source(fd, AUDIO_TX_SOURCE_NONE);
    ft710_audio_tx_input_reset();

    portENTER_CRITICAL(&s_digital_tx_mux);
    s_digital_tx_active = false;
    s_digital_tx_task_running = false;
    s_digital_tx_stop_requested = false;
    s_digital_tx_deadline_ms = 0;
    snprintf(s_digital_tx_phase, sizeof(s_digital_tx_phase), "%s", "IDLE");
    snprintf(s_digital_tx_last_reason, sizeof(s_digital_tx_last_reason), "%s", reason);
    portEXIT_CRITICAL(&s_digital_tx_mux);

    char complete_msg[320];
    snprintf(complete_msg, sizeof(complete_msg), "{\"type\":\"digital_tx_complete\",\"ok\":%s,\"id\":%" PRIu32 ",\"bytes\":%u,\"sent_bytes\":%u,\"reason\":\"%.160s\"}",
             completed ? "true" : "false", id, (unsigned)wave.expected_bytes, (unsigned)wave_pos, reason);
    ws_send_text_async_fd(fd, complete_msg);
    char idle_msg[240];
    snprintf(idle_msg, sizeof(idle_msg), "{\"type\":\"digital_tx_state\",\"state\":\"IDLE\",\"ok\":%s,\"id\":%" PRIu32 ",\"reason\":\"%.150s\"}",
             completed ? "true" : "false", id, reason);
    ws_send_text_async_fd(fd, idle_msg);
    if (!completed) {
        char abort_msg[240];
        snprintf(abort_msg, sizeof(abort_msg), "{\"type\":\"tx_abort\",\"reason\":\"%.160s\"}", reason);
        ws_send_text_async_fd(fd, abort_msg);
    }
    const uint64_t source_delta = keyed && audio_source_end >= audio_source_start ? audio_source_end - audio_source_start : 0;
    const uint64_t silence_delta = keyed && audio_silence_end >= audio_silence_start ? audio_silence_end - audio_silence_start : 0;
    const uint64_t drop_delta = keyed && audio_drop_end >= audio_drop_start ? audio_drop_end - audio_drop_start : 0;
    ESP_LOGW(TAG, "Digital staged TX stopped: %s; id=%" PRIu32 " staged=%u/%u B rate=%" PRIu32 "Hz ptt_delay=%ums tail=%ums source_frames=%" PRIu64 " silence_fill_frames=%" PRIu64 " dropped_old_bytes=%" PRIu64 " backpressure_retries=%" PRIu64,
             reason, id, (unsigned)wave_pos, (unsigned)wave.expected_bytes, wave.sample_rate_hz,
             ptt_delay_ms, tail_ms, source_delta, silence_delta, drop_delta, lossless_backpressure_retries);
    if (!audio_ws_is_active(fd)) digital_waveform_clear();
    if (params) free(params);
    vTaskDelete(NULL);
}

static bool digital_tx_start(int fd, uint32_t id, uint32_t ptt_delay_ms, uint32_t tail_ms, uint32_t lease_ms, const char *label, char *reason, size_t reason_len)
{
    if (fd < 0 || id == 0) { snprintf(reason, reason_len, "invalid digital TX id"); return false; }
    if (digital_tx_is_running() || ft8_rf_operation_is_running()) { snprintf(reason, reason_len, "another RF TX is already running"); return false; }
    size_t waveform_bytes = 0;
    uint32_t waveform_rate_hz = 0;
    if (!digital_waveform_ready_for(fd, id, &waveform_bytes, &waveform_rate_hz)) {
        snprintf(reason, reason_len, "staged digital waveform is not ready");
        return false;
    }
    if (waveform_rate_hz != DIGITAL_TX_STAGE_RATE_HZ) { snprintf(reason, reason_len, "staged digital TX requires 48 kHz PCM"); return false; }

    ft710_audio_tx_status_t tx;
    ft710_audio_tx_get_status(&tx);
    if (!tx.streaming) { snprintf(reason, reason_len, "TX audio is not ready"); return false; }
    ft710_cat_status_t cat;
    ft710_cat_get_status(&cat);
    if (!cat.power_known || !cat.radio_power_on) { snprintf(reason, reason_len, "radio must be ON for staged digital TX"); return false; }
    if (cat.ptt_active || !strcasecmp(cat.tx_state, "TX")) { snprintf(reason, reason_len, "radio must be in RX before staged digital TX"); return false; }
    if (!audio_ws_set_tx_source(fd, AUDIO_TX_SOURCE_DIGITAL)) { snprintf(reason, reason_len, "could not claim digital TX audio source"); return false; }

    ptt_delay_ms = ptt_delay_ms > DIGITAL_TX_MAX_PTT_DELAY_MS ? DIGITAL_TX_MAX_PTT_DELAY_MS : ptt_delay_ms;
    tail_ms = tail_ms > DIGITAL_TX_MAX_TAIL_MS ? DIGITAL_TX_MAX_TAIL_MS : tail_ms;
    const uint32_t duration_ms = (uint32_t)((waveform_bytes / 2ULL) * 1000ULL / DIGITAL_TX_STAGE_RATE_HZ);
    uint32_t computed_lease = duration_ms + ptt_delay_ms + tail_ms + 3000U;
    if (computed_lease < DIGITAL_TX_MIN_LEASE_MS) computed_lease = DIGITAL_TX_MIN_LEASE_MS;
    if (computed_lease > DIGITAL_TX_MAX_LEASE_MS) computed_lease = DIGITAL_TX_MAX_LEASE_MS;
    if (lease_ms == 0 || lease_ms < computed_lease) lease_ms = computed_lease;
    if (lease_ms > DIGITAL_TX_MAX_LEASE_MS) lease_ms = DIGITAL_TX_MAX_LEASE_MS;

    digital_tx_params_t *params = calloc(1, sizeof(*params));
    if (!params) {
        (void)audio_ws_set_tx_source(fd, AUDIO_TX_SOURCE_NONE);
        snprintf(reason, reason_len, "digital TX task allocation failed");
        return false;
    }
    params->fd = fd;
    params->id = id;
    params->ptt_delay_ms = ptt_delay_ms;
    params->tail_ms = tail_ms;
    params->lease_ms = lease_ms;
    if (label && label[0]) snprintf(params->label, sizeof(params->label), "%s", label);

    portENTER_CRITICAL(&s_digital_tx_mux);
    s_digital_tx_task_running = true;
    s_digital_tx_active = false;
    s_digital_tx_stop_requested = false;
    s_digital_tx_waveform_id = id;
    s_digital_tx_started_ms = 0;
    s_digital_tx_deadline_ms = 0;
    snprintf(s_digital_tx_phase, sizeof(s_digital_tx_phase), "%s", "ARMING");
    s_digital_tx_last_reason[0] = '\0';
    portEXIT_CRITICAL(&s_digital_tx_mux);

    if (xTaskCreate(digital_tx_task, "digital_tx", 6144, params, 4, NULL) != pdPASS) {
        portENTER_CRITICAL(&s_digital_tx_mux);
        s_digital_tx_task_running = false;
        snprintf(s_digital_tx_phase, sizeof(s_digital_tx_phase), "%s", "IDLE");
        snprintf(s_digital_tx_last_reason, sizeof(s_digital_tx_last_reason), "%s", "digital TX task allocation failed");
        portEXIT_CRITICAL(&s_digital_tx_mux);
        free(params);
        (void)audio_ws_set_tx_source(fd, AUDIO_TX_SOURCE_NONE);
        snprintf(reason, reason_len, "could not start digital TX task");
        return false;
    }
    ESP_LOGW(TAG, "Digital staged TX armed: id=%" PRIu32 " bytes=%u rate=%" PRIu32 "Hz ptt_delay=%ums tail=%ums lease=%ums label=%s",
             id, (unsigned)waveform_bytes, waveform_rate_hz, ptt_delay_ms, tail_ms, lease_ms, label && label[0] ? label : "-");
    return true;
}

static void ft8_tx_task(void *arg)
{
    const int fd = (int)(intptr_t)arg;
    char reason[96] = "completed";
    bool completed = false;
    bool keyed = false;
    bool rx_paused_for_tx = false;
    bool cat_quiet_for_tx = false;
    bool active_cat_transition_logged = false;
    ft8_tx_snapshot_t tx;
    ft710_cat_status_t cat;
    ft8_wave_snapshot_t wave;
    size_t wave_pos = 0;
    uint64_t audio_source_start = 0;
    uint64_t audio_silence_start = 0;
    uint64_t audio_drop_start = 0;
    uint32_t audio_error_start = 0;
    uint64_t output_empty_since_ms = 0;
    uint64_t audio_source_end = 0;
    uint64_t audio_silence_end = 0;
    uint64_t audio_drop_end = 0;
    uint64_t lossless_backpressure_retries = 0;

    ft8_tx_get_snapshot(&tx);
    memset(&wave, 0, sizeof(wave));
    if (!tx.streamed_audio) {
        ft8_waveform_get_snapshot(&wave);
        if (!wave.ready || !wave.data || wave.id != tx.waveform_id || wave.owner_fd != fd || wave.received_bytes != wave.expected_bytes) {
            snprintf(reason, sizeof(reason), "staged FT8 waveform vanished before slot start");
            goto cleanup;
        }
        if (wave.sample_rate_hz != FT8_TX_STAGE_RATE_HZ) {
            snprintf(reason, sizeof(reason), "staged FT8 waveform must be 48 kHz");
            goto cleanup;
        }
    }
    ft8_tx_set_phase("ARMED", NULL);
    while (true) {
        ft8_tx_get_snapshot(&tx);
        if (tx.stop_requested) { snprintf(reason, sizeof(reason), "%s", tx.last_reason[0] ? tx.last_reason : "operator halt"); goto cleanup; }
        if (!audio_ws_is_active(fd)) { snprintf(reason, sizeof(reason), "audio WebSocket disconnected"); goto cleanup; }
        if (monotonic_ms() >= tx.lease_deadline_ms) { snprintf(reason, sizeof(reason), "FT8 TX lease expired while armed"); goto cleanup; }
        bool clock_valid = false;
        const uint64_t now_unix = unix_time_ms(&clock_valid);
        if (!clock_valid) { snprintf(reason, sizeof(reason), "ESP32 UTC became invalid"); goto cleanup; }
        if (!rx_paused_for_tx && now_unix + 300U >= tx.target_unix_ms + FT8_TX_PTT_OFFSET_MS) {
            esp_err_t rx_err = ft710_audio_set_tx_half_duplex(true, 500U);
            if (rx_err != ESP_OK) {
                snprintf(reason, sizeof(reason), "could not suspend UAC RX before FT8 TX: %s", esp_err_to_name(rx_err));
                goto cleanup;
            }
            rx_paused_for_tx = true;
            ESP_LOGI(TAG, "FT8 TX half-duplex: UAC RX suspended before slot");
        }
        if (now_unix + 2U >= tx.target_unix_ms + FT8_TX_PTT_OFFSET_MS) break;
        vTaskDelay(pdMS_TO_TICKS(5));
    }

    ft8_tx_get_snapshot(&tx);
    ft710_cat_get_status(&cat);
    if (cat.ptt_active || !strcasecmp(cat.tx_state, "TX")) { snprintf(reason, sizeof(reason), "radio already in TX at slot start"); goto cleanup; }
    if (!ft8_tx_radio_matches_prekey(&cat, &tx, reason, sizeof(reason))) goto cleanup;
    if (audio_ws_get_tx_source() != AUDIO_TX_SOURCE_FT8) { snprintf(reason, sizeof(reason), "FT8 audio source was not armed"); goto cleanup; }

    ft8_tx_set_phase("KEYING", NULL);
    esp_err_t err = ft710_cat_set_ptt(true, API_TIMEOUT_MS);
    if (err != ESP_OK) { snprintf(reason, sizeof(reason), "PTT start failed: %s", esp_err_to_name(err)); goto cleanup; }
    keyed = true;
    err = ft710_cat_set_tx_quiet(true, 900U);
    if (err != ESP_OK) {
        snprintf(reason, sizeof(reason), "could not isolate CAT BULK IN for FT8 TX: %s", esp_err_to_name(err));
        goto cleanup;
    }
    cat_quiet_for_tx = true;
    const uint64_t keyed_ms = monotonic_ms();
    bool clock_valid = false;
    const uint64_t ptt_unix = unix_time_ms(&clock_valid);
    portENTER_CRITICAL(&s_ft8_tx_mux);
    s_ft8_tx_active = true;
    s_ft8_tx_ptt_started_unix_ms = clock_valid ? ptt_unix : 0;
    snprintf(s_ft8_tx_phase, sizeof(s_ft8_tx_phase), "%s", "ACTIVE");
    portEXIT_CRITICAL(&s_ft8_tx_mux);
    char active_msg[256];
    snprintf(active_msg, sizeof(active_msg), "{\"type\":\"ft8_tx_state\",\"state\":\"ACTIVE\",\"slot_index\":%" PRIu64 ",\"target_unix_ms\":%" PRIu64 ",\"ptt_unix_ms\":%" PRIu64 ",\"waveform_id\":%" PRIu32 "}", tx.target_slot_index, tx.target_unix_ms, ptt_unix, tx.waveform_id);
    ws_send_text_async_fd(fd, active_msg);
    ESP_LOGW(TAG, "FT8 TX ACTIVE slot=%" PRIu64 " target=%" PRIu64 " ptt=%" PRIu64 " vfoA=%" PRIu32 " vfoB=%" PRIu32 " power=%dW audio=%s waveform=%" PRIu32 " CAT_BULK_IN=HALTED", tx.target_slot_index, tx.target_unix_ms, ptt_unix, tx.expected_vfo_a_hz, tx.expected_vfo_b_hz, tx.expected_power_w, tx.streamed_audio ? "WEBAUDIO_WORKLET" : "STAGED_UAC_48K_1PKT", tx.waveform_id);

    /* FT8.5.16 automatic QSO TX uses staged 48 kHz PCM through the single-packet-URB UAC1 experiment
     * playback so browser/main-thread jitter cannot enter the RF waveform.
     * streamed_audio remains only for the legacy RX-only lab path. */
    ft710_audio_tx_input_reset();
    ft710_audio_tx_status_t audio_start;
    ft710_audio_tx_get_status(&audio_start);
    audio_source_start = audio_start.source_frames_sent;
    audio_silence_start = audio_start.silence_frames_sent;
    audio_drop_start = audio_start.input_bytes_dropped_old;
    audio_error_start = audio_start.transfer_errors;
    if (!tx.streamed_audio && s_ft8_wave_mutex && xSemaphoreTake(s_ft8_wave_mutex, pdMS_TO_TICKS(10)) == pdTRUE) {
        s_ft8_wave_consumed_bytes = 0;
        xSemaphoreGive(s_ft8_wave_mutex);
    }
    wave_pos = 0;

    while (true) {
        ft8_tx_get_snapshot(&tx);
        if (tx.stop_requested) {
            snprintf(reason, sizeof(reason), "%s", tx.last_reason[0] ? tx.last_reason : "browser completed waveform");
            completed = strstr(reason, "complete") != NULL || strstr(reason, "waveform") != NULL;
            break;
        }
        if (!audio_ws_is_active(fd)) { snprintf(reason, sizeof(reason), "audio WebSocket disconnected"); break; }
        if (monotonic_ms() >= tx.lease_deadline_ms) { snprintf(reason, sizeof(reason), "FT8 TX keepalive expired"); break; }
        bool valid = false;
        const uint64_t now_unix = unix_time_ms(&valid);
        if (!valid) { snprintf(reason, sizeof(reason), "ESP32 UTC became invalid"); break; }
        if (now_unix >= tx.hard_stop_unix_ms) { snprintf(reason, sizeof(reason), "FT8 slot hard deadline reached"); break; }
        ft710_cat_get_status(&cat);
        if (!cat.device_open || !cat.interface_claimed) {
            snprintf(reason, sizeof(reason), "CAT USB device disappeared during FT8 TX");
            break;
        }
        if (!cat.ptt_active) { snprintf(reason, sizeof(reason), "PTT watchdog/safety released TX"); break; }
        if (!cat_quiet_for_tx) {
            if (!active_cat_transition_logged &&
                ((tx.expected_vfo_a_hz && llabs((long long)cat.vfo_a_hz - (long long)tx.expected_vfo_a_hz) > 5) ||
                 (tx.expected_vfo_b_hz && llabs((long long)cat.vfo_b_hz - (long long)tx.expected_vfo_b_hz) > 5) ||
                 cat.active_vfo[0] != 'A')) {
                ESP_LOGW(TAG,
                         "FT8 TX ACTIVE CAT transition snapshot (diagnostic only): expected A=%" PRIu32 " B=%" PRIu32 "; observed A=%" PRIu32 " B=%" PRIu32 " active=%s split=%d tx_state=%s",
                         tx.expected_vfo_a_hz, tx.expected_vfo_b_hz,
                         cat.vfo_a_hz, cat.vfo_b_hz,
                         cat.active_vfo[0] ? cat.active_vfo : "?", cat.split_enabled, cat.tx_state);
                active_cat_transition_logged = true;
            }
            if (!ft8_tx_radio_safe_active(&cat, &tx, reason, sizeof(reason))) break;
            /* RI0 is polled asynchronously and can lag TX1 for a short time. */
            if (strcasecmp(cat.tx_state, "TX") && monotonic_ms() - keyed_ms >= FT8_TX_STATE_CONFIRM_GRACE_MS) {
                snprintf(reason, sizeof(reason), "radio did not confirm TX after %u ms", FT8_TX_STATE_CONFIRM_GRACE_MS);
                break;
            }
        }
        if (audio_ws_get_tx_source() != AUDIO_TX_SOURCE_FT8) { snprintf(reason, sizeof(reason), "FT8 TX source changed"); break; }

        ft710_audio_tx_status_t audio_now;
        ft710_audio_tx_get_status(&audio_now);
        if (!audio_now.streaming) { snprintf(reason, sizeof(reason), "UAC1 TX stream stopped during FT8 TX"); break; }
        if (audio_now.transfer_errors > audio_error_start) {
            snprintf(reason, sizeof(reason), "UAC TX transfer error during FT8 TX");
            break;
        }
        if (!tx.streamed_audio && wave_pos < wave.expected_bytes && audio_now.input_buffered_bytes < FT8_TX_WAVEFORM_QUEUE_LOW) {
            while (wave_pos < wave.expected_bytes && audio_now.input_buffered_bytes < FT8_TX_WAVEFORM_QUEUE_HIGH) {
                size_t room = FT8_TX_WAVEFORM_QUEUE_HIGH - audio_now.input_buffered_bytes;
                size_t accepted = 0;
                size_t source_advance = 0;

                size_t left = wave.expected_bytes - wave_pos;
                size_t chunk = left < FT8_TX_WAVEFORM_FEED_CHUNK ? left : FT8_TX_WAVEFORM_FEED_CHUNK;
                if (chunk > room) chunk = room;
                chunk &= ~(size_t)1U;
                if (chunk == 0) break;
                accepted = ft710_audio_tx_push_mono_s16_lossless(wave.data + wave_pos, chunk);
                if (accepted != 0 && accepted != chunk) {
                    snprintf(reason, sizeof(reason), "ESP32 UAC1 queue partially accepted staged FT8 PCM");
                    goto cleanup;
                }
                if (accepted == chunk) source_advance = chunk;

                if (accepted == 0) {
                    /* Lossless backpressure: a full/busy UAC queue is NOT a
                     * reason to advance the staged waveform. Wait for the USB
                     * consumer to create real space and retry the same PCM. */
                    lossless_backpressure_retries++;
                    break;
                }
                wave_pos += source_advance;
                if (s_ft8_wave_mutex && xSemaphoreTake(s_ft8_wave_mutex, pdMS_TO_TICKS(10)) == pdTRUE) {
                    s_ft8_wave_consumed_bytes = wave_pos;
                    xSemaphoreGive(s_ft8_wave_mutex);
                }
                portENTER_CRITICAL(&s_ws_mux);
                s_audio_ws_tx_bytes += accepted;
                s_audio_ws_tx_ft8_bytes += accepted;
                portEXIT_CRITICAL(&s_ws_mux);
                ft710_audio_tx_get_status(&audio_now);
            }
        }
        if (!tx.streamed_audio && wave_pos >= wave.expected_bytes) {
            ft710_audio_tx_get_status(&audio_now);
            /* FT8.5.16: 48 kHz raw TX keeps 32 x 1 ms single-packet isochronous URBs
             * queued in the HCD.  The FreeRig mono FIFO reaching zero can
             * therefore precede the final on-wire sample by up to ~128 ms.
             * Hold PTT for 180 ms after the local FIFO first reaches zero;
             * reset the timer if more source data appears. */
            if (audio_now.input_buffered_bytes == 0U) {
                if (output_empty_since_ms == 0U) output_empty_since_ms = monotonic_ms();
                if (monotonic_ms() - output_empty_since_ms >= 180U) {
                    snprintf(reason, sizeof(reason), "staged waveform complete (raw deep-isoc drain)");
                    completed = true;
                    break;
                }
            } else {
                output_empty_since_ms = 0U;
            }
        }
        vTaskDelay(pdMS_TO_TICKS(2));
    }

cleanup:
    /* Snapshot audio counters while RF playback is still active. Taking this
     * before TX0/source reset prevents normal post-waveform UAC silence from
     * being misreported as an underrun inside the FT8 waveform itself. */
    if (keyed) {
        ft710_audio_tx_status_t audio_rf_end;
        ft710_audio_tx_get_status(&audio_rf_end);
        audio_source_end = audio_rf_end.source_frames_sent;
        audio_silence_end = audio_rf_end.silence_frames_sent;
        audio_drop_end = audio_rf_end.input_bytes_dropped_old;
    }
    ft8_tx_set_phase("STOPPING", reason);
    if (keyed) (void)ft710_cat_force_ptt_off(API_TIMEOUT_MS);
    if (cat_quiet_for_tx) {
        esp_err_t cat_resume_err = ft710_cat_set_tx_quiet(false, 1000U);
        if (cat_resume_err != ESP_OK) ESP_LOGW(TAG, "CAT BULK IN resume after FT8 TX failed: %s", esp_err_to_name(cat_resume_err));
        else ESP_LOGI(TAG, "FT8 TX isolation: CAT BULK IN resumed");
        cat_quiet_for_tx = false;
    }
    if (rx_paused_for_tx) {
        esp_err_t rx_resume_err = ft710_audio_set_tx_half_duplex(false, 1200U);
        if (rx_resume_err != ESP_OK) ESP_LOGW(TAG, "UAC RX resume after FT8 TX failed: %s", esp_err_to_name(rx_resume_err));
        else ESP_LOGI(TAG, "FT8 TX half-duplex: UAC RX resumed");
        rx_paused_for_tx = false;
    }
    if (audio_ws_is_active(fd)) (void)audio_ws_set_tx_source(fd, AUDIO_TX_SOURCE_NONE);
    ft710_audio_tx_input_reset();
    portENTER_CRITICAL(&s_ft8_tx_mux);
    s_ft8_tx_active = false;
    s_ft8_tx_task_running = false;
    s_ft8_tx_stop_requested = false;
    s_ft8_tx_lease_deadline_ms = 0;
    snprintf(s_ft8_tx_phase, sizeof(s_ft8_tx_phase), "%s", "IDLE");
    snprintf(s_ft8_tx_last_reason, sizeof(s_ft8_tx_last_reason), "%s", reason);
    if (completed) s_ft8_tx_sessions_completed++;
    else s_ft8_tx_sessions_aborted++;
    portEXIT_CRITICAL(&s_ft8_tx_mux);
    char stopped_msg[320];
    snprintf(stopped_msg, sizeof(stopped_msg), "{\"type\":\"ft8_tx_state\",\"state\":\"IDLE\",\"ok\":%s,\"reason\":\"%.180s\"}", completed ? "true" : "false", reason);
    ws_send_text_async_fd(fd, stopped_msg);
    if (!completed) {
        char abort_msg[300];
        snprintf(abort_msg, sizeof(abort_msg), "{\"type\":\"tx_abort\",\"reason\":\"%.180s\"}", reason);
        ws_send_text_async_fd(fd, abort_msg);
    }
    const uint64_t source_delta = keyed && audio_source_end >= audio_source_start ? audio_source_end - audio_source_start : 0;
    const uint64_t silence_delta = keyed && audio_silence_end >= audio_silence_start ? audio_silence_end - audio_silence_start : 0;
    const uint64_t drop_delta = keyed && audio_drop_end >= audio_drop_start ? audio_drop_end - audio_drop_start : 0;
    if (tx.streamed_audio) {
        ESP_LOGW(TAG, "FT8 TX stopped: %s; audio=WEBAUDIO_WORKLET source_frames=%" PRIu64 " silence_fill_frames=%" PRIu64 " dropped_old_bytes=%" PRIu64,
                 reason, source_delta, silence_delta, drop_delta);
    } else {
        ESP_LOGW(TAG, "FT8 TX stopped: %s; staged=%u/%u B rate=%" PRIu32 "Hz source_frames=%" PRIu64 " silence_fill_frames=%" PRIu64 " dropped_old_bytes=%" PRIu64 " backpressure_retries=%" PRIu64,
                 reason, (unsigned)wave_pos, (unsigned)wave.expected_bytes, wave.sample_rate_hz,
                 source_delta, silence_delta, drop_delta, lossless_backpressure_retries);
    }
    if (!audio_ws_is_active(fd)) ft8_waveform_clear();
    vTaskDelete(NULL);
}

static cJSON *ft8_tx_status_json(void)
{
    ft8_tx_snapshot_t tx;
    ft8_tx_get_snapshot(&tx);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "running", tx.task_running);
    cJSON_AddBoolToObject(o, "active", tx.active);
    cJSON_AddStringToObject(o, "phase", tx.phase);
    cJSON_AddNumberToObject(o, "lease_ms", FT8_TX_LEASE_MS);
    cJSON_AddNumberToObject(o, "ptt_offset_ms", FT8_TX_PTT_OFFSET_MS);
    cJSON_AddNumberToObject(o, "hard_stop_offset_ms", FT8_TX_HARD_STOP_OFFSET_MS);
    cJSON_AddNumberToObject(o, "max_late_arm_ms", FT8_TX_ARM_MAX_LATE_MS);
    cJSON_AddNumberToObject(o, "target_slot_index", (double)tx.target_slot_index);
    cJSON_AddNumberToObject(o, "target_unix_ms", (double)tx.target_unix_ms);
    cJSON_AddNumberToObject(o, "ptt_started_unix_ms", (double)tx.ptt_started_unix_ms);
    cJSON_AddNumberToObject(o, "lease_deadline_ms", (double)tx.lease_deadline_ms);
    cJSON_AddNumberToObject(o, "hard_stop_unix_ms", (double)tx.hard_stop_unix_ms);
    cJSON_AddNumberToObject(o, "keepalives", tx.keepalives);
    cJSON_AddNumberToObject(o, "sessions_started", tx.sessions_started);
    cJSON_AddNumberToObject(o, "sessions_completed", tx.sessions_completed);
    cJSON_AddNumberToObject(o, "sessions_aborted", tx.sessions_aborted);
    cJSON_AddNumberToObject(o, "expected_vfo_a_hz", tx.expected_vfo_a_hz);
    cJSON_AddNumberToObject(o, "expected_vfo_b_hz", tx.expected_vfo_b_hz);
    cJSON_AddNumberToObject(o, "waveform_id", tx.waveform_id);
    cJSON_AddBoolToObject(o, "streamed_audio", tx.streamed_audio);
    cJSON_AddNumberToObject(o, "expected_power_w", tx.expected_power_w);
    ft710_cat_status_t cat;
    ft710_cat_get_status(&cat);
    cJSON_AddBoolToObject(o, "cat_quiet_active", cat.tx_quiet_active);
    cJSON_AddStringToObject(o, "last_reason", tx.last_reason);
    return o;
}

static esp_err_t ft8_tx_arm_handler(httpd_req_t *req)
{
    if (ft8_tune_is_running()) return send_error(req, "409 Conflict", "FT8 ALC Tune is running");
    if (ft8_tx_is_running()) return send_error(req, "409 Conflict", "an FT8 TX slot is already armed/running");
    cJSON *j = read_json(req);
    if (!j) return send_error(req, "422 Unprocessable Entity", "invalid JSON");
    cJSON *slot_item = cJSON_GetObjectItemCaseSensitive(j, "slot_index");
    const uint64_t slot_index = cJSON_IsNumber(slot_item) ? (uint64_t)slot_item->valuedouble : 0;
    const int parity = json_int(j, "slot_parity", -1);
    const uint32_t expected_a = (uint32_t)json_int(j, "vfo_a_hz", 0);
    const uint32_t expected_b = (uint32_t)json_int(j, "vfo_b_hz", 0);
    const uint32_t waveform_id = (uint32_t)json_int(j, "waveform_id", 0);
    const bool streamed_audio = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(j, "streamed_audio"));
    const int expected_power = json_int(j, "power_w", 0);
    cJSON_Delete(j);
    if (!slot_index || parity < 0 || parity > 1 || ((slot_index & 1ULL) != (uint64_t)parity)) return send_error(req, "422 Unprocessable Entity", "invalid FT8 slot/parity");
    if (expected_a < 30000 || expected_b < 30000 || expected_power < 5 || expected_power > 100) return send_error(req, "422 Unprocessable Entity", "expected VFO/power values are required");
    if (!streamed_audio && waveform_id == 0) return send_error(req, "422 Unprocessable Entity", "waveform id is required for staged FT8 TX");

    network_eth_status_t net;
    network_eth_get_status(&net);
    bool clock_valid = false;
    const uint64_t now_unix = unix_time_ms(&clock_valid);
    if (!clock_valid || !net.time_synced) return send_error(req, "409 Conflict", "ESP32 SNTP UTC is not synchronized");
    const uint64_t target_unix = slot_index * 15000ULL;
    if (target_unix > now_unix) {
        const uint64_t lead = target_unix - now_unix;
        if (lead < FT8_TX_ARM_MIN_LEAD_MS || lead > FT8_TX_ARM_MAX_LEAD_MS) return send_error(req, "409 Conflict", "FT8 slot must be armed 0.35..5.0 s before its UTC boundary");
    } else {
        const uint64_t late = now_unix - target_unix;
        if (late > FT8_TX_ARM_MAX_LATE_MS) return send_error(req, "409 Conflict", "current FT8 TX slot is already too late to arm safely");
    }

    ft710_cat_status_t cat;
    ft710_cat_get_status(&cat);
    ft710_audio_tx_status_t audio_tx;
    ft710_audio_tx_get_status(&audio_tx);
    portENTER_CRITICAL(&s_ws_mux);
    const int fd = s_audio_ws_fd;
    portEXIT_CRITICAL(&s_ws_mux);
    if (fd < 0) return send_error(req, "409 Conflict", "FT8 audio WebSocket is not connected");
    if (!audio_tx.streaming) return send_error(req, "409 Conflict", "TX audio is not ready");
    if (cat.ptt_active || !strcasecmp(cat.tx_state, "TX")) return send_error(req, "409 Conflict", "radio must be in RX before FT8 TX arm");

    ft8_tx_snapshot_t check = { .expected_vfo_a_hz = expected_a, .expected_vfo_b_hz = expected_b, .expected_power_w = expected_power };
    char reason[128] = {0};
    if (!ft8_tx_radio_matches_prekey(&cat, &check, reason, sizeof(reason))) {
        /* A freshly written FB/ST value may not be visible in the normal 1 Hz
         * status cache yet. Query the actual radio before refusing TX. A very
         * recent Yaesu setter can also need a few tens of milliseconds before
         * the matching query reflects it, so retry the fresh snapshot briefly. */
        bool matched = false;
        char refresh_reason[128] = {0};
        for (int attempt = 0; attempt < 3; ++attempt) {
            if (!ft8_tx_refresh_prekey_vfo(&cat, refresh_reason, sizeof(refresh_reason)))
                return send_error(req, "409 Conflict", refresh_reason);
            reason[0] = '\0';
            if (ft8_tx_radio_matches_prekey(&cat, &check, reason, sizeof(reason))) { matched = true; break; }
            if (attempt < 2) vTaskDelay(pdMS_TO_TICKS(35));
        }
        if (!matched) return send_error(req, "409 Conflict", reason);
    }

    /* Fresh CAT verification itself consumes time. Never let a slow pre-key
     * query turn a previously valid late-start request into an overrun. */
    bool verified_clock = false;
    const uint64_t verified_now_unix = unix_time_ms(&verified_clock);
    if (!verified_clock) return send_error(req, "409 Conflict", "ESP32 UTC became unavailable during FT8 pre-key check");
    if (verified_now_unix > target_unix && verified_now_unix - target_unix > FT8_TX_ARM_MAX_LATE_MS)
        return send_error(req, "409 Conflict", "FT8 slot became too late during CAT pre-key verification");
    size_t waveform_bytes = 0;
    uint32_t waveform_rate_hz = 0;
    if (!streamed_audio) {
        if (!ft8_waveform_ready_for(fd, waveform_id, &waveform_bytes, &waveform_rate_hz)) return send_error(req, "409 Conflict", "FT8 waveform is not fully staged on ESP32");
        if (waveform_rate_hz != FT8_TX_STAGE_RATE_HZ) return send_error(req, "409 Conflict", "staged FT8 TX requires 48 kHz PCM");
        if (waveform_bytes < 1200000U) return send_error(req, "409 Conflict", "staged FT8 48 kHz waveform is unexpectedly short");
    }
    if (!audio_ws_set_tx_source(fd, AUDIO_TX_SOURCE_FT8)) return send_error(req, "409 Conflict", "could not claim FT8 TX audio source");

    portENTER_CRITICAL(&s_ft8_tx_mux);
    s_ft8_tx_task_running = true;
    s_ft8_tx_active = false;
    s_ft8_tx_stop_requested = false;
    s_ft8_tx_target_slot_index = slot_index;
    s_ft8_tx_target_unix_ms = target_unix;
    s_ft8_tx_ptt_started_unix_ms = 0;
    s_ft8_tx_lease_deadline_ms = monotonic_ms() + FT8_TX_LEASE_MS;
    s_ft8_tx_hard_stop_unix_ms = target_unix + FT8_TX_HARD_STOP_OFFSET_MS;
    s_ft8_tx_keepalives = 0;
    s_ft8_tx_expected_vfo_a_hz = expected_a;
    s_ft8_tx_expected_vfo_b_hz = expected_b;
    s_ft8_tx_waveform_id = waveform_id;
    s_ft8_tx_streamed_audio = streamed_audio;
    s_ft8_tx_expected_power_w = expected_power;
    s_ft8_tx_sessions_started++;
    snprintf(s_ft8_tx_phase, sizeof(s_ft8_tx_phase), "%s", "ARMING");
    s_ft8_tx_last_reason[0] = '\0';
    portEXIT_CRITICAL(&s_ft8_tx_mux);

    ESP_LOGW(TAG, "FT8 TX ARMED slot=%" PRIu64 " parity=%s target=%" PRIu64 " lead_ms=%" PRId64 " audio=%s waveform=%" PRIu32 " rate=%" PRIu32 "Hz bytes=%u",
             slot_index, (slot_index & 1ULL) ? "ODD" : "EVEN", target_unix,
             (int64_t)target_unix - (int64_t)now_unix, streamed_audio ? "WEBAUDIO_WORKLET" : "STAGED_UAC_48K_1PKT", waveform_id, waveform_rate_hz, (unsigned)waveform_bytes);

    if (xTaskCreate(ft8_tx_task, "ft8_slot_tx", 6144, (void *)(intptr_t)fd, 4, NULL) != pdPASS) {
        portENTER_CRITICAL(&s_ft8_tx_mux);
        s_ft8_tx_task_running = false;
        snprintf(s_ft8_tx_phase, sizeof(s_ft8_tx_phase), "%s", "IDLE");
        snprintf(s_ft8_tx_last_reason, sizeof(s_ft8_tx_last_reason), "%s", "FT8 TX task allocation failed");
        s_ft8_tx_sessions_aborted++;
        portEXIT_CRITICAL(&s_ft8_tx_mux);
        (void)audio_ws_set_tx_source(fd, AUDIO_TX_SOURCE_NONE);
        return send_error(req, "500 Internal Server Error", "could not start FT8 TX task");
    }
    cJSON *o = cJSON_CreateObject();
    cJSON_AddTrueToObject(o, "ok");
    cJSON_AddItemToObject(o, "tx", ft8_tx_status_json());
    return send_json(req, o);
}

static esp_err_t ft8_tx_keepalive_handler(httpd_req_t *req)
{
    if (!ft8_tx_is_running()) return send_error(req, "409 Conflict", "FT8 TX is not armed/running");
    ft8_tx_keepalive();
    cJSON *o = cJSON_CreateObject();
    cJSON_AddTrueToObject(o, "ok");
    cJSON_AddItemToObject(o, "tx", ft8_tx_status_json());
    return send_json(req, o);
}

static esp_err_t ft8_tx_stop_handler(httpd_req_t *req)
{
    cJSON *j = read_json(req);
    const char *r = j ? json_string(j, "reason", "operator halt") : "operator halt";
    char reason[96];
    snprintf(reason, sizeof(reason), "%s", r && r[0] ? r : "operator halt");
    if (j) cJSON_Delete(j);
    ft8_tx_request_stop(reason);
    (void)ft710_cat_force_ptt_off(API_TIMEOUT_MS);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddTrueToObject(o, "ok");
    cJSON_AddItemToObject(o, "tx", ft8_tx_status_json());
    return send_json(req, o);
}

static void ft8_tune_task(void *arg)
{
    const int fd = (int)(intptr_t)arg;
    ft8_tune_snapshot_t initial_tune;
    ft8_tune_get_snapshot(&initial_tune);
    const float initial_level_dbfs = initial_tune.level_dbfs;
    const bool metering_enabled = initial_tune.metering_enabled;
    const bool usb_quiet = initial_tune.usb_quiet;
    const uint32_t tone_frequency_hz = initial_tune.frequency_hz;
    char response[FT710_CAT_RESPONSE_MAX] = {0};
    ft710_cat_status_t cat;
    ft710_cat_get_status(&cat);
    int original_power = (cat.tx_power_w >= 5 && cat.tx_power_w <= 100) ? cat.tx_power_w : 5;
    int queried_power = 0;
    if (ft710_cat_query("PC;", response, sizeof(response), API_TIMEOUT_MS) == ESP_OK && parse_pc_reply_local(response, &queried_power) && queried_power >= 5 && queried_power <= 100) {
        original_power = queried_power;
    }

    portENTER_CRITICAL(&s_ft8_tune_mux);
    s_ft8_tune_original_power_w = original_power;
    s_ft8_tune_restored_power_w = 0;
    portEXIT_CRITICAL(&s_ft8_tune_mux);

    char reason[96] = "operator stop";
    esp_err_t err = ESP_OK;
    bool rx_paused_for_tune = false;
    ft8_tune_set_phase("POWER_5W", NULL);
    err = ft710_cat_set("PC005;", API_TIMEOUT_MS);
    if (err != ESP_OK) {
        snprintf(reason, sizeof(reason), "failed to set 5 W: %s", esp_err_to_name(err));
        goto cleanup;
    }
    vTaskDelay(pdMS_TO_TICKS(80));

    if (!audio_ws_is_active(fd) || !audio_ws_set_tx_source(fd, AUDIO_TX_SOURCE_FT8)) {
        snprintf(reason, sizeof(reason), "audio WebSocket disappeared before tuning");
        goto cleanup;
    }

    ft8_tune_set_phase("RX_SUSPEND", NULL);
    err = ft710_audio_set_tx_half_duplex(true, 700U);
    if (err != ESP_OK) {
        snprintf(reason, sizeof(reason), "could not suspend UAC RX for Tune: %s", esp_err_to_name(err));
        goto cleanup;
    }
    rx_paused_for_tune = true;

    ft8_tune_set_phase("TONE_PREFILL", NULL);
    ft710_audio_tx_tone_start(tone_frequency_hz, initial_level_dbfs);
    const uint64_t prefill_deadline = monotonic_ms() + 500U;
    bool prefilled = false;
    while (monotonic_ms() < prefill_deadline) {
        ft710_audio_tx_status_t txs;
        ft710_audio_tx_get_status(&txs);
        if (txs.input_buffered_bytes >= 9600U) { /* >=100 ms mono PCM */
            prefilled = true;
            break;
        }
        if (!audio_ws_is_active(fd)) {
            snprintf(reason, sizeof(reason), "audio WebSocket disconnected during Tune prefill");
            goto cleanup;
        }
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    if (!prefilled) {
        snprintf(reason, sizeof(reason), "Tune FIFO did not prefill 100 ms before PTT");
        goto cleanup;
    }

    ft8_tune_set_phase("KEYING", NULL);
    err = ft710_cat_set_ptt(true, API_TIMEOUT_MS);
    if (err != ESP_OK) {
        snprintf(reason, sizeof(reason), "PTT start failed: %s", esp_err_to_name(err));
        goto cleanup;
    }
    if (usb_quiet) {
        ft8_tune_set_phase("CAT_QUIET", NULL);
        err = ft710_cat_set_tx_quiet(true, 700U);
        if (err != ESP_OK) {
            snprintf(reason, sizeof(reason), "could not isolate CAT BULK IN for Tune: %s", esp_err_to_name(err));
            goto cleanup;
        }
    }

    const uint64_t keyed_ms = monotonic_ms();
    const uint64_t started = keyed_ms;
    portENTER_CRITICAL(&s_ft8_tune_mux);
    s_ft8_tune_active = true;
    s_ft8_tune_started_ms = started;
    s_ft8_tune_deadline_ms = started + FT8_TUNE_LEASE_MS;
    snprintf(s_ft8_tune_phase, sizeof(s_ft8_tune_phase), "%s", "TUNING");
    portEXIT_CRITICAL(&s_ft8_tune_mux);
    ESP_LOGW(TAG, "FT8 tune started: fd=%d power=%dW->5W duration=%ums tone=%" PRIu32 "Hz FIFO_48K_1PKT level=%.1fdBFS metering=%s cat_bulk_in=%s",
             fd, original_power, FT8_TUNE_MAX_MS, tone_frequency_hz,
             (double)initial_level_dbfs, metering_enabled ? "on" : "off", usb_quiet ? "HALTED" : "running");

    uint64_t next_meter_ms = 0;
    uint32_t meter_cycle = 0;
    while (true) {
        const uint64_t now = monotonic_ms();
        ft8_tune_snapshot_t tune;
        ft8_tune_get_snapshot(&tune);
        if (tune.stop_requested) {
            snprintf(reason, sizeof(reason), "%s", tune.last_reason[0] ? tune.last_reason : "operator stop");
            break;
        }
        if (now >= tune.deadline_ms) {
            snprintf(reason, sizeof(reason), "tune keepalive expired");
            break;
        }
        if (!audio_ws_is_active(fd)) {
            snprintf(reason, sizeof(reason), "audio WebSocket disconnected");
            break;
        }
        if (now - started >= FT8_TUNE_MAX_MS) {
            snprintf(reason, sizeof(reason), "hard tune timeout reached");
            break;
        }
        ft710_cat_get_status(&cat);
        if (!cat.ptt_active) {
            snprintf(reason, sizeof(reason), "PTT safety released during tune");
            break;
        }
        /* In CAT-quiet diagnostic mode the continuous BULK IN endpoint is
         * intentionally halted, so power/SWR/TX state are frozen snapshots.
         * The local lease, hard timeout and PTT watchdog remain authoritative. */
        if (!usb_quiet) {
            if (!cat.power_known || !cat.radio_power_on) {
                snprintf(reason, sizeof(reason), "radio powered off during tune");
                break;
            }
            if (cat.hi_swr) {
                snprintf(reason, sizeof(reason), "HI-SWR detected during tune");
                break;
            }
            if (strcasecmp(cat.tx_state, "TX") && now - keyed_ms >= FT8_TX_STATE_CONFIRM_GRACE_MS) {
                snprintf(reason, sizeof(reason), "radio did not confirm TX during tune after %u ms", FT8_TX_STATE_CONFIRM_GRACE_MS);
                break;
            }
        }

        if (metering_enabled && now >= next_meter_ms) {
            int value = 0;
            bool ok = ft710_cat_query("RM4;", response, sizeof(response), API_TIMEOUT_MS) == ESP_OK && parse_rm_reply_local(response, '4', &value);
            portENTER_CRITICAL(&s_ft8_tune_mux);
            if (ok) {
                s_ft8_tune_alc_raw = value;
                s_ft8_tune_meter_reads++;
            } else {
                s_ft8_tune_meter_errors++;
            }
            portEXIT_CRITICAL(&s_ft8_tune_mux);

            if ((meter_cycle++ & 3U) == 0U) {
                int po = 0;
                if (ft710_cat_query("RM5;", response, sizeof(response), API_TIMEOUT_MS) == ESP_OK && parse_rm_reply_local(response, '5', &po)) {
                    portENTER_CRITICAL(&s_ft8_tune_mux);
                    s_ft8_tune_po_raw = po;
                    portEXIT_CRITICAL(&s_ft8_tune_mux);
                }
            }
            next_meter_ms = monotonic_ms() + FT8_TUNE_METER_PERIOD_MS;
        }
        vTaskDelay(pdMS_TO_TICKS(40));
    }

cleanup:
    ft8_tune_set_phase("STOPPING", reason);
    ft710_audio_tx_tone_stop();
    /* TX0 is intentionally first.  Power restore and source cleanup happen only after RF is gone. */
    (void)ft710_cat_force_ptt_off(API_TIMEOUT_MS);
    if (usb_quiet) {
        esp_err_t cat_resume_err = ft710_cat_set_tx_quiet(false, 900U);
        if (cat_resume_err != ESP_OK) ESP_LOGW(TAG, "CAT BULK IN resume after Tune failed: %s", esp_err_to_name(cat_resume_err));
        else ESP_LOGI(TAG, "FT8 Tune audio-only: CAT BULK IN resumed");
    }
    if (rx_paused_for_tune) {
        esp_err_t rx_resume_err = ft710_audio_set_tx_half_duplex(false, 1200U);
        if (rx_resume_err != ESP_OK) ESP_LOGW(TAG, "UAC RX resume after Tune failed: %s", esp_err_to_name(rx_resume_err));
        else ESP_LOGI(TAG, "FT8 Tune half-duplex: UAC RX resumed");
        rx_paused_for_tune = false;
    }
    if (audio_ws_is_active(fd)) (void)audio_ws_set_tx_source(fd, AUDIO_TX_SOURCE_NONE);
    ft710_audio_tx_input_reset();

    ft710_cat_get_status(&cat);
    int restored = 0;
    if (cat.power_known && cat.radio_power_on && original_power >= 5 && original_power <= 100) {
        char cmd[16];
        snprintf(cmd, sizeof(cmd), "PC%03d;", original_power);
        if (ft710_cat_set(cmd, API_TIMEOUT_MS) == ESP_OK) restored = original_power;
    }

    portENTER_CRITICAL(&s_ft8_tune_mux);
    s_ft8_tune_active = false;
    s_ft8_tune_task_running = false;
    s_ft8_tune_stop_requested = false;
    s_ft8_tune_deadline_ms = 0;
    s_ft8_tune_restored_power_w = restored;
    snprintf(s_ft8_tune_phase, sizeof(s_ft8_tune_phase), "%s", "IDLE");
    snprintf(s_ft8_tune_last_reason, sizeof(s_ft8_tune_last_reason), "%s", reason);
    portEXIT_CRITICAL(&s_ft8_tune_mux);
    ESP_LOGW(TAG, "FT8 ALC tune stopped: %s; power restored=%dW", reason, restored);
    vTaskDelete(NULL);
}

static cJSON *ft8_tune_status_json(void)
{
    ft8_tune_snapshot_t tune;
    ft8_tune_get_snapshot(&tune);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "running", tune.task_running);
    cJSON_AddBoolToObject(o, "active", tune.active);
    cJSON_AddStringToObject(o, "phase", tune.phase);
    cJSON_AddNumberToObject(o, "tune_power_w", FT8_TUNE_POWER_W);
    cJSON_AddNumberToObject(o, "hard_max_ms", FT8_TUNE_MAX_MS);
    cJSON_AddNumberToObject(o, "lease_ms", FT8_TUNE_LEASE_MS);
    cJSON_AddNumberToObject(o, "started_ms", (double)tune.started_ms);
    cJSON_AddNumberToObject(o, "deadline_ms", (double)tune.deadline_ms);
    cJSON_AddNumberToObject(o, "original_power_w", tune.original_power_w);
    cJSON_AddNumberToObject(o, "restored_power_w", tune.restored_power_w);
    cJSON_AddNumberToObject(o, "alc_raw", tune.alc_raw);
    cJSON_AddNumberToObject(o, "po_raw", tune.po_raw);
    cJSON_AddNumberToObject(o, "level_dbfs", tune.level_dbfs);
    cJSON_AddStringToObject(o, "tone_clock", "FIFO_48K_1PKT");
    cJSON_AddNumberToObject(o, "frequency_hz", tune.frequency_hz);
    cJSON_AddBoolToObject(o, "metering_enabled", tune.metering_enabled);
    cJSON_AddBoolToObject(o, "usb_quiet", tune.usb_quiet);
    ft710_cat_status_t quiet_cat;
    ft710_cat_get_status(&quiet_cat);
    cJSON_AddBoolToObject(o, "cat_quiet_active", quiet_cat.tx_quiet_active);
    cJSON_AddNumberToObject(o, "meter_reads", tune.meter_reads);
    cJSON_AddNumberToObject(o, "meter_errors", tune.meter_errors);
    cJSON_AddStringToObject(o, "last_reason", tune.last_reason);
    return o;
}

static esp_err_t ft8_tune_start_handler(httpd_req_t *req)
{
    bool requested_metering = true;
    bool requested_usb_quiet = false;
    uint32_t requested_frequency_hz = 1500U;
    float requested_level_dbfs = -32.0f;
    if (req->content_len > 0) {
        cJSON *j = read_json(req);
        if (!j) return send_error(req, "422 Unprocessable Entity", "invalid JSON");
        cJSON *metering = cJSON_GetObjectItemCaseSensitive(j, "metering");
        cJSON *frequency = cJSON_GetObjectItemCaseSensitive(j, "frequency_hz");
        cJSON *usb_quiet_item = cJSON_GetObjectItemCaseSensitive(j, "usb_quiet");
        cJSON *level = cJSON_GetObjectItemCaseSensitive(j, "dbfs");
        if (cJSON_IsBool(metering)) requested_metering = cJSON_IsTrue(metering);
        if (cJSON_IsBool(usb_quiet_item)) requested_usb_quiet = cJSON_IsTrue(usb_quiet_item);
        if (cJSON_IsNumber(frequency)) requested_frequency_hz = (uint32_t)frequency->valuedouble;
        if (cJSON_IsNumber(level)) requested_level_dbfs = (float)level->valuedouble;
        cJSON_Delete(j);
        if (requested_frequency_hz != 1000U && requested_frequency_hz != 1500U) {
            return send_error(req, "422 Unprocessable Entity", "frequency_hz must be 1000 or 1500");
        }
        if (!isfinite(requested_level_dbfs) || requested_level_dbfs < -40.0f || requested_level_dbfs > -1.0f) {
            return send_error(req, "422 Unprocessable Entity", "dbfs must be -40..-1");
        }
    }
    if (ft8_tx_is_running()) return send_error(req, "409 Conflict", "FT8 automatic TX is armed/running");
    if (digital_tx_is_running()) return send_error(req, "409 Conflict", "staged digital TX is running");
    ft8_tune_snapshot_t tune;
    ft8_tune_get_snapshot(&tune);
    if (tune.task_running) return send_error(req, "409 Conflict", "FT8 ALC tune is already running");

    ft710_cat_status_t cat;
    ft710_cat_get_status(&cat);
    ft710_audio_tx_status_t tx;
    ft710_audio_tx_get_status(&tx);
    portENTER_CRITICAL(&s_ws_mux);
    const int fd = s_audio_ws_fd;
    portEXIT_CRITICAL(&s_ws_mux);
    if (fd < 0) return send_error(req, "409 Conflict", "FT8 audio WebSocket is not connected");
    if (!tx.streaming) return send_error(req, "409 Conflict", "TX audio is not ready");
    if (!cat.power_known || !cat.radio_power_on) return send_error(req, "409 Conflict", "radio must be ON");
    if (cat.ptt_active || !strcasecmp(cat.tx_state, "TX")) return send_error(req, "409 Conflict", "radio must be in RX before ALC tune");
    if (cat.hi_swr) return send_error(req, "409 Conflict", "FT-710 reports HI-SWR; TX Tune refused");

    /* Tune owns the backend oscillator; discard any staged QSO
     * waveform so digital audio modes cannot share stale data. */
    ft8_waveform_clear();

    /* Neutralize any main-page jog that may have been left non-zero before the tune lock engaged. */
    portENTER_CRITICAL(&s_jog_mux);
    s_jog_position = 0.0f;
    s_jog_speed_hz_s = 0.0f;
    s_jog_frequency = 0;
    portEXIT_CRITICAL(&s_jog_mux);

    portENTER_CRITICAL(&s_ft8_tune_mux);
    s_ft8_tune_task_running = true;
    s_ft8_tune_active = false;
    s_ft8_tune_stop_requested = false;
    s_ft8_tune_started_ms = 0;
    s_ft8_tune_deadline_ms = monotonic_ms() + FT8_TUNE_LEASE_MS;
    s_ft8_tune_original_power_w = cat.tx_power_w;
    s_ft8_tune_restored_power_w = 0;
    s_ft8_tune_alc_raw = 0;
    s_ft8_tune_po_raw = 0;
    s_ft8_tune_level_dbfs = requested_level_dbfs;
    s_ft8_tune_meter_reads = 0;
    s_ft8_tune_meter_errors = 0;
    s_ft8_tune_metering_enabled = requested_metering;
    s_ft8_tune_usb_quiet = requested_usb_quiet;
    s_ft8_tune_frequency_hz = requested_frequency_hz;
    snprintf(s_ft8_tune_phase, sizeof(s_ft8_tune_phase), "%s", "STARTING");
    s_ft8_tune_last_reason[0] = '\0';
    portEXIT_CRITICAL(&s_ft8_tune_mux);

    if (xTaskCreate(ft8_tune_task, "ft8_alc_tune", 4096, (void *)(intptr_t)fd, 3, NULL) != pdPASS) {
        portENTER_CRITICAL(&s_ft8_tune_mux);
        s_ft8_tune_task_running = false;
        snprintf(s_ft8_tune_phase, sizeof(s_ft8_tune_phase), "%s", "IDLE");
        snprintf(s_ft8_tune_last_reason, sizeof(s_ft8_tune_last_reason), "%s", "tune task allocation failed");
        portEXIT_CRITICAL(&s_ft8_tune_mux);
        return send_error(req, "500 Internal Server Error", "could not start FT8 ALC tune task");
    }

    cJSON *o = cJSON_CreateObject();
    cJSON_AddTrueToObject(o, "ok");
    cJSON_AddItemToObject(o, "tune", ft8_tune_status_json());
    return send_json(req, o);
}

static esp_err_t ft8_tune_level_handler(httpd_req_t *req)
{
    ft8_tune_snapshot_t tune;
    ft8_tune_get_snapshot(&tune);
    if (!tune.task_running || !tune.active) return send_error(req, "409 Conflict", "FT8 ALC tune is not active");
    cJSON *j = read_json(req);
    if (!j) return send_error(req, "422 Unprocessable Entity", "invalid JSON");
    cJSON *lv = cJSON_GetObjectItemCaseSensitive(j, "dbfs");
    if (!cJSON_IsNumber(lv)) { cJSON_Delete(j); return send_error(req, "422 Unprocessable Entity", "dbfs is required"); }
    float level = (float)lv->valuedouble;
    cJSON_Delete(j);
    if (!isfinite(level) || level < -40.0f || level > -1.0f) return send_error(req, "422 Unprocessable Entity", "dbfs must be -40..-1");
    ft710_audio_tx_tone_set_level(level);
    portENTER_CRITICAL(&s_ft8_tune_mux);
    s_ft8_tune_level_dbfs = level;
    portEXIT_CRITICAL(&s_ft8_tune_mux);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddTrueToObject(o, "ok");
    cJSON_AddNumberToObject(o, "dbfs", level);
    cJSON_AddStringToObject(o, "tone_clock", "FIFO_48K_1PKT");
    cJSON_AddNumberToObject(o, "frequency_hz", tune.frequency_hz);
    return send_json(req, o);
}

static esp_err_t ft8_tune_keepalive_handler(httpd_req_t *req)
{
    ft8_tune_snapshot_t tune;
    ft8_tune_get_snapshot(&tune);
    if (!tune.task_running) return send_error(req, "409 Conflict", "FT8 ALC tune is not running");
    ft8_tune_keepalive();
    cJSON *o = cJSON_CreateObject();
    cJSON_AddTrueToObject(o, "ok");
    cJSON_AddItemToObject(o, "tune", ft8_tune_status_json());
    return send_json(req, o);
}

static esp_err_t ft8_tune_stop_handler(httpd_req_t *req)
{
    ft8_tune_request_stop("operator stop");
    (void)ft710_cat_force_ptt_off(API_TIMEOUT_MS);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddTrueToObject(o, "ok");
    cJSON_AddItemToObject(o, "tune", ft8_tune_status_json());
    return send_json(req, o);
}

static void audio_ws_close(int fd)
{
    bool mine = false;
    portENTER_CRITICAL(&s_ws_mux);
    if (s_audio_ws_fd == fd) {
        s_audio_ws_fd = -1;
        s_audio_tx_source = AUDIO_TX_SOURCE_NONE;
        s_audio_ws_disconnects++;
        mine = true;
    }
    portEXIT_CRITICAL(&s_ws_mux);
    if (mine) {
        ft8_tune_request_stop("audio WebSocket disconnected");
        ft8_tx_request_stop("audio WebSocket disconnected");
        digital_tx_request_stop("audio WebSocket disconnected");
        (void)manual_audio_tx_set(false);
        ft710_audio_tx_input_reset();
        ft710_audio_pcm_stream_close();
        if (!ft8_tx_is_running()) ft8_waveform_clear();
        if (!digital_tx_is_running()) digital_waveform_clear();
        ESP_LOGI(TAG, "audio WS closed fd=%d; TX source NONE; PTT forced RX", fd);
    }
}
static void audio_ws_sender(void*arg)
{
    int fd=(int)(intptr_t)arg;
    vTaskDelay(pdMS_TO_TICKS(120));
    if (!audio_ws_is_active(fd)) { vTaskDelete(NULL); return; }
    httpd_handle_t server=s_server;
    httpd_ws_frame_t f={0};
    const char ready[]="{\"type\":\"ready\",\"sample_rate\":48000,\"tx_sample_rate\":48000,\"channels\":1,\"bits_per_sample\":16,\"ptt_mode\":\"latching\",\"ptt_watchdog_ms\":1500,\"tx_source\":\"NONE\",\"tx_source_model\":\"NONE|MICROPHONE|FT8|DIGITAL\",\"ft8_tx_audio\":true,\"ft8_tune\":true,\"ft8_auto_ptt\":true,\"digital_staged_tx\":true}";
    f.type=HTTPD_WS_TYPE_TEXT;f.payload=(uint8_t*)ready;f.len=strlen(ready);
    if (httpd_ws_send_data(server,fd,&f) != ESP_OK) { audio_ws_close(fd); vTaskDelete(NULL); return; }
    (void)httpd_sess_update_lru_counter(server, fd);
    uint8_t*buf=malloc(AUDIO_WS_RX_CHUNK);
    if(!buf){audio_ws_close(fd);vTaskDelete(NULL);return;}
    uint32_t audio_missing_ms = 0;
    while(audio_ws_is_active(fd) && httpd_ws_get_fd_info(server,fd)==HTTPD_WS_CLIENT_WEBSOCKET){
        ft710_audio_status_t rx_status;
        ft710_audio_get_status(&rx_status);
        if (!rx_status.streaming || !rx_status.device_open) {
            /* Digital TX intentionally releases UAC RX for the whole RF
             * interval.  Keep the unified WS alive instead of treating this
             * deliberate half-duplex period as a radio/audio disconnect. */
            if (ft710_audio_tx_half_duplex_requested()) {
                audio_missing_ms = 0;
                vTaskDelay(pdMS_TO_TICKS(100));
                continue;
            }
            audio_missing_ms += 100;
            if (audio_missing_ms >= 4500) break;
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        audio_missing_ms = 0;
        size_t n=ft710_audio_pcm_stream_read(buf,AUDIO_WS_RX_CHUNK,100);
        if (!audio_ws_is_active(fd)) break;
        if(n){
            memset(&f,0,sizeof(f));f.type=HTTPD_WS_TYPE_BINARY;f.payload=buf;f.len=n;
            esp_err_t e=httpd_ws_send_data(server,fd,&f);
            if(e!=ESP_OK)break;
            (void)httpd_sess_update_lru_counter(server, fd);
            portENTER_CRITICAL(&s_ws_mux);s_audio_ws_rx_bytes+=n;portEXIT_CRITICAL(&s_ws_mux);
        }
    }
    free(buf);audio_ws_close(fd);vTaskDelete(NULL);
}
static esp_err_t ws_send_text_req(httpd_req_t *req, const char *text)
{
    httpd_ws_frame_t f = {
        .type = HTTPD_WS_TYPE_TEXT,
        .payload = (uint8_t *)text,
        .len = strlen(text),
    };
    /* IMPORTANT: this function is called from the HTTPD URI handler itself.
     * httpd_ws_send_data() queues work to the HTTPD task and waits for it;
     * calling it here would deadlock the HTTPD task waiting on itself.
     * httpd_ws_send_frame() is the in-handler API and sends immediately.
     */
    esp_err_t err = httpd_ws_send_frame(req, &f);
    if (err == ESP_OK) {
        (void)httpd_sess_update_lru_counter(req->handle, httpd_req_to_sockfd(req));
    }
    return err;
}

/*
 * ESP-IDF >= 6.0.1 no longer calls a WebSocket URI handler as part of
 * the HTTP Upgrade handshake. Connection-time initialization therefore
 * belongs in ws_post_handshake_cb, not in an HTTP_GET branch of the frame
 * handler. See ESP-IDF 6.0 migration guide.
 */
static esp_err_t audio_ws_post_handshake(httpd_req_t *req)
{
    int fd = httpd_req_to_sockfd(req);

    portENTER_CRITICAL(&s_ws_mux);
    int old = s_audio_ws_fd;
    portEXIT_CRITICAL(&s_ws_mux);
    if (old >= 0 && old != fd) {
        ESP_LOGI(TAG, "audio WS takeover: closing stale fd=%d for new fd=%d", old, fd);
        audio_ws_close(old);
        (void)httpd_sess_trigger_close(s_server, old);
    }

    if (!ft710_audio_pcm_stream_open()) {
        ft710_audio_pcm_stream_close();
        if (!ft710_audio_pcm_stream_open()) {
            ESP_LOGW(TAG, "audio WS post-handshake fd=%d: RX PCM stream is not ready", fd);
            return ESP_FAIL;
        }
    }

    ft710_audio_tx_input_reset();
    portENTER_CRITICAL(&s_ws_mux);
    s_audio_ws_fd = fd;
    s_audio_tx_source = AUDIO_TX_SOURCE_NONE;
    s_audio_ws_sessions++;
    portEXIT_CRITICAL(&s_ws_mux);
    (void)httpd_sess_update_lru_counter(s_server, fd);

    BaseType_t ok = xTaskCreate(audio_ws_sender, "audio_ws_tx", AUDIO_WS_TASK_STACK,
                                (void *)(intptr_t)fd, AUDIO_WS_TASK_PRIO, NULL);
    if (ok != pdPASS) {
        ESP_LOGE(TAG, "audio WS post-handshake fd=%d: sender task allocation failed", fd);
        audio_ws_close(fd);
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "unified audio WS connected fd=%d via post-handshake callback; latching PTT + 1.5s watchdog", fd);
    return ESP_OK;
}

static esp_err_t audio_ws_handler(httpd_req_t *req)
{
    const int fd = httpd_req_to_sockfd(req);
    httpd_ws_frame_t frame = {0};
    esp_err_t err = httpd_ws_recv_frame(req, &frame, 0);
    if (err != ESP_OK) {
        audio_ws_close(fd);
        return err;
    }
    if (frame.type == HTTPD_WS_TYPE_CLOSE) {
        audio_ws_close(fd);
        return ESP_FAIL;
    }
    if (frame.len > 16384) {
        ESP_LOGW(TAG, "audio WS fd=%d oversized frame: %u", fd, (unsigned)frame.len);
        audio_ws_close(fd);
        return ESP_FAIL;
    }

    uint8_t *payload = malloc(frame.len + 1);
    if (!payload) return ESP_ERR_NO_MEM;
    frame.payload = payload;
    err = httpd_ws_recv_frame(req, &frame, frame.len);
    if (err != ESP_OK) {
        free(payload);
        audio_ws_close(fd);
        return err;
    }
    payload[frame.len] = 0;

    if (frame.type == HTTPD_WS_TYPE_BINARY) {
        ft8_wave_snapshot_t staged;
        ft8_waveform_get_snapshot(&staged);
        if (staged.uploading && staged.owner_fd == fd) {
            bool ready_now = false;
            const bool accepted = ft8_waveform_append(fd, payload, frame.len, &ready_now);
            if (!accepted) {
                free(payload);
                (void)ws_send_text_req(req, "{\"type\":\"ft8_waveform_error\",\"error\":\"waveform upload rejected\"}");
                return ESP_OK;
            }
            if (ready_now) {
                ft8_wave_snapshot_t done;
                ft8_waveform_get_snapshot(&done);
                char reply[192];
                snprintf(reply, sizeof(reply), "{\"type\":\"ft8_waveform_ready\",\"id\":%" PRIu32 ",\"bytes\":%u,\"sample_rate_hz\":%" PRIu32 "}", done.id, (unsigned)done.received_bytes, done.sample_rate_hz);
                (void)ws_send_text_req(req, reply);
                ESP_LOGI(TAG, "FT8 waveform staged in PSRAM: id=%" PRIu32 " rate=%" PRIu32 "Hz bytes=%u upload_ms=%" PRIu64, done.id, done.sample_rate_hz, (unsigned)done.received_bytes, monotonic_ms() - done.upload_started_ms);
            }
            free(payload);
            return ESP_OK;
        }
        digital_wave_snapshot_t digital_staged;
        digital_waveform_get_snapshot(&digital_staged);
        if (digital_staged.uploading && digital_staged.owner_fd == fd) {
            bool ready_now = false;
            const bool accepted = digital_waveform_append(fd, payload, frame.len, &ready_now);
            if (!accepted) {
                free(payload);
                (void)ws_send_text_req(req, "{\"type\":\"digital_waveform_error\",\"error\":\"waveform upload rejected\"}");
                return ESP_OK;
            }
            if (ready_now) {
                digital_wave_snapshot_t done;
                digital_waveform_get_snapshot(&done);
                char reply[208];
                snprintf(reply, sizeof(reply), "{\"type\":\"digital_waveform_ready\",\"id\":%" PRIu32 ",\"bytes\":%u,\"sample_rate_hz\":%" PRIu32 "}", done.id, (unsigned)done.received_bytes, done.sample_rate_hz);
                (void)ws_send_text_req(req, reply);
                ESP_LOGI(TAG, "Digital waveform staged in PSRAM: id=%" PRIu32 " rate=%" PRIu32 "Hz bytes=%u upload_ms=%" PRIu64, done.id, done.sample_rate_hz, (unsigned)done.received_bytes, monotonic_ms() - done.upload_started_ms);
            }
            free(payload);
            return ESP_OK;
        }
        ft710_cat_status_t st;
        ft710_cat_get_status(&st);
        const audio_tx_source_t source = audio_ws_get_tx_source();
        ft8_tune_snapshot_t tune;
        ft8_tune_get_snapshot(&tune);
        ft8_tx_snapshot_t auto_tx;
        ft8_tx_get_snapshot(&auto_tx);
        const bool radio_tx = st.ptt_active || !strcasecmp(st.tx_state, "TX");
        /*
         * ptt_active is updated synchronously when our CAT TX1 command is
         * acknowledged. tx_state is refreshed asynchronously by the regular
         * RI0 poll and may transiently still say RX immediately after keying.
         * Do not reject the first PCM chunks during that harmless transition.
         */
        const bool tune_tx = tune.task_running && tune.active && st.power_known && st.radio_power_on && st.ptt_active;
        bool allow = false;
        if (frame.len > 0 && (frame.len % 2U) == 0) {
            if (source == AUDIO_TX_SOURCE_MICROPHONE) {
                allow = st.ptt_active && !tune.task_running && !auto_tx.task_running;
            } else if (source == AUDIO_TX_SOURCE_FT8) {
                /*
                 * During a bounded Tune/QSO session, accept PCM only after that
                 * session owns PTT.  This prevents a buggy browser from
                 * pre-filling the UAC TX queue while an automatic slot is merely
                 * ARMED.  RX-only waveform-lab audio remains allowed only when no
                 * bounded RF operation exists.
                 */
                if (tune.task_running) allow = tune_tx;
                else if (auto_tx.task_running) allow = auto_tx.streamed_audio && auto_tx.active && st.ptt_active;
                else allow = st.power_known && st.radio_power_on && !radio_tx;
            }
        }
        if (allow) {
            /* Browser microphone frames arrive at 48 kHz and use the stateful
             * 48 kHz TX FIFO. FT8 PCM is rendered directly at the
             * UAC rate and must never be resampled a second time. */
            const size_t accepted = source == AUDIO_TX_SOURCE_FT8
                ? ft710_audio_tx_push_mono_s16_lossless(payload, frame.len)
                : ft710_audio_tx_push_mono_s16(payload, frame.len);
            portENTER_CRITICAL(&s_ws_mux);
            s_audio_ws_tx_bytes += accepted;
            if (source == AUDIO_TX_SOURCE_FT8) s_audio_ws_tx_ft8_bytes += accepted;
            else if (source == AUDIO_TX_SOURCE_MICROPHONE) s_audio_ws_tx_microphone_bytes += accepted;
            s_audio_ws_tx_rejected_bytes += frame.len - accepted;
            portEXIT_CRITICAL(&s_ws_mux);
            if (source == AUDIO_TX_SOURCE_FT8 && auto_tx.task_running && auto_tx.streamed_audio && accepted != frame.len) {
                ft8_tx_request_stop("FT8 WebAudio PCM backlog/drop");
            }
        } else {
            portENTER_CRITICAL(&s_ws_mux);
            s_audio_ws_tx_rejected_bytes += frame.len;
            portEXIT_CRITICAL(&s_ws_mux);
            if (source == AUDIO_TX_SOURCE_FT8) {
                if (tune.task_running) {
                    ft8_tune_request_stop("FT8 PCM rejected during ALC tune");
                } else if (auto_tx.task_running) {
                    ft8_tx_request_stop("FT8 PCM rejected during automatic QSO TX");
                } else if (radio_tx || (st.power_known && !st.radio_power_on)) {
                    (void)audio_ws_set_tx_source(fd, AUDIO_TX_SOURCE_NONE);
                    (void)ws_send_text_req(req, "{\"type\":\"tx_abort\",\"reason\":\"radio left safe RX state during FT8 waveform test\"}");
                }
            }
        }
    } else if (frame.type == HTTPD_WS_TYPE_TEXT) {
        cJSON *json = cJSON_Parse((char *)payload);
        if (json) {
            const char *type = json_string(json, "type", "");
            if (!strcmp(type, "ft8_waveform_begin")) {
                const uint32_t wave_id = (uint32_t)json_int(json, "id", 0);
                const int requested_bytes = json_int(json, "bytes", 0);
                const uint32_t sample_rate_hz = (uint32_t)json_int(json, "sample_rate", FT8_TX_STAGE_RATE_HZ);
                char wave_reason[128] = {0};
                if (requested_bytes <= 0 || !ft8_waveform_begin_upload(fd, wave_id, (size_t)requested_bytes, sample_rate_hz, wave_reason, sizeof(wave_reason))) {
                    char reply[240];
                    snprintf(reply, sizeof(reply), "{\"type\":\"ft8_waveform_begin\",\"ok\":false,\"id\":%" PRIu32 ",\"error\":\"%.140s\"}", wave_id, wave_reason[0] ? wave_reason : "waveform upload rejected");
                    (void)ws_send_text_req(req, reply);
                } else {
                    char reply[180];
                    snprintf(reply, sizeof(reply), "{\"type\":\"ft8_waveform_begin\",\"ok\":true,\"id\":%" PRIu32 ",\"bytes\":%d,\"sample_rate_hz\":%" PRIu32 "}", wave_id, requested_bytes, sample_rate_hz);
                    (void)ws_send_text_req(req, reply);
                }
            } else if (!strcmp(type, "ft8_waveform_clear")) {
                if (!ft8_rf_operation_is_running()) ft8_waveform_clear();
                (void)ws_send_text_req(req, "{\"type\":\"ft8_waveform_clear\",\"ok\":true}");
            } else if (!strcmp(type, "digital_waveform_begin")) {
                const uint32_t wave_id = (uint32_t)json_int(json, "id", 0);
                const int requested_bytes = json_int(json, "bytes", 0);
                const uint32_t sample_rate_hz = (uint32_t)json_int(json, "sample_rate", DIGITAL_TX_STAGE_RATE_HZ);
                char wave_reason[128] = {0};
                if (requested_bytes <= 0 || !digital_waveform_begin_upload(fd, wave_id, (size_t)requested_bytes, sample_rate_hz, wave_reason, sizeof(wave_reason))) {
                    char reply[240];
                    snprintf(reply, sizeof(reply), "{\"type\":\"digital_waveform_begin\",\"ok\":false,\"id\":%" PRIu32 ",\"error\":\"%.140s\"}", wave_id, wave_reason[0] ? wave_reason : "waveform upload rejected");
                    (void)ws_send_text_req(req, reply);
                } else {
                    char reply[192];
                    snprintf(reply, sizeof(reply), "{\"type\":\"digital_waveform_begin\",\"ok\":true,\"id\":%" PRIu32 ",\"bytes\":%d,\"sample_rate_hz\":%" PRIu32 "}", wave_id, requested_bytes, sample_rate_hz);
                    (void)ws_send_text_req(req, reply);
                }
            } else if (!strcmp(type, "digital_waveform_clear")) {
                if (!digital_tx_is_running()) digital_waveform_clear();
                (void)ws_send_text_req(req, "{\"type\":\"digital_waveform_clear\",\"ok\":true}");
            } else if (!strcmp(type, "digital_tx_play")) {
                const uint32_t wave_id = (uint32_t)json_int(json, "id", 0);
                const uint32_t ptt_delay_ms = (uint32_t)json_int(json, "ptt_delay_ms", 100);
                const uint32_t tail_ms = (uint32_t)json_int(json, "tail_ms", 180);
                const uint32_t lease_ms = (uint32_t)json_int(json, "lease_ms", 0);
                const char *label = json_string(json, "label", "");
                char play_reason[128] = {0};
                if (!digital_tx_start(fd, wave_id, ptt_delay_ms, tail_ms, lease_ms, label, play_reason, sizeof(play_reason))) {
                    char reply[240];
                    snprintf(reply, sizeof(reply), "{\"type\":\"digital_tx_play\",\"ok\":false,\"id\":%" PRIu32 ",\"error\":\"%.140s\"}", wave_id, play_reason[0] ? play_reason : "digital TX rejected");
                    (void)ws_send_text_req(req, reply);
                } else {
                    char reply[160];
                    snprintf(reply, sizeof(reply), "{\"type\":\"digital_tx_play\",\"ok\":true,\"id\":%" PRIu32 "}", wave_id);
                    (void)ws_send_text_req(req, reply);
                }
            } else if (!strcmp(type, "digital_tx_stop")) {
                digital_tx_request_stop("operator stop");
                (void)ws_send_text_req(req, "{\"type\":\"digital_tx_stop\",\"ok\":true}");
            } else if (!strcmp(type, "tx_source")) {
                const char *requested = json_string(json, "source", "NONE");
                ft710_cat_status_t cat;
                ft710_cat_get_status(&cat);
                ft710_audio_tx_status_t tx;
                ft710_audio_tx_get_status(&tx);
                if (!strcasecmp(requested, "NONE")) {
                    (void)audio_ws_set_tx_source(fd, AUDIO_TX_SOURCE_NONE);
                    (void)ws_send_text_req(req, "{\"type\":\"tx_source\",\"source\":\"NONE\",\"ok\":true}");
                } else if (!strcasecmp(requested, "FT8")) {
                    if (!tx.streaming) {
                        (void)ws_send_text_req(req, "{\"type\":\"tx_source\",\"source\":\"NONE\",\"ok\":false,\"error\":\"TX audio is not ready\"}");
                    } else if (!cat.power_known || !cat.radio_power_on) {
                        (void)ws_send_text_req(req, "{\"type\":\"tx_source\",\"source\":\"NONE\",\"ok\":false,\"error\":\"radio must be ON for FT8 TX audio/tune\"}");
                    } else if (cat.ptt_active || !strcasecmp(cat.tx_state, "TX")) {
                        (void)ws_send_text_req(req, "{\"type\":\"tx_source\",\"source\":\"NONE\",\"ok\":false,\"error\":\"radio must be in RX before FT8 TX audio/tune\"}");
                    } else {
                        (void)audio_ws_set_tx_source(fd, AUDIO_TX_SOURCE_FT8);
                        (void)ws_send_text_req(req, "{\"type\":\"tx_source\",\"source\":\"FT8\",\"ok\":true,\"auto_ptt_available\":true}");
                    }
                } else if (!strcasecmp(requested, "MICROPHONE")) {
                    if (ft8_rf_operation_is_running()) {
                        (void)ws_send_text_req(req, "{\"type\":\"tx_source\",\"source\":\"NONE\",\"ok\":false,\"error\":\"microphone source is locked during FT8 TX/Tune\"}");
                    } else if (digital_tx_is_running()) {
                        (void)ws_send_text_req(req, "{\"type\":\"tx_source\",\"source\":\"NONE\",\"ok\":false,\"error\":\"microphone source is locked during staged digital TX\"}");
                    } else {
                        (void)audio_ws_set_tx_source(fd, AUDIO_TX_SOURCE_MICROPHONE);
                        (void)ws_send_text_req(req, "{\"type\":\"tx_source\",\"source\":\"MICROPHONE\",\"ok\":true}");
                    }
                } else if (!strcasecmp(requested, "DIGITAL")) {
                    if (!tx.streaming) {
                        (void)ws_send_text_req(req, "{\"type\":\"tx_source\",\"source\":\"NONE\",\"ok\":false,\"error\":\"TX audio is not ready\"}");
                    } else if (!cat.power_known || !cat.radio_power_on) {
                        (void)ws_send_text_req(req, "{\"type\":\"tx_source\",\"source\":\"NONE\",\"ok\":false,\"error\":\"radio must be ON for staged digital TX\"}");
                    } else if (cat.ptt_active || !strcasecmp(cat.tx_state, "TX")) {
                        (void)ws_send_text_req(req, "{\"type\":\"tx_source\",\"source\":\"NONE\",\"ok\":false,\"error\":\"radio must be in RX before staged digital TX\"}");
                    } else if (ft8_rf_operation_is_running() || digital_tx_is_running()) {
                        (void)ws_send_text_req(req, "{\"type\":\"tx_source\",\"source\":\"NONE\",\"ok\":false,\"error\":\"another RF TX is already running\"}");
                    } else {
                        (void)audio_ws_set_tx_source(fd, AUDIO_TX_SOURCE_DIGITAL);
                        (void)ws_send_text_req(req, "{\"type\":\"tx_source\",\"source\":\"DIGITAL\",\"ok\":true,\"staged\":true}");
                    }
                } else {
                    (void)ws_send_text_req(req, "{\"type\":\"tx_source\",\"source\":\"NONE\",\"ok\":false,\"error\":\"invalid TX source\"}");
                }
            } else if (!strcmp(type, "timing_probe")) {
                bool clock_valid = false;
                const uint64_t now_ms = unix_time_ms(&clock_valid);
                const double client_unix_ms = cJSON_IsNumber(cJSON_GetObjectItemCaseSensitive(json, "client_unix_ms"))
                    ? cJSON_GetObjectItemCaseSensitive(json, "client_unix_ms")->valuedouble : 0.0;
                const double client_perf_ms = cJSON_IsNumber(cJSON_GetObjectItemCaseSensitive(json, "client_perf_ms"))
                    ? cJSON_GetObjectItemCaseSensitive(json, "client_perf_ms")->valuedouble : 0.0;
                char reply[256];
                if (clock_valid) {
                    snprintf(reply, sizeof(reply),
                             "{\"type\":\"timing_probe\",\"client_unix_ms\":%.3f,\"client_perf_ms\":%.3f,\"server_unix_ms\":%" PRIu64 ",\"server_monotonic_ms\":%" PRIu64 ",\"clock_valid\":true}",
                             client_unix_ms, client_perf_ms, now_ms, (uint64_t)(esp_timer_get_time() / 1000ULL));
                } else {
                    snprintf(reply, sizeof(reply),
                             "{\"type\":\"timing_probe\",\"client_unix_ms\":%.3f,\"client_perf_ms\":%.3f,\"server_unix_ms\":null,\"server_monotonic_ms\":%" PRIu64 ",\"clock_valid\":false}",
                             client_unix_ms, client_perf_ms, (uint64_t)(esp_timer_get_time() / 1000ULL));
                }
                (void)ws_send_text_req(req, reply);
            } else if (!strcmp(type, "ft8_tune_keepalive")) {
                ft8_tune_keepalive();
            } else if (!strcmp(type, "ft8_tx_keepalive")) {
                ft8_tx_keepalive();
            } else if (!strcmp(type, "ptt_keepalive")) {
                ft710_cat_ptt_keepalive();
            } else if (!strcmp(type, "ptt")) {
                bool present = false;
                const bool enabled = json_bool(json, "enabled", false, &present);
                if (present) {
                    if (enabled) {
                        ft710_audio_tx_status_t tx;
                        ft710_audio_tx_get_status(&tx);
                        if (audio_ws_get_tx_source() == AUDIO_TX_SOURCE_FT8) {
                            (void)ws_send_text_req(req, "{\"type\":\"ptt\",\"enabled\":false,\"error\":\"FT8 PTT is controlled only by the bounded Tune/automatic FT8 TX backend\"}");
                        } else if (audio_ws_get_tx_source() == AUDIO_TX_SOURCE_DIGITAL || digital_tx_is_running()) {
                            (void)ws_send_text_req(req, "{\"type\":\"ptt\",\"enabled\":false,\"error\":\"staged digital TX owns PTT\"}");
                        } else if (!tx.streaming) {
                            (void)ws_send_text_req(req, "{\"type\":\"ptt\",\"enabled\":false,\"error\":\"TX audio is not ready\"}");
                        } else {
                            (void)audio_ws_set_tx_source(fd, AUDIO_TX_SOURCE_MICROPHONE);
                            err = manual_audio_tx_set(true);
                            if (err == ESP_OK) {
                                ESP_LOGI(TAG, "audio WS fd=%d PTT ON acknowledged; watchdog armed; TX isolation active", fd);
                                (void)ws_send_text_req(req, "{\"type\":\"ptt\",\"enabled\":true}");
                            } else {
                                (void)audio_ws_set_tx_source(fd, AUDIO_TX_SOURCE_NONE);
                                ESP_LOGW(TAG, "audio WS fd=%d PTT ON CAT failed: %s", fd, esp_err_to_name(err));
                                (void)ws_send_text_req(req, "{\"type\":\"ptt\",\"enabled\":false,\"error\":\"PTT CAT failed\"}");
                            }
                        }
                    } else {
                        if (ft8_tx_is_running()) ft8_tx_request_stop("manual PTT OFF / operator halt");
                        if (digital_tx_is_running()) digital_tx_request_stop("manual PTT OFF / operator halt");
                        err = manual_audio_tx_set(false);
                        (void)audio_ws_set_tx_source(fd, AUDIO_TX_SOURCE_NONE);
                        if (err == ESP_OK) {
                            ESP_LOGI(TAG, "audio WS fd=%d PTT OFF acknowledged", fd);
                            (void)ws_send_text_req(req, "{\"type\":\"ptt\",\"enabled\":false}");
                        } else {
                            ESP_LOGW(TAG, "audio WS fd=%d PTT OFF CAT failed: %s", fd, esp_err_to_name(err));
                            (void)ws_send_text_req(req, "{\"type\":\"ptt\",\"enabled\":false,\"error\":\"PTT release CAT failed\"}");
                        }
                    }
                }
            }
            cJSON_Delete(json);
        }
    }

    free(payload);
    return ESP_OK;
}

static esp_err_t options_handler(httpd_req_t*req){cors(req);httpd_resp_set_status(req,"204 No Content");return httpd_resp_send(req,NULL,0);}

static esp_err_t register_uri(const char*uri,httpd_method_t method,esp_err_t(*handler)(httpd_req_t*),bool ws)
{
    httpd_uri_t u={.uri=uri,.method=method,.handler=handler,.user_ctx=NULL,.is_websocket=ws,.handle_ws_control_frames=ws};return httpd_register_uri_handler(s_server,&u);
}

esp_err_t control_api_register(httpd_handle_t server)
{
    if (!server) {
        return ESP_ERR_INVALID_ARG;
    }
    if (s_ft8_wave_mutex == NULL) {
        s_ft8_wave_mutex = xSemaphoreCreateMutex();
        if (s_ft8_wave_mutex == NULL) return ESP_ERR_NO_MEM;
    }
    if (s_digital_wave_mutex == NULL) {
        s_digital_wave_mutex = xSemaphoreCreateMutex();
        if (s_digital_wave_mutex == NULL) return ESP_ERR_NO_MEM;
    }
    if (s_manual_tx_mutex == NULL) {
        s_manual_tx_mutex = xSemaphoreCreateMutex();
        if (s_manual_tx_mutex == NULL) return ESP_ERR_NO_MEM;
    }
    if (s_qrz_fetch_page_mutex == NULL) {
        s_qrz_fetch_page_mutex = xSemaphoreCreateMutex();
        if (s_qrz_fetch_page_mutex == NULL) return ESP_ERR_NO_MEM;
    }
    if (!s_manual_tx_recovery_started) {
        if (xTaskCreate(manual_tx_recovery_task, "tx_iso_recover", 3072, NULL, 3, NULL) != pdPASS) return ESP_ERR_NO_MEM;
        s_manual_tx_recovery_started = true;
    }
    s_server = server;

    /* Register the long-lived unified audio WebSocket first. Audio is a core
     * service, so its registration must fail fast and remain independent of
     * later REST endpoint growth. */
    httpd_uri_t audio_ws_uri = {
        .uri = "/api/v1/audio/ws",
        .method = HTTP_GET,
        .handler = audio_ws_handler,
        .user_ctx = NULL,
        .is_websocket = true,
        .handle_ws_control_frames = true,
        .ws_post_handshake_cb = audio_ws_post_handshake,
    };
    esp_err_t audio_ws_err = httpd_register_uri_handler(s_server, &audio_ws_uri);
    if (audio_ws_err != ESP_OK) {
        ESP_LOGE(TAG, "AUDIO WS registration FAILED: %s", esp_err_to_name(audio_ws_err));
        return audio_ws_err;
    }
    ESP_LOGI(TAG, "AUDIO WS REGISTERED: /api/v1/audio/ws");
    (void)freerig_config_init();
    (void)freerig_memories_init();
    static bool jog_started=false;if(!jog_started){if(xTaskCreate(jog_task,"freq_jog",3072,NULL,3,NULL)==pdPASS)jog_started=true;}
#define R(uri,method,fn) do{esp_err_t e=register_uri((uri),(method),(fn),false);if(e!=ESP_OK)return e;}while(0)
    R("/api/v1/capabilities",HTTP_GET,capabilities_handler);R("/api/v1/state",HTTP_GET,state_handler);
    R("/api/v1/radio/power",HTTP_POST,power_handler);R("/api/v1/radio/ptt",HTTP_POST,ptt_handler);R("/api/v1/radio/ptt/keepalive",HTTP_POST,ptt_keepalive_handler);R("/api/v1/radio/frequency",HTTP_POST,frequency_handler);R("/api/v1/radio/mode",HTTP_POST,mode_handler);R("/api/v1/radio/tx-power",HTTP_POST,tx_power_handler);R("/api/v1/radio/rf-sql-vr",HTTP_POST,rf_sql_handler);R("/api/v1/radio/rf-gain",HTTP_POST,rf_gain_handler);R("/api/v1/radio/squelch",HTTP_POST,squelch_handler);R("/api/v1/radio/agc",HTTP_POST,agc_handler);R("/api/v1/radio/tuner",HTTP_POST,tuner_handler);R("/api/v1/radio/vfo/select",HTTP_POST,vfo_select_handler);R("/api/v1/radio/vfo/split",HTTP_POST,vfo_split_handler);R("/api/v1/radio/vfo/operation",HTTP_POST,vfo_operation_handler);R("/api/v1/radio/preamp",HTTP_POST,preamp_handler);R("/api/v1/radio/attenuator",HTTP_POST,attenuator_handler);R("/api/v1/radio/dnr",HTTP_POST,dnr_handler);R("/api/v1/radio/noise-blanker",HTTP_POST,nb_handler);R("/api/v1/radio/auto-notch",HTTP_POST,auto_notch_handler);R("/api/v1/radio/filter",HTTP_POST,filter_handler);R("/api/v1/radio/meter-display",HTTP_POST,meter_handler);R("/api/v1/radio/scope",HTTP_POST,scope_handler);R("/api/v1/radio/jog",HTTP_POST,jog_handler);R("/api/v1/cat",HTTP_POST,raw_cat_handler);
    R("/api/v1/memories",HTTP_GET,memories_list_handler);R("/api/v1/memories",HTTP_POST,memory_save_handler);R("/api/v1/memories/sync",HTTP_POST,memories_sync_handler);R("/api/v1/memories/*",HTTP_POST,memory_wild_handler);R("/api/v1/memories/*",HTTP_PUT,memory_wild_handler);
    R("/api/v1/ft8/status",HTTP_GET,ft8_status_handler);R("/api/v1/ft8/tx/arm",HTTP_POST,ft8_tx_arm_handler);R("/api/v1/ft8/tx/keepalive",HTTP_POST,ft8_tx_keepalive_handler);R("/api/v1/ft8/tx/stop",HTTP_POST,ft8_tx_stop_handler);R("/api/v1/ft8/tune/start",HTTP_POST,ft8_tune_start_handler);R("/api/v1/ft8/tune/level",HTTP_POST,ft8_tune_level_handler);R("/api/v1/ft8/tune/keepalive",HTTP_POST,ft8_tune_keepalive_handler);R("/api/v1/ft8/tune/stop",HTTP_POST,ft8_tune_stop_handler);R("/api/v1/cw/status",HTTP_GET,cw_status_handler);R("/api/v1/cw/send",HTTP_POST,cw_send_handler);R("/api/v1/cw/stop",HTTP_POST,cw_stop_handler);
    R("/api/v1/video/settings",HTTP_GET,video_settings_get);R("/api/v1/video/settings",HTTP_POST,video_settings_post);
    R("/api/v1/wireguard/status",HTTP_GET,wireguard_status_handler);R("/api/v1/wireguard/config",HTTP_POST,wireguard_config_handler);
    R("/api/v1/log/status",HTTP_GET,qrz_status_handler);R("/api/v1/log/config",HTTP_POST,qrz_config_handler);R("/api/v1/log/qso",HTTP_POST,qrz_log_handler);R("/api/v1/log/qso/status",HTTP_GET,qrz_log_status_handler);R("/api/v1/log/gridtracker/adif",HTTP_POST,log_gridtracker_adif_handler);
    R("/api/v1/qrz/status",HTTP_GET,qrz_status_handler);R("/api/v1/qrz/config",HTTP_POST,qrz_config_handler);R("/api/v1/qrz/log",HTTP_POST,qrz_log_handler);R("/api/v1/qrz/log/status",HTTP_GET,qrz_log_status_handler);R("/api/v1/qrz/fetch",HTTP_POST,qrz_fetch_handler);R("/api/v1/qrz/fetch/status",HTTP_GET,qrz_fetch_status_handler);R("/api/v1/qrz/fetch/page",HTTP_GET,qrz_fetch_page_handler);R("/api/v1/qrz/fetch/cancel",HTTP_POST,qrz_fetch_cancel_handler);
    R("/api/v1/cw/status",HTTP_OPTIONS,options_handler);
    R("/api/v1/radio/jog",HTTP_OPTIONS,options_handler);
    R("/*",HTTP_OPTIONS,options_handler);
#undef R
    ESP_LOGI(TAG,"FreeRig710 control API registered: CAT BULK IN halted during microphone, FT8, and staged digital RF TX");return ESP_OK;
}
