import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * Estudio de avatares: UN solo sitio para armar los prompts y pedir las imagenes de los avatares de minijavi. Lo usan el
 * comando `npm run avatar` (y con el, la skill `crear-avatar`) y el servidor (avatares personalizados).
 *
 * Los textos NO viven aqui: salen de `content/avatares.json` (estilo, catalogo, vistas, retrato). Los de `estilo`,
 * `catalogo` y `vistas` son los que ya se usaron para hacer los ocho avatares del catalogo; el de `retrato` (foto de una
 * persona -> el mismo estilo) es nuevo.
 *
 * OpenAI Images (referencia leida el 2026-11-19): `POST /v1/images/edits` en JSON con `images: [{image_url}]` (data URL),
 * `n` de 1 a 10, devuelve `data[].b64_json`. `GET /v1/models/{id}` para saber si la cuenta tiene el modelo.
 */
export interface AvatarStyles {
  referencia: string;
  estilo: Record<string, string>;
  construccion: string[];
  catalogo: { id: string; nombre: string; humano: boolean; descripcion: string }[];
  vistas: Record<string, string>;
  retrato: { entrada: string; cierre: string };
}
export const VIEWS = ['perfil', 'trescuartos', 'ojoscerrados', 'atras'] as const;
export type ViewId = (typeof VIEWS)[number];

const ROOT = join(__dirname, '..', '..');
const abs = (p: string) => (isAbsolute(p) ? p : join(ROOT, p));

export function loadStyles(file = process.env.AVATARES_ARCHIVO || 'content/avatares.json'): AvatarStyles {
  const j = JSON.parse(readFileSync(abs(file), 'utf8'));
  const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  for (const k of ['tipo', 'proporciones', 'ojos', 'cejas', 'boca', 'pelo', 'piel_y_materiales', 'accesorios', 'iluminacion', 'fondo', 'encuadre'])
    if (!text(j?.estilo?.[k])) throw new Error(`${file}: falta estilo.${k}`);
  if (!Array.isArray(j.construccion) || !j.construccion.every(text)) throw new Error(`${file}: falta construccion`);
  if (!Array.isArray(j.catalogo) || !j.catalogo.every((c: any) => /^[a-z]{3,12}$/.test(c?.id) && text(c.descripcion))) throw new Error(`${file}: catalogo inválido`);
  for (const k of ['base', ...VIEWS]) if (!text(j?.vistas?.[k])) throw new Error(`${file}: falta vistas.${k}`);
  if (!text(j?.retrato?.entrada) || !text(j.retrato.cierre) || !text(j.referencia)) throw new Error(`${file}: falta retrato o referencia`);
  return j as AvatarStyles;
}

/** Las clausulas del estilo, en el orden de siempre. */
function styleClauses(s: AvatarStyles): string {
  const e = s.estilo;
  return `Estilo: ${e.tipo}. Proporciones: ${e.proporciones}. Ojos: ${e.ojos}. Cejas: ${e.cejas}. Boca: ${e.boca}. Pelo o pelaje: ${e.pelo}. Materiales: ${e.piel_y_materiales}. Accesorios: ${e.accesorios}. Iluminación: ${e.iluminacion}. Fondo: ${e.fondo}. Encuadre: ${e.encuadre}.`;
}

/** Personaje nuevo del catalogo a partir de una descripcion (el prompt con el que se hicieron los candidatos). Va con la imagen de referencia del estilo. */
export function catalogPrompt(s: AvatarStyles, description: string): string {
  return `Crea un personaje NUEVO con exactamente el mismo estilo visual de la imagen de referencia (misma técnica, mismos materiales y mismas proporciones de caricatura), pero que NO sea la misma persona: ${description.trim().replace(/\.+$/, '')}. ${styleClauses(s)} Debe poder modelarse en 3D con piezas simples: ${s.construccion.join('; ')}. Sin texto, sin logos, sin marcas de agua, sin marcos. No es una persona real.`;
}

