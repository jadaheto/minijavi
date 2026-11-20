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
interface Stored { day: string; at: string; intro: string; items: NewsItem[]; }

const META_KEY = 'news_cache';
const MAX_ITEMS = 8;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', iquest: '¿', iexcl: '¡', ntilde: 'ñ', Ntilde: 'Ñ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', uuml: 'ü', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–' };
/** Texto plano de un trozo de HTML: sin etiquetas, con las entidades resueltas y recortado. */
const plain = (html: string, max: number) => html.replace(/<[^>]*>/g, ' ')
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
        this.stored = { day: this.now().day, at: new Date().toISOString(), intro: parsed.intro, items };
        await this.db.query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [META_KEY, JSON.stringify(this.stored)]);
        this.lastError = '';
        this.log.log(`noticias: ${items.length} guardadas para hoy`);
      } catch (e) { this.lastError = (e as Error).name === 'TimeoutError' ? 'el webhook tardó demasiado' : (e as Error).message; this.log.warn(`noticias: no se pudieron traer (${this.lastError})`); }
      finally { this.fetching = undefined; }
    })();
    return this.fetching;
  }

  /** Lo que el navegador dibuja: la lista numerada o, con `open`, esa noticia en grande con su codigo QR. */
  panel(open?: number): Record<string, unknown> {
    const it = open ? this.items[open - 1] : undefined;
    return { action: it ? 'open' : 'list', day: this.day, items: this.items, index: it ? it.n : 0 };
  }
}
