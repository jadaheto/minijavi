// Bateria: el chip de carga (AXP2101, direccion 0x34 en el bus I2C de la placa) da el porcentaje en el registro 0xA4
// y el estado de carga en el registro 0x01 (bits 6-5 = 01: cargando). Valores del ejemplo 01_AXP2101 de Waveshare.
#include "bsp/esp-bsp.h"
#include "driver/i2c_master.h"
#include "app.h"

static i2c_master_dev_handle_t pmu;

static bool pmu_read(uint8_t reg, uint8_t *value)
{
    if (!pmu) {
        if (bsp_i2c_init() != ESP_OK) return false;
        i2c_device_config_t dev = { .dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = 0x34, .scl_speed_hz = 100000 };
        if (i2c_master_bus_add_device(bsp_i2c_get_handle(), &dev, &pmu) != ESP_OK) { pmu = NULL; return false; }
    }
    return i2c_master_transmit_receive(pmu, &reg, 1, value, 1, 100) == ESP_OK;
}

int power_battery_percent(bool *charging)
{
    uint8_t pct = 0, st = 0;
    if (!pmu_read(0xA4, &pct) || pct > 100) return -1;
    if (charging) *charging = pmu_read(0x01, &st) && ((st >> 5) & 0x03) == 0x01;
    return pct;
}
