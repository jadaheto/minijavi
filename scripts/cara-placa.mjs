// Empaqueta la cara 2D (public/bolsillo, hecha con `npm run cara2d`) en un solo archivo para la placa: placa/cara.bin.
// La pantalla de la placa trabaja con 16 bits por punto (RGB565) y fondo negro, así que cada imagen se mezcla sobre negro
// y se guarda sin comprimir: la placa la lee directo de su memoria, sin copiarla ni descomprimirla.
//
// El archivo trae DOS caras seguidas: la grande (toda la pantalla) y la pequeña (public/bolsillo/mini), que acompaña a
// las tarjetas de datos. Cada una es un bloque con este formato (enteros en little-endian; las posiciones cuentan desde
// el inicio de SU bloque), el mismo que lee placa/main/face.c:
//   "MJC2" · lado (u16) · número de capas (u16) · posición de la cara base (u32) · tamaño del bloque (u32)
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
const out = path.join(root, 'placa', 'cara.bin');
const MAX_LAYERS = 3, MAX_FRAMES = 24, LAYER_BYTES = 316, HEAD_BYTES = 16;

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

/** Un bloque con una cara completa (la carpeta trae cara.json y sus imágenes). */
function pack(src) {
  if (!fs.existsSync(path.join(src, 'cara.json'))) { console.error(`Falta ${path.relative(root, src)}/cara.json: corre primero «npm run cara2d».`); process.exit(1); }
  const m = JSON.parse(fs.readFileSync(path.join(src, 'cara.json'), 'utf8'));
  const png = (f) => PNG.sync.read(fs.readFileSync(path.join(src, f)));
  const layers = Object.entries(m.capas);
  if (layers.length > MAX_LAYERS) throw new Error('la placa admite hasta 3 capas');
  const head = Buffer.alloc(HEAD_BYTES + MAX_LAYERS * LAYER_BYTES), parts = [];
  let at = head.length;
  const add = (buf) => { const pos = at; parts.push(buf); at += buf.length; return pos; };
  head.write('MJC2'); head.writeUInt16LE(m.lado, 4); head.writeUInt16LE(layers.length, 6);
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
  if (at % 4) add(Buffer.alloc(4 - (at % 4))); // el bloque siguiente empieza alineado
  head.writeUInt32LE(at, 12);
  return { blob: Buffer.concat([head, ...parts]), text: `${m.lado} x ${m.lado} (${layers.map(([n, c]) => `${c.cuadros.length} de ${n}`).join(', ')})` };
}

const big = pack(path.join(root, 'public', 'bolsillo')), small = pack(path.join(root, 'public', 'bolsillo', 'mini'));
const all = Buffer.concat([big.blob, small.blob]);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, all);
console.log(`placa/cara.bin: ${(all.length / 1048576).toFixed(2)} MB · cara grande ${big.text} y cara pequeña ${small.text} (la partición «cara» tiene 4 MB)`);
if (all.length > 4 * 1024 * 1024) { console.error('No cabe en la partición de 4 MB.'); process.exit(1); }
