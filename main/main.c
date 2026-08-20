#include <inttypes.h>
#include <stdbool.h>

#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_timer.h"

#include "network_eth.h"
#include "ft710_usb.h"
#include "ft710_cat.h"
#include "ft710_audio.h"
#include "ft710_audio_tx.h"
#include "tc358743.h"
#include "video_capture.h"
#include "video_jpeg.h"
#include "web_api.h"
#include "freerig_config.h"
#include "freerig_memories.h"

static const char *TAG = "freerig710";

#define FREERIG_FT710_VIDEO_WIDTH       800U
#define FREERIG_FT710_VIDEO_HEIGHT      480U
#define FREERIG_VIDEO_WAIT_MS           500U
#define FREERIG_VIDEO_WAIT_LOG_MS       5000U
#define FREERIG_VIDEO_STALL_MS          2500U
#define FREERIG_VIDEO_SOURCE_LOST_MS     1000U
#define FREERIG_VIDEO_RECOVERY_BACKOFF_MS 10000U

static bool ft710_video_source_ready(const tc358743_status_t *tc)
{
    return tc != NULL &&
           tc->tmds && tc->sync && tc->timings.valid && !tc->timings.interlaced &&
           tc->timings.active_width == FREERIG_FT710_VIDEO_WIDTH &&
           tc->timings.active_height == FREERIG_FT710_VIDEO_HEIGHT;
}

