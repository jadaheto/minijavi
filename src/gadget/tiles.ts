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

/** Tarjeta de lo que suena en Spotify (control remoto). `image`: carátula, para las pantallas que pueden mostrarla. */
export function musicTile(o: { device: string; playing: boolean; title: string; artist: string; image?: string }): Record<string, unknown> {
  return { ...tile({ title: `Spotify · ${o.device}`, big: o.playing ? 'Suena' : 'Pausa', tone: o.playing ? 'ok' : 'info', lines: [o.title, o.artist] }), ...(o.image ? { image: o.image } : {}) };
}

/** Tarjetas para un mensaje que iba a la página ({type:'tesla'}, {type:'panel', kind}, {type:'weather'}). Vacío = no hay cómo mostrarlo. */
export function tilesFor(msg: unknown): Tile[] {
  const m = (msg ?? {}) as Data;
  try {
    if (m.type === 'tesla') return tesla(m);
    if (m.type === 'weather') return weather(m);
    if (m.type === 'panel') return m.kind === 'finance' ? finance(m) : m.kind === 'route' ? route(m) : m.kind === 'brief' ? brief(m) : m.kind === 'status' ? status(m) : [];
  } catch { /* un dato con otra forma: sin tarjeta, el avatar igual lo dice */ }
  return [];
}
