idf_component_register(
    SRCS "network_wifi.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_wifi esp_netif esp_event freertos freerig_config network_eth
)
