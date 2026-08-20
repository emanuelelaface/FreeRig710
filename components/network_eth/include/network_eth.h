#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool initialized;
    bool link_up;
    bool got_ip;
    char ip_address[16];
    char netmask[16];
    char gateway[16];
    uint8_t mac[6];

    /* FT8.1 UTC timing diagnostics. SNTP is started after Ethernet gets IP. */
    bool time_sync_initialized;
    bool time_sync_started;
    bool time_synced;
    uint32_t time_sync_count;
    uint64_t time_last_sync_unix_ms;

    esp_err_t last_error;
} network_eth_status_t;

esp_err_t network_eth_start(void);
void network_eth_get_status(network_eth_status_t *out_status);

#ifdef __cplusplus
}
#endif
