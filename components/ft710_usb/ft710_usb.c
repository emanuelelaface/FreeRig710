#include "ft710_usb.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "esp_intr_alloc.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "usb/usb_host.h"

#define FT710_USB_HOST_TASK_STACK   4096
#define FT710_USB_CLIENT_TASK_STACK 7168
#define FT710_USB_HOST_TASK_PRIO    5
#define FT710_USB_CLIENT_TASK_PRIO  4
#define FT710_USB_SCAN_PERIOD_MS    1000
#define FT710_USB_ADDR_LIST_MAX     16
#define FT710_USB_HOST_PERIPHERAL_MAP BIT0

/*
 * M8.3 experimental direct DWC2 register access.  ESP32-P4's onboard
 * Waveshare Type-A is connected to the HS DWC2/UTMI peripheral (BIT0).
 *
 * These offsets are the standard Synopsys DWC2 register layout.  The write is
 * guarded by the GSNPSID signature before touching HCFG so a wrong base
 * address cannot silently corrupt an unrelated peripheral.
 */
#define FT710_DWC_HS_BASE              0x50000000UL
#define FT710_DWC_GUSBCFG_OFFSET       0x000CU
#define FT710_DWC_GSNPSID_OFFSET       0x0040U
#define FT710_DWC_GHWCFG2_OFFSET       0x0048U
#define FT710_DWC_HCFG_OFFSET          0x0400U
#define FT710_DWC_HPRT_OFFSET          0x0440U
#define FT710_DWC_HCFG_FSLSSUPP        (1U << 2)
#define FT710_DWC_HPRT_SPD_SHIFT       17U
#define FT710_DWC_HPRT_SPD_MASK        (3U << FT710_DWC_HPRT_SPD_SHIFT)
#define FT710_DWC_GSNPSID_CORE_MASK    0xFFFF0000U
#define FT710_DWC_GSNPSID_OTG_CORE     0x4F540000U

static inline uint32_t dwc_reg_read(uint32_t offset)
{
    return *(volatile uint32_t *)(uintptr_t)(FT710_DWC_HS_BASE + offset);
}

static inline void dwc_reg_write(uint32_t offset, uint32_t value)
{
    *(volatile uint32_t *)(uintptr_t)(FT710_DWC_HS_BASE + offset) = value;
    __asm__ volatile ("fence iorw, iorw" ::: "memory");
}

static const char *dwc_hprt_speed_name(uint32_t hprt)
{
    switch ((hprt & FT710_DWC_HPRT_SPD_MASK) >> FT710_DWC_HPRT_SPD_SHIFT) {
    case 0: return "high";
    case 1: return "full";
    case 2: return "low";
    default: return "reserved";
    }
}

/* Standard USB descriptor types from USB 2.0 chapter 9. */
#define USB_DESC_TYPE_INTERFACE 0x04
#define USB_DESC_TYPE_ENDPOINT     0x05
#define USB_DESC_TYPE_CS_INTERFACE 0x24
#define USB_INTERFACE_DESC_LEN     9
#define USB_ENDPOINT_DESC_LEN      7
#define USB_CLASS_AUDIO            0x01
#define USB_AUDIO_SUBCLASS_STREAMING 0x02
#define UAC1_AS_FORMAT_TYPE_SUBTYPE 0x02
#define UAC1_FORMAT_TYPE_I          0x01

static const char *TAG = "ft710_usb";

static SemaphoreHandle_t s_status_mutex;
static TaskHandle_t s_start_waiter;
static ft710_usb_status_t s_status;
static volatile esp_err_t s_host_install_result = ESP_ERR_INVALID_STATE;

typedef struct {
    usb_device_handle_t dev_hdl;
    uint8_t address;
    bool gone;
} usb_diag_device_t;

typedef struct {
    usb_host_client_handle_t client_hdl;
    usb_diag_device_t devices[FT710_USB_MAX_DEVICES];
    bool scan_requested;
} usb_diag_ctx_t;

static void status_lock(void)
{
    if (s_status_mutex != NULL) {
        xSemaphoreTake(s_status_mutex, portMAX_DELAY);
    }
}

static void status_unlock(void)
{
    if (s_status_mutex != NULL) {
        xSemaphoreGive(s_status_mutex);
    }
}

