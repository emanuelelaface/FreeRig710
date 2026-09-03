#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define FREERIG_QRZ_CALLSIGN_MAX 17
#define FREERIG_QRZ_API_KEY_MAX 129
#define FREERIG_GRIDTRACKER_HOST_MAX 65
#define FREERIG_GRIDTRACKER_DEFAULT_PORT 2333U
#define FREERIG_WIFI_SSID_MAX 33
#define FREERIG_WIFI_PASSWORD_MAX 65
#define FREERIG_WIREGUARD_CONFIG_TEXT_MAX 3073
#define FREERIG_MEMORY_CATEGORY_MAX 25
#define FREERIG_MEMORY_NOTE_MAX 241

typedef struct {
    char station_callsign[FREERIG_QRZ_CALLSIGN_MAX];
    char api_key[FREERIG_QRZ_API_KEY_MAX];
    bool api_key_set;
    bool qrz_enabled;
    bool gridtracker_enabled;
    char gridtracker_host[FREERIG_GRIDTRACKER_HOST_MAX];
    uint16_t gridtracker_port;
} freerig_qrz_config_t;

typedef struct {
    char config_text[FREERIG_WIREGUARD_CONFIG_TEXT_MAX];
    bool config_set;
    bool enable_on_boot;
} freerig_wireguard_config_t;

typedef struct {
    char ssid[FREERIG_WIFI_SSID_MAX];
    char password[FREERIG_WIFI_PASSWORD_MAX];
    bool enabled;
    bool ssid_set;
    bool password_set;
} freerig_wifi_config_t;

esp_err_t freerig_config_init(void);
esp_err_t freerig_config_get_qrz(freerig_qrz_config_t *out);
esp_err_t freerig_config_set_qrz(const char *station_callsign, const char *api_key_or_null);
esp_err_t freerig_config_set_log(const char *station_callsign, const char *api_key_or_null,
                                 bool qrz_enabled, bool gridtracker_enabled,
                                 const char *gridtracker_host_or_null, uint16_t gridtracker_port);
esp_err_t freerig_config_get_wireguard(freerig_wireguard_config_t *out);
esp_err_t freerig_config_set_wireguard(const char *config_text_or_null, bool enable_on_boot);
esp_err_t freerig_config_get_wifi(freerig_wifi_config_t *out);
esp_err_t freerig_config_set_wifi(const char *ssid_or_null, const char *password_or_null, bool enabled);
esp_err_t freerig_config_get_memory_metadata(int slot, char *category, size_t category_size, char *note, size_t note_size);
esp_err_t freerig_config_set_memory_metadata(int slot, const char *category_or_null, const char *note_or_null);

#ifdef __cplusplus
}
#endif
