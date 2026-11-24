// Paneles animados de datos: dolar y Bitcoin (grafica que se dibuja sola), estado de los servicios (semaforo) y consumo
// (barras por dia). El servidor manda solo cifras y textos cortos; aqui se dibujan. Los textos van con textContent.
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const svg = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
const num = (v, d = 0) => Number(v || 0).toLocaleString('es-CO', { maximumFractionDigits: d, minimumFractionDigits: d });
const short = (v) => (v >= 1e6 ? `${num(v / 1e6, 1)} M` : v >= 1e4 ? `${num(v / 1e3)} mil` : num(v));
const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const dia = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${Number(m[3])} ${MES[Number(m[2]) - 1]}` : ''; };

/** Numero que sube hasta su valor. */
function countUp(node, value, decimals, delay) {
  const t0 = performance.now() + delay, dur = 1100;
  const step = (now) => { if (!node.isConnected) return; const p = Math.max(0, Math.min(1, (now - t0) / dur)), e = 1 - Math.pow(1 - p, 3); node.textContent = num(value * e, decimals); if (p < 1) requestAnimationFrame(step); };
  node.textContent = num(0, decimals); requestAnimationFrame(step);
}

/** Grafica de linea con area que se dibuja sola, con minimo, maximo y fechas de los extremos. */
function lineChart(points, tone, delay) {
  const W = 480, H = 150, padX = 6, padTop = 14, padBot = 20;
  const vals = points.map((p) => p.v), lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const x = (i) => padX + (i * (W - 2 * padX)) / Math.max(1, points.length - 1), y = (v) => padTop + (1 - (v - lo) / span) * (H - padTop - padBot);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: `pnl-chart ${tone}`, preserveAspectRatio: 'none' });
  for (const g of [0.25, 0.5, 0.75]) s.append(svg('line', { class: 'pnl-grid', x1: padX, x2: W - padX, y1: padTop + g * (H - padTop - padBot), y2: padTop + g * (H - padTop - padBot) }));
  s.append(svg('path', { class: 'pnl-area', d: `${d} L${x(points.length - 1).toFixed(1)} ${H - padBot} L${x(0).toFixed(1)} ${H - padBot} Z`, style: `animation-delay:${delay + 700}ms` }),
    svg('path', { class: 'pnl-line', d, pathLength: 1, style: `animation-delay:${delay}ms` }),
    svg('circle', { class: 'pnl-dot', cx: x(points.length - 1).toFixed(1), cy: y(vals.at(-1)).toFixed(1), r: 4, style: `animation-delay:${delay + 1300}ms` }));
  const first = svg('text', { class: 'pnl-axis', x: padX, y: H - 5 }); first.textContent = dia(points[0].t);
  const last = svg('text', { class: 'pnl-axis', x: W - padX, y: H - 5, 'text-anchor': 'end' }); last.textContent = 'hoy';
  s.append(first, last);
  return { svg: s, lo, hi };
}

function finance(msg) {
  const wrap = el('div', 'pnl-finance');
  (msg.items || []).forEach((it, i) => {
    const delay = 150 + i * 350, up = Number(it.change) > 0, down = Number(it.change) < 0, tone = up ? 'up' : down ? 'down' : 'flat';
    const card = el('section', 'pnl-card'); card.style.animationDelay = `${i * 0.2}s`;
    const head = el('div', 'pnl-row'), big = el('div', 'pnl-big'), val = el('b', 'pnl-value'), dec = it.id === 'trm' ? 2 : 0;
    big.append(val, el('small', '', it.unit)); countUp(val, Number(it.value) || 0, dec, delay);
    const left = el('div', 'pnl-name'); left.append(el('strong', '', it.name)); if (it.extra) left.append(el('small', '', it.extra));
    head.append(left, big); card.append(head);
    if (Number.isFinite(it.change) && it.change !== 0) card.append(el('span', `mkt-chg ${tone}`, `${up ? '▲' : '▼'} ${num(Math.abs(it.change), it.id === 'trm' ? 2 : 1)}${it.id === 'trm' ? ' pesos' : ' %'} ${it.changeLabel?.replace(/^% /, '') || ''}`.trim()));
    if (Array.isArray(it.points) && it.points.length > 1) {
      const c = lineChart(it.points, tone, delay);
      const range = el('small', 'pnl-range', `mín ${num(c.lo, dec)} · máx ${num(c.hi, dec)} · ${it.id === 'trm' ? `últimos ${it.points.length} valores` : 'últimos 7 días'}`);
      card.append(c.svg, range);
    }
    card.append(el('small', 'pnl-source', `Fuente: ${it.source}`));
    wrap.append(card);
  });
  return wrap;
}

function status(msg) {
  const rows = msg.rows || [], bad = rows.filter((r) => r.ok === false).length, wrap = el('div', 'pnl-status');
  const hero = el('div', `pnl-light ${bad ? 'bad' : 'ok'}`), lamp = el('span', 'pnl-lamp');
  const text = el('div', 'pnl-name'); text.append(el('strong', '', bad ? `${bad} con problemas` : 'Todo funcionando'), el('small', '', `${rows.length} servicios revisados`));
  hero.append(lamp, text); wrap.append(hero);
  const list = el('ul', 'pnl-list');
  // Lo que falla va primero.
  [...rows].sort((a, b) => Number(a.ok !== false) - Number(b.ok !== false)).forEach((r, i) => {
    const li = el('li', `pnl-svc ${r.ok === false ? 'bad' : r.ok === null ? 'idle' : 'ok'}`); li.style.animationDelay = `${0.25 + i * 0.07}s`;
    const t = el('span', 'pnl-svc-text'); t.append(el('b', '', r.name), el('small', '', r.detail || (r.ok ? 'bien' : '')));
    li.append(el('span', 'pnl-pip'), t, el('span', 'pnl-tag', r.ok === false ? 'Falla' : r.ok === null ? 'Sin dato' : 'Bien'));
    list.append(li);
  });
  wrap.append(list);
  return wrap;
}

function usage(msg) {
  const days = msg.days || [], wrap = el('div', 'pnl-usage'), today = days.at(-1) || {};
  const METRICS = [['sesiones', 'Conversaciones', (v) => num(v)], ['escucha_min', 'Escucha', (v) => `${num(v)} min`], ['tokens', 'Modelo', (v) => `${short(v)} tokens`], ['voz', 'Voz', (v) => `${short(v)} car.`]];
  if (msg.priced) METRICS.push(['usd', 'Costo estimado', (v) => `${num(v, 2)} USD`]);
  METRICS.forEach(([key, name, fmt], i) => {
    const vals = days.map((d) => Number(d[key]) || 0), max = Math.max(1e-9, ...vals), total = vals.reduce((a, b) => a + b, 0);
    const card = el('section', 'pnl-metric'); card.style.animationDelay = `${i * 0.12}s`;
    const head = el('div', 'pnl-row'), left = el('div', 'pnl-name');
    left.append(el('strong', '', name), el('small', '', `hoy ${fmt(Number(today[key]) || 0)}`));
    head.append(left, el('b', 'pnl-total', fmt(total)));
    const bars = el('div', 'pnl-bars');
    days.forEach((d, j) => {
      const col = el('span', 'pnl-bar'), fill = el('i'); fill.style.height = `${Math.max(3, (vals[j] / max) * 100)}%`; fill.style.animationDelay = `${0.3 + i * 0.12 + j * 0.04}s`;
      if (j === days.length - 1) col.classList.add('now');
      col.title = `${dia(d.day)}: ${fmt(vals[j])}`; col.append(fill); bars.append(col);
    });
    card.append(head, bars); wrap.append(card);
  });
  wrap.append(el('small', 'pnl-source', `${days.length ? `${dia(days[0].day)} a ${dia(today.day)}` : ''} · total del periodo a la derecha${msg.priced ? '' : ' · sin precios configurados: solo unidades'}`));
  return wrap;
}

/** Tablero de tareas: resumen arriba (avance, atrasadas, hoy) y columnas por estado con sus tarjetas. */
function board(msg) {
  const wrap = el('div', 'pnl-board'), total = Math.max(1, Number(msg.total) || 0), pct = Math.round(((Number(msg.done) || 0) / total) * 100);
  const hero = el('div', 'pnl-progress'), top = el('div', 'pnl-row'), left = el('div', 'pnl-name'), val = el('b', 'pnl-total');
  left.append(el('strong', '', `${num(msg.open)} abiertas · ${num(msg.done)} hechas`), el('small', '', `${msg.identifier || ''}${msg.truncated ? ' · las 400 más recientes' : ''}`));
  val.textContent = '0 %'; top.append(left, val);
  const track = el('div', 'pnl-track'), fill = el('i'); fill.style.width = `${pct}%`; track.append(fill);
  const t0 = performance.now() + 200; const step = (now) => { if (!val.isConnected) return; const p = Math.max(0, Math.min(1, (now - t0) / 1100)); val.textContent = `${Math.round(pct * (1 - Math.pow(1 - p, 3)))} %`; if (p < 1) requestAnimationFrame(step); }; requestAnimationFrame(step);
  const chips = el('div', 'pnl-chips');
  if (msg.late) chips.append(el('span', 'mkt-chg down', `${num(msg.late)} atrasada${msg.late > 1 ? 's' : ''}`));
  if (msg.dueToday) chips.append(el('span', 'mkt-chg warn', `${num(msg.dueToday)} vence${msg.dueToday > 1 ? 'n' : ''} hoy`));
  if (!msg.late && !msg.dueToday) chips.append(el('span', 'mkt-chg up', 'nada atrasado'));
  hero.append(top, track, chips); wrap.append(hero);
  const cols = el('div', 'pnl-cols');
  (msg.columns || []).filter((c) => c.group !== 'backlog' || c.count).forEach((c, i) => {
    const col = el('section', 'pnl-col'); col.style.animationDelay = `${0.15 + i * 0.12}s`; col.style.setProperty('--c', c.color || '#6fb2ff'); col.dataset.group = c.group;
    const head = el('header', 'pnl-col-head'); head.append(el('span', 'pnl-pip'), el('b', '', c.name), el('span', 'pnl-count', num(c.count)));
    col.append(head);
    (c.cards || []).forEach((k, j) => {
      const card = el('article', `pnl-task${k.late ? ' late' : k.today ? ' today' : ''}`); card.style.animationDelay = `${0.35 + i * 0.12 + j * 0.06}s`;
      const meta = el('small', '', [k.key, k.priority && k.priority !== 'none' ? ({ urgent: 'urgente', high: 'alta', medium: 'media', low: 'baja' }[k.priority] || '') : '', k.due ? (k.late ? `venció ${dia(k.due)}` : k.today ? 'vence hoy' : dia(k.due)) : ''].filter(Boolean).join(' · '));
      card.append(el('span', 'pnl-task-name', k.name), meta); col.append(card);
    });
    if (c.count > (c.cards || []).length) col.append(el('small', 'pnl-more', `+${num(c.count - c.cards.length)} más`));
    if (!c.count) col.append(el('small', 'pnl-more', 'vacía'));
    cols.append(col);
  });
  wrap.append(cols);
  return wrap;
}

/** Imagen del mapa que armo el servidor (solo de este mismo sitio). */
function mapImage(src, alt) {
  if (typeof src !== 'string' || !/^\/mapas\/[a-f0-9]{24}\.png$/.test(src)) return null;
  const fig = el('figure', 'pnl-map'), img = el('img'); img.src = src; img.alt = alt; img.addEventListener('load', () => fig.classList.add('ready'));
  fig.append(img); return fig;
}

/** Trayecto: mapa con la ruta, el tiempo en grande, la distancia y la hora de llegada. */
function route(msg) {
  const wrap = el('div', 'pnl-route'), map = mapImage(msg.map, 'Mapa con la ruta'); if (map) wrap.append(map);
  const card = el('section', 'pnl-card'), row = el('div', 'pnl-row'), big = el('div', 'pnl-big'), mins = Math.max(1, Number(msg.minutes) || 0);
  if (mins >= 60) { const h = el('b', 'pnl-value'), m = el('b', 'pnl-value'); countUp(h, Math.floor(mins / 60), 0, 200); countUp(m, mins % 60, 0, 350); big.append(h, el('small', '', 'h'), m, el('small', '', 'min')); }
  else { const m = el('b', 'pnl-value'); countUp(m, mins, 0, 200); big.append(m, el('small', '', 'min')); }
  const left = el('div', 'pnl-name'); left.append(el('strong', '', 'En carro, con el tráfico de ahora'), el('small', '', `${msg.from || ''} → ${msg.to || ''}`));
  row.append(left, big); card.append(row);
  const chips = el('div', 'pnl-chips');
  chips.append(el('span', 'mkt-chg flat', `${num(msg.km, 1)} km`), el('span', 'mkt-chg flat', `llegas ${msg.arrive || ''}`));
  if (Number(msg.delay) >= 3) chips.append(el('span', 'mkt-chg warn', `+${num(msg.delay)} min por tráfico`)); else chips.append(el('span', 'mkt-chg up', 'sin demoras'));
  card.append(chips, el('small', 'pnl-source', 'Estimación de Google Maps')); wrap.append(card);
  // Con el Tesla conectado: con cuanta bateria se llega (la barra muestra la de ahora, tenue, y la de llegada, encendida).
  const b = msg.battery;
  if (b && Number.isFinite(b.now)) {
    const bat = el('section', `pnl-card pnl-battery ${!b.enough ? 'short' : b.arrive < 15 ? 'low' : 'ok'}`), top = el('div', 'pnl-row'), name = el('div', 'pnl-name'), bigB = el('div', 'pnl-big');
    name.append(el('strong', '', b.enough ? 'Batería al llegar' : 'No alcanza la batería'), el('small', '', `sale con ${num(b.now)} % · ${num(b.rangeKm)} km de autonomía${b.live === false && Number.isFinite(b.ageMin) ? ` · dato de hace ${b.ageMin < 90 ? `${b.ageMin} min` : `${Math.round(b.ageMin / 60)} h`}` : ''}`));
    if (b.enough) { const v = el('b', 'pnl-value'); countUp(v, b.arrive, 0, 500); bigB.append(v, el('small', '', '%')); }
    else { const v = el('b', 'pnl-value'); countUp(v, b.shortKm, 0, 500); bigB.append(el('small', '', 'faltan'), v, el('small', '', 'km')); }
    top.append(name, bigB);
    const track = el('div', 'pnl-track pnl-bat'), now = el('i', 'now'), arr = el('i', 'arrive'); now.style.width = `${Math.max(0, Math.min(100, b.now))}%`; arr.style.width = `${Math.max(0, Math.min(100, b.enough ? b.arrive : 0))}%`; track.append(now, arr);
    bat.append(top, track, el('small', 'pnl-source', b.enough ? 'Aproximado: autonomía que marca el carro menos los kilómetros de la ruta' : 'Hay que cargar antes o en el camino: di «¿dónde puedo cargar?»'));
    wrap.append(bat);
  }
  return wrap;
}

/** Cargadores: mapa con los puntos numerados y la lista con distancia, potencia y conectores. */
function chargers(msg) {
  const wrap = el('div', 'pnl-chargers'), map = mapImage(msg.map, 'Mapa con los cargadores'); if (map) wrap.append(map);
  const list = el('ul', 'pnl-list');
  (msg.items || []).forEach((c, i) => {
    const li = el('li', `pnl-charger${c.fast ? ' fast' : ''}`); li.style.animationDelay = `${0.3 + i * 0.07}s`;
    const t = el('span', 'pnl-svc-text'); t.append(el('b', '', c.title), el('small', '', [c.town, (c.connectors || []).join(' · '), c.cost].filter(Boolean).join(' — ')));
    const right = el('span', 'pnl-charger-side'); right.append(el('b', '', `${num(c.km, 1)} km`), el('small', '', c.kw ? `${num(c.kw)} kW${c.fast ? ' · rápida' : ''}` : 'potencia sin dato'));
    li.append(el('span', 'nws-n', String(c.n)), t, right); list.append(li);
  });
  wrap.append(list, el('small', 'pnl-source', `Di «llévame al ${Math.min(2, (msg.items || []).length) || 1}» · distancias en línea recta · datos: Open Charge Map y su comunidad (CC BY 4.0); pueden estar desactualizados`));
  return wrap;
}


/** Resumen del dia: fecha, mosaico de tarjetas (lo que pide accion resaltado) y unos titulares. */
function brief(msg) {
  const wrap = el('div', 'pnl-brief');
  if (msg.subtitle) wrap.append(el('p', 'pnl-date', msg.subtitle));
  const grid = el('div', 'pnl-tiles');
  (msg.cards || []).forEach((c, i) => {
    const t = el('section', `pnl-tile${c.alert ? ' alert' : ''}`); t.dataset.id = c.id || ''; t.style.animationDelay = `${0.1 + i * 0.09}s`;
    const head = el('div', 'pnl-tile-head'); head.append(el('span', 'pnl-tile-icon', c.icon || '•'), el('span', 'pnl-tile-label', c.label || ''));
    t.append(head);
    if (Number.isFinite(c.value)) {
      const big = el('div', 'pnl-big'), val = el('b', 'pnl-value'); big.append(val); if (c.unit) big.append(el('small', '', c.unit));
      countUp(val, Number(c.value), Number(c.decimals) || 0, 250 + i * 90); t.append(big);
    }
    if (Number.isFinite(c.meter)) { const m = el('div', 'pnl-track'), f = el('i'); const v = Math.max(0, Math.min(100, c.meter)); f.style.width = `${v}%`; f.style.background = v < 20 ? '#ef5350' : v < 50 ? '#f0b429' : ''; m.append(f); t.append(m); }
    if (Number.isFinite(c.change) && c.change !== 0) t.append(el('span', `mkt-chg ${c.change > 0 ? 'up' : 'down'}`, `${c.change > 0 ? '▲' : '▼'} ${num(Math.abs(c.change), c.changeUnit === '%' ? 1 : 2)} ${c.changeUnit || ''}`.trim()));
    if (c.note) t.append(el('small', 'pnl-tile-note', c.note));
    if (Array.isArray(c.list) && c.list.length && c.alert) { const ul = el('ul', 'pnl-tile-list'); c.list.slice(0, 3).forEach((x) => ul.append(el('li', '', x))); t.append(ul); }
    grid.append(t);
  });
  wrap.append(grid);
  if (Array.isArray(msg.headlines) && msg.headlines.length) {
    const news = el('section', 'pnl-heads'); news.style.animationDelay = `${0.2 + (msg.cards || []).length * 0.09}s`;
    news.append(el('small', 'pnl-tile-label', '📰 Titulares'));
    msg.headlines.slice(0, 3).forEach((h) => news.append(el('span', 'pnl-head', h)));
    wrap.append(news);
  }
  if (Array.isArray(msg.failed) && msg.failed.length) wrap.append(el('small', 'pnl-source', `No se pudo consultar: ${msg.failed.join(', ')}`));
  return wrap;
}
/** Agenda de Google: los días con sus eventos (hora, título, lugar). Los textos los escribió quien creó cada evento. */
function agenda(msg) {
  const wrap = el('div', 'pnl-agenda'), days = (msg.days || []).filter((d) => (d.events || []).length);
  if (!days.length) { wrap.append(el('p', 'pnl-empty', 'No hay nada en la agenda.')); return wrap; }
  for (const d of days.slice(0, 7)) {
    const sec = el('section', 'pnl-day'); sec.append(el('h4', '', String(d.label || '')));
    const list = el('ul', 'pnl-events');
    for (const e of d.events.slice(0, 8)) {
      const li = el('li', e.tentative ? 'maybe' : '');
      const text = el('div', 'pnl-ev'); text.append(el('strong', '', String(e.title || '')), el('small', '', [e.where, e.others ? `con ${e.others} más` : '', e.tentative ? 'sin confirmar' : ''].filter(Boolean).join(' · ')));
      li.append(el('time', '', String(e.time || '')), text); list.append(li);
    }
    if (d.events.length > 8) list.append(el('li', 'more', `+${d.events.length - 8} más`));
    sec.append(list); wrap.append(sec);
  }
  return wrap;
}

const KINDS = { finance, status, usage, board, route, chargers, brief, agenda };
export function createDataPanel(box) {
  let timer = 0;
  const hide = () => { clearTimeout(timer); box.hidden = true; box.replaceChildren(); document.body.classList.remove('panel'); };
  return {
    show(msg) {
      const render = KINDS[msg.kind];
      if (msg.action === 'hide' || !render) return hide();
      clearTimeout(timer); box.replaceChildren(); box.dataset.kind = msg.kind; box.dataset.scene = typeof msg.scene === 'string' && /^[a-z]{3,20}$/.test(msg.scene) ? msg.scene : '';
      const head = el('header', 'nws-head'); head.append(el('strong', 'nws-title', msg.title || ''));
      const x = el('button', 'nws-close', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Quitar el panel'); x.addEventListener('click', hide); head.append(x);
      box.append(head, render(msg));
      box.hidden = false; document.body.classList.add('panel');
      box.classList.remove('in'); void box.offsetWidth; box.classList.add('in');
      timer = setTimeout(hide, ['board', 'route', 'chargers', 'brief', 'agenda'].includes(msg.kind) ? 120000 : 45000); // son consultas puntuales: se van solas (el tablero dura mas)
    },
    hide,
    get active() { return !box.hidden; },
    /** Que panel esta en pantalla (finance, status, usage, board, route, chargers). */
    get kind() { return box.hidden ? '' : box.dataset.kind || ''; },
    /** Fondo que pide el propio panel (el resumen del dia lleva el del clima). */
    get scene() { return box.hidden ? '' : box.dataset.scene || ''; },
  };
}
