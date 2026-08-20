#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define FT710_CAT_RESPONSE_MAX 128

/**
 * CAT transport + radio state snapshot.
 *
 * The CP2105 CAT-2/AUX interface is the single owner of all Yaesu CAT traffic.
 * All setters/queries issued by HTTP/WebSocket clients are serialized inside
 * the CAT USB task, so the continuous RX transfer and the poller never race.
 */
typedef struct {
    bool initialized;
    bool client_registered;
    bool cp2105_found;
    bool device_open;
    bool interface_claimed;
    bool uart_enabled;
    bool configured_115200_8n1;
    bool dtr_rts_forced_low;
    bool rx_running;
    bool ai_disabled;
    bool id_query_sent;
    bool id_query_ok;

    bool state_valid;
    bool power_known;
    bool radio_power_on;
    bool power_starting;
    uint8_t consecutive_poll_failures;
    uint64_t power_transition_deadline_ms;
    bool split_known;
    bool split_enabled;

    uint8_t device_address;
    uint8_t interface_number;
    uint8_t bulk_in_ep;
    uint8_t bulk_out_ep;
    uint16_t bulk_in_mps;
    uint16_t bulk_out_mps;
    uint32_t baudrate;

    char radio_id[16];
    uint32_t frequency_hz;
    uint32_t vfo_a_hz;
    uint32_t vfo_b_hz;
    char active_vfo[2];
    char mode[16];
    char vfo_a_mode[16];
    char vfo_b_mode[16];

    /* Full UI state mirrored from the FT-710 CAT-2 port. */
    int tx_power_w;
    char rf_sql_vr[8];
    int rf_gain;
    int squelch_level;
    char agc[8];
    char tuner[12];
    bool hi_swr;
    char tx_state[16];
    bool tuner_busy;
    bool squelch_open;
    char preamp[8];
    int attenuator_db;
    int width_code;
    int if_shift_hz;
    bool manual_notch;
    int manual_notch_hz;
    bool contour;
    int contour_hz;
    bool dnr;
    int dnr_level;
    bool noise_blanker;
    int noise_blanker_level;
    bool auto_notch;
    char meter_display[8];
    char scope_mode[40];
    char scope_speed[16];
    char scope_span[16];

    /* Voice PTT is latching from the UI, but guarded by a keepalive watchdog. */
    bool ptt_active;
    uint64_t ptt_deadline_ms;

    /* Production TX isolation: CAT BULK IN is halted/flushed while RF audio
     * is active so it cannot contend with UAC isochronous OUT scheduling. */
    bool tx_quiet_requested;
    bool tx_quiet_active;
    uint32_t ptt_watchdog_releases;

    uint32_t control_ok_count;
    uint32_t control_error_count;
    uint32_t bulk_in_count;
    uint32_t bulk_out_count;
    uint32_t rx_bytes;
    uint32_t tx_bytes;
    uint32_t disconnect_count;
    uint32_t state_poll_count;
    uint32_t state_poll_error_count;
    uint32_t optional_poll_error_count;
    uint32_t external_command_count;
    uint32_t external_command_error_count;
    uint64_t state_updated_ms;
    int last_error;

    char last_command[64];
    char last_response[FT710_CAT_RESPONSE_MAX];
} ft710_cat_status_t;

/** Start the FT-710 CAT-2/AUX CP2105 client. USB Host must already be installed. */
esp_err_t ft710_cat_start(void);

/** Copy current CAT/status state. */
void ft710_cat_get_status(ft710_cat_status_t *status);

/**
 * Serialize a raw CAT transaction through the CAT USB task.
 * command must include (or will be normalized to include) the trailing ';'.
 * When expect_reply is false response may be NULL.
 */
esp_err_t ft710_cat_exchange(const char *command,
                             bool expect_reply,
                             char *response,
                             size_t response_size,
                             uint32_t timeout_ms);

/** Convenience setter/query wrappers. */
esp_err_t ft710_cat_set(const char *command, uint32_t timeout_ms);
esp_err_t ft710_cat_query(const char *command, char *response, size_t response_size, uint32_t timeout_ms);

/** Power control with local OFF/STARTING state tracking. */
esp_err_t ft710_cat_set_power(bool enabled, uint32_t timeout_ms);

/** Latching PTT API. TX remains active while keepalives refresh the 1.5 s watchdog. */
esp_err_t ft710_cat_set_ptt(bool enabled, uint32_t timeout_ms);
void ft710_cat_ptt_keepalive(void);
esp_err_t ft710_cat_force_ptt_off(uint32_t timeout_ms);

/** Halt/flush the continuous CP2105 BULK IN endpoint during a diagnostic TX.
 *  The CAT OUT endpoint and local PTT watchdog remain available, so TX0 can
 *  still be sent.  Passing false clears the endpoint halt and restarts RX. */
esp_err_t ft710_cat_set_tx_quiet(bool quiet, uint32_t timeout_ms);

#ifdef __cplusplus
}
#endif
