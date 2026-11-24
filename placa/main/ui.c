// Pantalla: la cara, un anillo de color segun el estado, un aviso corto abajo, las tarjetas de datos (Tesla, clima,
// dolar...) con la cara pequeña, y, cuando hace falta, un texto grande (ajustes, errores).
// La letra es Montserrat (licencia OFL, en main/letra) leida como TTF: asi salen las tildes y la ñ.
#include <stdio.h>
#include <string.h>
#include "bsp/esp-bsp.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "lvgl.h"
#include "app.h"

extern const uint8_t ttf_start[] asm("_binary_Montserrat_Medium_ttf_start");
extern const uint8_t ttf_end[] asm("_binary_Montserrat_Medium_ttf_end");

#define SCREEN 466
#define TILE_STEP_MS 4500   // cada cuanto pasa a la tarjeta siguiente

static lv_obj_t *face_box, *ring, *note, *message, *battery;
static lv_obj_t *tile_box, *tile_arc, *tile_title, *tile_row, *tile_big, *tile_unit, *tile_lines, *tile_dots;
static lv_obj_t *cover_img, *music_prev, *music_next;
// Caratula: llega por la conexion a `cover_in` y la tarea de la pantalla la copia a `cover_px`, que es lo que se dibuja.
static uint8_t *cover_in, *cover_px;
static lv_image_dsc_t cover_dsc;
static bool cover_new, cover_ok;
static volatile bool music_on, music_playing, notice_on;
static const lv_font_t *f_text, *f_msg, *f_big, *f_unit;
static SemaphoreHandle_t lock;
static char want_message[220], want_note[64];
static bool has_message, dirty_message, dirty_note;
static int64_t note_until;
static int batt = -1; static bool batt_charging, dirty_batt;

// Tarjetas pedidas por el servidor (las escribe la tarea de la conexion; las dibuja la de la pantalla).
static tile_t tiles[TILE_MAX];
static int tile_count, tile_index, tile_seconds;
static bool tiles_new, tiles_off;
static volatile bool tile_on;
static int64_t tile_next, tile_until;

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
static const uint32_t TONES[4] = { 0x3987e5, 0x199e70, 0xc98500, 0xe5484d };

static void draw_tile(void)
{
    const tile_t *t = &tiles[tile_index];
    lv_color_t tone = lv_color_hex(TONES[t->tone >= 0 && t->tone < 4 ? t->tone : 0]);
    // Musica: la caratula entera arriba (nada encima), « y » a los lados; debajo, donde suena, la cancion y el artista.
    bool music = t->music && t->cover && cover_ok && cover_img;
    music_on = music; music_playing = t->playing; notice_on = t->notice > 0;
    lv_obj_t *only_music[] = { cover_img, music_prev, music_next }, *only_data[] = { tile_row, tile_dots };
    for (int i = 0; i < 3; i++) if (only_music[i]) { if (music) lv_obj_remove_flag(only_music[i], LV_OBJ_FLAG_HIDDEN); else lv_obj_add_flag(only_music[i], LV_OBJ_FLAG_HIDDEN); }
    for (int i = 0; i < 2; i++) { if (music) lv_obj_add_flag(only_data[i], LV_OBJ_FLAG_HIDDEN); else lv_obj_remove_flag(only_data[i], LV_OBJ_FLAG_HIDDEN); }
    lv_obj_align(tile_title, LV_ALIGN_TOP_MID, 0, music ? 200 : 50);
    lv_obj_align(tile_lines, LV_ALIGN_TOP_MID, 0, music ? 228 : 182);
    if (music) {
        char where[96]; snprintf(where, sizeof(where), "%s%s", t->playing ? "" : "En pausa · ", t->title);
        lv_label_set_text(tile_title, where); lv_label_set_text(tile_lines, t->lines);
        lv_obj_add_flag(tile_arc, LV_OBJ_FLAG_HIDDEN);
        return;
    }
    lv_label_set_text(tile_title, t->title);
    lv_label_set_text(tile_big, t->big);
    lv_label_set_text(tile_unit, t->unit);
    lv_obj_set_style_text_color(tile_unit, tone, 0);
    lv_label_set_text(tile_lines, t->lines);
    if (t->ring >= 0) {
        lv_obj_set_style_arc_color(tile_arc, tone, LV_PART_INDICATOR);
        lv_arc_set_value(tile_arc, t->ring);
        lv_obj_remove_flag(tile_arc, LV_OBJ_FLAG_HIDDEN);
    } else lv_obj_add_flag(tile_arc, LV_OBJ_FLAG_HIDDEN);
    char dots[TILE_MAX * 2 + 1] = "";
    if (tile_count > 1) for (int i = 0; i < tile_count; i++) strcat(dots, i == tile_index ? "o" : ".");
    lv_label_set_text(tile_dots, dots);
}

