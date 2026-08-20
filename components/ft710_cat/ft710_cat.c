#include "ft710_cat.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "usb/usb_host.h"
#include "usb/usb_types_ch9.h"

#define FT710_CAT_TASK_STACK         7168
#define FT710_CAT_TASK_PRIO          4
#define FT710_CAT_SCAN_PERIOD_MS     500
#define FT710_CAT_ADDR_LIST_MAX      16
#define FT710_CAT_CP2105_VID         0x10C4U
#define FT710_CAT_CP2105_PID         0xEA70U
#define FT710_CAT_AUX_INTERFACE      1U
#define FT710_CAT_BAUDRATE           115200U
#define FT710_CAT_CTRL_BUF_SIZE      64U
#define FT710_CAT_BULK_BUF_SIZE      64U
#define FT710_CAT_TRANSFER_WAIT_MS   1000U
#define FT710_CAT_QUERY_WAIT_MS      750U
#define FT710_CAT_STATE_POLL_MS       1000U
#define FT710_CAT_OFFLINE_POLL_MS     5000U
#define FT710_CAT_OFFLINE_AFTER_FAILURES 3U
#define FT710_CAT_POWER_START_GRACE_MS 12000U
#define FT710_CAT_PTT_WATCHDOG_MS      1500U
#define FT710_CAT_EXTERNAL_WAIT_MS     3000U
#define FT710_CAT_EXTERNAL_CMD_MAX     64U
#define FT710_CAT_USB_SETUP_SIZE      8U
#define FT710_CAT_DESC_INTERFACE      0x04U
#define FT710_CAT_DESC_ENDPOINT       0x05U
#define FT710_CAT_INTERFACE_DESC_LEN  9U
#define FT710_CAT_ENDPOINT_DESC_LEN   7U

/* Silicon Labs CP210x request encoding, matching the upstream Linux driver. */
#define CP210X_REQTYPE_HOST_TO_INTERFACE 0x41U
#define CP210X_IFC_ENABLE                0x00U
#define CP210X_SET_LINE_CTL              0x03U
#define CP210X_SET_MHS                   0x07U
#define CP210X_PURGE                     0x12U
#define CP210X_SET_FLOW                  0x13U
#define CP210X_SET_BAUDRATE              0x1EU
#define CP210X_UART_ENABLE               0x0001U
#define CP210X_BITS_8N1                   0x0800U
#define CP210X_CONTROL_WRITE_DTR          0x0100U
#define CP210X_CONTROL_WRITE_RTS          0x0200U
#define CP210X_PURGE_ALL                  0x000FU

static const char *TAG = "ft710_cat";

static SemaphoreHandle_t s_status_mutex;
static ft710_cat_status_t s_status;

/* One external CAT transaction at a time. The web/API caller fills this slot,
 * then the CAT task executes it using the same USB client that owns continuous
 * RX and state polling. This deliberately avoids USB Host calls from HTTP tasks. */
typedef struct {
    volatile bool pending;
    bool expect_reply;
    char command[FT710_CAT_EXTERNAL_CMD_MAX];
    char response[FT710_CAT_RESPONSE_MAX];
    esp_err_t result;
} external_cat_request_t;

static SemaphoreHandle_t s_external_mutex;
static SemaphoreHandle_t s_external_done;
static external_cat_request_t s_external_request;
static TaskHandle_t s_cat_task_handle;

typedef struct cat_ctx_s cat_ctx_t;

typedef struct {
    cat_ctx_t *ctx;
    bool done;
    usb_transfer_status_t status;
    int actual_num_bytes;
} transfer_wait_t;

struct cat_ctx_s {
    usb_host_client_handle_t client_hdl;
    usb_device_handle_t dev_hdl;
    uint8_t dev_addr;
    bool dev_gone;
    bool scan_requested;
    bool ready;

    uint8_t in_ep;
    uint8_t out_ep;
    uint16_t in_mps;
    uint16_t out_mps;

    usb_transfer_t *ctrl_xfer;
    usb_transfer_t *out_xfer;
    usb_transfer_t *in_xfer;
    size_t in_transfer_len;
    bool in_xfer_inflight;
    bool tx_quiet_active;
    transfer_wait_t out_wait;

    char rx_message[FT710_CAT_RESPONSE_MAX];
    size_t rx_message_len;
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

static void transfer_wait_cb(usb_transfer_t *transfer)
{
    transfer_wait_t *wait = (transfer_wait_t *)transfer->context;
    if (wait == NULL) {
        return;
    }
    wait->status = transfer->status;
    wait->actual_num_bytes = transfer->actual_num_bytes;
    wait->done = true;
}

static esp_err_t pump_until_done(cat_ctx_t *ctx, transfer_wait_t *wait, uint32_t timeout_ms)
{
    const int64_t deadline_us = esp_timer_get_time() + ((int64_t)timeout_ms * 1000LL);
    while (!wait->done && !ctx->dev_gone && esp_timer_get_time() < deadline_us) {
        esp_err_t err = usb_host_client_handle_events(ctx->client_hdl, pdMS_TO_TICKS(20));
        if (err != ESP_OK && err != ESP_ERR_TIMEOUT) {
            return err;
        }
    }
    if (ctx->dev_gone) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!wait->done) {
        return ESP_ERR_TIMEOUT;
    }
    return wait->status == USB_TRANSFER_STATUS_COMPLETED ? ESP_OK : ESP_FAIL;
}

