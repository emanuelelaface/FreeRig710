#include "ft710_audio.h"

#include <inttypes.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"
#include "usb/usb_host.h"
#include "usb/usb_types_ch9.h"

#define FT710_AUDIO_TASK_STACK             7168
#define FT710_AUDIO_TASK_PRIO              5
#define FT710_AUDIO_SCAN_PERIOD_MS         500
#define FT710_AUDIO_ADDR_LIST_MAX          16
#define FT710_AUDIO_VID                    0x0D8CU
#define FT710_AUDIO_PID                    0x0013U
#define FT710_AUDIO_RATE_HZ                48000U
#define FT710_AUDIO_CHANNELS               1U
#define FT710_AUDIO_BITS                   16U
#define FT710_AUDIO_BYTES_PER_SAMPLE       2U
#define FT710_AUDIO_EXPECTED_PACKET_BYTES  96U
#define FT710_AUDIO_ISOC_TRANSFERS         4U
#define FT710_AUDIO_ISOC_PACKETS_PER_XFER  8U
#define FT710_AUDIO_CTRL_BUF_SIZE          32U
#define FT710_AUDIO_CTRL_WAIT_MS           1000U
#define FT710_AUDIO_PCM_STREAM_BYTES        16384U

#define USB_DESC_INTERFACE                 0x04U
#define USB_DESC_ENDPOINT                  0x05U
#define USB_DESC_CS_INTERFACE              0x24U
#define UAC_CLASS_AUDIO                    0x01U
#define UAC_SUBCLASS_AUDIOSTREAMING        0x02U
#define UAC_AS_FORMAT_TYPE                 0x02U
#define UAC_FORMAT_TYPE_I                  0x01U

#define USB_REQTYPE_STD_OUT_INTERFACE      0x01U
#define USB_REQ_SET_INTERFACE              0x0BU
#define UAC_REQTYPE_CLASS_OUT_ENDPOINT     0x22U
#define UAC_REQ_SET_CUR                    0x01U
#define UAC_EP_SAMPLING_FREQ_CONTROL       0x0100U

static const char *TAG = "ft710_audio";

static SemaphoreHandle_t s_status_mutex;
static StreamBufferHandle_t s_pcm_stream;
static bool s_pcm_consumer_active;
static ft710_audio_status_t s_status;
static TaskHandle_t s_audio_task_handle;
static portMUX_TYPE s_tx_pause_mux = portMUX_INITIALIZER_UNLOCKED;
static bool s_tx_pause_requested;

typedef struct audio_ctx_s audio_ctx_t;

typedef struct {
    bool done;
    usb_transfer_status_t status;
    int actual_num_bytes;
} control_wait_t;

typedef struct {
    uint8_t interface_number;
    uint8_t alternate_setting;
    uint8_t endpoint;
    uint16_t mps;
    uint8_t channels;
    uint8_t subframe_size;
    uint8_t bit_resolution;
    bool rate_48000;
} audio_stream_desc_t;

struct audio_ctx_s {
    usb_host_client_handle_t client_hdl;
    usb_device_handle_t dev_hdl;
    uint8_t dev_addr;
    bool dev_gone;
    bool scan_requested;
    bool stopping;

    audio_stream_desc_t stream;
    usb_transfer_t *ctrl_xfer;
    usb_transfer_t *isoc[FT710_AUDIO_ISOC_TRANSFERS];
    uint32_t isoc_inflight;
};

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

static void status_error(esp_err_t err)
{
    status_lock();
    s_status.last_error = (int)err;
    status_unlock();
}

static uint32_t read_u24(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16);
}

static bool format_supports_48k(const uint8_t *desc, uint8_t len)
{
    if (desc == NULL || len < 8 || desc[1] != USB_DESC_CS_INTERFACE ||
        desc[2] != UAC_AS_FORMAT_TYPE || desc[3] != UAC_FORMAT_TYPE_I) {
        return false;
    }
    const uint8_t freq_type = desc[7];
    if (freq_type == 0) {
        if (len < 14) return false;
        const uint32_t min_hz = read_u24(&desc[8]);
        const uint32_t max_hz = read_u24(&desc[11]);
        return FT710_AUDIO_RATE_HZ >= min_hz && FT710_AUDIO_RATE_HZ <= max_hz;
    }
    if (len < (uint8_t)(8U + (uint8_t)(3U * freq_type))) return false;
    for (uint8_t i = 0; i < freq_type; ++i) {
        if (read_u24(&desc[8U + 3U * i]) == FT710_AUDIO_RATE_HZ) return true;
    }
    return false;
}

