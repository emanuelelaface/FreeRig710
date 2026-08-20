#include "tc358743.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "freerig_board.h"
#include "tc358743_edid.h"
#include "driver/i2c_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "tc358743";

/* Register addresses and masks follow the upstream Linux TC358743 driver. */
#define TC358743_REG_CHIPID       0x0000
#define TC358743_MASK_CHIPID      0xFF00
#define TC358743_MASK_REVID       0x00FF

#define TC358743_REG_SYSCTL       0x0002
#define TC358743_MASK_IRRST       0x0800
#define TC358743_MASK_CECRST      0x0400
#define TC358743_MASK_CTXRST      0x0200
#define TC358743_MASK_HDMIRST     0x0100
#define TC358743_MASK_SLEEP       0x0001

#define TC358743_REG_CONFCTL      0x0004
#define TC358743_MASK_AUDCHNUM_2  0x0C00
#define TC358743_MASK_AUDOUTSEL_I2S 0x0010
#define TC358743_MASK_AUTOINDEX   0x0004
#define TC358743_REG_FIFOCTL      0x0006
#define TC358743_LINUX_FIFO_LEVEL 374
#define TC358743_REG_CECHCLK      0x0028
#define TC358743_REG_CECLCLK      0x002A

/* Milestone 5 CSI-2 TX registers, following upstream Linux tc358743_regs.h. */
#define TC358743_REG_PLLCTL0          0x0020
#define TC358743_MASK_PLL_PRD         0xF000
#define TC358743_MASK_PLL_FBD         0x01FF
#define TC358743_REG_PLLCTL1          0x0022
#define TC358743_MASK_PLL_FRS         0x0C00
#define TC358743_MASK_CKEN            0x0010
#define TC358743_MASK_RESETB          0x0002
#define TC358743_MASK_PLL_EN          0x0001
#define TC358743_REG_CLW_CNTRL        0x0140
#define TC358743_REG_D0W_CNTRL        0x0144
#define TC358743_REG_D1W_CNTRL        0x0148
#define TC358743_REG_D2W_CNTRL        0x014C
#define TC358743_REG_D3W_CNTRL        0x0150
#define TC358743_MASK_LANEDISABLE     0x00000001U
#define TC358743_REG_STARTCNTRL       0x0204
#define TC358743_MASK_START           0x00000001U
#define TC358743_REG_LINEINITCNT      0x0210
#define TC358743_REG_LPTXTIMECNT      0x0214
#define TC358743_REG_TCLK_HEADERCNT   0x0218
#define TC358743_REG_TCLK_TRAILCNT    0x021C
#define TC358743_REG_THS_HEADERCNT    0x0220
#define TC358743_REG_TWAKEUP          0x0224
#define TC358743_REG_TCLK_POSTCNT     0x0228
#define TC358743_REG_THS_TRAILCNT     0x022C
#define TC358743_REG_HSTXVREGCNT      0x0230
#define TC358743_REG_HSTXVREGEN       0x0234
#define TC358743_MASK_D1M_HSTXVREGEN  0x0004U
#define TC358743_MASK_D0M_HSTXVREGEN  0x0002U
#define TC358743_MASK_CLM_HSTXVREGEN  0x0001U
#define TC358743_REG_TXOPTIONCNTRL    0x0238
#define TC358743_MASK_CONTCLKMODE     0x00000001U
#define TC358743_MASK_S_WSYNC         0x0400U
#define TC358743_MASK_S_TXACT         0x0200U
#define TC358743_MASK_S_RXACT         0x0100U
#define TC358743_MASK_S_HLT           0x0001U
#define TC358743_REG_CSI_CONTROL      0x040C
#define TC358743_REG_CSI_STATUS       0x0410
#define TC358743_REG_CSI_INT          0x0414
#define TC358743_REG_CSI_INT_ENA      0x0418
#define TC358743_REG_CSI_ERR          0x044C
#define TC358743_REG_CSI_ERR_INTENA   0x0450
#define TC358743_REG_CSI_ERR_HALT     0x0454
#define TC358743_REG_CSI_CONFW        0x0500
#define TC358743_MASK_MODE_SET        0xA0000000U
#define TC358743_MASK_MODE_CLEAR      0xC0000000U
#define TC358743_MASK_ADDRESS_CSI_CONTROL    0x03000000U
#define TC358743_MASK_ADDRESS_CSI_INT_ENA    0x06000000U
#define TC358743_MASK_ADDRESS_CSI_ERR_INTENA 0x14000000U
#define TC358743_MASK_ADDRESS_CSI_ERR_HALT   0x15000000U
#define TC358743_MASK_CSI_MODE        0x00008000U
#define TC358743_MASK_TXHSMD          0x00000080U
#define TC358743_MASK_NOL_2           0x00000002U
#define TC358743_MASK_INTER           0x00000004U
#define TC358743_MASK_INER            0x00000200U
#define TC358743_MASK_WCER            0x00000100U
#define TC358743_MASK_QUNK            0x00000010U
#define TC358743_MASK_TXBRK           0x00000002U
#define TC358743_REG_CSI_START        0x0518
#define TC358743_MASK_STRT            0x00000001U

#define TC358743_CSI_LANES            2U
#define TC358743_CSI_LANE_MBPS        972U
#define TC358743_CSI_PLL_PRD          4U
#define TC358743_CSI_PLL_FBD          144U
#define TC358743_CSI_FIFO_LEVEL       374U
#define TC358743_CSI_LINEINITCNT      0x00001B58U
#define TC358743_CSI_LPTXTIMECNT      0x00000007U
#define TC358743_CSI_TCLK_HEADERCNT   0x00002806U
#define TC358743_CSI_TCLK_TRAILCNT    0x00000000U
#define TC358743_CSI_THS_HEADERCNT    0x00000806U
#define TC358743_CSI_TWAKEUP          0x00004268U
#define TC358743_CSI_TCLK_POSTCNT     0x00000008U
#define TC358743_CSI_THS_TRAILCNT     0x00000005U
#define TC358743_CSI_HSTXVREGCNT      0x00000000U

#define TC358743_REG_HDMI_INT0     0x8500
#define TC358743_REG_HDMI_INT1     0x8501
#define TC358743_REG_SYS_INT       0x8502
#define TC358743_MASK_I_TMDS       0x02
#define TC358743_MASK_I_DDC        0x01
#define TC358743_REG_CLK_INT       0x8503
#define TC358743_MASK_I_IN_DE_CHG  0x20
#define TC358743_MASK_I_IN_HV_CHG  0x10
#define TC358743_MASK_I_PXCLK_CHG  0x04
#define TC358743_MASK_I_PHYCLK_CHG 0x02
#define TC358743_MASK_I_TMDSCLK_CHG 0x01
#define TC358743_REG_MISC_INT      0x850B
#define TC358743_MASK_I_SYNC_CHG   0x02
#define TC358743_REG_SYS_INTM      0x8512
#define TC358743_REG_CLK_INTM      0x8513
#define TC358743_REG_MISC_INTM     0x851B
#define TC358743_REG_SYS_STATUS   0x8520
#define TC358743_MASK_S_SYNC      0x80
#define TC358743_MASK_S_AVMUTE    0x40
#define TC358743_MASK_S_HDMI      0x10
#define TC358743_MASK_S_PHY_SCDT  0x08
#define TC358743_MASK_S_PHY_PLL   0x04
#define TC358743_MASK_S_TMDS      0x02
#define TC358743_MASK_S_DDC5V     0x01

#define TC358743_REG_VI_STATUS1   0x8522
#define TC358743_MASK_INTERLACE   0x01
#define TC358743_REG_PHY_CTL0     0x8531
#define TC358743_MASK_PHY_SYSCLK_IND 0x02
#define TC358743_MASK_PHY_CTL        0x01
#define TC358743_REG_PHY_CTL1     0x8532
#define TC358743_REG_PHY_CTL2     0x8533
#define TC358743_MASK_PHY_AUTO_RSTN 0x07
#define TC358743_REG_PHY_EN       0x8534
#define TC358743_MASK_ENABLE_PHY  0x01
#define TC358743_REG_PHY_RST      0x8535
#define TC358743_MASK_RESET_CTRL  0x01
#define TC358743_REG_PHY_BIAS     0x8536
#define TC358743_REG_PHY_CSQ      0x853F
#define TC358743_REG_SYS_FREQ0    0x8540
#define TC358743_REG_SYS_FREQ1    0x8541
#define TC358743_REG_SYS_CLK      0x8542
#define TC358743_REG_HPD_CTL      0x8544
#define TC358743_MASK_HPD_CTL0    0x10
#define TC358743_MASK_HPD_OUT0    0x01

#define TC358743_REG_DDC_CTL      0x8543
#define TC358743_MASK_DDC_ACK_POL 0x08
#define TC358743_MASK_DDC_ACTION  0x04
#define TC358743_MASK_DDC5V_MODE  0x03
#define TC358743_DDC5V_DELAY_0MS   0x00
#define TC358743_DDC5V_DELAY_100MS 0x02
#define TC358743_REG_ANA_CTL      0x8545
#define TC358743_MASK_APPL_PCSX    0x30
#define TC358743_MASK_APPL_PCSX_NORMAL 0x30
#define TC358743_MASK_ANALOG_ON    0x01
#define TC358743_REG_INIT_END     0x854A
#define TC358743_MASK_INIT_END     0x01
#define TC358743_REG_AVM_CTL      0x8546
#define TC358743_REG_HDMI_DET     0x8552
#define TC358743_MASK_HDMI_DET_V  0x30
#define TC358743_REG_HDCP_MODE    0x8560
#define TC358743_MASK_MANUAL_AUTH 0x02
#define TC358743_REG_DE_WIDTH_H_LO 0x8582
#define TC358743_REG_DE_WIDTH_H_HI 0x8583
#define TC358743_REG_DE_WIDTH_V_LO 0x8588
#define TC358743_REG_DE_WIDTH_V_HI 0x8589
#define TC358743_REG_H_SIZE_LO     0x858A
#define TC358743_REG_H_SIZE_HI     0x858B
#define TC358743_REG_V_SIZE_LO     0x858C
#define TC358743_REG_V_SIZE_HI     0x858D
#define TC358743_REG_FV_CNT_LO      0x85A1
#define TC358743_REG_FV_CNT_HI      0x85A2

#define TC358743_REG_FH_MIN0        0x85AA
#define TC358743_REG_FH_MIN1        0x85AB
#define TC358743_REG_FH_MAX0        0x85AC
#define TC358743_REG_FH_MAX1        0x85AD
#define TC358743_REG_HV_RST         0x85AF
#define TC358743_MASK_H_PI_RST      0x20
#define TC358743_MASK_V_PI_RST      0x10
#define TC358743_REG_EDID_MODE      0x85C7
#define TC358743_MASK_EDID_MODE     0x03
#define TC358743_EDID_MODE_E_DDC    0x02
#define TC358743_REG_EDID_LEN1      0x85CA
#define TC358743_REG_EDID_LEN2      0x85CB
#define TC358743_REG_EDID_RAM       0x8C00

