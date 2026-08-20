#include "video_capture.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "esp_attr.h"
#include "esp_cam_ctlr.h"
#include "esp_cam_ctlr_csi.h"
#include "esp_cam_ctlr_types.h"
#include "driver/isp_core.h"
#include "esp_cache.h"
#include "esp_private/esp_cache_private.h"
#include "esp_heap_caps.h"
#include "esp_ldo_regulator.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hal/mipi_csi_host_ll.h"
#include "hal/mipi_csi_brg_ll.h"
#include "soc/isp_struct.h"

#include "tc358743.h"

static const char *TAG = "video_capture";

#define FREERIG_CSI_WIDTH               800
#define FREERIG_CSI_HEIGHT              480
#define FREERIG_CSI_DATA_LANES         2
#define FREERIG_CSI_LANE_MBPS          972
#define FREERIG_CSI_CAPTURE_TIMEOUT_MS 3000
#define FREERIG_CSI_FRAME_BUFFERS       3
#define FREERIG_CSI_STATS_PERIOD_MS     1000
#define FREERIG_CSI_RECOVERY_HOLD_WAIT_MS 750
#define FREERIG_CSI_STATS_EXIT_WAIT_MS    1500
#define FREERIG_CSI_DT_RGB888           0x24
#define FREERIG_CSI_POLL_MS            100
#define FREERIG_MIPI_LDO_CHANNEL       3
#define FREERIG_MIPI_LDO_MV            2500

static esp_ldo_channel_handle_t s_mipi_ldo;
static esp_cam_ctlr_handle_t s_cam;
static isp_proc_handle_t s_isp_bypass;
static uint8_t *s_frame_buffers[FREERIG_CSI_FRAME_BUFFERS];
static uint32_t s_frame_sequences[FREERIG_CSI_FRAME_BUFFERS];
static uint8_t *s_frame_block;
static size_t s_frame_buffer_size;
static size_t s_frame_buffer_alignment;
static TaskHandle_t s_start_waiter;
static TaskHandle_t s_stats_task;
static volatile uint32_t s_get_new_calls;
static volatile uint32_t s_done_calls;
static volatile uint32_t s_frames_dropped;
static volatile uint32_t s_snapshot_requests;
static volatile uint32_t s_snapshot_failures;
static volatile uint32_t s_sequence;
static volatile bool s_continuous_running;
static volatile bool s_recovery_in_progress;
static volatile uint32_t s_recovery_attempts;
static volatile uint32_t s_recovery_successes;
static volatile uint32_t s_recovery_failures;
static volatile uint32_t s_last_recovery_ms;
static int s_write_fb_idx = -1;
static int s_ready_fb_idx = -1;
static int s_held_fb_idx = -1;
static portMUX_TYPE s_frame_lock = portMUX_INITIALIZER_UNLOCKED;

static video_capture_status_t s_status = {
    .ldo_channel = FREERIG_MIPI_LDO_CHANNEL,
    .ldo_voltage_mv = FREERIG_MIPI_LDO_MV,
    .width = FREERIG_CSI_WIDTH,
    .height = FREERIG_CSI_HEIGHT,
    .data_lanes = FREERIG_CSI_DATA_LANES,
    .lane_bit_rate_mbps = FREERIG_CSI_LANE_MBPS,
    .frame_buffer_count = FREERIG_CSI_FRAME_BUFFERS,
    .ready_buffer_index = -1,
    .held_buffer_index = -1,
    .last_error = ESP_ERR_INVALID_STATE,
};
static portMUX_TYPE s_status_lock = portMUX_INITIALIZER_UNLOCKED;

static void status_store(const video_capture_status_t *status)
{
    portENTER_CRITICAL(&s_status_lock);
    s_status = *status;
    portEXIT_CRITICAL(&s_status_lock);
}

static void status_load(video_capture_status_t *status)
{
    portENTER_CRITICAL(&s_status_lock);
    *status = s_status;
    portEXIT_CRITICAL(&s_status_lock);
}

/*
 * ESP-IDF v6.0.2 configures the CSI host but does not expose the host error
 * interrupt callback that exists in newer ESP-IDF revisions.  The rev1 P4
 * register block is nevertheless public through soc/mipi_csi_host_struct.h.
 * These status registers are read-clear (RC), so every sample ORs them into
 * the retained status before the hardware clears them.
 */
#define P4_CSI_MAIN_PHY_FATAL          (1U << 0)
#define P4_CSI_MAIN_PKT_FATAL          (1U << 1)
#define P4_CSI_MAIN_BNDRY_FRAME_FATAL  (1U << 2)
#define P4_CSI_MAIN_SEQ_FRAME_FATAL    (1U << 3)
#define P4_CSI_MAIN_CRC_FRAME_FATAL    (1U << 4)
#define P4_CSI_MAIN_PLD_CRC_FATAL      (1U << 5)
#define P4_CSI_MAIN_DATA_ID            (1U << 6)
#define P4_CSI_MAIN_ECC_CORRECTED      (1U << 7)
#define P4_CSI_MAIN_PHY                (1U << 16)

#define P4_CSI_PHY_RX_CLK_ACTIVE_HS    (1U << 17)
#define P4_CSI_STOPSTATE_DATA0         (1U << 0)
#define P4_CSI_STOPSTATE_DATA1         (1U << 1)
#define P4_CSI_STOPSTATE_CLK           (1U << 16)

static void p4_csi_host_diag_reset(video_capture_status_t *status)
{
    status->host_diag_available = false;
    status->host_version_raw = 0;
    status->host_n_lanes_raw = 0;
    status->host_csi2_resetn_raw = 0;
    status->host_phy_shutdownz_raw = 0;
    status->host_dphy_rstz_raw = 0;
    status->host_phy_rx_raw = 0;
    status->host_phy_stopstate_raw = 0;
    status->host_clk_active_hs_seen = false;
    status->host_clk_not_stop_seen = false;
    status->host_data0_not_stop_seen = false;
    status->host_data1_not_stop_seen = false;
    status->host_int_main_seen = 0;
    status->host_int_phy_fatal_seen = 0;
    status->host_int_pkt_fatal_seen = 0;
    status->host_int_phy_seen = 0;
    status->host_int_bndry_frame_fatal_seen = 0;
    status->host_int_seq_frame_fatal_seen = 0;
    status->host_int_crc_frame_fatal_seen = 0;
    status->host_int_pld_crc_fatal_seen = 0;
    status->host_int_data_id_seen = 0;
    status->host_int_ecc_corrected_seen = 0;
    status->host_phy_error_seen = false;
    status->host_packet_error_seen = false;
    status->host_frame_error_seen = false;
    status->host_crc_error_seen = false;
    status->host_data_id_error_seen = false;
}

