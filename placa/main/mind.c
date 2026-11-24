// Que recorte toca en cada momento: parpadeo, mirada, cejas, sonrisa, reacciones y la boca que dicta el servidor.
// Es la misma logica de public/js/cara2d.js (createMind), sin el vaiven de la cabeza: mover toda la cara obliga a
// redibujar la pantalla completa en cada cuadro y eso hay que medirlo con la placa en la mano.
#include <string.h>
#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "app.h"

static float rnd(float a, float b) { return a + (b - a) * (esp_random() / 4294967296.0f); }

// ---------- boca que manda el servidor: [milisegundo, cuadro] ----------
#define KEYS 2048
static struct { uint32_t ms; int16_t frame; } keys[KEYS];
static int k_head, k_count, k_last = -2;
static portMUX_TYPE k_lock = portMUX_INITIALIZER_UNLOCKED;

void mouth_reset(void) { taskENTER_CRITICAL(&k_lock); k_head = 0; k_count = 0; k_last = -2; taskEXIT_CRITICAL(&k_lock); }

void mouth_add(uint32_t ms, int frame)
{
    taskENTER_CRITICAL(&k_lock);
    if (k_count == KEYS) { k_head = (k_head + 1) % KEYS; k_count--; } // respuesta larguisima: se pierde lo mas viejo
    int i = (k_head + k_count) % KEYS; keys[i].ms = ms; keys[i].frame = (int16_t)frame; k_count++;
    taskEXIT_CRITICAL(&k_lock);
}

int mouth_at(uint32_t ms)
{
    taskENTER_CRITICAL(&k_lock);
    while (k_count > 0 && keys[k_head].ms <= ms) { k_last = keys[k_head].frame; k_head = (k_head + 1) % KEYS; k_count--; }
    int out = k_last;
    taskEXIT_CRITICAL(&k_lock);
    return out;
}

// ---------- gestos ----------
static float clock_s, blink_at = 2.0f, blink_t = -1.0f, gaze_at, brow_pulse, expr_t;
static char expr[16];
static const char *gaze = "frente";
static app_state_t last_state = ST_BOOT;

void mind_react(const char *name) { strlcpy(expr, name ? name : "", sizeof(expr)); expr_t = 0; }
void mind_raise_brows(void) { brow_pulse = 0.45f; }
static bool is(const char *name) { return strcmp(expr, name) == 0; }

void mind_tick(int dt_ms)
{
    float dt = dt_ms / 1000.0f;
    app_state_t st = app_state();
    clock_s += dt;
    if (st != last_state) { last_state = st; gaze_at = 0; }
    if (expr[0]) { expr_t += dt; if (expr_t >= 2.8f) expr[0] = 0; }
    bool away = st == ST_AWAY, resting = st == ST_IDLE || st == ST_NOWIFI || st == ST_CONNECTING;

    // Ojos: parpadeo irregular (a veces doble); la mirada se va a un lado al pensar o al esperar.
    const char *eyes = NULL;
    if (blink_t < 0 && clock_s >= blink_at) blink_t = 0;
    if (blink_t >= 0) {
        blink_t += dt; eyes = blink_t < 0.04f ? "medio" : blink_t < 0.11f ? "cerrados" : "medio";
        if (blink_t >= 0.15f) { blink_t = -1; eyes = NULL; blink_at = clock_s + (rnd(0, 1) < 0.18f ? rnd(0.12f, 0.25f) : rnd(1.8f, 5.5f)); }
    }
    if (clock_s >= gaze_at) {
        gaze_at = clock_s + rnd(0.9f, 2.8f);
        gaze = st == ST_THINKING ? "pensando" : resting ? (rnd(0, 1) < 0.45f ? "frente" : rnd(0, 1) < 0.5f ? "izquierda" : "derecha") : "frente";
    }
    if (away) eyes = "cerrados";
    else if (!eyes) eyes = is("risa") ? "medio" : is("pensativo") ? "pensando" : gaze;

    // Cejas: pulso al empezar a hablar, algo arriba al escuchar, y las de cada reaccion.
    brow_pulse = brow_pulse > dt ? brow_pulse - dt : 0;
    const char *brows = "reposo";
    if (is("sorpresa") || is("celebracion")) brows = "arriba2";
    else if (is("pena")) brows = "tristes";
    else if (is("pensativo")) brows = "ceno";
    else if (is("alegria") || is("despedida") || is("dinero")) brows = "arriba1";
    else if (brow_pulse > 0.2f) brows = "arriba2";
    else if (brow_pulse > 0 || st == ST_LISTENING) brows = "arriba1";

    // Boca: primero lo que se esta diciendo (lo dicta el servidor); si no habla, el gesto de la reaccion o la sonrisa.
    int mouth = -1;
    if (st == ST_SPEAKING && audio_playing()) { int m = mouth_at(audio_clock_ms()); if (m >= 0) mouth = m; }
    if (mouth < 0) {
        const char *name = "reposo";
        if (is("pena")) name = "triste";
        else if (is("sorpresa")) name = "o1";
        else if (is("alegria") || is("risa") || is("celebracion") || is("despedida") || is("dinero")) name = "sonrisa2";
        else if (st == ST_LISTENING || resting) name = "sonrisa1";
        mouth = face_frame(FACE_MOUTH, name);
    }
    face_show(FACE_BROWS, face_frame(FACE_BROWS, brows));
    face_show(FACE_EYES, face_frame(FACE_EYES, eyes));
    face_show(FACE_MOUTH, mouth);
}
