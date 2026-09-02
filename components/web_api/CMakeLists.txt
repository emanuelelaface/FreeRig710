idf_component_register(
    SRCS "web_api.c" "control_api.c"
    INCLUDE_DIRS "include"
    REQUIRES board network_eth tc358743 video_capture video_jpeg ft710_usb ft710_cat ft710_audio ft710_audio_tx freerig_config freerig_memories freerig_wireguard esp_http_server esp_http_client mbedtls freertos esp_timer lwip
)
