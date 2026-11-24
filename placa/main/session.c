// Conversacion con el servidor de minijavi por WebSocket, con el formato del "Javi de bolsillo":
//   placa -> servidor: {"type":"hello","gadget":"<pase>","rate":16000}, audio del microfono en binario (PCM16, 16 kHz,
//                      tramas de 40 ms), {"type":"playback","playing":bool}, {"type":"stop"} (cortar), {"type":"wake"},
//                      {"type":"music","cmd":"pausar|continuar|siguiente|anterior"} (toques en la tarjeta de musica)
//   servidor -> placa: ready, error, user_final, speech_start, mouth, speech_end, reaction, suspend, interrupt, tile
//                      (tarjetas de datos) y la voz en
//                      binario: 4 bytes (1, 0, numero de la respuesta en 16 bits) + PCM16 mono; y la caratula de lo que
//                      suena: 6 bytes (2, 0, ancho, alto) + 150 x 150 puntos en RGB565
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "app.h"

static const char *TAG = "sesion";
static esp_websocket_client_handle_t ws;
static volatile bool live, closing;
static int speech_id = -1;
static bool frame_ok;            // la trama binaria en curso es voz de la respuesta actual
static int bin_kind;             // tipo de la trama binaria en curso: 1 voz, 2 caratula
static uint8_t *cover; static size_t cover_len; static int cover_w, cover_h; // caratula que va llegando por pedazos
static int last_op;
static char *text; static size_t text_len, text_cap;
static char last_error[24];
static volatile int64_t mic_resume_at;
static int tell_ids[TILE_MAX], tell_count; // avisos que Javier toco: van en el saludo para que el avatar los cuente
static SemaphoreHandle_t ws_lock; // el microfono envia desde otra tarea: la conexion no se puede destruir a mitad de un envio

bool session_live(void) { return live; }
const char *session_last_error(void) { return last_error; }

void session_send_json(const char *json) { if (ws && esp_websocket_client_is_connected(ws)) esp_websocket_client_send_text(ws, json, (int)strlen(json), pdMS_TO_TICKS(1000)); }

// Microfono: solo se envia con la conversacion abierta y mientras el avatar NO habla. La placa aun no cancela el eco:
// si enviara lo que oye mientras suena, el servidor oiria al propio avatar y se interrumpiria solo.
static void on_mic(const int16_t *pcm, size_t samples)
{
    app_state_t st = app_state();
    if (!live || !(st == ST_LISTENING || st == ST_THINKING || st == ST_AWAY) || audio_playing() || esp_timer_get_time() < mic_resume_at) return;
    if (xSemaphoreTake(ws_lock, 0) != pdTRUE) return;
    if (ws && live) esp_websocket_client_send_bin(ws, (const char *)pcm, (int)(samples * 2), pdMS_TO_TICKS(100));
    xSemaphoreGive(ws_lock);
}