#define TC358743_REG_LOCKDET_REF0   0x8630
#define TC358743_REG_LOCKDET_REF1   0x8631
#define TC358743_REG_LOCKDET_REF2   0x8632
#define TC358743_REG_VI_MODE        0x8570
#define TC358743_MASK_RGB_DVI       0x08
#define TC358743_REG_VOUT_SET2      0x8573
#define TC358743_MASK_SEL422        0x80
#define TC358743_MASK_VOUT_422FIL_100 0x40
#define TC358743_MASK_VOUTCOLORMODE 0x03
#define TC358743_VOUTCOLORMODE_AUTO 0x01
#define TC358743_REG_VOUT_SET3      0x8574
#define TC358743_MASK_VOUT_EXTCNT   0x08
#define TC358743_REG_VI_REP         0x8576
#define TC358743_MASK_VOUT_COLOR_SEL 0xE0
#define TC358743_VOUT_COLOR_RGB_FULL 0x00
#define TC358743_VOUT_COLOR_601_YCBCR_LIMITED 0x60
#define TC358743_REG_VI_MUTE        0x857F
#define TC358743_MASK_AUTO_MUTE     0xC0
#define TC358743_MASK_VI_MUTE       0x10
#define TC358743_MASK_YCBCRFMT      0x00C0
#define TC358743_YCBCRFMT_422_8_BIT 0x00C0
#define TC358743_MASK_ABUFEN        0x0002
#define TC358743_MASK_VBUFEN        0x0001

#define TC358743_REG_FORCE_MUTE     0x8600
#define TC358743_REG_AUTO_CMD0      0x8602
#define TC358743_REG_AUTO_CMD1      0x8603
#define TC358743_REG_AUTO_CMD2      0x8604
#define TC358743_REG_BUFINIT_START  0x8606
#define TC358743_REG_FS_MUTE        0x8607
#define TC358743_REG_FS_IMODE       0x8620
#define TC358743_REG_ACR_MODE       0x8640
#define TC358743_REG_ACR_MDF0       0x8641
#define TC358743_REG_ACR_MDF1       0x8642
#define TC358743_REG_SDO_MODE1      0x8652
#define TC358743_REG_DIV_MODE       0x8665

#define TC358743_REG_PK_INT_MODE    0x8709
#define TC358743_REG_NO_PKT_LIMIT   0x870B
#define TC358743_REG_NO_PKT_CLR     0x870C
#define TC358743_REG_ERR_PK_LIMIT   0x870D
#define TC358743_REG_NO_PKT_LIMIT2  0x870E
#define TC358743_REG_NO_GDB_LIMIT   0x9007

#define TC358743_REG_NCO_F0_MOD     0x8670
#define TC358743_MASK_NCO_F0_MOD    0x03
#define TC358743_NCO_F0_MOD_27MHZ   0x01

#define TC358743_EDID_BLOCK_SIZE    128
#define TC358743_I2C_BURST_SIZE      16
#define TC358743_HPD_LOW_DELAY_MS   200
#define TC358743_HPD_HIGH_DELAY_MS  150
#define TC358743_POLL_INTERVAL_MS   500
#define TC358743_I2C_TIMEOUT_MS     100

static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_dev;
static tc358743_status_t s_status;
static portMUX_TYPE s_status_lock = portMUX_INITIALIZER_UNLOCKED;
static bool s_poll_task_started;

static void status_store(const tc358743_status_t *status)
{
    taskENTER_CRITICAL(&s_status_lock);
    s_status = *status;
    taskEXIT_CRITICAL(&s_status_lock);
}

static void status_load(tc358743_status_t *status)
{
    taskENTER_CRITICAL(&s_status_lock);
    *status = s_status;
    taskEXIT_CRITICAL(&s_status_lock);
}

static esp_err_t add_device(uint8_t address, i2c_master_dev_handle_t *out_dev)
{
    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = address,
        .scl_speed_hz = FREERIG_CSI_I2C_FREQ_HZ,
    };

    return i2c_master_bus_add_device(s_bus, &dev_cfg, out_dev);
}

static esp_err_t read_register(i2c_master_dev_handle_t dev, uint16_t reg, uint8_t *data, size_t len)
{
    uint8_t reg_addr[2] = {
        (uint8_t)(reg >> 8),
        (uint8_t)(reg & 0xFF),
    };

    return i2c_master_transmit_receive(dev, reg_addr, sizeof(reg_addr), data, len,
                                       TC358743_I2C_TIMEOUT_MS);
}

static esp_err_t write_register(i2c_master_dev_handle_t dev, uint16_t reg,
                                const uint8_t *data, size_t len)
{
    if (len > TC358743_I2C_BURST_SIZE) {
        return ESP_ERR_INVALID_SIZE;
    }

    uint8_t tx[2 + TC358743_I2C_BURST_SIZE];
    tx[0] = (uint8_t)(reg >> 8);
    tx[1] = (uint8_t)(reg & 0xFF);
    if (len > 0) {
        memcpy(&tx[2], data, len);
    }

    return i2c_master_transmit(dev, tx, 2 + len, TC358743_I2C_TIMEOUT_MS);
}

static esp_err_t read_u8(i2c_master_dev_handle_t dev, uint16_t reg, uint8_t *value)
{
    return read_register(dev, reg, value, 1);
}

static esp_err_t write_u8(i2c_master_dev_handle_t dev, uint16_t reg, uint8_t value)
{
    return write_register(dev, reg, &value, 1);
}

static esp_err_t update_u8(i2c_master_dev_handle_t dev, uint16_t reg, uint8_t clear_mask,
                           uint8_t set_bits, uint8_t *new_value)
{
    uint8_t value = 0;
    esp_err_t err = read_u8(dev, reg, &value);
    if (err != ESP_OK) {
        return err;
    }

    value = (uint8_t)((value & (uint8_t)~clear_mask) | set_bits);
    err = write_u8(dev, reg, value);
    if (err == ESP_OK && new_value != NULL) {
        *new_value = value;
    }
    return err;
}

static esp_err_t read_u16_le(i2c_master_dev_handle_t dev, uint16_t reg, uint16_t *value)
{
    uint8_t data[2] = {0};
    esp_err_t err = read_register(dev, reg, data, sizeof(data));
    if (err != ESP_OK) {
        return err;
    }

    *value = (uint16_t)data[0] | ((uint16_t)data[1] << 8);
    return ESP_OK;
}

static esp_err_t write_u16_le(i2c_master_dev_handle_t dev, uint16_t reg, uint16_t value)
{
    uint8_t data[2] = {
        (uint8_t)(value & 0xFF),
        (uint8_t)(value >> 8),
    };
    return write_register(dev, reg, data, sizeof(data));
}

static esp_err_t update_u16_le(i2c_master_dev_handle_t dev, uint16_t reg, uint16_t clear_mask,
                               uint16_t set_bits, uint16_t *new_value)
{
    uint16_t value = 0;
    esp_err_t err = read_u16_le(dev, reg, &value);
    if (err != ESP_OK) {
        return err;
    }

    value = (uint16_t)((value & (uint16_t)~clear_mask) | set_bits);
    err = write_u16_le(dev, reg, value);
    if (err == ESP_OK && new_value != NULL) {
        *new_value = value;
    }
    return err;
}

static esp_err_t read_u32_le(i2c_master_dev_handle_t dev, uint16_t reg, uint32_t *value)
{
    uint8_t data[4] = {0};
    esp_err_t err = read_register(dev, reg, data, sizeof(data));
    if (err != ESP_OK) {
        return err;
    }

    *value = (uint32_t)data[0] |
             ((uint32_t)data[1] << 8) |
             ((uint32_t)data[2] << 16) |
             ((uint32_t)data[3] << 24);
    return ESP_OK;
}

static esp_err_t write_u32_le(i2c_master_dev_handle_t dev, uint16_t reg, uint32_t value)
{
    uint8_t data[4] = {
        (uint8_t)(value & 0xFFU),
        (uint8_t)((value >> 8) & 0xFFU),
        (uint8_t)((value >> 16) & 0xFFU),
        (uint8_t)((value >> 24) & 0xFFU),
    };
    return write_register(dev, reg, data, sizeof(data));
}

static void record_discovered_address(tc358743_status_t *status, uint8_t address)
{
    if (status->discovered_count < TC358743_MAX_DISCOVERED_I2C_DEVICES) {
        status->discovered_addresses[status->discovered_count++] = address;
    } else {
        status->discovered_truncated = true;
    }
}

static void decode_sys_status(tc358743_status_t *status, uint8_t sys_status)
{
    status->sys_status_valid = true;
    status->sys_status_raw = sys_status;
    status->sync = (sys_status & TC358743_MASK_S_SYNC) != 0;
    status->avmute = (sys_status & TC358743_MASK_S_AVMUTE) != 0;
    status->hdmi = (sys_status & TC358743_MASK_S_HDMI) != 0;
    status->phy_scdt = (sys_status & TC358743_MASK_S_PHY_SCDT) != 0;
    status->phy_pll = (sys_status & TC358743_MASK_S_PHY_PLL) != 0;
    status->tmds = (sys_status & TC358743_MASK_S_TMDS) != 0;
    status->ddc_5v = (sys_status & TC358743_MASK_S_DDC5V) != 0;
}

static bool probe_candidate(tc358743_status_t *status, uint8_t address)
{
    i2c_master_dev_handle_t dev = NULL;
    esp_err_t err = add_device(address, &dev);
    if (err != ESP_OK) {
        return false;
    }

    uint16_t chipid = 0;
    err = read_u16_le(dev, TC358743_REG_CHIPID, &chipid);
    if (err != ESP_OK) {
        i2c_master_bus_rm_device(dev);
        return false;
    }

    /* The upstream Linux driver identifies TC358743 when CHIPID[15:8] == 0. */
    if ((chipid & TC358743_MASK_CHIPID) != 0) {
        i2c_master_bus_rm_device(dev);
        return false;
    }

    uint8_t sys_status = 0;
    err = read_u8(dev, TC358743_REG_SYS_STATUS, &sys_status);
    if (err != ESP_OK) {
        i2c_master_bus_rm_device(dev);
        return false;
    }

    status->found = true;
    status->address = address;
    status->chip_id_raw = chipid;
    status->chip_id = (uint8_t)((chipid & TC358743_MASK_CHIPID) >> 8);
    status->revision = (uint8_t)(chipid & TC358743_MASK_REVID);
    decode_sys_status(status, sys_status);

    /* Keep the identified device attached for EDID and live diagnostics. */
    s_dev = dev;

    ESP_LOGI(TAG, "TC358743 candidate at 7-bit I2C address 0x%02X: CHIPID=0x%04X revision=0x%02X",
             address, chipid, status->revision);
    ESP_LOGI(TAG,
             "Initial SYS_STATUS=0x%02X DDC5V=%d TMDS=%d PHY_PLL=%d PHY_SCDT=%d HDMI=%d SYNC=%d AVMUTE=%d",
             status->sys_status_raw,
             status->ddc_5v,
             status->tmds,
             status->phy_pll,
             status->phy_scdt,
             status->hdmi,
             status->sync,
             status->avmute);

    return true;
}