static esp_err_t cp210x_control(cat_ctx_t *ctx, uint8_t request, uint16_t value,
                                const void *payload, uint16_t payload_len)
{
    if (ctx == NULL || ctx->dev_hdl == NULL || ctx->ctrl_xfer == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if ((size_t)FT710_CAT_USB_SETUP_SIZE + payload_len > ctx->ctrl_xfer->data_buffer_size) {
        return ESP_ERR_INVALID_SIZE;
    }

    memset(ctx->ctrl_xfer->data_buffer, 0, ctx->ctrl_xfer->data_buffer_size);
    usb_setup_packet_t *setup = (usb_setup_packet_t *)ctx->ctrl_xfer->data_buffer;
    setup->bmRequestType = CP210X_REQTYPE_HOST_TO_INTERFACE;
    setup->bRequest = request;
    setup->wValue = value;
    setup->wIndex = FT710_CAT_AUX_INTERFACE;
    setup->wLength = payload_len;
    if (payload_len > 0 && payload != NULL) {
        memcpy(ctx->ctrl_xfer->data_buffer + FT710_CAT_USB_SETUP_SIZE, payload, payload_len);
    }

    transfer_wait_t wait = {
        .ctx = ctx,
        .done = false,
        .status = USB_TRANSFER_STATUS_ERROR,
        .actual_num_bytes = 0,
    };
    ctx->ctrl_xfer->device_handle = ctx->dev_hdl;
    ctx->ctrl_xfer->bEndpointAddress = 0;
    ctx->ctrl_xfer->num_bytes = FT710_CAT_USB_SETUP_SIZE + payload_len;
    ctx->ctrl_xfer->callback = transfer_wait_cb;
    ctx->ctrl_xfer->context = &wait;
    ctx->ctrl_xfer->timeout_ms = FT710_CAT_TRANSFER_WAIT_MS;

    esp_err_t err = usb_host_transfer_submit_control(ctx->client_hdl, ctx->ctrl_xfer);
    if (err == ESP_OK) {
        err = pump_until_done(ctx, &wait, FT710_CAT_TRANSFER_WAIT_MS);
    }

    status_lock();
    if (err == ESP_OK) {
        s_status.control_ok_count++;
        s_status.last_error = ESP_OK;
    } else {
        s_status.control_error_count++;
        s_status.last_error = (int)err;
    }
    status_unlock();
    return err;
}

static void put_le32(uint8_t out[4], uint32_t value)
{
    out[0] = (uint8_t)(value & 0xFFU);
    out[1] = (uint8_t)((value >> 8) & 0xFFU);
    out[2] = (uint8_t)((value >> 16) & 0xFFU);
    out[3] = (uint8_t)((value >> 24) & 0xFFU);
}

static esp_err_t configure_cp2105_aux(cat_ctx_t *ctx)
{
    esp_err_t err;
    uint8_t baud_le[4];
    uint8_t flow_none[16] = {0};
    put_le32(baud_le, FT710_CAT_BAUDRATE);

    err = cp210x_control(ctx, CP210X_IFC_ENABLE, CP210X_UART_ENABLE, NULL, 0);
    if (err != ESP_OK) return err;

    err = cp210x_control(ctx, CP210X_SET_BAUDRATE, 0, baud_le, sizeof(baud_le));
    if (err != ESP_OK) return err;

    err = cp210x_control(ctx, CP210X_SET_LINE_CTL, CP210X_BITS_8N1, NULL, 0);
    if (err != ESP_OK) return err;

    /* No XON/XOFF, CTS/RTS, DSR/DTR or other flow-control modes. */
    err = cp210x_control(ctx, CP210X_SET_FLOW, 0, flow_none, sizeof(flow_none));
    if (err != ESP_OK) return err;

    /* Explicitly write both modem control outputs LOW. This is a PTT safety invariant. */
    err = cp210x_control(ctx, CP210X_SET_MHS,
                         CP210X_CONTROL_WRITE_DTR | CP210X_CONTROL_WRITE_RTS,
                         NULL, 0);
    if (err != ESP_OK) return err;

    err = cp210x_control(ctx, CP210X_PURGE, CP210X_PURGE_ALL, NULL, 0);
    if (err != ESP_OK) return err;

    status_lock();
    s_status.uart_enabled = true;
    s_status.configured_115200_8n1 = true;
    s_status.dtr_rts_forced_low = true;
    s_status.baudrate = FT710_CAT_BAUDRATE;
    s_status.last_error = ESP_OK;
    status_unlock();

    ESP_LOGI(TAG, "CP2105 CAT-2/AUX configured: interface=1 115200 8N1, flow-control off, DTR=0 RTS=0");
    return ESP_OK;
}

static bool find_aux_endpoints(const usb_config_desc_t *config_desc,
                               uint8_t *in_ep, uint16_t *in_mps,
                               uint8_t *out_ep, uint16_t *out_mps)
{
    if (config_desc == NULL || in_ep == NULL || in_mps == NULL || out_ep == NULL || out_mps == NULL) {
        return false;
    }

    const uint8_t *raw = (const uint8_t *)config_desc;
    const uint16_t total = config_desc->wTotalLength;
    uint8_t current_if = 0xFF;
    uint8_t current_alt = 0xFF;
    *in_ep = *out_ep = 0;
    *in_mps = *out_mps = 0;

    for (size_t off = 0; off + 2 <= total;) {
        uint8_t len = raw[off];
        uint8_t type = raw[off + 1];
        if (len < 2 || off + len > total) {
            break;
        }
        if (type == FT710_CAT_DESC_INTERFACE && len >= FT710_CAT_INTERFACE_DESC_LEN) {
            const usb_intf_desc_t *intf = (const usb_intf_desc_t *)(raw + off);
            current_if = intf->bInterfaceNumber;
            current_alt = intf->bAlternateSetting;
        } else if (type == FT710_CAT_DESC_ENDPOINT && len >= FT710_CAT_ENDPOINT_DESC_LEN &&
                   current_if == FT710_CAT_AUX_INTERFACE && current_alt == 0) {
            const usb_ep_desc_t *ep = (const usb_ep_desc_t *)(raw + off);
            if ((ep->bmAttributes & 0x03U) == USB_TRANSFER_TYPE_BULK) {
                uint16_t mps = ep->wMaxPacketSize & 0x07FFU;
                if (ep->bEndpointAddress & 0x80U) {
                    *in_ep = ep->bEndpointAddress;
                    *in_mps = mps;
                } else {
                    *out_ep = ep->bEndpointAddress;
                    *out_mps = mps;
                }
            }
        }
        off += len;
    }
    return *in_ep != 0 && *out_ep != 0 && *in_mps != 0 && *out_mps != 0;
}

static void rx_transfer_cb(usb_transfer_t *transfer)
{
    cat_ctx_t *ctx = (cat_ctx_t *)transfer->context;
    if (ctx == NULL) {
        return;
    }
    ctx->in_xfer_inflight = false;

    if (transfer->status == USB_TRANSFER_STATUS_COMPLETED) {
        if (transfer->actual_num_bytes > 0) {
            status_lock();
            s_status.bulk_in_count++;
            s_status.rx_bytes += (uint32_t)transfer->actual_num_bytes;
            status_unlock();

            for (int i = 0; i < transfer->actual_num_bytes; ++i) {
                const char ch = (char)transfer->data_buffer[i];
                if (ctx->rx_message_len + 1 < sizeof(ctx->rx_message)) {
                    ctx->rx_message[ctx->rx_message_len++] = ch;
                    ctx->rx_message[ctx->rx_message_len] = '\0';
                } else {
                    ctx->rx_message_len = 0;
                    ctx->rx_message[0] = '\0';
                }
            }
        }

        if (!ctx->dev_gone && ctx->ready && !ctx->tx_quiet_active) {
            transfer->num_bytes = ctx->in_transfer_len;
            esp_err_t err = usb_host_transfer_submit(transfer);
            if (err == ESP_OK) ctx->in_xfer_inflight = true;
            if (err != ESP_OK) {
                status_error(err);
                ESP_LOGW(TAG, "CAT continuous BULK IN resubmit failed: %s", esp_err_to_name(err));
            }
        }
    } else if (transfer->status != USB_TRANSFER_STATUS_NO_DEVICE &&
               transfer->status != USB_TRANSFER_STATUS_CANCELED &&
               !ctx->dev_gone && !ctx->tx_quiet_active) {
        ESP_LOGW(TAG, "CAT BULK IN completed with status=%d", (int)transfer->status);
    }
}

static esp_err_t start_rx(cat_ctx_t *ctx)
{
    if (ctx == NULL || ctx->in_xfer == NULL || ctx->in_mps == 0 ||
        ctx->in_mps > FT710_CAT_BULK_BUF_SIZE) {
        return ESP_ERR_INVALID_SIZE;
    }

    /* ESP-IDF requires a non-control IN transfer length to be a multiple of MPS. */
    ctx->in_transfer_len = FT710_CAT_BULK_BUF_SIZE -
                           (FT710_CAT_BULK_BUF_SIZE % ctx->in_mps);
    if (ctx->in_transfer_len == 0) {
        return ESP_ERR_INVALID_SIZE;
    }

    ctx->in_xfer->device_handle = ctx->dev_hdl;
    ctx->in_xfer->bEndpointAddress = ctx->in_ep;
    ctx->in_xfer->num_bytes = ctx->in_transfer_len;
    ctx->in_xfer->callback = rx_transfer_cb;
    ctx->in_xfer->context = ctx;
    ctx->in_xfer->timeout_ms = 0;
    ctx->ready = true;

    esp_err_t err = usb_host_transfer_submit(ctx->in_xfer);
    if (err == ESP_OK) {
        ctx->in_xfer_inflight = true;
        status_lock();
        s_status.rx_running = true;
        status_unlock();
    }
    return err;
}

static esp_err_t cat_bulk_write(cat_ctx_t *ctx, const char *command)
{
    if (ctx == NULL || command == NULL || ctx->out_xfer == NULL || !ctx->ready) {
        return ESP_ERR_INVALID_STATE;
    }
    size_t len = strlen(command);
    if (len == 0 || len > ctx->out_xfer->data_buffer_size) {
        return ESP_ERR_INVALID_SIZE;
    }

    memcpy(ctx->out_xfer->data_buffer, command, len);
    memset(&ctx->out_wait, 0, sizeof(ctx->out_wait));
    ctx->out_wait.ctx = ctx;
    ctx->out_wait.status = USB_TRANSFER_STATUS_ERROR;
    ctx->out_xfer->device_handle = ctx->dev_hdl;
    ctx->out_xfer->bEndpointAddress = ctx->out_ep;
    ctx->out_xfer->num_bytes = (int)len;
    ctx->out_xfer->callback = transfer_wait_cb;
    ctx->out_xfer->context = &ctx->out_wait;
    ctx->out_xfer->timeout_ms = FT710_CAT_TRANSFER_WAIT_MS;

    status_lock();
    snprintf(s_status.last_command, sizeof(s_status.last_command), "%s", command);
    s_status.tx_bytes += (uint32_t)len;
    status_unlock();

    esp_err_t err = usb_host_transfer_submit(ctx->out_xfer);
    if (err == ESP_OK) {
        err = pump_until_done(ctx, &ctx->out_wait, FT710_CAT_TRANSFER_WAIT_MS);
    }
    status_lock();
    if (err == ESP_OK) {
        s_status.bulk_out_count++;
        s_status.last_error = ESP_OK;
    } else {
        s_status.last_error = (int)err;
    }
    status_unlock();
    return err;
}

static esp_err_t cat_query_response(cat_ctx_t *ctx, const char *command,
                                    char *response, size_t response_size)
{
    if (ctx == NULL || command == NULL || response == NULL || response_size < 2) {
        return ESP_ERR_INVALID_ARG;
    }

    ctx->rx_message_len = 0;
    ctx->rx_message[0] = '\0';
    response[0] = '\0';

    esp_err_t err = cat_bulk_write(ctx, command);
    if (err != ESP_OK) {
        return err;
    }

    const int64_t deadline_us = esp_timer_get_time() + ((int64_t)FT710_CAT_QUERY_WAIT_MS * 1000LL);
    while (!ctx->dev_gone && esp_timer_get_time() < deadline_us) {
        err = usb_host_client_handle_events(ctx->client_hdl, pdMS_TO_TICKS(20));
        if (err != ESP_OK && err != ESP_ERR_TIMEOUT) {
            return err;
        }
        char *end = strchr(ctx->rx_message, ';');
        if (end != NULL) {
            end[1] = '\0';
            snprintf(response, response_size, "%s", ctx->rx_message);
            status_lock();
            snprintf(s_status.last_response, sizeof(s_status.last_response), "%s", response);
            s_status.last_error = ESP_OK;
            status_unlock();
            return ESP_OK;
        }
    }

    snprintf(response, response_size, "%s", ctx->rx_message);
    status_lock();
    snprintf(s_status.last_response, sizeof(s_status.last_response), "%s", response);
    s_status.last_error = ESP_ERR_TIMEOUT;
    status_unlock();
    return ESP_ERR_TIMEOUT;
}

static const char *mode_name_from_code(char code)
{
    switch (code) {
        case '1': return "LSB";
        case '2': return "USB";
        case '3': return "CW-U";
        case '4': return "FM";
        case '5': return "AM";
        case '6': return "RTTY-L";
        case '7': return "CW-L";
        case '8': return "DATA-L";
        case '9': return "RTTY-U";
        case 'A': return "DATA-FM";
        case 'B': return "FM-N";
        case 'C': return "DATA-U";
        case 'D': return "AM-N";
        case 'E': return "PSK";
        case 'F': return "DATA-FM-N";
        default: return "UNKNOWN";
    }
}

static bool parse_bool_reply(const char *response, const char *prefix, bool *value)
{
    if (response == NULL || prefix == NULL || value == NULL) return false;
    const size_t plen = strlen(prefix);
    if (strlen(response) != plen + 2 || strncmp(response, prefix, plen) != 0 ||
        response[plen + 1] != ';' || (response[plen] != '0' && response[plen] != '1')) {
        return false;
    }
    *value = response[plen] == '1';
    return true;
}

static bool parse_frequency_reply(const char *response, const char *prefix, uint32_t *frequency_hz)
{
    if (response == NULL || prefix == NULL || frequency_hz == NULL) return false;
    const size_t plen = strlen(prefix);
    if (strlen(response) != plen + 10 || strncmp(response, prefix, plen) != 0 ||
        response[plen + 9] != ';') {
        return false;
    }
    uint32_t value = 0;
    for (size_t i = 0; i < 9; ++i) {
        const char ch = response[plen + i];
        if (ch < '0' || ch > '9') return false;
        value = value * 10U + (uint32_t)(ch - '0');
    }
    *frequency_hz = value;
    return true;
}

static bool parse_mode_reply(const char *response, char selector, char *mode_code)
{
    if (response == NULL || mode_code == NULL || strlen(response) != 5 ||
        response[0] != 'M' || response[1] != 'D' || response[2] != selector || response[4] != ';') {
        return false;
    }
    const char code = response[3];
    if (!((code >= '0' && code <= '9') || (code >= 'A' && code <= 'F'))) return false;
    *mode_code = code;
    return true;
}

static esp_err_t cat_disable_auto_information(cat_ctx_t *ctx)
{
    esp_err_t err = cat_bulk_write(ctx, "AI0;");
    if (err == ESP_OK) {
        /* AI0; is a setter and normally has no reply. Pump briefly so any stale
         * completion is consumed before the first query, then clear the parser. */
        const int64_t deadline_us = esp_timer_get_time() + 50000LL;
        while (!ctx->dev_gone && esp_timer_get_time() < deadline_us) {
            esp_err_t pump = usb_host_client_handle_events(ctx->client_hdl, pdMS_TO_TICKS(10));
            if (pump != ESP_OK && pump != ESP_ERR_TIMEOUT) break;
        }
        ctx->rx_message_len = 0;
        ctx->rx_message[0] = '\0';
        status_lock();
        s_status.ai_disabled = true;
        status_unlock();
        ESP_LOGI(TAG, "CAT Auto Information disabled: TX='AI0;' (read-only polling can now serialize replies)");
    }
    return err;
}

static bool parse_uint_reply(const char *response, const char *prefix, size_t digits, int *value)
{
    if (response == NULL || prefix == NULL || value == NULL) return false;
    const size_t plen = strlen(prefix);
    if (strlen(response) != plen + digits + 1 || strncmp(response, prefix, plen) != 0 ||
        response[plen + digits] != ';') return false;
    int parsed = 0;
    for (size_t i = 0; i < digits; ++i) {
        const char ch = response[plen + i];
        if (ch < '0' || ch > '9') return false;
        parsed = parsed * 10 + (ch - '0');
    }
    *value = parsed;
    return true;
}

static const char *agc_name_from_code(char code)
{
    switch (code) {
    case '0': return "OFF";
    case '1': return "FAST";
    case '2': return "MID";
    case '3': return "SLOW";
    case '4': case '5': case '6': return "AUTO";
    default: return "UNKNOWN";
    }
}

static const char *preamp_name_from_code(char code)
{
    switch (code) {
    case '0': return "IPO";
    case '1': return "AMP1";
    case '2': return "AMP2";
    default: return "UNKNOWN";
    }
}

static const char *meter_name_from_code(char code)
{
    switch (code) {
    case '0': return "PO";
    case '1': return "COMP";
    case '2': return "ALC";
    case '3': return "VDD";
    case '4': return "ID";
    case '5': return "SWR";
    default: return "UNKNOWN";
    }
}

static const char *scope_mode_name_from_code(char code)
{
    switch (code) {
    case '0': return "3DSS CENTER";
    case '1': return "3DSS CURSOR";
    case '2': return "3DSS FIX";
    case '3': case '5': return "WATERFALL CENTER EXPAND";
    case '4': return "WATERFALL CENTER NORMAL";
    case '6': return "WATERFALL CURSOR EXPAND";
    case '7': return "WATERFALL CURSOR NORMAL";
    case '9': return "WATERFALL FIX EXPAND";
    case 'A': return "WATERFALL FIX NORMAL";
    default: return "UNKNOWN";
    }
}

static const char *scope_speed_name_from_code(char code)
{
    switch (code) {
    case '0': return "SLOW 1";
    case '1': return "SLOW 2";
    case '2': return "FAST 1";
    case '3': return "FAST 2";
    case '4': return "FAST 3";
    case '5': return "STOP";
    default: return "UNKNOWN";
    }
}

static const char *scope_span_name_from_code(char code)
{
    switch (code) {
    case '0': return "1 kHz";
    case '1': return "2 kHz";
    case '2': return "5 kHz";
    case '3': return "10 kHz";
    case '4': return "20 kHz";
    case '5': return "50 kHz";
    case '6': return "100 kHz";
    case '7': return "200 kHz";
    case '8': return "500 kHz";
    case '9': return "1 MHz";
    default: return "UNKNOWN";
    }
}

static bool optional_query(cat_ctx_t *ctx, const char *command, char *response, size_t response_size)
{
    esp_err_t err = cat_query_response(ctx, command, response, response_size);
    if (err != ESP_OK) {
        status_lock();
        s_status.optional_poll_error_count++;
        status_unlock();
        return false;
    }
    return true;
}

static esp_err_t cat_poll_readonly_state(cat_ctx_t *ctx)
{
    char response[FT710_CAT_RESPONSE_MAX];
    bool power_on = false;
    bool split_enabled = false;
    bool active_b = false;
    uint32_t vfo_a_hz = 0;
    uint32_t vfo_b_hz = 0;
    char main_mode_code = 0;
    char sub_mode_code = 0;
    esp_err_t err;

#define CAT_QUERY_OR_FAIL(cmd) do { \
        err = cat_query_response(ctx, (cmd), response, sizeof(response)); \
        if (err != ESP_OK) goto poll_fail; \
    } while (0)

    /* Core snapshot: all of these must succeed together. */
    CAT_QUERY_OR_FAIL("PS;");
    if (!parse_bool_reply(response, "PS", &power_on)) { err = ESP_FAIL; goto poll_fail; }

    if (!power_on) {
        status_lock();
        s_status.power_known = true;
        s_status.radio_power_on = false;
        s_status.power_starting = false;
        s_status.power_transition_deadline_ms = 0;
        s_status.consecutive_poll_failures = 0;
        s_status.state_valid = true;
        s_status.frequency_hz = 0;
        s_status.vfo_a_hz = 0;
        s_status.vfo_b_hz = 0;
        s_status.active_vfo[0] = '\0';
        s_status.mode[0] = '\0';
        s_status.vfo_a_mode[0] = '\0';
        s_status.vfo_b_mode[0] = '\0';
        s_status.ptt_active = false;
        s_status.ptt_deadline_ms = 0;
        snprintf(s_status.tx_state, sizeof(s_status.tx_state), "%s", "RX");
        s_status.state_poll_count++;
        s_status.state_updated_ms = (uint64_t)(esp_timer_get_time() / 1000LL);
        s_status.last_error = ESP_OK;
        status_unlock();
        return ESP_OK;
    }

    CAT_QUERY_OR_FAIL("VS;");
    if (!parse_bool_reply(response, "VS", &active_b)) { err = ESP_FAIL; goto poll_fail; }
    CAT_QUERY_OR_FAIL("ST;");
    if (!parse_bool_reply(response, "ST", &split_enabled)) { err = ESP_FAIL; goto poll_fail; }
    CAT_QUERY_OR_FAIL("FA;");
    if (!parse_frequency_reply(response, "FA", &vfo_a_hz)) { err = ESP_FAIL; goto poll_fail; }
    CAT_QUERY_OR_FAIL("FB;");
    if (!parse_frequency_reply(response, "FB", &vfo_b_hz)) { err = ESP_FAIL; goto poll_fail; }
    CAT_QUERY_OR_FAIL("MD0;");
    if (!parse_mode_reply(response, '0', &main_mode_code)) { err = ESP_FAIL; goto poll_fail; }
    CAT_QUERY_OR_FAIL("MD1;");
    if (!parse_mode_reply(response, '1', &sub_mode_code)) { err = ESP_FAIL; goto poll_fail; }

    const char *main_mode = mode_name_from_code(main_mode_code);
    const char *sub_mode = mode_name_from_code(sub_mode_code);
    const char *vfo_a_mode = active_b ? sub_mode : main_mode;
    const char *vfo_b_mode = active_b ? main_mode : sub_mode;

    status_lock();
    s_status.power_known = true;
    s_status.radio_power_on = true;
    s_status.power_starting = false;
    s_status.power_transition_deadline_ms = 0;
    s_status.consecutive_poll_failures = 0;
    s_status.split_known = true;
    s_status.split_enabled = split_enabled;
    s_status.active_vfo[0] = active_b ? 'B' : 'A';
    s_status.active_vfo[1] = '\0';
    s_status.vfo_a_hz = vfo_a_hz;
    s_status.vfo_b_hz = vfo_b_hz;
    s_status.frequency_hz = active_b ? vfo_b_hz : vfo_a_hz;
    snprintf(s_status.vfo_a_mode, sizeof(s_status.vfo_a_mode), "%s", vfo_a_mode);
    snprintf(s_status.vfo_b_mode, sizeof(s_status.vfo_b_mode), "%s", vfo_b_mode);
    snprintf(s_status.mode, sizeof(s_status.mode), "%s", active_b ? vfo_b_mode : vfo_a_mode);
    s_status.state_valid = true;
    s_status.state_poll_count++;
    s_status.state_updated_ms = (uint64_t)(esp_timer_get_time() / 1000LL);
    s_status.last_error = ESP_OK;
    status_unlock();

    /* Secondary controls: best effort. A transient failure here never destroys
     * the coherent frequency/mode/VFO snapshot above. */
    int ivalue = 0;
    if (optional_query(ctx, "PC;", response, sizeof(response)) && parse_uint_reply(response, "PC", 3, &ivalue)) {
        status_lock(); s_status.tx_power_w = ivalue; status_unlock();
    }
    if (optional_query(ctx, "EX030102;", response, sizeof(response)) &&
        strlen(response) == 10 && strncmp(response, "EX030102", 8) == 0 && response[9] == ';') {
        const char *name = response[8] == '0' ? "RF" : (response[8] == '1' ? "SQL" : (response[8] == '2' ? "SQL_FM" : "UNKNOWN"));
        status_lock(); snprintf(s_status.rf_sql_vr, sizeof(s_status.rf_sql_vr), "%s", name); status_unlock();
    }
    if (optional_query(ctx, "RG0;", response, sizeof(response)) && parse_uint_reply(response, "RG0", 3, &ivalue)) {
        status_lock(); s_status.rf_gain = ivalue; status_unlock();
    }
    if (optional_query(ctx, "SQ0;", response, sizeof(response)) && parse_uint_reply(response, "SQ0", 3, &ivalue)) {
        status_lock(); s_status.squelch_level = ivalue; status_unlock();
    }
    if (optional_query(ctx, "GT0;", response, sizeof(response)) && strlen(response) == 5 && strncmp(response, "GT0", 3) == 0 && response[4] == ';') {
        status_lock(); snprintf(s_status.agc, sizeof(s_status.agc), "%s", agc_name_from_code(response[3])); status_unlock();
    }
    if (optional_query(ctx, "AC;", response, sizeof(response)) && strlen(response) == 6 && strncmp(response, "AC0", 3) == 0 && response[5] == ';') {
        const char *name = response[4] == '0' ? "OFF" : (response[4] == '1' ? "ON" : (response[4] == '3' ? "TUNING" : "UNKNOWN"));
        status_lock(); snprintf(s_status.tuner, sizeof(s_status.tuner), "%s", name); status_unlock();
    }
    if (optional_query(ctx, "RI0;", response, sizeof(response)) && strlen(response) == 11 && strncmp(response, "RI0", 3) == 0 && response[10] == ';') {
        /* RI0 P1 P2 P3 0 P5 P6 P7 ; */
        const char *tx = response[5] == '0' ? "RX" : (response[5] == '1' ? "TX" : "TX INHIBIT");
        status_lock();
        s_status.hi_swr = response[3] == '1';
        snprintf(s_status.tx_state, sizeof(s_status.tx_state), "%s", tx);
        s_status.tuner_busy = response[7] == '1';
        s_status.squelch_open = response[9] == '1';
        status_unlock();
    }
    if (optional_query(ctx, "PA0;", response, sizeof(response)) && strlen(response) == 5 && strncmp(response, "PA0", 3) == 0 && response[4] == ';') {
        status_lock(); snprintf(s_status.preamp, sizeof(s_status.preamp), "%s", preamp_name_from_code(response[3])); status_unlock();
    }
    if (optional_query(ctx, "RA0;", response, sizeof(response)) && strlen(response) == 5 && strncmp(response, "RA0", 3) == 0 && response[4] == ';' && response[3] >= '0' && response[3] <= '3') {
        status_lock(); s_status.attenuator_db = (response[3] - '0') * 6; status_unlock();
    }
    if (optional_query(ctx, "SH0;", response, sizeof(response)) && strlen(response) == 7 && strncmp(response, "SH00", 4) == 0 && response[6] == ';') {
        int code = (response[4] - '0') * 10 + (response[5] - '0');
        if (response[4] >= '0' && response[4] <= '9' && response[5] >= '0' && response[5] <= '9') {
            status_lock(); s_status.width_code = code; status_unlock();
        }
    }
    if (optional_query(ctx, "IS0;", response, sizeof(response)) && strlen(response) == 10 && strncmp(response, "IS00", 4) == 0 && response[9] == ';' && (response[4] == '+' || response[4] == '-')) {
        int shift = 0; bool valid = true;
        for (int i = 5; i < 9; ++i) { if (response[i] < '0' || response[i] > '9') { valid = false; break; } shift = shift * 10 + (response[i] - '0'); }
        if (valid) { if (response[4] == '-') shift = -shift; status_lock(); s_status.if_shift_hz = shift; status_unlock(); }
    }
    if (optional_query(ctx, "BP00;", response, sizeof(response)) && strlen(response) == 8 && strncmp(response, "BP00", 4) == 0 && response[7] == ';') {
        status_lock(); s_status.manual_notch = strcmp(response + 4, "001;") == 0; status_unlock();
    }
    if (optional_query(ctx, "BP01;", response, sizeof(response)) && parse_uint_reply(response, "BP01", 3, &ivalue)) {
        status_lock(); s_status.manual_notch_hz = ivalue * 10; status_unlock();
    }
    if (optional_query(ctx, "CO00;", response, sizeof(response)) && strlen(response) == 9 && strncmp(response, "CO00", 4) == 0 && response[8] == ';') {
        status_lock(); s_status.contour = strcmp(response + 4, "0001;") == 0; status_unlock();
    }
    if (optional_query(ctx, "CO01;", response, sizeof(response)) && parse_uint_reply(response, "CO01", 4, &ivalue)) {
        status_lock(); s_status.contour_hz = ivalue; status_unlock();
    }
    if (optional_query(ctx, "NR0;", response, sizeof(response)) && parse_bool_reply(response, "NR0", &power_on)) {
        status_lock(); s_status.dnr = power_on; status_unlock();
    }
    if (optional_query(ctx, "RL0;", response, sizeof(response)) && parse_uint_reply(response, "RL0", 2, &ivalue)) {
        status_lock(); s_status.dnr_level = ivalue; status_unlock();
    }
    if (optional_query(ctx, "NB0;", response, sizeof(response)) && parse_bool_reply(response, "NB0", &power_on)) {
        status_lock(); s_status.noise_blanker = power_on; status_unlock();
    }
    if (optional_query(ctx, "NL0;", response, sizeof(response)) && parse_uint_reply(response, "NL0", 3, &ivalue)) {
        status_lock(); s_status.noise_blanker_level = ivalue; status_unlock();
    }
    if (optional_query(ctx, "BC0;", response, sizeof(response)) && parse_bool_reply(response, "BC0", &power_on)) {
        status_lock(); s_status.auto_notch = power_on; status_unlock();
    }
    if (optional_query(ctx, "MS;", response, sizeof(response)) && strlen(response) == 5 && strncmp(response, "MS", 2) == 0 && response[3] == '0' && response[4] == ';') {
        status_lock(); snprintf(s_status.meter_display, sizeof(s_status.meter_display), "%s", meter_name_from_code(response[2])); status_unlock();
    }
    if (optional_query(ctx, "SS06;", response, sizeof(response)) && strlen(response) == 10 && strncmp(response, "SS06", 4) == 0 && response[9] == ';') {
        status_lock(); snprintf(s_status.scope_mode, sizeof(s_status.scope_mode), "%s", scope_mode_name_from_code(response[4])); status_unlock();
    }
    if (optional_query(ctx, "SS00;", response, sizeof(response)) && strlen(response) == 10 && strncmp(response, "SS00", 4) == 0 && response[9] == ';') {
        status_lock(); snprintf(s_status.scope_speed, sizeof(s_status.scope_speed), "%s", scope_speed_name_from_code(response[4])); status_unlock();
    }
    if (optional_query(ctx, "SS05;", response, sizeof(response)) && strlen(response) == 10 && strncmp(response, "SS05", 4) == 0 && response[9] == ';') {
        status_lock(); snprintf(s_status.scope_span, sizeof(s_status.scope_span), "%s", scope_span_name_from_code(response[4])); status_unlock();
    }

    return ESP_OK;

poll_fail:
    {
        const uint64_t now_ms = (uint64_t)(esp_timer_get_time() / 1000LL);
        bool starting = false;
        bool assumed_off = false;
        bool was_already_off = false;
        uint8_t failures = 0;
        char last_cmd[64];
        char last_rsp[FT710_CAT_RESPONSE_MAX];
        last_cmd[0] = '\0';
        last_rsp[0] = '\0';

        status_lock();
        const bool already_off = s_status.power_known && !s_status.radio_power_on && !s_status.power_starting;
        was_already_off = already_off;
        if (!already_off) {
            s_status.state_poll_error_count++;
            if (s_status.consecutive_poll_failures < UINT8_MAX) {
                s_status.consecutive_poll_failures++;
            }
        }
        failures = s_status.consecutive_poll_failures;
        starting = s_status.power_starting &&
                   s_status.power_transition_deadline_ms != 0 &&
                   now_ms < s_status.power_transition_deadline_ms;

        if (already_off) {
            s_status.state_valid = true;
            s_status.last_error = ESP_OK;
            assumed_off = true;
        } else if (!starting && failures >= FT710_CAT_OFFLINE_AFTER_FAILURES) {
            /* FT-710 keeps the CP2105 bridge alive while the radio itself is off.
             * A silent CAT port is therefore a useful OFF indication. Keep the
             * transport open so PS1; can power the radio back on. */
            s_status.power_known = true;
            s_status.radio_power_on = false;
            s_status.power_starting = false;
            s_status.power_transition_deadline_ms = 0;
            s_status.state_valid = true;
            s_status.ptt_active = false;
            s_status.ptt_deadline_ms = 0;
            snprintf(s_status.tx_state, sizeof(s_status.tx_state), "%s", "RX");
            s_status.last_error = ESP_OK;
            assumed_off = true;
        } else if (!starting) {
            s_status.state_valid = false;
            s_status.last_error = (int)err;
        } else {
            /* During PS1 startup the radio can legitimately be silent for
             * several seconds. Do not turn that into an error storm. */
            s_status.last_error = ESP_OK;
        }
        snprintf(last_cmd, sizeof(last_cmd), "%s", s_status.last_command);
        snprintf(last_rsp, sizeof(last_rsp), "%s", s_status.last_response);
        status_unlock();

        if (starting) {
            if (failures == 1) {
                ESP_LOGI(TAG, "Radio power-up in progress; CAT replies not ready yet");
            }
        } else if (assumed_off) {
            if (!was_already_off && failures == FT710_CAT_OFFLINE_AFTER_FAILURES) {
                ESP_LOGI(TAG, "CAT silent for %u consecutive polls; treating FT-710 as powered OFF while keeping CAT bridge available for PS1;",
                         (unsigned)failures);
            }
        } else {
            ESP_LOGW(TAG, "CAT core state poll failed (%u/%u) after TX='%s' RX='%s': %s",
                     (unsigned)failures, (unsigned)FT710_CAT_OFFLINE_AFTER_FAILURES,
                     last_cmd, last_rsp, esp_err_to_name(err));
        }
        return err;
    }
#undef CAT_QUERY_OR_FAIL
}

