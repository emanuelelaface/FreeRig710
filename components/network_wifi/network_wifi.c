#include "network_wifi.h"

#include <stdio.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "network_eth.h"

static const char *TAG = "network_wifi";

static SemaphoreHandle_t s_status_mutex;
static SemaphoreHandle_t s_scan_mutex;
static esp_netif_t *s_wifi_netif;
static network_wifi_status_t s_status;

static void status_lock(void)
{
    if (s_status_mutex != NULL) xSemaphoreTake(s_status_mutex, portMAX_DELAY);
}

static void status_unlock(void)
{
    if (s_status_mutex != NULL) xSemaphoreGive(s_status_mutex);
}

static void set_last_error(esp_err_t err)
{
    status_lock();
    s_status.last_error = err;
    status_unlock();
}

static void ssid_copy(char *dst, size_t dst_size, const uint8_t *src, size_t src_size)
{
    if (!dst || dst_size == 0) return;
    dst[0] = '\0';
    if (!src || src_size == 0) return;
    size_t n = 0;
    while (n < src_size && src[n] != '\0') n++;
    if (n >= dst_size) n = dst_size - 1;
    memcpy(dst, src, n);
    dst[n] = '\0';
}

static const char *authmode_name(int authmode)
{
    switch (authmode) {
        case WIFI_AUTH_OPEN: return "OPEN";
        case WIFI_AUTH_OWE: return "OWE";
        case WIFI_AUTH_WEP: return "WEP";
        case WIFI_AUTH_WPA_PSK: return "WPA";
        case WIFI_AUTH_WPA2_PSK: return "WPA2";
        case WIFI_AUTH_WPA_WPA2_PSK: return "WPA/WPA2";
        case WIFI_AUTH_ENTERPRISE: return "ENTERPRISE";
        case WIFI_AUTH_WPA3_PSK: return "WPA3";
        case WIFI_AUTH_WPA2_WPA3_PSK: return "WPA2/WPA3";
        case WIFI_AUTH_WPA3_ENTERPRISE: return "WPA3-ENT";
        case WIFI_AUTH_WPA2_WPA3_ENTERPRISE: return "WPA2/WPA3-ENT";
        case WIFI_AUTH_WPA3_ENT_192: return "WPA3-ENT-192";
        default: return "UNKNOWN";
    }
}

static void update_ap_info_locked(void)
{
    wifi_ap_record_t ap = {0};
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
        s_status.rssi = ap.rssi;
        s_status.channel = ap.primary;
    }
}

static void wifi_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    (void)arg;
    (void)event_base;

    if (event_id == WIFI_EVENT_STA_START) {
        status_lock();
        s_status.started = true;
        const bool should_connect = s_status.enabled && s_status.configured;
        if (should_connect) {
            s_status.connecting = true;
            s_status.connect_attempts++;
        }
        status_unlock();
        if (should_connect) (void)esp_wifi_connect();
        return;
    }

    if (event_id == WIFI_EVENT_STA_CONNECTED) {
        status_lock();
        s_status.connected = true;
        s_status.connecting = false;
        s_status.last_error = ESP_OK;
        update_ap_info_locked();
        status_unlock();
        ESP_LOGI(TAG, "Wi-Fi associated");
        return;
    }

    if (event_id == WIFI_EVENT_STA_DISCONNECTED) {
        const wifi_event_sta_disconnected_t *event = (const wifi_event_sta_disconnected_t *)event_data;
        status_lock();
        s_status.connected = false;
        s_status.got_ip = false;
        s_status.connecting = s_status.enabled && s_status.configured;
        s_status.ip_address[0] = '\0';
        s_status.netmask[0] = '\0';
        s_status.gateway[0] = '\0';
        s_status.disconnects++;
        s_status.last_disconnect_reason = event ? event->reason : 0;
        const bool should_reconnect = s_status.enabled && s_status.configured;
        if (should_reconnect) s_status.connect_attempts++;
        status_unlock();
        ESP_LOGW(TAG, "Wi-Fi disconnected: reason=%d", event ? event->reason : 0);
        if (should_reconnect) (void)esp_wifi_connect();
    }
}

