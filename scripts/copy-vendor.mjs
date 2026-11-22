// Copia Three.js desde node_modules a public/vendor para servirlo localmente (sin CDN).
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'three');
const dst = join(root, 'public', 'vendor', 'three');
const files = [
  'build/three.module.js',
  'build/three.core.js',
  'examples/jsm/loaders/GLTFLoader.js',
  'examples/jsm/utils/BufferGeometryUtils.js',
  'examples/jsm/utils/SkeletonUtils.js',
];
for (const f of files) {
  mkdirSync(dirname(join(dst, f)), { recursive: true });
  cpSync(join(src, f), join(dst, f));
}
// GSAP para los sitios del taller (licencia propia de GSAP, gratis tambien para uso comercial: gsap.com/standard-license).
// El taller copia estas librerias de public/vendor a sitio/vendor de cada proyecto: los sitios no cargan nada de internet.
const gsap = ['gsap.min.js', 'ScrollTrigger.min.js'];
for (const f of gsap) { mkdirSync(join(root, 'public', 'vendor', 'gsap'), { recursive: true }); cpSync(join(root, 'node_modules', 'gsap', 'dist', f), join(root, 'public', 'vendor', 'gsap', f)); }
// Tipografias del panel del dueño (OFL 1.1), servidas desde aqui: el panel no depende de Google Fonts.
const fonts = [['@fontsource-variable/bricolage-grotesque', 'bricolage-grotesque-latin-wght-normal.woff2'], ['@fontsource-variable/figtree', 'figtree-latin-wght-normal.woff2']];
for (const [pkg, f] of fonts) { mkdirSync(join(root, 'public', 'vendor', 'fonts'), { recursive: true }); cpSync(join(root, 'node_modules', pkg, 'files', f), join(root, 'public', 'vendor', 'fonts', f)); }
console.log(`vendor: ${files.length} archivos de three, ${gsap.length} de gsap y ${fonts.length} tipografías copiados`);