static esp_err_t configure_timing_reference(tc358743_status_t *status)
{
    /*
     * Mirror tc358743_set_ref_clk() from the upstream Linux driver for the
     * known 27 MHz reference clock. These registers belong to the HDMI RX
     * clock/signal detector; this still does not configure the CSI TX PLL.
     */
    const uint32_t refclk = FREERIG_TC358743_REFERENCE_HZ;
    const uint16_t sys_freq = (uint16_t)(refclk / 10000U);
    const uint16_t fh_min = (uint16_t)(refclk / 100000U);
    const uint16_t fh_max = (uint16_t)((fh_min * 66U) / 10U);
    const uint32_t lockdet_ref = refclk / 100U;

    esp_err_t err = write_u8(s_dev, TC358743_REG_SYS_FREQ0, (uint8_t)(sys_freq & 0xFF));
    if (err != ESP_OK) return err;
    err = write_u8(s_dev, TC358743_REG_SYS_FREQ1, (uint8_t)(sys_freq >> 8));
    if (err != ESP_OK) return err;

    /* 27 MHz uses PHY_SYSCLK_IND=0. */
    err = update_u8(s_dev, TC358743_REG_PHY_CTL0, TC358743_MASK_PHY_SYSCLK_IND, 0,
                    &status->phy_ctl0_raw);
    if (err != ESP_OK) return err;

    err = write_u8(s_dev, TC358743_REG_FH_MIN0, (uint8_t)(fh_min & 0xFF));
    if (err != ESP_OK) return err;
    err = write_u8(s_dev, TC358743_REG_FH_MIN1, (uint8_t)(fh_min >> 8));
    if (err != ESP_OK) return err;
    err = write_u8(s_dev, TC358743_REG_FH_MAX0, (uint8_t)(fh_max & 0xFF));
    if (err != ESP_OK) return err;
    err = write_u8(s_dev, TC358743_REG_FH_MAX1, (uint8_t)(fh_max >> 8));
    if (err != ESP_OK) return err;

    err = write_u8(s_dev, TC358743_REG_LOCKDET_REF0, (uint8_t)(lockdet_ref & 0xFF));
    if (err != ESP_OK) return err;
    err = write_u8(s_dev, TC358743_REG_LOCKDET_REF1, (uint8_t)((lockdet_ref >> 8) & 0xFF));
    if (err != ESP_OK) return err;
    err = write_u8(s_dev, TC358743_REG_LOCKDET_REF2, (uint8_t)((lockdet_ref >> 16) & 0x0F));
    if (err != ESP_OK) return err;

    err = update_u8(s_dev, TC358743_REG_NCO_F0_MOD, TC358743_MASK_NCO_F0_MOD,
                    TC358743_NCO_F0_MOD_27MHZ, &status->nco_f0_mod_raw);
    if (err != ESP_OK) return err;

    /* Upstream Linux derives both CEC clocks from the real reference clock. */
    const uint16_t cec_freq = (uint16_t)((656U * (uint32_t)sys_freq) / 4200U);
    err = write_u16_le(s_dev, TC358743_REG_CECHCLK, cec_freq);
    if (err != ESP_OK) return err;
    err = write_u16_le(s_dev, TC358743_REG_CECLCLK, cec_freq);
    if (err != ESP_OK) return err;

    status->sys_freq_raw = sys_freq;
    status->reference_clock_hz = refclk;
    status->fh_min_raw = fh_min;
    status->fh_max_raw = fh_max;
    status->lockdet_ref_raw = lockdet_ref;
    status->timing_reference_programmed = true;

    ESP_LOGI(TAG,
             "HDMI RX refclk configured: ref=%" PRIu32 " SYS_FREQ=%u FH_MIN=%u FH_MAX=%u LOCKDET_REF=%" PRIu32 " NCO=0x%02X",
             refclk, sys_freq, fh_min, fh_max, lockdet_ref, status->nco_f0_mod_raw);
    return ESP_OK;
}

static esp_err_t reset_hdmi_blocks(tc358743_status_t *status)
{
    uint16_t sysctl = 0;
    esp_err_t err = read_u16_le(s_dev, TC358743_REG_SYSCTL, &sysctl);
    if (err != ESP_OK) return err;

    const uint16_t reset_mask = TC358743_MASK_CTXRST | TC358743_MASK_HDMIRST;
    err = write_u16_le(s_dev, TC358743_REG_SYSCTL, (uint16_t)(sysctl | reset_mask));
    if (err != ESP_OK) return err;
    vTaskDelay(pdMS_TO_TICKS(2));
    err = write_u16_le(s_dev, TC358743_REG_SYSCTL, (uint16_t)(sysctl & (uint16_t)~reset_mask));
    if (err != ESP_OK) return err;

    err = update_u16_le(s_dev, TC358743_REG_SYSCTL, TC358743_MASK_SLEEP, 0, &status->sysctl_raw);
    if (err != ESP_OK) return err;

    ESP_LOGI(TAG, "HDMI RX + CSI context reset complete; sleep disabled (SYSCTL=0x%04X)",
             status->sysctl_raw);
    return ESP_OK;
}

static esp_err_t clear_hdmi_event_latches(void)
{
    /* Linux clears these write-one-to-clear status registers at init. */
    const uint16_t regs[] = {
        TC358743_REG_HDMI_INT0,
        TC358743_REG_HDMI_INT1,
        TC358743_REG_SYS_INT,
        TC358743_REG_CLK_INT,
        TC358743_REG_MISC_INT,
    };
    for (size_t i = 0; i < sizeof(regs) / sizeof(regs[0]); ++i) {
        esp_err_t err = write_u8(s_dev, regs[i], 0xFF);
        if (err != ESP_OK) {
            return err;
        }
    }
    return ESP_OK;
}

static esp_err_t read_hdmi_diagnostics(tc358743_status_t *status)
{
    esp_err_t err;
    uint8_t value = 0;

#define READ_DIAG(reg, field) do { \
        err = read_u8(s_dev, (reg), &value); \
        if (err != ESP_OK) return err; \
        status->field = value; \
    } while (0)

    READ_DIAG(TC358743_REG_HPD_CTL, hpd_ctl_raw);
    status->hpd_high = (status->hpd_ctl_raw & TC358743_MASK_HPD_OUT0) != 0;
    status->hpd_control_enabled = (status->hpd_ctl_raw & TC358743_MASK_HPD_CTL0) != 0;

    READ_DIAG(TC358743_REG_DDC_CTL, ddc_ctl_raw);
    status->ddc_action = (status->ddc_ctl_raw & TC358743_MASK_DDC_ACTION) != 0;
    status->ddc_ack_polarity = (status->ddc_ctl_raw & TC358743_MASK_DDC_ACK_POL) != 0;
    READ_DIAG(TC358743_REG_SYS_CLK, sys_clk_raw);
    READ_DIAG(TC358743_REG_ANA_CTL, ana_ctl_raw);
    READ_DIAG(TC358743_REG_INIT_END, init_end_raw);

    READ_DIAG(TC358743_REG_SYS_INTM, sys_int_mask_raw);
    READ_DIAG(TC358743_REG_CLK_INTM, clk_int_mask_raw);
    READ_DIAG(TC358743_REG_MISC_INTM, misc_int_mask_raw);

    READ_DIAG(TC358743_REG_HDMI_INT0, hdmi_int0_raw);
    status->hdmi_int0_seen |= status->hdmi_int0_raw;
    READ_DIAG(TC358743_REG_HDMI_INT1, hdmi_int1_raw);
    status->hdmi_int1_seen |= status->hdmi_int1_raw;
    READ_DIAG(TC358743_REG_SYS_INT, sys_int_raw);
    status->sys_int_seen |= status->sys_int_raw;
    READ_DIAG(TC358743_REG_CLK_INT, clk_int_raw);
    status->clk_int_seen |= status->clk_int_raw;
    READ_DIAG(TC358743_REG_MISC_INT, misc_int_raw);
    status->misc_int_seen |= status->misc_int_raw;

#undef READ_DIAG
    return ESP_OK;
}

static void log_hdmi_diagnostics(const tc358743_status_t *status, const char *stage)
{
    ESP_LOGI(TAG,
             "HDMI diag %-12s HPD_CTL=0x%02X OUT=%d CTL=%d DDC_CTL=0x%02X ACTION=%d ACKPOL=%d SYS_INT=0x%02X CLK_INT=0x%02X MISC_INT=0x%02X HDMI_INT=0x%02X/0x%02X ANA=0x%02X INIT_END=0x%02X",
             stage,
             status->hpd_ctl_raw,
             status->hpd_high,
             status->hpd_control_enabled,
             status->ddc_ctl_raw,
             status->ddc_action,
             status->ddc_ack_polarity,
             status->sys_int_raw,
             status->clk_int_raw,
             status->misc_int_raw,
             status->hdmi_int0_raw,
             status->hdmi_int1_raw,
             status->ana_ctl_raw,
             status->init_end_raw);
}

static esp_err_t log_signal_stage(tc358743_status_t *status, const char *stage)
{
    uint8_t sys_status = 0;
    esp_err_t err = read_u8(s_dev, TC358743_REG_SYS_STATUS, &sys_status);
    if (err != ESP_OK) return err;
    decode_sys_status(status, sys_status);
    ESP_LOGI(TAG,
             "Stage %-18s SYS_STATUS=0x%02X DDC5V=%d TMDS=%d PHY_PLL=%d PHY_SCDT=%d HDMI=%d SYNC=%d",
             stage, status->sys_status_raw, status->ddc_5v, status->tmds,
             status->phy_pll, status->phy_scdt, status->hdmi, status->sync);
    return ESP_OK;
}

