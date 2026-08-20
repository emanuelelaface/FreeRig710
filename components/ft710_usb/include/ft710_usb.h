#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define FT710_USB_MAX_DEVICES    12
#define FT710_USB_MAX_INTERFACES 24
#define FT710_USB_MAX_ENDPOINTS  40
#define FT710_USB_STRING_MAX     64
#define FT710_USB_MAX_AUDIO_FORMATS 8
#define FT710_USB_MAX_AUDIO_RATES   8
#define FT710_USB_FS_PERIPHERAL_MAP 0x02U

typedef struct {
    uint8_t number;
    uint8_t alternate_setting;
    uint8_t num_endpoints;
    uint8_t interface_class;
    uint8_t interface_subclass;
    uint8_t interface_protocol;
    uint8_t string_index;
} ft710_usb_interface_desc_t;

typedef struct {
    uint8_t interface_number;
    uint8_t alternate_setting;
    uint8_t address;
    uint8_t attributes;
    uint8_t transfer_type;
    uint16_t max_packet_size_raw;
    uint16_t max_packet_size;
    uint8_t interval;
} ft710_usb_endpoint_desc_t;


typedef struct {
    bool valid;
    uint8_t interface_number;
    uint8_t alternate_setting;
    uint8_t endpoint_address;
    uint8_t endpoint_attributes;
    uint16_t max_packet_size;
    uint8_t interval;
    uint8_t format_type;
    uint8_t channels;
    uint8_t subframe_size_bytes;
    uint8_t bit_resolution;
    uint8_t sample_freq_type;
    bool continuous_sample_rate;
    uint32_t min_sample_rate_hz;
    uint32_t max_sample_rate_hz;
    size_t sample_rate_count;
    uint32_t sample_rates_hz[FT710_USB_MAX_AUDIO_RATES];
} ft710_usb_audio_format_t;

typedef struct {
    bool present;
    bool descriptors_valid;
    bool descriptor_list_truncated;

    uint8_t device_address;
    uint8_t speed;
    uint8_t active_configuration;

    uint16_t vid;
    uint16_t pid;
    uint16_t bcd_usb;
    uint16_t bcd_device;
    uint8_t device_class;
    uint8_t device_subclass;
    uint8_t device_protocol;
    uint8_t num_configurations;

    char manufacturer[FT710_USB_STRING_MAX];
    char product[FT710_USB_STRING_MAX];
    char serial[FT710_USB_STRING_MAX];

    size_t interface_count;
    size_t endpoint_count;
    ft710_usb_interface_desc_t interfaces[FT710_USB_MAX_INTERFACES];
    ft710_usb_endpoint_desc_t endpoints[FT710_USB_MAX_ENDPOINTS];

    size_t audio_format_count;
    ft710_usb_audio_format_t audio_formats[FT710_USB_MAX_AUDIO_FORMATS];
} ft710_usb_device_status_t;

typedef struct {
    bool initialized;
    bool host_installed;
    bool client_registered;
    bool device_list_truncated;

    uint32_t peripheral_map;
    bool full_speed_phy;
    bool manual_phy_setup;
    bool force_full_speed_on_hs_port;
    int phy_setup_error;

    /* M8.3 experimental DWC2 host-port Full/Low-Speed-only diagnostics. */
    bool dwc_force_fsls_only;
    bool dwc_register_guard_ok;
    uint32_t dwc_gsnpsid;
    uint32_t dwc_ghwcfg2;
    uint32_t dwc_gusbcfg;
    uint32_t dwc_hcfg_before;
    uint32_t dwc_hcfg_after;
    uint32_t dwc_hprt;

    size_t device_count;
    ft710_usb_device_status_t devices[FT710_USB_MAX_DEVICES];

    uint32_t connect_count;
    uint32_t disconnect_count;
    int last_error;
} ft710_usb_status_t;

/**
 * @brief Start the Milestone-8.3 DWC2 FS/LS-only diagnostic USB Host stack.
 *
 * The diagnostic client never claims an application USB interface and never
 * submits CAT/audio application transfers. It opens every enumerated device it
 * can track, reads cached descriptors, logs them, and keeps each handle open so
 * disconnects can be observed. This deliberately supports an FT-710 that may
 * enumerate as one composite device or as several devices below a USB hub.
 */
esp_err_t ft710_usb_start(void);

/** Copy the latest diagnostic status snapshot. */
void ft710_usb_get_status(ft710_usb_status_t *status);

/** Human-readable role for known FT-710 USB devices. */
const char *ft710_usb_device_role(uint16_t vid, uint16_t pid, uint8_t device_class);

/** Human-readable USB speed string for the numeric speed stored in status. */
const char *ft710_usb_speed_name(uint8_t speed);

/** Human-readable endpoint transfer type (control/iso/bulk/interrupt). */
const char *ft710_usb_transfer_type_name(uint8_t transfer_type);

#ifdef __cplusplus
}
#endif
