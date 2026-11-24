import { emitNotice } from '../notices/bus';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { TelegramService } from '../ops/telegram.service';
import { ACTION_KINDS, ActionKind, ActionRequest, ActionResult, ActionsService } from './actions.service';
import { PolicyService } from './policy.service';

export interface Approval {
  id: number; created_at: string; kind: string; contact: string; lead_id: number | null; trigger: string; content: string; why: string; cost_usd: number; consent: number;
  payload: string; status: 'pendiente' | 'en_espera' | 'aprobada' | 'rechazada'; decided_at: string; retry_at: string; decided_by: string; result: string; nonce: string; tg_message: number | null;
}
/** Lo que ejecuta una accion aprobada, a partir de lo que se guardo al pedirla. Devuelve '' o el motivo del fallo. */
type Executor = (payload: any) => Promise<string>;

/**
 * Bandeja de aprobaciones (etapa 2b, pedida por Javier el 2026-11-18). Lo que el avatar no puede hacer solo (primer
 * contacto sin autorizacion verificada, ofertas, y lo que la politica marque) se queda aqui hasta que Javier diga si o no,
 * en el panel o con los botones de Telegram. Cada solicitud muestra que se hara, a quien, por que y el texto exacto.
 *  - No vencen: quedan pendientes y una vez al dia se le recuerda a Javier cuantas hay.
 *  - Aprobar NO es saltarse los limites: al ejecutar se vuelve a pasar por la puerta de acciones (no contactar, numeros de
 *    prueba, horario, topes, gasto, simulacion). Lo unico que la aprobacion resuelve es el permiso de Javier.
 *  - Si se aprueba cuando no puede salir por algo pasajero (es de noche, se lleno el tope de hoy), queda 'en_espera' y
 *    sale sola cuando se pueda; Javier puede cancelarla mientras tanto.
 *  - Una solicitud se decide una sola vez (dos toques, o panel y Telegram a la vez, no la ejecutan dos veces).
 * `submit()` es la entrada para quien quiera actuar por iniciativa propia: pasa por la puerta y, si hace falta permiso,
 * deja la solicitud en la bandeja.
 */