static void video_bringup_task(void *arg)
{
    (void)arg;
    uint32_t waited_ms = 0;
    bool jpeg_ready = false;
    bool capture_started = false;
    bool saw_radio_down = false;
    uint32_t last_sequence = 0;
    int64_t last_frame_progress_ms = 0;
    int64_t last_recovery_attempt_ms = -((int64_t)FREERIG_VIDEO_RECOVERY_BACKOFF_MS);
    int64_t source_missing_since_ms = 0;

    for (;;) {
        (void)tc358743_refresh_status();
        tc358743_status_t tc;
        tc358743_get_status(&tc);

        ft710_cat_status_t cat;
        ft710_cat_get_status(&cat);
        const bool radio_known_down = cat.initialized && cat.power_known &&
                                      (!cat.radio_power_on || cat.power_starting);
        if (radio_known_down) {
            saw_radio_down = true;
        }

        video_capture_status_t cap;
        video_capture_get_status(&cap);
        const int64_t now_ms = esp_timer_get_time() / 1000LL;
        const bool source_ready = ft710_video_source_ready(&tc);

        if (source_ready) {
            source_missing_since_ms = 0;
        } else if (source_missing_since_ms == 0) {
            source_missing_since_ms = now_ms;
        }

        if (cap.latest_sequence != last_sequence) {
            last_sequence = cap.latest_sequence;
            last_frame_progress_ms = now_ms;
            if (saw_radio_down && cat.initialized && cat.power_known && cat.radio_power_on && !cat.power_starting) {
                ESP_LOGI(TAG, "Video frames active after radio/source cycle; seq=%" PRIu32,
                         cap.latest_sequence);
                saw_radio_down = false;
            }
        }

        /* Radio OFF (or a genuinely lost video source) is handled as an orderly
         * capture teardown.  The P4 CSI peripheral is not expected to survive a
         * disappearing MIPI stream and later be revived in-place.  When the
         * source returns, the normal cold-start path below recreates it. */
        if (capture_started) {
            const bool source_lost_long_enough = !source_ready && source_missing_since_ms > 0 &&
                (now_ms - source_missing_since_ms) >= FREERIG_VIDEO_SOURCE_LOST_MS;
            if (radio_known_down || source_lost_long_enough) {
                ESP_LOGW(TAG,
                         "Video source gone: radio_down=%d source_ready=%d missing=%" PRIi64
                         " ms; fully releasing P4 CSI capture",
                         radio_known_down, source_ready,
                         source_missing_since_ms > 0 ? now_ms - source_missing_since_ms : 0);
                esp_err_t stop_err = video_capture_stop_continuous();
                video_capture_get_status(&cap);
                if (stop_err != ESP_OK) {
                    ESP_LOGW(TAG, "CSI full stop failed: %s", esp_err_to_name(stop_err));
                } else {
                    capture_started = false;
                    last_sequence = 0;
                    last_frame_progress_ms = 0;
                    last_recovery_attempt_ms = now_ms - FREERIG_VIDEO_RECOVERY_BACKOFF_MS;
                    ESP_LOGI(TAG, "P4 CSI released; waiting for a fresh stable FT-710 source");
                }
            }
        }

        if (!capture_started) {
            if (!radio_known_down && source_ready) {
                ESP_LOGI(TAG,
                         "FT-710 video source ready: %ux%u%c ~%" PRIu32 ".%02" PRIu32 " fps; starting CSI capture",
                         tc.timings.active_width,
                         tc.timings.active_height,
                         tc.timings.interlaced ? 'i' : 'p',
                         tc.timings.fps_x100 / 100U,
                         tc.timings.fps_x100 % 100U);

                esp_err_t capture_err = video_capture_start_continuous();
                video_capture_get_status(&cap);
                if (capture_err != ESP_OK && !cap.continuous_running) {
                    ESP_LOGW(TAG, "FT-710 continuous capture start failed: %s; will retry",
                             esp_err_to_name(capture_err));
                    vTaskDelay(pdMS_TO_TICKS(2000));
                    continue;
                }
                capture_started = cap.continuous_running;
                last_sequence = cap.latest_sequence;
                last_frame_progress_ms = now_ms;

                if (capture_err != ESP_OK) {
                    ESP_LOGW(TAG,
                             "CSI capture is running but initial-frame wait returned %s; JPEG will still be initialized",
                             esp_err_to_name(capture_err));
                }

                if (!jpeg_ready) {
                    esp_err_t jpeg_err = video_jpeg_init();
                    if (jpeg_err != ESP_OK) {
                        ESP_LOGW(TAG, "ESP32-P4 hardware JPEG initialization failed: %s",
                                 esp_err_to_name(jpeg_err));
                    } else {
                        jpeg_ready = true;
                        ESP_LOGI(TAG, "FT-710 800x480 hardware JPEG/MJPEG path ready");
                    }
                }
                waited_ms = 0;
            } else if ((waited_ms % FREERIG_VIDEO_WAIT_LOG_MS) == 0U) {
                if (tc.timings.valid) {
                    ESP_LOGW(TAG,
                             "Waiting for FT-710 800x480p source: current=%ux%u%c TMDS=%d SYNC=%d",
                             tc.timings.active_width, tc.timings.active_height,
                             tc.timings.interlaced ? 'i' : 'p', tc.tmds, tc.sync);
                } else {
                    ESP_LOGI(TAG,
                             "Waiting for FT-710 800x480p source: HPD=%d DDC5V=%d TMDS=%d SYNC=%d",
                             tc.hpd_high, tc.ddc_5v, tc.tmds, tc.sync);
                }
            }
        } else if (!radio_known_down && source_ready && cap.continuous_running) {
            const bool stalled = last_frame_progress_ms > 0 &&
                                 (now_ms - last_frame_progress_ms) >= FREERIG_VIDEO_STALL_MS;
            if (stalled && (now_ms - last_recovery_attempt_ms) >= FREERIG_VIDEO_RECOVERY_BACKOFF_MS) {
                last_recovery_attempt_ms = now_ms;
                ESP_LOGW(TAG,
                         "CSI frame stall detected: seq=%" PRIu32 " stalled=%" PRIi64 " ms radio_cycle=%d; recovering",
                         cap.latest_sequence, now_ms - last_frame_progress_ms, saw_radio_down);
                esp_err_t recovery_err = video_capture_recover_continuous();
                video_capture_get_status(&cap);
                capture_started = cap.continuous_running;
                if (recovery_err == ESP_OK && capture_started) {
                    last_sequence = cap.latest_sequence;
                    last_frame_progress_ms = esp_timer_get_time() / 1000LL;
                    saw_radio_down = false;
                    ESP_LOGI(TAG,
                             "Video full-reinit recovery complete: attempts=%" PRIu32 " ok=%" PRIu32 " fail=%" PRIu32,
                             cap.recovery_attempts, cap.recovery_successes, cap.recovery_failures);
                } else {
                    last_sequence = 0;
                    last_frame_progress_ms = 0;
                    ESP_LOGW(TAG,
                             "Video full-reinit recovery failed: %s; capture_running=%d, cold-start path will retry",
                             esp_err_to_name(recovery_err), capture_started);
                }
            }
        }

        vTaskDelay(pdMS_TO_TICKS(FREERIG_VIDEO_WAIT_MS));
        waited_ms += FREERIG_VIDEO_WAIT_MS;
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "FreeRig710 1.0.0 ESP32-P4 firmware");
    ESP_LOGI(TAG, "Target radio: Yaesu FT-710");
    ESP_LOGI(TAG, "FreeRig710 1.0.0 production baseline (FT8.6.5.22 lineage)");
    ESP_LOGI(TAG, "Full CAT control API enabled; UAC1 RX/TX normally full duplex; microphone and automatic FT8 TX suspend UAC RX and CAT BULK IN; latching browser PTT guarded by 1.5 s watchdog; FT8 Tune has a 12 s hard limit; FT8.5.16 automatic slot TX stages the complete 48 kHz waveform before RF; UAC1 OUT uses the 48 kHz mode with 32 one-millisecond 192-byte URBs queued; ESP32 SNTP scheduling + lease + CAT watchdog + hard slot deadline remain authoritative");
    ESP_LOGI(TAG, "Expected FT-710 DVI-D external display mode: 800x480p60");
    ESP_LOGI(TAG, "Diagnostic startup delay: 2000 ms so idf.py monitor can reconnect after flashing");
    vTaskDelay(pdMS_TO_TICKS(2000));

    esp_err_t cfg_err = freerig_config_init();
    if (cfg_err != ESP_OK) {
        ESP_LOGE(TAG, "NVS configuration initialization failed: %s", esp_err_to_name(cfg_err));
    }
    (void)freerig_memories_init();

    esp_err_t tc_err = tc358743_init_and_probe();
    if (tc_err != ESP_OK) {
        ESP_LOGW(TAG, "TC358743 HDMI-RX initialization did not complete successfully: %s",
                 esp_err_to_name(tc_err));
    } else {
        BaseType_t video_task_ok = xTaskCreate(video_bringup_task,
                                                "video_supervisor",
                                                4096,
                                                NULL,
                                                5,
                                                NULL);
        if (video_task_ok != pdPASS) {
            ESP_LOGE(TAG, "Could not create FT-710 video bring-up task");
        }
    }

    esp_err_t eth_err = network_eth_start();
    if (eth_err != ESP_OK) {
        ESP_LOGE(TAG, "Ethernet initialization failed: %s", esp_err_to_name(eth_err));
    }

    esp_err_t http_err = web_api_start();
    if (http_err != ESP_OK) {
        ESP_LOGE(TAG, "HTTP server initialization failed: %s", esp_err_to_name(http_err));
    }

    /*
     * M12.5 keeps the proven NORMAL Waveshare onboard Type-A port (USB HS / BIT0).
     * ESP-IDF initializes the HS/UTMI PHY normally; ft710_usb then sets the
     * DWC2 HCFG.FSLSSUPP host bit before processing root-port events, attempting
     * to prevent High-Speed operation so the FT-710 hub enumerates Full-Speed.
     */
    esp_err_t usb_err = ft710_usb_start();
    if (usb_err != ESP_OK) {
        ESP_LOGE(TAG, "FT-710 USB diagnostic initialization failed: %s", esp_err_to_name(usb_err));
    } else {
        ESP_LOGI(TAG, "FT-710 DWC2 FS/LS-only onboard-Type-A USB diagnostics active");

        esp_err_t cat_err = ft710_cat_start();
        if (cat_err != ESP_OK) {
            ESP_LOGE(TAG, "FT-710 CAT-2 client initialization failed: %s", esp_err_to_name(cat_err));
        } else {
            ESP_LOGI(TAG, "FT-710 CP2105 CAT-2/AUX client started; full serialized CAT API enabled; PTT safety releases TX0 on reconnect");
        }

        esp_err_t audio_err = ft710_audio_start();
        if (audio_err != ESP_OK) {
            ESP_LOGE(TAG, "FT-710 UAC1 RX client initialization failed: %s", esp_err_to_name(audio_err));
        } else {
            ESP_LOGI(TAG, "FT-710 UAC1 RX client started; target 48000 Hz mono S16LE; unified browser WebSocket audio available on /api/v1/audio/ws");
        }

        esp_err_t tx_audio_err = ft710_audio_tx_start();
        if (tx_audio_err != ESP_OK) {
            ESP_LOGE(TAG, "FT-710 UAC1 TX client initialization failed: %s", esp_err_to_name(tx_audio_err));
        } else {
            ESP_LOGI(TAG, "FT-710 UAC1 TX client started; 48000 Hz stereo S16LE with one 192-byte packet per URB; unified browser audio WS=/api/v1/audio/ws; PTT latching + watchdog handled by API");
        }
    }
}