static void ip_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    (void)arg;
    (void)event_base;
    if (event_id != IP_EVENT_STA_GOT_IP) return;

    const ip_event_got_ip_t *event = (const ip_event_got_ip_t *)event_data;
    const esp_netif_ip_info_t *ip_info = &event->ip_info;
    status_lock();
    s_status.got_ip = true;
    s_status.connected = true;
    s_status.connecting = false;
    snprintf(s_status.ip_address, sizeof(s_status.ip_address), IPSTR, IP2STR(&ip_info->ip));
    snprintf(s_status.netmask, sizeof(s_status.netmask), IPSTR, IP2STR(&ip_info->netmask));
    snprintf(s_status.gateway, sizeof(s_status.gateway), IPSTR, IP2STR(&ip_info->gw));
    update_ap_info_locked();
    status_unlock();
    ESP_LOGI(TAG, "Wi-Fi DHCP address: " IPSTR, IP2STR(&ip_info->ip));
    network_eth_start_time_sync();
}

esp_err_t network_wifi_start(void)
{
    if (s_status_mutex == NULL) {
        s_status_mutex = xSemaphoreCreateMutex();
        if (s_status_mutex == NULL) return ESP_ERR_NO_MEM;
    }
    if (s_scan_mutex == NULL) {
        s_scan_mutex = xSemaphoreCreateMutex();
        if (s_scan_mutex == NULL) return ESP_ERR_NO_MEM;
    }

    status_lock();
    const bool already_initialized = s_status.initialized;
    status_unlock();
    if (already_initialized) return ESP_OK;

    esp_err_t err = esp_netif_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        set_last_error(err);
        return err;
    }

    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        set_last_error(err);
        return err;
    }

    s_wifi_netif = esp_netif_create_default_wifi_sta();
    if (s_wifi_netif == NULL) {
        set_last_error(ESP_ERR_NO_MEM);
        return ESP_ERR_NO_MEM;
    }

    err = esp_netif_set_hostname(s_wifi_netif, "ft710");
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Could not set Wi-Fi hostname ft710: %s", esp_err_to_name(err));
    }

    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    err = esp_wifi_init(&init);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        set_last_error(err);
        return err;
    }

    err = esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        set_last_error(err);
        return err;
    }
    err = esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &ip_event_handler, NULL);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        set_last_error(err);
        return err;
    }

    (void)esp_wifi_set_storage(WIFI_STORAGE_RAM);
    err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (err != ESP_OK) {
        set_last_error(err);
        return err;
    }
    err = esp_wifi_start();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        set_last_error(err);
        return err;
    }

    uint8_t mac[6] = {0};
    if (esp_wifi_get_mac(WIFI_IF_STA, mac) == ESP_OK) {
        status_lock();
        memcpy(s_status.mac, mac, sizeof(mac));
        status_unlock();
    }

    status_lock();
    s_status.initialized = true;
    s_status.started = true;
    s_status.last_error = ESP_OK;
    status_unlock();

    ESP_LOGI(TAG, "Wi-Fi STA initialized via ESP-Hosted co-processor");
    return network_wifi_apply_config();
}

