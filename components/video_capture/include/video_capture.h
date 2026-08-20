#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool ldo_ready;
    int ldo_channel;
    int ldo_voltage_mv;

    bool controller_created;
    bool controller_enabled;
    bool controller_started;
    bool isp_bypass_created;
    uint32_t isp_cntl_raw;
    uint32_t callback_get_new_calls;
    uint32_t callback_done_calls;

    bool capture_attempted;
    bool capture_succeeded;
    bool frame_retained;
    bool continuous_running;
    bool recovery_in_progress;
    uint32_t recovery_attempts;
    uint32_t recovery_successes;
    uint32_t recovery_failures;
    uint32_t last_recovery_ms;

    uint16_t width;
    uint16_t height;
    uint8_t data_lanes;
    uint32_t lane_bit_rate_mbps;

    uint8_t frame_buffer_count;
    size_t frame_buffer_size;
    size_t frame_buffer_total_bytes;
    size_t received_size;
    uintptr_t frame_buffer_address;
    int ready_buffer_index;
    int held_buffer_index;
    uint32_t latest_sequence;
    uint32_t frames_completed;
    uint32_t frames_dropped;
    uint32_t fps_x100;
    uint32_t snapshot_requests;
    uint32_t snapshot_failures;

    /* ESP32-P4 CSI host / D-PHY diagnostics (HW rev1 register block). */
    bool host_diag_available;
    uint32_t host_version_raw;
    uint32_t host_n_lanes_raw;
    uint32_t host_csi2_resetn_raw;
    uint32_t host_phy_shutdownz_raw;
    uint32_t host_dphy_rstz_raw;
    uint32_t host_phy_rx_raw;
    uint32_t host_phy_stopstate_raw;

    bool host_clk_active_hs_seen;
    bool host_clk_not_stop_seen;
    bool host_data0_not_stop_seen;
    bool host_data1_not_stop_seen;

    uint32_t host_int_main_seen;
    uint32_t host_int_phy_fatal_seen;
    uint32_t host_int_pkt_fatal_seen;
    uint32_t host_int_phy_seen;
    uint32_t host_int_bndry_frame_fatal_seen;
    uint32_t host_int_seq_frame_fatal_seen;
    uint32_t host_int_crc_frame_fatal_seen;
    uint32_t host_int_pld_crc_fatal_seen;
    uint32_t host_int_data_id_seen;
    uint32_t host_int_ecc_corrected_seen;

    bool host_phy_error_seen;
    bool host_packet_error_seen;
    bool host_frame_error_seen;
    bool host_crc_error_seen;
    bool host_data_id_error_seen;

    /* ESP32-P4 CSI bridge diagnostics. */
    bool bridge_diag_available;
    uint32_t bridge_csi_en_raw;
    uint32_t bridge_dma_req_cfg_raw;
    uint32_t bridge_buf_flow_ctl_raw;
    uint32_t bridge_buf_depth_current;
    uint32_t bridge_buf_depth_peak;
    uint32_t bridge_data_type_cfg_raw;
    uint32_t bridge_frame_cfg_raw;
    uint32_t bridge_h_pixels;
    uint32_t bridge_v_rows;
    bool bridge_has_hsync;
    bool bridge_vadr_check;
    uint32_t bridge_int_raw_seen;
    uint32_t bridge_int_st_seen;
    uint32_t bridge_dmablk_size_raw;

    uint32_t frame_crc32;
    char first_32_bytes_hex[65];

    size_t psram_free_before;
    size_t psram_free_after;

    esp_err_t last_error;
} video_capture_status_t;

typedef struct {
    const uint8_t *data;
    size_t size;
    uint16_t width;
    uint16_t height;
    uint32_t sequence;
} video_capture_frame_view_t;

/* Milestone 6.1: start and keep the proven RGB888 CSI path running. */
esp_err_t video_capture_start_continuous(void);

/* Stop and fully release the P4 CSI capture path while keeping the MIPI LDO.
 * Safe to call when the FT-710/source disappears; blocks new frame consumers,
 * waits for the current raw-frame reader, then stop/disable/delete controller,
 * ISP bypass and framebuffer ring. */
esp_err_t video_capture_stop_continuous(void);

/* Recovery path for a source that disappeared and later returned.
 * ESP32-P4 CSI is rebuilt from the same proven cold-start sequence instead of
 * trying to restart a controller that has already lost the MIPI stream. */
esp_err_t video_capture_recover_continuous(void);

/* Backward-compatible alias retained for earlier bring-up callers. */
esp_err_t video_capture_capture_one_frame(void);

/* Hold the newest completed framebuffer so a consumer can read it safely. */
esp_err_t video_capture_acquire_latest_frame(video_capture_frame_view_t *out_view);
/* Hold the newest frame for an internal processor without counting a BMP snapshot request. */
esp_err_t video_capture_acquire_latest_frame_for_processing(video_capture_frame_view_t *out_view);
void video_capture_release_frame(const video_capture_frame_view_t *view);

void video_capture_get_status(video_capture_status_t *out_status);

#ifdef __cplusplus
}
#endif
