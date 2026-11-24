// Javi de bolsillo: piezas compartidas del programa de la placa.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// ---------- estado general ----------
typedef enum {
    ST_BOOT,        // arrancando
    ST_SETUP,       // pagina de ajustes abierta (la placa es un punto de acceso Wi-Fi)
    ST_NOWIFI,      // no encuentra ninguna de las redes guardadas
    ST_IDLE,        // con Wi-Fi, sin conversacion: un toque la abre
    ST_CONNECTING,  // abriendo la conversacion con el servidor
    ST_LISTENING,   // conversacion abierta, oyendo
    ST_THINKING,    // el servidor ya tiene la frase y prepara la respuesta
    ST_SPEAKING,    // sonando la respuesta
    ST_AWAY,        // suspendido ("silenciate"): oye pero no responde hasta despertarlo
} app_state_t;

typedef enum {
    EV_TOUCH, EV_LONG_TOUCH,
    EV_WIFI_UP, EV_WIFI_DOWN,
    EV_WS_READY, EV_WS_CLOSED,
    EV_USER_FINAL, EV_SUSPEND_ON, EV_SUSPEND_OFF, EV_INTERRUPT,
    EV_PLAY_START, EV_PLAY_STOP,
} app_event_t;

void app_post(app_event_t ev);
app_state_t app_state(void);

// ---------- ajustes guardados (config.c) ----------
#define CFG_NETS 3
typedef struct {
    char ssid[CFG_NETS][33];
    char pass[CFG_NETS][65];
    char url[128];      // direccion del servidor, por ejemplo wss://yo.minijavi.com/ws
    char pase[200];     // pase del dispositivo (panel -> Dispositivos -> Javi de bolsillo)
    int32_t volume;     // 0 a 100
} cfg_t;
extern cfg_t g_cfg;
void cfg_load(void);
bool cfg_save(void);
bool cfg_complete(void);   // hay al menos una red, direccion y pase

// ---------- pagina de ajustes (portal.c) ----------
void portal_run(void);     // no vuelve: al guardar, la placa se reinicia

// ---------- Wi-Fi (net.c) ----------
void net_start(void);
bool net_up(void);
void net_pause(void);

// ---------- cara (face.c) ----------
enum { FACE_BROWS, FACE_EYES, FACE_MOUTH, FACE_LAYERS };
bool face_load(void);                        // abre la particion "cara"
int face_side(void);
int face_frame(int layer, const char *name); // numero del cuadro o -1
struct _lv_obj_t;
void face_build(struct _lv_obj_t *parent);   // crea las imagenes (dentro del candado de la pantalla)
void face_show(int layer, int frame);        // cambia un recorte (dentro del candado de la pantalla)
void face_visible(bool on);

// ---------- pantalla (ui.c) ----------
void ui_start(void);
void ui_message(const char *text);           // texto grande en vez de la cara (ajustes, errores); NULL = volver a la cara
void ui_note(const char *text, int seconds); // aviso corto bajo la cara
void ui_battery(int percent, bool charging);

// ---------- gestos de la cara (mind.c) ----------
void mind_react(const char *name);
void mind_raise_brows(void);
void mind_tick(int dt_ms);                   // lo llama la pantalla ~25 veces por segundo
void mouth_reset(void);
void mouth_add(uint32_t ms, int frame);      // frame: numero de cuadro de la boca, o -1 = boca quieta
int mouth_at(uint32_t ms);                   // -2 = aun no hay dato

// ---------- audio (audio.c) ----------
#define AUDIO_RATE 16000
bool audio_start(void);
void audio_volume(int percent);
void audio_begin(void);                              // empieza una respuesta: vacia lo anterior
void audio_push(const uint8_t *pcm, size_t bytes);   // PCM16 mono a AUDIO_RATE
void audio_end(void);                                // no llega mas audio de esta respuesta
void audio_flush(void);                              // cortar ya
bool audio_playing(void);
uint32_t audio_clock_ms(void);                       // milisegundos de la respuesta que ya sonaron
typedef void (*audio_mic_cb_t)(const int16_t *pcm, size_t samples);
void audio_on_mic(audio_mic_cb_t cb);                // tramas de 40 ms del microfono

// ---------- conversacion (session.c) ----------
void session_open(void);
void session_close(void);
bool session_live(void);
void session_send_json(const char *json);
const char *session_last_error(void);
void session_mic_pause(int ms);

// ---------- bateria (power.c) ----------
int power_battery_percent(bool *charging);           // -1 si no se pudo leer
