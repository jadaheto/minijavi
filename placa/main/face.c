// La cara 2D: una imagen base y tres capas de recortes (cejas, ojos, boca) guardadas en la particion "cara" (cara.bin,
// hecho con `npm run cara:placa`). El archivo trae dos caras: la grande y la pequeña que acompaña a las tarjetas.
// Las imagenes se leen directo de la memoria flash, sin copiarlas a la RAM.
#include <string.h>
#include "esp_log.h"
#include "esp_partition.h"
#include "lvgl.h"
#include "app.h"

static const char *TAG = "cara";
#define MAX_FRAMES 24

typedef struct __attribute__((packed)) { char magic[4]; uint16_t side, layers; uint32_t base, size; } head_t;
typedef struct __attribute__((packed)) { char name[12]; uint16_t x, y, w, h, n, pad; uint32_t data; char frames[MAX_FRAMES][12]; } layer_t;
_Static_assert(sizeof(head_t) == 16 && sizeof(layer_t) == 316, "el formato de cara.bin cambio: revisar scripts/cara-placa.mjs");

typedef struct {
    const head_t *head;
    const layer_t *layers[FACE_LAYERS];
    lv_image_dsc_t base, frame[FACE_LAYERS][MAX_FRAMES];
    lv_obj_t *base_img, *img[FACE_LAYERS];
    int shown[FACE_LAYERS];
    int map[FACE_LAYERS][MAX_FRAMES]; // cuadro de la cara grande -> cuadro de esta cara (por nombre)
} face_t;
static face_t faces[FACE_COUNT];
static const char *LAYER_NAMES[FACE_LAYERS] = { "cejas", "ojos", "boca" };

static void dsc(lv_image_dsc_t *d, int w, int h, const uint8_t *data)
{
    memset(d, 0, sizeof(*d));
    d->header.magic = LV_IMAGE_HEADER_MAGIC; d->header.cf = LV_COLOR_FORMAT_RGB565;
    d->header.w = w; d->header.h = h; d->header.stride = w * 2;
    d->data_size = (uint32_t)w * h * 2; d->data = data;
}

static bool parse(face_t *f, const uint8_t *blob, size_t room)
{
    const head_t *h = (const head_t *)blob;
    if (room < sizeof(head_t) || memcmp(h->magic, "MJC2", 4) != 0 || h->side == 0 || h->side > 600 || h->layers > FACE_LAYERS || h->size > room) return false;
    const layer_t *all = (const layer_t *)(blob + sizeof(head_t));
    for (int l = 0; l < FACE_LAYERS; l++) {
        f->layers[l] = NULL;
        for (int i = 0; i < h->layers; i++) if (strncmp(all[i].name, LAYER_NAMES[l], 12) == 0) f->layers[l] = &all[i];
        const layer_t *c = f->layers[l];
        if (!c || c->n == 0 || c->n > MAX_FRAMES) { ESP_LOGE(TAG, "falta la capa %s", LAYER_NAMES[l]); return false; }
        if ((size_t)c->data + (size_t)c->n * c->w * c->h * 2 > h->size || c->x + c->w > h->side || c->y + c->h > h->side) { ESP_LOGE(TAG, "la capa %s se sale", LAYER_NAMES[l]); return false; }
        for (int i = 0; i < c->n; i++) dsc(&f->frame[l][i], c->w, c->h, blob + c->data + (size_t)i * c->w * c->h * 2);
    }
    if ((size_t)h->base + (size_t)h->side * h->side * 2 > h->size) return false;
    dsc(&f->base, h->side, h->side, blob + h->base);
    f->head = h;
    return true;
}

bool face_load(void)
{
    const esp_partition_t *part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, 0x40, "cara");
    if (!part) { ESP_LOGE(TAG, "no existe la particion 'cara'"); return false; }
    const uint8_t *blob; esp_partition_mmap_handle_t map;
    if (esp_partition_mmap(part, 0, part->size, ESP_PARTITION_MMAP_DATA, (const void **)&blob, &map) != ESP_OK) { ESP_LOGE(TAG, "no se pudo abrir la particion"); return false; }
    if (!parse(&faces[FACE_BIG], blob, part->size)) { ESP_LOGE(TAG, "la particion 'cara' esta vacia o tiene otro formato"); faces[FACE_BIG].head = NULL; return false; }
    size_t next = faces[FACE_BIG].head->size;
    if (!parse(&faces[FACE_MINI], blob + next, part->size - next)) { ESP_LOGW(TAG, "no hay cara pequeña: las tarjetas saldran sin ella"); faces[FACE_MINI].head = NULL; }
    // Los cuadros se piden con el numero de la cara grande; en la pequeña se buscan por nombre.
    for (int w = 0; w < FACE_COUNT; w++) for (int l = 0; l < FACE_LAYERS; l++) for (int i = 0; i < MAX_FRAMES; i++) {
        faces[w].map[l][i] = 0;
        if (!faces[w].head || i >= faces[FACE_BIG].layers[l]->n) continue;
        for (int j = 0; j < faces[w].layers[l]->n; j++) if (strncmp(faces[w].layers[l]->frames[j], faces[FACE_BIG].layers[l]->frames[i], 12) == 0) faces[w].map[l][i] = j;
    }
    ESP_LOGI(TAG, "cara de %d x %d%s", faces[FACE_BIG].head->side, faces[FACE_BIG].head->side, faces[FACE_MINI].head ? " y cara pequeña" : "");
    return true;
}

int face_side(int which) { return which >= 0 && which < FACE_COUNT && faces[which].head ? faces[which].head->side : 0; }

int face_frame(int layer, const char *name)
{
    const face_t *f = &faces[FACE_BIG];
    if (!f->head || layer < 0 || layer >= FACE_LAYERS || !name) return -1;
    for (int i = 0; i < f->layers[layer]->n; i++) if (strncmp(f->layers[layer]->frames[i], name, 12) == 0) return i;
    return -1;
}

void face_build(int which, lv_obj_t *parent)
{
    if (which < 0 || which >= FACE_COUNT || !faces[which].head) return;
    face_t *f = &faces[which];
    f->base_img = lv_image_create(parent);
    lv_image_set_src(f->base_img, &f->base);
    lv_obj_set_pos(f->base_img, 0, 0);
    for (int l = 0; l < FACE_LAYERS; l++) {
        f->img[l] = lv_image_create(parent);
        lv_obj_set_pos(f->img[l], f->layers[l]->x, f->layers[l]->y);
        lv_obj_add_flag(f->img[l], LV_OBJ_FLAG_HIDDEN); // el cuadro 0 es el de la cara base: no hace falta dibujarlo
        f->shown[l] = 0;
    }
}

void face_show(int layer, int frame)
{
    if (layer < 0 || layer >= FACE_LAYERS || !faces[FACE_BIG].head) return;
    if (frame < 0 || frame >= faces[FACE_BIG].layers[layer]->n) frame = 0;
    for (int w = 0; w < FACE_COUNT; w++) {
        face_t *f = &faces[w];
        if (!f->head || !f->base_img) continue;
        int own = f->map[layer][frame];
        if (own == f->shown[layer]) continue;
        f->shown[layer] = own;
        if (own == 0) { lv_obj_add_flag(f->img[layer], LV_OBJ_FLAG_HIDDEN); continue; }
        lv_image_set_src(f->img[layer], &f->frame[layer][own]);
        lv_obj_remove_flag(f->img[layer], LV_OBJ_FLAG_HIDDEN);
    }
}
