cmake_minimum_required(VERSION 3.16)

set(IDF_TARGET "esp32p4")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(FreeRig710)

# ESP-IDF 6.0.2's lwIP requires TCP_SNDLOWAT to fit its 16-bit sanity check.
# For larger send buffers, preserve the previous 65534-byte buffer's threshold.
if(CONFIG_LWIP_TCP_SND_BUF_DEFAULT GREATER 65534)
    idf_component_get_property(lwip_lib lwip COMPONENT_LIB)
    target_compile_definitions(${lwip_lib} PUBLIC TCP_SNDLOWAT=32767)
endif()