static bool dwc_force_fsls_only(void)
{
    const uint32_t gsnpsid = dwc_reg_read(FT710_DWC_GSNPSID_OFFSET);
    const uint32_t ghwcfg2 = dwc_reg_read(FT710_DWC_GHWCFG2_OFFSET);
    const uint32_t gusbcfg = dwc_reg_read(FT710_DWC_GUSBCFG_OFFSET);
    const uint32_t hcfg_before = dwc_reg_read(FT710_DWC_HCFG_OFFSET);
    const uint32_t hprt_before = dwc_reg_read(FT710_DWC_HPRT_OFFSET);
    const bool signature_ok = (gsnpsid & FT710_DWC_GSNPSID_CORE_MASK) == FT710_DWC_GSNPSID_OTG_CORE;

    status_lock();
    s_status.dwc_force_fsls_only = true;
    s_status.dwc_register_guard_ok = signature_ok;
    s_status.dwc_gsnpsid = gsnpsid;
    s_status.dwc_ghwcfg2 = ghwcfg2;
    s_status.dwc_gusbcfg = gusbcfg;
    s_status.dwc_hcfg_before = hcfg_before;
    s_status.dwc_hcfg_after = hcfg_before;
    s_status.dwc_hprt = hprt_before;
    status_unlock();

    ESP_LOGI(TAG,
             "M8.3 DWC before: base=0x%08" PRIX32 " GSNPSID=0x%08" PRIX32 " GHWCFG2=0x%08" PRIX32 " GUSBCFG=0x%08" PRIX32 " HCFG=0x%08" PRIX32 " HPRT=0x%08" PRIX32 " speed=%s",
             (uint32_t)FT710_DWC_HS_BASE, gsnpsid, ghwcfg2, gusbcfg, hcfg_before, hprt_before, dwc_hprt_speed_name(hprt_before));

    if (!signature_ok) {
        ESP_LOGE(TAG,
                 "M8.3 DWC register guard FAILED: GSNPSID=0x%08" PRIX32 " is not a Synopsys OTG core signature; HCFG will NOT be modified",
                 gsnpsid);
        return false;
    }

    const uint32_t requested = hcfg_before | FT710_DWC_HCFG_FSLSSUPP;
    dwc_reg_write(FT710_DWC_HCFG_OFFSET, requested);
    const uint32_t hcfg_after = dwc_reg_read(FT710_DWC_HCFG_OFFSET);
    const uint32_t hprt_after = dwc_reg_read(FT710_DWC_HPRT_OFFSET);

    status_lock();
    s_status.dwc_hcfg_after = hcfg_after;
    s_status.dwc_hprt = hprt_after;
    status_unlock();

    ESP_LOGI(TAG,
             "M8.3 HCFG.FSLSSUPP set: before=0x%08" PRIX32 " requested=0x%08" PRIX32 " readback=0x%08" PRIX32 " bit=%u HPRT=0x%08" PRIX32 " speed=%s",
             hcfg_before, requested, hcfg_after,
             (unsigned)((hcfg_after & FT710_DWC_HCFG_FSLSSUPP) != 0),
             hprt_after, dwc_hprt_speed_name(hprt_after));

    return (hcfg_after & FT710_DWC_HCFG_FSLSSUPP) != 0;
}

static void status_set_error(esp_err_t err)
{
    status_lock();
    s_status.last_error = (int)err;
    status_unlock();
}

static size_t status_count_present_locked(void)
{
    size_t count = 0;
    for (size_t i = 0; i < FT710_USB_MAX_DEVICES; ++i) {
        if (s_status.devices[i].present) {
            ++count;
        }
    }
    return count;
}


const char *ft710_usb_device_role(uint16_t vid, uint16_t pid, uint8_t device_class)
{
    if (vid == 0x10C4U && pid == 0xEA70U) {
        return "FT-710 CP2105 CAT bridge";
    }
    if (vid == 0x0403U && pid == 0x601CU) {
        return "FT-710 FT4222 scope/waterfall";
    }
    if (vid == 0x04B4U && pid == 0x6560U) {
        return "FT-710 internal USB hub";
    }
    if (vid == 0x0D8CU && pid == 0x0013U) {
        return "FT-710 USB Audio (C-Media)";
    }
    if (device_class == 0x01U) {
        return "USB Audio device";
    }
    if (device_class == 0x09U) {
        return "USB hub";
    }
    return "unclassified";
}

const char *ft710_usb_speed_name(uint8_t speed)
{
    switch (speed) {
    case 0:
        return "low";
    case 1:
        return "full";
    case 2:
        return "high";
    default:
        return "unknown";
    }
}

const char *ft710_usb_transfer_type_name(uint8_t transfer_type)
{
    switch (transfer_type & 0x03U) {
    case 0:
        return "control";
    case 1:
        return "isochronous";
    case 2:
        return "bulk";
    case 3:
        return "interrupt";
    default:
        return "unknown";
    }
}

static void copy_usb_string_ascii(const usb_str_desc_t *desc, char *dst, size_t dst_size)
{
    if (dst == NULL || dst_size == 0) {
        return;
    }

    dst[0] = '\0';
    if (desc == NULL) {
        return;
    }

    const uint8_t *raw = (const uint8_t *)desc;
    const size_t raw_len = raw[0];
    if (raw_len < 2) {
        return;
    }

    size_t out = 0;
    for (size_t i = 2; i + 1 < raw_len && out + 1 < dst_size; i += 2) {
        uint16_t codepoint = (uint16_t)raw[i] | ((uint16_t)raw[i + 1] << 8);
        char ch = (codepoint >= 0x20 && codepoint <= 0x7E) ? (char)codepoint : '?';
        /* Keep the HTTP JSON representation safe without adding a JSON library. */
        if (ch == '"' || ch == '\\') {
            ch = '_';
        }
        dst[out++] = ch;
    }
    dst[out] = '\0';
}

