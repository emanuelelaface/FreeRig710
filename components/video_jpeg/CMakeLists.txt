idf_component_register(
    SRCS "video_jpeg.c"
    INCLUDE_DIRS "include"
    REQUIRES video_capture esp_driver_jpeg freertos esp_timer heap
)
