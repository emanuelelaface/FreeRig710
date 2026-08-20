#include "web_api.h"
#include "control_api.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freerig_board.h"
#include "ft710_usb.h"
#include "ft710_cat.h"
#include "ft710_audio.h"
#include "ft710_audio_tx.h"
#include "network_eth.h"
#include "tc358743.h"
#include "video_capture.h"
#include "video_jpeg.h"

static const char *TAG = "web_api";
static httpd_handle_t s_server;
static portMUX_TYPE s_mjpeg_mux = portMUX_INITIALIZER_UNLOCKED;
static int s_mjpeg_fd = -1;

typedef struct {
    uint32_t active_clients;
    uint32_t sessions;
    uint32_t disconnects;
    uint64_t pcm_bytes_sent;
    int last_error;
} audio_net_status_t;

static portMUX_TYPE s_audio_net_mux = portMUX_INITIALIZER_UNLOCKED;
static audio_net_status_t s_audio_net_status;

typedef struct {
    uint32_t active_clients;
    uint32_t sessions;
    uint32_t disconnects;
    uint32_t binary_frames;
    uint32_t invalid_frames;
    uint64_t pcm_bytes_received;
    uint64_t pcm_bytes_accepted;
    int active_fd;
    int last_error;
} mic_ws_status_t;

static portMUX_TYPE s_mic_ws_mux = portMUX_INITIALIZER_UNLOCKED;
static mic_ws_status_t s_mic_ws_status = {.active_fd = -1};

static void mic_ws_get_status(mic_ws_status_t *out)
{
    if (out == NULL) return;
    portENTER_CRITICAL(&s_mic_ws_mux);
    *out = s_mic_ws_status;
    portEXIT_CRITICAL(&s_mic_ws_mux);
}

static void audio_net_get_status(audio_net_status_t *out)
{
    if (out == NULL) return;
    portENTER_CRITICAL(&s_audio_net_mux);
    *out = s_audio_net_status;
    portEXIT_CRITICAL(&s_audio_net_mux);
}

static const char STATUS_PAGE[] =
    "<!doctype html>"
    "<html lang=\"en\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>FreeRig710</title>"
    "<style>body{font-family:system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;}"
    "code,pre{background:#eee;padding:.2rem .35rem;border-radius:.25rem;}li{margin:.45rem 0}"
    ".video{width:100%;height:auto;border:1px solid #bbb;background:#111;display:block}</style>"
    "</head><body>"
    "<h1>FreeRig710</h1>"
    "<p>ESP32-P4 bring-up firmware for the Yaesu FT-710.</p>"
    "<p><strong>FreeRig710:</strong> ESP32-P4 radio control, live video, browser audio and integrated FT8.</p>"
    "<p><strong>Unified audio/PTT:</strong> the production GUI uses <code>/api/v1/audio/ws</code> for RX PCM, browser microphone PCM and latching PTT with a 1.5 s safety watchdog.</p>"
    "<p><img class=\"video\" src=\"/video.mjpeg\" alt=\"Live HDMI video\"></p>"
    "<ul>"
    "<li><a href=\"/video.mjpeg\">/video.mjpeg</a> (live MJPEG)</li>"
    "<li><a href=\"/api/v1/hardware/audio\">/api/v1/hardware/audio</a> (RX + TX UAC1 status)</li>"
    "<li><a href=\"/api/v1/hardware/cat\">/api/v1/hardware/cat</a></li>"
    "<li><a href=\"/api/v1/radio/state\">/api/v1/radio/state</a></li>"
    "<li><a href=\"/api/v1/hardware/usb\">/api/v1/hardware/usb</a></li>"
    "<li><a href=\"/api/v1/health\">/api/v1/health</a></li>"
    "</ul>"
    "</body></html>";

static void append_i2c_addresses(char *buffer, size_t buffer_size, const tc358743_status_t *status)
{
    size_t used = 0;
    if (buffer_size == 0) {
        return;
    }

    buffer[0] = '\0';
    for (size_t i = 0; i < status->discovered_count; ++i) {
        int written = snprintf(buffer + used, buffer_size - used,
                               "%s\"0x%02X\"", i == 0 ? "" : ",", status->discovered_addresses[i]);
        if (written < 0 || (size_t)written >= buffer_size - used) {
            break;
        }
        used += (size_t)written;
    }
}

static esp_err_t root_handler(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, STATUS_PAGE, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t favicon_handler(httpd_req_t *req)
{
    httpd_resp_set_status(req, "204 No Content");
    return httpd_resp_send(req, "", 0);
}

static esp_err_t health_handler(httpd_req_t *req)
{
    network_eth_status_t eth;
    tc358743_status_t tc;
    video_jpeg_status_t jpeg;
    ft710_usb_status_t *usb = malloc(sizeof(*usb));
    if (usb == NULL) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "out of memory");
    }

    network_eth_get_status(&eth);
    tc358743_get_status(&tc);
    video_jpeg_get_status(&jpeg);
    ft710_usb_get_status(usb);

    size_t usb_valid_devices = 0;
    for (size_t i = 0; i < FT710_USB_MAX_DEVICES; ++i) {
        if (usb->devices[i].present && usb->devices[i].descriptors_valid) {
            ++usb_valid_devices;
        }
    }

    const size_t json_capacity = 3072;
    char *json = malloc(json_capacity);
    if (json == NULL) {
        free(usb);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "out of memory");
    }

    int length = snprintf(
        json, json_capacity,
        "{"
        "\"ok\":true,"
        "\"service\":\"FreeRig710\","
        "\"platform\":\"ESP32-P4\","
        "\"radio\":\"Yaesu FT-710\","
        "\"version\":\"1.0\","
        "\"ft8_enabled\":true,"
        "\"usb_descriptor_enumeration_enabled\":true,"
        "\"csi_capture_enabled\":true,"
        "\"continuous_capture_enabled\":true,"
        "\"video_snapshot_enabled\":true,"
        "\"video_streaming_enabled\":true,"
        "\"jpeg_hardware_enabled\":%s,"
        "\"ft710_usb\":{"
            "\"host_installed\":%s,"
            "\"client_registered\":%s,"
            "\"device_count\":%u,"
            "\"descriptors_valid_count\":%u,"
            "\"device_list_truncated\":%s,"
            "\"last_error\":%d"
        "},"
        "\"ethernet\":{"
            "\"initialized\":%s,"
            "\"link_up\":%s,"
            "\"got_ip\":%s,"
            "\"ip\":\"%s\","
            "\"mac\":\"%02X:%02X:%02X:%02X:%02X:%02X\","
            "\"last_error\":%d"
        "},"
        "\"tc358743\":{"
            "\"bus_ready\":%s,"
            "\"found\":%s,"
            "\"address\":\"0x%02X\","
            "\"hdmi_receiver_configured\":%s,"
            "\"edid_verified\":%s,"
            "\"hpd_high\":%s,"
            "\"sys_status\":\"0x%02X\","
            "\"tmds\":%s,"
            "\"sync\":%s,"
            "\"timing_valid\":%s,"
            "\"last_error\":%d"
        "}"
        "}",
        jpeg.encoder_ready ? "true" : "false",
        usb->host_installed ? "true" : "false",
        usb->client_registered ? "true" : "false",
        (unsigned)usb->device_count,
        (unsigned)usb_valid_devices,
        usb->device_list_truncated ? "true" : "false",
        usb->last_error,
        eth.initialized ? "true" : "false",
        eth.link_up ? "true" : "false",
        eth.got_ip ? "true" : "false",
        eth.ip_address,
        eth.mac[0], eth.mac[1], eth.mac[2], eth.mac[3], eth.mac[4], eth.mac[5],
        (int)eth.last_error,
        tc.bus_ready ? "true" : "false",
        tc.found ? "true" : "false",
        tc.address,
        tc.hdmi_receiver_configured ? "true" : "false",
        tc.edid_verified ? "true" : "false",
        tc.hpd_high ? "true" : "false",
        tc.sys_status_raw,
        tc.tmds ? "true" : "false",
        tc.sync ? "true" : "false",
        tc.timings.valid ? "true" : "false",
        (int)tc.last_error);

    if (length < 0 || length >= (int)json_capacity) {
        free(json);
        free(usb);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "health JSON overflow");
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t result = httpd_resp_send(req, json, length);
    free(json);
    free(usb);
    return result;
}

