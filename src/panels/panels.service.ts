import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { UsageDay, UsageService } from '../usage/usage.service';
import { AlertsService } from '../ops/alerts.service';
import { SpotifyService } from '../music/spotify.service';
import { TeslaService } from '../tesla/tesla.service';
import { NewsService } from '../news/news.service';

/**
 * Datos para los paneles animados que Javier pidio el 2026-11-20 (primera entrega): dolar y Bitcoin con grafica, estado
 * de los servicios y consumo. Aqui solo se juntan y se ordenan los datos; el navegador los dibuja.
 *  - TRM: datos.gov.co, conjunto 32sa-8pi3 (el mismo de `precio_dolar`), ultimas filas por `vigenciadesde`.
 *  - Bitcoin: CoinGecko `GET /api/v3/simple/price` y `/coins/bitcoin/market_chart?vs_currency=usd&days=7` (documentacion
 *    leida el 2026-11-20; respondio sin clave en la prueba, pero su documentacion no garantiza el acceso sin clave ni da
 *    limites: por eso hay cache y, si falla, se muestra lo que si haya). `cop` no existe en la grafica: va en dolares.
 *  - Servicios: lo que ya vigila OpsService (AlertsService.status) mas el estado de las conexiones (Spotify, Tesla, noticias).
 *  - Consumo: UsageService.days. Costo en dolares SOLO si Javier configuro USAGE_PRICES (no hay precios en el codigo).
 */
export interface Series { id: string; name: string; value: number; unit: string; extra?: string; change?: number; changeLabel?: string; points: { t: string; v: number }[]; source: string; }
export interface ServiceRow { name: string; ok: boolean | null; detail: string; since?: string; }
const getJson = async (url: string, ms = 7000): Promise<any> => { const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { Accept: 'application/json', 'User-Agent': 'minijavi/1.0' } }); if (!r.ok) throw new Error(`respondió ${r.status}`); return r.json(); };
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

@Injectable()
export class PanelsService {
  private readonly log = new Logger(PanelsService.name);
  private trm?: { at: number; data: Series };
  private btc?: { at: number; data: Series };

  constructor(private readonly cfg: ConfigService, private readonly usage: UsageService, private readonly alerts: AlertsService,
    @Optional() private readonly spotify?: SpotifyService, @Optional() private readonly tesla?: TeslaService, @Optional() private readonly news?: NewsService) {}

