#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool initialized;
    bool encoder_ready;
    uint16_t width;
    uint16_t height;
    uint8_t quality;
    uint8_t fps_limit;
    size_t output_buffer_capacity;
    size_t psram_free_before;
    size_t psram_free_after;

    uint32_t frames_encoded;
    uint32_t encode_failures;
    uint32_t encode_busy_timeouts;
    uint32_t last_source_sequence;
    size_t last_jpeg_size;
    uint32_t last_encode_us;
    uint32_t max_encode_us;

    uint32_t active_stream_clients;
    uint32_t stream_frames_sent;
    uint64_t stream_bytes_sent;
    uint32_t stream_disconnects;

    esp_err_t last_error;
} video_jpeg_status_t;

typedef struct {
    const uint8_t *data;
    size_t size;
    uint32_t source_sequence;
    uint32_t encode_us;
} video_jpeg_frame_view_t;

/* Initialize the ESP32-P4 hardware JPEG encoder and its PSRAM output buffer. */
esp_err_t video_jpeg_init(void);

/* Encode the newest CSI RGB888 frame. The returned JPEG buffer is held until release. */
esp_err_t video_jpeg_encode_latest(video_jpeg_frame_view_t *out_view, uint32_t wait_ms);
void video_jpeg_release(video_jpeg_frame_view_t *view);

/* Milestone 6.1 intentionally supports one MJPEG client at a time. */
bool video_jpeg_try_open_stream(void);
void video_jpeg_close_stream(bool disconnected);
void video_jpeg_note_stream_frame(size_t jpeg_size);

void video_jpeg_get_status(video_jpeg_status_t *out_status);

/* Runtime stream settings used by the external web GUI. */
esp_err_t video_jpeg_set_settings(uint8_t quality, uint8_t fps_limit);

#ifdef __cplusplus
}
#endif