static bool find_rx_stream(const usb_config_desc_t *config, audio_stream_desc_t *out)
{
    if (config == NULL || out == NULL) return false;
    memset(out, 0, sizeof(*out));

    const uint8_t *raw = (const uint8_t *)config;
    const size_t total = config->wTotalLength;
    uint8_t current_if = 0xFF;
    uint8_t current_alt = 0xFF;
    bool current_audio_as = false;
    audio_stream_desc_t candidate = {0};
    bool candidate_has_format = false;

    for (size_t off = 0; off + 2 <= total;) {
        const uint8_t len = raw[off];
        const uint8_t type = raw[off + 1];
        if (len < 2 || off + len > total) break;

        if (type == USB_DESC_INTERFACE && len >= 9) {
            if (candidate.endpoint != 0 && candidate_has_format && candidate.rate_48000 &&
                candidate.channels == FT710_AUDIO_CHANNELS &&
                candidate.subframe_size == FT710_AUDIO_BYTES_PER_SAMPLE &&
                candidate.bit_resolution == FT710_AUDIO_BITS) {
                *out = candidate;
                return true;
            }
            const usb_intf_desc_t *intf = (const usb_intf_desc_t *)(raw + off);
            current_if = intf->bInterfaceNumber;
            current_alt = intf->bAlternateSetting;
            current_audio_as = intf->bInterfaceClass == UAC_CLASS_AUDIO &&
                               intf->bInterfaceSubClass == UAC_SUBCLASS_AUDIOSTREAMING &&
                               current_alt != 0;
            memset(&candidate, 0, sizeof(candidate));
            candidate.interface_number = current_if;
            candidate.alternate_setting = current_alt;
            candidate_has_format = false;
        } else if (current_audio_as && type == USB_DESC_CS_INTERFACE && len >= 8 &&
                   raw[off + 2] == UAC_AS_FORMAT_TYPE && raw[off + 3] == UAC_FORMAT_TYPE_I) {
            candidate.channels = raw[off + 4];
            candidate.subframe_size = raw[off + 5];
            candidate.bit_resolution = raw[off + 6];
            candidate.rate_48000 = format_supports_48k(raw + off, len);
            candidate_has_format = true;
        } else if (current_audio_as && type == USB_DESC_ENDPOINT && len >= 7) {
            const usb_ep_desc_t *ep = (const usb_ep_desc_t *)(raw + off);
            const uint8_t transfer_type = ep->bmAttributes & 0x03U;
            if (transfer_type == USB_TRANSFER_TYPE_ISOCHRONOUS &&
                (ep->bEndpointAddress & 0x80U) != 0) {
                candidate.endpoint = ep->bEndpointAddress;
                candidate.mps = ep->wMaxPacketSize & 0x07FFU;
            }
        }
        off += len;
    }

    if (candidate.endpoint != 0 && candidate_has_format && candidate.rate_48000 &&
        candidate.channels == FT710_AUDIO_CHANNELS &&
        candidate.subframe_size == FT710_AUDIO_BYTES_PER_SAMPLE &&
        candidate.bit_resolution == FT710_AUDIO_BITS) {
        *out = candidate;
        return true;
    }
    return false;
}

static void control_cb(usb_transfer_t *transfer)
{
    control_wait_t *wait = (control_wait_t *)transfer->context;
    if (wait == NULL) return;
    wait->status = transfer->status;
    wait->actual_num_bytes = transfer->actual_num_bytes;
    wait->done = true;
}

static esp_err_t pump_control(audio_ctx_t *ctx, control_wait_t *wait, uint32_t timeout_ms)
{
    const int64_t deadline = esp_timer_get_time() + (int64_t)timeout_ms * 1000LL;
    while (!wait->done && !ctx->dev_gone && esp_timer_get_time() < deadline) {
        esp_err_t err = usb_host_client_handle_events(ctx->client_hdl, pdMS_TO_TICKS(20));
        if (err != ESP_OK && err != ESP_ERR_TIMEOUT) return err;
    }
    if (ctx->dev_gone) return ESP_ERR_INVALID_STATE;
    if (!wait->done) return ESP_ERR_TIMEOUT;
    return wait->status == USB_TRANSFER_STATUS_COMPLETED ? ESP_OK : ESP_FAIL;
}