static uint32_t uac1_get_le24(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16);
}

static void audio_format_attach_endpoint(ft710_usb_audio_format_t *fmt,
                                         const usb_ep_desc_t *ep)
{
    if (fmt == NULL || ep == NULL) {
        return;
    }
    fmt->endpoint_address = ep->bEndpointAddress;
    fmt->endpoint_attributes = ep->bmAttributes;
    fmt->max_packet_size = ep->wMaxPacketSize & 0x07FFU;
    fmt->interval = ep->bInterval;
}

static void log_and_parse_config_descriptor(const usb_config_desc_t *config_desc,
                                            ft710_usb_device_status_t *snapshot)
{
    if (config_desc == NULL || snapshot == NULL) {
        return;
    }

    snapshot->interface_count = 0;
    snapshot->endpoint_count = 0;
    snapshot->audio_format_count = 0;
    memset(snapshot->audio_formats, 0, sizeof(snapshot->audio_formats));
    snapshot->descriptor_list_truncated = false;

    const uint8_t *raw = (const uint8_t *)config_desc;
    const uint16_t total_len = config_desc->wTotalLength;
    uint8_t current_interface = 0xFF;
    uint8_t current_alt = 0;
    uint8_t current_class = 0xFF;
    uint8_t current_subclass = 0xFF;
    ft710_usb_audio_format_t *current_audio_format = NULL;

    ESP_LOGI(TAG,
             "USB-DESC CONFIG dev=%u value=%u interfaces=%u total_len=%u attributes=0x%02X max_power=%u",
             snapshot->device_address,
             config_desc->bConfigurationValue,
             config_desc->bNumInterfaces,
             total_len,
             config_desc->bmAttributes,
             config_desc->bMaxPower);

    size_t offset = 0;
    while (offset + 2 <= total_len) {
        const uint8_t len = raw[offset];
        const uint8_t type = raw[offset + 1];
        if (len < 2 || offset + len > total_len) {
            ESP_LOGW(TAG,
                     "USB-DESC malformed descriptor dev=%u offset=%u len=%u type=0x%02X total=%u",
                     snapshot->device_address, (unsigned)offset, len, type, total_len);
            break;
        }

        if (type == USB_DESC_TYPE_INTERFACE && len >= USB_INTERFACE_DESC_LEN) {
            const usb_intf_desc_t *intf = (const usb_intf_desc_t *)(raw + offset);
            current_interface = intf->bInterfaceNumber;
            current_alt = intf->bAlternateSetting;
            current_class = intf->bInterfaceClass;
            current_subclass = intf->bInterfaceSubClass;
            current_audio_format = NULL;

            ESP_LOGI(TAG,
                     "USB-DESC IF dev=%u num=%u alt=%u eps=%u class=0x%02X subclass=0x%02X protocol=0x%02X iInterface=%u",
                     snapshot->device_address,
                     intf->bInterfaceNumber,
                     intf->bAlternateSetting,
                     intf->bNumEndpoints,
                     intf->bInterfaceClass,
                     intf->bInterfaceSubClass,
                     intf->bInterfaceProtocol,
                     intf->iInterface);

            if (snapshot->interface_count < FT710_USB_MAX_INTERFACES) {
                ft710_usb_interface_desc_t *dst = &snapshot->interfaces[snapshot->interface_count++];
                dst->number = intf->bInterfaceNumber;
                dst->alternate_setting = intf->bAlternateSetting;
                dst->num_endpoints = intf->bNumEndpoints;
                dst->interface_class = intf->bInterfaceClass;
                dst->interface_subclass = intf->bInterfaceSubClass;
                dst->interface_protocol = intf->bInterfaceProtocol;
                dst->string_index = intf->iInterface;
            } else {
                snapshot->descriptor_list_truncated = true;
            }
        } else if (type == USB_DESC_TYPE_CS_INTERFACE && len >= 8 &&
                   current_class == USB_CLASS_AUDIO &&
                   current_subclass == USB_AUDIO_SUBCLASS_STREAMING &&
                   current_alt != 0 &&
                   raw[offset + 2] == UAC1_AS_FORMAT_TYPE_SUBTYPE &&
                   raw[offset + 3] == UAC1_FORMAT_TYPE_I) {
            if (snapshot->audio_format_count < FT710_USB_MAX_AUDIO_FORMATS) {
                ft710_usb_audio_format_t *fmt =
                    &snapshot->audio_formats[snapshot->audio_format_count++];
                memset(fmt, 0, sizeof(*fmt));
                fmt->valid = true;
                fmt->interface_number = current_interface;
                fmt->alternate_setting = current_alt;
                fmt->format_type = raw[offset + 3];
                fmt->channels = raw[offset + 4];
                fmt->subframe_size_bytes = raw[offset + 5];
                fmt->bit_resolution = raw[offset + 6];
                fmt->sample_freq_type = raw[offset + 7];

                if (fmt->sample_freq_type == 0) {
                    if (len >= 14) {
                        fmt->continuous_sample_rate = true;
                        fmt->min_sample_rate_hz = uac1_get_le24(raw + offset + 8);
                        fmt->max_sample_rate_hz = uac1_get_le24(raw + offset + 11);
                    }
                } else {
                    size_t advertised = fmt->sample_freq_type;
                    size_t available = len > 8 ? (size_t)(len - 8) / 3U : 0;
                    size_t count = advertised < available ? advertised : available;
                    if (count > FT710_USB_MAX_AUDIO_RATES) {
                        count = FT710_USB_MAX_AUDIO_RATES;
                        snapshot->descriptor_list_truncated = true;
                    }
                    fmt->sample_rate_count = count;
                    for (size_t i = 0; i < count; ++i) {
                        fmt->sample_rates_hz[i] = uac1_get_le24(raw + offset + 8 + i * 3U);
                    }
                }
                current_audio_format = fmt;

                ESP_LOGI(TAG,
                         "USB-AUDIO FORMAT dev=%u if=%u alt=%u type=%u ch=%u subframe=%u bits=%u freq_type=%u",
                         snapshot->device_address, current_interface, current_alt,
                         fmt->format_type, fmt->channels, fmt->subframe_size_bytes,
                         fmt->bit_resolution, fmt->sample_freq_type);
                if (fmt->continuous_sample_rate) {
                    ESP_LOGI(TAG,
                             "USB-AUDIO RATE dev=%u if=%u continuous=%" PRIu32 "..%" PRIu32 " Hz",
                             snapshot->device_address, current_interface,
                             fmt->min_sample_rate_hz, fmt->max_sample_rate_hz);
                } else {
                    for (size_t i = 0; i < fmt->sample_rate_count; ++i) {
                        ESP_LOGI(TAG,
                                 "USB-AUDIO RATE dev=%u if=%u[%u]=%" PRIu32 " Hz",
                                 snapshot->device_address, current_interface,
                                 (unsigned)i, fmt->sample_rates_hz[i]);
                    }
                }
            } else {
                snapshot->descriptor_list_truncated = true;
            }
        } else if (type == USB_DESC_TYPE_ENDPOINT && len >= USB_ENDPOINT_DESC_LEN) {
            const usb_ep_desc_t *ep = (const usb_ep_desc_t *)(raw + offset);
            const uint8_t transfer_type = ep->bmAttributes & 0x03U;
            const uint16_t mps = ep->wMaxPacketSize & 0x07FFU;

            ESP_LOGI(TAG,
                     "USB-DESC EP dev=%u if=%u alt=%u addr=0x%02X attr=0x%02X type=%s mps=%u raw_mps=0x%04X interval=%u",
                     snapshot->device_address,
                     current_interface,
                     current_alt,
                     ep->bEndpointAddress,
                     ep->bmAttributes,
                     ft710_usb_transfer_type_name(transfer_type),
                     mps,
                     ep->wMaxPacketSize,
                     ep->bInterval);

            if (current_audio_format != NULL &&
                current_audio_format->interface_number == current_interface &&
                current_audio_format->alternate_setting == current_alt &&
                (ep->bmAttributes & 0x03U) == USB_TRANSFER_TYPE_ISOCHRONOUS) {
                audio_format_attach_endpoint(current_audio_format, ep);
                ESP_LOGI(TAG,
                         "USB-AUDIO EP dev=%u if=%u alt=%u addr=0x%02X mps=%u interval=%u attr=0x%02X",
                         snapshot->device_address, current_interface, current_alt,
                         ep->bEndpointAddress, mps, ep->bInterval, ep->bmAttributes);
            }

            if (snapshot->endpoint_count < FT710_USB_MAX_ENDPOINTS) {
                ft710_usb_endpoint_desc_t *dst = &snapshot->endpoints[snapshot->endpoint_count++];
                dst->interface_number = current_interface;
                dst->alternate_setting = current_alt;
                dst->address = ep->bEndpointAddress;
                dst->attributes = ep->bmAttributes;
                dst->transfer_type = transfer_type;
                dst->max_packet_size_raw = ep->wMaxPacketSize;
                dst->max_packet_size = mps;
                dst->interval = ep->bInterval;
            } else {
                snapshot->descriptor_list_truncated = true;
            }
        }

        offset += len;
    }
}