static esp_err_t cat_safe_id_query(cat_ctx_t *ctx)
{
    char response[FT710_CAT_RESPONSE_MAX];
    esp_err_t err = cat_query_response(ctx, "ID;", response, sizeof(response));
    status_lock();
    s_status.id_query_sent = true;
    if (err == ESP_OK) {
        const bool ok = strncmp(response, "ID", 2) == 0 && strchr(response, ';') != NULL;
        s_status.id_query_ok = ok;
        if (ok) {
            size_t n = strlen(response);
            if (n >= 3 && response[n - 1] == ';') {
                const size_t id_len = n - 3;
                snprintf(s_status.radio_id, sizeof(s_status.radio_id), "%.*s", (int)id_len, response + 2);
            }
        }
        s_status.last_error = ok ? ESP_OK : ESP_FAIL;
        status_unlock();
        ESP_LOGI(TAG, "CAT safe query: TX='ID;' RX='%s' valid=%s", response, ok ? "yes" : "no");
        return ok ? ESP_OK : ESP_FAIL;
    }
    s_status.id_query_ok = false;
    s_status.last_error = (int)err;
    status_unlock();
    ESP_LOGW(TAG, "CAT safe query ID; failed: %s partial RX='%s'", esp_err_to_name(err), response);
    return err;
}


