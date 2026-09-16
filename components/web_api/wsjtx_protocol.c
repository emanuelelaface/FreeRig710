#include "wsjtx_protocol.h"

#include <string.h>

static bool reserve(wsjtx_packet_t *packet, size_t bytes)
{
    if (!packet || packet->failed || bytes > sizeof(packet->data) - packet->length) {
        if (packet) packet->failed = true;
        return false;
    }
    return true;
}

static void put_u8(wsjtx_packet_t *packet, uint8_t value)
{
    if (reserve(packet, 1)) packet->data[packet->length++] = value;
}

static void put_u32(wsjtx_packet_t *packet, uint32_t value)
{
    if (!reserve(packet, 4)) return;
    packet->data[packet->length++] = (uint8_t)(value >> 24);
    packet->data[packet->length++] = (uint8_t)(value >> 16);
    packet->data[packet->length++] = (uint8_t)(value >> 8);
    packet->data[packet->length++] = (uint8_t)value;
}

static void put_i32(wsjtx_packet_t *packet, int32_t value)
{
    put_u32(packet, (uint32_t)value);
}

static void put_u64(wsjtx_packet_t *packet, uint64_t value)
{
    put_u32(packet, (uint32_t)(value >> 32));
    put_u32(packet, (uint32_t)value);
}

static void put_i64(wsjtx_packet_t *packet, int64_t value)
{
    put_u64(packet, (uint64_t)value);
}

static void put_double(wsjtx_packet_t *packet, double value)
{
    uint64_t bits = 0;
    memcpy(&bits, &value, sizeof(bits));
    put_u64(packet, bits);
}

static void put_bool(wsjtx_packet_t *packet, bool value)
{
    put_u8(packet, value ? 1U : 0U);
}

static void put_utf8(wsjtx_packet_t *packet, const char *value)
{
    const char *text = value ? value : "";
    size_t length = strlen(text);
    if (length > UINT32_MAX || !reserve(packet, 4U + length)) return;
    put_u32(packet, (uint32_t)length);
    if (length && reserve(packet, length)) {
        memcpy(packet->data + packet->length, text, length);
        packet->length += length;
    }
}

static bool begin(wsjtx_packet_t *packet, wsjtx_message_type_t type, const char *id)
{
    if (!packet) return false;
    memset(packet, 0, sizeof(*packet));
    put_u32(packet, WSJTX_PROTOCOL_MAGIC);
    put_u32(packet, WSJTX_PROTOCOL_SCHEMA);
    put_u32(packet, (uint32_t)type);
    put_utf8(packet, id && id[0] ? id : WSJTX_PROTOCOL_ID);
    return !packet->failed;
}

/* QDataStream serializes QDate as a signed Julian-day number. */
static int64_t julian_day(int year, int month, int day)
{
    int a = (14 - month) / 12;
    int y = year + 4800 - a;
    int m = month + 12 * a - 3;
    return (int64_t)day + (153 * m + 2) / 5 + 365LL * y + y / 4 - y / 100 + y / 400 - 32045;
}

static void put_datetime_utc(wsjtx_packet_t *packet, const wsjtx_utc_t *value)
{
    wsjtx_utc_t zero = {0};
    const wsjtx_utc_t *utc = value ? value : &zero;
    int64_t date = 0;
    uint32_t time = UINT32_MAX;
    if (utc->year > 0 && utc->month >= 1 && utc->month <= 12 && utc->day >= 1 && utc->day <= 31) {
        date = julian_day(utc->year, utc->month, utc->day);
    }
    if (utc->hour >= 0 && utc->hour <= 23 && utc->minute >= 0 && utc->minute <= 59 &&
        utc->second >= 0 && utc->second <= 59 && utc->millisecond >= 0 && utc->millisecond <= 999) {
        time = (uint32_t)((((utc->hour * 60) + utc->minute) * 60 + utc->second) * 1000 + utc->millisecond);
    }
    put_i64(packet, date);
    put_u32(packet, time);
    put_u8(packet, 1U); /* Qt::UTC */
}

