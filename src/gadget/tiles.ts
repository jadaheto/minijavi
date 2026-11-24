/**
 * Javi de bolsillo: tarjetas para la pantalla pequeña.
 *
 * La página del avatar dibuja paneles ricos (gráficas, mapas, listas). La placa solo sabe dibujar UNA cosa: una tarjeta con
 * un título, una cifra grande con su unidad, un anillo de porcentaje opcional y hasta tres renglones. Aquí se resume cada
 * panel a ese formato, con los mismos datos que ya se enviaban a la página: así, sumar un panel nuevo no exige volver a
 * cargar el programa de la placa.
 */
export interface Tile {
  title: string;
  big: string;
  unit?: string;
  /** Anillo alrededor de la pantalla, de 0 a 100. */
  ring?: number;
  tone?: 'ok' | 'warn' | 'bad' | 'info';
  lines: string[];
  /** 'list': sin cifra grande; `lines` son hasta tres entradas de una lista (cada una ocupa hasta dos renglones). */
  kind?: 'list';
}
type Data = Record<string, any>;

const clip = (s: unknown, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const num = (v: unknown, decimals = 0) => (Number.isFinite(Number(v)) ? Number(v) : 0).toLocaleString('es-CO', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const hm = (minutes: number) => (minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}` : `${minutes}`);
const tile = (t: Tile): Tile => ({ ...t, title: clip(t.title, 22), big: clip(t.big, 9), unit: t.unit ? clip(t.unit, 6) : undefined, lines: t.lines.filter(Boolean).slice(0, 3).map((l) => clip(l, 30)), ring: t.ring === undefined ? undefined : Math.max(0, Math.min(100, Math.round(t.ring))) });
const batteryTone = (level: number): Tile['tone'] => (level < 20 ? 'bad' : level < 50 ? 'warn' : 'ok');
const ago = (min?: number) => (min === undefined ? '' : min < 90 ? `Dato de hace ${min} min` : `Dato de hace ${Math.round(min / 60)} h`);

function tesla(d: Data): Tile[] {
  if (typeof d.level !== 'number') return [];
  const charging = d.charging === 'Charging', open = [...(d.doors ?? []), ...(d.trunks ?? [])].some(Boolean);
  const charge = charging ? `Cargando${d.minutesLeft ? ` · faltan ${hm(d.minutesLeft)}${d.minutesLeft >= 60 ? '' : ' min'}` : ''}` : d.charging === 'Complete' ? 'Carga completa' : '';
  const safe = open ? 'Hay una puerta o baúl abierto' : d.locked === false ? 'SIN seguro' : d.locked === true ? 'Con seguro' : '';
  const temp = typeof d.inside === 'number' ? `Adentro ${Math.round(d.inside)}°${typeof d.outside === 'number' ? ` · afuera ${Math.round(d.outside)}°` : ''}` : '';
  const range = typeof d.rangeKm === 'number' ? `${num(d.rangeKm)} km de autonomía` : '';
  const lines = d.focus === 'clima' ? [temp, d.climateOn ? 'Aire encendido' : 'Aire apagado', range]
    : d.focus === 'seguridad' ? [safe, d.sentry === true ? 'Centinela activo' : d.sentry === false ? 'Centinela apagado' : '', range]
      : [range, charge || safe, charge ? safe : d.live === false ? ago(d.ageMin) : temp];
  return [tile({ title: d.name || 'Tesla', big: String(Math.round(d.level)), unit: '%', ring: d.level, tone: open || d.locked === false ? 'bad' : batteryTone(d.level), lines })];
}

function finance(d: Data): Tile[] {
  return (Array.isArray(d.items) ? d.items : []).map((s: Data) => {
    const trm = s.id === 'trm', up = Number(s.change) > 0, flat = !Number(s.change);
    const change = s.change === undefined ? '' : trm ? (flat ? 'Igual que el valor anterior' : `${up ? 'Subió' : 'Bajó'} ${num(Math.abs(s.change), 2)} pesos`) : `${up ? 'Subió' : 'Bajó'} ${num(Math.abs(s.change), 2)} % en 24 h`;
    return tile({ title: trm ? 'Dólar (TRM)' : s.name || 'Bitcoin', big: num(s.value, trm ? 0 : 0), unit: trm ? 'COP' : 'USD', tone: flat ? 'info' : up ? 'ok' : 'warn', lines: [change, String(s.extra ?? '')] });
  });
}

function route(d: Data): Tile[] {
  const out = [tile({ title: `A ${d.to ?? 'destino'}`, big: hm(Number(d.minutes) || 0), unit: Number(d.minutes) >= 60 ? '' : 'min', tone: Number(d.delay) >= 10 ? 'warn' : 'info',
    lines: [Number.isFinite(Number(d.km)) && d.km !== null && typeof d.km !== 'object' ? `${num(d.km, 1)} km` : '', d.arrive ? `Llegas hacia las ${d.arrive}` : '', Number(d.delay) >= 3 ? `Tráfico: +${d.delay} min` : 'Sin demoras'] })];
  const b = d.battery;
  if (b && typeof b.now === 'number') out.push(tile(b.enough
    ? { title: 'Batería al llegar', big: String(b.arrive), unit: '%', ring: b.arrive, tone: b.arrive < 15 ? 'bad' : batteryTone(b.arrive), lines: [`Ahora tiene ${b.now} %`, `${num(b.rangeKm)} km de autonomía`, 'Cuenta aproximada'] }
    : { title: 'No le alcanza', big: String(b.shortKm), unit: 'km', ring: 0, tone: 'bad', lines: ['Le faltan esos kilómetros', `Ahora tiene ${b.now} %`, 'Hay que cargar antes'] }));
  return out;
}

function brief(d: Data): Tile[] {
  return (Array.isArray(d.cards) ? d.cards : []).filter((c: Data) => c.value !== undefined && c.value !== null).slice(0, 6).map((c: Data) => tile({
    title: c.label ?? '', big: typeof c.value === 'number' ? num(c.value, c.id === 'trm' ? 0 : 0) : String(c.value), unit: c.unit, ring: typeof c.meter === 'number' ? c.meter : undefined,
    tone: c.alert ? 'warn' : typeof c.meter === 'number' ? batteryTone(c.meter) : 'info', lines: String(c.note ?? '').split(' · '),
  }));
}

function weather(d: Data): Tile[] {
  if (typeof d.temp !== 'number') return [];
  return [tile({ title: d.city ?? 'Clima', big: String(d.temp), unit: '°C', tone: 'info', lines: [d.desc ? String(d.desc).replace(/^./, (c: string) => c.toUpperCase()) : '', `Máx ${d.max}° · mín ${d.min}°`, `Lluvia ${d.rain} %`] })];
}

function status(d: Data): Tile[] {
  const rows: Data[] = Array.isArray(d.rows) ? d.rows : [], bad = rows.filter((r) => r.ok === false);
  return [tile({ title: 'Servicios', big: bad.length ? String(bad.length) : 'OK', unit: bad.length ? (bad.length === 1 ? 'falla' : 'fallas') : '', tone: bad.length ? 'bad' : 'ok',
    lines: bad.length ? bad.slice(0, 3).map((r) => r.name) : [`${rows.filter((r) => r.ok === true).length} funcionando`] })];
}

/**
 * Listas (noticias, mercados, tareas, cargadores): tarjetas de tres entradas que pasan solas. La pantalla no alcanza
 * para más: el avatar dice lo importante y la tarjeta acompaña.
 */
const LIST_ROWS = 3, LIST_CHARS = 52, LIST_PAGES = 4;
function listTiles(title: string, rows: string[], tone: Tile['tone'] = 'info'): Tile[] {
  const clean = rows.map((r) => clip(r, LIST_CHARS)).filter(Boolean).slice(0, LIST_ROWS * LIST_PAGES), out: Tile[] = [];
  for (let i = 0; i < clean.length; i += LIST_ROWS) out.push({ kind: 'list', title: clip(title, 22), big: '', tone, lines: clean.slice(i, i + LIST_ROWS) });
  return out;
}

function news(d: Data): Tile[] {
  const items: Data[] = Array.isArray(d.items) ? d.items : [];
  if (d.action === 'hide' || !items.length) return [];
  const k = Number(d.index) || 0, one = k >= 1 && k <= items.length ? items[k - 1] : undefined;
  if (one) return listTiles(one.source || d.title || 'Noticia', wrapLines(String(one.title ?? ''), LIST_CHARS, LIST_ROWS)); // una noticia abierta: su titular entero
  return listTiles(d.title || 'Noticias', items.map((i) => `${i.n ?? ''}. ${i.title ?? ''}`));
}

function markets(d: Data): Tile[] {
  const items: Data[] = Array.isArray(d.items) ? d.items : [];
  if (d.action === 'hide' || !items.length) return [];
  const top = (e: Data) => (Array.isArray(e.options) && e.options[0] && Number.isFinite(Number(e.options[0].pct)) ? e.options[0] : undefined);
  const k = Number(d.index) || 0, one = d.action === 'open' && k >= 1 && k <= items.length ? items[k - 1] : undefined;
  if (one) { // un mercado abierto: la opción que va adelante en grande y las demás debajo
    const o = top(one); if (!o) return [];
    return [tile({ title: one.title ?? 'Mercado', big: num(o.pct), unit: '%', ring: Number(o.pct), tone: 'info', lines: [String(o.label ?? ''), ...(one.options as Data[]).slice(1, 3).map((x) => `${x.label}: ${num(x.pct)} %`)] })];
  }
  return listTiles(d.title || 'Mercados', items.map((e) => { const o = top(e); return o ? `${clip(e.title, 36)} · ${clip(o.label, 8)} ${num(o.pct)} %` : String(e.title ?? ''); }));
}

function board(d: Data): Tile[] {
  if (!Array.isArray(d.columns)) return [];
  const cards = (g: string): Data[] => (d.columns as Data[]).find((c) => c.group === g)?.cards ?? [];
  const head = tile({ title: d.project || 'Tareas', big: num(d.open), unit: Number(d.open) === 1 ? 'tarea' : 'tareas', ring: Number(d.total) ? (Number(d.done) / Number(d.total)) * 100 : undefined, tone: Number(d.late) ? 'bad' : Number(d.dueToday) ? 'warn' : 'ok',
    lines: [Number(d.late) ? `${d.late} atrasada${Number(d.late) === 1 ? '' : 's'}` : 'Nada atrasado', Number(d.dueToday) ? `${d.dueToday} para hoy` : '', `${num(d.done)} hecha${Number(d.done) === 1 ? '' : 's'}`] });
  const rows = [...cards('started'), ...cards('unstarted')].map((c) => `${c.late ? 'Atrasada: ' : c.today ? 'Hoy: ' : ''}${c.name ?? ''}`);
  return [head, ...listTiles('Lo que sigue', rows, Number(d.late) ? 'bad' : 'info').slice(0, 2)];
}

function chargers(d: Data): Tile[] {
  const items: Data[] = Array.isArray(d.items) ? d.items : [];
  return listTiles('Cargadores', items.map((c) => `${c.n ?? ''}. ${clip(c.title, 26)} · ${num(c.km, 1)} km${Number(c.kw) ? ` · ${num(c.kw)} kW` : ''}`), 'ok');
}

/** Un texto partido en renglones cortos por palabras (para decir en la tarjeta qué pasó con una orden). */
export function wrapLines(text: string, width = 30, max = 3): string[] {
  const out: string[] = []; let line = '';
  for (const w of String(text ?? '').replace(/\s+/g, ' ').trim().split(' ')) {
    if (line && (line + ' ' + w).length > width) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.length > max ? [...out.slice(0, max - 1), clip(out.slice(max - 1).join(' '), width)] : out;
}

/** Tarjeta de lo que suena en Spotify (control remoto). `image`: carátula, para las pantallas que pueden mostrarla. */
export function musicTile(o: { device: string; playing: boolean; title: string; artist: string; image?: string }): Record<string, unknown> {
  return { ...tile({ title: `Spotify · ${o.device}`, big: o.playing ? 'Suena' : 'Pausa', tone: o.playing ? 'ok' : 'info', lines: [o.title, o.artist] }), kind: 'music', playing: o.playing, ...(o.image ? { image: o.image } : {}) };
}

/** Tarjetas para un mensaje que iba a la página ({type:'tesla'}, {type:'panel', kind}, {type:'weather'}, {type:'news'}, {type:'markets'}). Vacío = no hay cómo mostrarlo. */
export function tilesFor(msg: unknown): Tile[] {
  const m = (msg ?? {}) as Data;
  try {
    if (m.type === 'tesla') return tesla(m);
    if (m.type === 'weather') return weather(m);
    if (m.type === 'news') return news(m);
    if (m.type === 'markets') return markets(m);
    if (m.type === 'panel') return m.kind === 'finance' ? finance(m) : m.kind === 'route' ? route(m) : m.kind === 'brief' ? brief(m) : m.kind === 'status' ? status(m) : m.kind === 'board' ? board(m) : m.kind === 'chargers' ? chargers(m) : [];
  } catch { /* un dato con otra forma: sin tarjeta, el avatar igual lo dice */ }
  return [];
}