  /** TRM de hoy con sus ultimos ~30 valores distintos (la TRM no cambia en fines de semana ni festivos). */
  private async dollar(): Promise<Series> {
    if (this.trm && Date.now() - this.trm.at < 30 * 60_000) return this.trm.data;
    const rows: any[] = await getJson('https://www.datos.gov.co/resource/32sa-8pi3.json?$order=vigenciadesde%20DESC&$limit=45');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: this.cfg.timezone }).format(new Date());
    const seen = new Set<string>(), points: { t: string; v: number }[] = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const t = String(r?.vigenciadesde ?? '').slice(0, 10), v = Number(r?.valor);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || !(v > 0) || seen.has(t) || t > today) continue; // una fila futura (vigencia desde mañana) no es la de hoy
      seen.add(t); points.push({ t, v: round(v) });
    }
    points.reverse();
    if (points.length < 2) throw new Error('la fuente no devolvió datos de la TRM');
    const now = points.at(-1)!.v, prev = points.at(-2)!.v, first = points.slice(-30)[0].v;
    const data: Series = { id: 'trm', name: 'Dólar (TRM)', value: now, unit: 'COP', change: round(now - prev), changeLabel: 'frente al valor anterior', extra: `${round(((now - first) / first) * 100, 1)} % en ${Math.min(30, points.length)} valores`, points: points.slice(-30), source: 'datos.gov.co' };
    this.trm = { at: Date.now(), data };
    return data;
  }

  /** Bitcoin: precio en dolares y pesos, cambio de 24 h y los ultimos 7 dias (en dolares). */
  private async bitcoin(): Promise<Series> {
    if (this.btc && Date.now() - this.btc.at < 5 * 60_000) return this.btc.data;
    const api = 'https://api.coingecko.com/api/v3';
    const [price, chart] = await Promise.all([getJson(`${api}/simple/price?ids=bitcoin&vs_currencies=usd,cop&include_24hr_change=true`), getJson(`${api}/coins/bitcoin/market_chart?vs_currency=usd&days=7`).catch(() => null)]);
    const usd = Number(price?.bitcoin?.usd), cop = Number(price?.bitcoin?.cop), ch = Number(price?.bitcoin?.usd_24h_change);
    if (!(usd > 0)) throw new Error('la fuente no devolvió el precio de Bitcoin');
    const raw: [number, number][] = Array.isArray(chart?.prices) ? chart.prices.filter((p: any) => Array.isArray(p) && p[1] > 0) : [];
    const stepSize = Math.max(1, Math.floor(raw.length / 56)); // ~56 puntos: una linea suave sin mandar cientos al navegador
    const points = raw.filter((_, i) => i % stepSize === 0 || i === raw.length - 1).map(([t, v]) => ({ t: new Date(t).toISOString(), v: Math.round(v) }));
    const data: Series = { id: 'btc', name: 'Bitcoin', value: Math.round(usd), unit: 'USD', change: Number.isFinite(ch) ? round(ch, 1) : undefined, changeLabel: '% en 24 h', extra: cop > 0 ? `${Math.round(cop / 1e6).toLocaleString('es-CO')} millones de pesos` : undefined, points, source: 'CoinGecko' };
    this.btc = { at: Date.now(), data };
    return data;
  }

  async finance(what: 'dolar' | 'bitcoin' | 'ambos'): Promise<{ items: Series[]; errors: string[] }> {
    const jobs: [string, Promise<Series>][] = [];
    if (what !== 'bitcoin') jobs.push(['el dólar', this.dollar()]);
    if (what !== 'dolar') jobs.push(['Bitcoin', this.bitcoin()]);
    const done = await Promise.allSettled(jobs.map(([, p]) => p)), items: Series[] = [], errors: string[] = [];
    done.forEach((d, i) => { if (d.status === 'fulfilled') items.push(d.value); else { const why = (d.reason as Error).name === 'TimeoutError' ? 'la fuente tardó demasiado' : (d.reason as Error).message; errors.push(`${jobs[i][0]}: ${why}`); this.log.warn(`panel de finanzas, ${jobs[i][0]}: ${why}`); } });
    return { items, errors };
  }

  /** Semaforo: lo que vigila el servidor cada pocos minutos y el estado de las conexiones de cuentas. */
  status(): { rows: ServiceRow[]; bad: number; checked: boolean } {
    const watched = Object.entries(this.alerts.status()).map(([name, s]) => ({ name: name.replace(/^(El|La) /, '').replace(/^./, (c) => c.toUpperCase()), ok: s.ok, detail: s.detail, since: s.since }));
    const rows: ServiceRow[] = [...watched];
    // Una cuenta sin conectar no es una falla (queda "sin dato"); si se desconecto sola (vencio o fue revocada), si lo es.
    const account = (name: string, a: { connected: boolean; status: { error?: string } }): ServiceRow => ({ name, ok: a.connected ? true : a.status.error ? false : null, detail: a.connected ? 'cuenta conectada' : a.status.error || 'sin conectar (se conecta en el panel)' });
    if (this.spotify?.configured) rows.push(account('Spotify', this.spotify));
    if (this.tesla?.configured) rows.push(account('Tesla', this.tesla));
    if (this.news?.enabled) rows.push({ name: 'Noticias', ok: this.news.items.length ? true : this.news.lastError ? false : null, detail: this.news.items.length ? `${this.news.items.length} del ${this.news.day}` : this.news.lastError || 'aún no se han traído' });
    return { rows, bad: rows.filter((r) => r.ok === false).length, checked: watched.length > 0 };
  }

  /** Consumo de los ultimos dias, del mas antiguo al mas reciente, en las medidas que mas pesan. */
  async consumption(days: number): Promise<{ days: { day: string; sesiones: number; escucha_min: number; tokens: number; voz: number; usd?: number }[]; priced: boolean }> {
    const rows = await this.usage.days(days), n = (v?: number) => Number(v) || 0;
    const out = rows.map((d: UsageDay) => ({ day: d.day, sesiones: n(d.sesiones), escucha_min: Math.round((n(d.deepgram_s) + n(d.deepgram_pre_s)) / 60), tokens: n(d.deepseek_in) + n(d.deepseek_out), voz: n(d.eleven_chars), usd: d.estimado_usd })).reverse();
    return { days: out, priced: Object.keys(this.cfg.usagePrices).length > 0 };
  }
}