static esp_err_t control_out(audio_ctx_t *ctx, uint8_t bmRequestType, uint8_t bRequest,
                             uint16_t wValue, uint16_t wIndex,
                             const void *payload, uint16_t payload_len)
{
    if (ctx == NULL || ctx->dev_hdl == NULL || ctx->ctrl_xfer == NULL) return ESP_ERR_INVALID_STATE;
    const size_t total = sizeof(usb_setup_packet_t) + payload_len;
    if (total > ctx->ctrl_xfer->data_buffer_size) return ESP_ERR_INVALID_SIZE;

    memset(ctx->ctrl_xfer->data_buffer, 0, ctx->ctrl_xfer->data_buffer_size);
    usb_setup_packet_t *setup = (usb_setup_packet_t *)ctx->ctrl_xfer->data_buffer;
    setup->bmRequestType = bmRequestType;
    setup->bRequest = bRequest;
    setup->wValue = wValue;
    setup->wIndex = wIndex;
    setup->wLength = payload_len;
    if (payload_len != 0 && payload != NULL) {
        memcpy(ctx->ctrl_xfer->data_buffer + sizeof(usb_setup_packet_t), payload, payload_len);
    }

    control_wait_t wait = {
        .done = false,
        .status = USB_TRANSFER_STATUS_ERROR,
        .actual_num_bytes = 0,
    };
    ctx->ctrl_xfer->device_handle = ctx->dev_hdl;
    ctx->ctrl_xfer->bEndpointAddress = 0;
    ctx->ctrl_xfer->num_bytes = (int)total;
    ctx->ctrl_xfer->callback = control_cb;
    ctx->ctrl_xfer->context = &wait;
    ctx->ctrl_xfer->timeout_ms = FT710_AUDIO_CTRL_WAIT_MS;

    esp_err_t err = usb_host_transfer_submit_control(ctx->client_hdl, ctx->ctrl_xfer);
    if (err == ESP_OK) err = pump_control(ctx, &wait, FT710_AUDIO_CTRL_WAIT_MS);
    return err;
}

static esp_err_t set_interface(audio_ctx_t *ctx, uint8_t interface_number, uint8_t alt)
{
    return control_out(ctx, USB_REQTYPE_STD_OUT_INTERFACE, USB_REQ_SET_INTERFACE,
                       alt, interface_number, NULL, 0);
}

static esp_err_t set_sampling_rate_48k(audio_ctx_t *ctx, uint8_t endpoint)
{
    const uint8_t rate[3] = {
        (uint8_t)(FT710_AUDIO_RATE_HZ & 0xFFU),
        (uint8_t)((FT710_AUDIO_RATE_HZ >> 8) & 0xFFU),
        (uint8_t)((FT710_AUDIO_RATE_HZ >> 16) & 0xFFU),
    };
    return control_out(ctx, UAC_REQTYPE_CLASS_OUT_ENDPOINT, UAC_REQ_SET_CUR,
                       UAC_EP_SAMPLING_FREQ_CONTROL, endpoint, rate, sizeof(rate));
}

static void account_pcm(const uint8_t *data, size_t len, uint16_t *peak_out, uint16_t *mean_abs_out)
{
    uint32_t peak = 0;
    uint64_t sum_abs = 0;
    size_t samples = 0;
    for (size_t i = 0; i + 1 < len; i += 2) {
        const int16_t sample = (int16_t)((uint16_t)data[i] | ((uint16_t)data[i + 1] << 8));
        const uint32_t mag = sample == INT16_MIN ? 32768U : (uint32_t)(sample < 0 ? -sample : sample);
        if (mag > peak) peak = mag;
        sum_abs += mag;
        samples++;
    }
    *peak_out = (uint16_t)peak;
    *mean_abs_out = samples != 0 ? (uint16_t)(sum_abs / samples) : 0;
}