esp_err_t network_wifi_apply_config(void)
{
    status_lock();
    const bool initialized = s_status.initialized;
    status_unlock();
    if (!initialized) return network_wifi_start();

    freerig_wifi_config_t cfg;
    esp_err_t err = freerig_config_get_wifi(&cfg);
    if (err != ESP_OK) {
        set_last_error(err);
        return err;
    }

    status_lock();
    s_status.enabled = cfg.enabled;
    s_status.configured = cfg.ssid_set;
    snprintf(s_status.ssid, sizeof(s_status.ssid), "%s", cfg.ssid);
    status_unlock();

    if (!cfg.enabled || !cfg.ssid_set) {
        (void)esp_wifi_disconnect();
        status_lock();
        s_status.connecting = false;
        s_status.connected = false;
        s_status.got_ip = false;
        s_status.ip_address[0] = '\0';
        s_status.netmask[0] = '\0';
        s_status.gateway[0] = '\0';
        s_status.last_error = ESP_OK;
        status_unlock();
        ESP_LOGI(TAG, "Wi-Fi disabled or not configured");
        return ESP_OK;
    }

    wifi_config_t wifi_cfg = {0};
    const size_t ssid_len = strlen(cfg.ssid);
    memcpy(wifi_cfg.sta.ssid, cfg.ssid, ssid_len > sizeof(wifi_cfg.sta.ssid) ? sizeof(wifi_cfg.sta.ssid) : ssid_len);
    const size_t pass_len = strlen(cfg.password);
    memcpy(wifi_cfg.sta.password, cfg.password, pass_len > sizeof(wifi_cfg.sta.password) ? sizeof(wifi_cfg.sta.password) : pass_len);
    wifi_cfg.sta.threshold.authmode = pass_len ? WIFI_AUTH_WPA_PSK : WIFI_AUTH_OPEN;
    wifi_cfg.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;

    err = esp_wifi_set_config(WIFI_IF_STA, &wifi_cfg);
    if (err != ESP_OK) {
        set_last_error(err);
        return err;
    }

    (void)esp_wifi_disconnect();
    status_lock();
    s_status.connecting = true;
    s_status.connected = false;
    s_status.got_ip = false;
    s_status.connect_attempts++;
    s_status.last_error = ESP_OK;
    status_unlock();
    err = esp_wifi_connect();
    if (err != ESP_OK && err != ESP_ERR_WIFI_CONN) {
        set_last_error(err);
        return err;
    }

    ESP_LOGI(TAG, "Wi-Fi connecting to SSID %s", cfg.ssid);
    return ESP_OK;
}

esp_err_t network_wifi_scan(network_wifi_ap_t *out, size_t max_count, size_t *out_count)
{
    if (out_count) *out_count = 0;
    if (out == NULL || max_count == 0) return ESP_ERR_INVALID_ARG;
    esp_err_t err = network_wifi_start();
    if (err != ESP_OK) return err;
    if (xSemaphoreTake(s_scan_mutex, pdMS_TO_TICKS(50)) != pdTRUE) return ESP_ERR_TIMEOUT;

    wifi_scan_config_t scan_cfg = {
        .show_hidden = true,
    };
    err = esp_wifi_scan_start(&scan_cfg, true);
    if (err != ESP_OK) {
        xSemaphoreGive(s_scan_mutex);
        set_last_error(err);
        return err;
    }

    uint16_t ap_count = 0;
    (void)esp_wifi_scan_get_ap_num(&ap_count);
    uint16_t number = ap_count;
    if (number > max_count) number = (uint16_t)max_count;
    wifi_ap_record_t records[NETWORK_WIFI_SCAN_MAX] = {0};
    if (number > NETWORK_WIFI_SCAN_MAX) number = NETWORK_WIFI_SCAN_MAX;
    err = esp_wifi_scan_get_ap_records(&number, records);
    if (err == ESP_OK) {
        for (uint16_t i = 0; i < number; ++i) {
            ssid_copy(out[i].ssid, sizeof(out[i].ssid), records[i].ssid, sizeof(records[i].ssid));
            out[i].rssi = records[i].rssi;
            out[i].channel = records[i].primary;
            out[i].authmode = records[i].authmode;
            snprintf(out[i].authmode_name, sizeof(out[i].authmode_name), "%s", authmode_name(records[i].authmode));
            out[i].secure = records[i].authmode != WIFI_AUTH_OPEN;
        }
        if (out_count) *out_count = number;
    } else {
        set_last_error(err);
    }
    xSemaphoreGive(s_scan_mutex);
    return err;
}

void network_wifi_get_status(network_wifi_status_t *out_status)
{
    if (out_status == NULL) return;
    status_lock();
    *out_status = s_status;
    status_unlock();
}