static esp_err_t tc358743_handler(httpd_req_t *req)
{
    tc358743_status_t tc;
    tc358743_get_status(&tc);

    char addresses[160];
    append_i2c_addresses(addresses, sizeof(addresses), &tc);

    const size_t json_capacity = 4096;
    char *json = malloc(json_capacity);
    if (json == NULL) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "out of memory");
    }

    int length = snprintf(
        json, json_capacity,
        "{"
        "\"ok\":%s,"
        "\"version\":\"1.0\","
        "\"writes_enabled\":true,"
        "\"csi_transmitter_configured\":%s,"
        "\"i2c\":{"
            "\"bus_ready\":%s,"
            "\"sda_gpio\":%d,"
            "\"scl_gpio\":%d,"
            "\"frequency_hz\":%d,"
            "\"devices\":[%s],"
            "\"devices_truncated\":%s"
        "},"
        "\"tc358743\":{"
            "\"found\":%s,"
            "\"address\":\"0x%02X\","
            "\"chip_id_raw\":\"0x%04X\","
            "\"chip_id\":\"0x%02X\","
            "\"revision\":\"0x%02X\","
            "\"reference_clock_hz\":%" PRIu32 ","
            "\"timing_reference_programmed\":%s,"
            "\"sys_freq_raw\":%u,"
            "\"receiver\":{"
                "\"configured\":%s,"
                "\"sysctl_raw\":\"0x%04X\","
                "\"ddc_ctl_raw\":\"0x%02X\","
                "\"phy_ctl0_raw\":\"0x%02X\","
                "\"phy_ctl1_raw\":\"0x%02X\","
                "\"phy_ctl2_raw\":\"0x%02X\","
                "\"phy_en_raw\":\"0x%02X\","
                "\"phy_bias_raw\":\"0x%02X\","
                "\"phy_csq_raw\":\"0x%02X\","
                "\"hdmi_det_raw\":\"0x%02X\","
                "\"hv_rst_raw\":\"0x%02X\","
                "\"fh_min_raw\":%u,"
                "\"fh_max_raw\":%u,"
                "\"lockdet_ref_raw\":%" PRIu32 ","
                "\"nco_f0_mod_raw\":\"0x%02X\","
                "\"phy_reset_count\":%u"
            "},"
            "\"diagnostics\":{"
                "\"hpd_ctl_raw\":\"0x%02X\","
                "\"hpd_out\":%s,"
                "\"hpd_ctl0\":%s,"
                "\"ddc_action\":%s,"
                "\"ddc_ack_polarity\":%s,"
                "\"sys_clk_raw\":\"0x%02X\","
                "\"ana_ctl_raw\":\"0x%02X\","
                "\"init_end_raw\":\"0x%02X\","
                "\"sys_int_raw\":\"0x%02X\","
                "\"sys_int_seen\":\"0x%02X\","
                "\"clk_int_raw\":\"0x%02X\","
                "\"clk_int_seen\":\"0x%02X\","
                "\"misc_int_raw\":\"0x%02X\","
                "\"misc_int_seen\":\"0x%02X\","
                "\"hdmi_int0_raw\":\"0x%02X\","
                "\"hdmi_int0_seen\":\"0x%02X\","
                "\"hdmi_int1_raw\":\"0x%02X\","
                "\"hdmi_int1_seen\":\"0x%02X\","
                "\"sys_int_mask_raw\":\"0x%02X\","
                "\"clk_int_mask_raw\":\"0x%02X\","
                "\"misc_int_mask_raw\":\"0x%02X\""
            "},"
            "\"edid\":{"
                "\"source\":\"FreeRig710/config/video/tc358743-edid.hex\","
                "\"programmed\":%s,"
                "\"verified\":%s,"
                "\"verify_failed\":%s,"
                "\"verify_mismatch_offset\":%u,"
                "\"verify_expected\":\"0x%02X\","
                "\"verify_actual\":\"0x%02X\","
                "\"length\":%u,"
                "\"blocks\":%u,"
                "\"len1_readback\":\"0x%02X\","
                "\"len2_readback\":\"0x%02X\","
                "\"mode_raw\":\"0x%02X\","
                "\"hpd_high\":%s"
            "},"
            "\"signal\":{"
                "\"sys_status_valid\":%s,"
                "\"sys_status_raw\":\"0x%02X\","
                "\"ddc_5v\":%s,"
                "\"tmds\":%s,"
                "\"phy_pll\":%s,"
                "\"phy_scdt\":%s,"
                "\"hdmi\":%s,"
                "\"sync\":%s,"
                "\"avmute\":%s"
            "},"
            "\"timing\":{"
                "\"valid\":%s,"
                "\"interlaced\":%s,"
                "\"active_width\":%u,"
                "\"active_height\":%u,"
                "\"frame_width\":%u,"
                "\"frame_height\":%u,"
                "\"h_blanking\":%u,"
                "\"v_blanking\":%u,"
                "\"frame_interval_100us\":%u,"
                "\"fps_x100\":%" PRIu32 ","
                "\"pixel_clock_hz\":%" PRIu32
            "}"
        "},"
        "\"last_error\":%d"
        "}",
        tc.found ? "true" : "false",
        tc.csi_tx_configured ? "true" : "false",
        tc.bus_ready ? "true" : "false",
        FREERIG_CSI_I2C_SDA_GPIO,
        FREERIG_CSI_I2C_SCL_GPIO,
        FREERIG_CSI_I2C_FREQ_HZ,
        addresses,
        tc.discovered_truncated ? "true" : "false",
        tc.found ? "true" : "false",
        tc.address,
        tc.chip_id_raw,
        tc.chip_id,
        tc.revision,
        tc.reference_clock_hz,
        tc.timing_reference_programmed ? "true" : "false",
        tc.sys_freq_raw,
        tc.hdmi_receiver_configured ? "true" : "false",
        tc.sysctl_raw,
        tc.ddc_ctl_raw,
        tc.phy_ctl0_raw,
        tc.phy_ctl1_raw,
        tc.phy_ctl2_raw,
        tc.phy_en_raw,
        tc.phy_bias_raw,
        tc.phy_csq_raw,
        tc.hdmi_det_raw,
        tc.hv_rst_raw,
        tc.fh_min_raw,
        tc.fh_max_raw,
        tc.lockdet_ref_raw,
        tc.nco_f0_mod_raw,
        tc.phy_reset_count,
        tc.hpd_ctl_raw,
        tc.hpd_high ? "true" : "false",
        tc.hpd_control_enabled ? "true" : "false",
        tc.ddc_action ? "true" : "false",
        tc.ddc_ack_polarity ? "true" : "false",
        tc.sys_clk_raw,
        tc.ana_ctl_raw,
        tc.init_end_raw,
        tc.sys_int_raw,
        tc.sys_int_seen,
        tc.clk_int_raw,
        tc.clk_int_seen,
        tc.misc_int_raw,
        tc.misc_int_seen,
        tc.hdmi_int0_raw,
        tc.hdmi_int0_seen,
        tc.hdmi_int1_raw,
        tc.hdmi_int1_seen,
        tc.sys_int_mask_raw,
        tc.clk_int_mask_raw,
        tc.misc_int_mask_raw,
        tc.edid_programmed ? "true" : "false",
        tc.edid_verified ? "true" : "false",
        tc.edid_verify_failed ? "true" : "false",
        tc.edid_verify_mismatch_offset,
        tc.edid_verify_expected,
        tc.edid_verify_actual,
        tc.edid_length,
        tc.edid_blocks,
        tc.edid_len1_readback,
        tc.edid_len2_readback,
        tc.edid_mode_raw,
        tc.hpd_high ? "true" : "false",
        tc.sys_status_valid ? "true" : "false",
        tc.sys_status_raw,
        tc.ddc_5v ? "true" : "false",
        tc.tmds ? "true" : "false",
        tc.phy_pll ? "true" : "false",
        tc.phy_scdt ? "true" : "false",
        tc.hdmi ? "true" : "false",
        tc.sync ? "true" : "false",
        tc.avmute ? "true" : "false",
        tc.timings.valid ? "true" : "false",
        tc.timings.interlaced ? "true" : "false",
        tc.timings.active_width,
        tc.timings.active_height,
        tc.timings.frame_width,
        tc.timings.frame_height,
        tc.timings.h_blanking,
        tc.timings.v_blanking,
        tc.timings.frame_interval_100us,
        tc.timings.fps_x100,
        tc.timings.pixel_clock_hz,
        (int)tc.last_error);

    if (length < 0 || length >= (int)json_capacity) {
        free(json);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "TC358743 JSON overflow");
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t result = httpd_resp_send(req, json, length);
    free(json);
    return result;
}


static void write_le16(uint8_t *p, uint16_t value)
{
    p[0] = (uint8_t)(value & 0xFFU);
    p[1] = (uint8_t)((value >> 8) & 0xFFU);
}

static void write_le32(uint8_t *p, uint32_t value)
{
    p[0] = (uint8_t)(value & 0xFFU);
    p[1] = (uint8_t)((value >> 8) & 0xFFU);
    p[2] = (uint8_t)((value >> 16) & 0xFFU);
    p[3] = (uint8_t)((value >> 24) & 0xFFU);
}

static esp_err_t video_bmp_handler(httpd_req_t *req)
{
    video_capture_frame_view_t frame;
    esp_err_t err = video_capture_acquire_latest_frame(&frame);
    if (err != ESP_OK) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        httpd_resp_set_type(req, "text/plain; charset=utf-8");
        httpd_resp_set_hdr(req, "Cache-Control", "no-store");
        return httpd_resp_send(req, "No completed CSI frame is available yet.\n", HTTPD_RESP_USE_STRLEN);
    }

    /* 24-bit BMP stores pixels as B,G,R. On ESP32-P4 rev1.x the proven RGB888
     * CSI path lands in PSRAM in BGR byte order, so the framebuffer can be sent
     * directly without a colour conversion or a second full-frame copy. Width
     * 800 gives a 2400-byte row, already aligned to BMP's four-byte stride. */
    uint8_t header[54] = {0};
    const uint32_t image_size = (uint32_t)frame.size;
    const uint32_t file_size = image_size + sizeof(header);
    header[0] = 'B';
    header[1] = 'M';
    write_le32(&header[2], file_size);
    write_le32(&header[10], sizeof(header));
    write_le32(&header[14], 40); /* BITMAPINFOHEADER */
    write_le32(&header[18], frame.width);
    /* Negative height selects top-down scan lines. */
    write_le32(&header[22], (uint32_t)(-(int32_t)frame.height));
    write_le16(&header[26], 1);
    write_le16(&header[28], 24);
    write_le32(&header[34], image_size);
    write_le32(&header[38], 2835);
    write_le32(&header[42], 2835);

    httpd_resp_set_type(req, "image/bmp");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store, no-cache, must-revalidate");
    httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=freerig710.bmp");
    char seq_hdr[32];
    snprintf(seq_hdr, sizeof(seq_hdr), "%" PRIu32, frame.sequence);
    httpd_resp_set_hdr(req, "X-FreeRig710-Frame-Sequence", seq_hdr);

    err = httpd_resp_send_chunk(req, (const char *)header, sizeof(header));
    if (err == ESP_OK) {
        const size_t chunk_size = 32 * 1024;
        for (size_t offset = 0; offset < frame.size; offset += chunk_size) {
            size_t count = frame.size - offset;
            if (count > chunk_size) {
                count = chunk_size;
            }
            err = httpd_resp_send_chunk(req, (const char *)(frame.data + offset), count);
            if (err != ESP_OK) {
                break;
            }
        }
    }
    if (err == ESP_OK) {
        err = httpd_resp_send_chunk(req, NULL, 0);
    }

    video_capture_release_frame(&frame);
    return err;
}