static void on_json(const char *raw)
{
    cJSON *m = cJSON_Parse(raw);
    if (!m) return;
    const char *type = cJSON_GetStringValue(cJSON_GetObjectItem(m, "type"));
    const cJSON *id = cJSON_GetObjectItem(m, "id");
    if (!type) { cJSON_Delete(m); return; }
    if (!strcmp(type, "ready")) { live = true; last_error[0] = 0; app_post(EV_WS_READY); }
    else if (!strcmp(type, "error")) { const char *r = cJSON_GetStringValue(cJSON_GetObjectItem(m, "reason")); strlcpy(last_error, r ? r : "", sizeof(last_error)); }
    else if (!strcmp(type, "user_final")) app_post(EV_USER_FINAL);
    else if (!strcmp(type, "speech_start") && cJSON_IsNumber(id)) { speech_id = id->valueint; mouth_reset(); audio_begin(); }
    else if (!strcmp(type, "speech_end") && cJSON_IsNumber(id) && id->valueint == speech_id) audio_end();
    else if (!strcmp(type, "mouth") && cJSON_IsNumber(id) && id->valueint == speech_id) {
        const cJSON *k; cJSON_ArrayForEach(k, cJSON_GetObjectItem(m, "k")) {
            const cJSON *ms = cJSON_GetArrayItem(k, 0); const char *f = cJSON_GetStringValue(cJSON_GetArrayItem(k, 1));
            if (cJSON_IsNumber(ms) && f) mouth_add((uint32_t)ms->valuedouble, f[0] == '-' ? -1 : face_frame(FACE_MOUTH, f));
        }
    }
    else if (!strcmp(type, "tile")) { // tarjetas de datos: titulo, cifra, unidad, anillo, tono y hasta tres renglones
        static tile_t list[TILE_MAX]; int n = 0; const cJSON *t;
        cJSON_ArrayForEach(t, cJSON_GetObjectItem(m, "tiles")) {
            if (n == TILE_MAX) break;
            tile_t *o = &list[n]; memset(o, 0, sizeof(*o));
            const char *s;
            if ((s = cJSON_GetStringValue(cJSON_GetObjectItem(t, "title")))) strlcpy(o->title, s, sizeof(o->title));
            if ((s = cJSON_GetStringValue(cJSON_GetObjectItem(t, "big")))) strlcpy(o->big, s, sizeof(o->big));
            if ((s = cJSON_GetStringValue(cJSON_GetObjectItem(t, "unit")))) strlcpy(o->unit, s, sizeof(o->unit));
            const cJSON *ring = cJSON_GetObjectItem(t, "ring"), *line; int lines = 0;
            o->ring = cJSON_IsNumber(ring) ? (ring->valueint < 0 ? 0 : ring->valueint > 100 ? 100 : ring->valueint) : -1;
            s = cJSON_GetStringValue(cJSON_GetObjectItem(t, "tone"));
            o->tone = !s ? 0 : !strcmp(s, "ok") ? 1 : !strcmp(s, "warn") ? 2 : !strcmp(s, "bad") ? 3 : 0;
            s = cJSON_GetStringValue(cJSON_GetObjectItem(t, "kind"));
            o->music = s && !strcmp(s, "music"); o->cover = cJSON_IsTrue(cJSON_GetObjectItem(t, "cover")); o->playing = !cJSON_IsFalse(cJSON_GetObjectItem(t, "playing"));
            cJSON_ArrayForEach(line, cJSON_GetObjectItem(t, "lines")) {
                const char *l = cJSON_GetStringValue(line);
                if (!l || lines == 3) continue;
                if (lines++) strlcat(o->lines, "\n", sizeof(o->lines));
                strlcat(o->lines, l, sizeof(o->lines));
            }
            if (o->big[0] || o->title[0]) n++;
        }
        const cJSON *sec = cJSON_GetObjectItem(m, "seconds");
        ui_tiles(list, n, cJSON_IsNumber(sec) ? sec->valueint : 12);
    }
    else if (!strcmp(type, "reaction")) mind_react(cJSON_GetStringValue(cJSON_GetObjectItem(m, "name")));
    else if (!strcmp(type, "suspend")) app_post(cJSON_IsTrue(cJSON_GetObjectItem(m, "on")) ? EV_SUSPEND_ON : EV_SUSPEND_OFF);
    else if (!strcmp(type, "interrupt")) { speech_id = -1; audio_flush(); app_post(EV_INTERRUPT); }
    cJSON_Delete(m);
}

