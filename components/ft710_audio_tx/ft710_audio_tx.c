#include "ft710_audio_tx.h"

#include <inttypes.h>
#include <math.h>
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

#define FT710_TX_TASK_STACK                7168
#define FT710_TX_TASK_PRIO                 5
#define FT710_TX_SCAN_PERIOD_MS            500
#define FT710_TX_ADDR_LIST_MAX             16
#define FT710_TX_VID                       0x0D8CU
#define FT710_TX_PID                       0x0013U
#define FT710_TX_RATE_HZ                   48000U
#define FT710_TX_CHANNELS                  2U
#define FT710_TX_BITS                      16U
#define FT710_TX_SUBFRAME_BYTES            2U
#define FT710_TX_MONO_FRAME_BYTES          2U
#define FT710_TX_STEREO_FRAME_BYTES        4U
#define FT710_TX_FRAMES_PER_MS             48U
#define FT710_TX_PACKET_BYTES              (FT710_TX_FRAMES_PER_MS * FT710_TX_STEREO_FRAME_BYTES)
/* Diagnostic transport experiment: one USB Full-Speed frame per URB.  Keeping
 * 32 one-packet URBs queued gives 32 ms of hardware lead without relying on
 * the ESP32-P4/DWC multi-packet isochronous descriptor path. */
#define FT710_TX_ISOC_TRANSFERS            32U
#define FT710_TX_ISOC_PACKETS_PER_XFER     1U
#define FT710_TX_CTRL_BUF_SIZE             32U
#define FT710_TX_CTRL_WAIT_MS              1000U
#define FT710_TX_INPUT_STREAM_BYTES        65536U
#define FT710_TX_INPUT_TARGET_MAX_BYTES    16384U
#define FT710_TX_TONE_TASK_STACK            3072U
#define FT710_TX_TONE_TASK_PRIO             4U
#define FT710_TX_TONE_BLOCK_FRAMES          480U /* 10 ms at 48 kHz */
#define FT710_TX_TONE_TARGET_BYTES           12288U /* ~128 ms mono lead */

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

static const char *TAG = "ft710_audio_tx";

static SemaphoreHandle_t s_status_mutex;
static SemaphoreHandle_t s_input_mutex;
static StreamBufferHandle_t s_input_stream;
static ft710_audio_tx_status_t s_status;

/* Bounded ALC Tune oscillator. 1500 Hz at 48 kHz is exactly 32 samples/cycle,
 * so a fixed Q15 table gives a phase-stable tone independent of task timing. */
static portMUX_TYPE s_tone_mux = portMUX_INITIALIZER_UNLOCKED;
static bool s_tone_active;
static int32_t s_tone_amp_q15;
static uint8_t s_tone_phase;
static uint32_t s_tone_frequency_hz = 1500U;
static TaskHandle_t s_tone_task_handle;
static const int16_t s_tone_1500_q15[32] = {
    0, 6393, 12539, 18204, 23170, 27245, 30273, 32137,
    32767, 32137, 30273, 27245, 23170, 18204, 12539, 6393,
    0, -6393, -12539, -18204, -23170, -27245, -30273, -32137,
    -32767, -32137, -30273, -27245, -23170, -18204, -12539, -6393
};

static const int16_t s_tone_1000_q15[48] = {
    0, 4277, 8481, 12539, 16383, 19947, 23170, 25996,
    28377, 30273, 31650, 32487, 32767, 32487, 31650, 30273,
    28377, 25996, 23170, 19947, 16383, 12539, 8481, 4277,
    0, -4277, -8481, -12539, -16383, -19947, -23170, -25996,
    -28377, -30273, -31650, -32487, -32767, -32487, -31650, -30273,
    -28377, -25996, -23170, -19947, -16384, -12539, -8481, -4277
};

typedef struct tx_ctx_s tx_ctx_t;

/* Forward declaration: the task is created in ft710_audio_tx_start() and
 * implemented later in this translation unit. */
static void tone_fifo_task(void *arg);

typedef struct {
    bool done;
    usb_transfer_status_t status;
} control_wait_t;

typedef struct {
    uint8_t interface_number;
    uint8_t alternate_setting;
    uint8_t endpoint;
    uint16_t mps;
    uint8_t channels;
    uint8_t subframe_size;
    uint8_t bit_resolution;
    bool target_rate_supported;
} tx_stream_desc_t;

struct tx_ctx_s {
    usb_host_client_handle_t client_hdl;
    usb_device_handle_t dev_hdl;
    uint8_t dev_addr;
    bool dev_gone;
    bool scan_requested;
    bool stopping;

    tx_stream_desc_t stream;
    usb_transfer_t *ctrl_xfer;
    usb_transfer_t *isoc[FT710_TX_ISOC_TRANSFERS];
    uint32_t isoc_inflight;
};

static int isoc_index_for_transfer(const tx_ctx_t *ctx, const usb_transfer_t *transfer)
{
    if (ctx == NULL || transfer == NULL) return -1;
    for (size_t i = 0; i < FT710_TX_ISOC_TRANSFERS; ++i) {
        if (ctx->isoc[i] == transfer) return (int)i;
    }
    return -1;
}

