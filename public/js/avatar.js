// Carga el GLB y anima todo lo que no es la boca: estados, parpadeo, mirada, cabeza y cejas.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const rnd = (a, b) => a + Math.random() * (b - a);

const PHONES = { x: 1.0, top: 1.04, earY: -0.05, z: -0.05 }; // proporciones de los audifonos respecto a la caja del modelo

export async function createAvatar(canvas, model = '') {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(14, 1, 0.1, 100); // campo de vision muy angosto: casi sin perspectiva, como el Memoji

  // Luz casi frontal y pareja; el sombreado fino ya viene en el color por vertice del modelo.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(-1.2, 1.6, 4); scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.5); rim.position.set(2, 1.5, -3); scene.add(rim);

  // Modo negocio: el avatar del catalogo que eligio el cliente (models/avatar-<id>.glb). Si aun no existe ese modelo, el de siempre.
  const base = new URL('../models/avatar-javier.glb', import.meta.url).href, wanted = /^[a-z]{3,12}$/.test(model) ? new URL(`../models/avatar-${model}.glb`, import.meta.url).href : '';
  const loader = new GLTFLoader();
  const gltf = wanted ? await loader.loadAsync(wanted).catch(() => loader.loadAsync(base)) : await loader.loadAsync(base);
  const root = gltf.scene; const pivot = new THREE.Group(); pivot.add(root); scene.add(pivot);

  // Los morph targets estan repartidos en varias mallas: se indexa cada nombre con todas las mallas que lo tienen.
  const morphs = new Map();
  let lensMesh = null;
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.material?.name === 'Lens') { o.material.depthWrite = false; o.renderOrder = 10; lensMesh = o; } // cristal de las gafas
    const dict = o.morphTargetDictionary; if (!dict) return;
    for (const [name, index] of Object.entries(dict)) {
      if (!morphs.has(name)) morphs.set(name, []);
      morphs.get(name).push({ mesh: o, index });
    }
  });
  const setMorph = (name, value) => { const list = morphs.get(name); if (list) for (const m of list) m.mesh.morphTargetInfluences[m.index] = value; };
  const eyeL = root.getObjectByName('Eye_L'), eyeR = root.getObjectByName('Eye_R');

  // Reflejo de pantalla en las gafas: mientras Claude Code programa, sus lineas de codigo suben por los cristales.
  // El cristal del modelo no trae coordenadas de textura: se proyectan aqui, cada lente por separado.
  const lens = { k: 0, on: false, lines: [], scroll: 0, mat: null, tex: null, ctx: null, at: 0 };
  if (lensMesh) {
    const geo = lensMesh.geometry.clone(), pos = geo.attributes.position, uv = new Float32Array(pos.count * 2);
    const b = [[Infinity, -Infinity], [Infinity, -Infinity]]; let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), s = x < 0 ? 0 : 1; b[s][0] = Math.min(b[s][0], x); b[s][1] = Math.max(b[s][1], x); y0 = Math.min(y0, pos.getY(i)); y1 = Math.max(y1, pos.getY(i)); }
    for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), s = x < 0 ? 0 : 1; uv[i * 2] = (x - b[s][0]) / (b[s][1] - b[s][0] || 1); uv[i * 2 + 1] = (pos.getY(i) - y0) / (y1 - y0 || 1); }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 192;
    lens.ctx = cv.getContext('2d'); lens.tex = new THREE.CanvasTexture(cv); lens.tex.colorSpace = THREE.SRGBColorSpace;
    lens.mat = new THREE.MeshBasicMaterial({ map: lens.tex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
    const glow = new THREE.Mesh(geo, lens.mat); glow.renderOrder = 11; glow.visible = false; glow.position.z = 0.002;
    lensMesh.add(glow); lens.mesh = glow;
  }
  // Audifonos para cuando escucha musica en suspension: diadema y dos copas, hechos aqui (el modelo no los trae).
  const phones = new THREE.Group(); phones.visible = false;
  // Actividades del modo suspension: dormir, leer, musica, juego (en el juego solo sigue la pelota con la mirada).
  let act = null, actT = 0, sleepK = 0, musicK = 0, readK = 0;
  const LENS_COLORS = ['#8fe3ff', '#b6ffb0', '#ffe08a', '#d7c2ff', '#ffffff'];
  function drawLens(dt) {
    const c = lens.ctx, W = 256, H = 192, lh = 15;
    lens.scroll += dt * 26;                       // el texto sube como en una terminal
    while (lens.scroll >= lh && lens.lines.length > 1) { lens.scroll -= lh; lens.lines.push(lens.lines.shift()); }
    c.clearRect(0, 0, W, H); c.fillStyle = 'rgba(40, 120, 190, 0.12)'; c.fillRect(0, 0, W, H); // brillo azulado de pantalla
    c.font = '11px ui-monospace, Menlo, Consolas, monospace'; c.textBaseline = 'top';
    for (let i = 0; i * lh - lens.scroll < H && lens.lines.length; i++) {
      const line = lens.lines[i % lens.lines.length];
      c.fillStyle = LENS_COLORS[(line.length + i) % LENS_COLORS.length]; c.fillText(line, 8, i * lh - lens.scroll);
    }
    lens.tex.needsUpdate = true;
  }

  // Encuadre: la cabeza completa cabe tanto en horizontal como en vertical (kiosco).
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  function resize() {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const dist = Math.max(size.y / 2 / t, size.x / 2 / (t * camera.aspect)) * 1.2;
    camera.position.set(0, center.y + size.y * 0.02, center.z + dist); camera.lookAt(0, center.y - size.y * 0.02, center.z);
    camera.updateProjectionMatrix();
  }
  {
    const dark = new THREE.MeshStandardMaterial({ color: 0x20242c, roughness: 0.55 }), color = new THREE.MeshStandardMaterial({ color: 0x4f8cff, roughness: 0.4 });
    const rx = size.x * 0.5 * PHONES.x, top = size.y * 0.5 * PHONES.top, earY = center.y + size.y * PHONES.earY, zc = center.z + size.z * PHONES.z;
    const band = new THREE.Mesh(new THREE.TorusGeometry(rx, size.x * 0.035, 10, 40, Math.PI), dark);
    band.scale.y = (center.y + top - earY) / rx; band.position.set(0, earY, zc);
    phones.add(band);
    for (const side of [-1, 1]) {
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(size.y * 0.13, size.y * 0.13, size.x * 0.09, 28), color);
      cup.rotation.z = Math.PI / 2; cup.scale.z = 0.8; cup.position.set(side * rx, earY, zc);
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(size.y * 0.145, size.y * 0.145, size.x * 0.04, 28), dark);
      pad.rotation.z = Math.PI / 2; pad.scale.z = 0.8; pad.position.set(side * (rx - size.x * 0.05), earY, zc);
      phones.add(cup, pad);
    }
    pivot.add(phones);
  }
  resize(); window.addEventListener('resize', resize); window.addEventListener('orientationchange', resize);

  let state = 'idle', clock = 0;
  let blinkAt = rnd(1, 3), blinkT = -1;
  let gazeAt = 0; const gaze = { x: 0, y: 0 }, gazeGoal = { x: 0, y: 0 };
  let browPulse = 0, brow = 0, smile = 0;
  const head = { x: 0, y: 0, z: 0 };
  // Reaccion del momento (sorpresa, alegria, risa, pena, pensativo): dura unos segundos y se mezcla con lo demas.
  const expr = { name: '', t: 0, dur: 2.8 }; let exprK = 0;
  const exprMouth = {};
  // Seguimiento del puntero (mouse o dedo), como el Memoji: la cabeza y los ojos giran hacia donde esta.
  const pointer = { x: 0, y: 0, at: -100 }, follow = { x: 0, y: 0 };
  const onPointer = (ev) => {
    pointer.x = Math.max(-1, Math.min(1, (ev.clientX / window.innerWidth) * 2 - 1));
    pointer.y = Math.max(-1, Math.min(1, 1 - (ev.clientY / window.innerHeight) * 2));
    pointer.at = clock;
  };
  window.addEventListener('pointermove', onPointer, { passive: true });
  window.addEventListener('pointerdown', onPointer, { passive: true });

  function update(dt) {
    clock += dt;
    // Parpadeo a intervalos irregulares (a veces doble).
    if (blinkT < 0 && clock >= blinkAt) blinkT = 0;
    let blink = 0;
    if (blinkT >= 0) {
      blinkT += dt; const d = 0.16;
      blink = blinkT < d ? Math.sin((blinkT / d) * Math.PI) : 0;
      if (blinkT >= d) { blinkT = -1; blinkAt = clock + (Math.random() < 0.18 ? rnd(0.12, 0.25) : rnd(1.8, 5.5)); }
    }

    // Mirada: hacia la camara, con pequenos saltos; al pensar se va hacia arriba y a un lado.
    if (clock >= gazeAt) {
      gazeAt = clock + rnd(0.7, 2.6);
      if (state === 'thinking') { gazeGoal.x = rnd(-0.22, -0.12); gazeGoal.y = rnd(0.18, 0.3) * (Math.random() < 0.5 ? -1 : 1); }
      else if (state === 'idle') { gazeGoal.x = rnd(-0.08, 0.06); gazeGoal.y = rnd(-0.3, 0.3); } // en espera: mira alrededor
      else { gazeGoal.x = rnd(-0.025, 0.025); gazeGoal.y = rnd(-0.04, 0.04); }
    }
    const kg = 1 - Math.exp(-dt / 0.05); gaze.x += (gazeGoal.x - gaze.x) * kg; gaze.y += (gazeGoal.y - gaze.y) * kg;

    // Cabeza: respiracion lenta siempre; cada estado agrega su gesto. Nunca queda inmovil.
    const speaking = state === 'speaking', listening = state === 'listening', thinking = state === 'thinking';
    const goal = {
      x: Math.sin(clock * 0.9) * 0.012 + (speaking ? Math.sin(clock * 3.1) * 0.02 : 0) + (listening ? 0.035 : 0) + (thinking ? -0.04 : 0),
      y: Math.sin(clock * 0.43) * 0.035 + (speaking ? Math.sin(clock * 1.7) * 0.03 : 0) + (thinking ? 0.09 : 0),
      z: Math.sin(clock * 0.31) * 0.012 + (listening ? 0.03 : 0) + (thinking ? -0.035 : 0),
    };
    if (state === 'idle') { goal.y += Math.sin(clock * 0.23) * 0.2; goal.x += Math.sin(clock * 0.17) * 0.04; } // en espera: gira despacio buscando a alguien
    // Actividades de la suspension: cada una entra y sale con un fundido.
    actT += dt;
    const ease = (v, to, tau) => v + (to - v) * (1 - Math.exp(-dt / tau));
    sleepK = ease(sleepK, act === 'dormir' && !expr.name ? 1 : 0, act === 'dormir' && !expr.name ? 0.7 : 0.12); // un sobresalto le abre los ojos
    musicK = ease(musicK, act === 'musica' ? 1 : 0, 0.35);
    readK = ease(readK, act === 'leer' ? 1 : 0, 0.4);
    if (sleepK > 0.01) { const nod = (actT * 0.2) % 1; goal.x += (0.09 + nod * nod * 0.17) * sleepK; goal.z += 0.1 * sleepK; goal.y *= 1 - 0.7 * sleepK; } // cabecea: cae despacio y se endereza
    if (musicK > 0.01) { goal.x += Math.sin(actT * 9.4) * 0.045 * musicK; goal.z += Math.sin(actT * 4.7) * 0.06 * musicK; }            // lleva el ritmo
    if (readK > 0.01) { goal.x += 0.11 * readK; goal.y *= 1 - 0.6 * readK; gazeGoal.x = 0.1 * readK; gazeGoal.y = (0.13 - ((actT % 2.4) / 2.4) * 0.26) * readK; } // recorre los renglones
    phones.visible = musicK > 0.03; phones.scale.setScalar(0.6 + 0.4 * musicK);
    // Si el puntero lleva un rato quieto, vuelve a mirar al frente.
    const active = clock - pointer.at < 4 ? 1 : 0;
    const kf = 1 - Math.exp(-dt / 0.12);
    follow.x += (pointer.x * active - follow.x) * kf; follow.y += (pointer.y * active - follow.y) * kf;
    goal.y += follow.x * 0.5; goal.x += -follow.y * 0.32; goal.z += -follow.x * 0.06;
    // Reaccion: entra rapido, se sostiene y sale suave.
    if (expr.name) { expr.t += dt; if (expr.t >= expr.dur) expr.name = ''; }
    const env = expr.name ? Math.min(1, expr.t / 0.18) * Math.min(1, (expr.dur - expr.t) / 0.6) : 0;
    exprK += (env - exprK) * (1 - Math.exp(-dt / 0.07));
    const e = expr.name, k = exprK;
    let exBrow = 0, exSmile = 0, exBlink = 0, exSad = 0, exFrown = 0, back = 0, lift = 0; exprMouth.viseme_O = 0;
    if (e === 'sorpresa') { exBrow = 1; exprMouth.viseme_O = 0.55 * k; back = 0.16; goal.x += -0.07 * k; }
    else if (e === 'alegria') { exSmile = 1; exBrow = 0.35; goal.z += 0.07 * k; lift = Math.abs(Math.sin(expr.t * 7)) * 0.035; }
    else if (e === 'risa') { exSmile = 1; exBlink = 0.4; goal.x += Math.sin(expr.t * 16) * 0.05 * k; lift = Math.abs(Math.sin(expr.t * 16)) * 0.02; }
    else if (e === 'celebracion') { exSmile = 1; exBrow = 0.7; lift = Math.abs(Math.sin(expr.t * 9)) * 0.06; goal.z += Math.sin(expr.t * 9) * 0.05 * k; }
    else if (e === 'despedida') { exSmile = 0.9; exBrow = 0.3; goal.z += Math.sin(expr.t * 6) * 0.09 * k; goal.x += 0.05 * k; }
    else if (e === 'dinero') { exBrow = 0.6; exSmile = 0.6; }
    else if (e === 'pena') { exSad = 1; exBlink = 0.22; goal.x += 0.11 * k; goal.z += -0.05 * k; }
    else if (e === 'pensativo') { exFrown = 0.35; exBrow = 0.3; goal.z += 0.08 * k; goal.y += 0.1 * k; gazeGoal.x = -0.2; gazeGoal.y = 0.22; }
    pivot.position.set(0, lift * k, -back * k);
    setMorph('mouthSad', exSad * k); setMorph('browSad', exSad * k); setMorph('browDown', exFrown * k); // expresiones agregadas al modelo
    const kh = 1 - Math.exp(-dt / 0.14);
    head.x += (goal.x - head.x) * kh; head.y += (goal.y - head.y) * kh; head.z += (goal.z - head.z) * kh;
    pivot.rotation.set(head.x, head.y, head.z);
    // Los ojos compensan el giro de la cabeza para seguir mirando a la camara.
    for (const e of [eyeL, eyeR]) if (e) e.rotation.set(gaze.x - follow.y * 0.16, gaze.y + follow.x * 0.26, 0);

    // Cejas: pulso al iniciar una frase; algo levantadas al escuchar.
    browPulse = Math.max(0, browPulse - dt / 0.6);
    const browGoal = Math.max(browPulse > 0 ? Math.sin(Math.min(1, browPulse) * Math.PI) * 0.8 : 0, listening ? 0.22 : 0, thinking ? 0.12 : 0);
    brow += (browGoal - brow) * (1 - Math.exp(-dt / 0.08)); setMorph('browUp', Math.max(brow, exBrow * k));
    setMorph('eyeBlink', Math.min(1, Math.max(blink * 1.05, exBlink * k, sleepK, musicK * 0.3)));
    exprMouth.viseme_aa = 0.1 * sleepK; // duerme con la boca un poco abierta
    const smileGoal = listening ? 0.25 : (state === 'idle' ? 0.15 : 0);
    smile += (smileGoal - smile) * (1 - Math.exp(-dt / 0.3)); setMorph('mouthSmile', Math.max(smile * (1 - exSad * k), exSmile * k, musicK * 0.5));

    if (lens.mat) { // el reflejo entra y sale con un fundido
      lens.k += ((lens.on || readK > 0.5 ? 1 : 0) - lens.k) * (1 - Math.exp(-dt / 0.5));
      lens.mesh.visible = lens.k > 0.01; lens.mat.opacity = lens.k * (0.62 + Math.sin(clock * 7) * 0.04);
      if (lens.mesh.visible && clock - lens.at > 1 / 15) { drawLens(clock - lens.at); lens.at = clock; }
    }
    renderer.render(scene, camera);
  }

  return {
    update, setMorph,
    setState(s) { if (s !== state) { state = s; gazeAt = 0; } },
    raiseBrows() { browPulse = 1; },
    react(name) { expr.name = name; expr.t = 0; },
    /** Reflejo de codigo en las gafas. `lines`: lo que Claude Code esta escribiendo (si no llega nada, se conserva lo anterior). */
    setWork(active, lines) {
      lens.on = !!active && !!lens.mat;
      if (lines?.length) lens.lines = lines.map((l) => String(l).replace(/\t/g, '  ').slice(0, 38));
      else if (active && !lens.lines.length) lens.lines = ['$ claude -p "..."', 'const avatar = await taller();', 'for (const paso of plan) {', '  await paso.run();', '}', '// trabajando...'];
    },
    /** Actividad del modo suspension: 'dormir' | 'leer' | 'musica' | 'juego' | null. */
    setActivity(name) {
      if (name !== act) { act = name; actT = 0; }
      if (name === 'leer' && !lens.lines.length) lens.lines = ['function descansar() {', '  while (!meLlaman) {', '    leer(unPoco);', '  }', '}', '// no molestar', 'const idea = pensar();'];
    },
    /** Mirar hacia un punto de la pantalla (-1..1), igual que si fuera el puntero. */
    look(x, y) { pointer.x = x; pointer.y = y; pointer.at = clock; },
    /** Forma de boca que pide la reaccion (se combina con el lip sync). */
    exprMouth,
    morphNames: [...morphs.keys()],
  };
}
