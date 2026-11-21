import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { UsageService } from '../usage/usage.service';

/**
 * Noticias de inteligencia artificial (pedido por Javier el 2026-11-20). Salen de un webhook suyo de n8n (`NOTICIAS_URL`)
 * que devuelve una pagina HTML tipo boletin ("Weekly Insider"): una introduccion y tarjetas `<div class="card">` con
 * `<h2>` (titulo), `<div class="meta">` ("fecha - medio"), `<p>` (resumen, casi siempre igual al titulo) y un enlace.
 * Leido el 2026-11-20: 5 noticias, sin imagenes, enlaces de news.google.com; el webhook tarda ~40 s en responder.
 * Decisiones de Javier: se traen UNA vez al dia (por eso se guardan en la base y se sirven de ahi, al instante), las
 * puede pedir cualquier visitante, al abrir una se muestra su tarjeta con un codigo QR, y se lee el HTML tal como llega.
 * Lo que trae el webhook es texto de terceros (titulares de medios): se limpia, se recorta y se trata como dato.
 */
export interface NewsItem { n: number; title: string; source: string; date: string; summary: string; link: string; qr: string; }
interface Stored { day: string; at: string; intro: string; items: NewsItem[]; logos?: Record<string, string>; }

const META_KEY = 'news_cache';
const MAX_ITEMS = 8;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', iquest: '¿', iexcl: '¡', ntilde: 'ñ', Ntilde: 'Ñ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', uuml: 'ü', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–' };
/** Texto plano de un trozo de HTML: sin etiquetas, con las entidades resueltas y recortado. */
export const plain = (html: string, max: number) => html.replace(/<[^>]*>/g, ' ')
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Math.min(0x10ffff, Number(d)))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Math.min(0x10ffff, parseInt(h, 16))))
  .replace(/&([a-zA-Z]+);/g, (m, k) => ENTITIES[k] ?? m).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Saca las noticias de la pagina del boletin. No lanza: lo que no cuadra se omite. */
