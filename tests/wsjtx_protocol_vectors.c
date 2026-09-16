#include "wsjtx_protocol.h"

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    const uint8_t *data;
    size_t length;
    size_t offset;
} cursor_t;

static uint8_t get_u8(cursor_t *c)
{
    assert(c->offset < c->length);
    return c->data[c->offset++];
}

static uint32_t get_u32(cursor_t *c)
{
    assert(c->length - c->offset >= 4);
    uint32_t value = ((uint32_t)c->data[c->offset] << 24) |
                     ((uint32_t)c->data[c->offset + 1] << 16) |
                     ((uint32_t)c->data[c->offset + 2] << 8) |
                     c->data[c->offset + 3];
    c->offset += 4;
    return value;
}

static uint64_t get_u64(cursor_t *c)
{
    return ((uint64_t)get_u32(c) << 32) | get_u32(c);
}

static double get_double(cursor_t *c)
{
    uint64_t bits = get_u64(c);
    double value;
    memcpy(&value, &bits, sizeof(value));
    return value;
}

static void expect_utf8(cursor_t *c, const char *expected)
{
    uint32_t length = get_u32(c);
    assert(length == strlen(expected));
    assert(c->length - c->offset >= length);
    assert(memcmp(c->data + c->offset, expected, length) == 0);
    c->offset += length;
}

static cursor_t expect_header(const wsjtx_packet_t *packet, uint32_t type)
{
    assert(packet && !packet->failed);
    cursor_t c = { packet->data, packet->length, 0 };
    assert(get_u32(&c) == 0xADBCCBDAU);
    assert(get_u32(&c) == 3U);
    assert(get_u32(&c) == type);
    expect_utf8(&c, "FreeRig710");
    return c;
}

static void expect_datetime(cursor_t *c, uint64_t julian_day, uint32_t milliseconds)
{
    assert(get_u64(c) == julian_day);
    assert(get_u32(c) == milliseconds);
    assert(get_u8(c) == 1U);
}

int main(void)
{
    wsjtx_packet_t packet;
    cursor_t c;

    assert(wsjtx_build_heartbeat(&packet, NULL, "FreeRig710 1.0", "r1"));
    c = expect_header(&packet, WSJTX_MESSAGE_HEARTBEAT);
    assert(get_u32(&c) == 3U);
    expect_utf8(&c, "FreeRig710 1.0");
    expect_utf8(&c, "r1");
    assert(c.offset == c.length);

    wsjtx_status_t status = {
        .dial_frequency_hz = 14074000,
        .mode = "FT8", .dx_call = "SM0ABC", .report = "-12", .tx_mode = "FT8",
        .tx_enabled = true, .transmitting = false, .decoding = true,
        .rx_df_hz = 913, .tx_df_hz = 1500,
        .de_call = "SA0XYZ", .de_grid = "JO89", .dx_grid = "JO99",
        .tx_watchdog = false, .sub_mode = "", .fast_mode = false,
        .special_operation_mode = 0, .frequency_tolerance_hz = UINT32_MAX, .tr_period_seconds = 15,
        .configuration_name = "Default", .tx_message = "SM0ABC SA0XYZ -12",
    };
    assert(wsjtx_build_status(&packet, NULL, &status));
    c = expect_header(&packet, WSJTX_MESSAGE_STATUS);
    assert(get_u64(&c) == 14074000U);
    expect_utf8(&c, "FT8"); expect_utf8(&c, "SM0ABC"); expect_utf8(&c, "-12"); expect_utf8(&c, "FT8");
    assert(get_u8(&c) == 1U); assert(get_u8(&c) == 0U); assert(get_u8(&c) == 1U);
    assert((int32_t)get_u32(&c) == 913); assert((int32_t)get_u32(&c) == 1500);
    expect_utf8(&c, "SA0XYZ"); expect_utf8(&c, "JO89"); expect_utf8(&c, "JO99");
    assert(get_u8(&c) == 0U); expect_utf8(&c, ""); assert(get_u8(&c) == 0U); assert(get_u8(&c) == 0U);
    assert(get_u32(&c) == UINT32_MAX); assert(get_u32(&c) == 15U);
    expect_utf8(&c, "Default"); expect_utf8(&c, "SM0ABC SA0XYZ -12");
    assert(c.offset == c.length);

    wsjtx_decode_t decode = {
        .is_new = true, .milliseconds_since_midnight = 45255000,
        .snr = -18, .delta_time_seconds = 0.2, .delta_frequency_hz = 913,
        .mode = "~", .message = "CQ SM0ABC JO89", .low_confidence = false, .off_air = false,
    };
    assert(wsjtx_build_decode(&packet, NULL, &decode));
    c = expect_header(&packet, WSJTX_MESSAGE_DECODE);
    assert(get_u8(&c) == 1U); assert(get_u32(&c) == 45255000U);
    assert((int32_t)get_u32(&c) == -18); assert(get_double(&c) == 0.2); assert(get_u32(&c) == 913U);
    expect_utf8(&c, "~"); expect_utf8(&c, "CQ SM0ABC JO89");
    assert(get_u8(&c) == 0U); assert(get_u8(&c) == 0U); assert(c.offset == c.length);

    wsjtx_qso_logged_t qso = {
        .time_off = { 2026, 9, 16, 12, 37, 45, 0 },
        .dx_call = "SM0ABC", .dx_grid = "JO89", .tx_frequency_hz = 14074000,
        .mode = "FT8", .report_sent = "-12", .report_received = "-18",
        .tx_power = "10", .comments = "test", .name = "Ada",
        .time_on = { 2026, 9, 16, 12, 35, 15, 0 },
        .operator_call = "SA0XYZ", .my_call = "SA0XYZ", .my_grid = "JO99",
        .exchange_sent = "", .exchange_received = "", .adif_propagation_mode = "",
    };
    assert(wsjtx_build_qso_logged(&packet, NULL, &qso));
    c = expect_header(&packet, WSJTX_MESSAGE_QSO_LOGGED);
    expect_datetime(&c, 2461300U, 45465000U);
    expect_utf8(&c, "SM0ABC"); expect_utf8(&c, "JO89"); assert(get_u64(&c) == 14074000U);
    expect_utf8(&c, "FT8"); expect_utf8(&c, "-12"); expect_utf8(&c, "-18");
    expect_utf8(&c, "10"); expect_utf8(&c, "test"); expect_utf8(&c, "Ada");
    expect_datetime(&c, 2461300U, 45315000U);
    expect_utf8(&c, "SA0XYZ"); expect_utf8(&c, "SA0XYZ"); expect_utf8(&c, "JO99");
    expect_utf8(&c, ""); expect_utf8(&c, ""); expect_utf8(&c, ""); assert(c.offset == c.length);

    const char *adif = "<ADIF_VER:5>3.1.4<EOH><CALL:6>SM0ABC<EOR>";
    assert(wsjtx_build_logged_adif(&packet, NULL, adif));
    c = expect_header(&packet, WSJTX_MESSAGE_LOGGED_ADIF);
    expect_utf8(&c, adif); assert(c.offset == c.length);

    assert(wsjtx_build_clear(&packet, NULL)); c = expect_header(&packet, WSJTX_MESSAGE_CLEAR); assert(c.offset == c.length);
    assert(wsjtx_build_close(&packet, NULL)); c = expect_header(&packet, WSJTX_MESSAGE_CLOSE); assert(c.offset == c.length);
    puts("WSJT-X protocol vectors: OK");
    return 0;
}
