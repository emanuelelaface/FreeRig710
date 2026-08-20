#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool initialized;
    bool client_registered;
    bool device_present;
    bool device_open;
    bool interface_claimed;
    bool streaming;
    bool sample_rate_configured;

    uint8_t device_address;
    uint8_t interface_number;
    uint8_t alternate_setting;
    uint8_t endpoint;
    uint16_t max_packet_size;
    uint32_t sample_rate_hz;
    uint8_t channels;
    uint8_t bits_per_sample;

    uint32_t transfer_callbacks;
    uint32_t transfer_errors;
    uint32_t packets_total;
    uint32_t packets_completed;
    uint32_t packets_skipped;
    uint32_t packets_error;
    uint32_t packets_expected_size;
    uint32_t packets_other_size;
    uint64_t rx_bytes;
    uint64_t rx_samples;
    uint16_t last_packet_bytes;
    uint16_t peak_abs;
    uint16_t mean_abs;
    uint64_t started_ms;
    uint64_t updated_ms;
    uint32_t disconnects;

    /* M10.2 browser/network PCM tap. One consumer at a time. */
    bool pcm_consumer_active;
    uint32_t pcm_buffer_capacity;
    uint32_t pcm_buffered_bytes;
    uint32_t pcm_stream_opens;
    uint64_t pcm_stream_bytes;
    uint64_t pcm_stream_dropped_bytes;

    int last_error;
} ft710_audio_status_t;

/** Start M10.2 FT-710 UAC1 RX capture at 48 kHz mono 16-bit. */
esp_err_t ft710_audio_start(void);


/** Temporarily release UAC1 RX while digital TX owns the C-Media device.
 *  pause=true waits until RX interface is closed; pause=false waits until it is reopened. */
esp_err_t ft710_audio_set_tx_half_duplex(bool pause, uint32_t timeout_ms);
bool ft710_audio_tx_half_duplex_requested(void);

/** Copy current UAC1 RX streaming status. */
void ft710_audio_get_status(ft710_audio_status_t *status);

/** Open the single M10.2 PCM consumer. Returns false if already in use/not ready. */
bool ft710_audio_pcm_stream_open(void);

/** Receive S16LE mono 48 kHz PCM bytes for the active consumer. */
size_t ft710_audio_pcm_stream_read(void *buffer, size_t capacity, uint32_t timeout_ms);

/** Close the active PCM consumer and discard buffered audio. */
void ft710_audio_pcm_stream_close(void);

#ifdef __cplusplus
}
#endif