static void process_external_request(cat_ctx_t *ctx)
{
    if (ctx == NULL || !s_external_request.pending) return;

    char response[FT710_CAT_RESPONSE_MAX] = {0};
    esp_err_t result = ESP_ERR_INVALID_STATE;
    if (ctx->ready && ctx->dev_hdl != NULL && !ctx->dev_gone) {
        if (s_external_request.expect_reply) {
            result = cat_query_response(ctx, s_external_request.command, response, sizeof(response));
        } else {
            result = cat_bulk_write(ctx, s_external_request.command);
        }
    }

    snprintf(s_external_request.response, sizeof(s_external_request.response), "%s", response);
    s_external_request.result = result;
    s_external_request.pending = false;

    status_lock();
    s_status.external_command_count++;
    if (result != ESP_OK) s_status.external_command_error_count++;
    status_unlock();

    if (s_external_done != NULL) xSemaphoreGive(s_external_done);
}

static void ptt_watchdog_tick(cat_ctx_t *ctx)
{
    bool active = false;
    uint64_t deadline_ms = 0;
    const uint64_t now_ms = (uint64_t)(esp_timer_get_time() / 1000LL);
    status_lock();
    active = s_status.ptt_active;
    deadline_ms = s_status.ptt_deadline_ms;
    status_unlock();
    if (!active || deadline_ms == 0 || now_ms < deadline_ms) return;

    ESP_LOGW(TAG, "PTT keepalive watchdog expired; forcing CAT TX0;");
    esp_err_t err = (ctx != NULL && ctx->ready && ctx->dev_hdl != NULL && !ctx->dev_gone)
                        ? cat_bulk_write(ctx, "TX0;") : ESP_ERR_INVALID_STATE;
    status_lock();
    /* Clear local TX state even if USB is gone. On reconnect try_open_cp2105()
     * sends TX0; again before exposing the CAT interface as ready. */
    s_status.ptt_active = false;
    s_status.ptt_deadline_ms = 0;
    s_status.tx_quiet_requested = false;
    s_status.ptt_watchdog_releases++;
    snprintf(s_status.tx_state, sizeof(s_status.tx_state), "%s", "RX");
    if (err != ESP_OK) s_status.last_error = (int)err;
    status_unlock();
}