static esp_err_t submit_isoc_transfer(tx_ctx_t *ctx, size_t index)
{
    if (ctx == NULL || index >= FT710_TX_ISOC_TRANSFERS || ctx->isoc[index] == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    const esp_err_t err = usb_host_transfer_submit(ctx->isoc[index]);
    if (err == ESP_OK) ctx->isoc_inflight++;
    return err;
}

static void status_lock(void)
{
    if (s_status_mutex != NULL) xSemaphoreTake(s_status_mutex, portMAX_DELAY);
}

static void status_unlock(void)
{
    if (s_status_mutex != NULL) xSemaphoreGive(s_status_mutex);
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

static bool format_supports_target_rate(const uint8_t *desc, uint8_t len)
{
    if (desc == NULL || len < 8 || desc[1] != USB_DESC_CS_INTERFACE ||
        desc[2] != UAC_AS_FORMAT_TYPE || desc[3] != UAC_FORMAT_TYPE_I) return false;
    const uint8_t freq_type = desc[7];
    if (freq_type == 0) {
        if (len < 14) return false;
        return FT710_TX_RATE_HZ >= read_u24(&desc[8]) && FT710_TX_RATE_HZ <= read_u24(&desc[11]);
    }
    if (len < (uint8_t)(8U + 3U * freq_type)) return false;
    for (uint8_t i = 0; i < freq_type; ++i) {
        if (read_u24(&desc[8U + 3U * i]) == FT710_TX_RATE_HZ) return true;
    }
    return false;
}

static bool find_tx_stream(const usb_config_desc_t *config, tx_stream_desc_t *out)
{
    if (config == NULL || out == NULL) return false;
    memset(out, 0, sizeof(*out));

    const uint8_t *raw = (const uint8_t *)config;
    const size_t total = config->wTotalLength;
    bool current_audio_as = false;
    tx_stream_desc_t candidate = {0};
    bool candidate_has_format = false;

    for (size_t off = 0; off + 2 <= total;) {
        const uint8_t len = raw[off];
        const uint8_t type = raw[off + 1];
        if (len < 2 || off + len > total) break;

        if (type == USB_DESC_INTERFACE && len >= 9) {
            if (candidate.endpoint != 0 && candidate_has_format && candidate.target_rate_supported &&
                candidate.channels == FT710_TX_CHANNELS &&
                candidate.subframe_size == FT710_TX_SUBFRAME_BYTES &&
                candidate.bit_resolution == FT710_TX_BITS) {
                *out = candidate;
                return true;
            }
            const usb_intf_desc_t *intf = (const usb_intf_desc_t *)(raw + off);
            current_audio_as = intf->bInterfaceClass == UAC_CLASS_AUDIO &&
                               intf->bInterfaceSubClass == UAC_SUBCLASS_AUDIOSTREAMING &&
                               intf->bAlternateSetting != 0;
            memset(&candidate, 0, sizeof(candidate));
            candidate.interface_number = intf->bInterfaceNumber;
            candidate.alternate_setting = intf->bAlternateSetting;
            candidate_has_format = false;
        } else if (current_audio_as && type == USB_DESC_CS_INTERFACE && len >= 8 &&
                   raw[off + 2] == UAC_AS_FORMAT_TYPE && raw[off + 3] == UAC_FORMAT_TYPE_I) {
            candidate.channels = raw[off + 4];
            candidate.subframe_size = raw[off + 5];
            candidate.bit_resolution = raw[off + 6];
            candidate.target_rate_supported = format_supports_target_rate(raw + off, len);
            candidate_has_format = true;
        } else if (current_audio_as && type == USB_DESC_ENDPOINT && len >= 7) {
            const usb_ep_desc_t *ep = (const usb_ep_desc_t *)(raw + off);
            if ((ep->bmAttributes & 0x03U) == USB_TRANSFER_TYPE_ISOCHRONOUS &&
                (ep->bEndpointAddress & 0x80U) == 0) {
                candidate.endpoint = ep->bEndpointAddress;
                candidate.mps = ep->wMaxPacketSize & 0x07FFU;
            }
        }
        off += len;
    }

    if (candidate.endpoint != 0 && candidate_has_format && candidate.target_rate_supported &&
        candidate.channels == FT710_TX_CHANNELS &&
        candidate.subframe_size == FT710_TX_SUBFRAME_BYTES &&
        candidate.bit_resolution == FT710_TX_BITS) {
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
    wait->done = true;
}

static esp_err_t pump_control(tx_ctx_t *ctx, control_wait_t *wait, uint32_t timeout_ms)
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

static esp_err_t control_out(tx_ctx_t *ctx, uint8_t bmRequestType, uint8_t bRequest,
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

    control_wait_t wait = {.done = false, .status = USB_TRANSFER_STATUS_ERROR};
    ctx->ctrl_xfer->device_handle = ctx->dev_hdl;
    ctx->ctrl_xfer->bEndpointAddress = 0;
    ctx->ctrl_xfer->num_bytes = (int)total;
    ctx->ctrl_xfer->callback = control_cb;
    ctx->ctrl_xfer->context = &wait;
    ctx->ctrl_xfer->timeout_ms = FT710_TX_CTRL_WAIT_MS;

    esp_err_t err = usb_host_transfer_submit_control(ctx->client_hdl, ctx->ctrl_xfer);
    if (err == ESP_OK) err = pump_control(ctx, &wait, FT710_TX_CTRL_WAIT_MS);
    return err;
}

static esp_err_t set_interface(tx_ctx_t *ctx, uint8_t interface_number, uint8_t alt)
{
    return control_out(ctx, USB_REQTYPE_STD_OUT_INTERFACE, USB_REQ_SET_INTERFACE,
                       alt, interface_number, NULL, 0);
}

static esp_err_t set_sampling_rate_target(tx_ctx_t *ctx, uint8_t endpoint)
{
    const uint8_t rate[3] = {
        (uint8_t)(FT710_TX_RATE_HZ & 0xFFU),
        (uint8_t)((FT710_TX_RATE_HZ >> 8) & 0xFFU),
        (uint8_t)((FT710_TX_RATE_HZ >> 16) & 0xFFU),
    };
    return control_out(ctx, UAC_REQTYPE_CLASS_OUT_ENDPOINT, UAC_REQ_SET_CUR,
                       UAC_EP_SAMPLING_FREQ_CONTROL, endpoint, rate, sizeof(rate));
}

static size_t read_mono_frames(int16_t *mono, size_t frames)
{
    if (mono == NULL || frames == 0) return 0;
    /* FreeRTOS StreamBuffer is explicitly designed for one concurrent writer
     * and one concurrent reader.  Writers remain serialized by s_input_mutex
     * because microphone, staged FT8 and Tune are distinct producer contexts.
     *
     * Do NOT take the writer mutex here: this function runs in the 1 ms USB
     * completion path.  The old zero-timeout mutex attempt turned harmless
     * producer activity into a false FIFO underrun and emitted a complete
     * 1 ms packet of silence whenever a push overlapped this callback.  That
     * is strongly audible as rapid modulation on a continuous sine wave. */
    if (s_input_stream == NULL) return 0;
    const size_t want = frames * FT710_TX_MONO_FRAME_BYTES;
    const size_t got = xStreamBufferReceive(s_input_stream, mono, want, 0);
    return got / FT710_TX_MONO_FRAME_BYTES;
}

static void fill_tx_transfer(tx_ctx_t *ctx, usb_transfer_t *transfer)
{
    (void)ctx;
    if (transfer == NULL) return;

    const size_t total_frames = (size_t)transfer->num_isoc_packets * FT710_TX_FRAMES_PER_MS;
    int16_t mono[FT710_TX_ISOC_PACKETS_PER_XFER * FT710_TX_FRAMES_PER_MS];
    memset(mono, 0, sizeof(mono));
    const size_t got_frames = read_mono_frames(mono, total_frames);

    uint8_t *dst = transfer->data_buffer;
    size_t frame_pos = 0;
    for (int p = 0; p < transfer->num_isoc_packets; ++p) {
        int16_t *stereo = (int16_t *)dst;
        for (size_t i = 0; i < FT710_TX_FRAMES_PER_MS; ++i, ++frame_pos) {
            const int16_t sample = frame_pos < got_frames ? mono[frame_pos] : 0;
            stereo[2U * i] = sample;
            stereo[2U * i + 1U] = sample;
        }
        transfer->isoc_packet_desc[p].num_bytes = FT710_TX_PACKET_BYTES;
        dst += FT710_TX_PACKET_BYTES;
    }
    transfer->num_bytes = (int)(transfer->num_isoc_packets * FT710_TX_PACKET_BYTES);

    status_lock();
    s_status.source_frames_sent += got_frames;
    s_status.silence_frames_sent += total_frames - got_frames;
    if (s_input_stream != NULL) s_status.input_buffered_bytes = (uint32_t)xStreamBufferBytesAvailable(s_input_stream);
    status_unlock();
}

static void tx_isoc_cb(usb_transfer_t *transfer)
{
    tx_ctx_t *ctx = (tx_ctx_t *)transfer->context;
    if (ctx == NULL) return;
    const int isoc_index = isoc_index_for_transfer(ctx, transfer);
    if (ctx->isoc_inflight > 0) ctx->isoc_inflight--;

    uint32_t completed = 0;
    uint32_t skipped = 0;
    uint32_t errors = 0;
    uint64_t sent = 0;
    uint32_t packets_48 = 0;
    if (transfer->status == USB_TRANSFER_STATUS_COMPLETED) {
        for (int i = 0; i < transfer->num_isoc_packets; ++i) {
            const usb_isoc_packet_desc_t *pkt = &transfer->isoc_packet_desc[i];
            if (pkt->status == USB_TRANSFER_STATUS_COMPLETED) {
                completed++;
                sent += (uint32_t)pkt->actual_num_bytes;
                if (pkt->num_bytes == (int)FT710_TX_PACKET_BYTES) packets_48++;
            } else if (pkt->status == USB_TRANSFER_STATUS_SKIPPED) {
                skipped++;
            } else {
                errors++;
            }
        }
    } else {
        errors = (uint32_t)transfer->num_isoc_packets;
    }

    status_lock();
    s_status.transfer_callbacks++;
    if (transfer->status != USB_TRANSFER_STATUS_COMPLETED) s_status.transfer_errors++;
    s_status.packets_total += (uint32_t)transfer->num_isoc_packets;
    s_status.packets_completed += completed;
    s_status.packets_skipped += skipped;
    s_status.packets_error += errors;
    s_status.usb_bytes_sent += sent;
    s_status.packets_48_frames += packets_48;
    s_status.updated_ms = (uint64_t)(esp_timer_get_time() / 1000LL);
    if (transfer->status != USB_TRANSFER_STATUS_COMPLETED) s_status.last_error = ESP_FAIL;
    status_unlock();

    if (!ctx->stopping && !ctx->dev_gone && ctx->dev_hdl != NULL) {
        fill_tx_transfer(ctx, transfer);
        esp_err_t err = isoc_index >= 0
            ? submit_isoc_transfer(ctx, (size_t)isoc_index)
            : ESP_ERR_INVALID_STATE;
        if (err != ESP_OK) {
            status_lock();
            s_status.transfer_errors++;
            s_status.last_error = (int)err;
            status_unlock();
        }
    }
}

static esp_err_t alloc_and_submit_isoc(tx_ctx_t *ctx)
{
    const size_t transfer_bytes = FT710_TX_PACKET_BYTES * FT710_TX_ISOC_PACKETS_PER_XFER;
    for (size_t n = 0; n < FT710_TX_ISOC_TRANSFERS; ++n) {
        esp_err_t err = usb_host_transfer_alloc(transfer_bytes, FT710_TX_ISOC_PACKETS_PER_XFER,
                                                &ctx->isoc[n]);
        if (err != ESP_OK) return err;
        usb_transfer_t *xfer = ctx->isoc[n];
        xfer->device_handle = ctx->dev_hdl;
        xfer->bEndpointAddress = ctx->stream.endpoint;
        xfer->callback = tx_isoc_cb;
        xfer->context = ctx;
        xfer->timeout_ms = 0;
        fill_tx_transfer(ctx, xfer);
    }

    ctx->isoc_inflight = 0;
    for (size_t n = 0; n < FT710_TX_ISOC_TRANSFERS; ++n) {
        esp_err_t err = submit_isoc_transfer(ctx, n);
        if (err != ESP_OK) return err;
    }
    return ESP_OK;
}

static void free_isoc(tx_ctx_t *ctx)
{
    for (size_t n = 0; n < FT710_TX_ISOC_TRANSFERS; ++n) {
        if (ctx->isoc[n] != NULL) {
            (void)usb_host_transfer_free(ctx->isoc[n]);
            ctx->isoc[n] = NULL;
        }
    }
}

static void cleanup_device(tx_ctx_t *ctx)
{
    if (ctx == NULL || ctx->dev_hdl == NULL) return;
    ctx->stopping = true;
    if (ctx->stream.endpoint != 0) {
        (void)usb_host_endpoint_halt(ctx->dev_hdl, ctx->stream.endpoint);
        (void)usb_host_endpoint_flush(ctx->dev_hdl, ctx->stream.endpoint);
    }
    const int64_t deadline = esp_timer_get_time() + 500000LL;
    while (ctx->isoc_inflight != 0 && esp_timer_get_time() < deadline) {
        esp_err_t err = usb_host_client_handle_events(ctx->client_hdl, pdMS_TO_TICKS(20));
        if (err != ESP_OK && err != ESP_ERR_TIMEOUT) break;
    }
    if (ctx->isoc_inflight == 0) free_isoc(ctx);
    (void)set_interface(ctx, ctx->stream.interface_number, 0);
    (void)usb_host_interface_release(ctx->client_hdl, ctx->dev_hdl, ctx->stream.interface_number);
    (void)usb_host_device_close(ctx->client_hdl, ctx->dev_hdl);

    ctx->dev_hdl = NULL;
    ctx->dev_addr = 0;
    ctx->dev_gone = false;
    ctx->stopping = false;
    memset(&ctx->stream, 0, sizeof(ctx->stream));
    ft710_audio_tx_input_reset();

    status_lock();
    s_status.device_present = false;
    s_status.device_open = false;
    s_status.interface_claimed = false;
    s_status.sample_rate_configured = false;
    s_status.streaming = false;
    s_status.disconnects++;
    status_unlock();
}

static esp_err_t try_open_audio(tx_ctx_t *ctx, uint8_t addr)
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
    if (desc->idVendor != FT710_TX_VID || desc->idProduct != FT710_TX_PID) {
        (void)usb_host_device_close(ctx->client_hdl, dev);
        return ESP_ERR_NOT_FOUND;
    }

    const usb_config_desc_t *config = NULL;
    err = usb_host_get_active_config_descriptor(dev, &config);
    if (err != ESP_OK || config == NULL) {
        (void)usb_host_device_close(ctx->client_hdl, dev);
        return err != ESP_OK ? err : ESP_FAIL;
    }

    tx_stream_desc_t stream;
    if (!find_tx_stream(config, &stream)) {
        (void)usb_host_device_close(ctx->client_hdl, dev);
        return ESP_ERR_NOT_SUPPORTED;
    }
    if (stream.mps < FT710_TX_PACKET_BYTES) {
        ESP_LOGE(TAG, "TX endpoint MPS=%u is smaller than 48 kHz stereo16 packet=%u",
                 stream.mps, (unsigned)FT710_TX_PACKET_BYTES);
        (void)usb_host_device_close(ctx->client_hdl, dev);
        return ESP_ERR_INVALID_SIZE;
    }

    ctx->dev_hdl = dev;
    ctx->dev_addr = addr;
    ctx->stream = stream;
    ctx->stopping = false;

    err = usb_host_interface_claim(ctx->client_hdl, dev, stream.interface_number, stream.alternate_setting);
    if (err != ESP_OK) {
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
    s_status.sample_rate_hz = FT710_TX_RATE_HZ;
    s_status.channels = stream.channels;
    s_status.bits_per_sample = stream.bit_resolution;
    s_status.expected_packet_bytes = FT710_TX_PACKET_BYTES;
    s_status.packet_bytes_min = FT710_TX_PACKET_BYTES;
    s_status.packet_bytes_max = FT710_TX_PACKET_BYTES;
    s_status.last_error = ESP_OK;
    status_unlock();

    ESP_LOGI(TAG, "FT-710 UAC1 TX found: addr=%u if=%u alt=%u OUT=0x%02X MPS=%u stereo 16-bit; PTT remains disabled",
             addr, stream.interface_number, stream.alternate_setting, stream.endpoint, stream.mps);

    err = set_interface(ctx, stream.interface_number, stream.alternate_setting);
    if (err != ESP_OK) {
        cleanup_device(ctx);
        return err;
    }
    err = set_sampling_rate_target(ctx, stream.endpoint);
    if (err != ESP_OK) {
        cleanup_device(ctx);
        return err;
    }
    status_lock();
    s_status.sample_rate_configured = true;
    status_unlock();

    err = alloc_and_submit_isoc(ctx);
    if (err != ESP_OK) {
        cleanup_device(ctx);
        return err;
    }

    status_lock();
    s_status.streaming = true;
    s_status.started_ms = (uint64_t)(esp_timer_get_time() / 1000LL);
    s_status.updated_ms = s_status.started_ms;
    s_status.last_error = ESP_OK;
    status_unlock();

    ESP_LOGI(TAG, "FT8.5.16 UAC1 TX STREAMING: 48000 Hz stereo S16LE, ep=0x%02X, packet=192 bytes, queue=%ux%u single-packet URBs pipeline=%u ms; PTT DISABLED",
             stream.endpoint, (unsigned)FT710_TX_ISOC_TRANSFERS,
             (unsigned)FT710_TX_ISOC_PACKETS_PER_XFER,
             (unsigned)(FT710_TX_ISOC_TRANSFERS * FT710_TX_ISOC_PACKETS_PER_XFER));
    return ESP_OK;
}

static void client_event_cb(const usb_host_client_event_msg_t *event_msg, void *arg)
{
    tx_ctx_t *ctx = (tx_ctx_t *)arg;
    if (ctx == NULL || event_msg == NULL) return;
    if (event_msg->event == USB_HOST_CLIENT_EVENT_NEW_DEV) {
        ctx->scan_requested = true;
    } else if (event_msg->event == USB_HOST_CLIENT_EVENT_DEV_GONE &&
               ctx->dev_hdl != NULL && event_msg->dev_gone.dev_hdl == ctx->dev_hdl) {
        ctx->dev_gone = true;
    }
}

static void scan_for_audio(tx_ctx_t *ctx)
{
    if (ctx->dev_hdl != NULL) return;
    uint8_t addresses[FT710_TX_ADDR_LIST_MAX] = {0};
    int count = 0;
    esp_err_t err = usb_host_device_addr_list_fill(FT710_TX_ADDR_LIST_MAX, addresses, &count);
    if (err != ESP_OK) {
        status_error(err);
        return;
    }
    for (int i = 0; i < count && i < FT710_TX_ADDR_LIST_MAX; ++i) {
        if (addresses[i] == 0) continue;
        err = try_open_audio(ctx, addresses[i]);
        if (err == ESP_OK) return;
        if (err != ESP_ERR_NOT_FOUND && err != ESP_ERR_NOT_SUPPORTED) status_error(err);
    }
}

static void tx_task(void *arg)
{
    (void)arg;
    tx_ctx_t ctx;
    memset(&ctx, 0, sizeof(ctx));

    usb_host_client_config_t config = {
        .is_synchronous = false,
        .max_num_event_msg = 16,
        .async = {.client_event_callback = client_event_cb, .callback_arg = &ctx},
    };
    esp_err_t err = usb_host_client_register(&config, &ctx.client_hdl);
    if (err != ESP_OK) {
        status_error(err);
        vTaskDelete(NULL);
        return;
    }
    err = usb_host_transfer_alloc(FT710_TX_CTRL_BUF_SIZE, 0, &ctx.ctrl_xfer);
    if (err != ESP_OK) {
        status_error(err);
        (void)usb_host_client_deregister(ctx.client_hdl);
        vTaskDelete(NULL);
        return;
    }

    status_lock();
    s_status.initialized = true;
    s_status.client_registered = true;
    s_status.sample_rate_hz = FT710_TX_RATE_HZ;
    s_status.channels = FT710_TX_CHANNELS;
    s_status.bits_per_sample = FT710_TX_BITS;
    s_status.expected_packet_bytes = FT710_TX_PACKET_BYTES;
    s_status.packet_bytes_min = FT710_TX_PACKET_BYTES;
    s_status.packet_bytes_max = FT710_TX_PACKET_BYTES;
    s_status.last_error = ESP_OK;
    status_unlock();

    ESP_LOGI(TAG, "FT8.5.16 audio TX client registered; scanning for C-Media 0D8C:0013 UAC1 OUT at 48 kHz with one packet per URB; PTT disabled");
    ctx.scan_requested = true;
    TickType_t last_scan = 0;
    TickType_t last_log = 0;

    for (;;) {
        err = usb_host_client_handle_events(ctx.client_hdl, pdMS_TO_TICKS(20));
        if (err != ESP_OK && err != ESP_ERR_TIMEOUT) status_error(err);
        if (ctx.dev_gone) {
            ESP_LOGW(TAG, "FT-710 USB Audio TX disconnected");
            cleanup_device(&ctx);
            ctx.scan_requested = true;
        }
        TickType_t now = xTaskGetTickCount();
        if (ctx.scan_requested || (now - last_scan) >= pdMS_TO_TICKS(FT710_TX_SCAN_PERIOD_MS)) {
            ctx.scan_requested = false;
            last_scan = now;
            scan_for_audio(&ctx);
        }
        if (ctx.dev_hdl != NULL && (last_log == 0 || (now - last_log) >= pdMS_TO_TICKS(5000))) {
            last_log = now;
            ft710_audio_tx_status_t st;
            ft710_audio_tx_get_status(&st);
            ESP_LOGI(TAG,
                     "TX audio: usb_bytes=%" PRIu64 " packets=%" PRIu32 " ok=%" PRIu32
                     " skip=%" PRIu32 " err=%" PRIu32 " mic_bytes=%" PRIu64
                     " queued=%" PRIu32 " source_frames=%" PRIu64 " silence_frames=%" PRIu64
                     " pkt48=%" PRIu32,
                     st.usb_bytes_sent, st.packets_total, st.packets_completed,
                     st.packets_skipped, st.packets_error, st.input_bytes_received,
                     st.input_buffered_bytes, st.source_frames_sent, st.silence_frames_sent,
                     st.packets_48_frames);
        }
    }
}

esp_err_t ft710_audio_tx_start(void)
{
    if (s_status_mutex != NULL) return ESP_OK;
    s_status_mutex = xSemaphoreCreateMutex();
    if (s_status_mutex == NULL) return ESP_ERR_NO_MEM;
    s_input_mutex = xSemaphoreCreateMutex();
    if (s_input_mutex == NULL) {
        vSemaphoreDelete(s_status_mutex);
        s_status_mutex = NULL;
        return ESP_ERR_NO_MEM;
    }
    s_input_stream = xStreamBufferCreate(FT710_TX_INPUT_STREAM_BYTES, 1);
    if (s_input_stream == NULL) {
        vSemaphoreDelete(s_input_mutex);
        s_input_mutex = NULL;
        vSemaphoreDelete(s_status_mutex);
        s_status_mutex = NULL;
        return ESP_ERR_NO_MEM;
    }
    memset(&s_status, 0, sizeof(s_status));
    s_status.input_buffer_capacity = FT710_TX_INPUT_STREAM_BYTES;

    BaseType_t tone_ok = xTaskCreate(tone_fifo_task, "ft710_tone_fifo", FT710_TX_TONE_TASK_STACK, NULL,
                                     FT710_TX_TONE_TASK_PRIO, &s_tone_task_handle);
    if (tone_ok != pdPASS) {
        vStreamBufferDelete(s_input_stream);
        s_input_stream = NULL;
        vSemaphoreDelete(s_input_mutex);
        s_input_mutex = NULL;
        vSemaphoreDelete(s_status_mutex);
        s_status_mutex = NULL;
        return ESP_ERR_NO_MEM;
    }

    BaseType_t ok = xTaskCreate(tx_task, "ft710_audio_tx", FT710_TX_TASK_STACK, NULL,
                                FT710_TX_TASK_PRIO, NULL);
    if (ok != pdPASS) {
        if (s_tone_task_handle != NULL) {
            vTaskDelete(s_tone_task_handle);
            s_tone_task_handle = NULL;
        }
        vStreamBufferDelete(s_input_stream);
        s_input_stream = NULL;
        vSemaphoreDelete(s_input_mutex);
        s_input_mutex = NULL;
        vSemaphoreDelete(s_status_mutex);
        s_status_mutex = NULL;
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

void ft710_audio_tx_get_status(ft710_audio_tx_status_t *status)
{
    if (status == NULL) return;
    memset(status, 0, sizeof(*status));
    if (s_status_mutex == NULL) return;
    status_lock();
    *status = s_status;
    status_unlock();
}

static uint16_t pcm_peak_abs(const int16_t *samples, size_t count)
{
    uint32_t peak = 0;
    for (size_t i = 0; i < count; ++i) {
        const int32_t v = samples[i];
        const uint32_t mag = (uint32_t)(v == INT16_MIN ? 32768 : (v < 0 ? -v : v));
        if (mag > peak) peak = mag;
    }
    return (uint16_t)peak;
}

size_t ft710_audio_tx_push_mono_s16(const void *data, size_t bytes)
{
    if (data == NULL || bytes < 2 || s_input_stream == NULL || s_status_mutex == NULL) return 0;
    bytes &= ~(size_t)1U;

    ft710_audio_tx_status_t snapshot;
    ft710_audio_tx_get_status(&snapshot);
    if (!snapshot.streaming) return 0;

    const size_t capacity = FT710_TX_INPUT_STREAM_BYTES;
    if (bytes > capacity) {
        data = (const uint8_t *)data + (bytes - capacity);
        bytes = capacity;
        bytes &= ~(size_t)1U;
    }

    if (s_input_mutex == NULL || xSemaphoreTake(s_input_mutex, pdMS_TO_TICKS(20)) != pdTRUE) return 0;
    size_t queued = xStreamBufferBytesAvailable(s_input_stream);
    uint64_t dropped = 0;
    if (queued > FT710_TX_INPUT_TARGET_MAX_BYTES || queued + bytes > FT710_TX_INPUT_TARGET_MAX_BYTES) {
        size_t keep_room = bytes < FT710_TX_INPUT_TARGET_MAX_BYTES ? FT710_TX_INPUT_TARGET_MAX_BYTES - bytes : 0;
        size_t discard = queued > keep_room ? queued - keep_room : 0;
        uint8_t scratch[256];
        while (discard != 0) {
            const size_t chunk = discard > sizeof(scratch) ? sizeof(scratch) : discard;
            const size_t got = xStreamBufferReceive(s_input_stream, scratch, chunk, 0);
            if (got == 0) break;
            dropped += got;
            discard -= got;
        }
    }

    const size_t sent = xStreamBufferSend(s_input_stream, data, bytes, 0);
    const uint32_t buffered = (uint32_t)xStreamBufferBytesAvailable(s_input_stream);
    xSemaphoreGive(s_input_mutex);
    const uint16_t peak = pcm_peak_abs((const int16_t *)data, bytes / 2U);
    status_lock();
    s_status.input_pushes++;
    s_status.input_bytes_received += sent;
    s_status.input_bytes_dropped_old += dropped + (bytes - sent);
    s_status.input_peak_abs = peak;
    s_status.input_buffered_bytes = buffered;
    s_status.updated_ms = (uint64_t)(esp_timer_get_time() / 1000LL);
    status_unlock();
    return sent;
}

size_t ft710_audio_tx_push_mono_s16_lossless(const void *data, size_t bytes)
{
    if (data == NULL || bytes < 2 || s_input_stream == NULL || s_status_mutex == NULL) return 0;
    bytes &= ~(size_t)1U;
    if (bytes == 0 || bytes > FT710_TX_INPUT_STREAM_BYTES) return 0;

    ft710_audio_tx_status_t snapshot;
    ft710_audio_tx_get_status(&snapshot);
    if (!snapshot.streaming) return 0;

    /* Unlike the microphone path above, deterministic FT8 playback must never
     * make room by deleting older samples.  The caller advances its waveform
     * only when this function accepts the complete block. */
    if (s_input_mutex == NULL || xSemaphoreTake(s_input_mutex, pdMS_TO_TICKS(2)) != pdTRUE) return 0;
    const size_t free_bytes = xStreamBufferSpacesAvailable(s_input_stream);
    if (free_bytes < bytes) {
        xSemaphoreGive(s_input_mutex);
        return 0;
    }
    const size_t sent = xStreamBufferSend(s_input_stream, data, bytes, 0);
    const uint32_t buffered = (uint32_t)xStreamBufferBytesAvailable(s_input_stream);
    xSemaphoreGive(s_input_mutex);
    if (sent != bytes) return 0;

    const uint16_t peak = pcm_peak_abs((const int16_t *)data, bytes / 2U);
    status_lock();
    s_status.input_pushes++;
    s_status.input_bytes_received += sent;
    s_status.input_peak_abs = peak;
    s_status.input_buffered_bytes = buffered;
    s_status.updated_ms = (uint64_t)(esp_timer_get_time() / 1000LL);
    status_unlock();
    return sent;
}

static void tone_fifo_task(void *arg)
{
    (void)arg;
    int16_t block[FT710_TX_TONE_BLOCK_FRAMES];
    for (;;) {
        (void)ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        for (;;) {
            bool active;
            int32_t amp_q15;
            uint8_t phase;
            uint32_t frequency_hz;
            portENTER_CRITICAL(&s_tone_mux);
            active = s_tone_active;
            amp_q15 = s_tone_amp_q15;
            phase = s_tone_phase;
            frequency_hz = s_tone_frequency_hz;
            portEXIT_CRITICAL(&s_tone_mux);
            if (!active) break;

            /* Keep a bounded lead instead of filling the entire 64 KiB FIFO;
             * this preserves quick level changes while remaining far from an
             * underrun. */
            if (s_input_stream != NULL && xStreamBufferBytesAvailable(s_input_stream) >= FT710_TX_TONE_TARGET_BYTES) {
                vTaskDelay(pdMS_TO_TICKS(2));
                continue;
            }

            const int16_t *table = frequency_hz == 1000U ? s_tone_1000_q15 : s_tone_1500_q15;
            const uint8_t period = frequency_hz == 1000U ? 48U : 32U;
            uint8_t next_phase = phase;
            for (size_t i = 0; i < FT710_TX_TONE_BLOCK_FRAMES; ++i) {
                block[i] = (int16_t)(((int32_t)table[next_phase] * amp_q15) / 32767);
                next_phase++;
                if (next_phase >= period) next_phase = 0;
            }

            const size_t bytes = sizeof(block);
            if (ft710_audio_tx_push_mono_s16_lossless(block, bytes) == bytes) {
                portENTER_CRITICAL(&s_tone_mux);
                if (s_tone_active && s_tone_frequency_hz == frequency_hz && s_tone_phase == phase) {
                    s_tone_phase = next_phase;
                }
                portEXIT_CRITICAL(&s_tone_mux);
            } else {
                /* Backpressure is expected when the shared FIFO is full. */
                vTaskDelay(1);
            }
        }
    }
}

static int32_t tone_level_to_q15(float level_dbfs)
{
    if (!isfinite(level_dbfs)) level_dbfs = -32.0f;
    if (level_dbfs < -40.0f) level_dbfs = -40.0f;
    if (level_dbfs > -1.0f) level_dbfs = -1.0f;
    const float linear = powf(10.0f, level_dbfs / 20.0f);
    int32_t q = (int32_t)lroundf(linear * 32767.0f);
    if (q < 1) q = 1;
    if (q > 32767) q = 32767;
    return q;
}

void ft710_audio_tx_tone_start(uint32_t frequency_hz, float level_dbfs)
{
    if (frequency_hz != 1000U && frequency_hz != 1500U) frequency_hz = 1500U;
    ft710_audio_tx_input_reset();
    portENTER_CRITICAL(&s_tone_mux);
    s_tone_amp_q15 = tone_level_to_q15(level_dbfs);
    s_tone_frequency_hz = frequency_hz;
    s_tone_phase = 0;
    s_tone_active = true;
    portEXIT_CRITICAL(&s_tone_mux);
    if (s_tone_task_handle != NULL) xTaskNotifyGive(s_tone_task_handle);
}

void ft710_audio_tx_tone_start_1500(float level_dbfs)
{
    ft710_audio_tx_tone_start(1500U, level_dbfs);
}

void ft710_audio_tx_tone_set_level(float level_dbfs)
{
    const int32_t q = tone_level_to_q15(level_dbfs);
    portENTER_CRITICAL(&s_tone_mux);
    s_tone_amp_q15 = q;
    portEXIT_CRITICAL(&s_tone_mux);
}

void ft710_audio_tx_tone_stop(void)
{
    portENTER_CRITICAL(&s_tone_mux);
    s_tone_active = false;
    s_tone_phase = 0;
    portEXIT_CRITICAL(&s_tone_mux);
}

bool ft710_audio_tx_tone_active(void)
{
    bool active;
    portENTER_CRITICAL(&s_tone_mux);
    active = s_tone_active;
    portEXIT_CRITICAL(&s_tone_mux);
    return active;
}

void ft710_audio_tx_input_reset(void)
{
    if (s_input_stream == NULL || s_input_mutex == NULL || s_status_mutex == NULL) return;
    if (xSemaphoreTake(s_input_mutex, pdMS_TO_TICKS(20)) == pdTRUE) {
        (void)xStreamBufferReset(s_input_stream);
        xSemaphoreGive(s_input_mutex);
    }
    status_lock();
    s_status.input_buffered_bytes = 0;
    s_status.input_peak_abs = 0;
    status_unlock();
}
