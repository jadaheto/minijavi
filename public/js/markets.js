// Panel de mercados de prediccion (modo dueño, solo consulta). Lista numerada: cada mercado con un medidor circular de
// la opcion que va adelante, cuanto se movio en 24 h y una linea de tendencia; al abrir uno, el medidor en grande, la
// grafica de evolucion (hace un mes, una semana, ayer, hace una hora, ahora) y todas sus opciones con barras.
// La tendencia sale de los cambios reales que entrega la fuente: son pocos puntos, no una curva inventada.
// Los textos vienen de un tercero (traducidos por el modelo): siempre con textContent. Sin enlaces.
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const svg = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
const money = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.0', '')} M` : n >= 1e3 ? `${Math.round(n / 1e3)} mil` : String(Math.round(n || 0)));
const pctText = (p) => (p > 0 && p < 1 ? '<1' : p > 99 && p < 100 ? '>99' : String(Math.round(p)));
const fecha = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${Number(m[3])} ${['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][Number(m[2]) - 1]} ${m[1]}` : ''; };
const STEPS = [['m', 'hace 1 mes'], ['w', 'hace 1 sem'], ['d', 'ayer'], ['h', 'hace 1 h']];
/** Puntos de la tendencia de una opcion, del mas antiguo al actual. */
const points = (o) => [...STEPS.filter(([k]) => Number.isFinite(o?.trend?.[k])).map(([k, label]) => ({ label, v: o.trend[k] })), { label: 'ahora', v: Number(o?.pct) || 0 }];
const tone = (d) => (d > 0.4 ? 'up' : d < -0.4 ? 'down' : 'flat');

/** Medidor circular que se llena hasta `value` (0-100) con el numero subiendo. */
function ring(value, size, delay) {
  const r = 42, c = 2 * Math.PI * r, box = el('div', 'mkt-ring'); box.style.width = box.style.height = `${size}px`;
  const s = svg('svg', { viewBox: '0 0 100 100' });
  const arc = svg('circle', { class: 'mkt-arc', cx: 50, cy: 50, r, 'stroke-dasharray': c, 'stroke-dashoffset': c });
  s.append(svg('circle', { class: 'mkt-track', cx: 50, cy: 50, r }), arc);
  const num = el('b', 'mkt-num', '0'), unit = el('small', '', '%'), mid = el('span', 'mkt-mid'); mid.append(num, unit);
  box.append(s, mid);
  const t0 = performance.now() + delay, dur = 1100;
  const step = (now) => {
    if (!box.isConnected) return;
    const p = Math.max(0, Math.min(1, (now - t0) / dur)), e = 1 - Math.pow(1 - p, 3), v = value * e;
    arc.setAttribute('stroke-dashoffset', String(c * (1 - v / 100))); num.textContent = p < 1 ? String(Math.round(v)) : pctText(value);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return box;
}

/** Linea de tendencia que se dibuja sola. Con `detail` lleva area, puntos y los rotulos de cada momento. */
function trend(o, w, h, delay, detail) {
  const pts = points(o);
  if (pts.length < 2) return null;
  const vals = pts.map((p) => p.v), lo = Math.min(...vals), hi = Math.max(...vals), pad = detail ? 16 : 4, span = Math.max(4, hi - lo);
  const x = (i) => pad + (i * (w - 2 * pad)) / (pts.length - 1), y = (v) => pad + (1 - (v - (lo - (span - (hi - lo)) / 2)) / span) * (h - 2 * pad - (detail ? 14 : 0));
  const s = svg('svg', { viewBox: `0 0 ${w} ${h}`, class: `mkt-trend ${tone(vals.at(-1) - vals[0])}${detail ? ' big' : ''}`, preserveAspectRatio: 'none' });
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  if (detail) s.append(svg('path', { class: 'mkt-area', d: `${d} L${x(pts.length - 1).toFixed(1)} ${h - 14} L${x(0).toFixed(1)} ${h - 14} Z`, style: `animation-delay:${delay + 500}ms` }));
  const line = svg('path', { class: 'mkt-line', d, pathLength: 1, style: `animation-delay:${delay}ms` });
  s.append(line);
  pts.forEach((p, i) => {
    if (!detail && i !== pts.length - 1) return;
    s.append(svg('circle', { class: 'mkt-dot', cx: x(i).toFixed(1), cy: y(p.v).toFixed(1), r: detail ? 3.4 : 2.6, style: `animation-delay:${delay + 300 + i * 160}ms` }));
    if (detail) {
      const anchor = i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle';
      const val = svg('text', { class: 'mkt-val', x: x(i).toFixed(1), y: (y(p.v) - 7).toFixed(1), 'text-anchor': anchor, style: `animation-delay:${delay + 300 + i * 160}ms` }); val.textContent = `${pctText(p.v)}%`;
      const lab = svg('text', { class: 'mkt-lab', x: x(i).toFixed(1), y: h - 2, 'text-anchor': anchor }); lab.textContent = p.label;
      s.append(val, lab);
    }
  });
  return s;
}

function change(d) {
  if (!Number.isFinite(d) || Math.abs(d) < 0.5) return null;
  return el('span', `mkt-chg ${tone(d)}`, `${d > 0 ? '▲' : '▼'} ${Math.abs(d) >= 10 ? Math.round(Math.abs(d)) : Math.abs(d).toFixed(1).replace('.', ',')} pts hoy`);
}
function bar(o, delay) {
  const row = el('div', 'mkt-opt'); row.style.setProperty('--pct', `${Math.max(0, Math.min(100, Number(o.pct) || 0))}%`); row.style.animationDelay = `${delay}ms`;
  const right = el('span', 'mkt-right'); const c = change(o.d1); if (c) right.append(c); right.append(el('b', '', `${pctText(Number(o.pct) || 0)} %`));
  row.append(el('span', 'mkt-label', o.label), right);
  return row;
}

export function createMarketsPanel(box, onPick) {
  let items = [], title = '', index = 0;
  const hide = () => { box.hidden = true; box.replaceChildren(); document.body.classList.remove('markets'); items = []; index = 0; };

  function head(text, back) {
    const h = el('header', 'nws-head');
    if (back) { const b = el('button', 'nws-back', '‹ Lista'); b.type = 'button'; b.addEventListener('click', () => { index = 0; draw(); onPick?.(0); }); h.append(b); }
    h.append(el('strong', 'nws-title', text));
    const x = el('button', 'nws-close', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Quitar los mercados'); x.addEventListener('click', hide); h.append(x);
    return h;
  }
  const foot = (it, extra) => [extra > 0 ? `+${extra} opciones` : '', it.volume24 ? `${money(it.volume24)} USD en 24 h` : '', it.ends ? `cierra ${fecha(it.ends)}` : ''].filter(Boolean).join(' · ');

  function draw() {
    box.replaceChildren(); box.dataset.view = index ? 'open' : 'list';
    if (!index) {
      const list = el('ol', 'nws-list');
      for (const it of items) {
        const lead = it.options?.[0] || { label: '', pct: 0 }, delay = 70 * it.n;
        const li = el('li', 'mkt-item'); li.style.animationDelay = `${delay}ms`;
        const btn = el('button', 'mkt-row'); btn.type = 'button'; btn.addEventListener('click', () => { index = it.n; draw(); onPick?.(it.n); });
        const text = el('span', 'mkt-text'), line = el('span', 'mkt-lead'); line.append(el('span', 'mkt-label', lead.label)); const c = change(lead.d1); if (c) line.append(c);
        const head2 = el('span', 'mkt-top'); head2.append(el('span', 'nws-n', String(it.n)), el('span', 'nws-h', it.title));
        text.append(head2, line, el('small', 'mkt-foot', foot(it, (it.options?.length || 0) - 1 + (Number(it.more) || 0))));
        const side = el('span', 'mkt-side'); side.append(ring(Number(lead.pct) || 0, 62, delay + 150)); const t = trend(lead, 96, 26, delay + 500, false); if (t) side.append(t);
        btn.append(text, side); li.append(btn); list.append(li);
      }
      box.append(head(title || 'Mercados de predicción'), list, el('p', 'nws-hint', 'Di «abre el mercado 2» o toca uno · probabilidades del mercado de Polymarket, solo consulta'));
      return;
    }
    const it = items[index - 1], lead = it.options?.[0] || { label: '', pct: 0 };
    const art = el('article', 'mkt-open'), top = el('div', 'mkt-hero'), info = el('div', 'mkt-info'), line = el('span', 'mkt-lead');
    line.append(el('span', 'mkt-label', lead.label)); const c = change(lead.d1); if (c) line.append(c);
    info.append(el('h2', 'nws-h big', it.title), line);
    top.append(ring(Number(lead.pct) || 0, 124, 150), info);
    art.append(top);
    const t = trend(lead, 460, 150, 350, true);
    if (t) { const wrap = el('div', 'mkt-chart'); wrap.append(el('small', 'mkt-cap', `Evolución de «${lead.label}»`), t); art.append(wrap); }
    const opts = el('div', 'mkt-opts'); (it.options || []).slice(0, 6).forEach((o, i) => opts.append(bar(o, 500 + i * 110)));
    art.append(opts, el('small', 'mkt-foot', foot(it, Number(it.more) || 0)));
    box.append(head(`Mercado ${it.n} de ${items.length}`, true), art, el('p', 'nws-hint', 'Probabilidades del mercado de Polymarket · solo consulta'));
  }

  return {
    show(msg) {
      if (msg.action === 'hide' || !Array.isArray(msg.items) || !msg.items.length) return hide();
      items = msg.items.slice(0, 8); title = msg.title || ''; index = msg.action === 'open' ? Math.max(0, Math.min(items.length, Number(msg.index) || 0)) : 0;
      draw();
      box.hidden = false; document.body.classList.add('markets');
      box.classList.remove('in'); void box.offsetWidth; box.classList.add('in');
    },
    hide,
    get active() { return !box.hidden; },
  };
}