static bool normalize_external_command(const char *command, char *out, size_t out_size)
{
    if (command == NULL || out == NULL || out_size < 3) return false;
    size_t len = strlen(command);
    while (len > 0 && (command[len - 1] == ' ' || command[len - 1] == '\t' || command[len - 1] == '\r' || command[len - 1] == '\n')) len--;
    size_t start = 0;
    while (start < len && (command[start] == ' ' || command[start] == '\t')) start++;
    if (start >= len) return false;
    size_t body_len = len - start;
    if (command[start + body_len - 1] == ';') body_len--;
    if (body_len == 0 || body_len + 2 > out_size) return false;
    for (size_t i = 0; i < body_len; ++i) {
        const unsigned char ch = (unsigned char)command[start + i];
        if (ch < 32 || ch > 126 || ch == ';') return false;
        out[i] = (char)ch;
    }
    out[body_len] = ';';
    out[body_len + 1] = '\0';
    return true;
}

static void cleanup_device(cat_ctx_t *ctx)
{
    if (ctx == NULL || ctx->dev_hdl == NULL) {
        return;
    }
    ctx->ready = false;
    status_lock();
    s_status.rx_running = false;
    status_unlock();

    if (ctx->in_ep != 0) {
        (void)usb_host_endpoint_halt(ctx->dev_hdl, ctx->in_ep);
        (void)usb_host_endpoint_flush(ctx->dev_hdl, ctx->in_ep);
    }
    if (ctx->out_ep != 0) {
        (void)usb_host_endpoint_halt(ctx->dev_hdl, ctx->out_ep);
        (void)usb_host_endpoint_flush(ctx->dev_hdl, ctx->out_ep);
    }
    (void)usb_host_interface_release(ctx->client_hdl, ctx->dev_hdl, FT710_CAT_AUX_INTERFACE);
    (void)usb_host_device_close(ctx->client_hdl, ctx->dev_hdl);

    ctx->dev_hdl = NULL;
    ctx->dev_addr = 0;
    ctx->dev_gone = false;
    ctx->in_ep = ctx->out_ep = 0;
    ctx->in_mps = ctx->out_mps = 0;
    ctx->in_transfer_len = 0;
    ctx->in_xfer_inflight = false;
    ctx->tx_quiet_active = false;
    ctx->rx_message_len = 0;

    status_lock();
    s_status.device_open = false;
    s_status.interface_claimed = false;
    s_status.uart_enabled = false;
    s_status.configured_115200_8n1 = false;
    s_status.dtr_rts_forced_low = false;
    s_status.rx_running = false;
    s_status.ai_disabled = false;
    s_status.state_valid = false;
    s_status.power_known = false;
    s_status.split_known = false;
    s_status.ptt_active = false;
    s_status.ptt_deadline_ms = 0;
    s_status.tx_quiet_requested = false;
    s_status.tx_quiet_active = false;
    snprintf(s_status.tx_state, sizeof(s_status.tx_state), "%s", "RX");
    s_status.active_vfo[0] = '\0';
    s_status.mode[0] = '\0';
    s_status.vfo_a_mode[0] = '\0';
    s_status.vfo_b_mode[0] = '\0';
    s_status.disconnect_count++;
    status_unlock();

    if (s_external_request.pending) {
        s_external_request.result = ESP_ERR_INVALID_STATE;
        s_external_request.response[0] = '\0';
        s_external_request.pending = false;
        if (s_external_done != NULL) xSemaphoreGive(s_external_done);
    }
}