static void show_tile(bool on)
{
    tile_on = on; if (!on) { music_on = false; notice_on = false; }
    if (on) { lv_obj_remove_flag(tile_box, LV_OBJ_FLAG_HIDDEN); lv_obj_add_flag(face_box, LV_OBJ_FLAG_HIDDEN); lv_obj_add_flag(ring, LV_OBJ_FLAG_HIDDEN); }
    else { lv_obj_add_flag(tile_box, LV_OBJ_FLAG_HIDDEN); lv_obj_remove_flag(ring, LV_OBJ_FLAG_HIDDEN); if (!has_message) lv_obj_remove_flag(face_box, LV_OBJ_FLAG_HIDDEN); }
}

static void tick(lv_timer_t *t)
{
    static app_state_t shown = ST_BOOT; static bool first = true;
    app_state_t st = app_state();
    int64_t now = esp_timer_get_time();
    if (first || st != shown) { first = false; shown = st; lv_obj_set_style_border_color(ring, lv_color_hex(ring_color(st)), 0); lv_obj_set_style_border_opa(ring, ring_color(st) ? LV_OPA_COVER : LV_OPA_TRANSP, 0); }
    xSemaphoreTake(lock, portMAX_DELAY);
    if (dirty_message) {
        dirty_message = false;
        if (has_message) { lv_label_set_text(message, want_message); lv_obj_remove_flag(message, LV_OBJ_FLAG_HIDDEN); lv_obj_add_flag(face_box, LV_OBJ_FLAG_HIDDEN); if (tile_on) show_tile(false); lv_obj_add_flag(face_box, LV_OBJ_FLAG_HIDDEN); }
        else { lv_obj_add_flag(message, LV_OBJ_FLAG_HIDDEN); if (!tile_on) lv_obj_remove_flag(face_box, LV_OBJ_FLAG_HIDDEN); }
    }
    if (dirty_note) { dirty_note = false; lv_label_set_text(note, want_note); if (want_note[0]) lv_obj_remove_flag(note, LV_OBJ_FLAG_HIDDEN); else lv_obj_add_flag(note, LV_OBJ_FLAG_HIDDEN); }
    if (want_note[0] && note_until && now > note_until) { want_note[0] = 0; note_until = 0; lv_obj_add_flag(note, LV_OBJ_FLAG_HIDDEN); }
    if (dirty_batt) {
        dirty_batt = false;
        if (batt >= 0 && (batt <= 20 || batt_charging)) { lv_label_set_text_fmt(battery, "%s %d%%", batt_charging ? LV_SYMBOL_CHARGE : LV_SYMBOL_BATTERY_1, batt); lv_obj_remove_flag(battery, LV_OBJ_FLAG_HIDDEN); }
        else lv_obj_add_flag(battery, LV_OBJ_FLAG_HIDDEN); // solo se muestra cuando importa: poca bateria o cargando
    }
    if (cover_new && cover_in && cover_px) { cover_new = false; memcpy(cover_px, cover_in, COVER_SIDE * COVER_SIDE * 2); cover_ok = true; if (cover_img) { lv_image_set_src(cover_img, &cover_dsc); lv_obj_invalidate(cover_img); } }
    // Tarjetas: llegan, pasan solas si son varias y se van unos segundos despues de que el avatar termina de hablar.
    if (tiles_off) { tiles_off = false; tiles_new = false; if (tile_on) show_tile(false); }
    if (tiles_new && !has_message) { tiles_new = false; tile_index = 0; tile_next = now + TILE_STEP_MS * 1000LL; tile_until = 0; draw_tile(); show_tile(true); }
    if (tile_on) {
        if (tile_count > 1 && now >= tile_next) { tile_index = (tile_index + 1) % tile_count; tile_next = now + TILE_STEP_MS * 1000LL; draw_tile(); }
        if (st == ST_SPEAKING) tile_until = 0; // mientras habla, se queda
        else {
            int64_t left = (int64_t)(tile_count - tile_index) * TILE_STEP_MS * 1000LL, hold = (int64_t)tile_seconds * 1000000LL;
            if (!tile_until) tile_until = now + (hold > left ? hold : left);
            // Las tarjetas de datos son de la conversacion; un aviso que llego solo se queda aunque no haya conversacion.
            if (now >= tile_until || !(st == ST_LISTENING || st == ST_THINKING || st == ST_AWAY || (notice_on && st == ST_IDLE))) show_tile(false);
        }
    }
    xSemaphoreGive(lock);
    if (!has_message) mind_tick(40);
}

