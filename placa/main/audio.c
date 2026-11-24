// Audio: parlante (ES8311) y microfonos (ES7210) por el componente de la placa. Los dos comparten reloj, asi que
// trabajan igual que en el ejemplo del fabricante: 16 kHz, 16 bits, 2 canales. La voz llega del servidor en mono y se
// duplica a los dos canales; del microfono se toma el canal izquierdo.
#include <string.h>
#include "bsp/esp-bsp.h"
#include "esp_codec_dev.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"
#include "app.h"

static const char *TAG = "audio";
#define BLOCK 320                 // 20 ms a 16 kHz
#define MIC_FRAME 640             // 40 ms: lo que espera el servidor por trama
#define BUFFER_SECONDS 7          // el servidor envia la voz con ~4 s de adelanto
#define OUT_DELAY_MS 60           // lo que tarda en sonar lo que ya se le entrego al chip (estimado; ajustar con la placa)
#define MIC_GAIN_DB 24.0f         // el del ejemplo 05_Spec_Analyzer

static esp_codec_dev_handle_t spk, mic;
static StreamBufferHandle_t stream;
static volatile bool playing, ended, flush_req;
static volatile uint32_t played;  // muestras de la respuesta actual ya entregadas al parlante
static audio_mic_cb_t mic_cb;

static void play_task(void *arg)
{
    static int16_t mono[BLOCK], stereo[BLOCK * 2];
    int64_t empty_since = 0;
    for (;;) {
        if (flush_req) { while (xStreamBufferReceive(stream, mono, sizeof(mono), 0) > 0) { } flush_req = false; ended = true; }
        size_t got = xStreamBufferReceive(stream, mono, sizeof(mono), pdMS_TO_TICKS(40));
        got -= got % 2;
        if (got > 0) {
            if (flush_req) continue;
            if (!playing) { playing = true; app_post(EV_PLAY_START); }
            empty_since = 0;
            size_t n = got / 2;
            for (size_t i = 0; i < n; i++) stereo[i * 2] = stereo[i * 2 + 1] = mono[i];
            esp_codec_dev_write(spk, stereo, (int)(n * 4));
            played += n;
        } else if (playing) {
            // Sin audio: la respuesta termino (el servidor ya lo dijo) o la red se quedo corta mas de 1,2 s.
            int64_t now = esp_timer_get_time();
            if (!empty_since) empty_since = now;
            if (ended || now - empty_since > 1200000) { vTaskDelay(pdMS_TO_TICKS(OUT_DELAY_MS)); playing = false; app_post(EV_PLAY_STOP); }
        }
    }
}

static void mic_task(void *arg)
{
    static int16_t stereo[BLOCK * 2], frame[MIC_FRAME];
    size_t fill = 0;
    for (;;) {
        if (esp_codec_dev_read(mic, stereo, sizeof(stereo)) != ESP_CODEC_DEV_OK) { vTaskDelay(pdMS_TO_TICKS(20)); continue; }
        for (int i = 0; i < BLOCK; i++) {
            frame[fill++] = stereo[i * 2];
            if (fill == MIC_FRAME) { fill = 0; if (mic_cb) mic_cb(frame, MIC_FRAME); }
        }
    }
}

bool audio_start(void)
{
    spk = bsp_audio_codec_speaker_init();
    mic = bsp_audio_codec_microphone_init();
    if (!spk || !mic) { ESP_LOGE(TAG, "no se pudo iniciar el audio de la placa"); return false; }
    esp_codec_dev_sample_info_t fs = { .sample_rate = AUDIO_RATE, .channel = 2, .bits_per_sample = 16 };
    if (esp_codec_dev_open(spk, &fs) != ESP_CODEC_DEV_OK || esp_codec_dev_open(mic, &fs) != ESP_CODEC_DEV_OK) { ESP_LOGE(TAG, "el chip de audio no acepto 16 kHz"); return false; }
    esp_codec_dev_set_in_gain(mic, MIC_GAIN_DB);
    audio_volume(g_cfg.volume);

    size_t bytes = (size_t)AUDIO_RATE * 2 * BUFFER_SECONDS;
    uint8_t *store = heap_caps_malloc(bytes + 1, MALLOC_CAP_SPIRAM); // la voz por adelantado vive en la memoria grande (PSRAM)
    static StaticStreamBuffer_t ctrl;
    if (!store) { ESP_LOGE(TAG, "sin memoria para la voz"); return false; }
    stream = xStreamBufferCreateStatic(bytes, 2, store, &ctrl);
    xTaskCreatePinnedToCore(play_task, "voz", 4096, NULL, 6, NULL, 1);
    xTaskCreatePinnedToCore(mic_task, "micro", 4096, NULL, 5, NULL, 1);
    return true;
}

void audio_volume(int percent) { if (spk) esp_codec_dev_set_out_vol(spk, percent < 0 ? 0 : percent > 100 ? 100 : percent); }
void audio_on_mic(audio_mic_cb_t cb) { mic_cb = cb; }

void audio_begin(void)
{
    audio_flush();
    for (int i = 0; i < 20 && flush_req; i++) vTaskDelay(pdMS_TO_TICKS(5));
    // Si aun sonaba la respuesta anterior, se da por terminada: asi la nueva vuelve a avisar que empezo a sonar.
    if (playing) { playing = false; app_post(EV_PLAY_STOP); }
    played = 0; ended = false;
}

void audio_push(const uint8_t *pcm, size_t bytes)
{
    if (!stream || flush_req || bytes < 2) return;
    bytes -= bytes % 2;
    // Entra completo o no entra: un trozo a medias dejaria las muestras partidas por la mitad.
    for (int i = 0; i < 30 && xStreamBufferSpacesAvailable(stream) < bytes; i++) vTaskDelay(pdMS_TO_TICKS(10));
    if (xStreamBufferSpacesAvailable(stream) < bytes) { ESP_LOGW(TAG, "voz descartada: no cupieron %u bytes", (unsigned)bytes); return; }
    xStreamBufferSend(stream, pcm, bytes, 0);
}

void audio_end(void) { ended = true; }
void audio_flush(void) { flush_req = true; }
bool audio_playing(void) { return playing; }

uint32_t audio_clock_ms(void)
{
    uint32_t ms = (uint32_t)((uint64_t)played * 1000 / AUDIO_RATE);
    return ms > OUT_DELAY_MS ? ms - OUT_DELAY_MS : 0;
}