@Injectable()
export class ApprovalsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ApprovalsService.name);
  private readonly executors = new Map<string, Executor>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly cfg: ConfigService, private readonly db: DbService, private readonly actions: ActionsService, private readonly policy: PolicyService, private readonly telegram: TelegramService) {
    telegram.onPress((p) => this.onPress(p));
    policy.defineHour('recordatorio_hora', 'Hora del recordatorio de aprobaciones pendientes', 9);
  }
  onModuleInit() { this.timer = setInterval(() => { void this.remind().catch(() => undefined); void this.flush().catch(() => undefined); }, 60_000); this.timer.unref(); }
  onModuleDestroy() { clearInterval(this.timer); }

  /** Cada tipo de accion registra como se ejecuta una vez aprobada. */
  register(kind: ActionKind, run: Executor) { this.executors.set(kind, run); }

  /** Intenta la accion ya; si necesita el permiso de Javier, la deja en la bandeja y le avisa. */
  async submit(req: ActionRequest, payload: unknown): Promise<ActionResult> {
    const run = this.executors.get(req.kind);
    if (!run) return { status: 'bloqueada', reason: 'ese tipo de acción no tiene cómo ejecutarse', id: null };
    const r = await this.actions.run(req, () => run(payload));
    if (r.status === 'requiere_aprobacion') await this.enqueue(req, payload, r.reason).catch((e) => this.log.error(`no se pudo dejar la solicitud en la bandeja: ${(e as Error).message}`));
    return r;
  }

  private async enqueue(req: ActionRequest, payload: unknown, why: string) {
    const contact = this.actions.contactKey(req.contact);
    // La misma accion para la misma persona no se pide dos veces mientras siga pendiente.
    if ((await this.db.query(`SELECT id FROM approvals WHERE business = $1 AND status = 'pendiente' AND kind = $2 AND contact = $3`, [this.cfg.businessId, req.kind, contact])).length) return;
    const nonce = randomBytes(6).toString('hex');
    const [row] = await this.db.query<Approval>('INSERT INTO approvals (business, created_at, kind, contact, lead_id, trigger, content, why, cost_usd, consent, payload, nonce) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *',
      [this.cfg.businessId, new Date().toISOString(), req.kind, contact, req.leadId ?? null, clip(req.trigger, 120), clip(req.content, 2000), clip(why, 300), Number(req.costUsd ?? 0), req.consent ? 1 : 0, JSON.stringify(payload ?? {}), nonce]);
    const msg = await this.telegram.send(this.describe(row), [{ text: '✅ Aprobar', data: `ap:${row.id}:${nonce}` }, { text: '✖️ Rechazar', data: `re:${row.id}:${nonce}` }]);
    if (msg) await this.db.query('UPDATE approvals SET tg_message = $1 WHERE id = $2', [msg, row.id]);
    emitNotice({ source: 'aprobaciones', title: 'Por aprobar', body: (ACTION_KINDS as Record<string, { label: string }>)[req.kind]?.label ?? req.kind, tone: 'warn', ref: { kind: 'aprobacion', id: row.id } });
    this.log.log(`aprobación #${row.id} pendiente (${req.kind})`);
  }

  /** Que se hara, a quien, por que y el texto exacto. */
  describe(a: Approval): string {
    const who = a.contact.includes('@') ? a.contact : '+' + a.contact;
    return [`🟡 Necesito tu aprobación (#${a.id})`, `Qué: ${(ACTION_KINDS as Record<string, { label: string }>)[a.kind]?.label ?? a.kind}`, `A quién: ${who}${a.lead_id ? ` (interesado #${a.lead_id})` : ''}`,
      `Por qué: ${a.trigger}${a.why ? ` — ${a.why}` : ''}`, `Texto exacto: ${a.content}`, Number(a.cost_usd) ? `Costo estimado: ${Number(a.cost_usd).toFixed(4)} USD` : '',
      this.policy.simulation ? 'Estás en modo simulación: aunque apruebes, no saldrá nada de verdad.' : ''].filter(Boolean).join('\n');
  }

  /**
   * Decide una solicitud. Devuelve el texto de lo que paso. Solo la primera decision cuenta: el cambio de estado se hace
   * con una sola instruccion que exige que siga pendiente.
   */
  async decide(id: number, approve: boolean, by: 'panel' | 'telegram' | 'placa'): Promise<{ ok: boolean; text: string }> {
    // Aprobar: solo lo pendiente. Rechazar: lo pendiente, o cancelar algo ya aprobado que sigue esperando su momento.
    const [a] = await this.db.query<Approval>(`UPDATE approvals SET status = $1, decided_at = $2, decided_by = $3 WHERE id = $4 AND business = $5 AND (status = 'pendiente'${approve ? '' : ` OR status = 'en_espera'`}) RETURNING *`,
      [approve ? 'aprobada' : 'rechazada', new Date().toISOString(), by, id, this.cfg.businessId]);
    if (!a) { const [old] = await this.db.query<Approval>('SELECT * FROM approvals WHERE id = $1 AND business = $2', [id, this.cfg.businessId]); return { ok: false, text: old ? `Esa solicitud ya estaba ${old.status === 'en_espera' ? 'aprobada y esperando su momento' : old.status}${old.result ? `: ${old.result}` : ''}.` : 'Esa solicitud no existe.' }; }
    let text: string;
    if (!approve) { await this.actions.rejected(this.request(a), by); text = 'Rechazada: no se hizo nada.'; }
    else text = await this.execute(a);
    await this.db.query('UPDATE approvals SET result = $1 WHERE id = $2', [text, a.id]);
    if (by !== 'telegram' && a.tg_message) void this.telegram.edit(Number(a.tg_message), `${this.describe(a)}\n\n${approve ? '✅' : '✖️'} ${text} (desde ${by === 'placa' ? 'el Javi de bolsillo' : 'el panel'})`); // que el mensaje no quede con botones vivos
    this.log.log(`aprobación #${a.id}: ${text}`);
    return { ok: true, text };
  }

  private request(a: Approval): ActionRequest {
    return { kind: a.kind as ActionKind, contact: a.contact, leadId: a.lead_id ?? undefined, consent: Number(a.consent) > 0, trigger: `${a.trigger} (aprobación #${a.id})`, content: a.content, costUsd: Number(a.cost_usd) };
  }

  /**
   * Ejecuta algo ya aprobado. Pasa otra vez por la puerta: pudo cambiar algo desde que se pidio (la persona pidio no ser
   * contactada, es de noche, se lleno un tope...). Si lo que lo frena es pasajero, queda en espera y `flush()` lo reintenta.
   */
  private async execute(a: Approval): Promise<string> {
    const run = this.executors.get(a.kind);
    let payload: unknown = {}; try { payload = JSON.parse(a.payload || '{}'); } catch { /* se guardo mal: se ejecuta sin datos y fallara con su motivo */ }
    const r: ActionResult = run ? await this.actions.run({ ...this.request(a), approved: true }, () => run(payload)) : { status: 'bloqueada', reason: 'ese tipo de acción ya no tiene cómo ejecutarse', id: null };
    if (r.status === 'bloqueada' && r.temporary) {
      await this.db.query(`UPDATE approvals SET status = 'en_espera', retry_at = $1 WHERE id = $2`, [new Date(this.actions.now().getTime() + RETRY_MS).toISOString(), a.id]);
      return `Aprobada. Ahora no puede salir (${r.reason}); sale sola en cuanto se pueda.`;
    }
    await this.db.query(`UPDATE approvals SET status = 'aprobada', retry_at = '' WHERE id = $1`, [a.id]);
    return r.status === 'enviada' ? 'Aprobada y enviada.' : r.status === 'simulada' ? 'Aprobada. Modo simulación: no se envió nada, quedó en la bitácora.' : r.status === 'fallo' ? `Aprobada, pero el envío falló: ${r.reason}` : `Aprobada, pero no salió: ${r.reason}`;
  }

  /** Reintenta lo aprobado que estaba esperando su momento. Fuera de horario ni lo intenta (no llena la bitacora de intentos). */
  async flush(): Promise<number> {
    const now = this.actions.now();
    if (this.policy.paused || this.policy.outsideHours(now)) return 0;
    const due = await this.db.query<Approval>(`SELECT * FROM approvals WHERE business = $1 AND status = 'en_espera' AND retry_at <= $2 ORDER BY id LIMIT 20`, [this.cfg.businessId, now.toISOString()]);
    let done = 0;
    for (const a of due) {
      const text = await this.execute(a);
      if (text.startsWith('Aprobada. Ahora no puede salir')) continue; // sigue esperando
      const final = text.replace(/^Aprobada y enviada\.$/, 'Enviada (estaba aprobada y esperando su momento).');
      await this.db.query('UPDATE approvals SET result = $1 WHERE id = $2', [final, a.id]);
      void this.telegram.send(`${final.startsWith('Enviada') || final.includes('simulación') ? '✅' : '⚠️'} Aprobación #${a.id} (${(ACTION_KINDS as Record<string, { label: string }>)[a.kind]?.label ?? a.kind} → ${a.contact.includes('@') ? a.contact : '+' + a.contact}): ${final}`);
      done++;
    }
    return done;
  }

  /** Un boton pulsado en Telegram: "ap:<id>:<clave>" o "re:<id>:<clave>". La clave es la que se genero al pedir la aprobacion. */
  private async onPress(p: { data: string; answer(t: string): Promise<void>; edit(t: string): Promise<void> }) {
    const m = /^(ap|re):(\d+):([a-f0-9]{12})$/.exec(p.data);
    if (!m) { await p.answer('Botón no reconocido.'); return; }
    const [a] = await this.db.query<Approval>('SELECT * FROM approvals WHERE id = $1 AND business = $2', [Number(m[2]), this.cfg.businessId]);
    if (!a || a.nonce !== m[3]) { await p.answer('Esa solicitud no existe.'); return; }
    const r = await this.decide(a.id, m[1] === 'ap', 'telegram');
    await p.answer(r.text);
    if (r.ok) await p.edit(`${this.describe(a)}\n\n${m[1] === 'ap' ? '✅' : '✖️'} ${r.text}`);
  }

  /** Aprobadas que esperan su momento (horario, tope del dia). */
  /** Lo minimo para mostrar una solicitud pendiente en una pantalla pequeña; undefined si ya no esta pendiente. */
  async brief(id: number): Promise<{ what: string; who: string } | undefined> {
    const [a] = await this.db.query<Approval>(`SELECT * FROM approvals WHERE id = $1 AND business = $2 AND status = 'pendiente'`, [Math.floor(id) || 0, this.cfg.businessId]);
    return a ? { what: (ACTION_KINDS as Record<string, { label: string }>)[a.kind]?.label ?? a.kind, who: a.contact.includes('@') ? a.contact : `+${a.contact}` } : undefined;
  }

  waiting(): Promise<Approval[]> { return this.db.query<Approval>(`SELECT * FROM approvals WHERE business = $1 AND status = 'en_espera' ORDER BY id`, [this.cfg.businessId]); }
  pending(): Promise<Approval[]> { return this.db.query<Approval>(`SELECT * FROM approvals WHERE business = $1 AND status = 'pendiente' ORDER BY id`, [this.cfg.businessId]); }
  recent(limit = 50): Promise<Approval[]> { return this.db.query<Approval>(`SELECT * FROM approvals WHERE business = $1 AND status IN ('aprobada', 'rechazada') ORDER BY id DESC LIMIT $2`, [this.cfg.businessId, limit]); }

  /** Una vez al dia, a la hora configurada: si hay pendientes, se lo recuerda a Javier. Publico para poder probarlo. */
  async remind(now = new Date()): Promise<boolean> {
    const c = this.policy.clock(now), hour = this.policy.limit('recordatorio_hora');
    if (c.minutes < hour * 60) return false;
    const key = `approvals_reminder_${this.cfg.businessId}`;
    if ((await this.db.query<{ value: string }>('SELECT value FROM meta WHERE key = $1', [key]))[0]?.value === c.dayKey) return false;
    await this.db.query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, c.dayKey]);
    const list = await this.pending();
    if (!list.length) return false;
    await this.telegram.send(`🟡 Tienes ${list.length} ${list.length === 1 ? 'aprobación pendiente' : 'aprobaciones pendientes'}:\n` + list.slice(0, 15).map((a) => `#${a.id} · ${(ACTION_KINDS as Record<string, { label: string }>)[a.kind]?.label ?? a.kind} → ${a.contact.includes('@') ? a.contact : '+' + a.contact} (desde ${a.created_at.slice(0, 10)})`).join('\n') + '\nPuedes decidirlas en el panel, pestaña Aprobaciones, o con los botones de cada mensaje.');
    return true;
  }
}
/** Cada cuanto se reintenta algo aprobado que no pudo salir por un tope del dia. */
const RETRY_MS = 20 * 60_000;
const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
