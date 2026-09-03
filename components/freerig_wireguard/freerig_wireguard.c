#include "freerig_wireguard.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "freerig_config.h"
#include "lwip/def.h"
#include "lwip/ip.h"
#include "lwip/mem.h"
#include "lwip/netdb.h"
#include "lwip/netif.h"
#include "lwip/sockets.h"
#include "lwip/tcpip.h"
#include "lwip/udp.h"
#include "network_eth.h"
#include "network_wifi.h"
#include "wireguard.h"
#include "wireguardif.h"

static const char *TAG = "freerig_wireguard";

#define WG_KEY_TEXT_MAX 65
#define WG_ENDPOINT_HOST_MAX 128
#define WG_START_WAIT_NETWORK_MS 60000U
#define WG_START_WAIT_TIME_MS 30000U

typedef struct {
    char private_key[WG_KEY_TEXT_MAX];
    char peer_public_key[WG_KEY_TEXT_MAX];
    uint8_t preshared_key[WIREGUARD_SESSION_KEY_LEN];
    bool has_preshared_key;
    ip_addr_t interface_ip;
    ip_addr_t interface_mask;
    ip_addr_t route_mask;
    ip_addr_t allowed_ip;
    ip_addr_t allowed_mask;
    ip_addr_t endpoint_ip;
    char endpoint_host[WG_ENDPOINT_HOST_MAX];
    uint16_t endpoint_port;
    uint16_t listen_port;
    uint16_t keepalive_s;
} wg_runtime_config_t;

static SemaphoreHandle_t s_mutex;
static struct netif s_netif;
static struct netif *s_netif_ptr;
static uint8_t s_peer_index = WIREGUARDIF_INVALID_INDEX;
static struct wireguardif_init_data s_wg_init;
static wg_runtime_config_t s_runtime;
static bool s_initialized;
static bool s_configured;
static bool s_enable_on_boot;
static bool s_starting;
static bool s_active;
static uint32_t s_starts;
static uint32_t s_stops;
static esp_err_t s_last_error = ESP_OK;
static char s_last_error_text[128] = "disabled";
static TaskHandle_t s_start_task;

static void set_last_status(esp_err_t err, const char *text)
{
    if (s_mutex) xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_last_error = err;
    snprintf(s_last_error_text, sizeof(s_last_error_text), "%s", text ? text : esp_err_to_name(err));
    if (s_mutex) xSemaphoreGive(s_mutex);
}

static char *trim_in_place(char *s)
{
    if (!s) return s;
    while (*s && isspace((unsigned char)*s)) s++;
    char *end = s + strlen(s);
    while (end > s && isspace((unsigned char)end[-1])) {
        end--;
        *end = '\0';
    }
    return s;
}

static void copy_trimmed(char *dst, size_t dst_size, const char *src)
{
    if (!dst || dst_size == 0) return;
    dst[0] = '\0';
    if (!src) return;
    while (*src && isspace((unsigned char)*src)) src++;
    size_t n = strlen(src);
    while (n > 0 && isspace((unsigned char)src[n - 1])) n--;
    if (n >= dst_size) n = dst_size - 1;
    memcpy(dst, src, n);
    dst[n] = '\0';
}

static bool parse_u16(const char *text, uint16_t min, uint16_t max, uint16_t *out)
{
    if (!text || !*text || !out) return false;
    char *end = NULL;
    unsigned long v = strtoul(text, &end, 10);
    while (end && *end && isspace((unsigned char)*end)) end++;
    if (!end || *end || v < min || v > max) return false;
    *out = (uint16_t)v;
    return true;
}

static bool parse_ipv4_literal(const char *text, uint8_t octets[4])
{
    if (!text || !octets) return false;
    const char *p = text;
    for (int i = 0; i < 4; ++i) {
        if (!isdigit((unsigned char)*p)) return false;
        char *end = NULL;
        unsigned long v = strtoul(p, &end, 10);
        if (v > 255 || end == p) return false;
        octets[i] = (uint8_t)v;
        p = end;
        if (i < 3) {
            if (*p != '.') return false;
            p++;
        }
    }
    return *p == '\0';
}

static void set_ip4(ip_addr_t *out, const uint8_t octets[4])
{
    IP_ADDR4(out, octets[0], octets[1], octets[2], octets[3]);
}