static bool ctx_has_address(const usb_diag_ctx_t *ctx, uint8_t address)
{
    if (ctx == NULL || address == 0) {
        return false;
    }
    for (size_t i = 0; i < FT710_USB_MAX_DEVICES; ++i) {
        if (ctx->devices[i].dev_hdl != NULL && ctx->devices[i].address == address) {
            return true;
        }
    }
    return false;
}

static usb_diag_device_t *ctx_find_free_slot(usb_diag_ctx_t *ctx)
{
    if (ctx == NULL) {
        return NULL;
    }
    for (size_t i = 0; i < FT710_USB_MAX_DEVICES; ++i) {
        if (ctx->devices[i].dev_hdl == NULL) {
            return &ctx->devices[i];
        }
    }
    return NULL;
}

static void status_store_device(const ft710_usb_device_status_t *snapshot)
{
    if (snapshot == NULL) {
        return;
    }

    status_lock();

    ft710_usb_device_status_t *dst = NULL;
    for (size_t i = 0; i < FT710_USB_MAX_DEVICES; ++i) {
        if (!s_status.devices[i].present && s_status.devices[i].device_address == snapshot->device_address) {
            dst = &s_status.devices[i];
            break;
        }
    }
    if (dst == NULL) {
        for (size_t i = 0; i < FT710_USB_MAX_DEVICES; ++i) {
            if (!s_status.devices[i].present) {
                dst = &s_status.devices[i];
                break;
            }
        }
    }

    if (dst != NULL) {
        *dst = *snapshot;
    } else {
        s_status.device_list_truncated = true;
    }

    s_status.connect_count++;
    s_status.device_count = status_count_present_locked();
    s_status.last_error = ESP_OK;
    status_unlock();
}

