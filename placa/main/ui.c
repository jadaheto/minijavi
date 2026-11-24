// Pantalla: la cara, un anillo de color segun el estado, un aviso corto abajo y, cuando hace falta, un texto grande
// (ajustes, errores). Los textos van sin tildes: la letra incluida en LVGL no las trae.
#include <stdio.h>
#include <string.h>
#include "bsp/esp-bsp.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "lvgl.h"
#include "app.h"

static lv_obj_t *face_box, *ring, *note, *message, *battery;
static SemaphoreHandle_t text_lock;
static char want_message[220], want_note[64];
static bool has_message, dirty_message, dirty_note;
static int64_t note_until;
static int batt = -1; static bool batt_charging, dirty_batt;

static uint32_t ring_color(app_state_t st)
{
    switch (st) {
        case ST_LISTENING: return 0x199e70; // verde: te oye
        case ST_THINKING:  return 0xc98500; // ambar: preparando la respuesta
        case ST_SPEAKING:  return 0x3987e5; // azul: hablando
        case ST_CONNECTING: return 0x6b7385;
        default: return 0x000000;
    }
}

static void tick(lv_timer_t *t)
{
    static app_state_t shown = ST_BOOT; static bool first = true;
    app_state_t st = app_state();
    if (first || st != shown) { first = false; shown = st; lv_obj_set_style_border_color(ring, lv_color_hex(ring_color(st)), 0); lv_obj_set_style_border_opa(ring, ring_color(st) ? LV_OPA_COVER : LV_OPA_TRANSP, 0); }
    xSemaphoreTake(text_lock, portMAX_DELAY);
    if (dirty_message) {
        dirty_message = false;
        if (has_message) { lv_label_set_text(message, want_message); lv_obj_remove_flag(message, LV_OBJ_FLAG_HIDDEN); lv_obj_add_flag(face_box, LV_OBJ_FLAG_HIDDEN); }
        else { lv_obj_add_flag(message, LV_OBJ_FLAG_HIDDEN); lv_obj_remove_flag(face_box, LV_OBJ_FLAG_HIDDEN); }
    }
    if (dirty_note) { dirty_note = false; lv_label_set_text(note, want_note); if (want_note[0]) lv_obj_remove_flag(note, LV_OBJ_FLAG_HIDDEN); else lv_obj_add_flag(note, LV_OBJ_FLAG_HIDDEN); }
    if (want_note[0] && note_until && esp_timer_get_time() > note_until) { want_note[0] = 0; note_until = 0; lv_obj_add_flag(note, LV_OBJ_FLAG_HIDDEN); }
    if (dirty_batt) {
        dirty_batt = false;
        if (batt >= 0 && (batt <= 20 || batt_charging)) { lv_label_set_text_fmt(battery, "%s %d%%", batt_charging ? LV_SYMBOL_CHARGE : LV_SYMBOL_BATTERY_1, batt); lv_obj_remove_flag(battery, LV_OBJ_FLAG_HIDDEN); }
        else lv_obj_add_flag(battery, LV_OBJ_FLAG_HIDDEN); // solo se muestra cuando importa: poca bateria o cargando
    }
    xSemaphoreGive(text_lock);
    if (!has_message) mind_tick(40);
}

static void on_touch(lv_event_t *e)
{
    static int64_t pressed_at; static bool fired;
    lv_event_code_t code = lv_event_get_code(e);
    if (code == LV_EVENT_PRESSED) { pressed_at = esp_timer_get_time(); fired = false; }
    else if (code == LV_EVENT_SHORT_CLICKED) app_post(EV_TOUCH);
    else if (code == LV_EVENT_LONG_PRESSED_REPEAT && !fired && esp_timer_get_time() - pressed_at > 3000000) { fired = true; app_post(EV_LONG_TOUCH); } // 3 s con el dedo puesto: ajustes
}

