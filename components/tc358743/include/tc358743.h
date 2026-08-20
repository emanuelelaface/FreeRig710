#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define TC358743_MAX_DISCOVERED_I2C_DEVICES 16

typedef struct {
    bool valid;
    bool interlaced;
    uint16_t active_width;
    uint16_t active_height;
    uint16_t frame_width;
    uint16_t frame_height;
    uint16_t h_blanking;
    uint16_t v_blanking;
    uint16_t frame_interval_100us;
    uint32_t fps_x100;
    uint32_t pixel_clock_hz;
} tc358743_timings_t;

typedef struct {
    bool bus_ready;
    bool found;
    uint8_t address;

    uint16_t chip_id_raw;
    uint8_t chip_id;
    uint8_t revision;

    bool sys_status_valid;
    uint8_t sys_status_raw;
    bool sync;
    bool avmute;
    bool hdmi;
    bool phy_scdt;
    bool phy_pll;
    bool tmds;
    bool ddc_5v;

    bool edid_programmed;
    bool edid_verified;
    bool edid_verify_failed;
    uint16_t edid_verify_mismatch_offset;
    uint8_t edid_verify_expected;
    uint8_t edid_verify_actual;
    uint16_t edid_length;
    uint8_t edid_blocks;
    uint8_t edid_len1_readback;
    uint8_t edid_len2_readback;
    uint8_t edid_mode_raw;
    bool hpd_high;
    uint8_t hpd_ctl_raw;
    bool hpd_control_enabled;

    uint8_t sys_int_raw;
    uint8_t clk_int_raw;
    uint8_t misc_int_raw;
    uint8_t hdmi_int0_raw;
    uint8_t hdmi_int1_raw;
    uint8_t sys_int_seen;
    uint8_t clk_int_seen;
    uint8_t misc_int_seen;
    uint8_t hdmi_int0_seen;
    uint8_t hdmi_int1_seen;
    uint8_t sys_int_mask_raw;
    uint8_t clk_int_mask_raw;
    uint8_t misc_int_mask_raw;
    bool ddc_action;
    bool ddc_ack_polarity;
    uint8_t sys_clk_raw;
    uint8_t ana_ctl_raw;
    uint8_t init_end_raw;

    uint16_t sys_freq_raw;
    uint32_t reference_clock_hz;
    bool timing_reference_programmed;

    bool hdmi_receiver_configured;
    uint16_t sysctl_raw;
    uint8_t ddc_ctl_raw;
    uint8_t phy_ctl0_raw;
    uint8_t phy_ctl1_raw;
    uint8_t phy_ctl2_raw;
    uint8_t phy_en_raw;
    uint8_t phy_bias_raw;
    uint8_t phy_csq_raw;
    uint8_t hdmi_det_raw;
    uint8_t hv_rst_raw;
    uint16_t fh_min_raw;
    uint16_t fh_max_raw;
    uint32_t lockdet_ref_raw;
    uint8_t nco_f0_mod_raw;
    uint8_t phy_reset_count;

    /* Milestone 5: TC358743 CSI-2 transmitter state. */
    bool csi_tx_configured;
    bool csi_streaming;
    uint8_t csi_data_lanes;
    uint32_t csi_lane_bit_rate_mbps;
    uint16_t csi_pll_prd;
    uint16_t csi_pll_fbd;
    uint16_t csi_pllctl0_raw;
    uint16_t csi_pllctl1_raw;
    uint16_t csi_confctl_raw;
    uint16_t csi_fifoctl_raw;
    uint16_t csi_status_raw;
    uint16_t csi_status_seen;
    uint16_t csi_status_stream_on_raw;
    bool csi_wsync_seen;
    bool csi_txact_seen;
    bool csi_rxact_seen;
    bool csi_hlt_seen;
    uint16_t csi_control_raw;
    uint32_t csi_error_raw;
    uint32_t csi_error_seen;
    uint32_t csi_int_raw;
    uint32_t csi_int_ena_raw;
    uint32_t csi_err_intena_raw;
    uint32_t csi_err_halt_raw;
    uint32_t csi_txoption_raw;
    uint32_t csi_startcntrl_raw;
    uint32_t csi_start_raw;

    tc358743_timings_t timings;

    uint8_t discovered_addresses[TC358743_MAX_DISCOVERED_I2C_DEVICES];
    size_t discovered_count;
    bool discovered_truncated;

    esp_err_t last_error;
} tc358743_status_t;

esp_err_t tc358743_init_and_probe(void);
void tc358743_get_status(tc358743_status_t *out_status);
/* Refresh live HDMI/DVI + CSI transmitter state from hardware, then retain it. */
esp_err_t tc358743_refresh_status(void);

/* Milestone 5: configure and gate the bridge CSI-2 transmitter. */
esp_err_t tc358743_configure_csi_tx_rgb888_2lane_972(void);
esp_err_t tc358743_set_csi_streaming(bool enable);
/* M5.5: reproduce ESP-KVM startup tail so the TC358743 is already emitting MIPI before P4 CSI starts. */
esp_err_t tc358743_prepare_csi_source_before_p4(uint32_t lock_timeout_ms);
esp_err_t tc358743_sample_csi_activity(void);

#ifdef __cplusplus
}
#endif
