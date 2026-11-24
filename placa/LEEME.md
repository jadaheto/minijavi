# Javi de bolsillo: programa de la placa

Programa para la placa **Waveshare ESP32-S3-Touch-AMOLED-1.75C**. Muestra la cara 2D del avatar y conversa por voz con
el servidor de minijavi en modo dueño.

> **Estado: escrito y compilado sin la placa.** Nunca se ha ejecutado en una placa real. La conversación con el servidor
> sí está probada con una placa simulada. La primera vez habrá que ajustar cosas con la placa conectada (ver "Lo que
> falta probar").

## Cargarlo

1. Conecta la placa al computador por USB-C.
2. En esta carpeta: `./cargar.sh` (compila y carga el programa y la cara). Con `./cargar.sh ver` queda abierto el
   registro de la placa.

Necesita ESP-IDF v5.5.x en `~/esp/esp-idf` (o `IDF_PATH`) y haber generado la cara 2D (`npm run cara2d` en la carpeta
de arriba; el paquete para la placa lo arma solo).

Si la placa no entra en modo de carga: mantén oprimido **BOOT**, toca **PWR** y suelta BOOT.

## Primera vez

1. La pantalla muestra **Ajustes**, una red Wi-Fi `Javi-XXXX` y una clave de 8 números (cambia cada vez).
2. Conéctate a esa red desde el celular y abre `http://192.168.4.1`.
3. Escribe hasta tres redes Wi-Fi (solo 2,4 GHz), la dirección del servidor (`wss://yo.minijavi.com/ws`) y el **pase**:
   se crea en el panel de minijavi, en Dispositivos → Javi de bolsillo.
4. Guarda. La placa se reinicia y se conecta.

Para volver a los ajustes: deja el dedo 3 segundos en la pantalla, o enciéndela con BOOT oprimido.

## Uso

| En la pantalla | Qué pasa |
|---|---|
| Cara tranquila, sin anillo | En reposo. **Un toque abre la conversación.** |
| Anillo verde | Te oye (manos libres). |
| Anillo ámbar | Prepara la respuesta. |
| Anillo azul | Está hablando. **Un toque lo corta.** |
| Ojos cerrados | Suspendido ("silénciate"). Un toque o decir "Javi" lo despierta. |
| Tarjeta con una cifra y la cara pequeña | Datos de lo que preguntaste (Tesla, clima, dólar o Bitcoin, trayecto, servicios, resumen). Se va sola a los 12 s de terminar de hablar, o con un toque. |
| Carátula con « y » | Música en Spotify (suena en tu celular o computador, no en la placa). Toca la carátula para pausar o seguir, « y » para cambiar de canción; tocar la cara quita la tarjeta. |
| Tarjeta que aparece sola, con un tono | Un aviso (interesado nuevo, algo por aprobar, pago por revisar, taller, servicio caído). Tócala arriba y el avatar te lo cuenta; toca la cara para quitarla. De 9 p. m. a 7 a. m. no llegan: salen en la mañana. |
| Aviso «Por aprobar» (dice «Deja el dedo 2 s: aprobar») | Una solicitud de la bandeja. **Deja el dedo 2 segundos** (el anillo se llena) y queda aprobada; la tarjeta dice si salió, quedó en espera o no salió. Rechazar: en el panel o en Telegram. Los pagos de avatar no se aprueban aquí. |
| Tarjeta con título y tres renglones, sin cifra | Una lista (noticias, mercados, tareas, cargadores). Pasa sola de tres en tres. |
| Hora grande, fecha y un renglón tenue | Reloj de reposo: sale a los 45 s sin usarla, con el clima y la batería del carro. Enchufada se queda así; con batería se apaga a los 5 min. Un toque abre la conversación. |

La conversación se cierra sola por inactividad (lo decide el servidor). En reposo la pantalla baja el brillo a los 45 s
y se apaga a los 5 min; un toque la enciende.

Mientras el avatar habla, el micrófono no se envía: la placa todavía no cancela el eco, y sin eso se oiría a sí misma.
Por eso se le corta con un toque y no con la voz.

## Cómo está hecho

| Archivo | Qué hace |
|---|---|
| `main/main.c` | Arranque y estados (reposo, conectando, oyendo, pensando, hablando, suspendido). |
| `main/session.c` | Conversación con el servidor por WebSocket seguro. |
| `main/audio.c` | Parlante y micrófonos, a 16 kHz como el ejemplo del fabricante. |
| `main/face.c`, `main/mind.c`, `main/ui.c` | La cara (grande y pequeña), sus gestos, la pantalla y las tarjetas de datos. |
| `main/letra/` | Letra Montserrat (licencia OFL), para que salgan las tildes. |
| `main/portal.c`, `main/config.c`, `main/net.c` | Página de ajustes, lo guardado y el Wi-Fi. |
| `main/notices.c` | Avisos que llegan solos: enchufada espera el aviso al instante; con batería pregunta cada 5 minutos. |
| `main/power.c` | Porcentaje de batería. |
| `partitions.csv` | Programa (6 MB) y cara (4 MB). |

Usa el componente oficial de la placa (`waveshare/esp32_s3_touch_amoled_1_75c`), LVGL 9.5 y el cliente WebSocket de
Espressif; se bajan solos al compilar. El pase y las claves de Wi-Fi viven solo en la memoria de la placa: no están en
este repositorio ni salen en el registro.

## Lo que falta probar (todo necesita la placa)

- Que encienda, muestre la cara y los colores salgan bien.
- El audio: que el parlante suene y los micrófonos se oigan a 16 kHz, el volumen y la ganancia del micrófono
  (`MIC_GAIN_DB` en `audio.c`).
- Que la boca vaya a tiempo con la voz (`OUT_DELAY_MS` en `audio.c`).
- Que la pantalla alcance a redibujar la boca con fluidez.
- Las tarjetas: que la letra se lea bien, el anillo, y que la cara pequeña mueva la boca.
- Los avisos: que lleguen enchufada y con batería, el tono, y cuánta batería gasta preguntar cada 5 minutos.
- La tarjeta de música: que la carátula llegue y se vea, y que los toques caigan donde deben (si la pantalla táctil sale volteada, « y » quedarían al revés).
- El toque largo, el botón BOOT (se asumió el pin 0) y la lectura de la batería.
- Aprobar con el dedo (que no se confunda con el toque largo de 3 s de los ajustes), el reloj de reposo (brillo, que la hora no se atrase, que se corra cada minuto) y cómo se leen las listas de tres renglones.
- La página de ajustes desde un celular real y la conexión segura al servidor.
- Cuánto dura la batería.
