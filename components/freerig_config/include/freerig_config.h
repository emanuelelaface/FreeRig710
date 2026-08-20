#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define FREERIG_QRZ_CALLSIGN_MAX 17
#define FREERIG_QRZ_API_KEY_MAX 129
#define FREERIG_MEMORY_CATEGORY_MAX 25
#define FREERIG_MEMORY_NOTE_MAX 241

typedef struct {
    char station_callsign[FREERIG_QRZ_CALLSIGN_MAX];
    char api_key[FREERIG_QRZ_API_KEY_MAX];
    bool api_key_set;
} freerig_qrz_config_t;

esp_err_t freerig_config_init(void);
esp_err_t freerig_config_get_qrz(freerig_qrz_config_t *out);
esp_err_t freerig_config_set_qrz(const char *station_callsign, const char *api_key_or_null);
esp_err_t freerig_config_get_memory_metadata(int slot, char *category, size_t category_size, char *note, size_t note_size);
esp_err_t freerig_config_set_memory_metadata(int slot, const char *category_or_null, const char *note_or_null);

#ifdef __cplusplus
}
#endif
