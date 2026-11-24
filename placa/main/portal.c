// Pagina de ajustes: la placa crea su propia red Wi-Fi (con clave, que se muestra en la pantalla) y sirve un formulario
// en http://192.168.4.1 para escribir las redes, la direccion del servidor y el pase. Al guardar, se reinicia.
// La clave de la red cambia cada vez: quien no ve la pantalla no puede entrar ni ver lo que se escribe.
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "app.h"

static const char *TAG = "ajustes-web";
static volatile bool saved;

/** Texto para poner dentro de un atributo HTML (los nombres de red los escribe cualquiera). */
static void esc(char *out, size_t cap, const char *in)
{
    size_t o = 0;
    for (; *in && o + 7 < cap; in++) {
        const char *r = *in == '&' ? "&amp;" : *in == '<' ? "&lt;" : *in == '>' ? "&gt;" : *in == '"' ? "&quot;" : *in == '\'' ? "&#39;" : NULL;
        if (r) { size_t n = strlen(r); memcpy(out + o, r, n); o += n; } else out[o++] = *in;
    }
    out[o] = 0;
}

static esp_err_t page(httpd_req_t *req)
{
    static const char HEAD[] =
        "<!doctype html><html lang=es><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
        "<title>Javi de bolsillo</title><style>body{font:16px system-ui,sans-serif;background:#0b0d12;color:#e8ebf2;margin:0;padding:16px}"
        "main{max-width:460px;margin:auto}h1{font-size:1.3rem}fieldset{border:1px solid #232836;border-radius:8px;margin:0 0 16px;padding:12px}"
        "legend{padding:0 6px;color:#98a1b3}label{display:block;margin:10px 0 4px;color:#98a1b3;font-size:.9rem}"
        "input{width:100%;box-sizing:border-box;font:inherit;padding:10px;border-radius:8px;border:1px solid #232836;background:#151924;color:#e8ebf2}"
        "input:focus-visible,button:focus-visible{outline:2px solid #3987e5;outline-offset:2px}"
        "button{font:inherit;font-weight:600;width:100%;padding:12px;border:0;border-radius:8px;background:#3987e5;color:#fff}small{color:#98a1b3}</style>"
        "<main><h1>Javi de bolsillo: ajustes</h1><form method=post action=/guardar>";
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_sendstr_chunk(req, HEAD);
    char buf[1100], name[200];
    for (int i = 0; i < CFG_NETS; i++) {
        esc(name, sizeof(name), g_cfg.ssid[i]);
        snprintf(buf, sizeof(buf),
            "<fieldset><legend>Red Wi-Fi %d%s</legend><label for=r%d>Nombre de la red</label><input id=r%d name=r%d maxlength=32 value=\"%s\" autocapitalize=off autocorrect=off>"
            "<label for=c%d>Clave%s</label><input id=c%d name=c%d type=password maxlength=64 autocomplete=off></fieldset>",
            i + 1, i ? " (opcional)" : "", i, i, i, name, i, g_cfg.pass[i][0] ? " (guardada: d&eacute;jala vac&iacute;a para no cambiarla)" : "", i, i);
        httpd_resp_sendstr_chunk(req, buf);
    }
    esc(name, sizeof(name), g_cfg.url);
    snprintf(buf, sizeof(buf),
        "<fieldset><legend>Servidor</legend><label for=u>Direcci&oacute;n</label><input id=u name=u maxlength=120 value=\"%s\" autocapitalize=off autocorrect=off>"
        "<label for=p>Pase del dispositivo%s</label><input id=p name=p type=password maxlength=190 autocomplete=off>"
        "<small>Se crea en el panel de minijavi, en Dispositivos &rarr; Javi de bolsillo.</small>",
        name, g_cfg.pase[0] ? " (guardado: d&eacute;jalo vac&iacute;o para no cambiarlo)" : "");
    httpd_resp_sendstr_chunk(req, buf);
    snprintf(buf, sizeof(buf),
        "<label for=v>Volumen (0 a 100)</label><input id=v name=v type=number min=0 max=100 value=%d></fieldset>"
        "<button>Guardar y reiniciar</button><p><small>Solo redes de 2,4 GHz. La placa se reinicia al guardar.</small></p></form></main></html>", (int)g_cfg.volume);
    httpd_resp_sendstr_chunk(req, buf);
    return httpd_resp_sendstr_chunk(req, NULL);
}

/** Valor de un campo de un formulario (application/x-www-form-urlencoded), ya decodificado. */
static bool field(const char *body, const char *key, char *out, size_t cap)
{
    size_t klen = strlen(key);
    for (const char *p = body; p && *p; ) {
        const char *amp = strchr(p, '&'), *end = amp ? amp : p + strlen(p);
        if (strncmp(p, key, klen) == 0 && p[klen] == '=') {
            size_t o = 0;
            for (const char *q = p + klen + 1; q < end && o + 1 < cap; q++) {
                if (*q == '+') out[o++] = ' ';
                else if (*q == '%' && q + 2 < end + 0 && isxdigit((unsigned char)q[1]) && isxdigit((unsigned char)q[2])) { char hex[3] = { q[1], q[2], 0 }; out[o++] = (char)strtol(hex, NULL, 16); q += 2; }
                else out[o++] = *q;
            }
            out[o] = 0;
            return true;
        }
        p = amp ? amp + 1 : NULL;
    }
    out[0] = 0;
    return false;
}