#define FREERIG_MJPEG_BOUNDARY "freerig710frame"
#define FREERIG_MJPEG_TASK_STACK 6144
#define FREERIG_MJPEG_TASK_PRIORITY 4
#define FREERIG_MJPEG_FRAME_STALL_MS 5000

typedef struct {
    httpd_req_t *req;
    int fd;
} mjpeg_task_ctx_t;

static esp_err_t video_jpg_handler(httpd_req_t *req)
{
    video_jpeg_frame_view_t jpeg = {0};
    esp_err_t err = video_jpeg_encode_latest(&jpeg, 150);
    if (err != ESP_OK) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        httpd_resp_set_type(req, "text/plain; charset=utf-8");
        httpd_resp_set_hdr(req, "Cache-Control", "no-store");
        return httpd_resp_send(req, "Hardware JPEG frame is not available right now.\n", HTTPD_RESP_USE_STRLEN);
    }

    char seq_hdr[32];
    char enc_hdr[32];
    snprintf(seq_hdr, sizeof(seq_hdr), "%" PRIu32, jpeg.source_sequence);
    snprintf(enc_hdr, sizeof(enc_hdr), "%" PRIu32, jpeg.encode_us);
    httpd_resp_set_type(req, "image/jpeg");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store, no-cache, must-revalidate");
    httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=freerig710.jpg");
    httpd_resp_set_hdr(req, "X-FreeRig710-Frame-Sequence", seq_hdr);
    httpd_resp_set_hdr(req, "X-FreeRig710-JPEG-Encode-Us", enc_hdr);
    err = httpd_resp_send(req, (const char *)jpeg.data, (ssize_t)jpeg.size);
    video_jpeg_release(&jpeg);
    return err;
}

static void mjpeg_stream_task(void *arg)
{
    mjpeg_task_ctx_t *ctx = (mjpeg_task_ctx_t *)arg;
    httpd_req_t *req = ctx->req;
    const int fd = ctx->fd;
    free(ctx);

    esp_err_t err = httpd_resp_set_type(req,
        "multipart/x-mixed-replace; boundary=" FREERIG_MJPEG_BOUNDARY);
    if (err == ESP_OK) {
        err = httpd_resp_set_hdr(req, "Cache-Control", "no-store, no-cache, must-revalidate");
    }
    if (err == ESP_OK) {
        err = httpd_resp_set_hdr(req, "Pragma", "no-cache");
    }

    uint32_t last_sequence = 0;
    int64_t next_due_us = esp_timer_get_time();
    int64_t last_frame_progress_us = next_due_us;
    bool disconnected = false;

    while (err == ESP_OK) {
        if (httpd_sess_update_lru_counter(s_server, fd) != ESP_OK) {
            disconnected = true;
            err = ESP_FAIL;
            break;
        }
        video_capture_status_t capture;
        video_capture_get_status(&capture);
        if (!capture.continuous_running || !capture.capture_succeeded) {
            if ((esp_timer_get_time() - last_frame_progress_us) >=
                ((int64_t)FREERIG_MJPEG_FRAME_STALL_MS * 1000LL)) {
                ESP_LOGW(TAG, "MJPEG closing stalled session fd=%d: capture not progressing", fd);
                err = ESP_ERR_TIMEOUT;
                break;
            }
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }

        const int64_t now_us = esp_timer_get_time();
        if (now_us < next_due_us) {
            uint32_t delay_ms = (uint32_t)((next_due_us - now_us + 999) / 1000);
            if (delay_ms == 0) {
                delay_ms = 1;
            }
            vTaskDelay(pdMS_TO_TICKS(delay_ms));
        }

        video_jpeg_frame_view_t jpeg = {0};
        err = video_jpeg_encode_latest(&jpeg, 100);
        if (err == ESP_ERR_NOT_FOUND || err == ESP_ERR_TIMEOUT) {
            err = ESP_OK;
            vTaskDelay(pdMS_TO_TICKS(5));
            continue;
        }
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "MJPEG hardware encode failed: %s", esp_err_to_name(err));
            vTaskDelay(pdMS_TO_TICKS(20));
            err = ESP_OK;
            continue;
        }

        if (jpeg.source_sequence == last_sequence) {
            video_jpeg_release(&jpeg);
            if ((esp_timer_get_time() - last_frame_progress_us) >=
                ((int64_t)FREERIG_MJPEG_FRAME_STALL_MS * 1000LL)) {
                ESP_LOGW(TAG,
                         "MJPEG closing stalled session fd=%d: source sequence stuck at %" PRIu32,
                         fd, last_sequence);
                err = ESP_ERR_TIMEOUT;
                break;
            }
            video_jpeg_status_t cfg_status;
            video_jpeg_get_status(&cfg_status);
            const int64_t period_us = 1000000LL / (cfg_status.fps_limit ? cfg_status.fps_limit : 20U);
            next_due_us = esp_timer_get_time() + period_us;
            continue;
        }

        char part_header[192];
        int header_len = snprintf(part_header, sizeof(part_header),
                                  "--" FREERIG_MJPEG_BOUNDARY "\r\n"
                                  "Content-Type: image/jpeg\r\n"
                                  "Content-Length: %zu\r\n"
                                  "X-FreeRig710-Frame-Sequence: %" PRIu32 "\r\n"
                                  "X-FreeRig710-JPEG-Encode-Us: %" PRIu32 "\r\n\r\n",
                                  jpeg.size, jpeg.source_sequence, jpeg.encode_us);
        if (header_len <= 0 || header_len >= (int)sizeof(part_header)) {
            video_jpeg_release(&jpeg);
            err = ESP_FAIL;
            break;
        }

        err = httpd_resp_send_chunk(req, part_header, header_len);
        if (err == ESP_OK) {
            err = httpd_resp_send_chunk(req, (const char *)jpeg.data, jpeg.size);
        }
        if (err == ESP_OK) {
            err = httpd_resp_send_chunk(req, "\r\n", 2);
        }
        if (err == ESP_OK) {
            last_sequence = jpeg.source_sequence;
            last_frame_progress_us = esp_timer_get_time();
            video_jpeg_note_stream_frame(jpeg.size);
            (void)httpd_sess_update_lru_counter(s_server, fd);
        } else {
            disconnected = true;
        }
        video_jpeg_release(&jpeg);

        const int64_t after_send_us = esp_timer_get_time();
        video_jpeg_status_t cfg_status;
        video_jpeg_get_status(&cfg_status);
        const int64_t period_us = 1000000LL / (cfg_status.fps_limit ? cfg_status.fps_limit : 20U);
        next_due_us += period_us;
        if (next_due_us < after_send_us) {
            next_due_us = after_send_us;
        }
    }

    video_jpeg_close_stream(disconnected || err != ESP_OK);
    portENTER_CRITICAL(&s_mjpeg_mux);
    if (s_mjpeg_fd == fd) s_mjpeg_fd = -1;
    portEXIT_CRITICAL(&s_mjpeg_mux);
    (void)httpd_req_async_handler_complete(req);
    ESP_LOGI(TAG, "MJPEG client closed fd=%d", fd);
    vTaskDelete(NULL);
}

static esp_err_t video_mjpeg_handler(httpd_req_t *req)
{
    const int fd = httpd_req_to_sockfd(req);
    portENTER_CRITICAL(&s_mjpeg_mux);
    const int old_fd = s_mjpeg_fd;
    portEXIT_CRITICAL(&s_mjpeg_mux);

    if (old_fd >= 0 && old_fd != fd) {
        ESP_LOGI(TAG, "MJPEG takeover: closing stale fd=%d for new fd=%d", old_fd, fd);
        (void)httpd_sess_trigger_close(s_server, old_fd);
    }

    bool stream_claimed = false;
    for (int attempt = 0; attempt < 10 && !stream_claimed; ++attempt) {
        stream_claimed = video_jpeg_try_open_stream();
        if (!stream_claimed && old_fd >= 0 && old_fd != fd) vTaskDelay(pdMS_TO_TICKS(20));
        else if (!stream_claimed) break;
    }
    if (!stream_claimed) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        httpd_resp_set_type(req, "text/plain; charset=utf-8");
        httpd_resp_set_hdr(req, "Cache-Control", "no-store");
        return httpd_resp_send(req,
                               "MJPEG encoder is not ready.\n",
                               HTTPD_RESP_USE_STRLEN);
    }

    portENTER_CRITICAL(&s_mjpeg_mux);
    s_mjpeg_fd = fd;
    portEXIT_CRITICAL(&s_mjpeg_mux);
    (void)httpd_sess_update_lru_counter(s_server, fd);

    httpd_req_t *async_req = NULL;
    esp_err_t err = httpd_req_async_handler_begin(req, &async_req);
    if (err != ESP_OK) {
        video_jpeg_close_stream(false);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "async MJPEG request failed");
    }

    mjpeg_task_ctx_t *ctx = calloc(1, sizeof(*ctx));
    if (ctx == NULL) {
        video_jpeg_close_stream(false);
        (void)httpd_req_async_handler_complete(async_req);
        return ESP_ERR_NO_MEM;
    }
    ctx->req = async_req;
    ctx->fd = fd;

    BaseType_t task_ok = xTaskCreate(mjpeg_stream_task,
                                     "mjpeg_stream",
                                     FREERIG_MJPEG_TASK_STACK,
                                     ctx,
                                     FREERIG_MJPEG_TASK_PRIORITY,
                                     NULL);
    if (task_ok != pdPASS) {
        free(ctx);
        portENTER_CRITICAL(&s_mjpeg_mux);
        if (s_mjpeg_fd == fd) s_mjpeg_fd = -1;
        portEXIT_CRITICAL(&s_mjpeg_mux);
        video_jpeg_close_stream(false);
        (void)httpd_req_async_handler_complete(async_req);
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "MJPEG client opened: FT-710 800x480 quality=80 max_fps=20 (async HTTP task)");
    return ESP_OK;
}