static void status_remove_device(uint8_t address, esp_err_t close_err)
{
    status_lock();
    for (size_t i = 0; i < FT710_USB_MAX_DEVICES; ++i) {
        if (s_status.devices[i].present && s_status.devices[i].device_address == address) {
            s_status.devices[i].present = false;
            break;
        }
    }
    s_status.disconnect_count++;
    s_status.device_count = status_count_present_locked();
    if (close_err != ESP_OK) {
        s_status.last_error = (int)close_err;
    }
    status_unlock();
}

static esp_err_t inspect_device(usb_diag_ctx_t *ctx, uint8_t dev_addr)
{
    if (ctx == NULL || dev_addr == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    if (ctx_has_address(ctx, dev_addr)) {
        return ESP_OK;
    }

    usb_diag_device_t *slot = ctx_find_free_slot(ctx);
    if (slot == NULL) {
        ESP_LOGW(TAG, "Cannot track USB address %u: M7 device table is full", dev_addr);
        status_lock();
        s_status.device_list_truncated = true;
        status_unlock();
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "Opening enumerated USB device at address %u", dev_addr);

    usb_device_handle_t dev_hdl = NULL;
    esp_err_t err = usb_host_device_open(ctx->client_hdl, dev_addr, &dev_hdl);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "usb_host_device_open(%u) failed: %s", dev_addr, esp_err_to_name(err));
        status_set_error(err);
        return err;
    }

    usb_device_info_t dev_info;
    memset(&dev_info, 0, sizeof(dev_info));
    err = usb_host_device_info(dev_hdl, &dev_info);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "usb_host_device_info(addr=%u) failed: %s", dev_addr, esp_err_to_name(err));
        usb_host_device_close(ctx->client_hdl, dev_hdl);
        status_set_error(err);
        return err;
    }

    const usb_device_desc_t *dev_desc = NULL;
    err = usb_host_get_device_descriptor(dev_hdl, &dev_desc);
    if (err != ESP_OK || dev_desc == NULL) {
        ESP_LOGE(TAG, "usb_host_get_device_descriptor(addr=%u) failed: %s", dev_addr, esp_err_to_name(err));
        usb_host_device_close(ctx->client_hdl, dev_hdl);
        status_set_error(err);
        return err != ESP_OK ? err : ESP_FAIL;
    }

    const usb_config_desc_t *config_desc = NULL;
    err = usb_host_get_active_config_descriptor(dev_hdl, &config_desc);
    if (err != ESP_OK || config_desc == NULL) {
        ESP_LOGE(TAG, "usb_host_get_active_config_descriptor(addr=%u) failed: %s", dev_addr, esp_err_to_name(err));
        usb_host_device_close(ctx->client_hdl, dev_hdl);
        status_set_error(err);
        return err != ESP_OK ? err : ESP_FAIL;
    }

    ft710_usb_device_status_t snapshot;
    memset(&snapshot, 0, sizeof(snapshot));
    snapshot.present = true;
    snapshot.descriptors_valid = true;
    snapshot.device_address = dev_addr;
    snapshot.speed = (uint8_t)dev_info.speed;
    snapshot.active_configuration = dev_info.bConfigurationValue;
    snapshot.vid = dev_desc->idVendor;
    snapshot.pid = dev_desc->idProduct;
    snapshot.bcd_usb = dev_desc->bcdUSB;
    snapshot.bcd_device = dev_desc->bcdDevice;
    snapshot.device_class = dev_desc->bDeviceClass;
    snapshot.device_subclass = dev_desc->bDeviceSubClass;
    snapshot.device_protocol = dev_desc->bDeviceProtocol;
    snapshot.num_configurations = dev_desc->bNumConfigurations;

    if (s_status.dwc_register_guard_ok) {
        const uint32_t live_hcfg = dwc_reg_read(FT710_DWC_HCFG_OFFSET);
        const uint32_t live_hprt = dwc_reg_read(FT710_DWC_HPRT_OFFSET);
        status_lock();
        s_status.dwc_hcfg_after = live_hcfg;
        s_status.dwc_hprt = live_hprt;
        status_unlock();
        ESP_LOGI(TAG,
                 "M8.3 DWC live at dev=%u: HCFG=0x%08" PRIX32 " FSLSSUPP=%u HPRT=0x%08" PRIX32 " root_speed=%s enumerated_speed=%s",
                 dev_addr, live_hcfg,
                 (unsigned)((live_hcfg & FT710_DWC_HCFG_FSLSSUPP) != 0),
                 live_hprt, dwc_hprt_speed_name(live_hprt),
                 ft710_usb_speed_name(snapshot.speed));
    }

    copy_usb_string_ascii(dev_info.str_desc_manufacturer, snapshot.manufacturer, sizeof(snapshot.manufacturer));
    copy_usb_string_ascii(dev_info.str_desc_product, snapshot.product, sizeof(snapshot.product));
    copy_usb_string_ascii(dev_info.str_desc_serial_num, snapshot.serial, sizeof(snapshot.serial));

    ESP_LOGI(TAG, "================ FT-710 USB M8.3 DWC-FSLS-ONLY DESCRIPTOR DUMP ================");
    ESP_LOGI(TAG,
             "USB-DESC DEVICE addr=%u speed=%s vid=0x%04X pid=0x%04X bcdUSB=0x%04X bcdDevice=0x%04X class=0x%02X subclass=0x%02X protocol=0x%02X configs=%u active_config=%u",
             dev_addr,
             ft710_usb_speed_name(snapshot.speed),
             snapshot.vid,
             snapshot.pid,
             snapshot.bcd_usb,
             snapshot.bcd_device,
             snapshot.device_class,
             snapshot.device_subclass,
             snapshot.device_protocol,
             snapshot.num_configurations,
             snapshot.active_configuration);
    ESP_LOGI(TAG, "USB-DESC ROLE dev=%u role='%s'", dev_addr,
             ft710_usb_device_role(snapshot.vid, snapshot.pid, snapshot.device_class));
    if (snapshot.vid == 0x10C4U && snapshot.pid == 0xEA70U) {
        ESP_LOGI(TAG, "FT-710 CP2105 detected: interface 0 = CAT-1/Enhanced COM, interface 1 = CAT-2/Standard COM (AUX); M8.3 remains descriptor-only");
    }

    ESP_LOGI(TAG,
             "USB-DESC STR dev=%u manufacturer='%s' product='%s' serial='%s'",
             dev_addr,
             snapshot.manufacturer[0] ? snapshot.manufacturer : "(none)",
             snapshot.product[0] ? snapshot.product : "(none)",
             snapshot.serial[0] ? snapshot.serial : "(none)");

    /* Print the native ESP-IDF representation too, including descriptors that
       the compact HTTP snapshot does not interpret. */
    usb_print_device_descriptor(dev_desc);
    usb_print_config_descriptor(config_desc, NULL);
    if (dev_info.str_desc_manufacturer != NULL) {
        usb_print_string_descriptor(dev_info.str_desc_manufacturer);
    }
    if (dev_info.str_desc_product != NULL) {
        usb_print_string_descriptor(dev_info.str_desc_product);
    }
    if (dev_info.str_desc_serial_num != NULL) {
        usb_print_string_descriptor(dev_info.str_desc_serial_num);
    }

    log_and_parse_config_descriptor(config_desc, &snapshot);
    ESP_LOGI(TAG,
             "USB-DESC SUMMARY dev=%u interface_descriptors=%u endpoint_descriptors=%u truncated=%s",
             dev_addr,
             (unsigned)snapshot.interface_count,
             (unsigned)snapshot.endpoint_count,
             snapshot.descriptor_list_truncated ? "yes" : "no");
    ESP_LOGI(TAG, "No application interfaces are claimed in M8.3; CAT/Audio transfers remain disabled until CP2105/audio enumeration is verified.");
    ESP_LOGI(TAG, "===============================================================");

    slot->dev_hdl = dev_hdl;
    slot->address = dev_addr;
    slot->gone = false;
    status_store_device(&snapshot);
    return ESP_OK;
}

