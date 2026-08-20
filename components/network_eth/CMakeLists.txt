idf_component_register(
    SRCS "network_eth.c"
    INCLUDE_DIRS "include"
    REQUIRES board esp_eth esp_netif esp_event mdns
)
