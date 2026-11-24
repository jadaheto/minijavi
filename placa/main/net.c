// Wi-Fi: prueba las redes guardadas (hasta tres) una tras otra y se queda con la primera que conecte. Si se cae, reintenta.
#include <string.h>
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "app.h"

static const char *TAG = "wifi";
static volatile bool up;
static int current = -1, fails;
static volatile bool paused; // con la pagina de ajustes abierta no se buscan redes

static bool try_next(void)
{
    for (int i = 1; i <= CFG_NETS; i++) {
        int n = (current + i + CFG_NETS) % CFG_NETS;
        if (!g_cfg.ssid[n][0]) continue;
        wifi_config_t wc = { 0 };
        strlcpy((char *)wc.sta.ssid, g_cfg.ssid[n], sizeof(wc.sta.ssid));
        strlcpy((char *)wc.sta.password, g_cfg.pass[n], sizeof(wc.sta.password));
        wc.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
        current = n;
        esp_wifi_set_config(WIFI_IF_STA, &wc);
        ESP_LOGI(TAG, "probando la red %d", n + 1);
        return esp_wifi_connect() == ESP_OK;
    }
    return false;
}

static void on_wifi(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (paused) return;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) { current = -1; try_next(); }
    else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        if (up) { up = false; app_post(EV_WIFI_DOWN); }
        // La misma red dos veces (un corte corto) y despues la siguiente.
        if (++fails % 2 == 1 && current >= 0) esp_wifi_connect(); else try_next();
    }
    else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) { fails = 0; up = true; app_post(EV_WIFI_UP); }
}

void net_start(void)
{
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi, NULL, NULL);
    esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi, NULL, NULL);
    esp_wifi_set_storage(WIFI_STORAGE_RAM); // las claves viven en nuestros ajustes, no en una copia del controlador
    esp_wifi_set_mode(WIFI_MODE_STA);
    esp_wifi_start();
}

bool net_up(void) { return up; }
void net_pause(void) { paused = true; up = false; }