static esp_err_t jpeg_status_handler(httpd_req_t *req)
{
    video_jpeg_status_t jpeg;
    video_jpeg_get_status(&jpeg);

    const size_t json_capacity = 3072;
    char *json = malloc(json_capacity);
    if (json == NULL) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "out of memory");
    }

    int length = snprintf(
        json, json_capacity,
        "{"
        "\"ok\":%s,"
        "\"version\":\"1.0\","
        "\"engine\":{"
            "\"hardware\":true,"
            "\"initialized\":%s,"
            "\"ready\":%s,"
            "\"input_format\":\"RGB888/BGR\","
            "\"jpeg_subsampling\":\"YUV420\","
            "\"quality\":%u,"
            "\"width\":%u,"
            "\"height\":%u,"
            "\"fps_limit\":%u,"
            "\"output_buffer_capacity\":%zu"
        "},"
        "\"encoding\":{"
            "\"frames_encoded\":%" PRIu32 ","
            "\"failures\":%" PRIu32 ","
            "\"busy_timeouts\":%" PRIu32 ","
            "\"last_source_sequence\":%" PRIu32 ","
            "\"last_jpeg_size\":%zu,"
            "\"last_encode_us\":%" PRIu32 ","
            "\"max_encode_us\":%" PRIu32
        "},"
        "\"stream\":{"
            "\"uri\":\"/video.mjpeg\","
            "\"active_clients\":%" PRIu32 ","
            "\"max_clients\":1,"
            "\"frames_sent\":%" PRIu32 ","
            "\"bytes_sent\":%" PRIu64 ","
            "\"disconnects\":%" PRIu32
        "},"
        "\"memory\":{"
            "\"psram_free_before\":%zu,"
            "\"psram_free_after\":%zu"
        "},"
        "\"last_error\":%d"
        "}",
        jpeg.encoder_ready ? "true" : "false",
        jpeg.initialized ? "true" : "false",
        jpeg.encoder_ready ? "true" : "false",
        jpeg.quality,
        jpeg.width,
        jpeg.height,
        jpeg.fps_limit,
        jpeg.output_buffer_capacity,
        jpeg.frames_encoded,
        jpeg.encode_failures,
        jpeg.encode_busy_timeouts,
        jpeg.last_source_sequence,
        jpeg.last_jpeg_size,
        jpeg.last_encode_us,
        jpeg.max_encode_us,
        jpeg.active_stream_clients,
        jpeg.stream_frames_sent,
        jpeg.stream_bytes_sent,
        jpeg.stream_disconnects,
        jpeg.psram_free_before,
        jpeg.psram_free_after,
        (int)jpeg.last_error);

    if (length < 0 || length >= (int)json_capacity) {
        free(json);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "JPEG JSON overflow");
    }

    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t result = httpd_resp_send(req, json, length);
    free(json);
    return result;
}

static bool usb_json_append(char **cursor, size_t *remaining, const char *fmt, ...)
{
    if (cursor == NULL || *cursor == NULL || remaining == NULL || *remaining == 0) {
        return false;
    }

    va_list args;
    va_start(args, fmt);
    int written = vsnprintf(*cursor, *remaining, fmt, args);
    va_end(args);

    if (written < 0 || (size_t)written >= *remaining) {
        return false;
    }

    *cursor += written;
    *remaining -= (size_t)written;
    return true;
}

static esp_err_t usb_status_handler(httpd_req_t *req)
{
    ft710_usb_status_t *usb = malloc(sizeof(*usb));
    if (usb == NULL) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "out of memory");
    }
    ft710_usb_get_status(usb);

    const size_t json_capacity = 65536;
    char *json = malloc(json_capacity);
    if (json == NULL) {
        free(usb);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "out of memory");
    }

    char *cursor = json;
    size_t remaining = json_capacity;
    bool ok = usb_json_append(
        &cursor, &remaining,
        "{"
        "\"ok\":%s,"
        "\"version\":\"1.0\","
        "\"role\":\"DWC2 FS/LS-only Type-A with CP2105 CAT-2 transport; USB Audio enumerated but not claimed\","
        "\"host\":{" 
            "\"initialized\":%s,"
            "\"host_installed\":%s,"
            "\"client_registered\":%s,"
            "\"peripheral_map\":\"0x1\","
            "\"phy\":\"normal onboard HS/UTMI PHY with experimental DWC2 host FS/LS-only mode\","
            "\"data_pins\":\"onboard Waveshare USB Type-A (dedicated HS/UTMI pins)\","
            "\"manual_phy_setup\":false,"
            "\"force_full_speed_on_hs_port\":true,"
            "\"phy_setup_error\":%d,"
            "\"dwc_force_fsls_only\":%s,"
            "\"dwc_register_guard_ok\":%s,"
            "\"dwc_gsnpsid\":\"0x%08" PRIX32 "\","
            "\"dwc_ghwcfg2\":\"0x%08" PRIX32 "\","
            "\"dwc_gusbcfg\":\"0x%08" PRIX32 "\","
            "\"dwc_hcfg_before\":\"0x%08" PRIX32 "\","
            "\"dwc_hcfg_after\":\"0x%08" PRIX32 "\","
            "\"dwc_hprt\":\"0x%08" PRIX32 "\","
            "\"single_hub_support_enabled\":true,"
            "\"last_error\":%d"
        "},"
        "\"device_count\":%u,"
        "\"device_list_truncated\":%s,"
        "\"connect_count\":%" PRIu32 ","
        "\"disconnect_count\":%" PRIu32 ","
        "\"devices\":[",
        usb->host_installed && usb->client_registered ? "true" : "false",
        usb->initialized ? "true" : "false",
        usb->host_installed ? "true" : "false",
        usb->client_registered ? "true" : "false",
        usb->phy_setup_error,
        usb->dwc_force_fsls_only ? "true" : "false",
        usb->dwc_register_guard_ok ? "true" : "false",
        usb->dwc_gsnpsid,
        usb->dwc_ghwcfg2,
        usb->dwc_gusbcfg,
        usb->dwc_hcfg_before,
        usb->dwc_hcfg_after,
        usb->dwc_hprt,
        usb->last_error,
        (unsigned)usb->device_count,
        usb->device_list_truncated ? "true" : "false",
        usb->connect_count,
        usb->disconnect_count);

    size_t emitted_devices = 0;
    for (size_t d = 0; ok && d < FT710_USB_MAX_DEVICES; ++d) {
        const ft710_usb_device_status_t *dev = &usb->devices[d];
        if (!dev->present) {
            continue;
        }

        ok = usb_json_append(
            &cursor, &remaining,
            "%s{"
                "\"address\":%u,"
                "\"speed\":\"%s\","
                "\"descriptors_valid\":%s,"
                "\"vid\":\"0x%04X\","
                "\"pid\":\"0x%04X\","
                "\"device_role\":\"%s\","
                "\"bcd_usb\":\"0x%04X\","
                "\"bcd_device\":\"0x%04X\","
                "\"class\":\"0x%02X\","
                "\"subclass\":\"0x%02X\","
                "\"protocol\":\"0x%02X\","
                "\"num_configurations\":%u,"
                "\"active_configuration\":%u,"
                "\"manufacturer\":\"%s\","
                "\"product\":\"%s\","
                "\"serial\":\"%s\","
                "\"descriptor_list_truncated\":%s,"
                "\"interfaces\":[",
            emitted_devices == 0 ? "" : ",",
            dev->device_address,
            ft710_usb_speed_name(dev->speed),
            dev->descriptors_valid ? "true" : "false",
            dev->vid,
            dev->pid,
            ft710_usb_device_role(dev->vid, dev->pid, dev->device_class),
            dev->bcd_usb,
            dev->bcd_device,
            dev->device_class,
            dev->device_subclass,
            dev->device_protocol,
            dev->num_configurations,
            dev->active_configuration,
            dev->manufacturer,
            dev->product,
            dev->serial,
            dev->descriptor_list_truncated ? "true" : "false");

        for (size_t i = 0; ok && i < dev->interface_count; ++i) {
            const ft710_usb_interface_desc_t *intf = &dev->interfaces[i];
            ok = usb_json_append(
                &cursor, &remaining,
                "%s{"
                    "\"number\":%u,"
                    "\"alternate_setting\":%u,"
                    "\"num_endpoints\":%u,"
                    "\"class\":\"0x%02X\","
                    "\"subclass\":\"0x%02X\","
                    "\"protocol\":\"0x%02X\","
                    "\"string_index\":%u"
                "}",
                i == 0 ? "" : ",",
                intf->number,
                intf->alternate_setting,
                intf->num_endpoints,
                intf->interface_class,
                intf->interface_subclass,
                intf->interface_protocol,
                intf->string_index);
        }

        if (ok) {
            ok = usb_json_append(&cursor, &remaining, "],\"endpoints\":[");
        }

        for (size_t i = 0; ok && i < dev->endpoint_count; ++i) {
            const ft710_usb_endpoint_desc_t *ep = &dev->endpoints[i];
            ok = usb_json_append(
                &cursor, &remaining,
                "%s{"
                    "\"interface\":%u,"
                    "\"alternate_setting\":%u,"
                    "\"address\":\"0x%02X\","
                    "\"direction\":\"%s\","
                    "\"attributes\":\"0x%02X\","
                    "\"transfer_type\":\"%s\","
                    "\"max_packet_size\":%u,"
                    "\"max_packet_size_raw\":\"0x%04X\","
                    "\"interval\":%u"
                "}",
                i == 0 ? "" : ",",
                ep->interface_number,
                ep->alternate_setting,
                ep->address,
                (ep->address & 0x80U) ? "IN" : "OUT",
                ep->attributes,
                ft710_usb_transfer_type_name(ep->transfer_type),
                ep->max_packet_size,
                ep->max_packet_size_raw,
                ep->interval);
        }

        if (ok) {
            ok = usb_json_append(&cursor, &remaining, "]}");
        }
        ++emitted_devices;
    }

    if (ok) {
        ok = usb_json_append(&cursor, &remaining, "]}");
    }

    if (!ok) {
        free(json);
        free(usb);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "USB JSON overflow");
    }

    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t result = httpd_resp_send(req, json, (ssize_t)(cursor - json));
    free(json);
    free(usb);
    return result;
}

