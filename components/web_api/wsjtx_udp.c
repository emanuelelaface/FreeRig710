#include "wsjtx_udp.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lwip/netdb.h"
#include "lwip/sockets.h"

#define WSJTX_COMMAND_QUEUE_LENGTH 12
#define WSJTX_RECEIVER_STACK 4096

static const char *TAG = "wsjtx_udp";
static SemaphoreHandle_t s_mutex;
static QueueHandle_t s_commands;
static int s_socket = -1;
static struct sockaddr_storage s_target;
static socklen_t s_target_length;
static char s_host[65];
static uint16_t s_port;
static uint32_t s_sent_packets;
static uint32_t s_received_packets;
static uint32_t s_dropped_commands;
static uint32_t s_peer_schema = WSJTX_PROTOCOL_SCHEMA;
static bool s_started;

typedef struct {
    const uint8_t *data;
    size_t length;
    size_t offset;
    bool failed;
} reader_t;

static uint8_t read_u8(reader_t *r)
{
    if (!r || r->failed || r->offset >= r->length) {
        if (r) r->failed = true;
        return 0;
    }
    return r->data[r->offset++];
}

static uint32_t read_u32(reader_t *r)
{
    if (!r || r->failed || r->length - r->offset < 4) {
        if (r) r->failed = true;
        return 0;
    }
    uint32_t value = ((uint32_t)r->data[r->offset] << 24) |
                     ((uint32_t)r->data[r->offset + 1] << 16) |
                     ((uint32_t)r->data[r->offset + 2] << 8) |
                     (uint32_t)r->data[r->offset + 3];
    r->offset += 4;
    return value;
}

static int32_t read_i32(reader_t *r)
{
    return (int32_t)read_u32(r);
}

static uint64_t read_u64(reader_t *r)
{
    uint64_t high = read_u32(r);
    uint64_t low = read_u32(r);
    return (high << 32) | low;
}

static double read_double(reader_t *r)
{
    uint64_t bits = read_u64(r);
    double value = 0;
    memcpy(&value, &bits, sizeof(value));
    return value;
}

static bool read_utf8(reader_t *r, char *out, size_t out_size)
{
    uint32_t length = read_u32(r);
    if (r->failed || length == UINT32_MAX || length > r->length - r->offset) {
        r->failed = true;
        if (out && out_size) out[0] = '\0';
        return false;
    }
    if (out && out_size) {
        size_t copy = length < out_size - 1 ? length : out_size - 1;
        memcpy(out, r->data + r->offset, copy);
        out[copy] = '\0';
    }
    r->offset += length;
    return true;
}

static void queue_command(const wsjtx_command_t *command)
{
    if (!s_commands || !command) return;
    if (xQueueSend(s_commands, command, 0) == pdTRUE) return;
    wsjtx_command_t discarded;
    (void)xQueueReceive(s_commands, &discarded, 0);
    (void)xQueueSend(s_commands, command, 0);
    s_dropped_commands++;
}

static void parse_datagram(const uint8_t *data, size_t length)
{
    reader_t reader = { .data = data, .length = length };
    uint32_t magic = read_u32(&reader);
    uint32_t schema = read_u32(&reader);
    uint32_t raw_type = read_u32(&reader);
    wsjtx_command_t command = {0};
    if (reader.failed || magic != WSJTX_PROTOCOL_MAGIC || schema == 0 ||
        raw_type > WSJTX_MESSAGE_HIGHLIGHT_CALLSIGN) return;
    command.type = (wsjtx_message_type_t)raw_type;
    (void)read_utf8(&reader, command.id, sizeof(command.id));
    if (reader.failed) return;

    if (command.type == WSJTX_MESSAGE_HEARTBEAT) {
        uint32_t maximum_schema = reader.length - reader.offset >= 4 ? read_u32(&reader) : 2U;
        if (!reader.failed && maximum_schema > 0) {
            if (maximum_schema > WSJTX_PROTOCOL_SCHEMA) maximum_schema = WSJTX_PROTOCOL_SCHEMA;
            s_peer_schema = maximum_schema;
        }
        return;
    }
    if (strcmp(command.id, WSJTX_PROTOCOL_ID) != 0) return;

    switch (command.type) {
    case WSJTX_MESSAGE_REPLY:
        command.milliseconds_since_midnight = read_u32(&reader);
        command.snr = read_i32(&reader);
        command.delta_time_seconds = read_double(&reader);
        command.delta_frequency_hz = read_u32(&reader);
        (void)read_utf8(&reader, command.mode, sizeof(command.mode));
        (void)read_utf8(&reader, command.message, sizeof(command.message));
        command.low_confidence = read_u8(&reader) != 0;
        command.modifiers = read_u8(&reader);
        break;
    case WSJTX_MESSAGE_CLEAR:
        command.window = reader.offset < reader.length ? read_u8(&reader) : 0;
        break;
    case WSJTX_MESSAGE_REPLAY:
        break;
    case WSJTX_MESSAGE_HALT_TX:
        command.flag = read_u8(&reader) != 0;
        break;
    case WSJTX_MESSAGE_FREE_TEXT:
        (void)read_utf8(&reader, command.message, sizeof(command.message));
        command.flag = read_u8(&reader) != 0;
        break;
    case WSJTX_MESSAGE_LOCATION:
        (void)read_utf8(&reader, command.message, sizeof(command.message));
        break;
    default:
        return;
    }
    if (!reader.failed) queue_command(&command);
}

