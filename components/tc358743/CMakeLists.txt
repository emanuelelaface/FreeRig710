idf_component_register(
    SRCS "tc358743.c" "tc358743_edid.c"
    INCLUDE_DIRS "include"
    REQUIRES board esp_driver_i2c freertos
)