static esp_err_t configure_receiver_linux_full(tc358743_status_t *status)
{
    /*
     * Milestone 4.9 mirrors tc358743_initial_setup() from current upstream
     * Linux as closely as practical while intentionally omitting all CSI TX
     * configuration. The Mac has already proven that EDID/HPD/DDC are
     * physically functional, so this test focuses on the HDMI receiver state.
     */
    esp_err_t err;

    /* Keep the source disconnected logically while the receiver is reset. */
    err = update_u8(s_dev, TC358743_REG_HPD_CTL,
                    TC358743_MASK_HPD_OUT0, 0, NULL);
    if (err != ESP_OK) return err;
    status->hpd_high = false;
    err = log_signal_stage(status, "HPD low");
    if (err != ESP_OK) return err;

    /* Linux holds IR/CEC reset, pulses CTX+HDMI reset, then exits sleep. */
    uint16_t sysctl = 0;
    err = read_u16_le(s_dev, TC358743_REG_SYSCTL, &sysctl);
    if (err != ESP_OK) return err;
    sysctl = (uint16_t)(sysctl | TC358743_MASK_IRRST | TC358743_MASK_CECRST);
    err = write_u16_le(s_dev, TC358743_REG_SYSCTL, sysctl);
    if (err != ESP_OK) return err;
    err = reset_hdmi_blocks(status);
    if (err != ESP_OK) return err;
    err = log_signal_stage(status, "Linux reset");
    if (err != ESP_OK) return err;

    /* Current upstream fwnode default for pdata->fifo_level is 374. */
    err = write_u16_le(s_dev, TC358743_REG_FIFOCTL, TC358743_LINUX_FIFO_LEVEL);
    if (err != ESP_OK) return err;
    ESP_LOGI(TAG, "Linux FIFOCTL programmed: %u", TC358743_LINUX_FIFO_LEVEL);

    err = configure_timing_reference(status);
    if (err != ESP_OK) return err;
    err = log_signal_stage(status, "Linux refclk");
    if (err != ESP_OK) return err;

    /* Current upstream fwnode defaults: 100 ms DDC5V debounce and E-DDC EDID mode. */
    err = update_u8(s_dev, TC358743_REG_DDC_CTL,
                    TC358743_MASK_DDC5V_MODE,
                    TC358743_DDC5V_DELAY_100MS,
                    &status->ddc_ctl_raw);
    if (err != ESP_OK) return err;
    err = update_u8(s_dev, TC358743_REG_EDID_MODE,
                    TC358743_MASK_EDID_MODE,
                    TC358743_EDID_MODE_E_DDC,
                    &status->edid_mode_raw);
    if (err != ESP_OK) return err;
    err = log_signal_stage(status, "Linux DDC/EDID");
    if (err != ESP_OK) return err;

    /* tc358743_set_hdmi_phy(), with all platform-data booleans at defaults. */
    err = update_u8(s_dev, TC358743_REG_PHY_EN,
                    TC358743_MASK_ENABLE_PHY, 0, NULL);
    if (err != ESP_OK) return err;
    err = write_u8(s_dev, TC358743_REG_PHY_CTL1, 0x80); /* 1600 us, 1 cycle */
    if (err != ESP_OK) return err;
    err = update_u8(s_dev, TC358743_REG_PHY_CTL2,
                    TC358743_MASK_PHY_AUTO_RSTN, 0, NULL);
    if (err != ESP_OK) return err;
    err = write_u8(s_dev, TC358743_REG_PHY_BIAS, 0x40);
    if (err != ESP_OK) return err;
    err = write_u8(s_dev, TC358743_REG_PHY_CSQ, 0x0A);
    if (err != ESP_OK) return err;
    err = write_u8(s_dev, TC358743_REG_AVM_CTL, 45);
    if (err != ESP_OK) return err;
    err = update_u8(s_dev, TC358743_REG_HDMI_DET,
                    TC358743_MASK_HDMI_DET_V, 0, NULL);
    if (err != ESP_OK) return err;
    err = update_u8(s_dev, TC358743_REG_HV_RST,
                    TC358743_MASK_H_PI_RST | TC358743_MASK_V_PI_RST,
                    0, NULL);
    if (err != ESP_OK) return err;
    err = update_u8(s_dev, TC358743_REG_PHY_EN,
                    TC358743_MASK_ENABLE_PHY,
                    TC358743_MASK_ENABLE_PHY,
                    &status->phy_en_raw);
    if (err != ESP_OK) return err;

    if ((err = read_u8(s_dev, TC358743_REG_PHY_CTL0, &status->phy_ctl0_raw)) != ESP_OK) return err;
    if ((err = read_u8(s_dev, TC358743_REG_PHY_CTL1, &status->phy_ctl1_raw)) != ESP_OK) return err;
    if ((err = read_u8(s_dev, TC358743_REG_PHY_CTL2, &status->phy_ctl2_raw)) != ESP_OK) return err;
    if ((err = read_u8(s_dev, TC358743_REG_PHY_EN, &status->phy_en_raw)) != ESP_OK) return err;
    if ((err = read_u8(s_dev, TC358743_REG_PHY_BIAS, &status->phy_bias_raw)) != ESP_OK) return err;
    if ((err = read_u8(s_dev, TC358743_REG_PHY_CSQ, &status->phy_csq_raw)) != ESP_OK) return err;
    if ((err = read_u8(s_dev, TC358743_REG_HDMI_DET, &status->hdmi_det_raw)) != ESP_OK) return err;
    if ((err = read_u8(s_dev, TC358743_REG_HV_RST, &status->hv_rst_raw)) != ESP_OK) return err;
    ESP_LOGI(TAG,
             "Linux HDMI PHY: CTL0=0x%02X CTL1=0x%02X CTL2=0x%02X PHY_EN=0x%02X BIAS=0x%02X CSQ=0x%02X HDMI_DET=0x%02X HV_RST=0x%02X",
             status->phy_ctl0_raw, status->phy_ctl1_raw, status->phy_ctl2_raw,
             status->phy_en_raw, status->phy_bias_raw, status->phy_csq_raw,
             status->hdmi_det_raw, status->hv_rst_raw);
    err = log_signal_stage(status, "Linux HDMI PHY");
    if (err != ESP_OK) return err;

    /* tc358743_set_hdmi_hdcp(sd, false). */
    err = update_u8(s_dev, TC358743_REG_HDCP_MODE,
                    TC358743_MASK_MANUAL_AUTH,
                    TC358743_MASK_MANUAL_AUTH, NULL);
    if (err != ESP_OK) return err;
    err = log_signal_stage(status, "Linux HDCP off");
    if (err != ESP_OK) return err;

    /* tc358743_set_hdmi_audio() defaults. Audio is not consumed yet; these
     * writes only complete the HDMI RX configuration used by Linux. */
    if ((err = write_u8(s_dev, TC358743_REG_FORCE_MUTE, 0x00)) != ESP_OK) return err;
    if ((err = write_u8(s_dev, TC358743_REG_AUTO_CMD0, 0xF3)) != ESP_OK) return err;
    if ((err = write_u8(s_dev, TC358743_REG_AUTO_CMD1, 0x02)) != ESP_OK) return err;
    if ((err = write_u8(s_dev, TC358743_REG_AUTO_CMD2, 0x0C)) != ESP_OK) return err;
    if ((err = write_u8(s_dev, TC358743_REG_BUFINIT_START, 0x05)) != ESP_OK) return err;
    if ((err = write_u8(s_dev, TC358743_REG_FS_MUTE, 0x00)) != ESP_OK) return err;
    if ((err = write_u8(s_dev, TC358743_REG_FS_IMODE, 0x22)) != ESP_OK) return err;
    if ((err = write_u8(s_dev, TC358743_REG_ACR_MODE, 0x01)) != ESP_OK) return err;
    if ((err = write_u8(s_dev, TC358743_REG_ACR_MDF0, 0x65)) != ESP_OK) return err;
    if ((err = write_u8(s_dev, TC358743_REG_ACR_MDF1, 0x07)) != ESP_OK) return err;
    if ((err = write_u8(s_dev, TC358743_REG_SDO_MODE1, 0x02)) != ESP_OK) return err;
    if ((err = write_u8(s_dev, TC358743_REG_DIV_MODE, 0x10)) != ESP_OK) return err;
    err = update_u16_le(s_dev, TC358743_REG_CONFCTL, 0,
                        TC358743_MASK_AUDCHNUM_2 |
                        TC358743_MASK_AUDOUTSEL_I2S |
                        TC358743_MASK_AUTOINDEX,
                        NULL);
    if (err != ESP_OK) return err;
    err = log_signal_stage(status, "Linux HDMI audio");
    if (err != ESP_OK) return err;

    /* tc358743_set_hdmi_info_frame_mode(). */
    if ((err = write_u8(s_dev, TC358743_REG_PK_INT_MODE, 0xFF)) != ESP_OK) return err;
    if ((err = write_u8(s_dev, TC358743_REG_NO_PKT_LIMIT, 0x2C)) != ESP_OK) return err;
    if ((err = write_u8(s_dev, TC358743_REG_NO_PKT_CLR, 0x53)) != ESP_OK) return err;
    if ((err = write_u8(s_dev, TC358743_REG_ERR_PK_LIMIT, 0x01)) != ESP_OK) return err;
    if ((err = write_u8(s_dev, TC358743_REG_NO_PKT_LIMIT2, 0x30)) != ESP_OK) return err;
    if ((err = write_u8(s_dev, TC358743_REG_NO_GDB_LIMIT, 0x10)) != ESP_OK) return err;
    err = log_signal_stage(status, "Linux infoframes");
    if (err != ESP_OK) return err;

    /* Final HDMI RX video-mode defaults from tc358743_initial_setup(). */
    err = update_u8(s_dev, TC358743_REG_VI_MODE, TC358743_MASK_RGB_DVI, 0, NULL);
    if (err != ESP_OK) return err;
    err = update_u8(s_dev, TC358743_REG_VOUT_SET2,
                    TC358743_MASK_VOUTCOLORMODE,
                    TC358743_VOUTCOLORMODE_AUTO, NULL);
    if (err != ESP_OK) return err;
    if ((err = write_u8(s_dev, TC358743_REG_VOUT_SET3,
                        TC358743_MASK_VOUT_EXTCNT)) != ESP_OK) return err;

    status->hdmi_receiver_configured = true;
    ESP_LOGI(TAG, "Upstream Linux HDMI-RX initial_setup sequence completed; CSI TX remains disabled");
    return log_signal_stage(status, "Linux RX complete");
}

static void log_edid_sample(const char *label, const uint8_t *data, size_t len)
{
    if (data == NULL || len == 0) return;
    char line[3 * 16 + 1];
    const size_t sample_len = len < 16 ? len : 16;
    size_t pos = 0;
    for (size_t i = 0; i < sample_len && pos + 3 < sizeof(line); ++i) {
        int n = snprintf(&line[pos], sizeof(line) - pos, "%02X%s", data[i],
                         (i + 1 < sample_len) ? " " : "");
        if (n < 0) return;
        pos += (size_t)n;
    }
    line[sizeof(line) - 1] = '\0';
    ESP_LOGI(TAG, "%s: %s", label, line);
}

static esp_err_t write_edid_ram_explicit_bytes(const uint8_t *data, size_t len)
{
    if (data == NULL || len == 0 || len > TC358743_FREERIG710_EDID_LENGTH) {
        return ESP_ERR_INVALID_ARG;
    }

    /*
     * Real-hardware diagnostics with ESP32-P4 rev 1.3 + ESP-IDF 6.0.2 show
     * that multi-byte writes to EDID_RAM do not advance the TC358743 register
     * address as expected: the final byte in each burst remains at the burst's
     * starting address. Bypass that ambiguity completely by issuing one normal
     * TC358743 register write per EDID byte, with an explicit 16-bit address.
     *
     * This is deliberately conservative and only runs during boot. Once the
     * full bridge path is stable we can revisit an optimized transfer method.
     */
    for (size_t i = 0; i < len; ++i) {
        const uint16_t reg = (uint16_t)(TC358743_REG_EDID_RAM + i);
        esp_err_t err = write_u8(s_dev, reg, data[i]);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "EDID byte write failed: offset=0x%03X reg=0x%04X value=0x%02X: %s",
                     (unsigned)i, reg, data[i], esp_err_to_name(err));
            return err;
        }

        if ((i & 0x3F) == 0x3F) {
            ESP_LOGI(TAG, "EDID byte writes: %u/%u complete",
                     (unsigned)(i + 1), (unsigned)len);
        }
    }

    return ESP_OK;
}

static esp_err_t verify_edid(tc358743_status_t *status)
{
    uint8_t *readback = malloc(TC358743_FREERIG710_EDID_LENGTH);
    if (readback == NULL) {
        return ESP_ERR_NO_MEM;
    }

    status->edid_verify_failed = false;
    status->edid_verify_mismatch_offset = 0;
    status->edid_verify_expected = 0;
    status->edid_verify_actual = 0;

    /*
     * Use one explicit-address read per byte too. This removes all dependence
     * on multi-byte EDID_RAM auto-increment while diagnosing the real bridge.
     */
    esp_err_t err = ESP_OK;
    for (size_t i = 0; i < TC358743_FREERIG710_EDID_LENGTH; ++i) {
        const uint16_t reg = (uint16_t)(TC358743_REG_EDID_RAM + i);
        err = read_u8(s_dev, reg, &readback[i]);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "EDID byte readback failed: offset=0x%03X reg=0x%04X: %s",
                     (unsigned)i, reg, esp_err_to_name(err));
            free(readback);
            return err;
        }
    }

    size_t mismatch_count = 0;
    size_t first_mismatch = TC358743_FREERIG710_EDID_LENGTH;
    for (size_t i = 0; i < TC358743_FREERIG710_EDID_LENGTH; ++i) {
        if (readback[i] != g_tc358743_freerig710_edid[i]) {
            if (first_mismatch == TC358743_FREERIG710_EDID_LENGTH) {
                first_mismatch = i;
            }
            ++mismatch_count;
        }
    }

    if (mismatch_count != 0) {
        const uint8_t expected = g_tc358743_freerig710_edid[first_mismatch];
        const uint8_t actual = readback[first_mismatch];
        status->edid_verify_failed = true;
        status->edid_verify_mismatch_offset = (uint16_t)first_mismatch;
        status->edid_verify_expected = expected;
        status->edid_verify_actual = actual;
        ESP_LOGE(TAG,
                 "EDID verify failed: %u mismatches; first at 0x%03X expected=0x%02X actual=0x%02X",
                 (unsigned)mismatch_count, (unsigned)first_mismatch, expected, actual);
        log_edid_sample("EDID expected first 16", g_tc358743_freerig710_edid,
                        TC358743_FREERIG710_EDID_LENGTH);
        log_edid_sample("EDID readback first 16", readback,
                        TC358743_FREERIG710_EDID_LENGTH);
        if (TC358743_FREERIG710_EDID_LENGTH >= 16) {
            log_edid_sample("EDID expected last 16",
                            &g_tc358743_freerig710_edid[TC358743_FREERIG710_EDID_LENGTH - 16], 16);
            log_edid_sample("EDID readback last 16",
                            &readback[TC358743_FREERIG710_EDID_LENGTH - 16], 16);
        }
        free(readback);
        return ESP_ERR_INVALID_RESPONSE;
    }

    free(readback);
    return ESP_OK;
}

