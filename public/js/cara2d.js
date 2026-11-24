// Cara 2D del avatar para pantallas pequeñas sin 3D (el "Javi de bolsillo"). Las imágenes salen del modelo 3D con
// `npm run cara2d`: una cara base y tres capas de recortes (cejas, ojos, boca) que se dibujan encima.
// Este archivo tiene dos partes separadas a propósito, porque la segunda se va a reescribir tal cual en el programa
// de la placa: (1) dibujar los recortes y (2) decidir QUÉ recorte toca en cada momento.

/** Carga `cara.json` y sus imágenes. */
export async function loadFace(dir) {
  const base = new URL(dir.endsWith('/') ? dir : `${dir}/`, location.href);
  const manifest = await fetch(new URL('cara.json', base), { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('falta cara.json: corre «npm run cara2d»'); return r.json(); });
  const image = (file) => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error(`no cargó ${file}`)); i.src = new URL(file, base).href; });
  const layers = {};
  for (const [name, c] of Object.entries(manifest.capas)) layers[name] = { ...c, image: await image(c.archivo), index: Object.fromEntries(c.cuadros.map((f, i) => [f, i])) };
  return { side: manifest.lado, base: await image(manifest.base), layers };
}

/** Dibuja la cara en un canvas del tamaño de la pantalla. `frames`: { cejas, ojos, boca } con el nombre de cada cuadro. */
export function createFace(canvas, face) {
  canvas.width = canvas.height = face.side;
  const ctx = canvas.getContext('2d');
  // La cara se arma aparte y se pega entera: así moverla unos pixeles no deja rastros.
  const work = document.createElement('canvas'); work.width = work.height = face.side; const w = work.getContext('2d');
  let shown = '';
  return {
    draw(frames, dx = 0, dy = 0) {
      const key = Object.keys(face.layers).map((l) => frames[l] || '').join('|');
      if (key !== shown) {
        shown = key; w.clearRect(0, 0, face.side, face.side); w.drawImage(face.base, 0, 0);
        for (const [name, c] of Object.entries(face.layers)) {
          const i = c.index[frames[name]]; if (i === undefined || i === 0) continue; // el cuadro 0 es el de la cara base
          w.clearRect(c.x, c.y, c.w, c.h); w.drawImage(c.image, i * c.w, 0, c.w, c.h, c.x, c.y, c.w, c.h);
        }
      }
      ctx.clearRect(0, 0, face.side, face.side); ctx.drawImage(work, Math.round(dx), Math.round(dy));
    },
  };
}

const STRENGTH = { viseme_aa: 0.85, viseme_E: 0.7, viseme_I: 0.6, viseme_O: 0.75, viseme_U: 0.7, viseme_PP: 0.9, viseme_FF: 0.8, viseme_DD: 0.45 };
const SHORT = { viseme_aa: 'a', viseme_E: 'e', viseme_I: 'i', viseme_O: 'o', viseme_U: 'u', viseme_PP: 'p', viseme_FF: 'f', viseme_DD: 'd' };
const rnd = (a, b) => a + Math.random() * (b - a);

/** Cuadro de boca para los pesos del lip sync: el sonido que más pesa, a medio camino o completo; null = boca quieta. */
export function mouthFrame(weights) {
  let best = '', k = 0;
  for (const [v, s] of Object.entries(STRENGTH)) { const r = (weights[v] || 0) / s; if (r > k) { k = r; best = v; } }
  if (k < 0.22) return null;
  return `${SHORT[best]}${k > 0.62 ? 2 : 1}`;
}

/**
 * Decide los cuadros y el desplazamiento de la cabeza. Mismo comportamiento que el visor 3D (public/js/avatar.js),
 * reducido a lo que se puede hacer con recortes: parpadeo, mirada, cejas, sonrisa, reacciones y un leve vaivén.
 * Estados: idle | listening | thinking | speaking | away (suspendido: duerme).
 */