static void p4_csi_host_diag_clear_accumulators(video_capture_status_t *status)
{
    status->host_clk_active_hs_seen = false;
    status->host_clk_not_stop_seen = false;
    status->host_data0_not_stop_seen = false;
    status->host_data1_not_stop_seen = false;
    status->host_int_main_seen = 0;
    status->host_int_phy_fatal_seen = 0;
    status->host_int_pkt_fatal_seen = 0;
    status->host_int_phy_seen = 0;
    status->host_int_bndry_frame_fatal_seen = 0;
    status->host_int_seq_frame_fatal_seen = 0;
    status->host_int_crc_frame_fatal_seen = 0;
    status->host_int_pld_crc_fatal_seen = 0;
    status->host_int_data_id_seen = 0;
    status->host_int_ecc_corrected_seen = 0;
    status->host_phy_error_seen = false;
    status->host_packet_error_seen = false;
    status->host_frame_error_seen = false;
    status->host_crc_error_seen = false;
    status->host_data_id_error_seen = false;
}

static void p4_csi_host_diag_sample(video_capture_status_t *status)
{
    csi_host_dev_t *host = MIPI_CSI_HOST_LL_GET_HW(0);
    if (host == NULL) {
        return;
    }

    status->host_diag_available = true;
    status->host_version_raw = host->version.val;
    status->host_n_lanes_raw = host->n_lanes.val;
    status->host_csi2_resetn_raw = host->csi2_resetn.val;
    status->host_phy_shutdownz_raw = host->phy_shutdownz.val;
    status->host_dphy_rstz_raw = host->dphy_rstz.val;
    status->host_phy_rx_raw = host->phy_rx.val;
    status->host_phy_stopstate_raw = host->phy_stopstate.val;

    if (status->host_phy_rx_raw & P4_CSI_PHY_RX_CLK_ACTIVE_HS) {
        status->host_clk_active_hs_seen = true;
    }
    if (!(status->host_phy_stopstate_raw & P4_CSI_STOPSTATE_CLK)) {
        status->host_clk_not_stop_seen = true;
    }
    if (!(status->host_phy_stopstate_raw & P4_CSI_STOPSTATE_DATA0)) {
        status->host_data0_not_stop_seen = true;
    }
    if (!(status->host_phy_stopstate_raw & P4_CSI_STOPSTATE_DATA1)) {
        status->host_data1_not_stop_seen = true;
    }

    /* Read detailed RC sources first, aggregate/main RC status last. */
    const uint32_t phy_fatal = host->int_st_phy_fatal.val;
    const uint32_t pkt_fatal = host->int_st_pkt_fatal.val;
    const uint32_t phy = host->int_st_phy.val;
    const uint32_t bndry_frame = host->int_st_bndry_frame_fatal.val;
    const uint32_t seq_frame = host->int_st_seq_frame_fatal.val;
    const uint32_t crc_frame = host->int_st_crc_frame_fatal.val;
    const uint32_t pld_crc = host->int_st_pld_crc_fatal.val;
    const uint32_t data_id = host->int_st_data_id.val;
    const uint32_t ecc_corrected = host->int_st_ecc_corrected.val;
    const uint32_t main = host->int_st_main.val;

    status->host_int_phy_fatal_seen |= phy_fatal;
    status->host_int_pkt_fatal_seen |= pkt_fatal;
    status->host_int_phy_seen |= phy;
    status->host_int_bndry_frame_fatal_seen |= bndry_frame;
    status->host_int_seq_frame_fatal_seen |= seq_frame;
    status->host_int_crc_frame_fatal_seen |= crc_frame;
    status->host_int_pld_crc_fatal_seen |= pld_crc;
    status->host_int_data_id_seen |= data_id;
    status->host_int_ecc_corrected_seen |= ecc_corrected;
    status->host_int_main_seen |= main;

    if (phy_fatal || phy || (main & (P4_CSI_MAIN_PHY_FATAL | P4_CSI_MAIN_PHY))) {
        status->host_phy_error_seen = true;
    }
    if (pkt_fatal || ecc_corrected || (main & (P4_CSI_MAIN_PKT_FATAL | P4_CSI_MAIN_ECC_CORRECTED))) {
        status->host_packet_error_seen = true;
    }
    if (bndry_frame || seq_frame || (main & (P4_CSI_MAIN_BNDRY_FRAME_FATAL | P4_CSI_MAIN_SEQ_FRAME_FATAL))) {
        status->host_frame_error_seen = true;
    }
    if (crc_frame || pld_crc || (main & (P4_CSI_MAIN_CRC_FRAME_FATAL | P4_CSI_MAIN_PLD_CRC_FATAL))) {
        status->host_crc_error_seen = true;
    }
    if (data_id || (main & P4_CSI_MAIN_DATA_ID)) {
        status->host_data_id_error_seen = true;
    }
}

