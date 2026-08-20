idf_component_register(
    SRCS "ft710_usb.c"
    INCLUDE_DIRS "include"
    REQUIRES freertos
    PRIV_REQUIRES esp_hw_support
)
