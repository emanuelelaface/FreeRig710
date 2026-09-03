#include "network_eth.h"

#include <stdio.h>
#include <string.h>

#include "freerig_board.h"
#include "esp_eth.h"
#include "esp_eth_mac.h"
#include "esp_eth_mac_esp.h"
#include "esp_eth_phy.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "mdns.h"

static const char *TAG = "network_eth";

static esp_eth_handle_t s_eth_handle;
static esp_netif_t *s_eth_netif;
static SemaphoreHandle_t s_status_mutex;
static network_eth_status_t s_status;

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

static void set_last_error(esp_err_t err)
{
    status_lock();
    s_status.last_error = err;
    status_unlock();
}

static void eth_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    (void)arg;
    (void)event_base;
    (void)event_data;

    status_lock();
    switch (event_id) {
        case ETHERNET_EVENT_CONNECTED:
            s_status.link_up = true;
            ESP_LOGI(TAG, "Ethernet link up");
            break;
        case ETHERNET_EVENT_DISCONNECTED:
            s_status.link_up = false;
            s_status.got_ip = false;
            s_status.ip_address[0] = '\0';
            s_status.netmask[0] = '\0';
            s_status.gateway[0] = '\0';
            ESP_LOGW(TAG, "Ethernet link down");
            break;
        case ETHERNET_EVENT_START:
            ESP_LOGI(TAG, "Ethernet driver started");
            break;
        case ETHERNET_EVENT_STOP:
            s_status.link_up = false;
            s_status.got_ip = false;
            ESP_LOGW(TAG, "Ethernet driver stopped");
            break;
        default:
            break;
    }
    status_unlock();
}


static void sntp_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    (void)arg;
    (void)event_base;
    (void)event_id;

    const esp_netif_sntp_time_sync_t *event = (const esp_netif_sntp_time_sync_t *)event_data;
    status_lock();
    s_status.time_synced = true;
    s_status.time_sync_count++;
    if (event != NULL) {
        s_status.time_last_sync_unix_ms = (uint64_t)event->tv.tv_sec * 1000ULL +
                                          (uint64_t)event->tv.tv_usec / 1000ULL;
    }
    status_unlock();

    if (event != NULL) {
        ESP_LOGI(TAG, "SNTP time synchronized: %lld.%03ld UTC",
                 (long long)event->tv.tv_sec, (long)(event->tv.tv_usec / 1000));
    } else {
        ESP_LOGI(TAG, "SNTP time synchronized");
    }
}

void network_eth_start_time_sync(void)
{
    bool should_start_sntp = false;
    status_lock();
    if (s_status.time_sync_initialized && !s_status.time_sync_started) {
        s_status.time_sync_started = true;
        should_start_sntp = true;
    }
    status_unlock();

    if (!should_start_sntp) return;

    esp_err_t sntp_err = esp_netif_sntp_start();
    if (sntp_err != ESP_OK) {
        status_lock();
        s_status.time_sync_started = false;
        status_unlock();
        ESP_LOGW(TAG, "Could not start SNTP after network IP: %s", esp_err_to_name(sntp_err));
    } else {
        ESP_LOGI(TAG, "SNTP started for FT8 UTC timing cross-check (pool.ntp.org)");
    }
}

static void got_ip_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    (void)arg;
    (void)event_base;
    (void)event_id;

    const ip_event_got_ip_t *event = (const ip_event_got_ip_t *)event_data;
    const esp_netif_ip_info_t *ip_info = &event->ip_info;

    status_lock();
    s_status.got_ip = true;
    snprintf(s_status.ip_address, sizeof(s_status.ip_address), IPSTR, IP2STR(&ip_info->ip));
    snprintf(s_status.netmask, sizeof(s_status.netmask), IPSTR, IP2STR(&ip_info->netmask));
    snprintf(s_status.gateway, sizeof(s_status.gateway), IPSTR, IP2STR(&ip_info->gw));
    ESP_LOGI(TAG, "DHCP address: %s", s_status.ip_address);
    status_unlock();

    network_eth_start_time_sync();
}

