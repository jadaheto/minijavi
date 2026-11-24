// Avisos que llegan solos (interesado nuevo, solicitud por aprobar, pago por revisar, taller, servicio caido).
// Sin conversacion abierta, la placa le pregunta al servidor con su pase:
//   - enchufada (cargando): deja la peticion esperando hasta 25 s, asi el aviso llega al instante;
//   - con bateria: pregunta cada 5 minutos, para no gastarla.
// El servidor no entrega nada en el horario silencioso. Lo que llega se muestra como tarjeta, con un tono corto.
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "app.h"

static const char *TAG = "avisos";
#define BATTERY_EVERY_S 300
#define BODY_MAX 6000

static int last_id;
static int shown_ids[TILE_MAX], shown_count;
static volatile bool seen_pending;
static int seen_ids[TILE_MAX], seen_count;
static char body[BODY_MAX]; static int body_len;

/** La direccion de la conversacion (wss://servidor/ws) convertida en la de los avisos (https://servidor/api/placa/...). */
static bool api_url(char *out, size_t cap, const char *path)
{
    const char *u = g_cfg.url, *scheme = !strncmp(u, "wss://", 6) ? "https://" : !strncmp(u, "ws://", 5) ? "http://" : NULL;
    if (!scheme) return false;
    const char *host = strstr(u, "://") + 3, *end = strchr(host, '/');
    int n = end ? (int)(end - host) : (int)strlen(host);
    return snprintf(out, cap, "%s%.*s/api/placa/%s", scheme, n, host, path) < (int)cap;
}

static esp_err_t on_http(esp_http_client_event_t *e)
{
    if (e->event_id == HTTP_EVENT_ON_DATA && e->data_len > 0 && body_len + e->data_len < BODY_MAX) { memcpy(body + body_len, e->data, (size_t)e->data_len); body_len += e->data_len; }
    return ESP_OK;
}

/** Una peticion con el pase. Devuelve el codigo HTTP (o -1) y deja la respuesta en `body`. */
static int request(const char *url, const char *post, int timeout_ms)
{
    char auth[sizeof(g_cfg.pase) + 8]; snprintf(auth, sizeof(auth), "Bearer %s", g_cfg.pase);
    esp_http_client_config_t cfg = { .url = url, .timeout_ms = timeout_ms, .event_handler = on_http, .method = post ? HTTP_METHOD_POST : HTTP_METHOD_GET };
    if (!strncmp(url, "https://", 8)) cfg.crt_bundle_attach = esp_crt_bundle_attach;
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) return -1;
    esp_http_client_set_header(c, "Authorization", auth);
    if (post) { esp_http_client_set_header(c, "Content-Type", "application/json"); esp_http_client_set_post_field(c, post, (int)strlen(post)); }
    body_len = 0;
    int status = esp_http_client_perform(c) == ESP_OK ? esp_http_client_get_status_code(c) : -1;
    body[body_len] = 0;
    esp_http_client_cleanup(c);
    memset(auth, 0, sizeof(auth));
    return status;
}

/** Tono corto de dos notas por el parlante. */
static void chime(void)
{
    static int16_t tone[AUDIO_RATE * 36 / 100]; // 0,36 s
    const int n = (int)(sizeof(tone) / sizeof(tone[0])), half = n / 2;
    for (int i = 0; i < n; i++) {
        float f = i < half ? 880.0f : 1320.0f, t = (float)(i < half ? i : i - half) / half, env = t < 0.08f ? t / 0.08f : (1.0f - t);
        tone[i] = (int16_t)(sinf(2.0f * (float)M_PI * f * i / AUDIO_RATE) * env * 7000.0f);
    }
    audio_begin(); audio_push((const uint8_t *)tone, sizeof(tone)); audio_end();
}

