#pragma once

#include "driver/gpio.h"
#include "driver/i2c_types.h"

/* Waveshare ESP32-P4-NANO board wiring used by the official examples. */
#define FREERIG_ETH_MDC_GPIO       GPIO_NUM_31
#define FREERIG_ETH_MDIO_GPIO      GPIO_NUM_52
#define FREERIG_ETH_PHY_RESET_GPIO GPIO_NUM_51
#define FREERIG_ETH_PHY_ADDRESS    1

/* CSI connector I2C bus on the ESP32-P4-NANO. */
#define FREERIG_CSI_I2C_PORT       I2C_NUM_0
#define FREERIG_CSI_I2C_SDA_GPIO   GPIO_NUM_7
#define FREERIG_CSI_I2C_SCL_GPIO   GPIO_NUM_8
#define FREERIG_CSI_I2C_FREQ_HZ    100000

/* Known working Raspberry Pi tc358743 overlay uses a 27 MHz bridge reference clock. */
#define FREERIG_TC358743_REFERENCE_HZ 27000000U