esp_err_t network_eth_start(void)
{
    memset(&s_status, 0, sizeof(s_status));
    s_status.last_error = ESP_OK;

    s_status_mutex = xSemaphoreCreateMutex();
    if (s_status_mutex == NULL) {
        return ESP_ERR_NO_MEM;
    }

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

    err = esp_event_handler_register(
        NETIF_SNTP_EVENT, NETIF_SNTP_TIME_SYNC, &sntp_event_handler, NULL);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Could not register SNTP sync event handler: %s", esp_err_to_name(err));
    }

    esp_sntp_config_t sntp_config = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    sntp_config.start = false;
    err = esp_netif_sntp_init(&sntp_config);
    if (err == ESP_OK) {
        status_lock();
        s_status.time_sync_initialized = true;
        status_unlock();
    } else {
        ESP_LOGW(TAG, "SNTP initialization unavailable: %s; browser clock remains FT8 timing source",
                 esp_err_to_name(err));
    }

    eth_esp32_emac_config_t emac_config = ETH_ESP32_EMAC_DEFAULT_CONFIG();
    emac_config.smi_gpio.mdc_num = FREERIG_ETH_MDC_GPIO;
    emac_config.smi_gpio.mdio_num = FREERIG_ETH_MDIO_GPIO;

    eth_mac_config_t mac_config = ETH_MAC_DEFAULT_CONFIG();
    esp_eth_mac_t *mac = esp_eth_mac_new_esp32(&emac_config, &mac_config);
    if (mac == NULL) {
        set_last_error(ESP_FAIL);
        return ESP_FAIL;
    }

    eth_phy_config_t phy_config = ETH_PHY_DEFAULT_CONFIG();
    phy_config.phy_addr = FREERIG_ETH_PHY_ADDRESS;
    phy_config.reset_gpio_num = FREERIG_ETH_PHY_RESET_GPIO;

    /*
     * ESP-IDF 6.x keeps vendor-specific PHY drivers outside the core.
     * The onboard IP101 is IEEE 802.3 compliant, so the generic PHY is
     * sufficient for this deterministic bring-up milestone.
     */
    esp_eth_phy_t *phy = esp_eth_phy_new_generic(&phy_config);
    if (phy == NULL) {
        mac->del(mac);
        set_last_error(ESP_FAIL);
        return ESP_FAIL;
    }

    esp_eth_config_t eth_config = ETH_DEFAULT_CONFIG(mac, phy);
    err = esp_eth_driver_install(&eth_config, &s_eth_handle);
    if (err != ESP_OK) {
        phy->del(phy);
        mac->del(mac);
        set_last_error(err);
        return err;
    }

    esp_netif_config_t netif_config = ESP_NETIF_DEFAULT_ETH();
    s_eth_netif = esp_netif_new(&netif_config);
    if (s_eth_netif == NULL) {
        set_last_error(ESP_ERR_NO_MEM);
        return ESP_ERR_NO_MEM;
    }

    err = esp_netif_set_hostname(s_eth_netif, "ft710");
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Could not set Ethernet hostname ft710: %s", esp_err_to_name(err));
    }

    esp_eth_netif_glue_handle_t glue = esp_eth_new_netif_glue(s_eth_handle);
    if (glue == NULL) {
        set_last_error(ESP_ERR_NO_MEM);
        return ESP_ERR_NO_MEM;
    }

    err = esp_netif_attach(s_eth_netif, glue);
    if (err != ESP_OK) {
        set_last_error(err);
        return err;
    }

    err = esp_event_handler_register(
        ETH_EVENT, ESP_EVENT_ANY_ID, &eth_event_handler, NULL);
    if (err != ESP_OK) {
        set_last_error(err);
        return err;
    }

    err = esp_event_handler_register(
        IP_EVENT, IP_EVENT_ETH_GOT_IP, &got_ip_event_handler, NULL);
    if (err != ESP_OK) {
        set_last_error(err);
        return err;
    }

    uint8_t mac_addr[6] = {0};
    err = esp_eth_ioctl(s_eth_handle, ETH_CMD_G_MAC_ADDR, mac_addr);
    if (err == ESP_OK) {
        status_lock();
        memcpy(s_status.mac, mac_addr, sizeof(mac_addr));
        status_unlock();
    } else {
        ESP_LOGW(TAG, "Could not read Ethernet MAC address: %s", esp_err_to_name(err));
    }

    err = mdns_init();
    if (err == ESP_OK) {
        (void)mdns_hostname_set("ft710");
        (void)mdns_instance_name_set("FreeRig710 FT-710");
        mdns_txt_item_t txt[] = {
            {"radio", "Yaesu FT-710"},
            {"api", "v1"},
        };
        (void)mdns_service_add(NULL, "_http", "_tcp", 80, txt, 2);
        (void)mdns_service_add(NULL, "_freerig710", "_tcp", 80, txt, 2);
        ESP_LOGI(TAG, "mDNS ready: ft710.local (_http._tcp + _freerig710._tcp)");
    } else {
        ESP_LOGW(TAG, "mDNS initialization failed: %s", esp_err_to_name(err));
    }

    err = esp_eth_start(s_eth_handle);
    if (err != ESP_OK) {
        set_last_error(err);
        return err;
    }

    status_lock();
    s_status.initialized = true;
    s_status.last_error = ESP_OK;
    status_unlock();

    ESP_LOGI(TAG, "Ethernet initialized: MDC=%d MDIO=%d PHY_RST=%d PHY_ADDR=%d",
             FREERIG_ETH_MDC_GPIO,
             FREERIG_ETH_MDIO_GPIO,
             FREERIG_ETH_PHY_RESET_GPIO,
             FREERIG_ETH_PHY_ADDRESS);

    return ESP_OK;
}

void network_eth_get_status(network_eth_status_t *out_status)
{
    if (out_status == NULL) {
        return;
    }

    status_lock();
    *out_status = s_status;
    status_unlock();
}