static void isoc_cb(usb_transfer_t *transfer)
{
    audio_ctx_t *ctx = (audio_ctx_t *)transfer->context;
    if (ctx == NULL) return;
    if (ctx->isoc_inflight > 0) ctx->isoc_inflight--;

    uint32_t completed = 0;
    uint32_t skipped = 0;
    uint32_t errors = 0;
    uint32_t expected_size = 0;
    uint32_t other_size = 0;
    uint64_t bytes = 0;
    uint16_t last_packet = 0;
    uint16_t peak = 0;
    uint64_t mean_weighted_sum = 0;
    uint64_t mean_weight = 0;
    size_t data_offset = 0;
    uint8_t pcm_batch[FT710_AUDIO_ISOC_PACKETS_PER_XFER * 100U];
    size_t pcm_batch_len = 0;

    if (transfer->status == USB_TRANSFER_STATUS_COMPLETED) {
        for (int i = 0; i < transfer->num_isoc_packets; ++i) {
            const usb_isoc_packet_desc_t *pkt = &transfer->isoc_packet_desc[i];
            const int actual = pkt->actual_num_bytes;
            if (pkt->status == USB_TRANSFER_STATUS_COMPLETED) {
                completed++;
                if (actual > 0) {
                    const size_t actual_sz = (size_t)actual;
                    uint16_t pkt_peak = 0;
                    uint16_t pkt_mean = 0;
                    account_pcm(transfer->data_buffer + data_offset, actual_sz, &pkt_peak, &pkt_mean);
                    if (pkt_peak > peak) peak = pkt_peak;
                    mean_weighted_sum += (uint64_t)pkt_mean * (actual_sz / 2U);
                    mean_weight += actual_sz / 2U;
                    bytes += actual_sz;
                    last_packet = (uint16_t)actual_sz;
                    if (pcm_batch_len + actual_sz <= sizeof(pcm_batch)) {
                        memcpy(pcm_batch + pcm_batch_len, transfer->data_buffer + data_offset, actual_sz);
                        pcm_batch_len += actual_sz;
                    }
                    if (actual_sz == FT710_AUDIO_EXPECTED_PACKET_BYTES) expected_size++;
                    else other_size++;
                }
            } else if (pkt->status == USB_TRANSFER_STATUS_SKIPPED) {
                skipped++;
            } else {
                errors++;
            }
            data_offset += (size_t)pkt->num_bytes;
        }
    } else {
        errors = (uint32_t)transfer->num_isoc_packets;
    }

    size_t pcm_sent = 0;
    bool pcm_consumer = false;
    status_lock();
    pcm_consumer = s_pcm_consumer_active;
    status_unlock();
    if (pcm_consumer && s_pcm_stream != NULL && pcm_batch_len != 0) {
        pcm_sent = xStreamBufferSend(s_pcm_stream, pcm_batch, pcm_batch_len, 0);
    }

    status_lock();
    s_status.transfer_callbacks++;
    if (transfer->status != USB_TRANSFER_STATUS_COMPLETED) s_status.transfer_errors++;
    s_status.packets_total += (uint32_t)transfer->num_isoc_packets;
    s_status.packets_completed += completed;
    s_status.packets_skipped += skipped;
    s_status.packets_error += errors;
    s_status.packets_expected_size += expected_size;
    s_status.packets_other_size += other_size;
    s_status.rx_bytes += bytes;
    s_status.rx_samples += bytes / FT710_AUDIO_BYTES_PER_SAMPLE;
    s_status.last_packet_bytes = last_packet;
    s_status.peak_abs = peak;
    s_status.mean_abs = mean_weight != 0 ? (uint16_t)(mean_weighted_sum / mean_weight) : 0;
    s_status.updated_ms = (uint64_t)(esp_timer_get_time() / 1000LL);
    if (pcm_consumer) {
        s_status.pcm_stream_bytes += pcm_sent;
        if (pcm_batch_len > pcm_sent) {
            s_status.pcm_stream_dropped_bytes += (uint64_t)(pcm_batch_len - pcm_sent);
        }
        if (s_pcm_stream != NULL) {
            s_status.pcm_buffered_bytes = (uint32_t)xStreamBufferBytesAvailable(s_pcm_stream);
        }
    }
    if (transfer->status != USB_TRANSFER_STATUS_COMPLETED) s_status.last_error = ESP_FAIL;
    status_unlock();

    if (!ctx->stopping && !ctx->dev_gone && ctx->dev_hdl != NULL) {
        transfer->num_bytes = (int)(ctx->stream.mps * FT710_AUDIO_ISOC_PACKETS_PER_XFER);
        for (int i = 0; i < transfer->num_isoc_packets; ++i) {
            transfer->isoc_packet_desc[i].num_bytes = ctx->stream.mps;
        }
        esp_err_t err = usb_host_transfer_submit(transfer);
        if (err == ESP_OK) {
            ctx->isoc_inflight++;
        } else {
            status_lock();
            s_status.transfer_errors++;
            s_status.last_error = (int)err;
            status_unlock();
        }
    }
}

