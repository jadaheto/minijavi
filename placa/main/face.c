// La cara 2D: una imagen base y tres capas de recortes (cejas, ojos, boca) guardadas en la particion "cara" (cara.bin,
// hecho con `npm run cara:placa`). Las imagenes se leen directo de la memoria flash, sin copiarlas a la RAM.
#include <string.h>
#include "esp_log.h"
#include "esp_partition.h"
#include "lvgl.h"
#include "app.h"

static const char *TAG = "cara";
#define MAX_FRAMES 24

typedef struct __attribute__((packed)) { char magic[4]; uint16_t side, layers; uint32_t base; } head_t;
typedef struct __attribute__((packed)) { char name[12]; uint16_t x, y, w, h, n, pad; uint32_t data; char frames[MAX_FRAMES][12]; } layer_t;
_Static_assert(sizeof(head_t) == 12 && sizeof(layer_t) == 316, "el formato de cara.bin cambio: revisar scripts/cara-placa.mjs");

static const uint8_t *blob;
static const head_t *head;
static const layer_t *layers[FACE_LAYERS];
static const char *LAYER_NAMES[FACE_LAYERS] = { "cejas", "ojos", "boca" };
static lv_image_dsc_t base_dsc, frame_dsc[FACE_LAYERS][MAX_FRAMES];
static lv_obj_t *base_img, *layer_img[FACE_LAYERS];
static int shown[FACE_LAYERS];

static void dsc(lv_image_dsc_t *d, int w, int h, const uint8_t *data)
{
    memset(d, 0, sizeof(*d));
    d->header.magic = LV_IMAGE_HEADER_MAGIC; d->header.cf = LV_COLOR_FORMAT_RGB565;
    d->header.w = w; d->header.h = h; d->header.stride = w * 2;
    d->data_size = (uint32_t)w * h * 2; d->data = data;
}

bool face_load(void)
{
    const esp_partition_t *part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, 0x40, "cara");
    if (!part) { ESP_LOGE(TAG, "no existe la particion 'cara'"); return false; }
    esp_partition_mmap_handle_t map;
    if (esp_partition_mmap(part, 0, part->size, ESP_PARTITION_MMAP_DATA, (const void **)&blob, &map) != ESP_OK) { ESP_LOGE(TAG, "no se pudo abrir la particion"); return false; }
    head = (const head_t *)blob;
    if (memcmp(head->magic, "MJC1", 4) != 0 || head->side == 0 || head->side > 600 || head->layers > FACE_LAYERS) { ESP_LOGE(TAG, "la particion 'cara' esta vacia o tiene otro formato"); head = NULL; return false; }
    const layer_t *all = (const layer_t *)(blob + sizeof(head_t));
    for (int l = 0; l < FACE_LAYERS; l++) {
        layers[l] = NULL;
        for (int i = 0; i < head->layers; i++) if (strncmp(all[i].name, LAYER_NAMES[l], 12) == 0) layers[l] = &all[i];
        if (!layers[l] || layers[l]->n == 0 || layers[l]->n > MAX_FRAMES) { ESP_LOGE(TAG, "falta la capa %s", LAYER_NAMES[l]); head = NULL; return false; }
        const layer_t *c = layers[l];
        if ((size_t)c->data + (size_t)c->n * c->w * c->h * 2 > part->size || c->x + c->w > head->side || c->y + c->h > head->side) { ESP_LOGE(TAG, "la capa %s se sale", LAYER_NAMES[l]); head = NULL; return false; }
        for (int f = 0; f < c->n; f++) dsc(&frame_dsc[l][f], c->w, c->h, blob + c->data + (size_t)f * c->w * c->h * 2);
    }
    dsc(&base_dsc, head->side, head->side, blob + head->base);
    ESP_LOGI(TAG, "cara de %d x %d: %d cejas, %d ojos, %d bocas", head->side, head->side, layers[FACE_BROWS]->n, layers[FACE_EYES]->n, layers[FACE_MOUTH]->n);
    return true;
}

int face_side(void) { return head ? head->side : 0; }

int face_frame(int layer, const char *name)
{
    if (!head || layer < 0 || layer >= FACE_LAYERS || !name) return -1;
    for (int f = 0; f < layers[layer]->n; f++) if (strncmp(layers[layer]->frames[f], name, 12) == 0) return f;
    return -1;
}

void face_build(lv_obj_t *parent)
{
    if (!head) return;
    base_img = lv_image_create(parent);
    lv_image_set_src(base_img, &base_dsc);
    lv_obj_set_pos(base_img, 0, 0);
    for (int l = 0; l < FACE_LAYERS; l++) {
        layer_img[l] = lv_image_create(parent);
        lv_obj_set_pos(layer_img[l], layers[l]->x, layers[l]->y);
        lv_obj_add_flag(layer_img[l], LV_OBJ_FLAG_HIDDEN); // el cuadro 0 es el de la cara base: no hace falta dibujarlo
        shown[l] = 0;
    }
}

void face_show(int layer, int frame)
{
    if (!head || !base_img || layer < 0 || layer >= FACE_LAYERS) return;
    if (frame < 0 || frame >= layers[layer]->n) frame = 0;
    if (frame == shown[layer]) return;
    shown[layer] = frame;
    if (frame == 0) { lv_obj_add_flag(layer_img[layer], LV_OBJ_FLAG_HIDDEN); return; }
    lv_image_set_src(layer_img[layer], &frame_dsc[layer][frame]);
    lv_obj_remove_flag(layer_img[layer], LV_OBJ_FLAG_HIDDEN);
}

void face_visible(bool on)
{
    if (!base_img) return;
    if (on) lv_obj_remove_flag(lv_obj_get_parent(base_img), LV_OBJ_FLAG_HIDDEN); else lv_obj_add_flag(lv_obj_get_parent(base_img), LV_OBJ_FLAG_HIDDEN);
}