bool wsjtx_build_heartbeat(wsjtx_packet_t *packet, const char *id,
                           const char *version, const char *revision)
{
    if (!begin(packet, WSJTX_MESSAGE_HEARTBEAT, id)) return false;
    put_u32(packet, WSJTX_PROTOCOL_SCHEMA);
    put_utf8(packet, version);
    put_utf8(packet, revision);
    return !packet->failed;
}

bool wsjtx_build_status(wsjtx_packet_t *packet, const char *id,
                        const wsjtx_status_t *status)
{
    if (!status || !begin(packet, WSJTX_MESSAGE_STATUS, id)) return false;
    put_u64(packet, status->dial_frequency_hz);
    put_utf8(packet, status->mode);
    put_utf8(packet, status->dx_call);
    put_utf8(packet, status->report);
    put_utf8(packet, status->tx_mode);
    put_bool(packet, status->tx_enabled);
    put_bool(packet, status->transmitting);
    put_bool(packet, status->decoding);
    put_i32(packet, status->rx_df_hz);
    put_i32(packet, status->tx_df_hz);
    put_utf8(packet, status->de_call);
    put_utf8(packet, status->de_grid);
    put_utf8(packet, status->dx_grid);
    put_bool(packet, status->tx_watchdog);
    put_utf8(packet, status->sub_mode);
    put_bool(packet, status->fast_mode);
    put_u8(packet, status->special_operation_mode);
    put_u32(packet, status->frequency_tolerance_hz);
    put_u32(packet, status->tr_period_seconds);
    put_utf8(packet, status->configuration_name);
    put_utf8(packet, status->tx_message);
    return !packet->failed;
}

bool wsjtx_build_decode(wsjtx_packet_t *packet, const char *id,
                        const wsjtx_decode_t *decode)
{
    if (!decode || !begin(packet, WSJTX_MESSAGE_DECODE, id)) return false;
    put_bool(packet, decode->is_new);
    put_u32(packet, decode->milliseconds_since_midnight);
    put_i32(packet, decode->snr);
    put_double(packet, decode->delta_time_seconds);
    put_u32(packet, decode->delta_frequency_hz);
    put_utf8(packet, decode->mode);
    put_utf8(packet, decode->message);
    put_bool(packet, decode->low_confidence);
    put_bool(packet, decode->off_air);
    return !packet->failed;
}

bool wsjtx_build_clear(wsjtx_packet_t *packet, const char *id)
{
    return begin(packet, WSJTX_MESSAGE_CLEAR, id);
}

bool wsjtx_build_close(wsjtx_packet_t *packet, const char *id)
{
    return begin(packet, WSJTX_MESSAGE_CLOSE, id);
}

bool wsjtx_build_qso_logged(wsjtx_packet_t *packet, const char *id,
                            const wsjtx_qso_logged_t *qso)
{
    if (!qso || !begin(packet, WSJTX_MESSAGE_QSO_LOGGED, id)) return false;
    put_datetime_utc(packet, &qso->time_off);
    put_utf8(packet, qso->dx_call);
    put_utf8(packet, qso->dx_grid);
    put_u64(packet, qso->tx_frequency_hz);
    put_utf8(packet, qso->mode);
    put_utf8(packet, qso->report_sent);
    put_utf8(packet, qso->report_received);
    put_utf8(packet, qso->tx_power);
    put_utf8(packet, qso->comments);
    put_utf8(packet, qso->name);
    put_datetime_utc(packet, &qso->time_on);
    put_utf8(packet, qso->operator_call);
    put_utf8(packet, qso->my_call);
    put_utf8(packet, qso->my_grid);
    put_utf8(packet, qso->exchange_sent);
    put_utf8(packet, qso->exchange_received);
    put_utf8(packet, qso->adif_propagation_mode);
    return !packet->failed;
}

bool wsjtx_build_logged_adif(wsjtx_packet_t *packet, const char *id,
                             const char *adif)
{
    if (!begin(packet, WSJTX_MESSAGE_LOGGED_ADIF, id)) return false;
    put_utf8(packet, adif);
    return !packet->failed;
}
