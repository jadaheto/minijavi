// Ajustes guardados en la memoria de la placa (NVS): redes Wi-Fi, direccion del servidor, pase y volumen.
#include <string.h>
#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "app.h"

static const char *TAG = "ajustes";
cfg_t g_cfg;

void cfg_load(void)
{
    memset(&g_cfg, 0, sizeof(g_cfg));
    strlcpy(g_cfg.url, "wss://yo.minijavi.com/ws", sizeof(g_cfg.url));
    g_cfg.volume = 70;
    nvs_handle_t h;
    if (nvs_open("javi", NVS_READONLY, &h) != ESP_OK) return;
    cfg_t saved; size_t len = sizeof(saved);
    if (nvs_get_blob(h, "cfg", &saved, &len) == ESP_OK && len == sizeof(saved)) {
        g_cfg = saved;
        // Lo guardado siempre termina en cero, pase lo que pase.
        for (int i = 0; i < CFG_NETS; i++) { g_cfg.ssid[i][32] = 0; g_cfg.pass[i][64] = 0; }
        g_cfg.url[sizeof(g_cfg.url) - 1] = 0; g_cfg.pase[sizeof(g_cfg.pase) - 1] = 0;
        if (g_cfg.volume < 0 || g_cfg.volume > 100) g_cfg.volume = 70;
    }
    nvs_close(h);
}

bool cfg_save(void)
{
    nvs_handle_t h;
    if (nvs_open("javi", NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t err = nvs_set_blob(h, "cfg", &g_cfg, sizeof(g_cfg));
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) ESP_LOGE(TAG, "no se pudieron guardar los ajustes: %s", esp_err_to_name(err));
    return err == ESP_OK;
}

bool cfg_complete(void)
{
    bool net = false;
    for (int i = 0; i < CFG_NETS; i++) if (g_cfg.ssid[i][0]) net = true;
    return net && g_cfg.pase[0] && (strncmp(g_cfg.url, "ws://", 5) == 0 || strncmp(g_cfg.url, "wss://", 6) == 0);
}
