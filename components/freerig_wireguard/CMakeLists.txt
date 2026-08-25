idf_component_register(
    SRCS "freerig_wireguard.c"
    INCLUDE_DIRS "include"
    REQUIRES freerig_config network_eth lwip esp_timer freertos
)
