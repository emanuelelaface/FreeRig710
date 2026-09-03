#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "freerig_config.h"

#ifdef __cplusplus
extern "C" {
#endif

#define NETWORK_WIFI_SCAN_MAX 20
#define NETWORK_WIFI_AUTHMODE_MAX 24

typedef struct {
    char ssid[FREERIG_WIFI_SSID_MAX];
    int rssi;
    uint8_t channel;
    int authmode;
    char authmode_name[NETWORK_WIFI_AUTHMODE_MAX];
    bool secure;
} network_wifi_ap_t;

typedef struct {
    bool initialized;
    bool started;
    bool enabled;
    bool configured;
    bool connecting;
    bool connected;
    bool got_ip;
    char ssid[FREERIG_WIFI_SSID_MAX];
    char ip_address[16];
    char netmask[16];
    char gateway[16];
    uint8_t mac[6];
    int rssi;
    uint8_t channel;
    uint32_t connect_attempts;
    uint32_t disconnects;
    int last_disconnect_reason;
    esp_err_t last_error;
} network_wifi_status_t;

esp_err_t network_wifi_start(void);
esp_err_t network_wifi_apply_config(void);
esp_err_t network_wifi_scan(network_wifi_ap_t *out, size_t max_count, size_t *out_count);
void network_wifi_get_status(network_wifi_status_t *out_status);

#ifdef __cplusplus
}
#endif