static void show(const cJSON *list, int seconds)
{
    static tile_t tiles[TILE_MAX]; int n = 0; const cJSON *t;
    cJSON_ArrayForEach(t, list) {
        const cJSON *id = cJSON_GetObjectItem(t, "id");
        if (cJSON_IsNumber(id) && id->valueint > last_id) last_id = id->valueint;
        if (n == TILE_MAX) continue;
        tile_t *o = &tiles[n]; memset(o, 0, sizeof(*o)); o->ring = -1; o->notice = cJSON_IsNumber(id) ? id->valueint : 0;
        const char *s; const cJSON *line; int lines = 0;
        if ((s = cJSON_GetStringValue(cJSON_GetObjectItem(t, "title")))) strlcpy(o->title, s, sizeof(o->title));
        if ((s = cJSON_GetStringValue(cJSON_GetObjectItem(t, "big")))) strlcpy(o->big, s, sizeof(o->big));
        s = cJSON_GetStringValue(cJSON_GetObjectItem(t, "tone"));
        o->tone = !s ? 0 : !strcmp(s, "ok") ? 1 : !strcmp(s, "warn") ? 2 : !strcmp(s, "bad") ? 3 : 0;
        cJSON_ArrayForEach(line, cJSON_GetObjectItem(t, "lines")) {
            const char *l = cJSON_GetStringValue(line);
            if (!l || lines == 3) continue;
            if (lines++) strlcat(o->lines, "\n", sizeof(o->lines));
            strlcat(o->lines, l, sizeof(o->lines));
        }
        shown_ids[n] = o->notice; n++;
    }
    if (!n || app_state() != ST_IDLE) return; // justo se abrio una conversacion: quedan pendientes en el servidor
    shown_count = n;
    ui_tiles(tiles, n, seconds);
    app_post(EV_NOTICE);
    chime();
}

int notices_shown(int *ids, int max) { int n = shown_count < max ? shown_count : max; memcpy(ids, shown_ids, sizeof(int) * (size_t)n); return n; }

/** Javier quito los avisos de la pantalla (o el avatar ya se los conto): se le dice al servidor en la siguiente vuelta. */
void notices_seen(void) { seen_count = shown_count; memcpy(seen_ids, shown_ids, sizeof(seen_ids)); shown_count = 0; seen_pending = true; }

static void task(void *arg)
{
    char url[220], post[120];
    int idle_s = BATTERY_EVERY_S; // la primera vez pregunta de una
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        if (!net_up() || !cfg_complete()) continue;
        if (seen_pending && api_url(url, sizeof(url), "avisos/vistos")) {
            int o = snprintf(post, sizeof(post), "{\"ids\":[");
            for (int i = 0; i < seen_count && o < (int)sizeof(post) - 16; i++) o += snprintf(post + o, sizeof(post) - (size_t)o, "%s%d", i ? "," : "", seen_ids[i]);
            snprintf(post + o, sizeof(post) - (size_t)o, "]}");
            if (request(url, post, 8000) == 201 || body_len >= 0) seen_pending = false;
        }
        if (app_state() != ST_IDLE || ui_tile_active()) { idle_s = 0; continue; } // en conversacion o con algo en pantalla: despues
        bool charging = false; power_battery_percent(&charging);
        if (!charging && ++idle_s < BATTERY_EVERY_S) continue;
        idle_s = 0;
        snprintf(post, sizeof(post), "avisos?desde=%d&espera=%d", last_id, charging ? 25 : 0);
        if (!api_url(url, sizeof(url), post)) continue;
        int status = request(url, NULL, charging ? 32000 : 10000);
        if (status == 200) {
            cJSON *m = cJSON_Parse(body);
            const cJSON *list = cJSON_GetObjectItem(m, "notices"), *sec = cJSON_GetObjectItem(m, "seconds");
            if (cJSON_IsArray(list) && cJSON_GetArraySize(list) > 0) show(list, cJSON_IsNumber(sec) ? sec->valueint : 40);
            cJSON_Delete(m);
        } else if (status == 401 || status == 429) { ESP_LOGW(TAG, "el servidor no acepto el pase para los avisos (%d)", status); vTaskDelay(pdMS_TO_TICKS(120000)); }
        else vTaskDelay(pdMS_TO_TICKS(15000)); // sin red o servidor caido: se reintenta con calma
    }
}

void notices_start(void) { xTaskCreatePinnedToCore(task, "avisos", 8192, NULL, 3, NULL, 0); }