static void on_touch(lv_event_t *e)
{
    static int64_t pressed_at; static bool fired;
    lv_event_code_t code = lv_event_get_code(e);
    if (code == LV_EVENT_PRESSED) { pressed_at = esp_timer_get_time(); fired = false; }
    else if (code == LV_EVENT_SHORT_CLICKED) {
        // Sobre la tarjeta de musica: la caratula pausa o sigue, « y » cambian de cancion; mas abajo (la cara) la quita.
        lv_point_t p = { 233, 400 }; lv_indev_t *in = lv_indev_active(); if (in) lv_indev_get_point(in, &p);
        if (tile_on && music_on && p.y < 270) { tile_until = 0; app_post(p.x < 150 ? EV_MUSIC_PREV : p.x > 316 ? EV_MUSIC_NEXT : EV_MUSIC_TOGGLE); }
        else if (tile_on && notice_on) app_post(p.y < 270 ? EV_NOTICE_TALK : EV_NOTICE_DISMISS); // arriba: que lo cuente; sobre la cara: quitarlo
        else app_post(EV_TOUCH);
    }
    else if (code == LV_EVENT_LONG_PRESSED_REPEAT && !fired && esp_timer_get_time() - pressed_at > 3000000) { fired = true; app_post(EV_LONG_TOUCH); } // 3 s con el dedo puesto: ajustes
}

static lv_obj_t *label(lv_obj_t *parent, const lv_font_t *font, uint32_t color)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(color), 0);
    lv_obj_set_style_text_align(l, LV_TEXT_ALIGN_CENTER, 0);
    return l;
}

static lv_obj_t *box(lv_obj_t *parent, int w, int h)
{
    lv_obj_t *o = lv_obj_create(parent);
    lv_obj_remove_style_all(o);
    lv_obj_set_size(o, w, h);
    lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
    return o;
}