static void set_prefix_mask(ip_addr_t *out, uint8_t prefix)
{
    uint32_t mask = prefix == 0 ? 0 : (0xffffffffUL << (32U - prefix));
    uint8_t octets[4] = {
        (uint8_t)((mask >> 24) & 0xff),
        (uint8_t)((mask >> 16) & 0xff),
        (uint8_t)((mask >> 8) & 0xff),
        (uint8_t)(mask & 0xff),
    };
    set_ip4(out, octets);
}

static bool parse_ipv4_cidr_token(const char *token, ip_addr_t *ip, ip_addr_t *mask)
{
    char buf[64];
    copy_trimmed(buf, sizeof(buf), token);
    if (!buf[0]) return false;
    char *slash = strchr(buf, '/');
    uint8_t prefix = 32;
    if (slash) {
        *slash = '\0';
        slash++;
        char *end = NULL;
        unsigned long p = strtoul(slash, &end, 10);
        if (!end || *end || p > 32) return false;
        prefix = (uint8_t)p;
    }
    uint8_t octets[4];
    if (!parse_ipv4_literal(trim_in_place(buf), octets)) return false;
    set_ip4(ip, octets);
    set_prefix_mask(mask, prefix);
    return true;
}

static bool parse_first_ipv4_cidr(const char *value, ip_addr_t *ip, ip_addr_t *mask)
{
    if (!value) return false;
    char buf[256];
    copy_trimmed(buf, sizeof(buf), value);
    char *save = NULL;
    for (char *tok = strtok_r(buf, ",", &save); tok; tok = strtok_r(NULL, ",", &save)) {
        if (parse_ipv4_cidr_token(tok, ip, mask)) return true;
    }
    return false;
}

static bool parse_endpoint(const char *value, char *host, size_t host_size, uint16_t *port)
{
    char buf[WG_ENDPOINT_HOST_MAX + 16];
    copy_trimmed(buf, sizeof(buf), value);
    if (!buf[0]) return false;
    if (buf[0] == '[') return false;
    char *colon = strrchr(buf, ':');
    if (!colon || strchr(buf, ':') != colon) return false;
    *colon = '\0';
    colon++;
    char *h = trim_in_place(buf);
    char *p = trim_in_place(colon);
    if (!h[0] || !parse_u16(p, 1, 65535, port)) return false;
    snprintf(host, host_size, "%s", h);
    return true;
}

static bool resolve_endpoint_ip(const char *host, ip_addr_t *out)
{
    uint8_t octets[4];
    if (parse_ipv4_literal(host, octets)) {
        set_ip4(out, octets);
        return true;
    }

    struct addrinfo hints = {
        .ai_family = AF_INET,
        .ai_socktype = SOCK_DGRAM,
    };
    struct addrinfo *res = NULL;
    int rc = getaddrinfo(host, NULL, &hints, &res);
    if (rc != 0 || !res) return false;
    const struct sockaddr_in *sin = (const struct sockaddr_in *)res->ai_addr;
    uint32_t addr = lwip_ntohl(sin->sin_addr.s_addr);
    octets[0] = (uint8_t)((addr >> 24) & 0xff);
    octets[1] = (uint8_t)((addr >> 16) & 0xff);
    octets[2] = (uint8_t)((addr >> 8) & 0xff);
    octets[3] = (uint8_t)(addr & 0xff);
    set_ip4(out, octets);
    freeaddrinfo(res);
    return true;
}

static bool decode_preshared_key(const char *text, uint8_t out[WIREGUARD_SESSION_KEY_LEN])
{
    size_t out_len = WIREGUARD_SESSION_KEY_LEN;
    return wireguard_base64_decode(text, out, &out_len) && out_len == WIREGUARD_SESSION_KEY_LEN;
}

static bool copy_key_text(char *dst, size_t dst_size, const char *value)
{
    copy_trimmed(dst, dst_size, value);
    size_t n = strlen(dst);
    return n >= 40 && n < dst_size;
}