static esp_err_t program_edid_and_hpd(tc358743_status_t *status)
{
    ESP_LOGI(TAG,
             "Programming FT-710 DVI diagnostic EDID: %u bytes, %u blocks; no CTA/HDMI extension",
             TC358743_FREERIG710_EDID_LENGTH,
             TC358743_FREERIG710_EDID_BLOCKS);

    /* Disable hotplug first. Linux does the same before replacing EDID. */
    esp_err_t err = update_u8(s_dev, TC358743_REG_HPD_CTL, TC358743_MASK_HPD_OUT0, 0, NULL);
    if (err != ESP_OK) {
        return err;
    }
    status->hpd_high = false;
    ESP_LOGI(TAG, "HPD forced LOW before EDID update");
    vTaskDelay(pdMS_TO_TICKS(TC358743_HPD_LOW_DELAY_MS));

    /* E-DDC mode is the mode used by the upstream Linux driver. */
    err = update_u8(s_dev, TC358743_REG_EDID_MODE, TC358743_MASK_EDID_MODE,
                    TC358743_EDID_MODE_E_DDC, &status->edid_mode_raw);
    if (err != ESP_OK) {
        return err;
    }

    const uint16_t edid_len = TC358743_FREERIG710_EDID_LENGTH;
    err = write_u8(s_dev, TC358743_REG_EDID_LEN1, (uint8_t)(edid_len & 0xFF));
    if (err != ESP_OK) {
        return err;
    }
    err = write_u8(s_dev, TC358743_REG_EDID_LEN2, (uint8_t)(edid_len >> 8));
    if (err != ESP_OK) {
        return err;
    }

    err = read_u8(s_dev, TC358743_REG_EDID_LEN1, &status->edid_len1_readback);
    if (err != ESP_OK) {
        return err;
    }
    err = read_u8(s_dev, TC358743_REG_EDID_LEN2, &status->edid_len2_readback);
    if (err != ESP_OK) {
        return err;
    }
    ESP_LOGI(TAG, "EDID length readback: LEN1=0x%02X LEN2=0x%02X (%u bytes)",
             status->edid_len1_readback, status->edid_len2_readback,
             (unsigned)(((uint16_t)status->edid_len2_readback << 8) | status->edid_len1_readback));

    /*
     * Real-hardware diagnostics show burst writes do not advance EDID_RAM on
     * this ESP32-P4/driver path. Use explicit addressing for every byte.
     */
    err = write_edid_ram_explicit_bytes(g_tc358743_freerig710_edid,
                                        TC358743_FREERIG710_EDID_LENGTH);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "EDID explicit-byte programming failed: %s", esp_err_to_name(err));
        return err;
    }
    ESP_LOGI(TAG, "EDID RAM programming completed as %u explicit-address byte writes", (unsigned)TC358743_FREERIG710_EDID_LENGTH);

    status->edid_programmed = true;
    status->edid_length = TC358743_FREERIG710_EDID_LENGTH;
    status->edid_blocks = TC358743_FREERIG710_EDID_BLOCKS;

    err = verify_edid(status);
    if (err != ESP_OK) {
        return err;
    }
    status->edid_verified = true;
    ESP_LOGI(TAG, "EDID readback verified byte-for-byte");

    /* Clear stale HDMI event latches immediately before the HPD rising edge. */
    err = clear_hdmi_event_latches();
    if (err != ESP_OK) {
        return err;
    }
    status->sys_int_seen = 0;
    status->clk_int_seen = 0;
    status->misc_int_seen = 0;
    status->hdmi_int0_seen = 0;
    status->hdmi_int1_seen = 0;
    ESP_LOGI(TAG, "HDMI event latches cleared immediately before HPD HIGH");

    /* Linux enables hotplug after roughly 143 ms; use a conservative 150 ms. */
    vTaskDelay(pdMS_TO_TICKS(TC358743_HPD_HIGH_DELAY_MS));
    err = update_u8(s_dev, TC358743_REG_HPD_CTL, TC358743_MASK_HPD_OUT0,
                    TC358743_MASK_HPD_OUT0, NULL);
    if (err != ESP_OK) {
        return err;
    }
    status->hpd_high = true;
    err = read_hdmi_diagnostics(status);
    if (err != ESP_OK) {
        return err;
    }
    ESP_LOGI(TAG, "HPD set HIGH; HPD_CTL readback=0x%02X (OUT=%d CTL=%d)",
             status->hpd_ctl_raw, status->hpd_high, status->hpd_control_enabled);

    return ESP_OK;
}

static esp_err_t read_timing_registers(tc358743_timings_t *timings)
{
    memset(timings, 0, sizeof(*timings));

    uint8_t vi_status1 = 0;
    uint8_t de_h_lo = 0, de_h_hi = 0, de_v_lo = 0, de_v_hi = 0;
    uint8_t h_size_lo = 0, h_size_hi = 0, v_size_lo = 0, v_size_hi = 0;
    uint8_t fv_lo = 0, fv_hi = 0;

#define READ8_OR_RETURN(reg, variable)                  \
    do {                                                \
        esp_err_t _err = read_u8(s_dev, reg, &(variable)); \
        if (_err != ESP_OK) {                           \
            return _err;                                \
        }                                               \
    } while (0)

    READ8_OR_RETURN(TC358743_REG_VI_STATUS1, vi_status1);
    READ8_OR_RETURN(TC358743_REG_DE_WIDTH_H_LO, de_h_lo);
    READ8_OR_RETURN(TC358743_REG_DE_WIDTH_H_HI, de_h_hi);
    READ8_OR_RETURN(TC358743_REG_DE_WIDTH_V_LO, de_v_lo);
    READ8_OR_RETURN(TC358743_REG_DE_WIDTH_V_HI, de_v_hi);
    READ8_OR_RETURN(TC358743_REG_H_SIZE_LO, h_size_lo);
    READ8_OR_RETURN(TC358743_REG_H_SIZE_HI, h_size_hi);
    READ8_OR_RETURN(TC358743_REG_V_SIZE_LO, v_size_lo);
    READ8_OR_RETURN(TC358743_REG_V_SIZE_HI, v_size_hi);
    READ8_OR_RETURN(TC358743_REG_FV_CNT_LO, fv_lo);
    READ8_OR_RETURN(TC358743_REG_FV_CNT_HI, fv_hi);

#undef READ8_OR_RETURN

    uint16_t width = (uint16_t)(((de_h_hi & 0x1F) << 8) | de_h_lo);
    uint16_t height = (uint16_t)(((de_v_hi & 0x1F) << 8) | de_v_lo);
    uint16_t frame_width = (uint16_t)(((h_size_hi & 0x1F) << 8) | h_size_lo);
    uint16_t frame_height = (uint16_t)((((v_size_hi & 0x3F) << 8) | v_size_lo) / 2);
    uint16_t frame_interval = (uint16_t)(((fv_hi & 0x03) << 8) | fv_lo);
    bool interlaced = (vi_status1 & TC358743_MASK_INTERLACE) != 0;

    if (width == 0 || height == 0 || frame_width < width || frame_height < height) {
        return ESP_ERR_INVALID_RESPONSE;
    }

    timings->valid = true;
    timings->interlaced = interlaced;
    timings->active_width = width;
    timings->active_height = interlaced ? (uint16_t)(height * 2U) : height;
    timings->frame_width = frame_width;
    timings->frame_height = frame_height;
    timings->h_blanking = (uint16_t)(frame_width - width);
    timings->v_blanking = (uint16_t)(frame_height - height);
    timings->frame_interval_100us = frame_interval;

    if (frame_interval > 0) {
        timings->fps_x100 = (1000000U + (frame_interval / 2U)) / frame_interval;
        uint32_t fps = (10000U + (frame_interval / 2U)) / frame_interval;
        uint64_t pixel_clock = (uint64_t)frame_width * (uint64_t)frame_height * (uint64_t)fps;
        if (interlaced) {
            pixel_clock /= 2U;
        }
        timings->pixel_clock_hz = (uint32_t)pixel_clock;
    }

    return ESP_OK;
}

static esp_err_t refresh_live_status(tc358743_status_t *status)
{
    uint8_t sys_status = 0;
    esp_err_t err = read_u8(s_dev, TC358743_REG_SYS_STATUS, &sys_status);
    if (err != ESP_OK) {
        return err;
    }
    decode_sys_status(status, sys_status);

    err = read_hdmi_diagnostics(status);
    if (err != ESP_OK) {
        return err;
    }

    err = read_u8(s_dev, TC358743_REG_EDID_MODE, &status->edid_mode_raw);
    if (err != ESP_OK) {
        return err;
    }

    uint8_t sys_freq0 = 0, sys_freq1 = 0;
    err = read_u8(s_dev, TC358743_REG_SYS_FREQ0, &sys_freq0);
    if (err != ESP_OK) {
        return err;
    }
    err = read_u8(s_dev, TC358743_REG_SYS_FREQ1, &sys_freq1);
    if (err != ESP_OK) {
        return err;
    }
    status->sys_freq_raw = (uint16_t)(((uint16_t)sys_freq1 << 8) | sys_freq0);

    memset(&status->timings, 0, sizeof(status->timings));
    if (status->hpd_high && status->tmds && status->sync) {
        esp_err_t timing_err = read_timing_registers(&status->timings);
        if (timing_err != ESP_OK) {
            /* Signal status can transition while timing registers are sampled. */
            memset(&status->timings, 0, sizeof(status->timings));
        }
    }

    return ESP_OK;
}

static bool timing_changed(const tc358743_timings_t *a, const tc358743_timings_t *b)
{
    return a->valid != b->valid ||
           a->interlaced != b->interlaced ||
           a->active_width != b->active_width ||
           a->active_height != b->active_height ||
           a->frame_width != b->frame_width ||
           a->frame_height != b->frame_height ||
           a->frame_interval_100us != b->frame_interval_100us;
}