static esp_err_t alloc_and_submit_isoc(audio_ctx_t *ctx)
{
    const size_t transfer_bytes = (size_t)ctx->stream.mps * FT710_AUDIO_ISOC_PACKETS_PER_XFER;
    for (size_t n = 0; n < FT710_AUDIO_ISOC_TRANSFERS; ++n) {
        esp_err_t err = usb_host_transfer_alloc(transfer_bytes, FT710_AUDIO_ISOC_PACKETS_PER_XFER,
                                                &ctx->isoc[n]);
        if (err != ESP_OK) return err;
        usb_transfer_t *xfer = ctx->isoc[n];
        xfer->device_handle = ctx->dev_hdl;
        xfer->bEndpointAddress = ctx->stream.endpoint;
        xfer->num_bytes = (int)transfer_bytes;
        xfer->callback = isoc_cb;
        xfer->context = ctx;
        xfer->timeout_ms = 0;
        for (int i = 0; i < xfer->num_isoc_packets; ++i) {
            xfer->isoc_packet_desc[i].num_bytes = ctx->stream.mps;
        }
    }

    ctx->isoc_inflight = 0;
    for (size_t n = 0; n < FT710_AUDIO_ISOC_TRANSFERS; ++n) {
        esp_err_t err = usb_host_transfer_submit(ctx->isoc[n]);
        if (err != ESP_OK) return err;
        ctx->isoc_inflight++;
    }
    return ESP_OK;
}

static void free_isoc(audio_ctx_t *ctx)
{
    for (size_t n = 0; n < FT710_AUDIO_ISOC_TRANSFERS; ++n) {
        if (ctx->isoc[n] != NULL) {
            (void)usb_host_transfer_free(ctx->isoc[n]);
            ctx->isoc[n] = NULL;
        }
    }
}

static void cleanup_device(audio_ctx_t *ctx)
{
    if (ctx == NULL || ctx->dev_hdl == NULL) return;
    ctx->stopping = true;

    if (ctx->stream.endpoint != 0) {
        (void)usb_host_endpoint_halt(ctx->dev_hdl, ctx->stream.endpoint);
        (void)usb_host_endpoint_flush(ctx->dev_hdl, ctx->stream.endpoint);
    }
    const int64_t drain_deadline = esp_timer_get_time() + 500000LL;
    while (ctx->isoc_inflight != 0 && esp_timer_get_time() < drain_deadline) {
        esp_err_t pump_err = usb_host_client_handle_events(ctx->client_hdl, pdMS_TO_TICKS(20));
        if (pump_err != ESP_OK && pump_err != ESP_ERR_TIMEOUT) break;
    }
    if (ctx->isoc_inflight == 0) {
        free_isoc(ctx);
    } else {
        ESP_LOGW(TAG, "Audio teardown timed out with %" PRIu32 " isochronous transfers still in flight; buffers retained",
                 ctx->isoc_inflight);
    }
    (void)set_interface(ctx, ctx->stream.interface_number, 0);
    (void)usb_host_interface_release(ctx->client_hdl, ctx->dev_hdl, ctx->stream.interface_number);
    (void)usb_host_device_close(ctx->client_hdl, ctx->dev_hdl);

    ctx->dev_hdl = NULL;
    ctx->dev_addr = 0;
    ctx->dev_gone = false;
    ctx->stopping = false;
    memset(&ctx->stream, 0, sizeof(ctx->stream));

    status_lock();
    s_status.device_present = false;
    s_status.device_open = false;
    s_status.interface_claimed = false;
    s_status.streaming = false;
    s_status.sample_rate_configured = false;
    bool paused;
    portENTER_CRITICAL(&s_tx_pause_mux);
    paused = s_tx_pause_requested;
    portEXIT_CRITICAL(&s_tx_pause_mux);
    if (!paused) s_status.disconnects++;
    status_unlock();
}

