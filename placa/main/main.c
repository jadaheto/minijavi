// Javi de bolsillo. Programa de la placa Waveshare ESP32-S3-Touch-AMOLED-1.75C.
//
// Que hace: muestra la cara 2D del avatar y conversa por voz con el servidor de minijavi en modo dueño.
//   - Un toque abre la conversacion; desde ahi oye con manos libres hasta que el servidor la cierra por inactividad.
//   - Mientras el avatar habla el microfono no se envia (aun no hay cancelacion de eco): se le corta con un toque.
//   - Dejar el dedo 3 s (o tener oprimido BOOT al encender) abre la pagina de ajustes.
#include <stdio.h>
#include <string.h>
#include "bsp/esp-bsp.h"
#include "driver/gpio.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "app.h"

#define BOOT_BUTTON GPIO_NUM_0      // boton BOOT (el pin de arranque de todo ESP32-S3; sin confirmar en el esquema de esta placa)
#define DIM_AFTER_S 45              // sin conversacion: baja el brillo
#define SLEEP_AFTER_S 300           // y despues apaga la pantalla (un toque la enciende)

static QueueHandle_t events;
static volatile app_state_t state = ST_BOOT;
static int64_t idle_since;
static int brightness = 100;

void app_post(app_event_t ev) { if (events) xQueueSend(events, &ev, 0); }
app_state_t app_state(void) { return state; }

static void set_state(app_state_t s) { state = s; if (s == ST_IDLE || s == ST_NOWIFI) idle_since = esp_timer_get_time(); }
static void light(int percent) { if (percent != brightness) { brightness = percent; bsp_display_brightness_set(percent); } }

static const char *why_closed(void)
{
    const char *e = session_last_error();
    if (!strcmp(e, "pase")) return "Pase inválido o vencido";
    if (!strcmp(e, "ocupado")) return "Servidor ocupado";
    if (!strcmp(e, "sin_voz")) return "El servidor no tiene voz";
    if (!strcmp(e, "inactividad") || !strcmp(e, "tiempo") || !strcmp(e, "suspension")) return "";
    return "";
}

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) { nvs_flash_erase(); nvs_flash_init(); }
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    events = xQueueCreate(16, sizeof(app_event_t));
    cfg_load();

    gpio_config_t boot = { .pin_bit_mask = 1ULL << BOOT_BUTTON, .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE };
    gpio_config(&boot);
    bool want_setup = gpio_get_level(BOOT_BUTTON) == 0;

    bool has_face = face_load();
    ui_start();
    if (!has_face) { ui_message("Falta la cara.\nVuelve a cargar\nel programa completo."); vTaskDelay(portMAX_DELAY); }

    net_start();
    if (want_setup || !cfg_complete()) { set_state(ST_SETUP); portal_run(); }

    if (!audio_start()) ui_note("Sin audio", 0);
    set_state(ST_NOWIFI);
    ui_note("Buscando Wi-Fi...", 0);

    bool connecting_shown = false, had_ready = false, want_open = false;
    int64_t last_battery = 0;
    for (;;) {
        app_event_t ev;
        if (xQueueReceive(events, &ev, pdMS_TO_TICKS(250)) == pdTRUE) {
            switch (ev) {
                case EV_WIFI_UP:
                    if (state == ST_NOWIFI) { set_state(ST_IDLE); ui_note("Toca para hablar", 6); }
                    break;
                case EV_WIFI_DOWN:
                    session_close(); set_state(ST_NOWIFI); ui_note("Sin Wi-Fi", 0);
                    break;
                case EV_TOUCH:
                    light(100); idle_since = esp_timer_get_time();
                    if (ui_tile_active()) { ui_tile_dismiss(); break; } // con una tarjeta en pantalla, el toque la quita
                    if (state == ST_IDLE) want_open = true;
                    else if (state == ST_NOWIFI) ui_note("Sin Wi-Fi", 4);
                    else if (state == ST_SPEAKING) { audio_flush(); session_send_json("{\"type\":\"stop\"}"); }
                    else if (state == ST_AWAY) session_send_json("{\"type\":\"wake\"}");
                    break;
                case EV_LONG_TOUCH:
                    session_close(); ui_tile_dismiss(); set_state(ST_SETUP); portal_run();
                    break;
                case EV_WS_READY:
                    had_ready = true; connecting_shown = false; ui_note("", 0); set_state(ST_LISTENING);
                    break;
                case EV_WS_CLOSED: {
                    const char *why = why_closed();
                    session_close(); set_state(net_up() ? ST_IDLE : ST_NOWIFI);
                    ui_note(why[0] ? why : had_ready ? "" : "No pude conectar", why[0] || !had_ready ? 6 : 0);
                    had_ready = false; connecting_shown = false;
                    break;
                }
                case EV_USER_FINAL: if (state == ST_LISTENING) set_state(ST_THINKING); break;
                case EV_PLAY_START:
                    if (session_live()) { set_state(ST_SPEAKING); mind_raise_brows(); session_send_json("{\"type\":\"playback\",\"playing\":true}"); }
                    break;
                case EV_PLAY_STOP:
                    if (session_live()) { session_mic_pause(350); session_send_json("{\"type\":\"playback\",\"playing\":false}"); if (state == ST_SPEAKING || state == ST_THINKING) set_state(ST_LISTENING); }
                    break;
                case EV_INTERRUPT: if (state == ST_SPEAKING || state == ST_THINKING) set_state(ST_LISTENING); break;
                case EV_MUSIC_TOGGLE: session_send_json(ui_music_playing() ? "{\"type\":\"music\",\"cmd\":\"pausar\"}" : "{\"type\":\"music\",\"cmd\":\"continuar\"}"); break;
                case EV_MUSIC_NEXT: session_send_json("{\"type\":\"music\",\"cmd\":\"siguiente\"}"); break;
                case EV_MUSIC_PREV: session_send_json("{\"type\":\"music\",\"cmd\":\"anterior\"}"); break;
                case EV_SUSPEND_ON: set_state(ST_AWAY); break;
                case EV_SUSPEND_OFF: if (state == ST_AWAY) set_state(ST_LISTENING); break;
            }
        }
        if (want_open && state == ST_IDLE) { // se abre fuera del manejo del toque: abrir la conexion tarda
            want_open = false; set_state(ST_CONNECTING);
            if (!connecting_shown) { connecting_shown = true; ui_note("Conectando...", 0); }
            session_open();
        }
        // Brillo: con conversacion abierta, pleno; en reposo baja y luego se apaga (la pantalla AMOLED se marca si queda fija).
        int64_t now = esp_timer_get_time();
        if (state == ST_IDLE || state == ST_NOWIFI) {
            int64_t idle = (now - idle_since) / 1000000;
            light(idle > SLEEP_AFTER_S ? 0 : idle > DIM_AFTER_S ? 25 : 100);
        } else if (state == ST_AWAY) light(25);
        else light(100);
        if (now - last_battery > 60 * 1000000LL || !last_battery) {
            last_battery = now ? now : 1;
            bool charging = false; int pct = power_battery_percent(&charging);
            ui_battery(pct, charging);
        }
        // BOOT oprimido 3 s con la placa encendida: ajustes.
        static int boot_held;
        boot_held = gpio_get_level(BOOT_BUTTON) == 0 ? boot_held + 1 : 0;
        if (boot_held >= 12) { session_close(); set_state(ST_SETUP); portal_run(); }
    }
}