static esp_err_t try_open_cp2105(cat_ctx_t *ctx, uint8_t addr)
{
    usb_device_handle_t dev = NULL;
    esp_err_t err = usb_host_device_open(ctx->client_hdl, addr, &dev);
    if (err != ESP_OK) {
        return err;
    }

    const usb_device_desc_t *desc = NULL;
    err = usb_host_get_device_descriptor(dev, &desc);
    if (err != ESP_OK || desc == NULL) {
        usb_host_device_close(ctx->client_hdl, dev);
        return err != ESP_OK ? err : ESP_FAIL;
    }
    if (desc->idVendor != FT710_CAT_CP2105_VID || desc->idProduct != FT710_CAT_CP2105_PID) {
        usb_host_device_close(ctx->client_hdl, dev);
        return ESP_ERR_NOT_FOUND;
    }

    const usb_config_desc_t *config = NULL;
    err = usb_host_get_active_config_descriptor(dev, &config);
    if (err != ESP_OK || config == NULL) {
        usb_host_device_close(ctx->client_hdl, dev);
        return err != ESP_OK ? err : ESP_FAIL;
    }

    uint8_t in_ep = 0, out_ep = 0;
    uint16_t in_mps = 0, out_mps = 0;
    if (!find_aux_endpoints(config, &in_ep, &in_mps, &out_ep, &out_mps)) {
        ESP_LOGE(TAG, "CP2105 found at addr=%u but CAT-2 interface 1 BULK endpoints were not found", addr);
        usb_host_device_close(ctx->client_hdl, dev);
        return ESP_ERR_NOT_SUPPORTED;
    }

    err = usb_host_interface_claim(ctx->client_hdl, dev, FT710_CAT_AUX_INTERFACE, 0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "CP2105 interface 1 claim failed: %s", esp_err_to_name(err));
        usb_host_device_close(ctx->client_hdl, dev);
        return err;
    }

    ctx->dev_hdl = dev;
    ctx->dev_addr = addr;
    ctx->in_ep = in_ep;
    ctx->out_ep = out_ep;
    ctx->in_mps = in_mps;
    ctx->out_mps = out_mps;

    status_lock();
    s_status.cp2105_found = true;
    s_status.device_open = true;
    s_status.interface_claimed = true;
    s_status.device_address = addr;
    s_status.interface_number = FT710_CAT_AUX_INTERFACE;
    s_status.bulk_in_ep = in_ep;
    s_status.bulk_out_ep = out_ep;
    s_status.bulk_in_mps = in_mps;
    s_status.bulk_out_mps = out_mps;
    status_unlock();

    ESP_LOGI(TAG, "FT-710 CP2105 CAT-2 found: addr=%u if=1 IN=0x%02X/%u OUT=0x%02X/%u; interface claimed",
             addr, in_ep, in_mps, out_ep, out_mps);

    err = configure_cp2105_aux(ctx);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "CP2105 CAT-2 configuration failed: %s", esp_err_to_name(err));
        cleanup_device(ctx);
        return err;
    }

    err = start_rx(ctx);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "CAT continuous RX start failed: %s", esp_err_to_name(err));
        cleanup_device(ctx);
        return err;
    }

    err = cat_disable_auto_information(ctx);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "AI0; could not be sent: %s; continuing with serialized diagnostics", esp_err_to_name(err));
    }

    /* Safety invariant: every CAT reconnection starts by explicitly releasing
     * CAT PTT before the interface is exposed as ready to the application. */
    err = cat_bulk_write(ctx, "TX0;");
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Initial CAT PTT release TX0; failed: %s", esp_err_to_name(err));
    } else {
        status_lock();
        s_status.ptt_active = false;
        s_status.ptt_deadline_ms = 0;
        snprintf(s_status.tx_state, sizeof(s_status.tx_state), "%s", "RX");
        status_unlock();
    }

    err = cat_safe_id_query(ctx);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "CAT transport is configured but ID; validation did not complete: %s", esp_err_to_name(err));
        /* Keep the claimed/ready interface alive for diagnostics. */
    }
    return ESP_OK;
}

