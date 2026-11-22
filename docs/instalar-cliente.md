# Instalar el asistente de un cliente (modo negocio)

Cada cliente que paga es un servicio aparte en Easypanel con el mismo código de minijavi y `MODO=negocio`: su dominio, su
base, su colección de documentos, su número de WhatsApp, su avatar y su voz. Nada tuyo (modo dueño, taller, herramientas)
existe en ese servicio.

## Preparar la carpeta del cliente

```
npm run cliente:nuevo                 # pregunta los datos y crea clientes/<id>/
npm run cliente:nuevo -- --desde respuestas.json   # lo mismo, desde un archivo ya lleno
npm run cliente:revisar -- <id>       # comprueba la carpeta antes de instalar
```

La carpeta queda con `negocio.json`, `variables.env`, `documentos/` y `PASOS.md` (esta misma guía con los datos del
cliente). `clientes/*` no va al repositorio: vive solo en tu computador, así que el respaldo es tuyo.
El comando no lee tu `.env` ni copia claves: las de los proveedores las pegas tú; las propias del cliente se generan al azar.

Lo que sigue es la guía que recibe cada cliente, con valores de ejemplo.

---

# Instalar el asistente de Panadería Ejemplo

Carpeta del cliente: `clientes/panaderia-ejemplo/` · Dirección: https://panaderia-ejemplo.minijavi.com · Colección de Qdrant: `cliente_panaderia_ejemplo`

Cada cliente es UN servicio aparte en Easypanel, con el mismo código de minijavi y `MODO=negocio`.
Los pasos 1 a 3 y el 6 se hacen fuera de este proyecto (Easypanel y Meta) y **no se han probado todavía con un cliente real**.

## 0. Antes de empezar
- [ ] Pon en `documentos/` lo que mandó el cliente (menú, precios, horarios): PDF (también escaneados), fotos JPG/PNG/WebP o texto. Solo eso: todo lo que haya en la carpeta se carga.
- [ ] Llena las líneas en blanco de `variables.env` (sección 2; la 4 si lleva WhatsApp).
- [ ] `npm run cliente:revisar -- panaderia-ejemplo` debe terminar sin faltantes.

## 1. Crear el servicio en Easypanel
- [ ] Servicio nuevo tipo App, desde el mismo repositorio de minijavi (rama `main`), con su Dockerfile. Nombre sugerido: `panaderia-ejemplo`.
- [ ] Volumen montado en `/app/data`. Sin volumen se pierden el archivo del negocio, la ficha y los pedidos en cada despliegue.
- [ ] Pega todo `variables.env` en Environment.
- [ ] NO publiques los puertos UDP 40000–40009: son de las llamadas de tu avatar; el modo negocio no contesta llamadas.
- [ ] Base de datos: crea una base PostgreSQL SOLO para este cliente y pon su dirección en `DATABASE_URL` (o déjala vacía para usar SQLite en el volumen).

## 2. Conectar el dominio
- [ ] En el DNS de `panaderia-ejemplo.minijavi.com`, un registro que apunte al VPS.
- [ ] En Easypanel → Domains: `panaderia-ejemplo.minijavi.com`, puerto 3000, con HTTPS (el micrófono del navegador exige https).

## 3. Subir el archivo del negocio y cargar los documentos
- [ ] Copia `negocio.json` al volumen como `/app/data/negocio.json` y la carpeta `documentos/` como `/app/data/documentos/`.
- [ ] Despliega. Si `negocio.json` falta o está mal, el servicio no arranca y el registro dice qué campo corregir.
- [ ] En la consola del servicio: `node --no-warnings dist/business/ingest.js` (lee `/app/data/documentos`). Debe listar cada archivo con ✓ y sus fragmentos.
- [ ] Reinicia el servicio para que tome la ficha nueva.

## 4. Probar la página
- [ ] Abre https://panaderia-ejemplo.minijavi.com: debe decir "Panadería Ejemplo", con su color y su avatar.
- [ ] Toca para hablar y pregunta algo que esté en sus documentos (un precio, un horario). Debe responder con su dato, no inventar.
- [ ] Pregunta algo que NO esté: debe decir que no lo sabe.
- [ ] `https://panaderia-ejemplo.minijavi.com/owner/register` debe responder 404 (en modo negocio no existe tu modo dueño).

## 5. Panel del cliente
- [ ] https://panaderia-ejemplo.minijavi.com/negocio.html → entra con `NEGOCIO_PANEL_CLAVE` (está en `variables.env`). Esa clave se la entregas al dueño del negocio.
- [ ] Haz un pedido de prueba por voz y comprueba que aparece ahí.

## 6. WhatsApp del negocio (si lo lleva)
- [ ] El número del cliente debe estar en la API de WhatsApp Business (Cloud API). Pon su `WHATSAPP_PHONE_NUMBER_ID`, un token limitado a ESA cuenta y el `WHATSAPP_APP_SECRET` de su app.
- [ ] En Meta → la app → WhatsApp → Configuración: webhook `https://panaderia-ejemplo.minijavi.com/webhooks/whatsapp`, token de verificación `<WHATSAPP_VERIFY_TOKEN de variables.env>`, campo `messages`.
- [ ] Escribe "hola" al número desde otro celular: debe responder el asistente.
- [ ] El dueño (+573001234567) le escribe "hola" al número del negocio: eso abre 24 horas de avisos por WhatsApp (pedidos, citas, "pásame con alguien"). Debe repetirlo cada día; el asistente se lo recuerda.

## 7. Avisos por Telegram (opcional)
- [ ] Un bot para este cliente (BotFather) y el chat del dueño: `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`. No uses tu bot: sus avisos se mezclarían con los tuyos.

## 8. Cobrar el consumo
- [ ] `curl -H "X-Reporte-Secret: <REPORTE_SECRET>" "https://panaderia-ejemplo.minijavi.com/api/consumo?dias=30"` devuelve lo usado (minutos de escucha, tokens, caracteres de voz). El valor está en `variables.env`.

## Cuando el cliente cambie algo
- Precios o menú nuevos: reemplaza los archivos en `/app/data/documentos`, repite la carga del paso 3 y reinicia.
- Saludo, color, avatar, voz o funciones: edita `/app/data/negocio.json` y reinicia.
- Dar de baja: detén el servicio, borra su volumen, su base y la colección `cliente_panaderia_ejemplo` en Qdrant.