/** Otra vista del MISMO personaje (para modelarlo). Va con la imagen elegida del personaje. */
export function viewPrompt(s: AvatarStyles, view: ViewId): string {
  return `${s.vistas.base} ${s.vistas[view]}`;
}

/** Retrato de una persona en el estilo de los avatares. Va con DOS imagenes: la referencia del estilo y luego la foto. */
export function portraitPrompt(s: AvatarStyles): string {
  return `${s.retrato.entrada} ${styleClauses(s)} ${s.retrato.cierre}`;
}

/** Imagen local -> data URL. El tipo sale de sus primeros bytes, no del nombre. */
export function dataUrl(buf: Buffer): string {
  const mime = buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : buf.subarray(8, 12).toString('latin1') === 'WEBP' ? 'image/webp' : '';
  if (!mime) throw new Error('la imagen no es JPG, PNG ni WebP');
  return `data:${mime};base64,${buf.toString('base64')}`;
}
export const styleReference = (s: AvatarStyles) => readFileSync(abs(s.referencia));

export interface OpenAiImages { key: string; model: string; quality?: string }
export class ImageBlocked extends Error {}

/** ¿La cuenta tiene el modelo de imagen? No genera nada ni gasta. */
export async function checkModel(o: OpenAiImages, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
  if (!o.key) return { ok: false, detail: 'no hay clave de OpenAI' };
  if (!/^[A-Za-z0-9._:-]{2,80}$/.test(o.model)) return { ok: false, detail: 'nombre de modelo inválido' };
  try {
    const r = await fetch(`https://api.openai.com/v1/models/${o.model}`, { headers: { Authorization: `Bearer ${o.key}` }, signal: signal ?? AbortSignal.timeout(15_000) });
    if (r.ok) return { ok: true, detail: `${o.model} está en la cuenta` };
    return { ok: false, detail: r.status === 401 ? 'clave inválida' : r.status === 404 ? `la cuenta no tiene el modelo ${o.model}` : `OpenAI respondió ${r.status}` };
  } catch (e) { return { ok: false, detail: `no se pudo conectar con OpenAI (${(e as Error).name})` }; }
}

/** Pide `n` imagenes cuadradas a partir de un prompt y una o varias imagenes de entrada (en ese orden). */
export async function renderImages(o: OpenAiImages, prompt: string, inputs: Buffer[], n = 1, signal?: AbortSignal): Promise<Buffer[]> {
  if (!o.key) throw new Error('no hay clave de OpenAI');
  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${o.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: o.model, prompt: prompt.slice(0, 32_000), images: inputs.map((b) => ({ image_url: dataUrl(b) })), n: Math.min(10, Math.max(1, n)), size: '1024x1024', quality: o.quality || 'medium', output_format: 'jpeg' }),
      signal: signal ?? AbortSignal.timeout(300_000) });
  } catch (e) { throw new Error(`no se pudo conectar con OpenAI (${(e as Error).name})`); }
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = String(d?.error?.code ?? ''), msg = String(d?.error?.message ?? '').replace(/\s+/g, ' ').slice(0, 200);
    if (code === 'moderation_blocked' || code === 'content_policy_violation' || /safety system|content policy|moderation/i.test(msg)) throw new ImageBlocked('el filtro de contenido de OpenAI rechazó la imagen');
    throw new Error(`OpenAI respondió ${res.status}${code === 'insufficient_quota' ? ' (la cuenta no tiene saldo)' : res.status === 401 ? ' (clave inválida)' : res.status === 429 ? ' (límite de peticiones: espera un minuto)' : msg ? ` (${msg})` : ''}`);
  }
  const out = (Array.isArray(d?.data) ? d.data : []).map((x: any) => String(x?.b64_json ?? '')).filter(Boolean).map((b: string) => Buffer.from(b, 'base64'));
  if (!out.length) throw new Error('OpenAI terminó sin entregar la imagen');
  return out;
}