static void close_gone_devices(usb_diag_ctx_t *ctx)
{
    if (ctx == NULL) {
        return;
    }

    for (size_t i = 0; i < FT710_USB_MAX_DEVICES; ++i) {
        usb_diag_device_t *slot = &ctx->devices[i];
        if (slot->dev_hdl == NULL || !slot->gone) {
            continue;
        }

        const uint8_t old_addr = slot->address;
        esp_err_t err = usb_host_device_close(ctx->client_hdl, slot->dev_hdl);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "usb_host_device_close(addr=%u) after disconnect: %s",
                     old_addr, esp_err_to_name(err));
        }

        slot->dev_hdl = NULL;
        slot->address = 0;
        slot->gone = false;
        status_remove_device(old_addr, err);
        ESP_LOGW(TAG, "USB device address %u disconnected", old_addr);
    }
}

static esp_err_t scan_enumerated_devices(usb_diag_ctx_t *ctx)
{
    if (ctx == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t addresses[FT710_USB_ADDR_LIST_MAX] = {0};
    int count = 0;
    esp_err_t err = usb_host_device_addr_list_fill(FT710_USB_ADDR_LIST_MAX, addresses, &count);
    if (err != ESP_OK) {
        status_set_error(err);
        return err;
    }

    if (count >= FT710_USB_ADDR_LIST_MAX) {
        status_lock();
        s_status.device_list_truncated = true;
        status_unlock();
    }

    for (int i = 0; i < count && i < FT710_USB_ADDR_LIST_MAX; ++i) {
        if (addresses[i] != 0 && !ctx_has_address(ctx, addresses[i])) {
            (void)inspect_device(ctx, addresses[i]);
        }
    }
    return ESP_OK;
}

static void client_event_cb(const usb_host_client_event_msg_t *event_msg, void *arg)
{
    usb_diag_ctx_t *ctx = (usb_diag_ctx_t *)arg;
    if (ctx == NULL || event_msg == NULL) {
        return;
    }

    switch (event_msg->event) {
    case USB_HOST_CLIENT_EVENT_NEW_DEV:
        ESP_LOGI(TAG, "USB new-device event: address=%u", event_msg->new_dev.address);
        ctx->scan_requested = true;
        break;
    case USB_HOST_CLIENT_EVENT_DEV_GONE:
        for (size_t i = 0; i < FT710_USB_MAX_DEVICES; ++i) {
            if (ctx->devices[i].dev_hdl != NULL && event_msg->dev_gone.dev_hdl == ctx->devices[i].dev_hdl) {
                ctx->devices[i].gone = true;
                break;
            }
        }
        ctx->scan_requested = true;
        break;
    default:
        ESP_LOGD(TAG, "USB client event %d", (int)event_msg->event);
        break;
    }
}

static void usb_host_daemon_task(void *arg)
{
    (void)arg;

    /*
     * M8.3 keeps the normal Waveshare onboard Type-A / HS DWC2 peripheral
     * (BIT0), lets ESP-IDF initialize the UTMI PHY, then sets the DWC2 host
     * HCFG.FSLSSUPP bit before the Host Library event loop is allowed to run.
     *
     * This is intentionally different from M8.1: M8.1 only requested a
     * Full-Speed PHY through usb_new_phy(), while M8.3 changes the DWC2 host
     * controller's own "Full/Low-Speed only support" mode bit.
     *
     * We do not manually reset HPRT here because the ESP-IDF host stack owns
     * root-port state.  The experiment is deliberately limited to one guarded
     * HCFG write before enumeration.
     */
    status_lock();
    s_status.initialized = true;
    s_status.peripheral_map = FT710_USB_HOST_PERIPHERAL_MAP;
    s_status.full_speed_phy = false;
    s_status.manual_phy_setup = false;
    s_status.force_full_speed_on_hs_port = true;
    s_status.phy_setup_error = 0;
    s_status.dwc_force_fsls_only = true;
    status_unlock();

    usb_host_config_t host_config = {
        .skip_phy_setup = false,
        .intr_flags = ESP_INTR_FLAG_LOWMED,
        .peripheral_map = FT710_USB_HOST_PERIPHERAL_MAP,
    };

    ESP_LOGI(TAG,
             "M8.3 onboard Type-A Host: peripheral map 0x%X; ESP-IDF initializes HS/UTMI PHY, then DWC2 HCFG.FSLSSUPP is asserted",
             host_config.peripheral_map);

    esp_err_t err = usb_host_install(&host_config);
    s_host_install_result = err;

    status_lock();
    s_status.host_installed = (err == ESP_OK);
    s_status.last_error = (int)err;
    status_unlock();

    if (err != ESP_OK) {
        if (s_start_waiter != NULL) {
            xTaskNotifyGive(s_start_waiter);
        }
        ESP_LOGE(TAG, "USB Host install failed: %s", esp_err_to_name(err));
        vTaskDelete(NULL);
        return;
    }

    /* Critical experiment point: do this before notifying ft710_usb_start(),
       which means the diagnostic client cannot start before the bit is set. */
    const bool fsls_latched = dwc_force_fsls_only();
    if (!fsls_latched) {
        s_host_install_result = ESP_ERR_INVALID_STATE;
        status_set_error(ESP_ERR_INVALID_STATE);
        ESP_LOGE(TAG, "M8.3 aborted USB enumeration experiment because HCFG.FSLSSUPP could not be safely latched");
    }

    if (s_start_waiter != NULL) {
        xTaskNotifyGive(s_start_waiter);
    }

    if (!fsls_latched) {
        vTaskDelete(NULL);
        return;
    }

    ESP_LOGI(TAG, "M8.3 HCFG.FSLSSUPP latched BEFORE USB Host event processing; waiting 500 ms before first host event");
    ESP_LOGI(TAG, "M8.3 success criterion: FT-710 hub 04B4:6560 must enumerate speed=full and TT errors must disappear");
    ESP_LOGI(TAG, "If FT-710 was already connected at boot and still behaves oddly, unplug/replug only the FT-710 USB cable after this line");
    vTaskDelay(pdMS_TO_TICKS(500));

    for (;;) {
        uint32_t event_flags = 0;
        err = usb_host_lib_handle_events(portMAX_DELAY, &event_flags);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "usb_host_lib_handle_events failed: %s", esp_err_to_name(err));
            status_set_error(err);
            vTaskDelay(pdMS_TO_TICKS(100));
        }
    }
}

