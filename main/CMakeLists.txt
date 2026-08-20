idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    REQUIRES board network_eth tc358743 video_capture video_jpeg web_api esp_timer ft710_usb ft710_cat ft710_audio ft710_audio_tx freerig_config freerig_memories
)
