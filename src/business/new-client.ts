import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { AVATARS, FUNCIONES, loadBusiness } from './business';

/**
 * C4 (2026-11-21): preparar la instalacion de un cliente del "modo negocio" sin armar archivos a mano.
 *   npm run cliente:nuevo [-- --desde respuestas.json] [--carpeta clientes]   pregunta los datos y deja clientes/<id>/ lista
 *   npm run cliente:revisar -- <id> [--carpeta clientes]                      comprueba la carpeta antes de instalar
 *
 * La carpeta trae: negocio.json (validado con el MISMO codigo que usa el servidor al arrancar), variables.env (todo lo que
 * hay que pegar en Easypanel), documentos/ (lo que mande el cliente) y PASOS.md (la guia con sus datos ya puestos).
 *
 * Reglas: este comando NO lee el .env de Javier ni copia ninguna clave (las del proveedor quedan en blanco para pegarlas a
 * mano); las claves propias del cliente se generan al azar; no toca nada fuera de la carpeta; no crea nada en Easypanel ni
 * en Meta. `clientes/*` esta fuera de git: las carpetas viven solo en el computador de Javier.
 */
export interface ClientAnswers {
  nombre: string; asistente?: string; saludo?: string; personalidad?: string; color?: string; avatar?: string; voz?: string;
  preguntas?: string[]; dueno_whatsapp?: string; funciones?: string[]; humano_minutos?: number;
  /** Donde va a vivir: "panaderia.minijavi.com" o el dominio propio del cliente (sin https://). */
  dominio: string;
}
export interface ClientFiles { id: string; files: Record<string, string> }
/** Las variables que hay que llenar a mano para que el servicio arranque y atienda. */
export const REQUIRED_VARS = ['DEEPGRAM_API_KEY', 'DEEPSEEK_API_KEY', 'ELEVENLABS_API_KEY', 'NVIDIA_API_KEY', 'QDRANT_URL', 'MODELO_CAPAZ', 'MODELO_CAPAZ_KEY'] as const;