static esp_err_t parse_wireguard_config(const char *text, wg_runtime_config_t *out, char *err, size_t err_size)
{
    if (!text || !*text || !out) return ESP_ERR_INVALID_ARG;
    memset(out, 0, sizeof(*out));
    out->listen_port = WIREGUARDIF_DEFAULT_PORT;
    out->keepalive_s = WIREGUARDIF_KEEPALIVE_DEFAULT;

    char *buf = calloc(1, strlen(text) + 1);
    if (!buf) return ESP_ERR_NO_MEM;
    strcpy(buf, text);

    enum { SEC_NONE, SEC_INTERFACE, SEC_PEER } section = SEC_NONE;
    bool have_address = false;
    bool have_allowed = false;
    bool have_endpoint = false;
    bool have_private = false;
    bool have_public = false;
    bool psk_present = false;
    bool psk_valid = true;
    char *save = NULL;
    for (char *line = strtok_r(buf, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
        char *comment = strchr(line, '#');
        if (comment) *comment = '\0';
        char *s = trim_in_place(line);
        if (!*s) continue;
        size_t n = strlen(s);
        if (s[0] == '[' && n > 2 && s[n - 1] == ']') {
            s[n - 1] = '\0';
            char *name = trim_in_place(s + 1);
            if (!strcasecmp(name, "Interface")) section = SEC_INTERFACE;
            else if (!strcasecmp(name, "Peer")) section = SEC_PEER;
            else section = SEC_NONE;
            continue;
        }
        char *eq = strchr(s, '=');
        if (!eq) continue;
        *eq = '\0';
        char *key = trim_in_place(s);
        char *value = trim_in_place(eq + 1);
        if (section == SEC_INTERFACE) {
            if (!strcasecmp(key, "PrivateKey")) have_private = copy_key_text(out->private_key, sizeof(out->private_key), value);
            else if (!strcasecmp(key, "Address")) have_address = parse_first_ipv4_cidr(value, &out->interface_ip, &out->interface_mask);
            else if (!strcasecmp(key, "ListenPort")) (void)parse_u16(value, 1, 65535, &out->listen_port);
        } else if (section == SEC_PEER) {
            if (!strcasecmp(key, "PublicKey")) have_public = copy_key_text(out->peer_public_key, sizeof(out->peer_public_key), value);
            else if (!strcasecmp(key, "PresharedKey")) {
                psk_present = true;
                out->has_preshared_key = decode_preshared_key(value, out->preshared_key);
                psk_valid = out->has_preshared_key;
            }
            else if (!strcasecmp(key, "AllowedIPs")) have_allowed = parse_first_ipv4_cidr(value, &out->allowed_ip, &out->allowed_mask);
            else if (!strcasecmp(key, "Endpoint")) have_endpoint = parse_endpoint(value, out->endpoint_host, sizeof(out->endpoint_host), &out->endpoint_port);
            else if (!strcasecmp(key, "PersistentKeepalive")) (void)parse_u16(value, 0, 65535, &out->keepalive_s);
        }
    }
    free(buf);

    const char *missing = NULL;
    if (!have_private) missing = "PrivateKey";
    else if (!have_address) missing = "Address";
    else if (!have_public) missing = "Peer PublicKey";
    else if (!have_allowed) missing = "AllowedIPs IPv4";
    else if (!have_endpoint) missing = "Endpoint host:port";
    else if (psk_present && !psk_valid) missing = "PresharedKey";
    if (missing) {
        snprintf(err, err_size, "WireGuard config missing or invalid: %s", missing);
        return ESP_ERR_INVALID_ARG;
    }
    if (!resolve_endpoint_ip(out->endpoint_host, &out->endpoint_ip)) {
        snprintf(err, err_size, "WireGuard endpoint DNS failed: %s", out->endpoint_host);
        return ESP_ERR_NOT_FOUND;
    }
    return ESP_OK;
}

static void ip_to_text(const ip_addr_t *ip, char *out, size_t out_size)
{
    if (!out || out_size == 0) return;
    out[0] = '\0';
    if (!ip) return;
    (void)ipaddr_ntoa_r(ip, out, (int)out_size);
}

static int ipv4_prefix_len(const ip_addr_t *mask)
{
    uint32_t m = lwip_ntohl(ip_2_ip4(mask)->addr);
    int bits = 0;
    while (m & 0x80000000U) {
        bits++;
        m <<= 1;
    }
    return bits;
}

static bool ipv4_net_contains(const ip_addr_t *network, const ip_addr_t *mask, const ip_addr_t *ip)
{
    return ip4_addr_net_eq(ip_2_ip4(ip), ip_2_ip4(network), ip_2_ip4(mask));
}

static void choose_lwip_route(const wg_runtime_config_t *config, ip_addr_t *netmask, ip_addr_t *gateway)
{
    *netmask = config->interface_mask;
    ip_addr_set_any(0, gateway);

    const int interface_prefix = ipv4_prefix_len(&config->interface_mask);
    const int allowed_prefix = ipv4_prefix_len(&config->allowed_mask);

    if (allowed_prefix > 0 && allowed_prefix < interface_prefix &&
        ipv4_net_contains(&config->allowed_ip, &config->allowed_mask, &config->interface_ip)) {
        *netmask = config->allowed_mask;
    }

    if (allowed_prefix == 32) {
        *gateway = config->allowed_ip;
    }
}

static esp_err_t stop_core_locked(void)
{
    if (!s_netif_ptr) return ESP_OK;
    wireguardif_shutdown(s_netif_ptr);
    netif_set_down(s_netif_ptr);
    netif_set_link_down(s_netif_ptr);
    struct wireguard_device *device = (struct wireguard_device *)s_netif_ptr->state;
    if (device) {
        if (device->udp_pcb) {
            udp_remove(device->udp_pcb);
            device->udp_pcb = NULL;
        }
        mem_free(device);
        s_netif_ptr->state = NULL;
    }
    netif_remove(s_netif_ptr);
    memset(&s_netif, 0, sizeof(s_netif));
    s_netif_ptr = NULL;
    s_peer_index = WIREGUARDIF_INVALID_INDEX;
    memset(&s_runtime, 0, sizeof(s_runtime));
    s_active = false;
    s_stops++;
    return ESP_OK;
}

typedef struct {
    wg_runtime_config_t config;
    bool has_config;
    esp_err_t result;
} wg_tcpip_op_t;

static void start_core_cb(void *arg)
{
    wg_tcpip_op_t *op = (wg_tcpip_op_t *)arg;
    op->result = stop_core_locked();
    if (op->result != ESP_OK) return;
    if (!op->has_config) {
        op->result = ESP_ERR_INVALID_ARG;
        return;
    }

    s_runtime = op->config;
    s_wg_init.private_key = s_runtime.private_key;
    s_wg_init.listen_port = s_runtime.listen_port;
    s_wg_init.bind_netif = NULL;

    ip_addr_t gateway;
    choose_lwip_route(&s_runtime, &s_runtime.route_mask, &gateway);
    s_netif_ptr = netif_add(&s_netif,
                            ip_2_ip4(&s_runtime.interface_ip),
                            ip_2_ip4(&s_runtime.route_mask),
                            ip_2_ip4(&gateway),
                            &s_wg_init,
                            wireguardif_init,
                            ip_input);
    if (!s_netif_ptr) {
        op->result = ESP_FAIL;
        return;
    }
    netif_set_up(s_netif_ptr);

    struct wireguardif_peer peer;
    wireguardif_peer_init(&peer);
    peer.public_key = s_runtime.peer_public_key;
    peer.preshared_key = s_runtime.has_preshared_key ? s_runtime.preshared_key : NULL;
    peer.allowed_ip = s_runtime.allowed_ip;
    peer.allowed_mask = s_runtime.allowed_mask;
    peer.endpoint_ip = s_runtime.endpoint_ip;
    peer.endport_port = s_runtime.endpoint_port;
    peer.keep_alive = s_runtime.keepalive_s;
    err_t err = wireguardif_add_peer(s_netif_ptr, &peer, &s_peer_index);
    if (err != ERR_OK || s_peer_index == WIREGUARDIF_INVALID_INDEX) {
        (void)stop_core_locked();
        op->result = ESP_FAIL;
        return;
    }
    err = wireguardif_connect(s_netif_ptr, s_peer_index);
    if (err != ERR_OK) {
        (void)stop_core_locked();
        op->result = ESP_FAIL;
        return;
    }
    s_active = true;
    s_starts++;
    op->result = ESP_OK;
}

static void stop_core_cb(void *arg)
{
    wg_tcpip_op_t *op = (wg_tcpip_op_t *)arg;
    op->result = stop_core_locked();
}

static esp_err_t start_runtime(const wg_runtime_config_t *config)
{
    if (!config) return ESP_ERR_INVALID_ARG;
    wg_tcpip_op_t op = {
        .config = *config,
        .has_config = true,
        .result = ESP_FAIL,
    };
    err_t err = tcpip_callback_with_block(start_core_cb, &op, 1);
    if (err != ERR_OK) return ESP_FAIL;
    return op.result;
}

esp_err_t freerig_wireguard_stop(void)
{
    wg_tcpip_op_t op = {.result = ESP_FAIL};
    err_t err = tcpip_callback_with_block(stop_core_cb, &op, 1);
    if (err != ERR_OK) return ESP_FAIL;
    if (op.result == ESP_OK) set_last_status(ESP_OK, "WireGuard stopped");
    return op.result;
}

static bool wait_for_network_ready(void)
{
    uint32_t waited = 0;
    while (waited < WG_START_WAIT_NETWORK_MS) {
        network_eth_status_t st;
        network_eth_get_status(&st);
        if (st.got_ip) return true;
        network_wifi_status_t wifi;
        network_wifi_get_status(&wifi);
        if (wifi.got_ip) return true;
        vTaskDelay(pdMS_TO_TICKS(500));
        waited += 500;
    }
    return false;
}

static bool wait_for_time_sync(void)
{
    uint32_t waited = 0;
    while (waited < WG_START_WAIT_TIME_MS) {
        network_eth_status_t st;
        network_eth_get_status(&st);
        if (st.time_synced) return true;
        vTaskDelay(pdMS_TO_TICKS(500));
        waited += 500;
    }
    return false;
}

static void start_saved_task(void *arg)
{
    (void)arg;
    freerig_wireguard_config_t *cfg = calloc(1, sizeof(*cfg));
    if (!cfg) {
        set_last_status(ESP_ERR_NO_MEM, "WireGuard config allocation failed");
        goto done_no_cfg;
    }
    esp_err_t err = freerig_config_get_wireguard(cfg);
    if (s_mutex) xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_starting = true;
    if (err == ESP_OK) {
        s_configured = cfg->config_set;
        s_enable_on_boot = cfg->enable_on_boot;
    }
    if (s_mutex) xSemaphoreGive(s_mutex);
    if (err != ESP_OK) {
        set_last_status(err, "WireGuard NVS read failed");
        goto done;
    }
    if (!cfg->config_set || !cfg->enable_on_boot) {
        (void)freerig_wireguard_stop();
        set_last_status(ESP_OK, cfg->config_set ? "WireGuard disabled" : "WireGuard config is empty");
        goto done;
    }
    if (!wait_for_network_ready()) {
        set_last_status(ESP_ERR_TIMEOUT, "WireGuard waiting for network IP timed out");
        goto done;
    }
    if (!wait_for_time_sync()) {
        ESP_LOGW(TAG, "SNTP time is not synchronized; starting WireGuard anyway");
    }

    wg_runtime_config_t runtime;
    char parse_error[128] = "";
    err = parse_wireguard_config(cfg->config_text, &runtime, parse_error, sizeof(parse_error));
    if (err != ESP_OK) {
        set_last_status(err, parse_error[0] ? parse_error : "WireGuard config parse failed");
        goto done;
    }
    err = start_runtime(&runtime);
    if (err != ESP_OK) {
        set_last_status(err, "WireGuard netif start failed");
        goto done;
    }
    char ip[16], peer[16];
    ip_to_text(&runtime.interface_ip, ip, sizeof(ip));
    ip_to_text(&runtime.endpoint_ip, peer, sizeof(peer));
    ESP_LOGI(TAG, "WireGuard started: %s -> %s:%u", ip, peer, runtime.endpoint_port);
    set_last_status(ESP_OK, "WireGuard started");

done:
    free(cfg);
done_no_cfg:
    if (s_mutex) xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_starting = false;
    s_start_task = NULL;
    if (s_mutex) xSemaphoreGive(s_mutex);
    vTaskDelete(NULL);
}

esp_err_t freerig_wireguard_init(void)
{
    if (s_initialized) return ESP_OK;
    s_mutex = xSemaphoreCreateMutex();
    if (!s_mutex) return ESP_ERR_NO_MEM;
    freerig_wireguard_config_t *cfg = calloc(1, sizeof(*cfg));
    if (!cfg) return ESP_ERR_NO_MEM;
    esp_err_t err = freerig_config_get_wireguard(cfg);
    if (err == ESP_OK) {
        s_configured = cfg->config_set;
        s_enable_on_boot = cfg->enable_on_boot;
    }
    free(cfg);
    s_initialized = true;
    return err;
}

esp_err_t freerig_wireguard_apply_saved_config_async(void)
{
    esp_err_t err = freerig_wireguard_init();
    if (err != ESP_OK) return err;
    if (s_mutex) xSemaphoreTake(s_mutex, portMAX_DELAY);
    bool already = s_start_task != NULL;
    if (s_mutex) xSemaphoreGive(s_mutex);
    if (already) return ESP_OK;
    if (xTaskCreate(start_saved_task, "wg_start", 8192, NULL, 3, &s_start_task) != pdPASS) {
        if (s_mutex) xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_start_task = NULL;
        if (s_mutex) xSemaphoreGive(s_mutex);
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

esp_err_t freerig_wireguard_apply_boot_config(void)
{
    freerig_wireguard_config_t *cfg = calloc(1, sizeof(*cfg));
    if (!cfg) return ESP_ERR_NO_MEM;
    esp_err_t err = freerig_config_get_wireguard(cfg);
    if (err != ESP_OK) {
        free(cfg);
        return err;
    }
    bool should_start = cfg->config_set && cfg->enable_on_boot;
    free(cfg);
    if (!should_start) return ESP_OK;
    return freerig_wireguard_apply_saved_config_async();
}

static void peer_status_core_cb(void *arg)
{
    bool *up = (bool *)arg;
    *up = false;
    if (!s_netif_ptr || s_peer_index == WIREGUARDIF_INVALID_INDEX) return;
    ip_addr_t ip;
    u16_t port = 0;
    *up = wireguardif_peer_is_up(s_netif_ptr, s_peer_index, &ip, &port) == ERR_OK;
}

void freerig_wireguard_get_status(freerig_wireguard_status_t *out)
{
    if (!out) return;
    memset(out, 0, sizeof(*out));
    (void)freerig_wireguard_init();
    freerig_wireguard_config_t *cfg = calloc(1, sizeof(*cfg));
    if (cfg && freerig_config_get_wireguard(cfg) == ESP_OK) {
        if (s_mutex) xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_configured = cfg->config_set;
        s_enable_on_boot = cfg->enable_on_boot;
        if (s_mutex) xSemaphoreGive(s_mutex);
    }
    free(cfg);
    bool peer_up = false;
    if (s_active) {
        (void)tcpip_callback_with_block(peer_status_core_cb, &peer_up, 1);
    }
    if (s_mutex) xSemaphoreTake(s_mutex, portMAX_DELAY);
    out->initialized = s_initialized;
    out->configured = s_configured;
    out->enable_on_boot = s_enable_on_boot;
    out->starting = s_starting;
    out->active = s_active;
    out->peer_up = peer_up;
    out->endpoint_port = s_runtime.endpoint_port;
    out->listen_port = s_runtime.listen_port;
    out->keepalive_s = s_runtime.keepalive_s == WIREGUARDIF_KEEPALIVE_DEFAULT ? 0 : s_runtime.keepalive_s;
    out->starts = s_starts;
    out->stops = s_stops;
    out->last_error = s_last_error;
    snprintf(out->last_error_text, sizeof(out->last_error_text), "%s", s_last_error_text);
    snprintf(out->endpoint_host, sizeof(out->endpoint_host), "%s", s_runtime.endpoint_host);
    ip_to_text(&s_runtime.interface_ip, out->interface_ip, sizeof(out->interface_ip));
    ip_to_text(&s_runtime.route_mask, out->netmask, sizeof(out->netmask));
    ip_to_text(&s_runtime.allowed_ip, out->allowed_ip, sizeof(out->allowed_ip));
    ip_to_text(&s_runtime.allowed_mask, out->allowed_mask, sizeof(out->allowed_mask));
    ip_to_text(&s_runtime.endpoint_ip, out->endpoint_ip, sizeof(out->endpoint_ip));
    if (s_mutex) xSemaphoreGive(s_mutex);
}
