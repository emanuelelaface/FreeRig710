idf_component_register(
    SRCS "freerig_wireguard.c"
    INCLUDE_DIRS "include"
    REQUIRES freerig_config network_eth network_wifi lwip esp_timer freertos
)
