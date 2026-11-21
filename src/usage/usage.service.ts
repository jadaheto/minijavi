import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';

/** Lo que se mide. La unidad va en el nombre: _s segundos, _in/_out/_cache tokens, _chars caracteres, _usd dolares. */
export const USAGE_KEYS = [
  'sesiones', 'sesiones_dueno', 'demos',
  'deepgram_s', 'deepgram_susp_s', 'deepgram_pre_s',
  'deepseek_calls', 'deepseek_in', 'deepseek_cache', 'deepseek_out', 'deepseek_sin_dato',
  'eleven_calls', 'eleven_chars',
  'jev_calls', 'jev_in', 'capaz_calls', 'capaz_in', 'capaz_out', 'decisiones', 'decisiones_defecto',
  'nvidia_calls', 'demo_docs', 'resumen_enviado', 'youtube_searches', 'spotify_searches', 'tesla_calls', 'news_fetches', 'news_articles', 'polymarket_calls', 'maps_calls', 'charger_searches', 'wa_in', 'wa_out', 'image_searches', 'image_generations', 'image_openai', 'image_magnific',
  'claude_jobs', 'claude_s', 'claude_turns', 'claude_usd', 'respaldo_jobs', 'respaldo_calls', 'respaldo_in', 'respaldo_out',
] as const;
export type UsageKey = (typeof USAGE_KEYS)[number];
export type UsageDay = { day: string } & Partial<Record<UsageKey, number>> & { estimado_usd?: number };

/**
 * Consumo por dia de cada proveedor (pedido por Javier el 2026-11-18: saber adonde se va el gasto antes de optimizar).
 * Se acumula en memoria y se guarda cada 20 s en la tabla `uso`; asi contar cada trama de audio no escribe en la base.
 * Son medidas propias, no la factura: sirven para comparar dias y ver que pesa mas.
 */
@Injectable()
export class UsageService implements OnModuleDestroy {
  private readonly log = new Logger(UsageService.name);
  private readonly pending = new Map<string, number>();
  private readonly timer: NodeJS.Timeout;
  private readonly dayFmt: Intl.DateTimeFormat;

  constructor(private readonly cfg: ConfigService, private readonly db: DbService) {
    this.dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone });
    this.timer = setInterval(() => void this.flush(), 20_000);
    this.timer.unref();
  }
  async onModuleDestroy() { clearInterval(this.timer); await this.flush(); }

  add(key: UsageKey, n = 1) {
    if (!Number.isFinite(n) || n <= 0) return;
    const k = `${this.dayFmt.format(new Date())}|${key}`;
    this.pending.set(k, (this.pending.get(k) ?? 0) + n);
  }

  async flush() {
    if (!this.pending.size) return;
    const batch = [...this.pending]; this.pending.clear();
    for (const [k, v] of batch) {
      const [day, key] = k.split('|');
      try { await this.db.query('INSERT INTO uso (day, key, value) VALUES ($1, $2, $3) ON CONFLICT (day, key) DO UPDATE SET value = uso.value + excluded.value', [day, key, v]); }
      catch (e) { this.pending.set(k, (this.pending.get(k) ?? 0) + v); this.log.warn(`no se pudo guardar el consumo: ${(e as Error).message}`); return; } // se reintenta en el siguiente volcado
    }
  }

  /** Ultimos `days` dias con datos, del mas reciente al mas antiguo. */
  async days(days = 14): Promise<UsageDay[]> {
    await this.flush();
    const since = this.dayFmt.format(new Date(Date.now() - (Math.min(90, Math.max(1, days)) - 1) * 86_400_000));
    const rows = await this.db.query<{ day: string; key: UsageKey; value: number }>('SELECT day, key, value FROM uso WHERE day >= $1 ORDER BY day DESC', [since]);
    const out = new Map<string, UsageDay>();
    for (const r of rows) { const d = out.get(r.day) ?? { day: r.day }; d[r.key] = Math.round(Number(r.value) * 100) / 100; out.set(r.day, d); }
    const prices = this.cfg.usagePrices;
    for (const d of out.values()) {
      let usd = 0, any = false;
      for (const [key, price] of Object.entries(prices)) { const v = d[key as UsageKey]; if (v) { usd += v * price; any = true; } }
      if (any) d.estimado_usd = Math.round(usd * 1000) / 1000;
    }
    return [...out.values()];
  }

  /** Un dia contado en una frase, para que el avatar lo diga. */
  describe(d: UsageDay): string {
    const n = (v?: number) => Math.round(v ?? 0).toLocaleString('es-CO'), min = (v?: number) => ((v ?? 0) < 90 ? `${Math.round(v ?? 0)} segundos` : `${Math.round((v ?? 0) / 60)} min`);
    const parts = [`${d.day}: ${n(d.sesiones)} conversaciones`];
    if (d.deepgram_s) parts.push(`escucha (Deepgram) ${min(d.deepgram_s)}${d.deepgram_susp_s ? `, de ellos ${min(d.deepgram_susp_s)} suspendido` : ''}`);
    if (d.deepseek_calls || d.deepseek_sin_dato) {
      const cache = d.deepseek_in ? Math.round(((d.deepseek_cache ?? 0) / d.deepseek_in) * 100) : 0;
      parts.push(`modelo (DeepSeek) ${n((d.deepseek_calls ?? 0) + (d.deepseek_sin_dato ?? 0))} llamadas, ${n(d.deepseek_in)} tokens leídos (${cache} % en caché) y ${n(d.deepseek_out)} escritos` +
        (d.deepseek_sin_dato ? `; ${n(d.deepseek_sin_dato)} llamadas se cortaron sin dato de tokens` : ''));
    }
    if (d.jev_calls) parts.push(`decisiones con Jev ${n(d.jev_calls)} (${n(d.jev_in)} tokens)`);
    if (d.capaz_calls) parts.push(`modelo capaz ${n(d.capaz_calls)} llamadas (${n(d.capaz_in)} tokens leídos, ${n(d.capaz_out)} escritos)`);
    if (d.eleven_chars) parts.push(`voz (ElevenLabs) ${n(d.eleven_chars)} caracteres`);
    if (d.nvidia_calls) parts.push(`búsquedas en la base de conocimiento ${n(d.nvidia_calls)}`);
    if (d.wa_out) parts.push(`mensajes de WhatsApp respondidos ${n(d.wa_out)}`);
    if (d.tesla_calls) parts.push(`consultas al Tesla ${n(d.tesla_calls)}`);
    if (d.spotify_searches) parts.push(`búsquedas de Spotify ${n(d.spotify_searches)}`);
    if (d.youtube_searches) parts.push(`búsquedas de YouTube ${n(d.youtube_searches)}`);
    if (d.image_searches) parts.push(`búsquedas de fotos ${n(d.image_searches)}`);
    if (d.image_generations) parts.push(`imágenes generadas ${n(d.image_generations)}`);
    if (d.claude_jobs) parts.push(`Claude Code ${n(d.claude_jobs)} encargos, ${min(d.claude_s)}${d.claude_usd ? `, equivalente a ${d.claude_usd.toFixed(2)} dólares de API (va por la suscripción)` : ''}`);
    if (d.estimado_usd !== undefined) parts.push(`costo estimado con tus precios ${d.estimado_usd.toFixed(2)} dólares`);
    return parts.join('; ') + '.';
  }
}