static esp_err_t cat_status_handler(httpd_req_t *req)
{
    ft710_cat_status_t cat;
    ft710_cat_get_status(&cat);

    char json[3072];
    int length = snprintf(
        json, sizeof(json),
        "{"
        "\"ok\":%s,"
        "\"version\":\"1.0\","
        "\"role\":\"FT-710 CP2105 CAT-2/AUX interface 1; read-only state polling; PTT disabled\","
        "\"initialized\":%s,"
        "\"client_registered\":%s,"
        "\"cp2105_found\":%s,"
        "\"device_open\":%s,"
        "\"interface_claimed\":%s,"
        "\"device_address\":%u,"
        "\"interface\":%u,"
        "\"bulk_in\":{\"endpoint\":\"0x%02X\",\"mps\":%u},"
        "\"bulk_out\":{\"endpoint\":\"0x%02X\",\"mps\":%u},"
        "\"serial\":{\"baud\":%" PRIu32 ",\"format\":\"8N1\",\"flow_control\":\"off\",\"uart_enabled\":%s,\"dtr_rts_forced_low\":%s},"
        "\"rx_running\":%s,"
        "\"id_query_sent\":%s,"
        "\"id_query_ok\":%s,"
        "\"last_command\":\"%s\","
        "\"last_response\":\"%s\","
        "\"read_only_state\":{"
            "\"valid\":%s,"
            "\"power_known\":%s,"
            "\"power\":\"%s\","
            "\"active_vfo\":\"%s\","
            "\"split_known\":%s,"
            "\"split_enabled\":%s,"
            "\"frequency_hz\":%" PRIu32 ","
            "\"vfo_a_hz\":%" PRIu32 ","
            "\"vfo_b_hz\":%" PRIu32 ","
            "\"mode\":\"%s\","
            "\"vfo_a_mode\":\"%s\","
            "\"vfo_b_mode\":\"%s\","
            "\"updated_ms\":%" PRIu64
        "},"
        "\"counters\":{\"control_ok\":%" PRIu32 ",\"control_error\":%" PRIu32 ",\"bulk_in\":%" PRIu32 ",\"bulk_out\":%" PRIu32 ",\"rx_bytes\":%" PRIu32 ",\"tx_bytes\":%" PRIu32 ",\"disconnects\":%" PRIu32 ",\"state_polls\":%" PRIu32 ",\"state_poll_errors\":%" PRIu32 "},"
        "\"last_error\":%d"
        "}",
        cat.id_query_ok ? "true" : "false",
        cat.initialized ? "true" : "false",
        cat.client_registered ? "true" : "false",
        cat.cp2105_found ? "true" : "false",
        cat.device_open ? "true" : "false",
        cat.interface_claimed ? "true" : "false",
        cat.device_address,
        cat.interface_number,
        cat.bulk_in_ep,
        cat.bulk_in_mps,
        cat.bulk_out_ep,
        cat.bulk_out_mps,
        cat.baudrate,
        cat.uart_enabled && cat.configured_115200_8n1 ? "true" : "false",
        cat.dtr_rts_forced_low ? "true" : "false",
        cat.rx_running ? "true" : "false",
        cat.id_query_sent ? "true" : "false",
        cat.id_query_ok ? "true" : "false",
        cat.last_command,
        cat.last_response,
        cat.state_valid ? "true" : "false",
        cat.power_known ? "true" : "false",
        cat.power_known ? (cat.radio_power_on ? "ON" : "OFF") : "UNKNOWN",
        cat.active_vfo,
        cat.split_known ? "true" : "false",
        cat.split_enabled ? "true" : "false",
        cat.frequency_hz,
        cat.vfo_a_hz,
        cat.vfo_b_hz,
        cat.mode,
        cat.vfo_a_mode,
        cat.vfo_b_mode,
        cat.state_updated_ms,
        cat.control_ok_count,
        cat.control_error_count,
        cat.bulk_in_count,
        cat.bulk_out_count,
        cat.rx_bytes,
        cat.tx_bytes,
        cat.disconnect_count,
        cat.state_poll_count,
        cat.state_poll_error_count,
        cat.last_error);

    if (length < 0 || length >= (int)sizeof(json)) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "CAT JSON overflow");
    }
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, json, length);
}


static const char *uac_sync_type_name(uint8_t attributes)
{
    switch ((attributes >> 2) & 0x03U) {
    case 0: return "none";
    case 1: return "asynchronous";
    case 2: return "adaptive";
    case 3: return "synchronous";
    default: return "unknown";
    }
}

static void mic_ws_mark_closed(int fd, int err)
{
    portENTER_CRITICAL(&s_mic_ws_mux);
    if (s_mic_ws_status.active_fd == fd) {
        s_mic_ws_status.active_fd = -1;
        s_mic_ws_status.active_clients = 0;
        s_mic_ws_status.disconnects++;
        s_mic_ws_status.last_error = err;
    }
    portEXIT_CRITICAL(&s_mic_ws_mux);
    ft710_audio_tx_input_reset();
}

static esp_err_t mic_ws_post_handshake(httpd_req_t *req)
{
    const int fd = httpd_req_to_sockfd(req);
    portENTER_CRITICAL(&s_mic_ws_mux);
    const int old_fd = s_mic_ws_status.active_fd;
    portEXIT_CRITICAL(&s_mic_ws_mux);
    if (old_fd >= 0 && old_fd != fd &&
        httpd_ws_get_fd_info(req->handle, old_fd) == HTTPD_WS_CLIENT_WEBSOCKET) {
        (void)httpd_sess_trigger_close(req->handle, old_fd);
    }
    ft710_audio_tx_input_reset();
    portENTER_CRITICAL(&s_mic_ws_mux);
    s_mic_ws_status.active_fd = fd;
    s_mic_ws_status.active_clients = 1;
    s_mic_ws_status.sessions++;
    s_mic_ws_status.last_error = ESP_OK;
    portEXIT_CRITICAL(&s_mic_ws_mux);
    ESP_LOGI(TAG, "Legacy /ws/mic diagnostic connected fd=%d via post-handshake callback; production GUI uses /api/v1/audio/ws", fd);
    return ESP_OK;
}

static esp_err_t mic_ws_handler(httpd_req_t *req)
{
    const int fd = httpd_req_to_sockfd(req);
    httpd_ws_frame_t frame;
    memset(&frame, 0, sizeof(frame));
    esp_err_t err = httpd_ws_recv_frame(req, &frame, 0);
    if (err != ESP_OK) {
        mic_ws_mark_closed(fd, (int)err);
        return err;
    }
    if (frame.type == HTTPD_WS_TYPE_CLOSE) {
        mic_ws_mark_closed(fd, ESP_OK);
        return ESP_FAIL;
    }
    if (frame.type != HTTPD_WS_TYPE_BINARY || frame.len == 0 || (frame.len & 1U) != 0 || frame.len > 8192U) {
        portENTER_CRITICAL(&s_mic_ws_mux);
        s_mic_ws_status.invalid_frames++;
        portEXIT_CRITICAL(&s_mic_ws_mux);
        mic_ws_mark_closed(fd, ESP_ERR_INVALID_ARG);
        return ESP_FAIL;
    }

    uint8_t *payload = malloc(frame.len);
    if (payload == NULL) return ESP_ERR_NO_MEM;
    frame.payload = payload;
    err = httpd_ws_recv_frame(req, &frame, frame.len);
    if (err != ESP_OK) {
        free(payload);
        mic_ws_mark_closed(fd, (int)err);
        return err;
    }
    const size_t accepted = ft710_audio_tx_push_mono_s16(payload, frame.len);
    free(payload);

    portENTER_CRITICAL(&s_mic_ws_mux);
    s_mic_ws_status.binary_frames++;
    s_mic_ws_status.pcm_bytes_received += frame.len;
    s_mic_ws_status.pcm_bytes_accepted += accepted;
    s_mic_ws_status.last_error = accepted == frame.len ? ESP_OK : ESP_ERR_NO_MEM;
    portEXIT_CRITICAL(&s_mic_ws_mux);
    return ESP_OK;
}