export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
}
const cleanDomain = (d: string) => String(d ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const key = (bytes: number) => randomBytes(bytes).toString('hex');

/** Valida las respuestas y arma los archivos de la carpeta. Lanza un error claro (con el campo) si algo no sirve. */
export function buildClient(a: ClientAnswers, taken: { ids?: string[]; collections?: string[] } = {}): ClientFiles {
  const id = slugify(String(a.nombre ?? ''));
  if (id.length < 3) throw new Error('nombre: escribe el nombre del negocio (al menos 3 letras)');
  if (id === 'ejemplo' || taken.ids?.includes(id)) throw new Error(`nombre: ya existe un cliente con la carpeta "${id}"`);
  const dominio = cleanDomain(a.dominio);
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(dominio)) throw new Error('dominio: escribe un dominio válido, sin https:// (por ejemplo panaderia.minijavi.com)');
  if (a.color && !/^#[0-9a-f]{6}$/i.test(a.color)) throw new Error('color: debe ser #rrggbb (por ejemplo #b0541c)');
  if (a.avatar && !(AVATARS as readonly string[]).includes(a.avatar)) throw new Error(`avatar: debe ser uno de ${AVATARS.join(', ')}`);
  if (a.voz && !/^[A-Za-z0-9]{10,40}$/.test(a.voz)) throw new Error('voz: debe ser el id de una voz de ElevenLabs (solo letras y números)');
  const wa = String(a.dueno_whatsapp ?? '').replace(/\D/g, '');
  if (wa && !((wa.length === 10 && wa.startsWith('3')) || (wa.length >= 11 && wa.length <= 15))) throw new Error('dueno_whatsapp: un celular colombiano de 10 dígitos, o el número con indicativo');
  const funciones = a.funciones ?? [...FUNCIONES];
  const mal = funciones.filter((f) => !(FUNCIONES as readonly string[]).includes(f));
  if (mal.length) throw new Error(`funciones: no existe "${mal[0]}" (son ${FUNCIONES.join(', ')})`);
  const coleccion = `cliente_${id.replace(/-/g, '_')}`;
  if (coleccion === 'minijavi' || taken.collections?.includes(coleccion)) throw new Error(`la colección ${coleccion} ya la usa otro servicio`);

  const negocio = { nombre: a.nombre.trim().slice(0, 80), asistente: (a.asistente ?? '').trim(), saludo: (a.saludo ?? '').trim(), personalidad: (a.personalidad ?? '').trim(), color: (a.color ?? '#3987e5').toLowerCase(),
    avatar: a.avatar ?? 'hombre', voz: a.voz ?? '', preguntas: (a.preguntas ?? []).map((q) => String(q).trim()).filter(Boolean).slice(0, 3), dueno_whatsapp: wa, funciones, humano_minutos: Number(a.humano_minutos) || 60 };
  // El archivo debe pasar por el validador del servidor: si aqui falla, el servicio tampoco arrancaria.
  const tmp = mkdtempSync(join(tmpdir(), 'cliente-')), file = join(tmp, 'negocio.json'), json = `${JSON.stringify(negocio, null, 2)}\n`;
  try { writeFileSync(file, json); loadBusiness(file); } finally { rmSync(tmp, { recursive: true, force: true }); }

  const verify = key(12);
  const env = `# Variables del servicio de ${negocio.nombre} (${id}). Pégalas en Easypanel → el servicio → Environment.
# Este archivo NO va al repositorio. Las líneas en blanco de la sección 2 las llenas tú; nada de esto se copió de tu .env.

# 1. Lo que hace que este servicio sea el asistente de este cliente
MODO=negocio
DATA_DIR=/app/data
BUSINESS_ID=${id}
PUBLIC_URL=https://${dominio}
QDRANT_COLLECTION=${coleccion}
TIMEZONE=America/Bogota
ACCESS_CODE=

# 2. Claves de los proveedores (el consumo de este cliente sale de estas claves)
DEEPGRAM_API_KEY=
DEEPSEEK_API_KEY=
ELEVENLABS_API_KEY=
# Voz por defecto del servidor: solo se usa si negocio.json no trae "voz".
ELEVENLABS_VOICE_ID=${negocio.voz}
NVIDIA_API_KEY=
QDRANT_URL=
QDRANT_API_KEY=
# El modelo capaz lee los documentos del cliente (PDF y fotos): tiene que ser de OpenAI.
MODELO_CAPAZ_PROVEEDOR=openai
MODELO_CAPAZ=
MODELO_CAPAZ_KEY=

# 3. Base de datos de ESTE cliente (una base aparte; vacío = SQLite dentro del volumen)
DATABASE_URL=

# 4. WhatsApp del negocio (su número, no el tuyo). Vacío = solo la página con el avatar.
WHATSAPP_REPLIES=avatar
WHATSAPP_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_APP_SECRET=
WHATSAPP_VERIFY_TOKEN=${verify}

# 5. Avisos por Telegram al dueño del negocio (opcional). Sin botones: este servicio no aprueba nada.
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_BUTTONS=0

# 6. Claves propias de este cliente, generadas al azar (no las reutilices en otro)
REPORTE_SECRET=${key(24)}
NEGOCIO_PANEL_CLAVE=${key(9)}
`;
  return { id, files: { 'negocio.json': json, 'variables.env': env, 'PASOS.md': steps({ id, nombre: negocio.nombre, dominio, coleccion, whatsapp: wa, verify }) } };
}

/** La guia con los datos del cliente ya puestos. `docs/instalar-cliente.md` es la misma con valores de ejemplo. */
export function steps(c: { id: string; nombre: string; dominio: string; coleccion: string; whatsapp: string; verify: string }): string {
  const url = `https://${c.dominio}`;
  return `# Instalar el asistente de ${c.nombre}

Carpeta del cliente: \`clientes/${c.id}/\` · Dirección: ${url} · Colección de Qdrant: \`${c.coleccion}\`

Cada cliente es UN servicio aparte en Easypanel, con el mismo código de minijavi y \`MODO=negocio\`.
Los pasos 1 a 3 y el 6 se hacen fuera de este proyecto (Easypanel y Meta) y **no se han probado todavía con un cliente real**.

## 0. Antes de empezar
- [ ] Pon en \`documentos/\` lo que mandó el cliente (menú, precios, horarios): PDF (también escaneados), fotos JPG/PNG/WebP o texto. Solo eso: todo lo que haya en la carpeta se carga.
- [ ] Llena las líneas en blanco de \`variables.env\` (sección 2; la 4 si lleva WhatsApp).
- [ ] \`npm run cliente:revisar -- ${c.id}\` debe terminar sin faltantes.

## 1. Crear el servicio en Easypanel
- [ ] Servicio nuevo tipo App, desde el mismo repositorio de minijavi (rama \`main\`), con su Dockerfile. Nombre sugerido: \`${c.id}\`.
- [ ] Volumen montado en \`/app/data\`. Sin volumen se pierden el archivo del negocio, la ficha y los pedidos en cada despliegue.
- [ ] Pega todo \`variables.env\` en Environment.
- [ ] NO publiques los puertos UDP 40000–40009: son de las llamadas de tu avatar; el modo negocio no contesta llamadas.
- [ ] Base de datos: crea una base PostgreSQL SOLO para este cliente y pon su dirección en \`DATABASE_URL\` (o déjala vacía para usar SQLite en el volumen).

## 2. Conectar el dominio
- [ ] En el DNS de \`${c.dominio}\`, un registro que apunte al VPS.
- [ ] En Easypanel → Domains: \`${c.dominio}\`, puerto 3000, con HTTPS (el micrófono del navegador exige https).

## 3. Subir el archivo del negocio y cargar los documentos
- [ ] Copia \`negocio.json\` al volumen como \`/app/data/negocio.json\` y la carpeta \`documentos/\` como \`/app/data/documentos/\`.
- [ ] Despliega. Si \`negocio.json\` falta o está mal, el servicio no arranca y el registro dice qué campo corregir.
- [ ] En la consola del servicio: \`node --no-warnings dist/business/ingest.js\` (lee \`/app/data/documentos\`). Debe listar cada archivo con ✓ y sus fragmentos.
- [ ] Reinicia el servicio para que tome la ficha nueva.

## 4. Probar la página
- [ ] Abre ${url}: debe decir "${c.nombre}", con su color y su avatar.
- [ ] Toca para hablar y pregunta algo que esté en sus documentos (un precio, un horario). Debe responder con su dato, no inventar.
- [ ] Pregunta algo que NO esté: debe decir que no lo sabe.
- [ ] \`${url}/owner/register\` debe responder 404 (en modo negocio no existe tu modo dueño).

## 5. Panel del cliente
- [ ] ${url}/negocio.html → entra con \`NEGOCIO_PANEL_CLAVE\` (está en \`variables.env\`). Esa clave se la entregas al dueño del negocio.
- [ ] Haz un pedido de prueba por voz y comprueba que aparece ahí.

## 6. WhatsApp del negocio (si lo lleva)
- [ ] El número del cliente debe estar en la API de WhatsApp Business (Cloud API). Pon su \`WHATSAPP_PHONE_NUMBER_ID\`, un token limitado a ESA cuenta y el \`WHATSAPP_APP_SECRET\` de su app.
- [ ] En Meta → la app → WhatsApp → Configuración: webhook \`${url}/webhooks/whatsapp\`, token de verificación \`${c.verify}\`, campo \`messages\`.
- [ ] Escribe "hola" al número desde otro celular: debe responder el asistente.
${c.whatsapp ? `- [ ] El dueño (+${c.whatsapp.length === 10 ? '57' + c.whatsapp : c.whatsapp}) le escribe "hola" al número del negocio: eso abre 24 horas de avisos por WhatsApp (pedidos, citas, "pásame con alguien"). Debe repetirlo cada día; el asistente se lo recuerda.` : '- [ ] Este cliente no tiene WhatsApp del dueño en `negocio.json`: los avisos van solo por Telegram.'}

## 7. Avisos por Telegram (opcional)
- [ ] Un bot para este cliente (BotFather) y el chat del dueño: \`TELEGRAM_BOT_TOKEN\` y \`TELEGRAM_CHAT_ID\`. No uses tu bot: sus avisos se mezclarían con los tuyos.

## 8. Cobrar el consumo
- [ ] \`curl -H "X-Reporte-Secret: <REPORTE_SECRET>" "${url}/api/consumo?dias=30"\` devuelve lo usado (minutos de escucha, tokens, caracteres de voz). El valor está en \`variables.env\`.

## Cuando el cliente cambie algo
- Precios o menú nuevos: reemplaza los archivos en \`/app/data/documentos\`, repite la carga del paso 3 y reinicia.
- Saludo, color, avatar, voz o funciones: edita \`/app/data/negocio.json\` y reinicia.
- Dar de baja: detén el servicio, borra su volumen, su base y la colección \`${c.coleccion}\` en Qdrant.
`;
}

/** Lee `variables.env` sin ejecutar nada: solo lineas CLAVE=valor. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) { const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim()); if (m) out[m[1]] = m[2].trim(); }
  return out;
}

/** Revisa la carpeta de un cliente. `errors` impide instalar; `warnings` son cosas que conviene mirar. */
export function checkClient(base: string, id: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [], dir = join(base, id);
  if (!/^[a-z0-9-]{3,32}$/.test(id) || !existsSync(dir)) return { errors: [`no existe la carpeta ${dir}`], warnings };
  try { loadBusiness(join(dir, 'negocio.json')); } catch (e) { errors.push((e as Error).message.replace(/^MODO=negocio: /, 'negocio.json: ')); }
  let raw: any = {}; try { raw = JSON.parse(readFileSync(join(dir, 'negocio.json'), 'utf8')); } catch { /* ya se reporto arriba */ }
  if (raw.avatar && !(AVATARS as readonly string[]).includes(raw.avatar)) errors.push(`negocio.json: el avatar "${raw.avatar}" no existe (${AVATARS.join(', ')})`);
  else if (raw.avatar && !existsSync(join(__dirname, '..', '..', 'public', 'models', `avatar-${raw.avatar}.glb`))) errors.push(`falta el modelo public/models/avatar-${raw.avatar}.glb`);
  if (!raw.voz) warnings.push('negocio.json: sin "voz", el asistente habla con la voz por defecto del servidor (ELEVENLABS_VOICE_ID)');
  if (!existsSync(join(dir, 'variables.env'))) errors.push('falta variables.env');
  else {
    const env = parseEnv(readFileSync(join(dir, 'variables.env'), 'utf8'));
    if (env.MODO !== 'negocio') errors.push('variables.env: MODO debe ser negocio');
    for (const k of REQUIRED_VARS) if (!env[k]) errors.push(`variables.env: falta ${k}`);
    if (env.MODELO_CAPAZ_PROVEEDOR !== 'openai') errors.push('variables.env: MODELO_CAPAZ_PROVEEDOR debe ser openai (lee los documentos)');
    if (!/^https:\/\/[a-z0-9.-]+$/.test(env.PUBLIC_URL ?? '')) errors.push('variables.env: PUBLIC_URL debe ser https://dominio');
    if ((env.REPORTE_SECRET ?? '').length < 16) errors.push('variables.env: REPORTE_SECRET debe tener al menos 16 caracteres');
    if ((env.NEGOCIO_PANEL_CLAVE ?? '').length < 12) warnings.push('variables.env: sin NEGOCIO_PANEL_CLAVE (mínimo 12) el cliente no tiene panel');
    const col = env.QDRANT_COLLECTION ?? '';
    if (!col || col === 'minijavi') errors.push('variables.env: QDRANT_COLLECTION no puede estar vacía ni ser "minijavi" (es la tuya)');
    // Ningun otro cliente puede compartir coleccion, identificador ni claves propias.
    for (const other of readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== id)) {
      const f = join(base, other.name, 'variables.env'); if (!existsSync(f)) continue;
      const o = parseEnv(readFileSync(f, 'utf8'));
      if (col && o.QDRANT_COLLECTION === col) errors.push(`QDRANT_COLLECTION "${col}" también la usa el cliente ${other.name}: verían los documentos del otro`);
      if (env.BUSINESS_ID && o.BUSINESS_ID === env.BUSINESS_ID) errors.push(`BUSINESS_ID "${env.BUSINESS_ID}" también lo usa el cliente ${other.name}`);
      for (const k of ['REPORTE_SECRET', 'NEGOCIO_PANEL_CLAVE', 'DATABASE_URL', 'WHATSAPP_PHONE_NUMBER_ID'] as const) if (env[k] && o[k] === env[k]) errors.push(`${k} es igual a la del cliente ${other.name}: cada cliente lleva la suya`);
    }
    if (!env.DATABASE_URL) warnings.push('variables.env: sin DATABASE_URL usa SQLite dentro del volumen (sirve, pero el respaldo es el volumen)');
    if (env.WHATSAPP_REPLIES === 'avatar' && !(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID)) warnings.push('variables.env: sin WHATSAPP_TOKEN y WHATSAPP_PHONE_NUMBER_ID no hay chat de WhatsApp (solo la página)');
    else if (env.WHATSAPP_TOKEN && !env.WHATSAPP_APP_SECRET) errors.push('variables.env: con WhatsApp hace falta WHATSAPP_APP_SECRET (sin él no se aceptan los avisos de Meta)');
    if (!env.TELEGRAM_BOT_TOKEN && !raw.dueno_whatsapp) warnings.push('sin Telegram ni WhatsApp del dueño, nadie recibe los avisos de pedidos y citas (solo quedan en el panel)');
  }
  const docs = existsSync(join(dir, 'documentos')) ? readdirSync(join(dir, 'documentos')).filter((f) => /\.(pdf|jpe?g|png|webp|txt|md)$/i.test(f)) : [];
  if (!docs.length) warnings.push('documentos/ está vacía: el asistente no sabrá nada del negocio hasta cargar algo');
  return { errors, warnings };
}

