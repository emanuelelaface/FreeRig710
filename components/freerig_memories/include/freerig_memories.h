#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "freerig_config.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool present;
    int slot;
    char radio_channel[4];
    uint32_t frequency_hz;
    int clarifier_offset_hz;
    bool rx_clarifier;
    bool tx_clarifier;
    char mode[16];
    int operating_state;
    int ctcss_mode;
    int ctcss_number;
    int repeater_shift;
    bool tag_enabled;
    char tag[13];
    char category[FREERIG_MEMORY_CATEGORY_MAX];
    char note[FREERIG_MEMORY_NOTE_MAX];
} freerig_memory_t;

typedef struct {
    int present;
    int empty;
    int errors;
    int last_error_slot;
    int last_error;
} freerig_memory_sync_result_t;

esp_err_t freerig_memories_init(void);
size_t freerig_memories_list(freerig_memory_t *out, size_t capacity);
esp_err_t freerig_memories_sync(freerig_memory_sync_result_t *summary);
esp_err_t freerig_memory_read_radio(int slot, freerig_memory_t *out);
esp_err_t freerig_memory_save_current(int requested_slot, const char *name, const char *category, const char *note, bool overwrite, freerig_memory_t *out);
esp_err_t freerig_memory_edit(int slot, uint32_t frequency_hz, const char *mode, const char *name, const char *category, const char *note, freerig_memory_t *out);
esp_err_t freerig_memory_recall(int slot, const char *action);

#ifdef __cplusplus
}
#endif