static void p4_csi_host_diag_log(const char *prefix, const video_capture_status_t *status)
{
    ESP_LOGI(TAG,
             "%s P4HOST PHY_RX=0x%08" PRIX32 " [CLK_HS=%d] STOP=0x%08" PRIX32
             " [CLK_STOP=%d D0_STOP=%d D1_STOP=%d] MAIN_SEEN=0x%08" PRIX32
             " PHY_FATAL=0x%08" PRIX32 " PHY=0x%08" PRIX32
             " PKT=0x%08" PRIX32 " FRAME=%08" PRIX32 "/%08" PRIX32
             " CRC=%08" PRIX32 "/%08" PRIX32 " DATA_ID=%08" PRIX32 " ECC=%08" PRIX32,
             prefix,
             status->host_phy_rx_raw,
             !!(status->host_phy_rx_raw & P4_CSI_PHY_RX_CLK_ACTIVE_HS),
             status->host_phy_stopstate_raw,
             !!(status->host_phy_stopstate_raw & P4_CSI_STOPSTATE_CLK),
             !!(status->host_phy_stopstate_raw & P4_CSI_STOPSTATE_DATA0),
             !!(status->host_phy_stopstate_raw & P4_CSI_STOPSTATE_DATA1),
             status->host_int_main_seen,
             status->host_int_phy_fatal_seen,
             status->host_int_phy_seen,
             status->host_int_pkt_fatal_seen,
             status->host_int_bndry_frame_fatal_seen,
             status->host_int_seq_frame_fatal_seen,
             status->host_int_crc_frame_fatal_seen,
             status->host_int_pld_crc_fatal_seen,
             status->host_int_data_id_seen,
             status->host_int_ecc_corrected_seen);
}

static void p4_csi_bridge_diag_reset(video_capture_status_t *status)
{
    status->bridge_diag_available = false;
    status->bridge_csi_en_raw = 0;
    status->bridge_dma_req_cfg_raw = 0;
    status->bridge_buf_flow_ctl_raw = 0;
    status->bridge_buf_depth_current = 0;
    status->bridge_buf_depth_peak = 0;
    status->bridge_data_type_cfg_raw = 0;
    status->bridge_frame_cfg_raw = 0;
    status->bridge_h_pixels = 0;
    status->bridge_v_rows = 0;
    status->bridge_has_hsync = false;
    status->bridge_vadr_check = false;
    status->bridge_int_raw_seen = 0;
    status->bridge_int_st_seen = 0;
    status->bridge_dmablk_size_raw = 0;
}

static void p4_csi_bridge_diag_clear_hw(void)
{
    csi_brg_dev_t *bridge = MIPI_CSI_BRG_LL_GET_HW(0);
    if (bridge != NULL) {
        bridge->int_clr.val = 0x3FU;
    }
}

static void p4_csi_bridge_diag_sample(video_capture_status_t *status)
{
    csi_brg_dev_t *bridge = MIPI_CSI_BRG_LL_GET_HW(0);
    if (bridge == NULL) {
        return;
    }

    status->bridge_diag_available = true;
    status->bridge_csi_en_raw = bridge->csi_en.val;
    status->bridge_dma_req_cfg_raw = bridge->dma_req_cfg.val;
    status->bridge_buf_flow_ctl_raw = bridge->buf_flow_ctl.val;
    status->bridge_buf_depth_current = bridge->buf_flow_ctl.csi_buf_depth;
    if (status->bridge_buf_depth_current > status->bridge_buf_depth_peak) {
        status->bridge_buf_depth_peak = status->bridge_buf_depth_current;
    }
    status->bridge_data_type_cfg_raw = bridge->data_type_cfg.val;
    status->bridge_frame_cfg_raw = bridge->frame_cfg.val;
    status->bridge_h_pixels = bridge->frame_cfg.hadr_num;
    status->bridge_v_rows = bridge->frame_cfg.vadr_num;
    status->bridge_has_hsync = bridge->frame_cfg.has_hsync_e;
    status->bridge_vadr_check = bridge->frame_cfg.vadr_num_check;
    status->bridge_int_raw_seen |= bridge->int_raw.val;
    status->bridge_int_st_seen |= bridge->int_st.val;
    status->bridge_dmablk_size_raw = bridge->dmablk_size.val;
}

static void p4_csi_bridge_diag_log(const char *prefix, const video_capture_status_t *status)
{
    ESP_LOGI(TAG,
             "%s P4BRG EN=0x%08" PRIX32 " BUF=%" PRIu32 "/peak=%" PRIu32
             " DT=0x%08" PRIX32 " FRAME=0x%08" PRIX32
             " [H=%" PRIu32 " V=%" PRIu32 " HSYNC=%d VCHK=%d]"
             " INT_RAW_SEEN=0x%08" PRIX32 " INT_ST_SEEN=0x%08" PRIX32
             " DMA_REQ=0x%08" PRIX32 " DMABLK=0x%08" PRIX32,
             prefix,
             status->bridge_csi_en_raw,
             status->bridge_buf_depth_current,
             status->bridge_buf_depth_peak,
             status->bridge_data_type_cfg_raw,
             status->bridge_frame_cfg_raw,
             status->bridge_h_pixels,
             status->bridge_v_rows,
             status->bridge_has_hsync,
             status->bridge_vadr_check,
             status->bridge_int_raw_seen,
             status->bridge_int_st_seen,
             status->bridge_dma_req_cfg_raw,
             status->bridge_dmablk_size_raw);
}

static uint32_t crc32_ieee(const uint8_t *data, size_t length)
{
    uint32_t crc = 0xFFFFFFFFU;
    for (size_t i = 0; i < length; ++i) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; ++bit) {
            const uint32_t mask = (uint32_t)-(int32_t)(crc & 1U);
            crc = (crc >> 1) ^ (0xEDB88320U & mask);
        }
    }
    return ~crc;
}

static void format_first_bytes_hex(char out[65], const uint8_t *data, size_t length)
{
    const size_t count = length < 32 ? length : 32;
    size_t pos = 0;
    for (size_t i = 0; i < count && pos + 2 < 65; ++i) {
        int written = snprintf(out + pos, 65 - pos, "%02X", data[i]);
        if (written != 2) {
            break;
        }
        pos += 2;
    }
    out[pos] = '\0';
}

static int IRAM_ATTR frame_index_from_ptr(const void *ptr)
{
    for (int i = 0; i < FREERIG_CSI_FRAME_BUFFERS; ++i) {
        if (ptr == s_frame_buffers[i]) {
            return i;
        }
    }
    return -1;
}

