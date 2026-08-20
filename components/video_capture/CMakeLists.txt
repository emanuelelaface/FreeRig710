idf_component_register(
    SRCS "video_capture.c"
    INCLUDE_DIRS "include"
    REQUIRES tc358743 esp_driver_cam esp_driver_isp esp_hal_cam esp_hw_support esp_mm soc freertos heap esp_timer
)