static void on_event(void *arg, esp_event_base_t base, int32_t event, void *data)
{
    esp_websocket_event_data_t *d = data;
    switch (event) {
        case WEBSOCKET_EVENT_CONNECTED: {
            cJSON *h = cJSON_CreateObject();
            cJSON_AddStringToObject(h, "type", "hello"); cJSON_AddStringToObject(h, "gadget", g_cfg.pase); cJSON_AddNumberToObject(h, "rate", AUDIO_RATE);
            if (tell_count) { cJSON_AddItemToObject(h, "notice", cJSON_CreateIntArray(tell_ids, tell_count)); tell_count = 0; }
            char *s = cJSON_PrintUnformatted(h);
            if (s) { esp_websocket_client_send_text(ws, s, (int)strlen(s), pdMS_TO_TICKS(2000)); memset(s, 0, strlen(s)); free(s); } // el pase no se queda en memoria suelta
            cJSON_Delete(h);
            break;
        }
        case WEBSOCKET_EVENT_DATA: {
            bool first = d->payload_offset == 0 && d->op_code != 0; // inicio de un mensaje (no un pedazo de continuacion)
            if (first) last_op = d->op_code;
            if (last_op == 2) { // voz
                const uint8_t *p = (const uint8_t *)d->data_ptr; size_t n = (size_t)d->data_len;
                if (first) {
                    bin_kind = n >= 1 ? p[0] : 0;
                    if (bin_kind == 2) { // caratula: 6 bytes (2, 0, ancho, alto) y los puntos; llega en varios pedazos
                        cover_len = 0; cover_w = n >= 6 ? (p[2] | (p[3] << 8)) : 0; cover_h = n >= 6 ? (p[4] | (p[5] << 8)) : 0;
                        if (cover_w != COVER_SIDE || cover_h != COVER_SIDE || d->payload_len != 6 + COVER_SIDE * COVER_SIDE * 2) bin_kind = 0;
                        else { if (!cover) cover = heap_caps_malloc(COVER_SIDE * COVER_SIDE * 2, MALLOC_CAP_SPIRAM); if (!cover) bin_kind = 0; p += 6; n -= 6; }
                    } else {
                        frame_ok = n >= 4 && p[0] == 1 && (p[2] | (p[3] << 8)) == (speech_id & 0xffff);
                        if (n >= 4) { p += 4; n -= 4; } else n = 0;
                    }
                }
                if (bin_kind == 2) {
                    if (cover && cover_len + n <= COVER_SIDE * COVER_SIDE * 2) { memcpy(cover + cover_len, p, n); cover_len += n; }
                    if (cover && cover_len == COVER_SIDE * COVER_SIDE * 2 && d->payload_offset + d->data_len >= d->payload_len) { ui_cover(cover, cover_w, cover_h); cover_len = 0; }
                }
                else if (bin_kind == 1 && frame_ok && n) audio_push(p, n);
            } else if (last_op == 1) { // mensaje en JSON, que puede llegar en varios pedazos
                if (first) text_len = 0;
                size_t need = text_len + (size_t)d->data_len + 1;
                if (need > 64 * 1024) { text_len = 0; break; }
                if (need > text_cap) { char *t = realloc(text, need); if (!t) { text_len = 0; break; } text = t; text_cap = need; }
                memcpy(text + text_len, d->data_ptr, (size_t)d->data_len); text_len += (size_t)d->data_len;
                if (d->payload_offset + d->data_len >= d->payload_len && d->fin) { text[text_len] = 0; on_json(text); text_len = 0; }
            }
            break;
        }
        case WEBSOCKET_EVENT_ERROR:
            ESP_LOGW(TAG, "error de conexion (tipo %d, respuesta %d)", d->error_handle.error_type, d->error_handle.esp_ws_handshake_status_code);
            break;
        case WEBSOCKET_EVENT_DISCONNECTED:
        case WEBSOCKET_EVENT_CLOSED:
            if (!closing) { closing = true; live = false; audio_flush(); app_post(EV_WS_CLOSED); }
            break;
        default: break;
    }
}

void session_tell(const int *notice_ids, int count) { tell_count = count > TILE_MAX ? TILE_MAX : count < 0 ? 0 : count; memcpy(tell_ids, notice_ids, sizeof(int) * (size_t)tell_count); }

void session_open(void)
{
    if (!ws_lock) ws_lock = xSemaphoreCreateMutex();
    if (ws) return;
    esp_websocket_client_config_t cfg = {
        .uri = g_cfg.url,
        .buffer_size = 8192,                 // una trama de voz (4.100 bytes) cabe entera
        .task_stack = 8192,
        .disable_auto_reconnect = true,      // si se cae, se vuelve a abrir con un toque
        .network_timeout_ms = 10000,
        .ping_interval_sec = 15,
    };
    if (strncmp(g_cfg.url, "wss://", 6) == 0) cfg.crt_bundle_attach = esp_crt_bundle_attach;
    closing = false; live = false; speech_id = -1; last_op = 0; text_len = 0; last_error[0] = 0;
    ws = esp_websocket_client_init(&cfg);
    if (!ws) { app_post(EV_WS_CLOSED); return; }
    esp_websocket_register_events(ws, WEBSOCKET_EVENT_ANY, on_event, NULL);
    audio_on_mic(on_mic);
    if (esp_websocket_client_start(ws) != ESP_OK) { closing = true; app_post(EV_WS_CLOSED); }
}

/** Se llama desde la tarea principal (nunca desde el propio aviso del WebSocket). */
void session_close(void)
{
    if (!ws) return;
    live = false; closing = true;
    audio_flush();
    xSemaphoreTake(ws_lock, portMAX_DELAY);
    esp_websocket_client_handle_t old = ws; ws = NULL;
    xSemaphoreGive(ws_lock);
    esp_websocket_client_stop(old);
    esp_websocket_client_destroy(old);
}

/** Tras sonar la respuesta se espera un instante antes de volver a enviar el microfono (la cola del parlante). */
void session_mic_pause(int ms) { mic_resume_at = esp_timer_get_time() + (int64_t)ms * 1000; }