static bool IRAM_ATTR on_get_new_trans(esp_cam_ctlr_handle_t handle,
                                       esp_cam_ctlr_trans_t *trans,
                                       void *user_data)
{
    (void)handle;
    (void)user_data;
    (void)__sync_add_and_fetch(&s_get_new_calls, 1);

    int pick = -1;
    portENTER_CRITICAL_ISR(&s_frame_lock);
    for (int i = 0; i < FREERIG_CSI_FRAME_BUFFERS; ++i) {
        if (i != s_write_fb_idx && i != s_ready_fb_idx && i != s_held_fb_idx) {
            pick = i;
            break;
        }
    }
    s_write_fb_idx = pick;
    portEXIT_CRITICAL_ISR(&s_frame_lock);

    if (pick >= 0 && trans != NULL) {
        trans->buffer = s_frame_buffers[pick];
        trans->buflen = s_frame_buffer_size;
    } else {
        /* Leave trans->buffer NULL. ESP-IDF then uses its backup framebuffer,
         * keeping the free-running CSI path alive instead of corrupting a held frame. */
        (void)__sync_add_and_fetch(&s_frames_dropped, 1);
    }
    return false;
}

static bool IRAM_ATTR on_trans_finished(esp_cam_ctlr_handle_t handle,
                                        esp_cam_ctlr_trans_t *trans,
                                        void *user_data)
{
    (void)handle;
    (void)user_data;

    const uint32_t done = __sync_add_and_fetch(&s_done_calls, 1);
    (void)done;

    if (trans != NULL && trans->buffer != NULL && trans->received_size == s_frame_buffer_size) {
        const int idx = frame_index_from_ptr(trans->buffer);
        if (idx >= 0) {
            const uint32_t seq = __sync_add_and_fetch(&s_sequence, 1);
            portENTER_CRITICAL_ISR(&s_frame_lock);
            s_frame_sequences[idx] = seq;
            s_ready_fb_idx = idx;
            if (s_write_fb_idx == idx) {
                s_write_fb_idx = -1;
            }
            portEXIT_CRITICAL_ISR(&s_frame_lock);
        }
    }

    BaseType_t high_task_woken = pdFALSE;
    TaskHandle_t waiter = s_start_waiter;
    if (waiter != NULL) {
        vTaskNotifyGiveFromISR(waiter, &high_task_woken);
    }
    return high_task_woken == pdTRUE;
}

static esp_err_t ensure_mipi_ldo(video_capture_status_t *status)
{
    if (s_mipi_ldo != NULL) {
        status->ldo_ready = true;
        return ESP_OK;
    }

    esp_ldo_channel_config_t ldo_config = {
        .chan_id = FREERIG_MIPI_LDO_CHANNEL,
        .voltage_mv = FREERIG_MIPI_LDO_MV,
    };

    esp_err_t err = esp_ldo_acquire_channel(&ldo_config, &s_mipi_ldo);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to enable MIPI DPHY LDO channel %d at %d mV: %s",
                 FREERIG_MIPI_LDO_CHANNEL, FREERIG_MIPI_LDO_MV, esp_err_to_name(err));
        return err;
    }

    status->ldo_ready = true;
    ESP_LOGI(TAG, "MIPI DPHY power enabled: LDO channel %d at %d mV",
             FREERIG_MIPI_LDO_CHANNEL, FREERIG_MIPI_LDO_MV);
    vTaskDelay(pdMS_TO_TICKS(10));
    return ESP_OK;
}

static void reset_frame_ring(void)
{
    portENTER_CRITICAL(&s_frame_lock);
    s_write_fb_idx = -1;
    s_ready_fb_idx = -1;
    s_held_fb_idx = -1;
    for (int i = 0; i < FREERIG_CSI_FRAME_BUFFERS; ++i) {
        s_frame_sequences[i] = 0;
    }
    portEXIT_CRITICAL(&s_frame_lock);
    s_get_new_calls = 0;
    s_done_calls = 0;
    s_frames_dropped = 0;
    s_snapshot_requests = 0;
    s_snapshot_failures = 0;
    s_sequence = 0;
}

static esp_err_t create_csi_controller(video_capture_status_t *status)
{
    if (s_cam != NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    esp_cam_ctlr_csi_config_t csi_config = {
        .ctlr_id = 0,
        .h_res = FREERIG_CSI_WIDTH,
        .v_res = FREERIG_CSI_HEIGHT,
        .data_lane_num = FREERIG_CSI_DATA_LANES,
        .lane_bit_rate_mbps = FREERIG_CSI_LANE_MBPS,
        .clk_src = MIPI_CSI_PHY_CLK_SRC_DEFAULT,
        .input_data_color_type = CAM_CTLR_COLOR_RGB888,
        .output_data_color_type = CAM_CTLR_COLOR_RGB888,
        .queue_items = FREERIG_CSI_FRAME_BUFFERS,
        .input_8bit_swap_en = 0,
        .input_16bit_swap_en = 0,
        .byte_swap_en = 0,
        /* Keep IDF's backup buffer. When all three application buffers are busy,
         * a frame can be dropped safely without stalling the CSI receiver. */
        .bk_buffer_dis = 0,
    };

    esp_err_t err = esp_cam_new_csi_ctlr(&csi_config, &s_cam);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_cam_new_csi_ctlr failed: %s", esp_err_to_name(err));
        return err;
    }
    status->controller_created = true;

    s_frame_buffer_size = (size_t)FREERIG_CSI_WIDTH * (size_t)FREERIG_CSI_HEIGHT * 3U;
    err = esp_cache_get_alignment(MALLOC_CAP_SPIRAM | MALLOC_CAP_DMA, &s_frame_buffer_alignment);
    if (err != ESP_OK || s_frame_buffer_alignment == 0) {
        ESP_LOGE(TAG, "esp_cache_get_alignment failed: %s", esp_err_to_name(err));
        return err != ESP_OK ? err : ESP_ERR_INVALID_STATE;
    }

    s_frame_block = heap_caps_aligned_calloc(s_frame_buffer_alignment,
                                              FREERIG_CSI_FRAME_BUFFERS,
                                              s_frame_buffer_size,
                                              MALLOC_CAP_SPIRAM | MALLOC_CAP_DMA | MALLOC_CAP_8BIT);
    if (s_frame_block == NULL) {
        ESP_LOGE(TAG, "Failed to allocate %ux%zu-byte RGB888 DMA framebuffer ring in PSRAM",
                 FREERIG_CSI_FRAME_BUFFERS, s_frame_buffer_size);
        return ESP_ERR_NO_MEM;
    }
    for (int i = 0; i < FREERIG_CSI_FRAME_BUFFERS; ++i) {
        s_frame_buffers[i] = s_frame_block + ((size_t)i * s_frame_buffer_size);
    }
    reset_frame_ring();

    status->frame_buffer_count = FREERIG_CSI_FRAME_BUFFERS;
    status->frame_buffer_size = s_frame_buffer_size;
    status->frame_buffer_total_bytes = s_frame_buffer_size * FREERIG_CSI_FRAME_BUFFERS;
    status->frame_buffer_address = (uintptr_t)s_frame_buffers[0];
    status->frame_retained = true;
    status->ready_buffer_index = -1;
    status->held_buffer_index = -1;

    esp_cam_ctlr_evt_cbs_t callbacks = {
        .on_get_new_trans = on_get_new_trans,
        .on_trans_finished = on_trans_finished,
    };
    err = esp_cam_ctlr_register_event_callbacks(s_cam, &callbacks, NULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_cam_ctlr_register_event_callbacks failed: %s", esp_err_to_name(err));
        return err;
    }

    ESP_LOGI(TAG,
             "ESP32-P4 CSI controller created: %ux%u RGB888, DT=0x%02X, %u lanes @ %u Mbps/lane, ring=%ux%zu bytes @ %p (align=%zu)",
             FREERIG_CSI_WIDTH, FREERIG_CSI_HEIGHT, FREERIG_CSI_DT_RGB888,
             FREERIG_CSI_DATA_LANES, FREERIG_CSI_LANE_MBPS,
             FREERIG_CSI_FRAME_BUFFERS, s_frame_buffer_size, s_frame_block,
             s_frame_buffer_alignment);
    return ESP_OK;
}

