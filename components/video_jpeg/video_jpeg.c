#include "video_jpeg.h"

#include <inttypes.h>
#include <string.h>

#include "driver/jpeg_encode.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "video_capture.h"

static const char *TAG = "video_jpeg";

#define FREERIG_JPEG_WIDTH               800
#define FREERIG_JPEG_HEIGHT              480
#define FREERIG_JPEG_QUALITY            80
#define FREERIG_JPEG_FPS_LIMIT          20
#define FREERIG_JPEG_ENGINE_TIMEOUT_MS  100
#define FREERIG_JPEG_OUTPUT_REQUEST     (1536U * 1024U)

static jpeg_encoder_handle_t s_encoder;
static SemaphoreHandle_t s_encoder_lock;
static uint8_t *s_jpeg_buffer;
static size_t s_jpeg_capacity;
static bool s_stream_active;
static portMUX_TYPE s_status_lock = portMUX_INITIALIZER_UNLOCKED;

static video_jpeg_status_t s_status = {
    .width = FREERIG_JPEG_WIDTH,
    .height = FREERIG_JPEG_HEIGHT,
    .quality = FREERIG_JPEG_QUALITY,
    .fps_limit = FREERIG_JPEG_FPS_LIMIT,
    .last_error = ESP_ERR_INVALID_STATE,
};

static void status_load(video_jpeg_status_t *out)
{
    portENTER_CRITICAL(&s_status_lock);
    *out = s_status;
    portEXIT_CRITICAL(&s_status_lock);
}

static void status_store(const video_jpeg_status_t *in)
{
    portENTER_CRITICAL(&s_status_lock);
    s_status = *in;
    portEXIT_CRITICAL(&s_status_lock);
}

esp_err_t video_jpeg_init(void)
{
    video_jpeg_status_t status;
    status_load(&status);
    if (s_encoder != NULL) {
        return ESP_OK;
    }

    status.initialized = true;
    status.encoder_ready = false;
    status.psram_free_before = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    status.last_error = ESP_FAIL;
    status_store(&status);

    s_encoder_lock = xSemaphoreCreateMutex();
    if (s_encoder_lock == NULL) {
        status.last_error = ESP_ERR_NO_MEM;
        status_store(&status);
        return ESP_ERR_NO_MEM;
    }

    jpeg_encode_engine_cfg_t engine_cfg = {
        .intr_priority = 0,
        .timeout_ms = FREERIG_JPEG_ENGINE_TIMEOUT_MS,
    };
    esp_err_t err = jpeg_new_encoder_engine(&engine_cfg, &s_encoder);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "jpeg_new_encoder_engine failed: %s", esp_err_to_name(err));
        vSemaphoreDelete(s_encoder_lock);
        s_encoder_lock = NULL;
        status.last_error = err;
        status_store(&status);
        return err;
    }

    jpeg_encode_memory_alloc_cfg_t out_mem_cfg = {
        .buffer_direction = JPEG_ENC_ALLOC_OUTPUT_BUFFER,
    };
    s_jpeg_buffer = jpeg_alloc_encoder_mem(FREERIG_JPEG_OUTPUT_REQUEST,
                                            &out_mem_cfg,
                                            &s_jpeg_capacity);
    if (s_jpeg_buffer == NULL || s_jpeg_capacity == 0) {
        ESP_LOGE(TAG, "Failed to allocate JPEG output buffer in PSRAM");
        (void)jpeg_del_encoder_engine(s_encoder);
        s_encoder = NULL;
        vSemaphoreDelete(s_encoder_lock);
        s_encoder_lock = NULL;
        status.last_error = ESP_ERR_NO_MEM;
        status_store(&status);
        return ESP_ERR_NO_MEM;
    }

    status.encoder_ready = true;
    status.output_buffer_capacity = s_jpeg_capacity;
    status.psram_free_after = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    status.last_error = ESP_OK;
    status_store(&status);

    ESP_LOGI(TAG,
             "ESP32-P4 hardware JPEG encoder ready: %ux%u RGB888/BGR input -> YUV420 JPEG, quality=%u, output PSRAM=%zu bytes",
             FREERIG_JPEG_WIDTH, FREERIG_JPEG_HEIGHT, status.quality,
             s_jpeg_capacity);
    return ESP_OK;
}

