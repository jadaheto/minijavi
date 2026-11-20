// Efectos de pantalla: lluvia de emojis por reaccion y fondos animados por tema.
const EMOJIS = {
  sorpresa: ['⚠️', '🚨', '😳'],
  alegria: ['❤️', '💖', '😍', '💕'],
  risa: ['😂', '🤣', '😆'],
  pena: ['🥺', '💙', '😢'],
  pensativo: ['🤔', '💭'],
  celebracion: ['🎉', '🥳', '🎊', '✨'],
  despedida: ['👋', '✨', '🙌'],
  dinero: ['💵', '💰', '🤑', '💸'],
};

export function emojiBurst(layer, name) {
  const set = EMOJIS[name]; if (!set) return;
  for (let i = 0; i < 14; i++) {
    const el = document.createElement('span');
    el.className = 'emoji'; el.textContent = set[(Math.random() * set.length) | 0];
    const side = i % 2 ? 1 : -1; // a los lados de la cabeza, no encima de la cara
    el.style.left = `${50 + side * (16 + Math.random() * 24)}%`;
    el.style.top = `${30 + Math.random() * 40}%`;
    el.style.fontSize = `${28 + Math.random() * 30}px`;
    el.style.setProperty('--dx', `${side * (10 + Math.random() * 50)}px`);
    el.style.setProperty('--rot', `${(Math.random() - 0.5) * 50}deg`);
    el.style.animationDelay = `${Math.random() * 0.5}s`;
    el.addEventListener('animationend', () => el.remove());
    layer.appendChild(el);
  }
}

/** Un emoji suelto que sube junto a la cabeza (los "Zzz" al dormir, las notas al oir musica). */
export function floatEmoji(layer, set) {
  const el = document.createElement('span');
  el.className = 'emoji'; el.textContent = set[(Math.random() * set.length) | 0];
  el.style.left = `${61 + Math.random() * 6}%`; el.style.top = `${24 + Math.random() * 10}%`;
  el.style.fontSize = `${24 + Math.random() * 18}px`;
  el.style.setProperty('--dx', `${30 + Math.random() * 50}px`); el.style.setProperty('--rot', `${(Math.random() - 0.5) * 30}deg`);
  el.addEventListener('animationend', () => el.remove());
  layer.appendChild(el);
}