static esp_err_t create_isp_bypass(video_capture_status_t *status)
{
    if (s_isp_bypass != NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    esp_isp_processor_cfg_t isp_cfg = {
        .clk_src = ISP_CLK_SRC_DEFAULT,
        .clk_hz = 80 * 1000000,
        .input_data_source = ISP_INPUT_DATA_SOURCE_CSI,
        .input_data_color_type = ISP_COLOR_RGB888,
        .output_data_color_type = ISP_COLOR_RGB888,
        .yuv_range = ISP_COLOR_RANGE_LIMIT,
        .yuv_std = ISP_YUV_CONV_STD_BT709,
        .has_line_start_packet = false,
        .has_line_end_packet = false,
        .h_res = FREERIG_CSI_WIDTH,
        .v_res = FREERIG_CSI_HEIGHT,
        .bayer_order = COLOR_RAW_ELEMENT_ORDER_BGGR,
        .intr_priority = 0,
        .flags = {
            .bypass_isp = true,
            .byte_swap_en = false,
        },
    };

    esp_err_t err = esp_isp_new_processor(&isp_cfg, &s_isp_bypass);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_isp_new_processor(bypass) failed: %s", esp_err_to_name(err));
        return err;
    }

    ISP.cntl.isp_en = 0;
    status->isp_bypass_created = true;
    status->isp_cntl_raw = ISP.cntl.val;
    ESP_LOGI(TAG, "P4 ISP bypass created: ISP_CNTL=0x%08" PRIX32 " ISP_EN=%u",
             status->isp_cntl_raw, (unsigned)ISP.cntl.isp_en);
    return ESP_OK;
}

static void update_dynamic_status(video_capture_status_t *status)
{
    status->callback_get_new_calls = s_get_new_calls;
    status->callback_done_calls = s_done_calls;
    status->frames_completed = s_done_calls;
    status->frames_dropped = s_frames_dropped;
    status->latest_sequence = s_sequence;
    status->continuous_running = s_continuous_running;
    status->recovery_in_progress = s_recovery_in_progress;
    status->recovery_attempts = s_recovery_attempts;
    status->recovery_successes = s_recovery_successes;
    status->recovery_failures = s_recovery_failures;
    status->last_recovery_ms = s_last_recovery_ms;
    status->snapshot_requests = s_snapshot_requests;
    status->snapshot_failures = s_snapshot_failures;
    if (s_isp_bypass != NULL) {
        status->isp_cntl_raw = ISP.cntl.val;
    }

    portENTER_CRITICAL(&s_frame_lock);
    status->ready_buffer_index = s_ready_fb_idx;
    status->held_buffer_index = s_held_fb_idx;
    if (s_ready_fb_idx >= 0) {
        status->frame_buffer_address = (uintptr_t)s_frame_buffers[s_ready_fb_idx];
        status->received_size = s_frame_buffer_size;
    }
    portEXIT_CRITICAL(&s_frame_lock);

    status->capture_succeeded = (s_done_calls > 0);
}

static void capture_stats_task(void *arg)
{
    (void)arg;
    uint32_t previous_done = s_done_calls;
    int64_t previous_us = esp_timer_get_time();
    uint32_t log_divider = 0;

    while (s_continuous_running) {
        (void)ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(FREERIG_CSI_STATS_PERIOD_MS));
        if (!s_continuous_running) {
            break;
        }
        const uint32_t current_done = s_done_calls;
        const int64_t now_us = esp_timer_get_time();
        const int64_t elapsed_us = now_us - previous_us;
        uint32_t fps_x100 = 0;
        if (elapsed_us > 0) {
            const uint64_t delta = (uint64_t)(current_done - previous_done);
            fps_x100 = (uint32_t)((delta * 100000000ULL) / (uint64_t)elapsed_us);
        }
        previous_done = current_done;
        previous_us = now_us;

        video_capture_status_t status;
        status_load(&status);
        status.fps_x100 = fps_x100;
        update_dynamic_status(&status);
        p4_csi_host_diag_sample(&status);
        p4_csi_bridge_diag_sample(&status);
        status_store(&status);

        if ((++log_divider % 5U) == 0U) {
            ESP_LOGI(TAG,
                     "Continuous CSI: frames=%" PRIu32 " drops=%" PRIu32 " fps=%" PRIu32 ".%02" PRIu32
                     " ready=%d held=%d BUF=%" PRIu32 " errors=%d/%d/%d/%d/%d",
                     status.frames_completed, status.frames_dropped,
                     status.fps_x100 / 100U, status.fps_x100 % 100U,
                     status.ready_buffer_index, status.held_buffer_index,
                     status.bridge_buf_depth_current,
                     status.host_phy_error_seen, status.host_packet_error_seen,
                     status.host_frame_error_seen, status.host_crc_error_seen,
                     status.host_data_id_error_seen);
        }
    }

    s_stats_task = NULL;
    vTaskDelete(NULL);
}

