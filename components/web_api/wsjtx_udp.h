#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "wsjtx_protocol.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    wsjtx_message_type_t type;
    char id[33];
    uint32_t milliseconds_since_midnight;
    int32_t snr;
    double delta_time_seconds;
    uint32_t delta_frequency_hz;
    char mode[17];
    char message[96];
    bool low_confidence;
    uint8_t modifiers;
    bool flag;
    uint8_t window;
} wsjtx_command_t;

typedef struct {
    bool socket_open;
    char host[65];
    uint16_t port;
    uint32_t sent_packets;
    uint32_t received_packets;
    uint32_t dropped_commands;
    uint32_t peer_schema;
} wsjtx_udp_stats_t;

esp_err_t wsjtx_udp_init(void);
esp_err_t wsjtx_udp_send(const char *host, uint16_t port,
                         const wsjtx_packet_t *packet,
                         char *detail, size_t detail_size);
bool wsjtx_udp_pop_command(wsjtx_command_t *out);
void wsjtx_udp_get_stats(wsjtx_udp_stats_t *out);

#ifdef __cplusplus
}
#endif