export function createMind() {
  let state = 'idle', clock = 0;
  let blinkAt = rnd(1, 3), blinkT = -1, gazeAt = 0, gaze = 'frente', browPulse = 0;
  const expr = { name: '', t: 0, dur: 2.8 };
  return {
    setState(s) { if (s !== state) { state = s; gazeAt = 0; } },
    raiseBrows() { browPulse = 0.45; },
    react(name) { expr.name = name; expr.t = 0; },
    get state() { return state; },
    /**
     * dt en segundos; weights = pesos del lip sync (o null). `given`: recorte de boca ya decidido por el servidor (así le
     * llega a la placa); '-' o vacío = boca quieta. Devuelve { frames, dx, dy }.
     */
    update(dt, weights, given) {
      clock += dt;
      if (expr.name) { expr.t += dt; if (expr.t >= expr.dur) expr.name = ''; }
      const e = expr.name, away = state === 'away';

      // Ojos: parpadeo irregular (a veces doble); la mirada se va a un lado al pensar o al esperar.
      if (blinkT < 0 && clock >= blinkAt) blinkT = 0;
      let eyes = '';
      if (blinkT >= 0) {
        blinkT += dt; eyes = blinkT < 0.04 ? 'medio' : blinkT < 0.11 ? 'cerrados' : 'medio';
        if (blinkT >= 0.15) { blinkT = -1; eyes = ''; blinkAt = clock + (Math.random() < 0.18 ? rnd(0.12, 0.25) : rnd(1.8, 5.5)); }
      }
      if (clock >= gazeAt) {
        gazeAt = clock + rnd(0.9, 2.8);
        gaze = state === 'thinking' ? 'pensando' : state === 'idle' ? (Math.random() < 0.45 ? 'frente' : Math.random() < 0.5 ? 'izquierda' : 'derecha') : 'frente';
      }
      if (away) eyes = 'cerrados';
      else if (!eyes) eyes = e === 'risa' ? 'medio' : e === 'pensativo' ? 'pensando' : gaze;

      // Cejas: pulso al empezar a hablar, algo arriba al escuchar, y las de cada reacción.
      browPulse = Math.max(0, browPulse - dt);
      let brows = 'reposo';
      if (e === 'sorpresa' || e === 'celebracion') brows = 'arriba2';
      else if (e === 'pena') brows = 'tristes';
      else if (e === 'pensativo') brows = 'ceno';
      else if (e === 'alegria' || e === 'despedida' || e === 'dinero') brows = 'arriba1';
      else if (browPulse > 0.2) brows = 'arriba2';
      else if (browPulse > 0 || state === 'listening') brows = 'arriba1';

      // Boca: primero lo que se está diciendo; si no habla, el gesto de la reacción o la sonrisa del estado.
      let mouth = given !== undefined ? (given && given !== '-' ? given : null) : weights ? mouthFrame(weights) : null;
      if (!mouth) {
        if (e === 'pena') mouth = 'triste';
        else if (e === 'sorpresa') mouth = 'o1';
        else if (e === 'alegria' || e === 'risa' || e === 'celebracion' || e === 'despedida' || e === 'dinero') mouth = 'sonrisa2';
        else mouth = state === 'listening' || state === 'idle' ? 'sonrisa1' : 'reposo';
      }

      // Cabeza: respira siempre; al hablar se mueve un poco más; algunas reacciones la sacuden.
      let dx = Math.sin(clock * 0.43) * 1.2, dy = Math.sin(clock * 0.9) * 1.5;
      if (state === 'speaking') { dx += Math.sin(clock * 1.7) * 1.5; dy += Math.sin(clock * 3.1) * 1.5; }
      if (state === 'thinking') { dx += 3; dy -= 2; }
      if (away) dy += 4 + Math.sin(clock * 0.5) * 2; // cabecea dormido
      if (e === 'risa') dy += Math.sin(expr.t * 16) * 3;
      else if (e === 'alegria' || e === 'celebracion') dy -= Math.abs(Math.sin(expr.t * 8)) * 4;
      else if (e === 'despedida') dx += Math.sin(expr.t * 6) * 5;
      else if (e === 'pena') dy += 3;
      return { frames: { cejas: brows, ojos: eyes, boca: mouth }, dx, dy };
    },
  };
}