static esp_err_t audio_status_handler(httpd_req_t *req)
{
    ft710_usb_status_t *usb = malloc(sizeof(*usb));
    if (usb == NULL) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "out of memory");
    }
    ft710_usb_get_status(usb);

    ft710_audio_status_t rx;
    ft710_audio_get_status(&rx);
    ft710_audio_tx_status_t tx;
    ft710_audio_tx_get_status(&tx);
    audio_net_status_t net;
    audio_net_get_status(&net);
    mic_ws_status_t mic;
    mic_ws_get_status(&mic);

    const ft710_usb_device_status_t *audio = NULL;
    for (size_t i = 0; i < FT710_USB_MAX_DEVICES; ++i) {
        if (usb->devices[i].present && usb->devices[i].descriptors_valid &&
            usb->devices[i].vid == 0x0D8CU && usb->devices[i].pid == 0x0013U) {
            audio = &usb->devices[i];
            break;
        }
    }

    const size_t json_capacity = 12288;
    char *json = malloc(json_capacity);
    if (json == NULL) {
        free(usb);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "out of memory");
    }
    char *cursor = json;
    size_t remaining = json_capacity;
    bool ok = usb_json_append(&cursor, &remaining,
        "{\"ok\":%s,\"version\":\"1.0\",\"probe_only\":false,"
        "\"streaming_enabled\":%s,\"ptt_enabled\":false,\"tx_audio_enabled\":%s,"
        "\"device_present\":%s,\"vid\":\"0x0D8C\",\"pid\":\"0x0013\","
        "\"device_role\":\"FT-710 USB Audio (C-Media)\","
        "\"rx_capture\":{"
        "\"initialized\":%s,\"client_registered\":%s,\"device_open\":%s,"
        "\"interface_claimed\":%s,\"sample_rate_configured\":%s,\"streaming\":%s,"
        "\"device_address\":%u,\"interface\":%u,\"alternate_setting\":%u,"
        "\"endpoint\":\"0x%02X\",\"max_packet_size\":%u,\"sample_rate_hz\":%" PRIu32 ","
        "\"channels\":%u,\"bits_per_sample\":%u,\"expected_packet_bytes\":96,"
        "\"transfer_callbacks\":%" PRIu32 ",\"transfer_errors\":%" PRIu32 ","
        "\"packets_total\":%" PRIu32 ",\"packets_completed\":%" PRIu32 ","
        "\"packets_skipped\":%" PRIu32 ",\"packets_error\":%" PRIu32 ","
        "\"packets_96_bytes\":%" PRIu32 ",\"packets_other_size\":%" PRIu32 ","
        "\"rx_bytes\":%" PRIu64 ",\"rx_samples\":%" PRIu64 ","
        "\"last_packet_bytes\":%u,\"peak_abs\":%u,\"mean_abs\":%u,"
        "\"started_ms\":%" PRIu64 ",\"updated_ms\":%" PRIu64 ","
        "\"disconnects\":%" PRIu32 ","
        "\"pcm_tap\":{"
            "\"consumer_active\":%s,\"buffer_capacity\":%" PRIu32 ","
            "\"buffered_bytes\":%" PRIu32 ",\"stream_opens\":%" PRIu32 ","
            "\"stream_bytes\":%" PRIu64 ",\"dropped_bytes\":%" PRIu64
        "},\"last_error\":%d},"
        "\"browser_stream\":{"
            "\"enabled\":false,\"server_port\":0,\"path\":null,\"transport\":\"unified WebSocket /api/v1/audio/ws\","
            "\"format\":\"PCM S16LE over WebSocket\",\"sample_rate_hz\":48000,"
            "\"channels\":1,\"bits_per_sample\":16,\"active_clients\":%" PRIu32 ","
            "\"sessions\":%" PRIu32 ",\"pcm_bytes_sent\":%" PRIu64 ","
            "\"disconnects\":%" PRIu32 ",\"last_error\":%d},"
        "\"tx_stream\":{"
            "\"initialized\":%s,\"client_registered\":%s,\"device_open\":%s,"
            "\"interface_claimed\":%s,\"sample_rate_configured\":%s,\"streaming\":%s,"
            "\"device_address\":%u,\"interface\":%u,\"alternate_setting\":%u,"
            "\"endpoint\":\"0x%02X\",\"max_packet_size\":%u,\"sample_rate_hz\":%" PRIu32 ","
            "\"channels\":%u,\"bits_per_sample\":%u,\"expected_packet_bytes\":%u,"
            "\"packet_bytes_min\":%u,\"packet_bytes_max\":%u,"
            "\"transfer_callbacks\":%" PRIu32 ",\"transfer_errors\":%" PRIu32 ","
            "\"packets_total\":%" PRIu32 ",\"packets_completed\":%" PRIu32 ","
            "\"packets_skipped\":%" PRIu32 ",\"packets_error\":%" PRIu32 ","
            "\"packets_48_frames\":%" PRIu32 ","
            "\"usb_bytes_sent\":%" PRIu64 ",\"source_frames_sent\":%" PRIu64 ",\"silence_frames_sent\":%" PRIu64 ","
            "\"input_buffer_capacity\":%" PRIu32 ",\"input_buffered_bytes\":%" PRIu32 ","
            "\"input_pushes\":%" PRIu32 ",\"input_bytes_received\":%" PRIu64 ","
            "\"input_bytes_dropped_old\":%" PRIu64 ",\"input_peak_abs\":%u,"
            "\"disconnects\":%" PRIu32 ",\"last_error\":%d},"
        "\"browser_microphone\":{"
            "\"enabled\":true,\"path\":\"/api/v1/audio/ws\","
            "\"format\":\"PCM S16LE mono 48000 Hz input and TX\","
            "\"active_clients\":%" PRIu32 ",\"sessions\":%" PRIu32 ",\"disconnects\":%" PRIu32 ","
            "\"binary_frames\":%" PRIu32 ",\"invalid_frames\":%" PRIu32 ","
            "\"pcm_bytes_received\":%" PRIu64 ",\"pcm_bytes_accepted\":%" PRIu64 ",\"last_error\":%d},"
        "\"streams\":[",
        rx.streaming && tx.streaming && rx.last_error == 0 && tx.last_error == 0 ? "true" : "false",
        rx.streaming ? "true" : "false",
        tx.streaming ? "true" : "false",
        audio != NULL ? "true" : "false",
        rx.initialized ? "true" : "false",
        rx.client_registered ? "true" : "false",
        rx.device_open ? "true" : "false",
        rx.interface_claimed ? "true" : "false",
        rx.sample_rate_configured ? "true" : "false",
        rx.streaming ? "true" : "false",
        rx.device_address, rx.interface_number, rx.alternate_setting, rx.endpoint,
        rx.max_packet_size, rx.sample_rate_hz, rx.channels, rx.bits_per_sample,
        rx.transfer_callbacks, rx.transfer_errors, rx.packets_total, rx.packets_completed,
        rx.packets_skipped, rx.packets_error, rx.packets_expected_size, rx.packets_other_size,
        rx.rx_bytes, rx.rx_samples, rx.last_packet_bytes, rx.peak_abs, rx.mean_abs,
        rx.started_ms, rx.updated_ms, rx.disconnects,
        rx.pcm_consumer_active ? "true" : "false", rx.pcm_buffer_capacity,
        rx.pcm_buffered_bytes, rx.pcm_stream_opens, rx.pcm_stream_bytes,
        rx.pcm_stream_dropped_bytes, rx.last_error,
        net.active_clients, net.sessions, net.pcm_bytes_sent, net.disconnects, net.last_error,
        tx.initialized ? "true" : "false", tx.client_registered ? "true" : "false",
        tx.device_open ? "true" : "false", tx.interface_claimed ? "true" : "false",
        tx.sample_rate_configured ? "true" : "false", tx.streaming ? "true" : "false",
        tx.device_address, tx.interface_number, tx.alternate_setting, tx.endpoint, tx.max_packet_size,
        tx.sample_rate_hz, tx.channels, tx.bits_per_sample, tx.expected_packet_bytes,
        tx.packet_bytes_min, tx.packet_bytes_max, tx.transfer_callbacks, tx.transfer_errors, tx.packets_total, tx.packets_completed,
        tx.packets_skipped, tx.packets_error, tx.packets_48_frames, tx.usb_bytes_sent, tx.source_frames_sent, tx.silence_frames_sent,
        tx.input_buffer_capacity, tx.input_buffered_bytes, tx.input_pushes, tx.input_bytes_received,
        tx.input_bytes_dropped_old, tx.input_peak_abs, tx.disconnects, tx.last_error,
        mic.active_clients, mic.sessions, mic.disconnects, mic.binary_frames, mic.invalid_frames,
        mic.pcm_bytes_received, mic.pcm_bytes_accepted, mic.last_error);

    size_t emitted_streams = 0;
    if (audio != NULL) {
        for (size_t i = 0; ok && i < audio->audio_format_count; ++i) {
            const ft710_usb_audio_format_t *fmt = &audio->audio_formats[i];
            if (!fmt->valid) continue;
            const bool is_rx = (fmt->endpoint_address & 0x80U) != 0;
            ok = usb_json_append(&cursor, &remaining,
                "%s{\"interface\":%u,\"alternate_setting\":%u,"
                "\"direction\":\"%s\",\"meaning\":\"%s\","
                "\"endpoint\":\"0x%02X\",\"endpoint_attributes\":\"0x%02X\","
                "\"sync_type\":\"%s\",\"max_packet_size\":%u,\"interval\":%u,"
                "\"format_type\":%u,\"channels\":%u,\"subframe_size_bytes\":%u,"
                "\"bit_resolution\":%u,\"sample_rate_mode\":\"%s\","
                "\"sample_rates_hz\":[",
                emitted_streams == 0 ? "" : ",",
                fmt->interface_number, fmt->alternate_setting,
                is_rx ? "IN" : "OUT",
                is_rx ? "radio_to_esp32_rx_audio" : "esp32_to_radio_tx_audio",
                fmt->endpoint_address, fmt->endpoint_attributes,
                uac_sync_type_name(fmt->endpoint_attributes), fmt->max_packet_size,
                fmt->interval, fmt->format_type, fmt->channels,
                fmt->subframe_size_bytes, fmt->bit_resolution,
                fmt->continuous_sample_rate ? "continuous" : "discrete");

            if (fmt->continuous_sample_rate) {
                ok = ok && usb_json_append(&cursor, &remaining, "%" PRIu32 ",%" PRIu32,
                                            fmt->min_sample_rate_hz,
                                            fmt->max_sample_rate_hz);
            } else {
                for (size_t r = 0; ok && r < fmt->sample_rate_count; ++r) {
                    ok = usb_json_append(&cursor, &remaining, "%s%" PRIu32,
                                         r == 0 ? "" : ",",
                                         fmt->sample_rates_hz[r]);
                }
            }
            ok = ok && usb_json_append(&cursor, &remaining, "]}");
            ++emitted_streams;
        }
    }

    ok = ok && usb_json_append(&cursor, &remaining, "]}");
    if (!ok) {
        free(json);
        free(usb);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "audio JSON overflow");
    }

    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t result = httpd_resp_send(req, json, HTTPD_RESP_USE_STRLEN);
    free(json);
    free(usb);
    return result;
}