static void log_live_change(const tc358743_status_t *old_status, const tc358743_status_t *new_status)
{
    if (!old_status->sys_status_valid || old_status->sys_status_raw != new_status->sys_status_raw ||
        old_status->hpd_high != new_status->hpd_high) {
        ESP_LOGI(TAG,
                 "SYS_STATUS=0x%02X HPD=%d DDC5V=%d TMDS=%d PHY_PLL=%d PHY_SCDT=%d HDMI=%d SYNC=%d AVMUTE=%d",
                 new_status->sys_status_raw,
                 new_status->hpd_high,
                 new_status->ddc_5v,
                 new_status->tmds,
                 new_status->phy_pll,
                 new_status->phy_scdt,
                 new_status->hdmi,
                 new_status->sync,
                 new_status->avmute);
    }

    if (timing_changed(&old_status->timings, &new_status->timings)) {
        if (new_status->timings.valid) {
            const tc358743_timings_t *t = &new_status->timings;
            ESP_LOGI(TAG,
                     "Detected timing: %ux%u%c frame=%ux%u blanking=%ux%u FV_CNT=%u fps~%" PRIu32 ".%02" PRIu32,
                     t->active_width,
                     t->active_height,
                     t->interlaced ? 'i' : 'p',
                     t->frame_width,
                     t->frame_height,
                     t->h_blanking,
                     t->v_blanking,
                     t->frame_interval_100us,
                     t->fps_x100 / 100U,
                     t->fps_x100 % 100U);
            if (new_status->sys_freq_raw == 0) {
                ESP_LOGW(TAG, "SYS_FREQ is zero; frame-rate counter interpretation may be invalid");
            }
        } else if (old_status->timings.valid) {
            ESP_LOGW(TAG, "Previously detected timing is no longer valid");
        }
    }
}

static esp_err_t tc358743_recovery_reset_phy(tc358743_status_t *status, const char *reason)
{
    if (status == NULL || s_dev == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    uint8_t phy_rst = 0;
    esp_err_t err = read_u8(s_dev, TC358743_REG_PHY_RST, &phy_rst);
    if (err != ESP_OK) return err;

    /* Match upstream tc358743_reset_phy(): assert RESET_CTRL low, then release it high. */
    err = update_u8(s_dev, TC358743_REG_PHY_RST, TC358743_MASK_RESET_CTRL, 0, &phy_rst);
    if (err != ESP_OK) return err;
    err = update_u8(s_dev, TC358743_REG_PHY_RST, TC358743_MASK_RESET_CTRL,
                    TC358743_MASK_RESET_CTRL, &phy_rst);
    if (err != ESP_OK) return err;

    status->phy_reset_count++;
    ESP_LOGW(TAG, "FT-710 source recovery: HDMI PHY reset #%u (%s); PHY_RST=0x%02X",
             status->phy_reset_count, reason != NULL ? reason : "no reason", phy_rst);
    return refresh_live_status(status);
}

static esp_err_t tc358743_recovery_pulse_hpd(tc358743_status_t *status)
{
    if (status == NULL || s_dev == NULL || !status->edid_verified) {
        return ESP_ERR_INVALID_STATE;
    }

    ESP_LOGW(TAG,
             "FT-710 source recovery: DDC5V is present but no TMDS arrived; pulsing HPD LOW for 500 ms so the source re-reads the verified EDID");

    esp_err_t err = update_u8(s_dev, TC358743_REG_HPD_CTL,
                              TC358743_MASK_HPD_OUT0, 0, &status->hpd_ctl_raw);
    if (err != ESP_OK) return err;
    status->hpd_high = false;
    vTaskDelay(pdMS_TO_TICKS(500));

    /* Do not rewrite the EDID here. It was already verified byte-for-byte. */
    err = clear_hdmi_event_latches();
    if (err != ESP_OK) return err;
    status->sys_int_seen = 0;
    status->clk_int_seen = 0;
    status->misc_int_seen = 0;
    status->hdmi_int0_seen = 0;
    status->hdmi_int1_seen = 0;

    err = update_u8(s_dev, TC358743_REG_HPD_CTL,
                    TC358743_MASK_HPD_OUT0, TC358743_MASK_HPD_OUT0,
                    &status->hpd_ctl_raw);
    if (err != ESP_OK) return err;
    status->hpd_high = true;

    ESP_LOGW(TAG, "FT-710 source recovery: HPD HIGH again; waiting for TMDS");
    return refresh_live_status(status);
}

static void tc358743_poll_task(void *arg)
{
    (void)arg;

    tc358743_status_t previous;
    status_load(&previous);
    unsigned heartbeat = 0;
    unsigned no_tmds_polls = 0;
    bool phy_recovery_done = false;
    bool hpd_recovery_done = false;
    bool previous_ddc_5v = previous.ddc_5v;

    while (true) {
        tc358743_status_t current;
        status_load(&current);

        esp_err_t err = refresh_live_status(&current);
        if (err == ESP_OK) {
            /* A fresh cable/source insertion gets a fresh bounded recovery sequence. */
            if (current.ddc_5v && !previous_ddc_5v) {
                no_tmds_polls = 0;
                phy_recovery_done = false;
                hpd_recovery_done = false;
                ESP_LOGI(TAG, "DDC5V rising edge: FT-710/source connected; recovery state re-armed");
            }
            previous_ddc_5v = current.ddc_5v;

            if (current.ddc_5v && current.hpd_high && !current.tmds) {
                no_tmds_polls++;

                /* 5 seconds: Linux uses the same PHY reset when signal/sync recovery is needed. */
                if (!phy_recovery_done && no_tmds_polls >= 10U) {
                    err = tc358743_recovery_reset_phy(&current, "5 s with DDC5V+HPD but no TMDS");
                    phy_recovery_done = true;
                }

                /* 10 seconds: one deliberate hotplug retrain. Do not loop forever. */
                if (err == ESP_OK && !hpd_recovery_done && no_tmds_polls >= 20U) {
                    err = tc358743_recovery_pulse_hpd(&current);
                    hpd_recovery_done = true;
                    no_tmds_polls = 0;
                }
            } else if (current.tmds) {
                no_tmds_polls = 0;
            } else if (!current.ddc_5v) {
                no_tmds_polls = 0;
            }

            if (err == ESP_OK) {
                current.last_error = ESP_OK;
                log_live_change(&previous, &current);
                status_store(&current);
                previous = current;
                heartbeat++;
                if ((heartbeat % 10U) == 0U) {
                    ESP_LOGI(TAG,
                             "Signal heartbeat: HPD=%d DDC5V=%d TMDS=%d PHY_PLL=%d PHY_SCDT=%d HDMI=%d SYNC=%d SYS_INT_SEEN=0x%02X CLK_INT_SEEN=0x%02X",
                             current.hpd_high, current.ddc_5v, current.tmds, current.phy_pll,
                             current.phy_scdt, current.hdmi, current.sync,
                             current.sys_int_seen, current.clk_int_seen);
                }
            }
        }

        if (err != ESP_OK) {
            current.last_error = err;
            status_store(&current);
            ESP_LOGW(TAG, "Live status/recovery poll failed: %s", esp_err_to_name(err));
        }

        vTaskDelay(pdMS_TO_TICKS(TC358743_POLL_INTERVAL_MS));
    }
}

esp_err_t tc358743_init_and_probe(void)
{
    tc358743_status_t status = {0};
    status.last_error = ESP_OK;

    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = FREERIG_CSI_I2C_PORT,
        .sda_io_num = FREERIG_CSI_I2C_SDA_GPIO,
        .scl_io_num = FREERIG_CSI_I2C_SCL_GPIO,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };

    esp_err_t err = i2c_new_master_bus(&bus_cfg, &s_bus);
    if (err != ESP_OK) {
        status.last_error = err;
        status_store(&status);
        ESP_LOGE(TAG, "Failed to create CSI I2C bus: %s", esp_err_to_name(err));
        return err;
    }

    status.bus_ready = true;
    ESP_LOGI(TAG, "CSI I2C bus ready: SDA=%d SCL=%d frequency=%d Hz",
             FREERIG_CSI_I2C_SDA_GPIO,
             FREERIG_CSI_I2C_SCL_GPIO,
             FREERIG_CSI_I2C_FREQ_HZ);

    for (uint8_t address = 0x08; address <= 0x77; ++address) {
        err = i2c_master_probe(s_bus, address, 20);
        if (err == ESP_OK) {
            record_discovered_address(&status, address);
            ESP_LOGI(TAG, "I2C device found at 0x%02X", address);
        }
    }

    if (status.discovered_count == 0) {
        status.last_error = ESP_ERR_NOT_FOUND;
        status_store(&status);
        ESP_LOGW(TAG, "No devices responded on the CSI I2C bus");
        return ESP_ERR_NOT_FOUND;
    }

    bool found = false;
    for (size_t i = 0; i < status.discovered_count; ++i) {
        if (probe_candidate(&status, status.discovered_addresses[i])) {
            found = true;
            break;
        }
    }

    if (!found) {
        status.last_error = ESP_ERR_NOT_FOUND;
        status_store(&status);
        ESP_LOGW(TAG, "I2C devices responded, but no TC358743 candidate passed the probe");
        return ESP_ERR_NOT_FOUND;
    }

    err = configure_receiver_linux_full(&status);
    if (err != ESP_OK) {
        status.last_error = err;
        status_store(&status);
        ESP_LOGE(TAG, "Upstream Linux HDMI receiver setup failed: %s", esp_err_to_name(err));
        return err;
    }

    err = read_hdmi_diagnostics(&status);
    if (err == ESP_OK) {
        log_hdmi_diagnostics(&status, "pre-EDID");
    }

    err = program_edid_and_hpd(&status);
    if (err != ESP_OK) {
        status.last_error = err;
        status_store(&status);
        ESP_LOGE(TAG, "EDID/HPD sequence failed: %s", esp_err_to_name(err));
        return err;
    }

    /*
     * M4.9 observes the upstream-Linux-initialized HDMI RX after EDID/HPD. Do not reset or reprogram the
     * HDMI PHY after the rising edge. Clear stale event latches immediately before observing the
     * source, then retain cumulative event bits so we can distinguish HPD/DDC
     * activity from actual TMDS/pixel-clock arrival.
     */
    for (int attempt = 1; attempt <= 5; ++attempt) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        err = refresh_live_status(&status);
        if (err != ESP_OK) {
            status.last_error = err;
            status_store(&status);
            return err;
        }
        ESP_LOGI(TAG,
                 "Post-HPD observation %d/5: SYS_STATUS=0x%02X DDC5V=%d TMDS=%d PHY_PLL=%d PHY_SCDT=%d HDMI=%d SYNC=%d",
                 attempt, status.sys_status_raw, status.ddc_5v, status.tmds,
                 status.phy_pll, status.phy_scdt, status.hdmi, status.sync);
        log_hdmi_diagnostics(&status, "post-HPD");
    }

    ESP_LOGI(TAG,
             "HDMI event summary: SYS seen=0x%02X (DDC=%d TMDS=%d HDMI=%d DVI=%d) CLK seen=0x%02X (TMDSCLK=%d PHYCLK=%d PXCLK=%d DE=%d) MISC seen=0x%02X",
             status.sys_int_seen,
             !!(status.sys_int_seen & TC358743_MASK_I_DDC),
             !!(status.sys_int_seen & TC358743_MASK_I_TMDS),
             !!(status.sys_int_seen & 0x10),
             !!(status.sys_int_seen & 0x20),
             status.clk_int_seen,
             !!(status.clk_int_seen & TC358743_MASK_I_TMDSCLK_CHG),
             !!(status.clk_int_seen & TC358743_MASK_I_PHYCLK_CHG),
             !!(status.clk_int_seen & TC358743_MASK_I_PXCLK_CHG),
             !!(status.clk_int_seen & TC358743_MASK_I_IN_DE_CHG),
             status.misc_int_seen);

    status.last_error = ESP_OK;
    status_store(&status);

    if (!s_poll_task_started) {
        BaseType_t created = xTaskCreate(tc358743_poll_task, "tc358743_poll", 4096, NULL, 5, NULL);
        if (created != pdPASS) {
            status.last_error = ESP_ERR_NO_MEM;
            status_store(&status);
            return ESP_ERR_NO_MEM;
        }
        s_poll_task_started = true;
    }

    return ESP_OK;
}