static void close_socket_locked(void)
{
    if (s_socket >= 0) close(s_socket);
    s_socket = -1;
    memset(&s_target, 0, sizeof(s_target));
    s_target_length = 0;
    s_host[0] = '\0';
    s_port = 0;
}

static esp_err_t open_socket_locked(const char *host, uint16_t port)
{
    if (s_socket >= 0 && s_port == port && !strcmp(s_host, host)) return ESP_OK;
    close_socket_locked();

    char service[8];
    snprintf(service, sizeof(service), "%u", (unsigned)port);
    struct addrinfo hints = {0};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_DGRAM;
    struct addrinfo *addresses = NULL;
    int lookup = getaddrinfo(host, service, &hints, &addresses);
    if (lookup != 0 || !addresses) return ESP_ERR_NOT_FOUND;

    esp_err_t result = ESP_FAIL;
    for (const struct addrinfo *address = addresses; address; address = address->ai_next) {
        int fd = socket(address->ai_family, address->ai_socktype, address->ai_protocol);
        if (fd < 0) continue;
        if ((size_t)address->ai_addrlen > sizeof(s_target)) {
            close(fd);
            continue;
        }
        int nonblocking = 1;
        (void)ioctl(fd, FIONBIO, &nonblocking);
        memcpy(&s_target, address->ai_addr, address->ai_addrlen);
        s_target_length = address->ai_addrlen;
        s_socket = fd;
        snprintf(s_host, sizeof(s_host), "%s", host);
        s_port = port;
        result = ESP_OK;
        break;
    }
    freeaddrinfo(addresses);
    return result;
}

static void receiver_task(void *unused)
{
    (void)unused;
    uint8_t datagram[768];
    for (;;) {
        int received = -1;
        if (s_mutex && xSemaphoreTake(s_mutex, pdMS_TO_TICKS(50)) == pdTRUE) {
            if (s_socket >= 0) received = recvfrom(s_socket, datagram, sizeof(datagram), MSG_DONTWAIT, NULL, NULL);
            xSemaphoreGive(s_mutex);
        }
        if (received > 0) {
            s_received_packets++;
            parse_datagram(datagram, (size_t)received);
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

esp_err_t wsjtx_udp_init(void)
{
    if (s_started) return ESP_OK;
    s_mutex = xSemaphoreCreateMutex();
    if (!s_mutex) return ESP_ERR_NO_MEM;
    s_commands = xQueueCreate(WSJTX_COMMAND_QUEUE_LENGTH, sizeof(wsjtx_command_t));
    if (!s_commands) return ESP_ERR_NO_MEM;
    if (xTaskCreate(receiver_task, "wsjtx_udp_rx", WSJTX_RECEIVER_STACK, NULL, 3, NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    s_started = true;
    ESP_LOGI(TAG, "WSJT-X schema 3 UDP client ready");
    return ESP_OK;
}

esp_err_t wsjtx_udp_send(const char *host, uint16_t port,
                         const wsjtx_packet_t *packet,
                         char *detail, size_t detail_size)
{
    if (!host || !host[0] || port == 0 || !packet || packet->failed || packet->length == 0) {
        if (detail && detail_size) snprintf(detail, detail_size, "invalid WSJT-X UDP target or packet");
        return ESP_ERR_INVALID_ARG;
    }
    esp_err_t initialized = wsjtx_udp_init();
    if (initialized != ESP_OK) return initialized;
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(3000)) != pdTRUE) return ESP_ERR_TIMEOUT;
    esp_err_t result = open_socket_locked(host, port);
    if (result == ESP_OK) {
        ssize_t sent = sendto(s_socket, packet->data, packet->length, 0,
                              (const struct sockaddr *)&s_target, s_target_length);
        if (sent != (ssize_t)packet->length) {
            int send_errno = errno;
            close_socket_locked();
            result = ESP_FAIL;
            if (detail && detail_size) snprintf(detail, detail_size, "WSJT-X UDP send failed: errno %d", send_errno);
        } else {
            s_sent_packets++;
            if (detail && detail_size) {
                snprintf(detail, detail_size, "WSJT-X UDP packet %u sent to %s:%u",
                         (unsigned)s_sent_packets, host, (unsigned)port);
            }
        }
    } else if (detail && detail_size) {
        snprintf(detail, detail_size, "WSJT-X UDP address or socket setup failed");
    }
    xSemaphoreGive(s_mutex);
    return result;
}

bool wsjtx_udp_pop_command(wsjtx_command_t *out)
{
    return out && s_commands && xQueueReceive(s_commands, out, 0) == pdTRUE;
}

void wsjtx_udp_get_stats(wsjtx_udp_stats_t *out)
{
    if (!out) return;
    memset(out, 0, sizeof(*out));
    if (!s_mutex || xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) != pdTRUE) return;
    out->socket_open = s_socket >= 0;
    snprintf(out->host, sizeof(out->host), "%s", s_host);
    out->port = s_port;
    out->sent_packets = s_sent_packets;
    out->received_packets = s_received_packets;
    out->dropped_commands = s_dropped_commands;
    out->peer_schema = s_peer_schema;
    xSemaphoreGive(s_mutex);
}