static esp_err_t acquire_latest_frame_internal(video_capture_frame_view_t *out_view, bool count_snapshot);

static esp_err_t wait_for_raw_reader_release(void)
{
    const int64_t hold_deadline_us = esp_timer_get_time() +
        ((int64_t)FREERIG_CSI_RECOVERY_HOLD_WAIT_MS * 1000LL);
    for (;;) {
        int held;
        portENTER_CRITICAL(&s_frame_lock);
        held = s_held_fb_idx;
        portEXIT_CRITICAL(&s_frame_lock);
        if (held < 0) {
            return ESP_OK;
        }
        if (esp_timer_get_time() >= hold_deadline_us) {
            ESP_LOGW(TAG, "CSI teardown aborted: framebuffer still held by processor");
            return ESP_ERR_TIMEOUT;
        }
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}

static esp_err_t wait_for_stats_task_exit(void)
{
    TaskHandle_t stats = s_stats_task;
    if (stats == NULL) {
        return ESP_OK;
    }
    xTaskNotifyGive(stats);
    const int64_t deadline_us = esp_timer_get_time() +
        ((int64_t)FREERIG_CSI_STATS_EXIT_WAIT_MS * 1000LL);
    while (s_stats_task != NULL && esp_timer_get_time() < deadline_us) {
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    if (s_stats_task != NULL) {
        ESP_LOGE(TAG, "CSI statistics task did not exit within %u ms; refusing unsafe controller delete",
                 FREERIG_CSI_STATS_EXIT_WAIT_MS);
        return ESP_ERR_TIMEOUT;
    }
    return ESP_OK;
}

/*
 * Fully dismantle the P4 receive side.  This is intentionally stronger than a
 * stop/start cycle: after the external MIPI clock/data lanes disappear the P4
 * CSI/bridge/DMA state observed on this hardware does not resume reliably.
 * Releasing the controller and recreating it makes the radio OFF->ON path use
 * the same sequence that is already proven at cold boot.
 */
static esp_err_t teardown_capture_path(video_capture_status_t *status)
{
    s_start_waiter = NULL;

    /* Stop callbacks first, then let the periodic diagnostics task leave before
     * deleting the register-owning controller/ISP objects. */
    if (s_cam != NULL && status->controller_started) {
        esp_err_t err = esp_cam_ctlr_stop(s_cam);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "esp_cam_ctlr_stop during teardown: %s (will continue to disable/delete)",
                     esp_err_to_name(err));
        }
        status->controller_started = false;
    }
    s_continuous_running = false;
    status->continuous_running = false;
    esp_err_t stats_err = wait_for_stats_task_exit();
    if (stats_err != ESP_OK) {
        return stats_err;
    }

    if (s_cam != NULL && status->controller_enabled) {
        esp_err_t err = esp_cam_ctlr_disable(s_cam);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "esp_cam_ctlr_disable during teardown: %s (will still try delete)",
                     esp_err_to_name(err));
        }
        status->controller_enabled = false;
    }
    if (s_cam != NULL) {
        esp_err_t err = esp_cam_ctlr_del(s_cam);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "esp_cam_ctlr_del during teardown failed: %s", esp_err_to_name(err));
            /* Do not free buffers underneath a controller that failed to delete. */
            return err;
        }
        s_cam = NULL;
        status->controller_created = false;
    }

    if (s_isp_bypass != NULL) {
        esp_err_t err = esp_isp_del_processor(s_isp_bypass);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "esp_isp_del_processor during teardown failed: %s", esp_err_to_name(err));
            return err;
        }
        s_isp_bypass = NULL;
        status->isp_bypass_created = false;
        status->isp_cntl_raw = 0;
    }

    if (s_frame_block != NULL) {
        heap_caps_free(s_frame_block);
        s_frame_block = NULL;
    }
    memset(s_frame_buffers, 0, sizeof(s_frame_buffers));
    s_frame_buffer_size = 0;
    s_frame_buffer_alignment = 0;
    portENTER_CRITICAL(&s_frame_lock);
    s_write_fb_idx = -1;
    s_ready_fb_idx = -1;
    s_held_fb_idx = -1;
    memset(s_frame_sequences, 0, sizeof(s_frame_sequences));
    portEXIT_CRITICAL(&s_frame_lock);
    s_get_new_calls = 0;
    s_done_calls = 0;
    s_frames_dropped = 0;
    s_sequence = 0;

    status->frame_retained = false;
    status->frame_buffer_size = 0;
    status->frame_buffer_total_bytes = 0;
    status->frame_buffer_address = 0;
    status->ready_buffer_index = -1;
    status->held_buffer_index = -1;
    status->received_size = 0;
    status->latest_sequence = 0;
    status->frames_completed = 0;
    status->frames_dropped = 0;
    status->fps_x100 = 0;
    status->capture_succeeded = false;
    return ESP_OK;
}

static void cleanup_failed_start(video_capture_status_t *status)
{
    (void)teardown_capture_path(status);
    (void)tc358743_set_csi_streaming(false);
}

