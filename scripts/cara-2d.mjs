// Genera la cara 2D del avatar para pantallas pequeñas sin 3D (el "Javi de bolsillo": placa ESP32 con pantalla redonda
// de 466 x 466). Abre el MISMO modelo y las mismas luces del visor web en Chrome sin interfaz, pone cada forma de boca,
// de ojos y de cejas, y guarda:
//   public/bolsillo/base.png    la cara en reposo, completa
//   public/bolsillo/<capa>.png  una tira con los recortes de cada capa (boca, ojos, cejas)
//   public/bolsillo/cara.json   dónde va cada recorte y en qué orden vienen
// Cada capa es el rectángulo mínimo donde ESA parte cambia: la pantalla solo redibuja ese pedazo.
// Uso: npm run cara2d [-- --modelo javier] [--lado 466] [--radio 0.9]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { PNG } = createRequire(import.meta.url)('pngjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const MODEL = String(arg('modelo', 'javier')).replace(/[^a-z]/g, '');
const SIDE = Number(arg('lado', 466));
const RADIUS = Number(arg('radio', 0.9)); // cuánto del radio de la pantalla ocupa la cabeza (deja aire para moverla y para que baje la quijada)
const OUT = path.join(root, 'public', 'bolsillo');
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Las mismas fuerzas que usa el lip sync del navegador (public/js/lipsync.js).
const STRENGTH = { viseme_aa: 0.85, viseme_E: 0.7, viseme_I: 0.6, viseme_O: 0.75, viseme_U: 0.7, viseme_PP: 0.9, viseme_FF: 0.8, viseme_DD: 0.45 };
const SHORT = { viseme_aa: 'a', viseme_E: 'e', viseme_I: 'i', viseme_O: 'o', viseme_U: 'u', viseme_PP: 'p', viseme_FF: 'f', viseme_DD: 'd' };

/** Capas y cuadros. Cada cuadro: morphs del modelo y, en los ojos, hacia dónde miran (radianes, como en el visor). */
const LAYERS = {
  cejas: [
    { name: 'reposo', morphs: {} },
    { name: 'arriba1', morphs: { browUp: 0.3 } },
    { name: 'arriba2', morphs: { browUp: 1 } },
    { name: 'tristes', morphs: { browSad: 1 } },
    { name: 'ceno', morphs: { browDown: 0.6 } },
  ],
  ojos: [
    { name: 'frente', morphs: {} },
    { name: 'medio', morphs: { eyeBlink: 0.55 } },
    { name: 'cerrados', morphs: { eyeBlink: 1 } },
    { name: 'izquierda', morphs: {}, gaze: [0, -0.22] },
    { name: 'derecha', morphs: {}, gaze: [0, 0.22] },
    { name: 'pensando', morphs: {}, gaze: [-0.18, 0.22] },
  ],
  boca: [
    { name: 'reposo', morphs: {} },
    ...Object.entries(STRENGTH).flatMap(([v, s]) => [
      { name: `${SHORT[v]}1`, morphs: { [v]: s * 0.5 } }, // a medio camino: entrada y salida de cada sonido
      { name: `${SHORT[v]}2`, morphs: { [v]: s } },
    ]),
    { name: 'sonrisa1', morphs: { mouthSmile: 0.25 } },
    { name: 'sonrisa2', morphs: { mouthSmile: 1 } },
    { name: 'triste', morphs: { mouthSad: 1 } },
  ],
};