void ui_start(void)
{
    lock = xSemaphoreCreateMutex();
    bsp_display_start();
    bsp_display_lock(-1);
    size_t ttf_size = (size_t)(ttf_end - ttf_start);
    f_text = lv_tiny_ttf_create_data(ttf_start, ttf_size, 22);
    f_msg = lv_tiny_ttf_create_data(ttf_start, ttf_size, 26);
    f_big = lv_tiny_ttf_create_data(ttf_start, ttf_size, 88);
    f_unit = lv_tiny_ttf_create_data(ttf_start, ttf_size, 30);
    if (!f_text) f_text = &lv_font_montserrat_20; // sin la letra TTF salen sin tildes, pero salen
    if (!f_msg) f_msg = &lv_font_montserrat_26;
    if (!f_big) f_big = &lv_font_montserrat_26;
    if (!f_unit) f_unit = &lv_font_montserrat_20;

    lv_obj_t *scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, lv_color_black(), 0);
    lv_obj_remove_flag(scr, LV_OBJ_FLAG_SCROLLABLE);
    int side = face_side(FACE_BIG) ? face_side(FACE_BIG) : SCREEN;

    face_box = box(scr, side, side); lv_obj_center(face_box);
    face_build(FACE_BIG, face_box);

    ring = box(scr, SCREEN, SCREEN); lv_obj_center(ring);
    lv_obj_set_style_radius(ring, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(ring, 5, 0);
    lv_obj_set_style_border_opa(ring, LV_OPA_TRANSP, 0);

    // Tarjeta: anillo de porcentaje en el borde, titulo, cifra grande con su unidad, tres renglones y la cara pequeña.
    tile_box = box(scr, SCREEN, SCREEN); lv_obj_center(tile_box);
    lv_obj_add_flag(tile_box, LV_OBJ_FLAG_HIDDEN);
    tile_arc = lv_arc_create(tile_box);
    lv_obj_set_size(tile_arc, SCREEN - 12, SCREEN - 12); lv_obj_center(tile_arc);
    lv_arc_set_rotation(tile_arc, 270); lv_arc_set_bg_angles(tile_arc, 0, 360); lv_arc_set_range(tile_arc, 0, 100);
    lv_obj_remove_style(tile_arc, NULL, LV_PART_KNOB);
    lv_obj_remove_flag(tile_arc, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_style_arc_width(tile_arc, 10, LV_PART_MAIN); lv_obj_set_style_arc_width(tile_arc, 10, LV_PART_INDICATOR);
    lv_obj_set_style_arc_color(tile_arc, lv_color_hex(0x1b2030), LV_PART_MAIN);
    lv_obj_set_style_arc_rounded(tile_arc, true, LV_PART_INDICATOR);
    tile_title = label(tile_box, f_text, 0xaab3c5); lv_obj_align(tile_title, LV_ALIGN_TOP_MID, 0, 50);
    lv_obj_t *row = tile_row = box(tile_box, LV_SIZE_CONTENT, LV_SIZE_CONTENT); // cifra y unidad juntas, centradas
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW); lv_obj_set_flex_align(row, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_END);
    lv_obj_set_style_pad_column(row, 6, 0); lv_obj_align(row, LV_ALIGN_TOP_MID, 0, 78);
    tile_big = label(row, f_big, 0xffffff);
    tile_unit = label(row, f_unit, 0x3987e5); lv_obj_set_style_pad_bottom(tile_unit, 14, 0);
    tile_lines = label(tile_box, f_text, 0xffffff);
    lv_label_set_long_mode(tile_lines, LV_LABEL_LONG_MODE_DOTS); lv_obj_set_width(tile_lines, 350); lv_obj_set_height(tile_lines, 90);
    lv_obj_set_style_text_line_space(tile_lines, 5, 0); lv_obj_align(tile_lines, LV_ALIGN_TOP_MID, 0, 182);
    tile_dots = label(tile_box, &lv_font_montserrat_20, 0x8a93a6); lv_obj_align(tile_dots, LV_ALIGN_TOP_MID, 0, 262);
    // Musica: caratula de 150 x 150 que llega del servidor, y los signos para cambiar de cancion.
    cover_in = heap_caps_malloc(COVER_SIDE * COVER_SIDE * 2, MALLOC_CAP_SPIRAM); cover_px = heap_caps_calloc(1, COVER_SIDE * COVER_SIDE * 2, MALLOC_CAP_SPIRAM);
    if (cover_in && cover_px) {
        memset(&cover_dsc, 0, sizeof(cover_dsc));
        cover_dsc.header.magic = LV_IMAGE_HEADER_MAGIC; cover_dsc.header.cf = LV_COLOR_FORMAT_RGB565; cover_dsc.header.w = COVER_SIDE; cover_dsc.header.h = COVER_SIDE; cover_dsc.header.stride = COVER_SIDE * 2;
        cover_dsc.data_size = COVER_SIDE * COVER_SIDE * 2; cover_dsc.data = cover_px;
        cover_img = lv_image_create(tile_box); lv_image_set_src(cover_img, &cover_dsc); lv_obj_align(cover_img, LV_ALIGN_TOP_MID, 0, 44); lv_obj_add_flag(cover_img, LV_OBJ_FLAG_HIDDEN);
        music_prev = label(tile_box, f_unit, 0xaab3c5); lv_label_set_text(music_prev, "«"); lv_obj_align(music_prev, LV_ALIGN_TOP_MID, -116, 100); lv_obj_add_flag(music_prev, LV_OBJ_FLAG_HIDDEN);
        music_next = label(tile_box, f_unit, 0xaab3c5); lv_label_set_text(music_next, "»"); lv_obj_align(music_next, LV_ALIGN_TOP_MID, 116, 100); lv_obj_add_flag(music_next, LV_OBJ_FLAG_HIDDEN);
    }
    int small = face_side(FACE_MINI);
    if (small) { lv_obj_t *mini = box(tile_box, small, small); lv_obj_align(mini, LV_ALIGN_TOP_MID, 0, 280); face_build(FACE_MINI, mini); }

    note = label(scr, f_text, 0xffffff);
    lv_obj_set_style_bg_color(note, lv_color_black(), 0); lv_obj_set_style_bg_opa(note, LV_OPA_70, 0);
    lv_obj_set_style_pad_hor(note, 12, 0); lv_obj_set_style_pad_ver(note, 6, 0); lv_obj_set_style_radius(note, 14, 0);
    lv_obj_align(note, LV_ALIGN_BOTTOM_MID, 0, -34);
    lv_obj_add_flag(note, LV_OBJ_FLAG_HIDDEN);

    battery = label(scr, &lv_font_montserrat_20, 0xe8ebf2); // los simbolos de bateria vienen en la letra incluida en LVGL
    lv_obj_align(battery, LV_ALIGN_TOP_MID, 0, 22);
    lv_obj_add_flag(battery, LV_OBJ_FLAG_HIDDEN);

    message = label(scr, f_msg, 0xffffff);
    lv_label_set_long_mode(message, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_width(message, 340); lv_obj_center(message);
    lv_obj_add_flag(message, LV_OBJ_FLAG_HIDDEN);

    // Toda la pantalla es un boton: un toque abre la conversacion, despierta, corta o quita la tarjeta; dejar el dedo abre los ajustes.
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
    xSemaphoreTake(lock, portMAX_DELAY);
    has_message = text != NULL; if (text) strlcpy(want_message, text, sizeof(want_message)); dirty_message = true;
    xSemaphoreGive(lock);
}

void ui_note(const char *text, int seconds)
{
    xSemaphoreTake(lock, portMAX_DELAY);
    strlcpy(want_note, text ? text : "", sizeof(want_note)); dirty_note = true;
    note_until = seconds > 0 ? esp_timer_get_time() + (int64_t)seconds * 1000000 : 0;
    xSemaphoreGive(lock);
}

void ui_battery(int percent, bool charging)
{
    xSemaphoreTake(lock, portMAX_DELAY);
    batt = percent; batt_charging = charging; dirty_batt = true;
    xSemaphoreGive(lock);
}

void ui_tiles(const tile_t *list, int count, int seconds)
{
    if (!list || count <= 0) return;
    xSemaphoreTake(lock, portMAX_DELAY);
    tile_count = count > TILE_MAX ? TILE_MAX : count;
    memcpy(tiles, list, sizeof(tile_t) * (size_t)tile_count);
    tile_seconds = seconds < 2 ? 12 : seconds > 120 ? 120 : seconds;
    tiles_new = true; tiles_off = false;
    xSemaphoreGive(lock);
}

bool ui_tile_active(void) { return tile_on; }
bool ui_music_playing(void) { return music_playing; }

void ui_cover(const uint8_t *rgb565, int w, int h)
{
    if (!rgb565 || w != COVER_SIDE || h != COVER_SIDE || !cover_in) return;
    xSemaphoreTake(lock, portMAX_DELAY);
    memcpy(cover_in, rgb565, COVER_SIDE * COVER_SIDE * 2); cover_new = true;
    xSemaphoreGive(lock);
}

void ui_tile_dismiss(void)
{
    xSemaphoreTake(lock, portMAX_DELAY);
    tiles_off = true;
    xSemaphoreGive(lock);
}