esp_err_t video_capture_start_continuous(void)
{
    video_capture_status_t status;
    status_load(&status);
    if (s_continuous_running || s_cam != NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    status.capture_attempted = true;
    status.capture_succeeded = false;
    status.continuous_running = false;
    status.received_size = 0;
    status.frame_crc32 = 0;
    status.first_32_bytes_hex[0] = '\0';
    status.frames_completed = 0;
    status.frames_dropped = 0;
    status.fps_x100 = 0;
    status.snapshot_requests = 0;
    status.snapshot_failures = 0;
    p4_csi_host_diag_reset(&status);
    p4_csi_bridge_diag_reset(&status);
    status.psram_free_before = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    status.last_error = ESP_FAIL;
    status_store(&status);

    tc358743_status_t tc;
    tc358743_get_status(&tc);
    if (!tc.timings.valid || !tc.tmds || !tc.sync || tc.timings.interlaced ||
        tc.timings.active_width != FREERIG_CSI_WIDTH ||
        tc.timings.active_height != FREERIG_CSI_HEIGHT) {
        status.last_error = ESP_ERR_INVALID_STATE;
        status_store(&status);
        ESP_LOGE(TAG, "Cannot start continuous capture: stable FT-710 800x480p HDMI/DVI input is required");
        return ESP_ERR_INVALID_STATE;
    }

    esp_err_t err = ensure_mipi_ldo(&status);
    if (err != ESP_OK) {
        goto fail;
    }

    err = tc358743_configure_csi_tx_rgb888_2lane_972();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "TC358743 CSI TX configuration failed: %s", esp_err_to_name(err));
        goto fail;
    }

    /* Keep the exact startup order that produced the first valid frame in M5.5. */
    err = tc358743_prepare_csi_source_before_p4(5000);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "TC358743 pre-P4 stream/HPD retrain failed: %s", esp_err_to_name(err));
        goto fail;
    }

    tc358743_get_status(&tc);
    if (!tc.timings.valid || !tc.tmds || !tc.sync || tc.timings.interlaced ||
        tc.timings.active_width != FREERIG_CSI_WIDTH ||
        tc.timings.active_height != FREERIG_CSI_HEIGHT) {
        err = ESP_ERR_INVALID_STATE;
        ESP_LOGE(TAG, "TC358743 source not stable after pre-P4 retrain");
        goto fail;
    }

    err = create_csi_controller(&status);
    if (err != ESP_OK) {
        goto fail;
    }
    status.psram_free_after = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);

    err = esp_cam_ctlr_enable(s_cam);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_cam_ctlr_enable failed: %s", esp_err_to_name(err));
        goto fail;
    }
    status.controller_enabled = true;

    err = create_isp_bypass(&status);
    if (err != ESP_OK) {
        goto fail;
    }

    csi_brg_dev_t *bridge = MIPI_CSI_BRG_LL_GET_HW(0);
    if (bridge == NULL) {
        err = ESP_ERR_INVALID_STATE;
        ESP_LOGE(TAG, "P4 MIPI_CSI_BRIDGE register block unavailable");
        goto fail;
    }
    bridge->frame_cfg.hadr_num = FREERIG_CSI_WIDTH;
    bridge->frame_cfg.vadr_num = FREERIG_CSI_HEIGHT;
    bridge->frame_cfg.has_hsync_e = 0;
    bridge->frame_cfg.vadr_num_check = 0;
    bridge->data_type_cfg.data_type_min = FREERIG_CSI_DT_RGB888;
    bridge->data_type_cfg.data_type_max = FREERIG_CSI_DT_RGB888;
    bridge->int_clr.val = 0x3FU;

    p4_csi_host_diag_sample(&status);
    p4_csi_host_diag_clear_accumulators(&status);
    p4_csi_bridge_diag_clear_hw();
    p4_csi_bridge_diag_sample(&status);

    s_start_waiter = xTaskGetCurrentTaskHandle();
    (void)ulTaskNotifyTake(pdTRUE, 0);

    ESP_LOGI(TAG,
             "M6.1 start order: TC_STREAMING=1 -> P4_ENABLED=1 -> ISP_BYPASS=1 -> BRIDGE_OVERRIDE -> P4_START");

    err = esp_cam_ctlr_start(s_cam);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_cam_ctlr_start failed: %s", esp_err_to_name(err));
        goto fail;
    }
    status.controller_started = true;
    s_continuous_running = true;
    status.continuous_running = true;
    status.last_error = ESP_OK;
    update_dynamic_status(&status);
    status_store(&status);

    ESP_LOGI(TAG,
             "Continuous CSI capture started: %ux%u RGB888, %u buffers, %zu bytes/frame",
             FREERIG_CSI_WIDTH, FREERIG_CSI_HEIGHT,
             FREERIG_CSI_FRAME_BUFFERS, s_frame_buffer_size);

    const uint32_t notified = ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(FREERIG_CSI_CAPTURE_TIMEOUT_MS));
    s_start_waiter = NULL;

    if (notified != 0) {
        video_capture_frame_view_t first = {0};
        if (acquire_latest_frame_internal(&first, false) == ESP_OK) {
            status_load(&status);
            status.frame_crc32 = crc32_ieee(first.data, first.size);
            format_first_bytes_hex(status.first_32_bytes_hex, first.data, first.size);
            status.capture_succeeded = true;
            status.received_size = first.size;
            status.frame_buffer_address = (uintptr_t)first.data;
            status.latest_sequence = first.sequence;
            status.last_error = ESP_OK;
            video_capture_release_frame(&first);
            p4_csi_host_diag_sample(&status);
            p4_csi_bridge_diag_sample(&status);
            update_dynamic_status(&status);
            status_store(&status);
            ESP_LOGI(TAG,
                     "FIRST CONTINUOUS CSI FRAME: %zu bytes seq=%" PRIu32 " CRC32=0x%08" PRIX32
                     " first32=%s",
                     first.size, first.sequence, status.frame_crc32, status.first_32_bytes_hex);
            p4_csi_host_diag_log("M6.1 first-frame host", &status);
            p4_csi_bridge_diag_log("M6.1 first-frame bridge", &status);
        }
    } else {
        status_load(&status);
        status.last_error = ESP_ERR_TIMEOUT;
        update_dynamic_status(&status);
        status_store(&status);
        ESP_LOGW(TAG, "No CSI completion during initial %d ms window; capture remains running for diagnostics",
                 FREERIG_CSI_CAPTURE_TIMEOUT_MS);
        err = ESP_ERR_TIMEOUT;
    }

    if (s_stats_task == NULL) {
        BaseType_t task_ok = xTaskCreate(capture_stats_task, "csi_stats", 4096, NULL, 4, &s_stats_task);
        if (task_ok != pdPASS) {
            ESP_LOGW(TAG, "Could not create CSI statistics task; continuous capture remains active");
            s_stats_task = NULL;
        }
    }

    return notified != 0 ? ESP_OK : err;

fail:
    status.last_error = err;
    status.psram_free_after = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    cleanup_failed_start(&status);
    status_store(&status);
    return err;
}

