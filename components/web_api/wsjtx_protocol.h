#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define WSJTX_PROTOCOL_MAGIC 0xADBCCBDAU
#define WSJTX_PROTOCOL_SCHEMA 3U
#define WSJTX_PROTOCOL_MAX_PACKET 1536U
#define WSJTX_PROTOCOL_ID "FreeRig710"

typedef enum {
    WSJTX_MESSAGE_HEARTBEAT = 0,
    WSJTX_MESSAGE_STATUS = 1,
    WSJTX_MESSAGE_DECODE = 2,
    WSJTX_MESSAGE_CLEAR = 3,
    WSJTX_MESSAGE_REPLY = 4,
    WSJTX_MESSAGE_QSO_LOGGED = 5,
    WSJTX_MESSAGE_CLOSE = 6,
    WSJTX_MESSAGE_REPLAY = 7,
    WSJTX_MESSAGE_HALT_TX = 8,
    WSJTX_MESSAGE_FREE_TEXT = 9,
    WSJTX_MESSAGE_WSPR_DECODE = 10,
    WSJTX_MESSAGE_LOCATION = 11,
    WSJTX_MESSAGE_LOGGED_ADIF = 12,
    WSJTX_MESSAGE_HIGHLIGHT_CALLSIGN = 13,
} wsjtx_message_type_t;

typedef struct {
    uint8_t data[WSJTX_PROTOCOL_MAX_PACKET];
    size_t length;
    bool failed;
} wsjtx_packet_t;

typedef struct {
    uint64_t dial_frequency_hz;
    const char *mode;
    const char *dx_call;
    const char *report;
    const char *tx_mode;
    bool tx_enabled;
    bool transmitting;
    bool decoding;
    int32_t rx_df_hz;
    int32_t tx_df_hz;
    const char *de_call;
    const char *de_grid;
    const char *dx_grid;
    bool tx_watchdog;
    const char *sub_mode;
    bool fast_mode;
    uint8_t special_operation_mode;
    uint32_t frequency_tolerance_hz;
    uint32_t tr_period_seconds;
    const char *configuration_name;
    const char *tx_message;
} wsjtx_status_t;

typedef struct {
    bool is_new;
    uint32_t milliseconds_since_midnight;
    int32_t snr;
    double delta_time_seconds;
    uint32_t delta_frequency_hz;
    const char *mode;
    const char *message;
    bool low_confidence;
    bool off_air;
} wsjtx_decode_t;

typedef struct {
    int year;
    int month;
    int day;
    int hour;
    int minute;
    int second;
    int millisecond;
} wsjtx_utc_t;

typedef struct {
    wsjtx_utc_t time_off;
    const char *dx_call;
    const char *dx_grid;
    uint64_t tx_frequency_hz;
    const char *mode;
    const char *report_sent;
    const char *report_received;
    const char *tx_power;
    const char *comments;
    const char *name;
    wsjtx_utc_t time_on;
    const char *operator_call;
    const char *my_call;
    const char *my_grid;
    const char *exchange_sent;
    const char *exchange_received;
    const char *adif_propagation_mode;
} wsjtx_qso_logged_t;

bool wsjtx_build_heartbeat(wsjtx_packet_t *packet, const char *id,
                           const char *version, const char *revision);
bool wsjtx_build_status(wsjtx_packet_t *packet, const char *id,
                        const wsjtx_status_t *status);
bool wsjtx_build_decode(wsjtx_packet_t *packet, const char *id,
                        const wsjtx_decode_t *decode);
bool wsjtx_build_clear(wsjtx_packet_t *packet, const char *id);
bool wsjtx_build_close(wsjtx_packet_t *packet, const char *id);
bool wsjtx_build_qso_logged(wsjtx_packet_t *packet, const char *id,
                            const wsjtx_qso_logged_t *qso);
bool wsjtx_build_logged_adif(wsjtx_packet_t *packet, const char *id,
                             const char *adif);

#ifdef __cplusplus
}
#endif