static esp_err_t radio_state_handler(httpd_req_t *req)
{
    ft710_cat_status_t cat;
    ft710_cat_get_status(&cat);

    char json[1536];
    int length = snprintf(
        json, sizeof(json),
        "{"
        "\"ok\":%s,"
        "\"version\":\"1.0\","
        "\"read_only\":true,"
        "\"ptt_enabled\":false,"
        "\"connected\":%s,"
        "\"state_valid\":%s,"
        "\"power\":\"%s\","
        "\"active_vfo\":\"%s\","
        "\"split_enabled\":%s,"
        "\"frequency_hz\":%" PRIu32 ","
        "\"vfo_a_hz\":%" PRIu32 ","
        "\"vfo_b_hz\":%" PRIu32 ","
        "\"mode\":\"%s\","
        "\"vfo_a_mode\":\"%s\","
        "\"vfo_b_mode\":\"%s\","
        "\"updated_ms\":%" PRIu64 ","
        "\"poll_count\":%" PRIu32 ","
        "\"poll_errors\":%" PRIu32 ","
        "\"last_error\":%d"
        "}",
        cat.state_valid ? "true" : "false",
        cat.device_open && cat.interface_claimed ? "true" : "false",
        cat.state_valid ? "true" : "false",
        cat.power_known ? (cat.radio_power_on ? "ON" : "OFF") : "UNKNOWN",
        cat.active_vfo,
        cat.split_known && cat.split_enabled ? "true" : "false",
        cat.frequency_hz,
        cat.vfo_a_hz,
        cat.vfo_b_hz,
        cat.mode,
        cat.vfo_a_mode,
        cat.vfo_b_mode,
        cat.state_updated_ms,
        cat.state_poll_count,
        cat.state_poll_error_count,
        cat.last_error);

    if (length < 0 || length >= (int)sizeof(json)) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "radio state JSON overflow");
    }
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, json, length);
}

static esp_err_t csi_handler(httpd_req_t *req)
{
    tc358743_status_t tc;
    video_capture_status_t cap;
    tc358743_get_status(&tc);
    video_capture_get_status(&cap);

    const size_t json_capacity = 12288;
    char *json = malloc(json_capacity);
    if (json == NULL) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "out of memory");
    }

    int length = snprintf(
        json, json_capacity,
        "{"
        "\"ok\":%s,"
        "\"version\":\"1.0\","
        "\"source_test_mode\":\"FT-710 800x480p60\","
        "\"tc358743_csi_tx\":{"
            "\"configured\":%s,"
            "\"streaming\":%s,"
            "\"data_lanes\":%u,"
            "\"lane_bit_rate_mbps\":%" PRIu32 ","
            "\"pll_prd\":%u,"
            "\"pll_fbd\":%u,"
            "\"pllctl0_raw\":\"0x%04X\","
            "\"pllctl1_raw\":\"0x%04X\","
            "\"confctl_raw\":\"0x%04X\","
            "\"fifoctl_raw\":%u,"
            "\"csi_status_raw\":\"0x%04X\","
            "\"csi_status_stream_on_raw\":\"0x%04X\","
            "\"csi_status_seen\":\"0x%04X\","
            "\"wsync_seen\":%s,"
            "\"txact_seen\":%s,"
            "\"rxact_seen\":%s,"
            "\"hlt_seen\":%s,"
            "\"csi_control_raw\":\"0x%04X\","
            "\"csi_error_raw\":\"0x%08" PRIX32 "\","
            "\"csi_error_seen\":\"0x%08" PRIX32 "\","
            "\"csi_int_raw\":\"0x%08" PRIX32 "\","
            "\"csi_int_ena_raw\":\"0x%08" PRIX32 "\","
            "\"csi_err_intena_raw\":\"0x%08" PRIX32 "\","
            "\"csi_err_halt_raw\":\"0x%08" PRIX32 "\","
            "\"txoption_raw\":\"0x%08" PRIX32 "\","
            "\"startcntrl_raw\":\"0x%08" PRIX32 "\","
            "\"csi_start_raw\":\"0x%08" PRIX32 "\""
        "},"
        "\"esp32p4_csi_rx\":{"
            "\"ldo_ready\":%s,"
            "\"ldo_channel\":%d,"
            "\"ldo_voltage_mv\":%d,"
            "\"controller_created\":%s,"
            "\"controller_enabled\":%s,"
            "\"controller_started\":%s,"
            "\"isp_bypass_created\":%s,"
            "\"isp_cntl_raw\":\"0x%08" PRIX32 "\","
            "\"callback_get_new_calls\":%" PRIu32 ","
            "\"callback_done_calls\":%" PRIu32 ","
            "\"continuous_running\":%s,"
            "\"recovery\":{"
                "\"in_progress\":%s,"
                "\"attempts\":%" PRIu32 ","
                "\"successes\":%" PRIu32 ","
                "\"failures\":%" PRIu32 ","
                "\"last_recovery_ms\":%" PRIu32
            "},"
            "\"frames_completed\":%" PRIu32 ","
            "\"frames_dropped\":%" PRIu32 ","
            "\"fps_x100\":%" PRIu32 ","
            "\"width\":%u,"
            "\"height\":%u,"
            "\"data_lanes\":%u,"
            "\"lane_bit_rate_mbps\":%" PRIu32 ","
            "\"host_diag_available\":%s,"
            "\"host_version_raw\":\"0x%08" PRIX32 "\","
            "\"host_n_lanes_raw\":\"0x%08" PRIX32 "\","
            "\"host_csi2_resetn_raw\":\"0x%08" PRIX32 "\","
            "\"host_phy_shutdownz_raw\":\"0x%08" PRIX32 "\","
            "\"host_dphy_rstz_raw\":\"0x%08" PRIX32 "\","
            "\"host_phy_rx_raw\":\"0x%08" PRIX32 "\","
            "\"host_phy_stopstate_raw\":\"0x%08" PRIX32 "\","
            "\"clk_active_hs_seen\":%s,"
            "\"clk_not_stop_seen\":%s,"
            "\"data0_activity_seen\":%s,"
            "\"data1_activity_seen\":%s,"
            "\"errors\":{"
                "\"phy\":%s,"
                "\"packet\":%s,"
                "\"frame\":%s,"
                "\"crc\":%s,"
                "\"data_id\":%s,"
                "\"main_seen\":\"0x%08" PRIX32 "\","
                "\"phy_fatal_seen\":\"0x%08" PRIX32 "\","
                "\"phy_seen\":\"0x%08" PRIX32 "\","
                "\"pkt_fatal_seen\":\"0x%08" PRIX32 "\","
                "\"bndry_frame_seen\":\"0x%08" PRIX32 "\","
                "\"seq_frame_seen\":\"0x%08" PRIX32 "\","
                "\"crc_frame_seen\":\"0x%08" PRIX32 "\","
                "\"pld_crc_seen\":\"0x%08" PRIX32 "\","
                "\"data_id_seen\":\"0x%08" PRIX32 "\","
                "\"ecc_corrected_seen\":\"0x%08" PRIX32 "\""
            "},"
            "\"input_data_type\":\"0x24\","
            "\"input_bits_per_pixel\":24,"
            "\"bridge\":{"
                "\"diag_available\":%s,"
                "\"csi_en_raw\":\"0x%08" PRIX32 "\","
                "\"dma_req_cfg_raw\":\"0x%08" PRIX32 "\","
                "\"buf_flow_ctl_raw\":\"0x%08" PRIX32 "\","
                "\"buf_depth_current\":%" PRIu32 ","
                "\"buf_depth_peak\":%" PRIu32 ","
                "\"data_type_cfg_raw\":\"0x%08" PRIX32 "\","
                "\"frame_cfg_raw\":\"0x%08" PRIX32 "\","
                "\"h_pixels\":%" PRIu32 ","
                "\"v_rows\":%" PRIu32 ","
                "\"has_hsync\":%s,"
                "\"vadr_check\":%s,"
                "\"int_raw_seen\":\"0x%08" PRIX32 "\","
                "\"int_st_seen\":\"0x%08" PRIX32 "\","
                "\"dmablk_size_raw\":\"0x%08" PRIX32 "\","
                "\"interrupts\":{"
                    "\"v_rows_gt\":%s,"
                    "\"v_rows_lt\":%s,"
                    "\"discard\":%s,"
                    "\"buf_overrun\":%s,"
                    "\"async_fifo_overflow\":%s,"
                    "\"dma_cfg_updated\":%s"
                "}"
            "}"
        "},"
        "\"frame\":{"
            "\"capture_attempted\":%s,"
            "\"capture_succeeded\":%s,"
            "\"retained\":%s,"
            "\"buffer_count\":%u,"
            "\"buffer_size\":%zu,"
            "\"buffer_total_bytes\":%zu,"
            "\"received_size\":%zu,"
            "\"buffer_address\":\"0x%" PRIXPTR "\","
            "\"ready_buffer_index\":%d,"
            "\"held_buffer_index\":%d,"
            "\"latest_sequence\":%" PRIu32 ","
            "\"snapshot_requests\":%" PRIu32 ","
            "\"snapshot_failures\":%" PRIu32 ","
            "\"crc32_first_frame\":\"0x%08" PRIX32 "\","
            "\"first_32_bytes_hex\":\"%s\""
        "},"
        "\"memory\":{"
            "\"psram_free_before\":%zu,"
            "\"psram_free_after\":%zu"
        "},"
        "\"last_error\":%d"
        "}",
        cap.capture_succeeded ? "true" : "false",
        tc.csi_tx_configured ? "true" : "false",
        tc.csi_streaming ? "true" : "false",
        tc.csi_data_lanes,
        tc.csi_lane_bit_rate_mbps,
        tc.csi_pll_prd,
        tc.csi_pll_fbd,
        tc.csi_pllctl0_raw,
        tc.csi_pllctl1_raw,
        tc.csi_confctl_raw,
        tc.csi_fifoctl_raw,
        tc.csi_status_raw,
        tc.csi_status_stream_on_raw,
        tc.csi_status_seen,
        tc.csi_wsync_seen ? "true" : "false",
        tc.csi_txact_seen ? "true" : "false",
        tc.csi_rxact_seen ? "true" : "false",
        tc.csi_hlt_seen ? "true" : "false",
        tc.csi_control_raw,
        tc.csi_error_raw,
        tc.csi_error_seen,
        tc.csi_int_raw,
        tc.csi_int_ena_raw,
        tc.csi_err_intena_raw,
        tc.csi_err_halt_raw,
        tc.csi_txoption_raw,
        tc.csi_startcntrl_raw,
        tc.csi_start_raw,
        cap.ldo_ready ? "true" : "false",
        cap.ldo_channel,
        cap.ldo_voltage_mv,
        cap.controller_created ? "true" : "false",
        cap.controller_enabled ? "true" : "false",
        cap.controller_started ? "true" : "false",
        cap.isp_bypass_created ? "true" : "false",
        cap.isp_cntl_raw,
        cap.callback_get_new_calls,
        cap.callback_done_calls,
        cap.continuous_running ? "true" : "false",
        cap.recovery_in_progress ? "true" : "false",
        cap.recovery_attempts,
        cap.recovery_successes,
        cap.recovery_failures,
        cap.last_recovery_ms,
        cap.frames_completed,
        cap.frames_dropped,
        cap.fps_x100,
        cap.width,
        cap.height,
        cap.data_lanes,
        cap.lane_bit_rate_mbps,
        cap.host_diag_available ? "true" : "false",
        cap.host_version_raw,
        cap.host_n_lanes_raw,
        cap.host_csi2_resetn_raw,
        cap.host_phy_shutdownz_raw,
        cap.host_dphy_rstz_raw,
        cap.host_phy_rx_raw,
        cap.host_phy_stopstate_raw,
        cap.host_clk_active_hs_seen ? "true" : "false",
        cap.host_clk_not_stop_seen ? "true" : "false",
        cap.host_data0_not_stop_seen ? "true" : "false",
        cap.host_data1_not_stop_seen ? "true" : "false",
        cap.host_phy_error_seen ? "true" : "false",
        cap.host_packet_error_seen ? "true" : "false",
        cap.host_frame_error_seen ? "true" : "false",
        cap.host_crc_error_seen ? "true" : "false",
        cap.host_data_id_error_seen ? "true" : "false",
        cap.host_int_main_seen,
        cap.host_int_phy_fatal_seen,
        cap.host_int_phy_seen,
        cap.host_int_pkt_fatal_seen,
        cap.host_int_bndry_frame_fatal_seen,
        cap.host_int_seq_frame_fatal_seen,
        cap.host_int_crc_frame_fatal_seen,
        cap.host_int_pld_crc_fatal_seen,
        cap.host_int_data_id_seen,
        cap.host_int_ecc_corrected_seen,
        cap.bridge_diag_available ? "true" : "false",
        cap.bridge_csi_en_raw,
        cap.bridge_dma_req_cfg_raw,
        cap.bridge_buf_flow_ctl_raw,
        cap.bridge_buf_depth_current,
        cap.bridge_buf_depth_peak,
        cap.bridge_data_type_cfg_raw,
        cap.bridge_frame_cfg_raw,
        cap.bridge_h_pixels,
        cap.bridge_v_rows,
        cap.bridge_has_hsync ? "true" : "false",
        cap.bridge_vadr_check ? "true" : "false",
        cap.bridge_int_raw_seen,
        cap.bridge_int_st_seen,
        cap.bridge_dmablk_size_raw,
        (cap.bridge_int_raw_seen & (1U << 0)) ? "true" : "false",
        (cap.bridge_int_raw_seen & (1U << 1)) ? "true" : "false",
        (cap.bridge_int_raw_seen & (1U << 2)) ? "true" : "false",
        (cap.bridge_int_raw_seen & (1U << 3)) ? "true" : "false",
        (cap.bridge_int_raw_seen & (1U << 4)) ? "true" : "false",
        (cap.bridge_int_raw_seen & (1U << 5)) ? "true" : "false",
        cap.capture_attempted ? "true" : "false",
        cap.capture_succeeded ? "true" : "false",
        cap.frame_retained ? "true" : "false",
        cap.frame_buffer_count,
        cap.frame_buffer_size,
        cap.frame_buffer_total_bytes,
        cap.received_size,
        cap.frame_buffer_address,
        cap.ready_buffer_index,
        cap.held_buffer_index,
        cap.latest_sequence,
        cap.snapshot_requests,
        cap.snapshot_failures,
        cap.frame_crc32,
        cap.first_32_bytes_hex,
        cap.psram_free_before,
        cap.psram_free_after,
        (int)cap.last_error);

    if (length < 0 || length >= (int)json_capacity) {
        free(json);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "CSI JSON overflow");
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t result = httpd_resp_send(req, json, length);
    free(json);
    return result;
}