static esp_err_t save(httpd_req_t *req)
{
    if (req->content_len <= 0 || req->content_len > 1500) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Formulario demasiado grande");
    char *body = calloc(1, (size_t)req->content_len + 1);
    if (!body) return httpd_resp_send_500(req);
    int got = 0;
    while (got < req->content_len) { int n = httpd_req_recv(req, body + got, (size_t)(req->content_len - got)); if (n <= 0) { free(body); return ESP_FAIL; } got += n; }
    cfg_t next = g_cfg; char key[4], value[200];
    for (int i = 0; i < CFG_NETS; i++) {
        snprintf(key, sizeof(key), "r%d", i); field(body, key, value, sizeof(value));
        bool same = strcmp(value, g_cfg.ssid[i]) == 0;
        strlcpy(next.ssid[i], value, sizeof(next.ssid[i]));
        snprintf(key, sizeof(key), "c%d", i); field(body, key, value, sizeof(value));
        if (value[0] || !same) strlcpy(next.pass[i], value, sizeof(next.pass[i])); // red nueva sin clave = red abierta
        if (!next.ssid[i][0]) next.pass[i][0] = 0;
    }
    field(body, "u", value, sizeof(value)); if (value[0]) strlcpy(next.url, value, sizeof(next.url));
    field(body, "p", value, sizeof(value)); if (value[0]) strlcpy(next.pase, value, sizeof(next.pase));
    if (field(body, "v", value, sizeof(value)) && value[0]) { int v = atoi(value); next.volume = v < 0 ? 0 : v > 100 ? 100 : v; }
    memset(body, 0, (size_t)req->content_len); free(body); memset(value, 0, sizeof(value));

    httpd_resp_set_type(req, "text/html; charset=utf-8");
    const char *problem = NULL;
    if (strncmp(next.url, "ws://", 5) != 0 && strncmp(next.url, "wss://", 6) != 0) problem = "La direcci&oacute;n del servidor debe empezar por wss:// (o ws://).";
    else if (strncmp(next.pase, "mjb.", 4) != 0) problem = "El pase debe empezar por mjb. (c&oacute;pialo completo desde el panel).";
    else { bool net = false; for (int i = 0; i < CFG_NETS; i++) if (next.ssid[i][0]) net = true; if (!net) problem = "Escribe al menos una red Wi-Fi."; }
    if (problem) {
        char out[700]; snprintf(out, sizeof(out), "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><body style='font:16px system-ui;background:#0b0d12;color:#e8ebf2;padding:16px'><p>%s</p><p><a style='color:#8ab8f5' href='/'>Volver</a></p>", problem);
        return httpd_resp_sendstr(req, out);
    }
    g_cfg = next;
    if (!cfg_save()) return httpd_resp_sendstr(req, "<!doctype html><meta charset=utf-8><body style='font:16px system-ui;background:#0b0d12;color:#e8ebf2;padding:16px'><p>No se pudo guardar. Int&eacute;ntalo de nuevo.</p>");
    saved = true;
    return httpd_resp_sendstr(req, "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><body style='font:16px system-ui;background:#0b0d12;color:#e8ebf2;padding:16px'><h1 style='font-size:1.3rem'>Guardado</h1><p>La placa se reinicia y se conecta a tu red. Ya puedes cerrar esta p&aacute;gina.</p>");
}

void portal_run(void)
{
    uint8_t mac[6]; esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
    char ssid[20], key[9], text[200];
    snprintf(ssid, sizeof(ssid), "Javi-%02X%02X", mac[4], mac[5]);
    snprintf(key, sizeof(key), "%08u", (unsigned)(esp_random() % 100000000u));

    net_pause();
    esp_wifi_stop();
    esp_netif_create_default_wifi_ap();
    wifi_config_t ap = { .ap = { .channel = 6, .max_connection = 2, .authmode = WIFI_AUTH_WPA2_PSK } };
    strlcpy((char *)ap.ap.ssid, ssid, sizeof(ap.ap.ssid)); ap.ap.ssid_len = (uint8_t)strlen(ssid);
    strlcpy((char *)ap.ap.password, key, sizeof(ap.ap.password));
    esp_wifi_set_mode(WIFI_MODE_AP);
    esp_wifi_set_config(WIFI_IF_AP, &ap);
    esp_wifi_start();

    httpd_handle_t server = NULL;
    httpd_config_t hc = HTTPD_DEFAULT_CONFIG();
    hc.stack_size = 8192;
    if (httpd_start(&server, &hc) == ESP_OK) {
        httpd_uri_t get = { .uri = "/", .method = HTTP_GET, .handler = page }, post = { .uri = "/guardar", .method = HTTP_POST, .handler = save };
        httpd_register_uri_handler(server, &get); httpd_register_uri_handler(server, &post);
    } else ESP_LOGE(TAG, "no arranco la pagina de ajustes");

    snprintf(text, sizeof(text), "Ajustes\n\nRed Wi-Fi: %s\nClave: %s\n\nLuego abre\n192.168.4.1", ssid, key);
    ui_message(text);
    ESP_LOGI(TAG, "pagina de ajustes abierta en la red %s", ssid); // la clave solo sale en la pantalla
    for (int seconds = 0; !saved && seconds < 15 * 60; seconds++) vTaskDelay(pdMS_TO_TICKS(1000)); // a los 15 min se cierra sola
    vTaskDelay(pdMS_TO_TICKS(1500)); // que alcance a salir la pagina de "Guardado"
    esp_restart();
}