static void usb_diag_client_task(void *arg)
{
    (void)arg;

    usb_diag_ctx_t ctx;
    memset(&ctx, 0, sizeof(ctx));

    usb_host_client_config_t client_config = {
        .is_synchronous = false,
        .max_num_event_msg = 16,
        .async = {
            .client_event_callback = client_event_cb,
            .callback_arg = &ctx,
        },
    };

    esp_err_t err = usb_host_client_register(&client_config, &ctx.client_hdl);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "USB diagnostic client registration failed: %s", esp_err_to_name(err));
        status_set_error(err);
        vTaskDelete(NULL);
        return;
    }

    status_lock();
    s_status.client_registered = true;
    s_status.last_error = ESP_OK;
    status_unlock();

    ESP_LOGI(TAG, "USB M8.3 diagnostic client registered (multi-device descriptor-only; no application interface claims)");

    /* ESP-IDF explicitly recommends checking the address list after client
       registration so devices already enumerated before this client existed
       are not missed. */
    ctx.scan_requested = true;
    TickType_t last_scan = 0;

    for (;;) {
        err = usb_host_client_handle_events(ctx.client_hdl, pdMS_TO_TICKS(250));
        if (err != ESP_OK && err != ESP_ERR_TIMEOUT) {
            ESP_LOGW(TAG, "usb_host_client_handle_events: %s", esp_err_to_name(err));
            status_set_error(err);
        }

        close_gone_devices(&ctx);

        const TickType_t now = xTaskGetTickCount();
        if (ctx.scan_requested || (now - last_scan) >= pdMS_TO_TICKS(FT710_USB_SCAN_PERIOD_MS)) {
            ctx.scan_requested = false;
            last_scan = now;
            (void)scan_enumerated_devices(&ctx);
        }
    }
}