esp_err_t web_api_start(void)
{
    if (s_server != NULL) {
        return ESP_OK;
    }

    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = 80;
    config.max_uri_handlers = 80;
    config.max_open_sockets = 14;
    config.backlog_conn = 8;
    config.lru_purge_enable = true;
    config.uri_match_fn = httpd_uri_match_wildcard;
    config.stack_size = 8192;

    esp_err_t err = httpd_start(&s_server, &config);
    if (err != ESP_OK) {
        return err;
    }

    const httpd_uri_t root_uri = {
        .uri = "/",
        .method = HTTP_GET,
        .handler = root_handler,
        .user_ctx = NULL,
    };
    const httpd_uri_t favicon_uri = {
        .uri = "/favicon.ico",
        .method = HTTP_GET,
        .handler = favicon_handler,
        .user_ctx = NULL,
    };
    const httpd_uri_t health_uri = {
        .uri = "/api/v1/health",
        .method = HTTP_GET,
        .handler = health_handler,
        .user_ctx = NULL,
    };
    const httpd_uri_t tc_uri = {
        .uri = "/api/v1/hardware/tc358743",
        .method = HTTP_GET,
        .handler = tc358743_handler,
        .user_ctx = NULL,
    };
    const httpd_uri_t csi_uri = {
        .uri = "/api/v1/hardware/csi",
        .method = HTTP_GET,
        .handler = csi_handler,
        .user_ctx = NULL,
    };
    const httpd_uri_t video_bmp_uri = {
        .uri = "/video.bmp",
        .method = HTTP_GET,
        .handler = video_bmp_handler,
        .user_ctx = NULL,
    };
    const httpd_uri_t video_jpg_uri = {
        .uri = "/video.jpg",
        .method = HTTP_GET,
        .handler = video_jpg_handler,
        .user_ctx = NULL,
    };
    const httpd_uri_t video_mjpeg_uri = {
        .uri = "/video.mjpeg",
        .method = HTTP_GET,
        .handler = video_mjpeg_handler,
        .user_ctx = NULL,
    };
    const httpd_uri_t jpeg_status_uri = {
        .uri = "/api/v1/hardware/jpeg",
        .method = HTTP_GET,
        .handler = jpeg_status_handler,
        .user_ctx = NULL,
    };
    const httpd_uri_t usb_status_uri = {
        .uri = "/api/v1/hardware/usb",
        .method = HTTP_GET,
        .handler = usb_status_handler,
        .user_ctx = NULL,
    };
    const httpd_uri_t cat_status_uri = {
        .uri = "/api/v1/hardware/cat",
        .method = HTTP_GET,
        .handler = cat_status_handler,
        .user_ctx = NULL,
    };
    const httpd_uri_t audio_status_uri = {
        .uri = "/api/v1/hardware/audio",
        .method = HTTP_GET,
        .handler = audio_status_handler,
        .user_ctx = NULL,
    };
    const httpd_uri_t mic_ws_uri = {
        .uri = "/ws/mic",
        .method = HTTP_GET,
        .handler = mic_ws_handler,
        .user_ctx = NULL,
        .is_websocket = true,
        .handle_ws_control_frames = true,
        .ws_post_handshake_cb = mic_ws_post_handshake,
    };
    const httpd_uri_t radio_state_uri = {
        .uri = "/api/v1/radio/state",
        .method = HTTP_GET,
        .handler = radio_state_handler,
        .user_ctx = NULL,
    };

    ESP_ERROR_CHECK(httpd_register_uri_handler(s_server, &root_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_server, &favicon_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_server, &health_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_server, &tc_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_server, &csi_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_server, &video_bmp_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_server, &video_jpg_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_server, &video_mjpeg_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_server, &jpeg_status_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_server, &usb_status_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_server, &cat_status_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_server, &audio_status_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_server, &mic_ws_uri));
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_server, &radio_state_uri));

    err = control_api_register(s_server);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "FreeRig710 control API registration failed: %s", esp_err_to_name(err));
        return err;
    }

    ESP_LOGI(TAG, "HTTP server started on port 80; API=/api/v1/* MJPEG=/video.mjpeg AUDIO_WS=/api/v1/audio/ws max_clients=%u LRU=on",
             (unsigned)config.max_open_sockets);
    return ESP_OK;
}