esp_err_t video_capture_stop_continuous(void)
{
    video_capture_status_t status;
    status_load(&status);

    portENTER_CRITICAL(&s_frame_lock);
    if (s_recovery_in_progress) {
        portEXIT_CRITICAL(&s_frame_lock);
        return ESP_ERR_INVALID_STATE;
    }
    s_recovery_in_progress = true;
    portEXIT_CRITICAL(&s_frame_lock);

    esp_err_t err = wait_for_raw_reader_release();
    if (err == ESP_OK) {
        err = teardown_capture_path(&status);
        (void)tc358743_set_csi_streaming(false);
    }

    portENTER_CRITICAL(&s_frame_lock);
    s_recovery_in_progress = false;
    portEXIT_CRITICAL(&s_frame_lock);
    status.last_error = err;
    update_dynamic_status(&status);
    status_store(&status);

    if (err == ESP_OK) {
        ESP_LOGI(TAG, "CSI capture path fully stopped/released; next start will cold-recreate P4 CSI");
    }
    return err;
}

esp_err_t video_capture_recover_continuous(void)
{
    if (s_cam == NULL || !s_continuous_running) {
        return ESP_ERR_INVALID_STATE;
    }

    /* Only rebuild after the bridge reports that the FT-710 source is back and
     * stable.  The subsequent start routine performs the proven TC retrain too. */
    esp_err_t err = tc358743_refresh_status();
    if (err != ESP_OK) {
        return err;
    }
    tc358743_status_t tc;
    tc358743_get_status(&tc);
    if (!tc.timings.valid || !tc.tmds || !tc.sync || tc.timings.interlaced ||
        tc.timings.active_width != FREERIG_CSI_WIDTH ||
        tc.timings.active_height != FREERIG_CSI_HEIGHT) {
        return ESP_ERR_INVALID_STATE;
    }

    portENTER_CRITICAL(&s_frame_lock);
    if (s_recovery_in_progress) {
        portEXIT_CRITICAL(&s_frame_lock);
        return ESP_ERR_INVALID_STATE;
    }
    s_recovery_in_progress = true;
    portEXIT_CRITICAL(&s_frame_lock);
    (void)__sync_add_and_fetch(&s_recovery_attempts, 1);

    err = wait_for_raw_reader_release();
    if (err != ESP_OK) {
        goto recovery_done;
    }

    ESP_LOGW(TAG,
             "CSI recovery: source stable but frames stalled; FULL P4 teardown/recreate (stop/disable/del -> new/enable/start)");

    video_capture_status_t status;
    status_load(&status);
    err = teardown_capture_path(&status);
    (void)tc358743_set_csi_streaming(false);
    status.last_error = err;
    update_dynamic_status(&status);
    status_store(&status);
    if (err != ESP_OK) {
        goto recovery_done;
    }

    /* Keep s_recovery_in_progress asserted while the buffers/controller are
     * replaced so MJPEG/JPEG consumers cannot acquire a half-rebuilt ring. */
    err = video_capture_start_continuous();
    if (err == ESP_OK) {
        (void)__sync_add_and_fetch(&s_recovery_successes, 1);
    }

recovery_done:
    if (err != ESP_OK) {
        (void)__sync_add_and_fetch(&s_recovery_failures, 1);
    }
    s_last_recovery_ms = (uint32_t)(esp_timer_get_time() / 1000LL);
    portENTER_CRITICAL(&s_frame_lock);
    s_recovery_in_progress = false;
    portEXIT_CRITICAL(&s_frame_lock);

    {
        video_capture_status_t status;
        status_load(&status);
        status.last_error = err;
        update_dynamic_status(&status);
        status_store(&status);
    }

    if (err == ESP_OK) {
        ESP_LOGI(TAG, "CSI full-reinit recovery successful: sequence=%" PRIu32, s_sequence);
    } else {
        ESP_LOGW(TAG, "CSI full-reinit recovery failed: %s", esp_err_to_name(err));
    }
    return err;
}

esp_err_t video_capture_capture_one_frame(void)
{
    return video_capture_start_continuous();
}

static esp_err_t acquire_latest_frame_internal(video_capture_frame_view_t *out_view, bool count_snapshot)
{
    if (out_view == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    memset(out_view, 0, sizeof(*out_view));
    if (count_snapshot) {
        (void)__sync_add_and_fetch(&s_snapshot_requests, 1);
    }

    int idx = -1;
    uint32_t seq = 0;
    portENTER_CRITICAL(&s_frame_lock);
    if (!s_recovery_in_progress && s_held_fb_idx < 0 && s_ready_fb_idx >= 0) {
        idx = s_ready_fb_idx;
        s_held_fb_idx = idx;
        seq = s_frame_sequences[idx];
    }
    portEXIT_CRITICAL(&s_frame_lock);

    if (idx < 0) {
        if (count_snapshot) {
            (void)__sync_add_and_fetch(&s_snapshot_failures, 1);
        }
        return ESP_ERR_NOT_FOUND;
    }

    out_view->data = s_frame_buffers[idx];
    out_view->size = s_frame_buffer_size;
    out_view->width = FREERIG_CSI_WIDTH;
    out_view->height = FREERIG_CSI_HEIGHT;
    out_view->sequence = seq;
    return ESP_OK;
}

esp_err_t video_capture_acquire_latest_frame(video_capture_frame_view_t *out_view)
{
    return acquire_latest_frame_internal(out_view, true);
}

esp_err_t video_capture_acquire_latest_frame_for_processing(video_capture_frame_view_t *out_view)
{
    return acquire_latest_frame_internal(out_view, false);
}

void video_capture_release_frame(const video_capture_frame_view_t *view)
{
    if (view == NULL || view->data == NULL) {
        return;
    }
    const int idx = frame_index_from_ptr(view->data);
    if (idx < 0) {
        return;
    }

    portENTER_CRITICAL(&s_frame_lock);
    if (s_held_fb_idx == idx) {
        s_held_fb_idx = -1;
    }
    portEXIT_CRITICAL(&s_frame_lock);
}

void video_capture_get_status(video_capture_status_t *out_status)
{
    if (out_status == NULL) {
        return;
    }
    status_load(out_status);
    update_dynamic_status(out_status);
}