esp_err_t video_jpeg_encode_latest(video_jpeg_frame_view_t *out_view, uint32_t wait_ms)
{
    if (out_view == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    memset(out_view, 0, sizeof(*out_view));
    if (s_encoder == NULL || s_encoder_lock == NULL || s_jpeg_buffer == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    TickType_t wait_ticks = pdMS_TO_TICKS(wait_ms);
    if (wait_ms > 0 && wait_ticks == 0) {
        wait_ticks = 1;
    }
    if (xSemaphoreTake(s_encoder_lock, wait_ticks) != pdTRUE) {
        video_jpeg_status_t status;
        status_load(&status);
        status.encode_busy_timeouts++;
        status.last_error = ESP_ERR_TIMEOUT;
        status_store(&status);
        return ESP_ERR_TIMEOUT;
    }

    video_capture_frame_view_t raw = {0};
    esp_err_t err = video_capture_acquire_latest_frame_for_processing(&raw);
    if (err != ESP_OK) {
        xSemaphoreGive(s_encoder_lock);
        return err;
    }

    video_jpeg_status_t status;
    status_load(&status);
    const uint8_t encode_quality = status.quality;

    jpeg_encode_cfg_t encode_cfg = {
        .height = raw.height,
        .width = raw.width,
        .src_type = JPEG_ENCODE_IN_FORMAT_RGB888,
        .sub_sample = JPEG_DOWN_SAMPLING_YUV420,
        .image_quality = encode_quality,
        /* The proven P4 rev1.x CSI path lands in PSRAM in B,G,R byte order.
         * The ESP32-P4 JPEG encoder's default RGB888 order is BGR, so no reversal
         * is required. */
        .pixel_reverse = false,
    };

    uint32_t encoded_size = 0;
    const int64_t start_us = esp_timer_get_time();
    err = jpeg_encoder_process(s_encoder,
                               &encode_cfg,
                               raw.data,
                               (uint32_t)raw.size,
                               s_jpeg_buffer,
                               (uint32_t)s_jpeg_capacity,
                               &encoded_size);
    const int64_t end_us = esp_timer_get_time();
    const uint32_t encode_us = (uint32_t)(end_us - start_us);
    const uint32_t source_sequence = raw.sequence;
    video_capture_release_frame(&raw);

    status_load(&status);
    status.last_encode_us = encode_us;
    if (encode_us > status.max_encode_us) {
        status.max_encode_us = encode_us;
    }
    status.last_source_sequence = source_sequence;
    if (err != ESP_OK) {
        status.encode_failures++;
        status.last_error = err;
        status_store(&status);
        ESP_LOGW(TAG, "JPEG encode failed: %s", esp_err_to_name(err));
        xSemaphoreGive(s_encoder_lock);
        return err;
    }

    status.frames_encoded++;
    status.last_jpeg_size = encoded_size;
    status.last_error = ESP_OK;
    status_store(&status);

    out_view->data = s_jpeg_buffer;
    out_view->size = encoded_size;
    out_view->source_sequence = source_sequence;
    out_view->encode_us = encode_us;
    /* Keep s_encoder_lock held while the caller transmits this shared buffer. */
    return ESP_OK;
}

void video_jpeg_release(video_jpeg_frame_view_t *view)
{
    if (view == NULL || view->data == NULL || s_encoder_lock == NULL) {
        return;
    }
    memset(view, 0, sizeof(*view));
    xSemaphoreGive(s_encoder_lock);
}

bool video_jpeg_try_open_stream(void)
{
    bool opened = false;
    portENTER_CRITICAL(&s_status_lock);
    if (!s_stream_active && s_status.encoder_ready) {
        s_stream_active = true;
        s_status.active_stream_clients = 1;
        opened = true;
    }
    portEXIT_CRITICAL(&s_status_lock);
    return opened;
}

void video_jpeg_close_stream(bool disconnected)
{
    portENTER_CRITICAL(&s_status_lock);
    s_stream_active = false;
    s_status.active_stream_clients = 0;
    if (disconnected) {
        s_status.stream_disconnects++;
    }
    portEXIT_CRITICAL(&s_status_lock);
}

void video_jpeg_note_stream_frame(size_t jpeg_size)
{
    portENTER_CRITICAL(&s_status_lock);
    s_status.stream_frames_sent++;
    s_status.stream_bytes_sent += jpeg_size;
    portEXIT_CRITICAL(&s_status_lock);
}

void video_jpeg_get_status(video_jpeg_status_t *out_status)
{
    if (out_status == NULL) {
        return;
    }
    status_load(out_status);
}


esp_err_t video_jpeg_set_settings(uint8_t quality, uint8_t fps_limit)
{
    if (quality < 20 || quality > 95 || fps_limit < 1 || fps_limit > 30) {
        return ESP_ERR_INVALID_ARG;
    }
    portENTER_CRITICAL(&s_status_lock);
    s_status.quality = quality;
    s_status.fps_limit = fps_limit;
    portEXIT_CRITICAL(&s_status_lock);
    ESP_LOGI(TAG, "Runtime video settings: JPEG quality=%u max_fps=%u", quality, fps_limit);
    return ESP_OK;
}
