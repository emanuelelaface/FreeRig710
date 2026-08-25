#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool initialized;
    bool configured;
    bool enable_on_boot;
    bool starting;
    bool active;
    bool peer_up;
    char interface_ip[16];
    char netmask[16];
    char allowed_ip[16];
    char allowed_mask[16];
    char endpoint_host[128];
    char endpoint_ip[16];
    uint16_t endpoint_port;
    uint16_t listen_port;
    uint16_t keepalive_s;
    uint32_t starts;
    uint32_t stops;
    esp_err_t last_error;
    char last_error_text[128];
} freerig_wireguard_status_t;

esp_err_t freerig_wireguard_init(void);
esp_err_t freerig_wireguard_apply_boot_config(void);
esp_err_t freerig_wireguard_apply_saved_config_async(void);
esp_err_t freerig_wireguard_stop(void);
void freerig_wireguard_get_status(freerig_wireguard_status_t *out);

#ifdef __cplusplus
}
#endif