/** Clientes que ya existen en la carpeta base (para no repetir carpeta ni coleccion). */
export function existing(base: string): { ids: string[]; collections: string[] } {
  if (!existsSync(base)) return { ids: [], collections: [] };
  const ids = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  return { ids, collections: ids.map((i) => join(base, i, 'variables.env')).filter(existsSync).map((f) => parseEnv(readFileSync(f, 'utf8')).QDRANT_COLLECTION).filter(Boolean) };
}

/** Escribe la carpeta. Nunca pisa una que ya exista. */
export function writeClient(base: string, c: ClientFiles): string {
  const dir = join(base, c.id);
  if (existsSync(dir)) throw new Error(`ya existe ${dir}; bórrala o usa otro nombre`);
  mkdirSync(join(dir, 'documentos'), { recursive: true }); // vacia: TODO lo que haya ahi se carga como documento del negocio
  for (const [name, text] of Object.entries(c.files)) { const f = join(dir, name); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, text, { mode: name === 'variables.env' ? 0o600 : 0o644 }); }
  return dir;
}

async function ask(): Promise<ClientAnswers> {
  // Las lineas se leen de una cola: funciona igual escribiendo a mano que con la entrada por tuberia (asi se prueba).
  const rl = createInterface({ input: process.stdin }), lines = rl[Symbol.asyncIterator]();
  const question = async (text: string) => { process.stdout.write(text); const n = await lines.next(); if (n.done) throw new Error('se acabó la entrada antes de terminar las preguntas'); return String(n.value); };
  const a: Record<string, any> = {};
  // Cada respuesta se valida al escribirla: se arma el cliente con lo que hay y, si el error es de ese campo, se repite la pregunta.
  const q = async (field: string, text: string, def = '', map: (v: string) => unknown = (v) => v) => {
    for (;;) {
      const v = (await question(`${text}${def ? ` [${def}]` : ''}: `)).trim() || def;
      a[field] = map(v);
      try { buildClient({ nombre: 'Nombre provisional', dominio: 'provisional.example.com', ...a } as ClientAnswers); return; }
      catch (e) { const m = (e as Error).message; if (!m.startsWith(`${field}:`) && !/MODO=negocio/.test(m)) return; console.log(`  ✗ ${m.replace(/^MODO=negocio: /, '')}`); }
    }
  };
  try {
    console.log('Cliente nuevo del modo negocio. Enter deja el valor entre corchetes.\n');
    await q('nombre', 'Nombre del negocio');
    await q('dominio', 'Dominio donde va a vivir (sin https://)', `${slugify(a.nombre)}.minijavi.com`);
    await q('asistente', 'Nombre del asistente (vacío = "el asistente virtual de …")');
    await q('saludo', 'Saludo (una frase; vacío = uno por defecto)');
    await q('personalidad', 'Cómo habla (una o dos frases; vacío = amable y breve)');
    await q('color', 'Color de la marca', '#3987e5');
    await q('avatar', `Avatar (${AVATARS.join(', ')})`, 'hombre');
    await q('voz', 'Id de la voz de ElevenLabs (vacío = la del servidor)');
    const qs: string[] = []; for (let i = 1; i <= 3; i++) { const v = (await question(`Pregunta sugerida ${i} (vacío = no más): `)).trim(); if (!v) break; qs.push(v); } a.preguntas = qs;
    await q('dueno_whatsapp', 'WhatsApp del dueño del negocio (vacío = sin avisos por WhatsApp)');
    await q('funciones', `Funciones, separadas por coma (${FUNCIONES.join(', ')})`, FUNCIONES.join(','), (v) => v.split(',').map((x) => x.trim()).filter(Boolean));
  } finally { rl.close(); }
  return a as ClientAnswers;
}

