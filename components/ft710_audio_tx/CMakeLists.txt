idf_component_register(
    SRCS "ft710_audio_tx.c"
    INCLUDE_DIRS "include"
    REQUIRES freertos usb esp_timer
)