const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000">
<script type="importmap">{ "imports": { "three": "./vendor/three/build/three.module.js", "three/addons/": "./vendor/three/examples/jsm/" } }</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const N = ${SIDE}, SS = 2, R = ${RADIUS};
const gl = document.createElement('canvas');
const renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); renderer.setSize(N * SS, N * SS, false); renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(14, 1, 0.1, 100);
// Las mismas luces del visor (public/js/avatar.js).
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.55));
const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(-1.2, 1.6, 4); scene.add(key);
const rim = new THREE.DirectionalLight(0xffffff, 0.5); rim.position.set(2, 1.5, -3); scene.add(rim);
const gltf = await new GLTFLoader().loadAsync('./models/avatar-${MODEL}.glb');
const root = gltf.scene; scene.add(root);
const morphs = new Map();
root.traverse((o) => {
  if (!o.isMesh) return;
  if (o.material?.name === 'Lens') { o.material.depthWrite = false; o.renderOrder = 10; }
  for (const [name, index] of Object.entries(o.morphTargetDictionary || {})) { if (!morphs.has(name)) morphs.set(name, []); morphs.get(name).push({ mesh: o, index }); }
});
const eyes = [root.getObjectByName('Eye_L'), root.getObjectByName('Eye_R')].filter(Boolean);
const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
const view = { x: 0, y: center.y, dist: (Math.max(size.x, size.y) / 2 / t) * 1.3 };
const out = document.createElement('canvas'); out.width = out.height = N; const ctx = out.getContext('2d', { willReadFrequently: true });
function draw(frame) {
  for (const list of morphs.values()) for (const m of list) m.mesh.morphTargetInfluences[m.index] = 0; // el GLB trae algunos pesos en 1
  for (const [name, v] of Object.entries(frame?.morphs || {})) for (const m of morphs.get(name) || []) m.mesh.morphTargetInfluences[m.index] = v;
  for (const e of eyes) e.rotation.set(frame?.gaze?.[0] || 0, frame?.gaze?.[1] || 0, 0);
  camera.position.set(view.x, view.y, center.z + view.dist); camera.lookAt(view.x, view.y, center.z); camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  ctx.clearRect(0, 0, N, N); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(gl, 0, 0, N, N);
}
// Encuadre para pantalla redonda: la cabeza queda centrada y su punto más lejano toca R del radio.
for (let pass = 0; pass < 4; pass++) {
  draw(null);
  const d = ctx.getImageData(0, 0, N, N).data; let x0 = N, x1 = 0, y0 = N, y1 = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (d[(y * N + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2; let far = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (d[(y * N + x) * 4 + 3] > 24) far = Math.max(far, Math.hypot(x - cx, y - cy));
  const unit = (2 * view.dist * t) / N; // unidades del modelo por pixel, en el plano de la cabeza
  view.x += (cx - N / 2) * unit; view.y -= (cy - N / 2) * unit; view.dist *= far / ((N / 2) * R);
}
window.cara = { shot(frame) { draw(frame); return out.toDataURL('image/png'); }, morphs: [...morphs.keys()], view };
</script>`;

const TYPES = { '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.html': 'text/html' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (url === '/__cara.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); return; }
  const file = path.join(root, 'public', path.normalize(url));
  if (!file.startsWith(path.join(root, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cara2d-'));
const debugPort = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--window-size=600,600', '--hide-scrollbars', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finish = async (code) => { // Chrome sigue escribiendo su perfil un instante después de recibir la señal
  const gone = new Promise((r) => chrome.once('exit', r)); try { chrome.kill(); } catch { /* ya cerró */ }
  await Promise.race([gone, sleep(3000)]); server.close();
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* queda en la carpeta temporal del sistema */ }
  process.exit(code);
};
try {
  let target; for (let i = 0; i < 60 && !target; i++) { await sleep(250); target = await fetch(`http://127.0.0.1:${debugPort}/json`).then((r) => r.json()).then((l) => l.find((x) => x.type === 'page')).catch(() => null); }
  if (!target) throw new Error('Chrome no arrancó (CHROME_BIN apunta a otro navegador si hace falta)');
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const js = async (expression) => { const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || 'error en la página'); return m.result?.result?.value; };
  await send('Page.enable'); await send('Page.navigate', { url: `${base}/__cara.html` });
  let ready = false; for (let i = 0; i < 80 && !ready; i++) { await sleep(250); ready = await js('!!window.cara').catch(() => false); }
  if (!ready) throw new Error('el modelo no cargó en la página de captura');

  const have = await js('window.cara.morphs');
  const shot = async (frame) => PNG.sync.read(Buffer.from((await js(`window.cara.shot(${JSON.stringify(frame)})`)).split(',')[1], 'base64'));
  const neutral = await shot({ morphs: {} });

  const manifest = { modelo: MODEL, lado: SIDE, base: 'base.png', capas: {} };
  const rects = {};
  for (const [layer, frames] of Object.entries(LAYERS)) {
    const missing = frames.flatMap((f) => Object.keys(f.morphs)).filter((m) => !have.includes(m));
    if (missing.length) throw new Error(`al modelo le faltan formas para la capa ${layer}: ${[...new Set(missing)].join(', ')}`);
    const shots = []; let x0 = SIDE, x1 = -1, y0 = SIDE, y1 = -1;
    for (const f of frames) {
      const png = await shot(f); shots.push(png);
      for (let i = 0; i < SIDE * SIDE; i++) {
        const p = i * 4; let d = 0;
        for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(png.data[p + c] - neutral.data[p + c]));
        if (d > 6) { const x = i % SIDE, y = (i / SIDE) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    if (x1 < 0) throw new Error(`la capa ${layer} no cambia nada en la imagen`);
    const pad = 3; let x = Math.max(0, x0 - pad), y = Math.max(0, y0 - pad); const w = Math.min(SIDE, x1 + pad + 1) - x; let h = Math.min(SIDE, y1 + pad + 1) - y;
    // Dos capas no pueden pisarse (sus recortes se contradirían en la zona común): la de abajo empieza donde termina la
    // de arriba. Lo que queda fuera del recorte no se dibuja; cuánto era se anota como "residuo" (0 a 255).
    for (const r of Object.values(rects)) if (x < r.x + r.w && r.x < x + w && y < r.y + r.h && r.y < y + h) { const top = r.y + r.h; h -= top - y; y = top; }
    let residue = 0;
    for (const png of shots) for (let i = 0; i < SIDE * SIDE; i++) {
      const px = i % SIDE, py = (i / SIDE) | 0; if (px >= x && px < x + w && py >= y && py < y + h) continue;
      for (let c = 0; c < 4; c++) residue = Math.max(residue, Math.abs(png.data[i * 4 + c] - neutral.data[i * 4 + c]));
    }
    const strip = new PNG({ width: w * frames.length, height: h });
    shots.forEach((png, n) => PNG.bitblt(png, strip, x, y, w, h, n * w, 0));
    rects[layer] = { x, y, w, h };
    manifest.capas[layer] = { archivo: `${layer}.png`, x, y, w, h, residuo: residue, cuadros: frames.map((f) => f.name) };
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${layer}.png`), PNG.sync.write(strip));
  }
  fs.writeFileSync(path.join(OUT, 'base.png'), PNG.sync.write(neutral));
  fs.writeFileSync(path.join(OUT, 'cara.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const kb = (f) => Math.round(fs.statSync(path.join(OUT, f)).size / 1024);
  console.log(`Cara 2D de «${MODEL}» en public/bolsillo (${SIDE} x ${SIDE}):`);
  console.log(`  base.png ${kb('base.png')} KB`);
  for (const [layer, c] of Object.entries(manifest.capas)) console.log(`  ${layer}.png ${kb(c.archivo)} KB · ${c.cuadros.length} cuadros de ${c.w} x ${c.h} en (${c.x}, ${c.y}) · residuo ${c.residuo}`);
  ws.close(); await finish(0);
} catch (e) { console.error(`No se pudo generar la cara 2D: ${e.message}`); await finish(1); }