static void client_event_cb(const usb_host_client_event_msg_t *event_msg, void *arg)
{
    cat_ctx_t *ctx = (cat_ctx_t *)arg;
    if (ctx == NULL || event_msg == NULL) {
        return;
    }
    if (event_msg->event == USB_HOST_CLIENT_EVENT_NEW_DEV) {
        ctx->scan_requested = true;
    } else if (event_msg->event == USB_HOST_CLIENT_EVENT_DEV_GONE &&
               ctx->dev_hdl != NULL && event_msg->dev_gone.dev_hdl == ctx->dev_hdl) {
        ctx->dev_gone = true;
    }
}

static void scan_for_cp2105(cat_ctx_t *ctx)
{
    if (ctx->dev_hdl != NULL) {
        return;
    }
    uint8_t addresses[FT710_CAT_ADDR_LIST_MAX] = {0};
    int count = 0;
    esp_err_t err = usb_host_device_addr_list_fill(FT710_CAT_ADDR_LIST_MAX, addresses, &count);
    if (err != ESP_OK) {
        status_error(err);
        return;
    }
    for (int i = 0; i < count && i < FT710_CAT_ADDR_LIST_MAX; ++i) {
        if (addresses[i] == 0) continue;
        err = try_open_cp2105(ctx, addresses[i]);
        if (err == ESP_OK) {
            return;
        }
        if (err != ESP_ERR_NOT_FOUND) {
            status_error(err);
        }
    }
}

static void cat_tx_quiet_transition(cat_ctx_t *ctx)
{
    if (ctx == NULL) return;
    bool requested = false;
    status_lock();
    requested = s_status.tx_quiet_requested;
    status_unlock();
    if (requested == ctx->tx_quiet_active) return;

    if (requested) {
        /* Set the gate first so a completion callback cannot resubmit BULK IN
         * while halt/flush is being performed. */
        ctx->tx_quiet_active = true;
        esp_err_t halt_err = ESP_OK;
        esp_err_t flush_err = ESP_OK;
        if (ctx->ready && ctx->dev_hdl != NULL && ctx->in_ep != 0) {
            halt_err = usb_host_endpoint_halt(ctx->dev_hdl, ctx->in_ep);
            if (halt_err == ESP_OK) flush_err = usb_host_endpoint_flush(ctx->dev_hdl, ctx->in_ep);
            const int64_t deadline = esp_timer_get_time() + 300000LL;
            while (ctx->in_xfer_inflight && !ctx->dev_gone && esp_timer_get_time() < deadline) {
                esp_err_t ev = usb_host_client_handle_events(ctx->client_hdl, pdMS_TO_TICKS(10));
                if (ev != ESP_OK && ev != ESP_ERR_TIMEOUT) break;
            }
        }
        const bool ok = halt_err == ESP_OK && flush_err == ESP_OK && !ctx->in_xfer_inflight;
        status_lock();
        s_status.tx_quiet_active = ok;
        s_status.rx_running = false;
        if (!ok) s_status.last_error = halt_err != ESP_OK ? (int)halt_err : (flush_err != ESP_OK ? (int)flush_err : ESP_ERR_TIMEOUT);
        status_unlock();
        ESP_LOGW(TAG, "FT8.5.16 CAT TX quiet enter: halt=%s flush=%s inflight=%d active=%d",
                 esp_err_to_name(halt_err), esp_err_to_name(flush_err), ctx->in_xfer_inflight, ok);
        if (!ok) {
            /* Avoid claiming isolation when the endpoint could not be stopped. */
            ctx->tx_quiet_active = false;
        }
        return;
    }

    esp_err_t clear_err = ESP_OK;
    esp_err_t rx_err = ESP_OK;
    if (ctx->ready && ctx->dev_hdl != NULL && ctx->in_ep != 0) {
        clear_err = usb_host_endpoint_clear(ctx->dev_hdl, ctx->in_ep);
        ctx->tx_quiet_active = false;
        if (clear_err == ESP_OK) {
            ctx->rx_message_len = 0;
            ctx->rx_message[0] = '\0';
            rx_err = start_rx(ctx);
        }
    } else {
        ctx->tx_quiet_active = false;
    }
    const bool ok = clear_err == ESP_OK && rx_err == ESP_OK;
    status_lock();
    s_status.tx_quiet_active = false;
    if (!ok) s_status.last_error = clear_err != ESP_OK ? (int)clear_err : (int)rx_err;
    status_unlock();
    ESP_LOGW(TAG, "FT8.5.16 CAT TX quiet leave: clear=%s rx=%s",
             esp_err_to_name(clear_err), esp_err_to_name(rx_err));
}

static void cat_task(void *arg)
{
    (void)arg;
    cat_ctx_t ctx;
    memset(&ctx, 0, sizeof(ctx));
    s_cat_task_handle = xTaskGetCurrentTaskHandle();

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
        ESP_LOGE(TAG, "CAT USB client register failed: %s", esp_err_to_name(err));
        status_error(err);
        vTaskDelete(NULL);
        return;
    }

    esp_err_t alloc_err = usb_host_transfer_alloc(FT710_CAT_CTRL_BUF_SIZE, 0, &ctx.ctrl_xfer);
    if (alloc_err == ESP_OK) {
        alloc_err = usb_host_transfer_alloc(FT710_CAT_BULK_BUF_SIZE, 0, &ctx.out_xfer);
    }
    if (alloc_err == ESP_OK) {
        alloc_err = usb_host_transfer_alloc(FT710_CAT_BULK_BUF_SIZE, 0, &ctx.in_xfer);
    }
    if (alloc_err != ESP_OK) {
        ESP_LOGE(TAG, "CAT USB transfer allocation failed: %s", esp_err_to_name(alloc_err));
        status_error(alloc_err);
        if (ctx.in_xfer != NULL) (void)usb_host_transfer_free(ctx.in_xfer);
        if (ctx.out_xfer != NULL) (void)usb_host_transfer_free(ctx.out_xfer);
        if (ctx.ctrl_xfer != NULL) (void)usb_host_transfer_free(ctx.ctrl_xfer);
        (void)usb_host_client_deregister(ctx.client_hdl);
        vTaskDelete(NULL);
        return;
    }

    status_lock();
    s_status.initialized = true;
    s_status.client_registered = true;
    s_status.interface_number = FT710_CAT_AUX_INTERFACE;
    s_status.baudrate = FT710_CAT_BAUDRATE;
    s_status.last_error = ESP_OK;
    status_unlock();

    ESP_LOGI(TAG, "M12.1 CAT client registered; CP2105 AUX CAT + full radio state + OFF/STARTING backoff + serialized API commands");
    ctx.scan_requested = true;
    TickType_t last_scan = 0;
    TickType_t last_state_poll = 0;

    for (;;) {
        err = usb_host_client_handle_events(ctx.client_hdl, pdMS_TO_TICKS(50));
        if (err != ESP_OK && err != ESP_ERR_TIMEOUT) {
            status_error(err);
        }

        /* Application/API CAT commands always run in this USB-owner task. */
        process_external_request(&ctx);
        cat_tx_quiet_transition(&ctx);
        ptt_watchdog_tick(&ctx);

        if (ctx.dev_gone) {
            ESP_LOGW(TAG, "FT-710 CP2105 disconnected");
            cleanup_device(&ctx);
            ctx.scan_requested = true;
        }

        TickType_t now = xTaskGetTickCount();
        if (ctx.scan_requested || (now - last_scan) >= pdMS_TO_TICKS(FT710_CAT_SCAN_PERIOD_MS)) {
            ctx.scan_requested = false;
            last_scan = now;
            scan_for_cp2105(&ctx);
        }

        if (ctx.ready && ctx.dev_hdl != NULL && !ctx.tx_quiet_active) {
            uint32_t poll_ms = FT710_CAT_STATE_POLL_MS;
            status_lock();
            const bool offline = s_status.power_known && !s_status.radio_power_on && !s_status.power_starting;
            status_unlock();
            if (offline) poll_ms = FT710_CAT_OFFLINE_POLL_MS;
            if (last_state_poll == 0 || (now - last_state_poll) >= pdMS_TO_TICKS(poll_ms)) {
                last_state_poll = now;
                (void)cat_poll_readonly_state(&ctx);
            }
        }
    }
}