esp_err_t ft710_usb_start(void)
{
    if (s_status_mutex != NULL) {
        return ESP_OK;
    }

    s_status_mutex = xSemaphoreCreateMutex();
    if (s_status_mutex == NULL) {
        return ESP_ERR_NO_MEM;
    }

    memset(&s_status, 0, sizeof(s_status));
    s_start_waiter = xTaskGetCurrentTaskHandle();
    s_host_install_result = ESP_ERR_INVALID_STATE;

    BaseType_t task_ok = xTaskCreate(usb_host_daemon_task,
                                     "ft710_usb_host",
                                     FT710_USB_HOST_TASK_STACK,
                                     NULL,
                                     FT710_USB_HOST_TASK_PRIO,
                                     NULL);
    if (task_ok != pdPASS) {
        vSemaphoreDelete(s_status_mutex);
        s_status_mutex = NULL;
        return ESP_ERR_NO_MEM;
    }

    if (ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(2000)) == 0) {
        ESP_LOGE(TAG, "Timed out waiting for USB Host installation");
        status_set_error(ESP_ERR_TIMEOUT);
        return ESP_ERR_TIMEOUT;
    }

    s_start_waiter = NULL;
    if (s_host_install_result != ESP_OK) {
        return s_host_install_result;
    }

    task_ok = xTaskCreate(usb_diag_client_task,
                          "ft710_usb_diag",
                          FT710_USB_CLIENT_TASK_STACK,
                          NULL,
                          FT710_USB_CLIENT_TASK_PRIO,
                          NULL);
    if (task_ok != pdPASS) {
        status_set_error(ESP_ERR_NO_MEM);
        return ESP_ERR_NO_MEM;
    }

    return ESP_OK;
}

void ft710_usb_get_status(ft710_usb_status_t *status)
{
    if (status == NULL) {
        return;
    }

    memset(status, 0, sizeof(*status));
    if (s_status_mutex == NULL) {
        return;
    }

    status_lock();
    *status = s_status;
    status_unlock();
}
