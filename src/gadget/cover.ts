/**
 * Javi de bolsillo: carátula de lo que suena en Spotify.
 *
 * La placa no descarga ni descomprime imágenes: el servidor baja la carátula (solo de los servidores de imágenes de
 * Spotify), la reduce a 150 x 150 SIN recortarla (si no es cuadrada, queda centrada sobre negro) y se la manda ya en el
 * formato de su pantalla (RGB565), en una trama binaria: 6 bytes (tipo 2, 0, ancho y alto en 16 bits) + los puntos.
 */
import { decode } from 'jpeg-js';

export const GADGET_COVER = 2;
export const COVER_SIDE = 150;
const HOSTS = /(^|\.)(scdn\.co|spotifycdn\.com)$/;
const cache = new Map<string, Buffer>();

/** JPEG -> trama para la placa. Lanza si no es un JPEG que se pueda leer. */
export function coverFrame(jpeg: Buffer, side = COVER_SIDE): Buffer {
  const img = decode(jpeg, { useTArray: true, maxResolutionInMP: 4, maxMemoryUsageInMB: 64 });
  if (!img.width || !img.height) throw new Error('imagen vacía');
  const scale = Math.min(side / img.width, side / img.height), w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
  const x0 = Math.floor((side - w) / 2), y0 = Math.floor((side - h) / 2);
  const out = Buffer.alloc(6 + side * side * 2); // lo que no cubre la imagen queda negro
  out[0] = GADGET_COVER; out.writeUInt16LE(side, 2); out.writeUInt16LE(side, 4);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * img.height) / h), sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * img.width) / w), sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * img.width) / w));
      let r = 0, g = 0, b = 0, n = 0; // promedio de los puntos que caen en este: reduce sin dientes
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) { const p = (sy * img.width + sx) * 4; r += img.data[p]; g += img.data[p + 1]; b += img.data[p + 2]; n++; }
      r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
      out.writeUInt16LE(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3), 6 + ((y0 + y) * side + x0 + x) * 2);
    }
  }
  return out;
}

/** Baja la carátula y la deja lista para la placa. `undefined` si la dirección no es de Spotify o algo falla (la tarjeta sale sin imagen). */
export async function fetchCover(url: unknown): Promise<Buffer | undefined> {
  let u: URL;
  try { u = new URL(String(url)); } catch { return undefined; }
  if (u.protocol !== 'https:' || !HOSTS.test(u.hostname)) return undefined;
  const key = u.toString(), hit = cache.get(key);
  if (hit) return hit;
  try {
    const res = await fetch(key, { signal: AbortSignal.timeout(4000), redirect: 'error' });
    if (!res.ok) return undefined;
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length < 100 || body.length > 1_500_000 || body[0] !== 0xff || body[1] !== 0xd8) return undefined; // solo JPEG de tamaño razonable
    const frame = coverFrame(body);
    cache.set(key, frame); if (cache.size > 40) cache.delete(cache.keys().next().value!);
    return frame;
  } catch { return undefined; }
}