static esp_err_t refresh_csi_tx_status(tc358743_status_t *status)
{
    esp_err_t err = read_u16_le(s_dev, TC358743_REG_PLLCTL0, &status->csi_pllctl0_raw);
    if (err != ESP_OK) return err;
    err = read_u16_le(s_dev, TC358743_REG_PLLCTL1, &status->csi_pllctl1_raw);
    if (err != ESP_OK) return err;
    err = read_u16_le(s_dev, TC358743_REG_CONFCTL, &status->csi_confctl_raw);
    if (err != ESP_OK) return err;
    err = read_u16_le(s_dev, TC358743_REG_FIFOCTL, &status->csi_fifoctl_raw);
    if (err != ESP_OK) return err;
    err = read_u16_le(s_dev, TC358743_REG_CSI_CONTROL, &status->csi_control_raw);
    if (err != ESP_OK) return err;
    err = read_u16_le(s_dev, TC358743_REG_CSI_STATUS, &status->csi_status_raw);
    if (err != ESP_OK) return err;
    status->csi_status_seen |= status->csi_status_raw;
    status->csi_wsync_seen |= (status->csi_status_raw & TC358743_MASK_S_WSYNC) != 0;
    status->csi_txact_seen |= (status->csi_status_raw & TC358743_MASK_S_TXACT) != 0;
    status->csi_rxact_seen |= (status->csi_status_raw & TC358743_MASK_S_RXACT) != 0;
    status->csi_hlt_seen |= (status->csi_status_raw & TC358743_MASK_S_HLT) != 0;
    err = read_u32_le(s_dev, TC358743_REG_CSI_ERR, &status->csi_error_raw);
    if (err != ESP_OK) return err;
    status->csi_error_seen |= status->csi_error_raw;
    err = read_u32_le(s_dev, TC358743_REG_CSI_INT, &status->csi_int_raw);
    if (err != ESP_OK) return err;
    err = read_u32_le(s_dev, TC358743_REG_CSI_INT_ENA, &status->csi_int_ena_raw);
    if (err != ESP_OK) return err;
    err = read_u32_le(s_dev, TC358743_REG_CSI_ERR_INTENA, &status->csi_err_intena_raw);
    if (err != ESP_OK) return err;
    err = read_u32_le(s_dev, TC358743_REG_CSI_ERR_HALT, &status->csi_err_halt_raw);
    if (err != ESP_OK) return err;
    err = read_u32_le(s_dev, TC358743_REG_TXOPTIONCNTRL, &status->csi_txoption_raw);
    if (err != ESP_OK) return err;
    err = read_u32_le(s_dev, TC358743_REG_STARTCNTRL, &status->csi_startcntrl_raw);
    if (err != ESP_OK) return err;
    return read_u32_le(s_dev, TC358743_REG_CSI_START, &status->csi_start_raw);
}

static esp_err_t tc358743_set_pll_capture(void)
{
    const uint16_t pllctl0 = (uint16_t)((((TC358743_CSI_PLL_PRD - 1U) << 12) & TC358743_MASK_PLL_PRD) |
                                       ((TC358743_CSI_PLL_FBD - 1U) & TC358743_MASK_PLL_FBD));

    esp_err_t err = update_u16_le(s_dev, TC358743_REG_SYSCTL, TC358743_MASK_SLEEP,
                                  TC358743_MASK_SLEEP, NULL);
    if (err != ESP_OK) return err;

    err = write_u16_le(s_dev, TC358743_REG_PLLCTL0, pllctl0);
    if (err != ESP_OK) return err;

    /* The proven 972 MHz lane clock is above 500 MHz, therefore PLL_FRS=0. */
    err = update_u16_le(s_dev, TC358743_REG_PLLCTL1,
                        TC358743_MASK_PLL_FRS | TC358743_MASK_RESETB | TC358743_MASK_PLL_EN,
                        TC358743_MASK_RESETB | TC358743_MASK_PLL_EN, NULL);
    if (err != ESP_OK) return err;

    /* Upstream requires at least 10 us before CKEN; 10 ms is conservative and guarantees at least one RTOS tick. */
    vTaskDelay(pdMS_TO_TICKS(10));
    err = update_u16_le(s_dev, TC358743_REG_PLLCTL1, TC358743_MASK_CKEN,
                        TC358743_MASK_CKEN, NULL);
    if (err != ESP_OK) return err;

    return update_u16_le(s_dev, TC358743_REG_SYSCTL, TC358743_MASK_SLEEP, 0, NULL);
}

static esp_err_t tc358743_reset_ctx_only(void)
{
    uint16_t sysctl = 0;
    esp_err_t err = read_u16_le(s_dev, TC358743_REG_SYSCTL, &sysctl);
    if (err != ESP_OK) return err;
    err = write_u16_le(s_dev, TC358743_REG_SYSCTL, (uint16_t)(sysctl | TC358743_MASK_CTXRST));
    if (err != ESP_OK) return err;
    return write_u16_le(s_dev, TC358743_REG_SYSCTL, (uint16_t)(sysctl & (uint16_t)~TC358743_MASK_CTXRST));
}