async function main() {
  const args = process.argv.slice(2), opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] ?? '' : ''; };
  const base = resolve(opt('carpeta') || 'clientes'), from = opt('desde'), [cmd, id = ''] = args;
  if (cmd === 'revisar' && id) {
    const r = checkClient(base, id);
    for (const e of r.errors) console.log(` ✗ ${e}`);
    for (const w of r.warnings) console.log(` ⚠ ${w}`);
    console.log(r.errors.length ? `\n${r.errors.length} cosa${r.errors.length === 1 ? '' : 's'} por corregir antes de instalar.` : `\nLista para instalar${r.warnings.length ? ` (${r.warnings.length} aviso${r.warnings.length === 1 ? '' : 's'})` : ''}. Sigue ${join(base, id, 'PASOS.md')}.`);
    process.exit(r.errors.length ? 1 : 0);
  }
  if (cmd !== 'nuevo') { console.log('Uso: npm run cliente:nuevo [-- --desde respuestas.json] [--carpeta clientes]\n     npm run cliente:revisar -- <id> [--carpeta clientes]'); process.exit(cmd ? 1 : 0); }
  const answers: ClientAnswers = from ? JSON.parse(readFileSync(from, 'utf8')) : await ask();
  const client = buildClient(answers, existing(base)), dir = writeClient(base, client);
  console.log(`\n✓ ${dir}\n   negocio.json · variables.env · documentos/ · PASOS.md\n\nSigue así:\n 1. Pon en documentos/ lo que mandó el cliente.\n 2. Llena las claves en blanco de variables.env.\n 3. npm run cliente:revisar -- ${client.id}\n 4. Sigue PASOS.md.`);
}
if (require.main === module) main().catch((e) => { console.error(`✗ ${(e as Error).message.replace(/^MODO=negocio: /, '')}`); process.exit(1); });