esp_err_t ft710_cat_start(void)
{
    if (s_status_mutex != NULL) {
        return ESP_OK;
    }
    s_status_mutex = xSemaphoreCreateMutex();
    if (s_status_mutex == NULL) {
        return ESP_ERR_NO_MEM;
    }
    memset(&s_status, 0, sizeof(s_status));
    snprintf(s_status.tx_state, sizeof(s_status.tx_state), "%s", "RX");

    s_external_mutex = xSemaphoreCreateMutex();
    s_external_done = xSemaphoreCreateBinary();
    if (s_external_mutex == NULL || s_external_done == NULL) {
        if (s_external_mutex != NULL) vSemaphoreDelete(s_external_mutex);
        if (s_external_done != NULL) vSemaphoreDelete(s_external_done);
        vSemaphoreDelete(s_status_mutex);
        s_external_mutex = NULL;
        s_external_done = NULL;
        s_status_mutex = NULL;
        return ESP_ERR_NO_MEM;
    }
    memset(&s_external_request, 0, sizeof(s_external_request));

    BaseType_t ok = xTaskCreate(cat_task, "ft710_cat", FT710_CAT_TASK_STACK, NULL,
                                FT710_CAT_TASK_PRIO, NULL);
    if (ok != pdPASS) {
        vSemaphoreDelete(s_external_done);
        vSemaphoreDelete(s_external_mutex);
        vSemaphoreDelete(s_status_mutex);
        s_external_done = NULL;
        s_external_mutex = NULL;
        s_status_mutex = NULL;
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

void ft710_cat_get_status(ft710_cat_status_t *status)
{
    if (status == NULL) return;
    memset(status, 0, sizeof(*status));
    if (s_status_mutex == NULL) return;
    status_lock();
    *status = s_status;
    status_unlock();
}

esp_err_t ft710_cat_exchange(const char *command,
                             bool expect_reply,
                             char *response,
                             size_t response_size,
                             uint32_t timeout_ms)
{
    if (response != NULL && response_size > 0) response[0] = '\0';
    if (s_external_mutex == NULL || s_external_done == NULL || s_cat_task_handle == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    char normalized[FT710_CAT_EXTERNAL_CMD_MAX];
    if (!normalize_external_command(command, normalized, sizeof(normalized))) {
        return ESP_ERR_INVALID_ARG;
    }

    const uint32_t wait_ms = timeout_ms == 0 ? FT710_CAT_EXTERNAL_WAIT_MS : timeout_ms;
    TickType_t wait_ticks = pdMS_TO_TICKS(wait_ms);
    if (wait_ticks == 0) wait_ticks = 1;
    if (xSemaphoreTake(s_external_mutex, wait_ticks) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    /* A previous caller may have timed out while the CAT task was still
     * completing its request. Wait for that slot to become free before reuse. */
    if (s_external_request.pending) {
        if (xSemaphoreTake(s_external_done, wait_ticks) != pdTRUE && s_external_request.pending) {
            xSemaphoreGive(s_external_mutex);
            return ESP_ERR_TIMEOUT;
        }
    }
    while (xSemaphoreTake(s_external_done, 0) == pdTRUE) { /* drain stale completion */ }

    memset(&s_external_request, 0, sizeof(s_external_request));
    snprintf(s_external_request.command, sizeof(s_external_request.command), "%s", normalized);
    s_external_request.expect_reply = expect_reply;
    s_external_request.result = ESP_ERR_INVALID_STATE;
    s_external_request.pending = true;

    esp_err_t result = ESP_ERR_TIMEOUT;
    if (xSemaphoreTake(s_external_done, wait_ticks) == pdTRUE) {
        result = s_external_request.result;
        if (response != NULL && response_size > 0) {
            snprintf(response, response_size, "%s", s_external_request.response);
        }
    }
    xSemaphoreGive(s_external_mutex);
    return result;
}

esp_err_t ft710_cat_set(const char *command, uint32_t timeout_ms)
{
    return ft710_cat_exchange(command, false, NULL, 0, timeout_ms);
}

esp_err_t ft710_cat_query(const char *command, char *response, size_t response_size, uint32_t timeout_ms)
{
    if (response == NULL || response_size < 2) return ESP_ERR_INVALID_ARG;
    return ft710_cat_exchange(command, true, response, response_size, timeout_ms);
}

esp_err_t ft710_cat_set_power(bool enabled, uint32_t timeout_ms)
{
    if (!enabled) {
        (void)ft710_cat_force_ptt_off(timeout_ms);
    }

    esp_err_t err = ft710_cat_set(enabled ? "PS1;" : "PS0;", timeout_ms);
    if (err != ESP_OK) return err;

    const uint64_t now_ms = (uint64_t)(esp_timer_get_time() / 1000LL);
    status_lock();
    s_status.power_known = true;
    s_status.consecutive_poll_failures = 0;
    s_status.last_error = ESP_OK;
    if (enabled) {
        s_status.radio_power_on = false;
        s_status.power_starting = true;
        s_status.power_transition_deadline_ms = now_ms + FT710_CAT_POWER_START_GRACE_MS;
    } else {
        s_status.radio_power_on = false;
        s_status.power_starting = false;
        s_status.power_transition_deadline_ms = 0;
        s_status.state_valid = true;
        s_status.ptt_active = false;
        s_status.ptt_deadline_ms = 0;
        snprintf(s_status.tx_state, sizeof(s_status.tx_state), "%s", "RX");
    }
    status_unlock();
    return ESP_OK;
}

esp_err_t ft710_cat_set_ptt(bool enabled, uint32_t timeout_ms)
{
    esp_err_t err = ft710_cat_set(enabled ? "TX1;" : "TX0;", timeout_ms);
    if (err == ESP_OK) {
        status_lock();
        s_status.ptt_active = enabled;
        s_status.ptt_deadline_ms = enabled
            ? (uint64_t)(esp_timer_get_time() / 1000LL) + FT710_CAT_PTT_WATCHDOG_MS
            : 0;
        if (!enabled) s_status.tx_quiet_requested = false;
        snprintf(s_status.tx_state, sizeof(s_status.tx_state), "%s", enabled ? "TX" : "RX");
        status_unlock();
    }
    return err;
}

void ft710_cat_ptt_keepalive(void)
{
    const uint64_t now_ms = (uint64_t)(esp_timer_get_time() / 1000LL);
    status_lock();
    if (s_status.ptt_active) {
        s_status.ptt_deadline_ms = now_ms + FT710_CAT_PTT_WATCHDOG_MS;
    }
    status_unlock();
}

esp_err_t ft710_cat_force_ptt_off(uint32_t timeout_ms)
{
    ft710_cat_status_t st;
    ft710_cat_get_status(&st);
    if (!st.ptt_active && st.tx_state[0] != 'T') return ESP_OK;
    return ft710_cat_set_ptt(false, timeout_ms);
}

esp_err_t ft710_cat_set_tx_quiet(bool quiet, uint32_t timeout_ms)
{
    if (s_status_mutex == NULL || s_cat_task_handle == NULL) return ESP_ERR_INVALID_STATE;
    status_lock();
    s_status.tx_quiet_requested = quiet;
    status_unlock();
    const int64_t deadline = esp_timer_get_time() + (int64_t)timeout_ms * 1000LL;
    while (esp_timer_get_time() < deadline) {
        bool requested_now;
        bool active_now;
        status_lock();
        requested_now = s_status.tx_quiet_requested;
        active_now = s_status.tx_quiet_active;
        status_unlock();
        if (!quiet && !active_now) return ESP_OK;
        if (quiet && requested_now && active_now) return ESP_OK;
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    return ESP_ERR_TIMEOUT;
}

