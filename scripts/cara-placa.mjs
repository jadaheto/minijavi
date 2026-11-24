// Empaqueta la cara 2D (public/bolsillo, hecha con `npm run cara2d`) en un solo archivo para la placa: placa/cara.bin.
// La pantalla de la placa trabaja con 16 bits por punto (RGB565) y fondo negro, así que cada imagen se mezcla sobre negro
// y se guarda sin comprimir: la placa la lee directo de su memoria, sin copiarla ni descomprimirla.
//
// Formato (enteros en little-endian), el mismo que lee placa/main/face.c:
//   "MJC1" · lado (u16) · número de capas (u16) · posición de la cara base (u32)
//   por cada capa (316 bytes): nombre[12] · x, y, ancho, alto (u16) · cuadros (u16) · relleno (u16) · posición de sus datos (u32)
//                              · nombres de sus cuadros [24][12]
//   datos: la cara base (lado x lado x 2 bytes) y, por capa, sus cuadros uno tras otro (ancho x alto x 2 bytes cada uno)
// Uso: npm run cara:placa
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { PNG } = createRequire(import.meta.url)('pngjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'public', 'bolsillo'), out = path.join(root, 'placa', 'cara.bin');
const MAX_LAYERS = 3, MAX_FRAMES = 24, LAYER_BYTES = 316, HEAD_BYTES = 12;

if (!fs.existsSync(path.join(src, 'cara.json'))) { console.error('Falta public/bolsillo/cara.json: corre primero «npm run cara2d».'); process.exit(1); }
const m = JSON.parse(fs.readFileSync(path.join(src, 'cara.json'), 'utf8'));
const png = (f) => PNG.sync.read(fs.readFileSync(path.join(src, f)));
/** Un rectángulo de un PNG, mezclado sobre negro, como RGB565. */
function rgb565(img, x0, y0, w, h) {
  const buf = Buffer.alloc(w * h * 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = ((y0 + y) * img.width + x0 + x) * 4, a = img.data[p + 3] / 255;
    const r = Math.round(img.data[p] * a), g = Math.round(img.data[p + 1] * a), b = Math.round(img.data[p + 2] * a);
    buf.writeUInt16LE(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3), (y * w + x) * 2);
  }
  return buf;
}
const name12 = (s) => { const b = Buffer.alloc(12); if (Buffer.byteLength(s) > 11) throw new Error(`nombre demasiado largo para la placa: ${s}`); b.write(s); return b; };

const layers = Object.entries(m.capas);
if (layers.length > MAX_LAYERS) throw new Error('la placa admite hasta 3 capas');
const head = Buffer.alloc(HEAD_BYTES + MAX_LAYERS * LAYER_BYTES), parts = [];
let at = head.length;
const add = (buf) => { const pos = at; parts.push(buf); at += buf.length; return pos; };
head.write('MJC1'); head.writeUInt16LE(m.lado, 4); head.writeUInt16LE(layers.length, 6);
const base = png(m.base); if (base.width !== m.lado || base.height !== m.lado) throw new Error('la cara base no mide lo que dice cara.json');
head.writeUInt32LE(add(rgb565(base, 0, 0, m.lado, m.lado)), 8);
layers.forEach(([name, c], n) => {
  if (c.cuadros.length > MAX_FRAMES) throw new Error(`la capa ${name} tiene más de ${MAX_FRAMES} cuadros`);
  const strip = png(c.archivo), o = HEAD_BYTES + n * LAYER_BYTES;
  name12(name).copy(head, o);
  head.writeUInt16LE(c.x, o + 12); head.writeUInt16LE(c.y, o + 14); head.writeUInt16LE(c.w, o + 16); head.writeUInt16LE(c.h, o + 18);
  head.writeUInt16LE(c.cuadros.length, o + 20);
  head.writeUInt32LE(at, o + 24);
  c.cuadros.forEach((f, i) => name12(f).copy(head, o + 28 + i * 12));
  c.cuadros.forEach((_, i) => add(rgb565(strip, i * c.w, 0, c.w, c.h)));
});
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([head, ...parts]));
console.log(`placa/cara.bin: ${(at / 1048576).toFixed(2)} MB · cara de ${m.lado} x ${m.lado} y ${layers.map(([n, c]) => `${c.cuadros.length} de ${n}`).join(', ')} (la partición «cara» tiene 4 MB)`);
if (at > 4 * 1024 * 1024) { console.error('No cabe en la partición de 4 MB.'); process.exit(1); }
