import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { UsageService } from '../usage/usage.service';
import { NoticeInput, onNotice } from './bus';

export interface Notice { id: number; at: string; source: string; title: string; body: string; word: string; tone: string; untrusted: boolean; ref?: { kind: string; id: string }; }

const clip = (s: unknown, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const SOURCE_WORD: Record<string, string> = { interesados: 'Nuevo', aprobaciones: 'Aprobar', avatares: 'Pago', taller: 'Listo', servicios: 'Falla', correo: 'Correo', calendario: 'Cita' };

/**
 * Centro de avisos del dueño. Guarda lo que emiten las fuentes y lo entrega a los dispositivos de Javier que lo piden
 * (hoy, el Javi de bolsillo). Reglas:
 *  - En el horario silencioso (`AVISOS_SILENCIO`, por defecto de 21 a 7) no se entrega nada: queda guardado y sale al terminar.
 *  - El detalle escrito por terceros se guarda marcado (`untrusted`) y se recorta: es un dato para mostrar, no una orden.
 *  - Solo los entrega a quien presenta un pase de dispositivo del dueño (lo comprueba quien llama: el controlador).
 */
@Injectable()
export class NoticesService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(NoticesService.name);
  private off?: () => void;
  private waiters = new Set<() => void>();
  /** Para las pruebas: la hora "de ahora". */
  now: () => Date = () => new Date();

  constructor(private readonly cfg: ConfigService, private readonly db: DbService, private readonly usage: UsageService) {}

  get enabled() { return this.cfg.noticesEnabled; }

  onModuleInit() {
    if (!this.enabled) return;
    this.off = onNotice((n) => { void this.push(n).catch((e) => this.log.warn(`no se pudo guardar un aviso: ${(e as Error).message}`)); });
  }
  onModuleDestroy() { this.off?.(); for (const w of this.waiters) w(); }

  /** Guarda un aviso y despierta a quien esté esperando. */
  async push(n: NoticeInput): Promise<number | undefined> {
    if (!this.enabled || !n?.title) return undefined;
    const source = clip(n.source, 24).toLowerCase() || 'aviso';
    const [row] = await this.db.query<{ id: number }>(
      'INSERT INTO notices (business, at, source, title, body, word, tone, untrusted, ref_kind, ref_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
      [this.cfg.businessId, this.now().toISOString(), source, clip(n.title, 40), clip(n.body, 120), clip(n.word || SOURCE_WORD[source] || 'Aviso', 9), ['ok', 'warn', 'bad', 'info'].includes(n.tone ?? '') ? n.tone! : 'info', n.untrusted ? 1 : 0, n.ref ? clip(n.ref.kind, 24) : '', n.ref ? clip(n.ref.id, 40) : ''],
    );
    this.usage.add('avisos');
    void this.db.query('DELETE FROM notices WHERE business = $1 AND id < $2', [this.cfg.businessId, Number(row.id) - 300]).catch(() => undefined); // se conservan los últimos 300
    for (const w of [...this.waiters]) w();
    return Number(row.id);
  }

  /** Estamos en el horario silencioso (hora del negocio). */
  quiet(at = this.now()): boolean {
    const [from, to] = this.cfg.noticesQuiet; if (from === to) return false;
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: this.cfg.timezone, hour: '2-digit', hourCycle: 'h23' }).format(at));
    return from < to ? h >= from && h < to : h >= from || h < to;
  }

  private row(r: any): Notice {
    return { id: Number(r.id), at: String(r.at), source: r.source, title: r.title, body: r.body, word: r.word, tone: r.tone, untrusted: !!Number(r.untrusted), ...(r.ref_kind ? { ref: { kind: r.ref_kind, id: String(r.ref_id) } } : {}) };
  }

  /** Avisos sin ver posteriores a `after`. En horario silencioso, ninguno. */
  async pending(after = 0, limit = 6): Promise<Notice[]> {
    if (!this.enabled || this.quiet()) return [];
    const rows = await this.db.query('SELECT * FROM notices WHERE business = $1 AND id > $2 AND seen_at IS NULL ORDER BY id LIMIT 12', [this.cfg.businessId, Math.max(0, Math.floor(after) || 0)]);
    return rows.slice(0, limit).map((r) => this.row(r));
  }

  /** Igual que `pending`, pero si no hay nada espera hasta `waitMs` a que llegue algo (para que el aviso salga al instante). */
  async wait(after: number, waitMs: number, signal?: AbortSignal): Promise<Notice[]> {
    const first = await this.pending(after);
    if (first.length || waitMs <= 0 || this.quiet() || signal?.aborted) return first;
    await new Promise<void>((done) => {
      const end = () => { clearTimeout(t); this.waiters.delete(end); signal?.removeEventListener('abort', end); done(); };
      const t = setTimeout(end, Math.min(waitMs, 30_000));
      this.waiters.add(end); signal?.addEventListener('abort', end, { once: true });
    });
    return signal?.aborted ? [] : this.pending(after);
  }

  async get(id: number): Promise<Notice | undefined> {
    const [r] = await this.db.query('SELECT * FROM notices WHERE business = $1 AND id = $2', [this.cfg.businessId, Math.floor(id) || 0]);
    return r ? this.row(r) : undefined;
  }

  /** Javier ya los vio (los quitó de la pantalla o se los contó el avatar). */
  async seen(ids: number[]): Promise<void> {
    for (const id of ids.filter((x) => Number.isInteger(x) && x > 0).slice(0, 30)) await this.db.query('UPDATE notices SET seen_at = $1 WHERE business = $2 AND id = $3 AND seen_at IS NULL', [this.now().toISOString(), this.cfg.businessId, id]);
  }

  async recent(limit = 30): Promise<(Notice & { seenAt: string | null })[]> {
    const rows = await this.db.query('SELECT * FROM notices WHERE business = $1 ORDER BY id DESC LIMIT $2', [this.cfg.businessId, Math.min(100, limit)]);
    return rows.map((r: any) => ({ ...this.row(r), seenAt: r.seen_at ? String(r.seen_at) : null }));
  }
}