static esp_err_t try_open_audio(audio_ctx_t *ctx, uint8_t addr)
{
    usb_device_handle_t dev = NULL;
    esp_err_t err = usb_host_device_open(ctx->client_hdl, addr, &dev);
    if (err != ESP_OK) return err;

    const usb_device_desc_t *desc = NULL;
    err = usb_host_get_device_descriptor(dev, &desc);
    if (err != ESP_OK || desc == NULL) {
        (void)usb_host_device_close(ctx->client_hdl, dev);
        return err != ESP_OK ? err : ESP_FAIL;
    }
    if (desc->idVendor != FT710_AUDIO_VID || desc->idProduct != FT710_AUDIO_PID) {
        (void)usb_host_device_close(ctx->client_hdl, dev);
        return ESP_ERR_NOT_FOUND;
    }

    const usb_config_desc_t *config = NULL;
    err = usb_host_get_active_config_descriptor(dev, &config);
    if (err != ESP_OK || config == NULL) {
        (void)usb_host_device_close(ctx->client_hdl, dev);
        return err != ESP_OK ? err : ESP_FAIL;
    }

    audio_stream_desc_t stream;
    if (!find_rx_stream(config, &stream)) {
        ESP_LOGE(TAG, "C-Media audio found at addr=%u but no 48 kHz mono 16-bit isochronous IN stream was found", addr);
        (void)usb_host_device_close(ctx->client_hdl, dev);
        return ESP_ERR_NOT_SUPPORTED;
    }
    if (stream.mps < FT710_AUDIO_EXPECTED_PACKET_BYTES) {
        ESP_LOGE(TAG, "RX endpoint MPS=%u is smaller than 48 kHz mono16 requirement=%u",
                 stream.mps, FT710_AUDIO_EXPECTED_PACKET_BYTES);
        (void)usb_host_device_close(ctx->client_hdl, dev);
        return ESP_ERR_INVALID_SIZE;
    }

    ctx->dev_hdl = dev;
    ctx->dev_addr = addr;
    ctx->stream = stream;
    ctx->stopping = false;

    err = usb_host_interface_claim(ctx->client_hdl, dev, stream.interface_number, stream.alternate_setting);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Audio RX interface %u alt %u claim failed: %s",
                 stream.interface_number, stream.alternate_setting, esp_err_to_name(err));
        ctx->dev_hdl = NULL;
        (void)usb_host_device_close(ctx->client_hdl, dev);
        return err;
    }

    status_lock();
    s_status.device_present = true;
    s_status.device_open = true;
    s_status.interface_claimed = true;
    s_status.device_address = addr;
    s_status.interface_number = stream.interface_number;
    s_status.alternate_setting = stream.alternate_setting;
    s_status.endpoint = stream.endpoint;
    s_status.max_packet_size = stream.mps;
    s_status.sample_rate_hz = FT710_AUDIO_RATE_HZ;
    s_status.channels = stream.channels;
    s_status.bits_per_sample = stream.bit_resolution;
    s_status.last_error = ESP_OK;
    status_unlock();

    ESP_LOGI(TAG, "FT-710 UAC1 RX found: addr=%u if=%u alt=%u IN=0x%02X MPS=%u mono 16-bit; claiming stream at 48000 Hz",
             addr, stream.interface_number, stream.alternate_setting, stream.endpoint, stream.mps);

    err = set_interface(ctx, stream.interface_number, stream.alternate_setting);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "SET_INTERFACE if=%u alt=%u failed: %s",
                 stream.interface_number, stream.alternate_setting, esp_err_to_name(err));
        cleanup_device(ctx);
        return err;
    }

    err = set_sampling_rate_48k(ctx, stream.endpoint);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "UAC1 SET_CUR sampling frequency 48000 Hz on ep=0x%02X failed: %s",
                 stream.endpoint, esp_err_to_name(err));
        cleanup_device(ctx);
        return err;
    }

    status_lock();
    s_status.sample_rate_configured = true;
    status_unlock();

    err = alloc_and_submit_isoc(ctx);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Initial UAC1 RX isochronous queue failed: %s", esp_err_to_name(err));
        cleanup_device(ctx);
        return err;
    }

    status_lock();
    s_status.streaming = true;
    s_status.started_ms = (uint64_t)(esp_timer_get_time() / 1000LL);
    s_status.updated_ms = s_status.started_ms;
    s_status.last_error = ESP_OK;
    status_unlock();

    ESP_LOGI(TAG, "M10.2 UAC1 RX STREAMING: 48000 Hz mono S16LE, ep=0x%02X, expected=96 bytes/ms, queue=%ux%u packets",
             stream.endpoint, FT710_AUDIO_ISOC_TRANSFERS, FT710_AUDIO_ISOC_PACKETS_PER_XFER);
    return ESP_OK;
}

static void client_event_cb(const usb_host_client_event_msg_t *event_msg, void *arg)
{
    audio_ctx_t *ctx = (audio_ctx_t *)arg;
    if (ctx == NULL || event_msg == NULL) return;
    if (event_msg->event == USB_HOST_CLIENT_EVENT_NEW_DEV) {
        ctx->scan_requested = true;
    } else if (event_msg->event == USB_HOST_CLIENT_EVENT_DEV_GONE &&
               ctx->dev_hdl != NULL && event_msg->dev_gone.dev_hdl == ctx->dev_hdl) {
        ctx->dev_gone = true;
    }
}