void ui_start(void)
{
    text_lock = xSemaphoreCreateMutex();
    bsp_display_start();
    bsp_display_lock(-1);
    lv_obj_t *scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, lv_color_black(), 0);
    lv_obj_remove_flag(scr, LV_OBJ_FLAG_SCROLLABLE);
    int side = face_side() ? face_side() : 466;

    face_box = lv_obj_create(scr);
    lv_obj_remove_style_all(face_box);
    lv_obj_set_size(face_box, side, side); lv_obj_center(face_box);
    lv_obj_remove_flag(face_box, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
    face_build(face_box);

    ring = lv_obj_create(scr);
    lv_obj_remove_style_all(ring);
    lv_obj_set_size(ring, 466, 466); lv_obj_center(ring);
    lv_obj_set_style_radius(ring, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(ring, 5, 0);
    lv_obj_set_style_border_opa(ring, LV_OPA_TRANSP, 0);
    lv_obj_remove_flag(ring, LV_OBJ_FLAG_CLICKABLE);

    note = lv_label_create(scr);
    lv_obj_set_style_text_font(note, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(note, lv_color_white(), 0);
    lv_obj_set_style_bg_color(note, lv_color_black(), 0); lv_obj_set_style_bg_opa(note, LV_OPA_70, 0);
    lv_obj_set_style_pad_hor(note, 12, 0); lv_obj_set_style_pad_ver(note, 6, 0); lv_obj_set_style_radius(note, 14, 0);
    lv_obj_align(note, LV_ALIGN_BOTTOM_MID, 0, -34);
    lv_obj_add_flag(note, LV_OBJ_FLAG_HIDDEN);

    battery = lv_label_create(scr);
    lv_obj_set_style_text_font(battery, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(battery, lv_color_hex(0xe8ebf2), 0);
    lv_obj_align(battery, LV_ALIGN_TOP_MID, 0, 22);
    lv_obj_add_flag(battery, LV_OBJ_FLAG_HIDDEN);

    message = lv_label_create(scr);
    lv_obj_set_style_text_font(message, &lv_font_montserrat_26, 0);
    lv_obj_set_style_text_color(message, lv_color_white(), 0);
    lv_obj_set_style_text_align(message, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(message, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_width(message, 340); lv_obj_center(message);
    lv_obj_add_flag(message, LV_OBJ_FLAG_HIDDEN);

    // Toda la pantalla es un boton: un toque abre la conversacion, despierta o corta; dejar el dedo abre los ajustes.
    lv_obj_t *touch = lv_obj_create(scr);
    lv_obj_remove_style_all(touch);
    lv_obj_set_size(touch, LV_PCT(100), LV_PCT(100));
    lv_obj_add_flag(touch, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(touch, on_touch, LV_EVENT_PRESSED, NULL);
    lv_obj_add_event_cb(touch, on_touch, LV_EVENT_SHORT_CLICKED, NULL);
    lv_obj_add_event_cb(touch, on_touch, LV_EVENT_LONG_PRESSED_REPEAT, NULL);

    lv_timer_create(tick, 40, NULL);
    bsp_display_unlock();
}

void ui_message(const char *text)
{
    xSemaphoreTake(text_lock, portMAX_DELAY);
    has_message = text != NULL; if (text) strlcpy(want_message, text, sizeof(want_message)); dirty_message = true;
    xSemaphoreGive(text_lock);
}

void ui_note(const char *text, int seconds)
{
    xSemaphoreTake(text_lock, portMAX_DELAY);
    strlcpy(want_note, text ? text : "", sizeof(want_note)); dirty_note = true;
    note_until = seconds > 0 ? esp_timer_get_time() + (int64_t)seconds * 1000000 : 0;
    xSemaphoreGive(text_lock);
}

void ui_battery(int percent, bool charging)
{
    xSemaphoreTake(text_lock, portMAX_DELAY);
    batt = percent; batt_charging = charging; dirty_batt = true;
    xSemaphoreGive(text_lock);
}