esp_err_t tc358743_configure_csi_tx_rgb888_2lane_972(void)
{
    if (s_dev == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    tc358743_status_t status;
    status_load(&status);
    esp_err_t err = refresh_live_status(&status);
    if (err != ESP_OK) {
        status.last_error = err;
        status_store(&status);
        return err;
    }
    if (!status.found || !status.timings.valid || !status.tmds || !status.sync || status.timings.interlaced) {
        status.last_error = ESP_ERR_INVALID_STATE;
        status_store(&status);
        ESP_LOGE(TAG, "CSI TX requires a stable progressive HDMI input before configuration");
        return ESP_ERR_INVALID_STATE;
    }

    /* M7.3 uses the real FT-710 external-display mode (800x480p) while retaining
     * the proven ESP32-P4/TC358743 RGB888 two-lane physical path at 972 Mbps/lane.
     * The lane clock is intentionally not reduced in this milestone: it is already
     * proven on this board and provides ample payload headroom for 800x480 RGB888. */
    if (status.timings.active_width != 800 || status.timings.active_height != 480) {
        status.last_error = ESP_ERR_NOT_SUPPORTED;
        status_store(&status);
        ESP_LOGE(TAG, "M7.3 CSI bring-up requires FT-710 800x480 input, got %ux%u",
                 status.timings.active_width, status.timings.active_height);
        return ESP_ERR_NOT_SUPPORTED;
    }

    status.csi_status_seen = 0;
    status.csi_status_stream_on_raw = 0;
    status.csi_wsync_seen = false;
    status.csi_txact_seen = false;
    status.csi_rxact_seen = false;
    status.csi_hlt_seen = false;
    status.csi_error_seen = 0;

    /* Keep CSI data muted while PLL and lane timing are reconfigured. */
    err = write_u8(s_dev, TC358743_REG_VI_MUTE, TC358743_MASK_AUTO_MUTE | TC358743_MASK_VI_MUTE);
    if (err != ESP_OK) goto fail;
    err = update_u16_le(s_dev, TC358743_REG_CONFCTL,
                        TC358743_MASK_VBUFEN | TC358743_MASK_ABUFEN, 0, NULL);
    if (err != ESP_OK) goto fail;

    err = write_u16_le(s_dev, TC358743_REG_FIFOCTL, TC358743_CSI_FIFO_LEVEL);
    if (err != ESP_OK) goto fail;
    err = tc358743_set_pll_capture();
    if (err != ESP_OK) goto fail;
    err = tc358743_reset_ctx_only();
    if (err != ESP_OK) goto fail;

    /* Two data lanes: clock, D0 and D1 enabled; D2/D3 disabled. */
    if ((err = write_u32_le(s_dev, TC358743_REG_CLW_CNTRL, 0)) != ESP_OK) goto fail;
    if ((err = write_u32_le(s_dev, TC358743_REG_D0W_CNTRL, 0)) != ESP_OK) goto fail;
    if ((err = write_u32_le(s_dev, TC358743_REG_D1W_CNTRL, 0)) != ESP_OK) goto fail;
    if ((err = write_u32_le(s_dev, TC358743_REG_D2W_CNTRL, TC358743_MASK_LANEDISABLE)) != ESP_OK) goto fail;
    if ((err = write_u32_le(s_dev, TC358743_REG_D3W_CNTRL, TC358743_MASK_LANEDISABLE)) != ESP_OK) goto fail;

    if ((err = write_u32_le(s_dev, TC358743_REG_LINEINITCNT, TC358743_CSI_LINEINITCNT)) != ESP_OK) goto fail;
    if ((err = write_u32_le(s_dev, TC358743_REG_LPTXTIMECNT, TC358743_CSI_LPTXTIMECNT)) != ESP_OK) goto fail;
    if ((err = write_u32_le(s_dev, TC358743_REG_TCLK_HEADERCNT, TC358743_CSI_TCLK_HEADERCNT)) != ESP_OK) goto fail;
    if ((err = write_u32_le(s_dev, TC358743_REG_TCLK_TRAILCNT, TC358743_CSI_TCLK_TRAILCNT)) != ESP_OK) goto fail;
    if ((err = write_u32_le(s_dev, TC358743_REG_THS_HEADERCNT, TC358743_CSI_THS_HEADERCNT)) != ESP_OK) goto fail;
    if ((err = write_u32_le(s_dev, TC358743_REG_TWAKEUP, TC358743_CSI_TWAKEUP)) != ESP_OK) goto fail;
    if ((err = write_u32_le(s_dev, TC358743_REG_TCLK_POSTCNT, TC358743_CSI_TCLK_POSTCNT)) != ESP_OK) goto fail;
    if ((err = write_u32_le(s_dev, TC358743_REG_THS_TRAILCNT, TC358743_CSI_THS_TRAILCNT)) != ESP_OK) goto fail;
    if ((err = write_u32_le(s_dev, TC358743_REG_HSTXVREGCNT, TC358743_CSI_HSTXVREGCNT)) != ESP_OK) goto fail;
    if ((err = write_u32_le(s_dev, TC358743_REG_HSTXVREGEN,
                            TC358743_MASK_CLM_HSTXVREGEN |
                            TC358743_MASK_D0M_HSTXVREGEN |
                            TC358743_MASK_D1M_HSTXVREGEN)) != ESP_OK) goto fail;

    /* Proven p4kvm/ESP-KVM path: non-continuous MIPI clock. */
    if ((err = write_u32_le(s_dev, TC358743_REG_TXOPTIONCNTRL, 0)) != ESP_OK) goto fail;
    if ((err = write_u32_le(s_dev, TC358743_REG_STARTCNTRL, TC358743_MASK_START)) != ESP_OK) goto fail;
    if ((err = write_u32_le(s_dev, TC358743_REG_CSI_START, TC358743_MASK_STRT)) != ESP_OK) goto fail;
    if ((err = write_u32_le(s_dev, TC358743_REG_CSI_CONFW,
                            TC358743_MASK_MODE_SET | TC358743_MASK_ADDRESS_CSI_CONTROL |
                            TC358743_MASK_CSI_MODE | TC358743_MASK_TXHSMD | TC358743_MASK_NOL_2)) != ESP_OK) goto fail;
    if ((err = write_u32_le(s_dev, TC358743_REG_CSI_CONFW,
                            TC358743_MASK_MODE_SET | TC358743_MASK_ADDRESS_CSI_ERR_INTENA |
                            TC358743_MASK_TXBRK | TC358743_MASK_QUNK |
                            TC358743_MASK_WCER | TC358743_MASK_INER)) != ESP_OK) goto fail;
    if ((err = write_u32_le(s_dev, TC358743_REG_CSI_CONFW,
                            TC358743_MASK_MODE_CLEAR | TC358743_MASK_ADDRESS_CSI_ERR_HALT |
                            TC358743_MASK_TXBRK | TC358743_MASK_QUNK)) != ESP_OK) goto fail;
    if ((err = write_u32_le(s_dev, TC358743_REG_CSI_CONFW,
                            TC358743_MASK_MODE_SET | TC358743_MASK_ADDRESS_CSI_INT_ENA |
                            TC358743_MASK_INTER)) != ESP_OK) goto fail;

    /* Proven rev<3 path: TC358743 RGB888 / CSI-2 Data Type 0x24. */
    if ((err = update_u8(s_dev, TC358743_REG_VOUT_SET2,
                         TC358743_MASK_SEL422 | TC358743_MASK_VOUT_422FIL_100,
                         0, NULL)) != ESP_OK) goto fail;
    if ((err = update_u8(s_dev, TC358743_REG_VI_REP, TC358743_MASK_VOUT_COLOR_SEL,
                         TC358743_VOUT_COLOR_RGB_FULL, NULL)) != ESP_OK) goto fail;
    if ((err = update_u16_le(s_dev, TC358743_REG_CONFCTL, TC358743_MASK_YCBCRFMT,
                             0, NULL)) != ESP_OK) goto fail;

    status.csi_tx_configured = true;
    status.csi_streaming = false;
    status.csi_data_lanes = TC358743_CSI_LANES;
    status.csi_lane_bit_rate_mbps = TC358743_CSI_LANE_MBPS;
    status.csi_pll_prd = TC358743_CSI_PLL_PRD;
    status.csi_pll_fbd = TC358743_CSI_PLL_FBD;
    status.last_error = ESP_OK;
    err = refresh_csi_tx_status(&status);
    if (err != ESP_OK) goto fail;
    status_store(&status);

    ESP_LOGI(TAG,
             "CSI TX configured: 2 lanes @ %u Mbps/lane, PLL PRD=%u FBD=%u, RGB888 DT=0x24, FIFO=%u",
             TC358743_CSI_LANE_MBPS, TC358743_CSI_PLL_PRD,
             TC358743_CSI_PLL_FBD, TC358743_CSI_FIFO_LEVEL);
    ESP_LOGI(TAG,
             "CSI TX readback: PLLCTL0=0x%04X PLLCTL1=0x%04X CSI_CONTROL=0x%04X CSI_STATUS=0x%04X "
             "[WSYNC=%d TXACT=%d RXACT=%d HLT=%d] CSI_ERR=0x%08" PRIX32,
             status.csi_pllctl0_raw, status.csi_pllctl1_raw, status.csi_control_raw,
             status.csi_status_raw,
             !!(status.csi_status_raw & TC358743_MASK_S_WSYNC),
             !!(status.csi_status_raw & TC358743_MASK_S_TXACT),
             !!(status.csi_status_raw & TC358743_MASK_S_RXACT),
             !!(status.csi_status_raw & TC358743_MASK_S_HLT),
             status.csi_error_raw);
    return ESP_OK;

fail:
    status.last_error = err;
    (void)refresh_csi_tx_status(&status);
    status_store(&status);
    ESP_LOGE(TAG, "CSI TX configuration failed: %s", esp_err_to_name(err));
    return err;
}

esp_err_t tc358743_set_csi_streaming(bool enable)
{
    if (s_dev == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    tc358743_status_t status;
    status_load(&status);
    if (enable && !status.csi_tx_configured) {
        return ESP_ERR_INVALID_STATE;
    }

    esp_err_t err;
    if (enable) {
        /* Proven ESP-KVM/p4kvm sequence: keep non-continuous clock and re-kick CSI_START. */
        err = write_u32_le(s_dev, TC358743_REG_TXOPTIONCNTRL, 0);
        if (err != ESP_OK) goto done;
        err = write_u32_le(s_dev, TC358743_REG_CSI_START, TC358743_MASK_STRT);
        if (err != ESP_OK) goto done;
        err = write_u8(s_dev, TC358743_REG_VI_MUTE, TC358743_MASK_AUTO_MUTE);
        if (err != ESP_OK) goto done;
        err = update_u16_le(s_dev, TC358743_REG_CONFCTL,
                            TC358743_MASK_VBUFEN | TC358743_MASK_ABUFEN,
                            TC358743_MASK_VBUFEN | TC358743_MASK_ABUFEN, NULL);
    } else {
        err = write_u8(s_dev, TC358743_REG_VI_MUTE,
                       TC358743_MASK_AUTO_MUTE | TC358743_MASK_VI_MUTE);
        if (err != ESP_OK) goto done;
        err = update_u16_le(s_dev, TC358743_REG_CONFCTL,
                            TC358743_MASK_VBUFEN | TC358743_MASK_ABUFEN, 0, NULL);
    }

done:
    if (err == ESP_OK) {
        status.csi_streaming = enable;
        status.last_error = ESP_OK;
    } else {
        status.last_error = err;
    }
    (void)refresh_csi_tx_status(&status);
    if (enable && err == ESP_OK) {
        status.csi_status_stream_on_raw = status.csi_status_raw;
    }
    status_store(&status);
    ESP_LOGI(TAG,
             "CSI TX streaming %s: CONFCTL=0x%04X CSI_CONTROL=0x%04X CSI_STATUS=0x%04X "
             "[WSYNC=%d TXACT=%d RXACT=%d HLT=%d] CSI_ERR=0x%08" PRIX32,
             enable ? "ON" : "OFF", status.csi_confctl_raw, status.csi_control_raw,
             status.csi_status_raw,
             !!(status.csi_status_raw & TC358743_MASK_S_WSYNC),
             !!(status.csi_status_raw & TC358743_MASK_S_TXACT),
             !!(status.csi_status_raw & TC358743_MASK_S_RXACT),
             !!(status.csi_status_raw & TC358743_MASK_S_HLT),
             status.csi_error_raw);
    return err;
}

esp_err_t tc358743_prepare_csi_source_before_p4(uint32_t lock_timeout_ms)
{
    if (s_dev == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    tc358743_status_t status;
    status_load(&status);
    if (!status.csi_tx_configured) {
        return ESP_ERR_INVALID_STATE;
    }

    /*
     * Match the proven ESP-KVM/p4kvm startup tail:
     *   stream OFF -> HPD LOW -> stream ON -> delay -> HPD HIGH -> delay -> CSI_START kick.
     * The important property is that the TC358743 is already emitting MIPI before
     * esp_cam_ctlr_start() arms the ESP32-P4 receiver.
     */
    esp_err_t err = tc358743_set_csi_streaming(false);
    if (err != ESP_OK) {
        return err;
    }

    err = update_u8(s_dev, TC358743_REG_HPD_CTL, TC358743_MASK_HPD_OUT0, 0, NULL);
    if (err != ESP_OK) {
        return err;
    }
    status_load(&status);
    status.hpd_high = false;
    (void)refresh_live_status(&status);
    status_store(&status);
    ESP_LOGI(TAG, "M5.5 pre-P4 retrain: stream OFF, HPD LOW");
    vTaskDelay(pdMS_TO_TICKS(150));

    /* ESP-KVM enables the video FIFO before raising HPD. */
    err = write_u32_le(s_dev, TC358743_REG_TXOPTIONCNTRL, 0);
    if (err != ESP_OK) return err;
    err = write_u8(s_dev, TC358743_REG_VI_MUTE, TC358743_MASK_AUTO_MUTE);
    if (err != ESP_OK) return err;
    err = update_u16_le(s_dev, TC358743_REG_CONFCTL,
                        TC358743_MASK_VBUFEN | TC358743_MASK_ABUFEN,
                        TC358743_MASK_VBUFEN | TC358743_MASK_ABUFEN, NULL);
    if (err != ESP_OK) return err;

    status_load(&status);
    status.csi_streaming = true;
    (void)refresh_csi_tx_status(&status);
    status.csi_status_stream_on_raw = status.csi_status_raw;
    status_store(&status);
    ESP_LOGI(TAG, "M5.5 pre-P4 retrain: video FIFO ON; delaying 150 ms before HPD edge");
    vTaskDelay(pdMS_TO_TICKS(150));

    err = update_u8(s_dev, TC358743_REG_HPD_CTL, TC358743_MASK_HPD_OUT0,
                    TC358743_MASK_HPD_OUT0, NULL);
    if (err != ESP_OK) return err;
    vTaskDelay(pdMS_TO_TICKS(50));

    /* Re-kick CSI after CONFCTL + HPD, exactly as the proven implementation does. */
    err = write_u32_le(s_dev, TC358743_REG_CSI_START, TC358743_MASK_STRT);
    if (err != ESP_OK) return err;

    const uint32_t step_ms = 50;
    uint32_t waited_ms = 0;
    for (;;) {
        status_load(&status);
        err = refresh_live_status(&status);
        if (err == ESP_OK) {
            (void)refresh_csi_tx_status(&status);
            status.csi_streaming = true;
            status.last_error = ESP_OK;
            status_store(&status);
            if (status.tmds && status.sync && status.timings.valid &&
                status.timings.active_width == 800 && status.timings.active_height == 480) {
                ESP_LOGI(TAG,
                         "M5.5 pre-P4 source ready after %" PRIu32 " ms: SYS_STATUS=0x%02X CSI_STATUS=0x%04X TXACT=%d",
                         waited_ms, status.sys_status_raw, status.csi_status_raw,
                         !!(status.csi_status_raw & TC358743_MASK_S_TXACT));
                return ESP_OK;
            }
        }

        if (waited_ms >= lock_timeout_ms) {
            break;
        }
        vTaskDelay(pdMS_TO_TICKS(step_ms));
        waited_ms += step_ms;
    }

    status_load(&status);
    status.last_error = ESP_ERR_TIMEOUT;
    status_store(&status);
    ESP_LOGE(TAG, "M5.5 pre-P4 HDMI/CSI source did not relock within %" PRIu32 " ms", lock_timeout_ms);
    return ESP_ERR_TIMEOUT;
}

esp_err_t tc358743_sample_csi_activity(void)
{
    if (s_dev == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    tc358743_status_t status;
    status_load(&status);
    esp_err_t err = refresh_csi_tx_status(&status);
    if (err == ESP_OK) {
        status.last_error = ESP_OK;
        status_store(&status);
    }
    return err;
}

esp_err_t tc358743_refresh_status(void)
{
    if (s_dev == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    tc358743_status_t status;
    status_load(&status);
    esp_err_t err = refresh_live_status(&status);
    if (err == ESP_OK) {
        (void)refresh_csi_tx_status(&status);
        status.last_error = ESP_OK;
    } else {
        status.last_error = err;
    }
    status_store(&status);
    return err;
}

void tc358743_get_status(tc358743_status_t *out_status)
{
    if (out_status != NULL) {
        status_load(out_status);
    }
}