static void scan_for_audio(audio_ctx_t *ctx)
{
    if (ctx->dev_hdl != NULL) return;
    uint8_t addresses[FT710_AUDIO_ADDR_LIST_MAX] = {0};
    int count = 0;
    esp_err_t err = usb_host_device_addr_list_fill(FT710_AUDIO_ADDR_LIST_MAX, addresses, &count);
    if (err != ESP_OK) {
        status_error(err);
        return;
    }
    for (int i = 0; i < count && i < FT710_AUDIO_ADDR_LIST_MAX; ++i) {
        if (addresses[i] == 0) continue;
        err = try_open_audio(ctx, addresses[i]);
        if (err == ESP_OK) return;
        if (err != ESP_ERR_NOT_FOUND) status_error(err);
    }
}

static void audio_task(void *arg)
{
    (void)arg;
    s_audio_task_handle = xTaskGetCurrentTaskHandle();
    audio_ctx_t ctx;
    memset(&ctx, 0, sizeof(ctx));

    usb_host_client_config_t config = {
        .is_synchronous = false,
        .max_num_event_msg = 16,
        .async = {
            .client_event_callback = client_event_cb,
            .callback_arg = &ctx,
        },
    };

    esp_err_t err = usb_host_client_register(&config, &ctx.client_hdl);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Audio USB client register failed: %s", esp_err_to_name(err));
        status_error(err);
        vTaskDelete(NULL);
        return;
    }
    err = usb_host_transfer_alloc(FT710_AUDIO_CTRL_BUF_SIZE, 0, &ctx.ctrl_xfer);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Audio control transfer allocation failed: %s", esp_err_to_name(err));
        status_error(err);
        (void)usb_host_client_deregister(ctx.client_hdl);
        vTaskDelete(NULL);
        return;
    }

    status_lock();
    s_status.initialized = true;
    s_status.client_registered = true;
    s_status.sample_rate_hz = FT710_AUDIO_RATE_HZ;
    s_status.channels = FT710_AUDIO_CHANNELS;
    s_status.bits_per_sample = FT710_AUDIO_BITS;
    s_status.last_error = ESP_OK;
    status_unlock();

    ESP_LOGI(TAG, "M10.2 audio client registered; scanning for C-Media 0D8C:0013 UAC1 RX stream");
    ctx.scan_requested = true;
    TickType_t last_scan = 0;
    TickType_t last_log = 0;

    for (;;) {
        bool tx_pause;
        portENTER_CRITICAL(&s_tx_pause_mux);
        tx_pause = s_tx_pause_requested;
        portEXIT_CRITICAL(&s_tx_pause_mux);

        /* FT8.5.10.2 TX half-duplex: while digital RF is active, release the
         * C-Media RX interface entirely.  This removes the simultaneous 96 B/ms
         * isochronous IN schedule from the P4 DWC controller while the 192 B/ms
         * OUT stream is carrying Tune/FT8.  The PCM consumer remains open and
         * resumes automatically when the interface is reopened after TX. */
        if (tx_pause && ctx.dev_hdl != NULL) {
            ESP_LOGI(TAG, "UAC1 RX suspended for digital TX half-duplex");
            cleanup_device(&ctx);
            ctx.scan_requested = false;
        }

        err = usb_host_client_handle_events(ctx.client_hdl, pdMS_TO_TICKS(20));
        if (err != ESP_OK && err != ESP_ERR_TIMEOUT) status_error(err);

        if (ctx.dev_gone) {
            ESP_LOGW(TAG, "FT-710 USB Audio disconnected");
            cleanup_device(&ctx);
            ctx.scan_requested = true;
        }

        TickType_t now = xTaskGetTickCount();
        portENTER_CRITICAL(&s_tx_pause_mux);
        tx_pause = s_tx_pause_requested;
        portEXIT_CRITICAL(&s_tx_pause_mux);
        if (!tx_pause && (ctx.scan_requested || (now - last_scan) >= pdMS_TO_TICKS(FT710_AUDIO_SCAN_PERIOD_MS))) {
            ctx.scan_requested = false;
            last_scan = now;
            scan_for_audio(&ctx);
        }

        if (ctx.dev_hdl != NULL && (last_log == 0 || (now - last_log) >= pdMS_TO_TICKS(5000))) {
            last_log = now;
            ft710_audio_status_t st;
            ft710_audio_get_status(&st);
            if (st.streaming) {
                ESP_LOGI(TAG,
                         "RX audio: bytes=%" PRIu64 " samples=%" PRIu64 " packets=%" PRIu32
                         " ok=%" PRIu32 " skip=%" PRIu32 " err=%" PRIu32
                         " size96=%" PRIu32 " other=%" PRIu32 " last=%u peak=%u mean_abs=%u",
                         st.rx_bytes, st.rx_samples, st.packets_total, st.packets_completed,
                         st.packets_skipped, st.packets_error, st.packets_expected_size,
                         st.packets_other_size, st.last_packet_bytes, st.peak_abs, st.mean_abs);
            }
        }
    }
}