export function parseNews(html: string): { intro: string; items: Omit<NewsItem, 'qr'>[] } {
  const body = html.slice(0, 400_000);
  const intro = plain(body.match(/class="masthead"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '', 400);
  const items: Omit<NewsItem, 'qr'>[] = [];
  for (const chunk of body.split(/<div[^>]*class="card"[^>]*>/i).slice(1)) {
    if (items.length >= MAX_ITEMS) break;
    const title = plain(chunk.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? '', 220);
    if (title.length < 8) continue;
    const meta = plain(chunk.match(/class="meta"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '', 140), cut = meta.indexOf(' - ');
    let summary = plain(chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '', 1800); // el flujo v2 de n8n trae aqui un resumen de 5 a 7 frases
    if (summary.replace(/[.\s]+$/, '').toLowerCase() === title.replace(/[.\s]+$/, '').toLowerCase()) summary = ''; // el webhook suele repetir el titulo
    let link = '';
    try { const u = new URL(plain(chunk.match(/<a[^>]*href="([^"]+)"/i)?.[1] ?? '', 2000).replace(/ /g, '')); if (u.protocol === 'https:') link = u.toString(); } catch { /* sin enlace valido */ }
    items.push({ n: items.length + 1, title, source: cut >= 0 ? meta.slice(cut + 3) : '', date: cut >= 0 ? meta.slice(0, cut) : meta, summary, link });
  }
  return { intro, items };
}

/** Parrafos del cuerpo de una nota (pagina del medio): sin menus, pies, scripts ni lineas cortas de relleno. */
export function articleParagraphs(html: string): string[] {
  const body = html.slice(0, 3_000_000).replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|figure|button)[\s\S]*?<\/\1>/gi, ' ');
  const art = body.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? body;
  const out: string[] = []; let total = 0;
  for (const m of art.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const t = plain(m[1], 1500);
    // Fuera lo que no es la nota: firma con botones de compartir, formularios de "enviar a un amigo", avisos del sitio.
    if (t.length < 60 || out.includes(t) || /Facebook\s+X\s+Whats?app|^Por:\s.{0,80}\|\s*\d|Escribe a continuación al correo|Suscr[ií]bete a nuestro|Lea también:|Le puede interesar:/i.test(t)) continue;
    out.push(t); total += t.length;
    if (total > 14_000) break; // tope: una nota muy larga se lee hasta aqui
  }
  return out;
}
/** Tramos de lectura parejos de ~1 minuto y medio, cortados entre parrafos (una nota tipica queda en 3 a 6 tramos). */
export function readingParts(paragraphs: string[], size = 1500): string[] {
  const total = paragraphs.reduce((n, p) => n + p.length, 0), count = Math.max(1, Math.round(total / size)), target = total / count;
  const parts: string[] = []; let cur = '', read = 0;
  for (const p of paragraphs) {
    // Se corta donde el total leido queda mas cerca del limite de ese tramo (se mide sobre el acumulado, para que el
    // sobrante no se junte todo en un ultimo tramo diminuto).
    if (cur && parts.length < count - 1 && read + p.length / 2 > target * (parts.length + 1)) { parts.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + p; read += p.length;
  }
  if (cur) parts.push(cur);
  return parts;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const logoCache = new Map<string, { at: number; data: string }>();
/** Tipo de una imagen por sus primeros bytes (no se confia en lo que diga el servidor). */
function imageKind(b: Buffer): { mime: string; px: number } | undefined {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: 'image/png', px: b.readUInt32BE(16) };
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', px: 64 };
  if (b.length > 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return { mime: 'image/x-icon', px: 32 };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return { mime: 'image/jpeg', px: 64 };
  return undefined;
}
/**
 * Icono del medio de una noticia (el que el propio medio publica para su sitio), como `data:` para mostrarlo pequeño
 * junto al titular. Se buscan los que anuncia la portada y las rutas habituales; se prefiere uno de 64 px o mas que pese
 * poco. Vale una semana en memoria. '' si no se pudo (la noticia sale sin logo). Nunca lanza.
 */
export async function sourceLogo(link: string, maxMs = 6000): Promise<string> {
  let origin: string; try { const u = new URL(link); if (u.protocol !== 'https:') return ''; origin = u.origin; } catch { return ''; }
  const hit = logoCache.get(origin);
  if (hit && Date.now() - hit.at < 7 * 86400_000) return hit.data;
  const signal = AbortSignal.timeout(maxMs), get = (u: string) => fetch(u, { signal, headers: { 'User-Agent': UA } });
  let data = '';
  try {
    const home = await get(`${origin}/`).then((r) => (r.ok ? r.text() : ''), () => '');
    const announced = [...home.slice(0, 600_000).matchAll(/<link[^>]+rel=["'](?:apple-touch-icon[^"']*|icon|shortcut icon)["'][^>]*>/gi)].map((m) => m[0].match(/href=["']([^"']+)["']/)?.[1]).filter((h): h is string => !!h)
      .map((h) => { try { const u = new URL(h.replace(/&amp;/g, '&'), `${origin}/`); return u.protocol === 'https:' ? u.toString() : ''; } catch { return ''; } }).filter(Boolean);
    const urls = [...new Set([...announced.slice(0, 5), `${origin}/apple-touch-icon.png`, `${origin}/favicon.ico`])];
    const found = (await Promise.all(urls.map(async (u) => { try { const r = await get(u); if (!r.ok) return undefined; const b = Buffer.from(await r.arrayBuffer()), k = imageKind(b); return k && b.length >= 100 && b.length <= 60_000 ? { ...k, b } : undefined; } catch { return undefined; } }))).filter(<T>(x: T | undefined): x is T => !!x);
    // Primero los nitidos (64 px o mas), y entre ellos el mas liviano; si no hay, el mas grande que haya.
    const sharp = found.filter((f) => f.px >= 64).sort((a, b) => a.b.length - b.b.length)[0], best = sharp ?? found.sort((a, b) => b.px - a.px)[0];
    if (best) data = `data:${best.mime};base64,${best.b.toString('base64')}`;
  } catch { /* sin logo */ }
  if (data || !hit) logoCache.set(origin, { at: data ? Date.now() : Date.now() - 7 * 86400_000 + 3600_000, data }); // si fallo, se reintenta en una hora
  if (logoCache.size > 60) logoCache.delete(logoCache.keys().next().value!);
  return data;
}
/** Logos de los medios de una lista de noticias: {nombre del medio: imagen}. Espera como mucho `maxMs`; lo que no llegue queda para la proxima. */
export async function logosFor(items: { source: string; link: string }[], maxMs = 5000): Promise<Record<string, string>> {
  const out: Record<string, string> = {}, first = new Map<string, string>();
  for (const i of items) if (i.source && i.link && !first.has(i.source)) first.set(i.source, i.link);
  await Promise.race([Promise.all([...first].map(async ([source, link]) => { const d = await sourceLogo(link, maxMs); if (d) out[source] = d; })), new Promise((r) => setTimeout(r, maxMs + 300))]);
  return { ...out };
}

/**
 * Parrafos de una nota leidos de la pagina del medio. El enlace viene de un tercero: solo se abre si es https y de un
 * dominio de `domains`, tambien despues de las redirecciones. Lanza con el motivo si no se pudo leer.
 */
export async function fetchArticle(link: string, domains: string[]): Promise<string[]> {
  const allowed = (u: string) => { try { const x = new URL(u); return x.protocol === 'https:' && domains.some((d) => x.hostname === d || x.hostname.endsWith(`.${d}`)); } catch { return false; } };
  if (!allowed(link)) throw new Error('el medio de esa noticia no está en la lista de los que se pueden abrir');
  let res: Response;
  try { res = await fetch(link, { signal: AbortSignal.timeout(12_000), headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': 'es,en', Accept: 'text/html' } }); }
  catch (e) { throw new Error(`no se pudo abrir la nota (${(e as Error).name})`); }
  if (!res.ok) throw new Error(`el medio respondió ${res.status}`);
  if (!allowed(res.url || link)) throw new Error('la nota redirige a otro sitio');
  const paragraphs = articleParagraphs(await res.text());
  if (paragraphs.join(' ').length < 500) throw new Error('el medio no dejó leer el texto de la nota');
  return paragraphs;
}

@Injectable()
export class NewsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(NewsService.name);
  private stored?: Stored;
  private fetching?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private lastTry = 0;
  lastError = '';

  constructor(private readonly cfg: ConfigService, private readonly db: DbService, private readonly usage: UsageService) {}

  get enabled() { return !!this.cfg.newsUrl; }
  get items(): NewsItem[] { return this.stored?.items ?? []; }
  get intro() { return this.stored?.intro ?? ''; }
  /** Dia (AAAA-MM-DD, hora local) del que son las noticias guardadas. */
  get day() { return this.stored?.day ?? ''; }
  get loading() { return !!this.fetching; }

  private now() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: this.cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
  }

  async onModuleInit() {
    if (!this.enabled) return;
    try {
      const raw = (await this.db.query('SELECT value FROM meta WHERE key = $1', [META_KEY]))[0]?.value;
      if (raw) this.stored = JSON.parse(String(raw));
    } catch (e) { this.log.warn(`no se pudieron leer las noticias guardadas: ${(e as Error).message}`); }
    this.log.log(`noticias: ${this.items.length ? `${this.items.length} guardadas del ${this.day}` : 'aún no hay ninguna guardada'}`);
    this.tick();
    this.timer = setInterval(() => this.tick(), 10 * 60_000); this.timer.unref();
  }
  onModuleDestroy() { clearInterval(this.timer); }

  /** Una vez al dia, desde NOTICIAS_HORA. Si el webhook falla se reintenta, como mucho cada hora. */
  private tick() {
    const { day, hour } = this.now();
    if (this.day === day || (hour < this.cfg.newsHour && this.items.length)) return;
    if (Date.now() - this.lastTry < 3600_000) return;
    void this.refresh();
  }

  /** Pide las noticias al webhook y las guarda. Nunca lanza; si ya hay una peticion en curso, espera esa. */
  refresh(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.fetching ??= (async () => {
      this.lastTry = Date.now();
      try {
        this.usage.add('news_fetches');
        const res = await fetch(this.cfg.newsUrl, { signal: AbortSignal.timeout(150_000), headers: { Accept: 'text/html' } });
        if (!res.ok) throw new Error(`el webhook respondió ${res.status}`);
        const parsed = parseNews(await res.text());
        if (!parsed.items.length) throw new Error('la página no trajo noticias con el formato esperado');
        const items: NewsItem[] = [];
        for (const it of parsed.items) items.push({ ...it, qr: it.link ? await QRCode.toDataURL(it.link, { margin: 1, width: 360, errorCorrectionLevel: 'L' }).catch(() => '') : '' });
        this.stored = { day: this.now().day, at: new Date().toISOString(), intro: parsed.intro, items, logos: await logosFor(items) };
        await this.db.query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [META_KEY, JSON.stringify(this.stored)]);
        this.lastError = '';
        this.log.log(`noticias: ${items.length} guardadas para hoy`);
      } catch (e) { this.lastError = (e as Error).name === 'TimeoutError' ? 'el webhook tardó demasiado' : (e as Error).message; this.log.warn(`noticias: no se pudieron traer (${this.lastError})`); }
      finally { this.fetching = undefined; }
    })();
    return this.fetching;
  }

  private readonly articles = new Map<string, { at: number; parts: string[] }>();
  /**
   * Texto completo de una noticia, en tramos, leido de la pagina del medio (pedido por Javier el 2026-11-20: leerla
   * entera, por partes, solo en modo dueño). El enlace viene de un tercero: solo se abre si es https y de un medio de la
   * lista `NOTICIAS_DOMINIOS`, tambien despues de las redirecciones. Lanza con el motivo si no se pudo leer.
   */
  async article(n: number): Promise<string[]> {
    const it = this.items[n - 1];
    if (!it?.link) throw new Error('esa noticia no trae enlace');
    const hit = this.articles.get(it.link);
    if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.parts;
    this.usage.add('news_articles');
    const parts = readingParts(await fetchArticle(it.link, this.cfg.newsDomains));
    this.articles.set(it.link, { at: Date.now(), parts });
    if (this.articles.size > 40) this.articles.delete(this.articles.keys().next().value!);
    return parts;
  }
  /** Nombre de esta seccion de noticias (para la pantalla y para lo que dice el avatar). */
  readonly label = 'inteligencia artificial';
  /** Las de IA se traen solas una vez al dia: no hay nada que esperar al pedirlas. */
  async ensureFresh(): Promise<void> { /* nada */ }

  /** Lo que el navegador dibuja: la lista numerada o, con `open`, esa noticia en grande con su codigo QR. */
  panel(open?: number): Record<string, unknown> {
    const it = open ? this.items[open - 1] : undefined;
    return { action: it ? 'open' : 'list', title: 'Noticias de inteligencia artificial', day: this.day, items: this.items, index: it ? it.n : 0, logos: this.stored?.logos ?? {} };
  }
}