/** Fondo animado detras del avatar. show('neuronal' | 'estrellas' | 'atardecer' | 'soleado' | 'nublado' | 'lluvia' | 'tormenta' | 'codigo' | null). */
export function createBackdrop(canvas) {
  const ctx = canvas.getContext('2d');
  let current = null, timer = null, W = 0, H = 0, size = 18, stars = [], t = 0, drops = [], clouds = [], flash = 0, nodes = [], pulses = [];
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.width = Math.floor(window.innerWidth * dpr); H = canvas.height = Math.floor(window.innerHeight * dpr);
    size = Math.round(18 * dpr);
    nodes = Array.from({ length: Math.round(Math.min(120, Math.max(48, (window.innerWidth * window.innerHeight) / 11000))) }, () => ({ x: Math.random(), y: Math.random(), vx: (Math.random() - 0.5) * 0.0016, vy: (Math.random() - 0.5) * 0.0016, s: Math.random(), p: Math.random() * 6.28, hue: Math.random() < 0.35, glow: 0 }));
    pulses = [];
    drops = Array.from({ length: 220 }, () => ({ x: Math.random() * 1.3, y: Math.random(), v: 0.035 + Math.random() * 0.03, l: 0.02 + Math.random() * 0.03 }));
    clouds = Array.from({ length: 9 }, (_, i) => ({ x: Math.random(), y: 0.08 + (i % 4) * 0.2 + Math.random() * 0.08, r: 0.14 + Math.random() * 0.12, v: 0.0006 + Math.random() * 0.0008 }));
    stars = Array.from({ length: 160 }, () => ({ x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: Math.random() }));
  }
  const draw = {
    // Red neuronal (reemplaza a la lluvia de Matrix, pedido por Javier el 2026-11-20): nodos que derivan despacio, hilos
    // entre los cercanos y pulsos de luz que viajan de un nodo a otro.
    neuronal() {
      ctx.fillStyle = 'rgba(7, 9, 20, 0.30)'; ctx.fillRect(0, 0, W, H);
      const reach = Math.min(W, H) * 0.23, R2 = reach * reach;
      for (const n of nodes) {
        n.x += n.vx; n.y += n.vy; n.p += 0.05;
        if (n.x < -0.05 || n.x > 1.05) n.vx = -n.vx;
        if (n.y < -0.05 || n.y > 1.05) n.vy = -n.vy;
      }
      ctx.lineWidth = Math.max(1, size / 18);
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j], dx = (a.x - b.x) * W, dy = (a.y - b.y) * H, d2 = dx * dx + dy * dy;
        if (d2 > R2) continue;
        const k = 1 - d2 / R2;
        ctx.strokeStyle = `rgba(${a.hue ? '150, 120, 255' : '90, 170, 255'}, ${0.5 * k})`;
        ctx.beginPath(); ctx.moveTo(a.x * W, a.y * H); ctx.lineTo(b.x * W, b.y * H); ctx.stroke();
        // De vez en cuando sale un pulso por un hilo vivo.
        if (pulses.length < 26 && Math.random() < 0.0016 * k) pulses.push({ a: i, b: j, t: 0, v: 0.02 + Math.random() * 0.025 });
      }
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i], a = nodes[p.a], b = nodes[p.b]; p.t += p.v;
        if (p.t >= 1) { b.glow = 1; pulses.splice(i, 1); continue; }
        const x = (a.x + (b.x - a.x) * p.t) * W, y = (a.y + (b.y - a.y) * p.t) * H, r = size * 0.5;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, 'rgba(220, 240, 255, 0.95)'); g.addColorStop(1, 'rgba(120, 180, 255, 0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
      }
      for (const n of nodes) {
        n.glow *= 0.93;
        const r = size * (0.12 + n.s * 0.1) * (1 + 0.18 * Math.sin(n.p)) + n.glow * size * 0.22;
        ctx.fillStyle = `rgba(${n.hue ? '185, 160, 255' : '140, 200, 255'}, ${0.55 + n.glow * 0.45})`;
        ctx.beginPath(); ctx.arc(n.x * W, n.y * H, r, 0, 6.283); ctx.fill();
      }
    },
    estrellas() { // campo de estrellas que se acercan
      ctx.fillStyle = 'rgba(6, 8, 22, 0.35)'; ctx.fillRect(0, 0, W, H);
      for (const s of stars) {
        s.z -= 0.006; if (s.z <= 0.02) { s.x = (Math.random() - 0.5) * 2; s.y = (Math.random() - 0.5) * 2; s.z = 1; }
        const px = W / 2 + (s.x / s.z) * W * 0.5, py = H / 2 + (s.y / s.z) * H * 0.5, r = (1 - s.z) * size * 0.16 + 0.6;
        ctx.fillStyle = `rgba(210, 225, 255, ${Math.min(1, 1.2 - s.z)})`;
        ctx.beginPath(); ctx.arc(px, py, r, 0, 6.283); ctx.fill();
      }
    },
    atardecer() { // cielo calido con un sol bajo y un brillo que respira
      t += 0.02;
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#2a1b4d'); g.addColorStop(0.5, '#b8456b'); g.addColorStop(0.82, '#ff9a4d'); g.addColorStop(1, '#ffd27a');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      const r = Math.min(W, H) * (0.28 + Math.sin(t) * 0.01);
      const sun = ctx.createRadialGradient(W / 2, H * 0.86, 0, W / 2, H * 0.86, r * 2.2);
      sun.addColorStop(0, 'rgba(255, 240, 190, 0.95)'); sun.addColorStop(0.35, 'rgba(255, 190, 110, 0.55)'); sun.addColorStop(1, 'rgba(255, 150, 80, 0)');
      ctx.fillStyle = sun; ctx.fillRect(0, 0, W, H);
    },
  };
  function sky(top, bottom) { const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, top); g.addColorStop(1, bottom); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
  function drawClouds(color) {
    for (const c of clouds) {
      c.x += c.v; if (c.x > 1.3) c.x = -0.3;
      const cx = c.x * W, cy = c.y * H, r = c.r * Math.min(W, H) * 1.3;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r); g.addColorStop(0, color); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(cx, cy, r * 1.6, r * 0.75, 0, 0, 6.283); ctx.fill();
    }
  }
  function drawRain(alpha) {
    ctx.strokeStyle = `rgba(190, 215, 255, ${alpha})`; ctx.lineWidth = Math.max(1, size * 0.08); ctx.beginPath();
    for (const d of drops) {
      d.y += d.v; d.x -= d.v * 0.25; if (d.y > 1.05) { d.y = -0.05; d.x = Math.random() * 1.3; }
      ctx.moveTo(d.x * W, d.y * H); ctx.lineTo((d.x - d.l * 0.25) * W, (d.y + d.l) * H);
    }
    ctx.stroke();
  }
  // Fondos del clima: los elige el servidor segun el dato real de la consulta.
  draw.soleado = () => {
    t += 0.01; sky('#3fa9f5', '#bfe6ff');
    const cx = W * 0.82, cy = H * 0.16, r = Math.min(W, H) * 0.11;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(t); ctx.strokeStyle = 'rgba(255, 236, 150, 0.75)'; ctx.lineWidth = r * 0.14; ctx.lineCap = 'round';
    for (let i = 0; i < 12; i++) { ctx.rotate(Math.PI / 6); ctx.beginPath(); ctx.moveTo(r * 1.35, 0); ctx.lineTo(r * (1.75 + 0.12 * Math.sin(t * 6 + i)), 0); ctx.stroke(); }
    ctx.restore();
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 3.2); g.addColorStop(0, 'rgba(255, 250, 205, 1)'); g.addColorStop(0.3, 'rgba(255, 224, 110, 0.95)'); g.addColorStop(0.34, 'rgba(255, 224, 110, 0.35)'); g.addColorStop(1, 'rgba(255, 224, 110, 0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  };
  draw.nublado = () => { sky('#7d8894', '#c3cad2'); drawClouds('rgba(240, 243, 247, 0.6)'); };
  draw.lluvia = () => { sky('#2c3947', '#5c6b7a'); drawClouds('rgba(120, 132, 146, 0.5)'); drawRain(0.55); };
  draw.tormenta = () => {
    sky('#161c26', '#3a4350'); drawClouds('rgba(70, 78, 92, 0.6)'); drawRain(0.6);
    if (flash <= 0 && Math.random() < 0.012) flash = 1;      // relampago ocasional
    if (flash > 0) { ctx.fillStyle = `rgba(235, 240, 255, ${0.5 * flash})`; ctx.fillRect(0, 0, W, H); flash -= 0.18; }
  };
  // Fondo de trabajo: mientras Claude Code programa, un editor oscuro donde el codigo se va escribiendo y sube.
  const PALETTE = ['#7aa2f7', '#bb9af7', '#9ece6a', '#e0af68', '#7dcfff', '#c0caf5'];
  let codeLines = [], codeScroll = 0;
  const newLine = () => {
    const indent = ((Math.random() * 4) | 0) * 2, blocks = []; let n = 1 + ((Math.random() * 5) | 0);
    if (Math.random() < 0.12) n = 0; // linea en blanco
    while (n--) blocks.push({ w: 2 + ((Math.random() * 9) | 0), c: PALETTE[(Math.random() * PALETTE.length) | 0] });
    return { indent, blocks, typed: 0 };
  };
  draw.codigo = () => {
    const lh = size * 1.5, ch = size * 0.62, rows = Math.ceil(H / lh) + 2;
    if (codeLines.length < rows) while (codeLines.length < rows) { const l = newLine(); l.typed = 99; codeLines.push(l); }
    ctx.fillStyle = '#0d1017'; ctx.fillRect(0, 0, W, H);
    // La ultima linea se va "tecleando"; cuando termina, todo sube una linea y aparece otra.
    const lastLine = codeLines[codeLines.length - 1], total = lastLine.blocks.reduce((a, b) => a + b.w + 1, 0);
    lastLine.typed += 1.6;
    if (lastLine.typed > total + 4) { codeScroll += lh; codeLines.push(newLine()); }
    if (codeScroll > 0) { const step = Math.min(codeScroll, lh * 0.25); codeScroll -= step; if (codeScroll <= 0.01) { codeScroll = 0; codeLines.shift(); } }
    const y0 = H - (codeLines.length - 1) * lh - lh * 1.2 + codeScroll;
    for (let i = 0; i < codeLines.length; i++) {
      const l = codeLines[i], y = y0 + i * lh; if (y < -lh || y > H) continue;
      ctx.fillStyle = 'rgba(120, 130, 160, 0.35)'; ctx.fillRect(size * 0.9, y + lh * 0.25, ch * 1.6, lh * 0.34); // numero de linea
      let x = size * 3.4 + l.indent * ch, left = l.typed;
      for (const b of l.blocks) {
        if (left <= 0) break;
        const w = Math.min(b.w, left) * ch; left -= b.w + 1;
        ctx.fillStyle = b.c; ctx.globalAlpha = 0.5; ctx.fillRect(x, y + lh * 0.22, w, lh * 0.4); ctx.globalAlpha = 1;
        x += (b.w + 1) * ch;
      }
      if (i === codeLines.length - 1 && (Date.now() >> 8) % 2) { ctx.fillStyle = '#c0caf5'; ctx.fillRect(x, y + lh * 0.15, ch * 0.5, lh * 0.55); } // cursor
    }
  };
  // Fondos del modo suspension.
  draw.noche = () => { // cielo de noche con luna, para dormir
    t += 0.03; sky('#070b1c', '#1a2244');
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      ctx.fillStyle = `rgba(225, 232, 255, ${0.25 + 0.6 * Math.abs(Math.sin(t * (0.4 + (i % 7) * 0.13) + i))})`;
      ctx.beginPath(); ctx.arc((s.x + 1) / 2 * W, (s.y + 1) / 2 * H, size * (0.05 + (i % 3) * 0.03), 0, 6.283); ctx.fill();
    }
    const mx = W * 0.17, my = H * 0.2, r = Math.min(W, H) * 0.075;
    const g = ctx.createRadialGradient(mx, my, r * 0.6, mx, my, r * 3); g.addColorStop(0, 'rgba(255, 244, 200, 0.28)'); g.addColorStop(1, 'rgba(255, 244, 200, 0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fdf3c4'; ctx.beginPath(); ctx.arc(mx, my, r, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#0a1024'; ctx.beginPath(); ctx.arc(mx + r * 0.42, my - r * 0.18, r * 0.86, 0, 6.283); ctx.fill(); // media luna
  };
  draw.ecualizador = () => { // barras que suben y bajan, para cuando oye musica
    t += 0.09; sky('#1a1033', '#3b1d5e');
    const n = 28, bw = W / n;
    for (let i = 0; i < n; i++) {
      const h = (0.12 + 0.3 * Math.abs(Math.sin(t * 1.7 + i * 0.6)) + 0.22 * Math.abs(Math.sin(t * 2.9 + i * 1.3))) * H;
      const g = ctx.createLinearGradient(0, H - h, 0, H); g.addColorStop(0, '#ff7ad9'); g.addColorStop(1, '#6a5cff');
      ctx.fillStyle = g; ctx.fillRect(i * bw + bw * 0.14, H - h, bw * 0.72, h);
    }
  };
  // Ping-pong que se juega solo. La paleta derecha (naranja) es la del avatar. La pelota queda en `ball` para que la siga con la mirada.
  const pong = { x: 0.5, y: 0.5, vx: 0.012, vy: 0.008, l: 0.5, r: 0.5, sl: 0, sr: 0, wait: 0, errL: 0, errR: 0 };
  let onScore = null;
  const serve = (dir) => { pong.x = 0.5; pong.y = 0.3 + Math.random() * 0.4; pong.vx = dir * 0.013; pong.vy = (Math.random() - 0.5) * 0.02; pong.wait = 14; pong.errL = (Math.random() - 0.5) * 0.4; pong.errR = (Math.random() - 0.5) * 0.4; };
  draw.pong = () => {
    const ph = 0.2, px = 0.035;
    if (pong.wait > 0) pong.wait--;
    else {
      pong.x += pong.vx; pong.y += pong.vy;
      if (pong.y < 0.03 || pong.y > 0.97) { pong.vy = -pong.vy; pong.y = Math.max(0.03, Math.min(0.97, pong.y)); }
      // Cada paleta persigue la pelota con un error que cambia en cada saque: asi a veces falla.
      const chase = (cur, err, coming) => Math.max(ph / 2, Math.min(1 - ph / 2, cur + Math.max(-0.017, Math.min(0.017, (coming ? pong.y + err : 0.5) - cur))));
      pong.l = chase(pong.l, pong.errL, pong.vx < 0); pong.r = chase(pong.r, pong.errR, pong.vx > 0);
      const hit = (pad) => Math.abs(pong.y - pad) < ph / 2 + 0.02;
      if (pong.vx < 0 && pong.x < px + 0.012) { if (hit(pong.l)) { pong.vx = Math.min(0.024, -pong.vx * 1.06); pong.vy += (pong.y - pong.l) * 0.06; pong.errR = (Math.random() - 0.5) * 0.4; } else if (pong.x < 0) { pong.sr++; onScore?.('avatar', pong.sr, pong.sl); serve(1); } }
      if (pong.vx > 0 && pong.x > 1 - px - 0.012) { if (hit(pong.r)) { pong.vx = Math.max(-0.024, -pong.vx * 1.06); pong.vy += (pong.y - pong.r) * 0.06; pong.errL = (Math.random() - 0.5) * 0.4; } else if (pong.x > 1) { pong.sl++; onScore?.('rival', pong.sr, pong.sl); serve(-1); } }
      if (pong.sl >= 7 || pong.sr >= 7) { pong.sl = 0; pong.sr = 0; }
    }
    ctx.fillStyle = '#0b1020'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = size * 0.2; ctx.setLineDash([size, size]); ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = `700 ${size * 4}px ui-monospace, Menlo, monospace`; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillText(String(pong.sl), W * 0.2, size * 6); ctx.fillStyle = 'rgba(255,150,90,0.75)'; ctx.fillText(String(pong.sr), W * 0.8, size * 6); ctx.textAlign = 'start';
    const pw = size * 0.8;
    ctx.fillStyle = '#e8ecf5'; ctx.fillRect(px * W - pw, (pong.l - ph / 2) * H, pw, ph * H);
    ctx.fillStyle = '#ff7a59'; ctx.fillRect((1 - px) * W, (pong.r - ph / 2) * H, pw, ph * H);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(pong.x * W, pong.y * H, size * 0.75, 0, 6.283); ctx.fill();
  };
  window.addEventListener('resize', () => { if (current) resize(); });
  return {
    show(name) {
      if (name === 'matrix') name = 'neuronal'; // nombre anterior del fondo de tecnologia
      if (!draw[name]) name = null;
      if (name === current) return;
      current = name; canvas.classList.toggle('on', !!name);
      if (name) { clearInterval(timer); resize(); ctx.clearRect(0, 0, W, H); timer = setInterval(draw[name], 55); }
      else setTimeout(() => { if (!current) { clearInterval(timer); timer = null; } }, 1400); // sigue animando durante el fundido
    },
    get current() { return current; },
    /** Pelota del ping-pong en coordenadas de pantalla (-1..1) y aviso de cada punto: fn('avatar' | 'rival'). */
    get ball() { return { x: pong.x * 2 - 1, y: 1 - pong.y * 2 }; },
    set onScore(fn) { onScore = fn; },
  };
}