esp_err_t ft710_audio_start(void)
{
    if (s_status_mutex != NULL) return ESP_OK;
    s_status_mutex = xSemaphoreCreateMutex();
    if (s_status_mutex == NULL) return ESP_ERR_NO_MEM;
    s_pcm_stream = xStreamBufferCreate(FT710_AUDIO_PCM_STREAM_BYTES, 1);
    if (s_pcm_stream == NULL) {
        vSemaphoreDelete(s_status_mutex);
        s_status_mutex = NULL;
        return ESP_ERR_NO_MEM;
    }
    s_pcm_consumer_active = false;
    portENTER_CRITICAL(&s_tx_pause_mux);
    s_tx_pause_requested = false;
    portEXIT_CRITICAL(&s_tx_pause_mux);
    memset(&s_status, 0, sizeof(s_status));
    s_status.pcm_buffer_capacity = FT710_AUDIO_PCM_STREAM_BYTES;

    BaseType_t ok = xTaskCreate(audio_task, "ft710_audio", FT710_AUDIO_TASK_STACK, NULL,
                                FT710_AUDIO_TASK_PRIO, NULL);
    if (ok != pdPASS) {
        vStreamBufferDelete(s_pcm_stream);
        s_pcm_stream = NULL;
        vSemaphoreDelete(s_status_mutex);
        s_status_mutex = NULL;
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

esp_err_t ft710_audio_set_tx_half_duplex(bool pause, uint32_t timeout_ms)
{
    if (s_status_mutex == NULL) return ESP_ERR_INVALID_STATE;
    portENTER_CRITICAL(&s_tx_pause_mux);
    s_tx_pause_requested = pause;
    portEXIT_CRITICAL(&s_tx_pause_mux);
    if (s_audio_task_handle != NULL) xTaskNotifyGive(s_audio_task_handle);

    const int64_t deadline = esp_timer_get_time() + (int64_t)timeout_ms * 1000LL;
    for (;;) {
        ft710_audio_status_t st;
        ft710_audio_get_status(&st);
        if (pause) {
            if (!st.streaming && !st.device_open) return ESP_OK;
        } else {
            if (st.streaming && st.device_open) return ESP_OK;
        }
        if (esp_timer_get_time() >= deadline) return ESP_ERR_TIMEOUT;
        vTaskDelay(1);
    }
}

bool ft710_audio_tx_half_duplex_requested(void)
{
    bool paused;
    portENTER_CRITICAL(&s_tx_pause_mux);
    paused = s_tx_pause_requested;
    portEXIT_CRITICAL(&s_tx_pause_mux);
    return paused;
}

void ft710_audio_get_status(ft710_audio_status_t *status)
{
    if (status == NULL) return;
    memset(status, 0, sizeof(*status));
    if (s_status_mutex == NULL) return;
    status_lock();
    *status = s_status;
    status_unlock();
}

bool ft710_audio_pcm_stream_open(void)
{
    if (s_status_mutex == NULL || s_pcm_stream == NULL) return false;
    bool ok = false;
    status_lock();
    if (!s_pcm_consumer_active && s_status.streaming) {
        (void)xStreamBufferReset(s_pcm_stream);
        s_pcm_consumer_active = true;
        s_status.pcm_consumer_active = true;
        s_status.pcm_buffered_bytes = 0;
        s_status.pcm_stream_opens++;
        ok = true;
    }
    status_unlock();
    return ok;
}

size_t ft710_audio_pcm_stream_read(void *buffer, size_t capacity, uint32_t timeout_ms)
{
    if (buffer == NULL || capacity == 0 || s_pcm_stream == NULL) return 0;
    status_lock();
    const bool active = s_pcm_consumer_active;
    status_unlock();
    if (!active) return 0;

    const size_t got = xStreamBufferReceive(s_pcm_stream, buffer, capacity, pdMS_TO_TICKS(timeout_ms));
    status_lock();
    s_status.pcm_buffered_bytes = (uint32_t)xStreamBufferBytesAvailable(s_pcm_stream);
    status_unlock();
    return got;
}

void ft710_audio_pcm_stream_close(void)
{
    if (s_status_mutex == NULL || s_pcm_stream == NULL) return;
    status_lock();
    s_pcm_consumer_active = false;
    s_status.pcm_consumer_active = false;
    (void)xStreamBufferReset(s_pcm_stream);
    s_status.pcm_buffered_bytes = 0;
    status_unlock();
}

