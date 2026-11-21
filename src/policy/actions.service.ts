import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { AlertsService } from '../ops/alerts.service';
import { OptOutService } from '../security/optout.service';
import { CatalogService } from './catalog.service';
import { PolicyService } from './policy.service';

/**
 * Clases de accion: 'libre' (lectura, borradores: no pasa por limites), 'autonoma' (corre sola dentro de los limites) y
 * 'aprobacion' (siempre espera el si de Javier). Lo que no este en esta lista NO se puede hacer por iniciativa propia.
 */
export const ACTION_KINDS = {
  // Primer contacto a un numero que la persona dicto en el sitio: nadie verifico que sea suyo (decision de Javier: a la bandeja).
  // `literal`: `content` es el texto exacto que recibe la persona, asi que pasa la revision de salida (precios e identificacion
  // como IA). La plantilla no: su texto esta fijo y aprobado en Meta, aqui solo se describe.
  plantilla_bienvenida: { label: 'Plantilla de bienvenida por WhatsApp', channel: 'mensaje', class: 'aprobacion', literal: false },
  mensaje_seguimiento: { label: 'Mensaje de seguimiento', channel: 'mensaje', class: 'autonoma', literal: true },
  llamada_seguimiento: { label: 'Llamada de seguimiento', channel: 'llamada', class: 'autonoma', literal: false },
  oferta: { label: 'Oferta con precio', channel: 'mensaje', class: 'aprobacion', literal: true },
  // B3: enlace de la demo de su negocio (plantilla con imagen; su texto dice que es el asistente con IA de Javier). Siempre con aprobacion.
  enviar_demo: { label: 'Enlace de la demo de su negocio por WhatsApp', channel: 'mensaje', class: 'aprobacion', literal: false },
} as const satisfies Record<string, { label: string; channel: 'mensaje' | 'llamada'; class: 'libre' | 'autonoma' | 'aprobacion'; literal: boolean }>;
/** En todo contacto saliente minijavi dice que es el asistente con IA de Javier. Asi se reconoce esa frase en un texto. */
export const SAYS_AI = /asistente\s+(?:virtual\s+|digital\s+)?(?:con|de)\s+(?:ia|inteligencia\s+artificial)\b|\b(?:ia|inteligencia\s+artificial)\s+de\s+javier\b|\bsoy\s+una?\s+(?:ia|inteligencia\s+artificial)\b/i;
export type ActionKind = keyof typeof ACTION_KINDS;

export interface ActionRequest {
  kind: ActionKind; contact: string; leadId?: number;
  /** La persona dejo registrada su autorizacion para ser contactada (interesado con consent_at). */
  consent: boolean;
  /** Que lo disparo, de la lista explicita de disparadores (por ejemplo "interesado nuevo"). */
  trigger: string;
  /** El texto exacto que saldria (o un resumen fiel si es una plantilla o una llamada). */
  content: string;
  costUsd?: number; decisionIds?: number[];
  /** Javier ya aprobo esta accion en la bandeja: no vuelve a pedir aprobacion, pero TODO lo demas se comprueba otra vez. */
  approved?: boolean;
}
export type ActionStatus = 'enviada' | 'simulada' | 'bloqueada' | 'requiere_aprobacion' | 'rechazada' | 'fallo';
export interface ActionResult {
  status: ActionStatus; reason: string; id: number | null;
  /** Bloqueada por algo que pasa solo (horario, tope del dia, pausa): mas tarde si podria salir. */
  temporary?: boolean;
}
export interface ActionRow { id: number; at: string; kind: string; channel: string; contact: string; lead_id: number | null; trigger: string; content: string; status: ActionStatus; reason: string; cost_usd: number; simulated: number; decisions: string; ref: number | null; prev_hash: string; hash: string }

/**
 * La UNICA puerta por la que minijavi actua por iniciativa propia (etapa 2a). Quien quiera enviar algo sin que la persona
 * lo este pidiendo en ese momento llama a `run()` con lo que haria; aqui, en codigo, se decide si sale:
 *   pausa general -> "no contactar" -> numeros de prueba (si no hay produccion) -> aprobacion (clase de la accion o falta de
 *   autorizacion) -> horario -> topes por contacto y por dia -> intentos por interesado -> gasto -> simulacion o envio real.
 * Nada de esto depende de un prompt ni de la decision de un modelo. Cada intento, salga o no, queda en la bitacora
 * (tabla `actions`): solo se agregan filas, encadenadas por su huella, y ningun metodo de este servicio las cambia ni las borra.
 */
@Injectable()
export class ActionsService {
  private readonly log = new Logger(ActionsService.name);
  private chain: Promise<unknown> = Promise.resolve();
  private readonly alerted = new Map<string, string>();
  /** Reloj: las pruebas lo cambian para comprobar horarios y topes. */
  now: () => Date = () => new Date();

  constructor(private readonly cfg: ConfigService, private readonly db: DbService, private readonly policy: PolicyService, private readonly optout: OptOutService, private readonly alerts: AlertsService, private readonly catalog: CatalogService) {}

  /** Comprueba todo y, si se puede, ejecuta `send` (que devuelve '' o el motivo del fallo). Nunca lanza errores. */
  async run(req: ActionRequest, send: () => Promise<string>): Promise<ActionResult> {
    const def = ACTION_KINDS[req.kind];
    const done = async (status: ActionStatus, reason = '', simulated = false, temporary = false): Promise<ActionResult> => ({ status, reason, temporary, id: await this.append(req, def.channel, status, reason, simulated) });
    try {
      const why = await this.refusal(req, def);
      if (why) return await done(why.status, why.reason, false, !!why.temporary);
      if (this.policy.simulation) return await done('simulada', 'modo simulación: no se envió nada', true);
      const err = await send().catch((e) => (e as Error).message || 'fallo sin detalle');
      return await done(err ? 'fallo' : 'enviada', err);
    } catch (e) {
      this.log.error(`acción ${req.kind} no evaluada: ${(e as Error).message}`);
      return { status: 'bloqueada', reason: 'no se pudo comprobar la política; ante la duda no se actúa', id: null };
    }
  }

  /** El contacto como se guarda en la bitacora y en la bandeja (digitos con indicativo, o correo). */
  contactKey(contact: string) { return this.optout.key(contact) || contact.slice(0, 60); }

  /** Javier rechazo en la bandeja una accion que esperaba aprobacion: queda anotado en la bitacora y no se hace nada. */
  async rejected(req: ActionRequest, by: string): Promise<number | null> {
    return this.append(req, ACTION_KINDS[req.kind]?.channel ?? '', 'rechazada', `rechazada por Javier (${by})`, false);
  }

  /** Por que NO puede salir esta accion ahora (null = puede salir). El orden importa: lo mas grave primero. */
  private async refusal(req: ActionRequest, def: (typeof ACTION_KINDS)[ActionKind]): Promise<{ status: ActionStatus; reason: string; temporary?: boolean } | null> {
    const block = (reason: string) => ({ status: 'bloqueada' as const, reason }), later = (reason: string) => ({ status: 'bloqueada' as const, reason, temporary: true }), p = this.policy, now = this.now();
    if (!def) return block('ese tipo de acción no existe');
    if (p.paused) return later('las acciones autónomas están en pausa');
    if (!this.optout.key(req.contact)) return block('el contacto no es un teléfono ni un correo válido');
    if (this.optout.blocked(req.contact)) return block('esa persona pidió no ser contactada');
    // Revision de salida (2c): permisiva, solo frena fallos claros y comprobables en codigo. Va antes de pedir aprobacion: un
    // mensaje con un precio fuera del catalogo, o que no dice que es una IA, ni siquiera llega a la bandeja.
    if (def.literal) {
      const price = this.catalog.violation(req.content); if (price) return block(`revisión de salida: ${price}`);
      if (!SAYS_AI.test(req.content)) return block('revisión de salida: el mensaje no dice que es el asistente con IA de Javier');
    } else if (req.kind !== 'oferta' && this.catalog.violation(req.content)) return block(`revisión de salida: ${this.catalog.violation(req.content)}`);
    if (req.kind === 'oferta' && this.catalog.empty) return block('no hay catálogo de precios: no se envían ofertas');
    if (!p.production && !p.isTestNumber(req.contact)) return block('producción no está activada y el contacto no es un número de prueba');
    if (!req.approved && (def.class === 'aprobacion' || !req.consent)) return { status: 'requiere_aprobacion', reason: !req.consent ? 'primer contacto sin autorización registrada' : `${def.label}: siempre pide aprobación` };
    const late = p.outsideHours(now); if (late) return later(late);

    const since = p.since(now), key = this.optout.key(req.contact), call = def.channel === 'llamada';
    // Cuenta lo que ya salio (o habria salido, en simulacion: asi la bitacora muestra los topes como serian de verdad).
    const rows = await this.db.query<{ kind: string; contact: string; lead_id: number | null; at: string; cost_usd: number }>(
      `SELECT kind, contact, lead_id, at, cost_usd FROM actions WHERE business = $1 AND status IN ('enviada', 'simulada') AND (at >= $2 OR contact = $3 OR lead_id = $4)`, [this.cfg.businessId, since.month, key, req.leadId ?? -1]);
    const isCall = (k: string) => (ACTION_KINDS as Record<string, { channel: string }>)[k]?.channel === 'llamada';
    const today = rows.filter((r) => r.at >= since.day), mine = today.filter((r) => r.contact === key);
    const perContact = call ? p.limit('max_llamadas_contacto_dia') : p.limit('max_mensajes_contacto_dia'), perDay = call ? p.limit('max_llamadas_dia') : p.limit('max_mensajes_dia'), what = call ? 'llamadas' : 'mensajes';
    if (mine.filter((r) => isCall(r.kind) === call).length >= perContact) return later(`ya se llegó al tope de ${what} a este contacto por hoy (${perContact})`);
    if (today.filter((r) => isCall(r.kind) === call).length >= perDay) { this.limitAlert(`${what}-dia`, `Se alcanzó el tope de ${what} autónomos de hoy (${perDay}).`); return later(`ya se llegó al tope de ${what} de hoy (${perDay})`); }
    const attempts = rows.filter((r) => r.contact === key || (req.leadId && r.lead_id === req.leadId)).length, maxAttempts = p.limit('max_intentos_interesado');
    if (attempts >= maxAttempts) return block(`ya se hicieron los ${maxAttempts} intentos permitidos con esta persona`);
    const cost = req.costUsd ?? 0, spentDay = sum(today), spentMonth = sum(rows.filter((r) => r.at >= since.month)), capDay = p.limit('gasto_dia_usd'), capMonth = p.limit('gasto_mes_usd');
    if (capDay > 0 && spentDay + cost > capDay) { this.limitAlert('gasto-dia', `Se alcanzó el tope de gasto diario de las acciones autónomas (${capDay} USD).`); return later(`superaría el gasto máximo de hoy (${capDay} USD)`); }
    if (capMonth > 0 && spentMonth + cost > capMonth) { this.limitAlert('gasto-mes', `Se alcanzó el tope de gasto mensual de las acciones autónomas (${capMonth} USD).`); return block(`superaría el gasto máximo del mes (${capMonth} USD)`); }
    return null;
  }

  /** Un aviso por limite y por dia: avisar es util, repetirlo en cada intento no. */
  private limitAlert(which: string, text: string) {
    const day = this.policy.clock(this.now()).dayKey;
    if (this.alerted.get(which) === day) return;
    this.alerted.set(which, day);
    void Promise.resolve().then(() => this.alerts.send(`⛔ ${text} Desde ahora y hasta que cambie el día (o el tope en el panel) no hago más de eso por mi cuenta.`)).catch(() => undefined);
  }

  /** Agrega una fila a la bitacora. Las escrituras van en fila india: cada huella depende de la anterior. */
  private append(req: ActionRequest, channel: string, status: ActionStatus, reason: string, simulated: boolean, ref: number | null = null): Promise<number | null> {
    const job = this.chain.then(async () => {
      const prev = (await this.db.query<{ hash: string }>('SELECT hash FROM actions WHERE business = $1 ORDER BY id DESC LIMIT 1', [this.cfg.businessId]))[0]?.hash ?? '';
      const row = { at: this.now().toISOString(), kind: req.kind, channel, contact: this.optout.key(req.contact) || req.contact.slice(0, 60), lead_id: req.leadId ?? null, trigger: clip(req.trigger, 120), content: clip(req.content, 2000),
        status, reason: clip(reason, 300), cost_usd: status === 'enviada' || status === 'simulada' ? Number(req.costUsd ?? 0) : 0, simulated: simulated ? 1 : 0, decisions: (req.decisionIds ?? []).join(','), ref };
      const hash = fingerprint(prev, row);
      const out = await this.db.query<{ id: number }>('INSERT INTO actions (business, at, kind, channel, contact, lead_id, trigger, content, status, reason, cost_usd, simulated, decisions, ref, prev_hash, hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id',
        [this.cfg.businessId, row.at, row.kind, row.channel, row.contact, row.lead_id, row.trigger, row.content, row.status, row.reason, row.cost_usd, row.simulated, row.decisions, row.ref, prev, hash]);
      this.log.log(`acción ${req.kind} → ${status}${reason ? ` (${reason})` : ''}`);
      return out[0]?.id ?? null;
    });
    this.chain = job.catch(() => undefined);
    return job.catch((e) => { this.log.error(`no se pudo escribir en la bitácora: ${(e as Error).message}`); return null; });
  }

  /** Consulta de la bitacora (la mas reciente primero), con filtros simples. */
  async list(o: { status?: string; kind?: string; q?: string; days?: number; limit?: number } = {}): Promise<ActionRow[]> {
    const rows = await this.db.query<ActionRow>('SELECT * FROM actions WHERE business = $1 AND at >= $2 ORDER BY id DESC LIMIT 2000', [this.cfg.businessId, new Date(Date.now() - (o.days ?? 30) * 86_400_000).toISOString()]);
    const q = (o.q ?? '').toLowerCase().replace(/[\s+]/g, '');
    return rows.filter((r) => (!o.status || r.status === o.status) && (!o.kind || r.kind === o.kind) && (!q || `${r.contact} ${r.content} ${r.trigger} ${r.reason}`.toLowerCase().replace(/[\s+]/g, '').includes(q))).slice(0, Math.min(500, o.limit ?? 200));
  }

  /** Recorre la cadena de huellas. `ok` falso = alguna fila fue cambiada, quitada o insertada por fuera de este servicio. */
  async verify(): Promise<{ ok: boolean; rows: number; brokenAt: number | null }> {
    const rows = await this.db.query<ActionRow>('SELECT * FROM actions WHERE business = $1 ORDER BY id', [this.cfg.businessId]);
    let prev = '';
    for (const r of rows) {
      const row = { at: r.at, kind: r.kind, channel: r.channel, contact: r.contact, lead_id: r.lead_id === null ? null : Number(r.lead_id), trigger: r.trigger, content: r.content, status: r.status, reason: r.reason, cost_usd: Number(r.cost_usd), simulated: Number(r.simulated), decisions: r.decisions, ref: r.ref === null ? null : Number(r.ref) };
      if (r.prev_hash !== prev || r.hash !== fingerprint(prev, row)) return { ok: false, rows: rows.length, brokenAt: Number(r.id) };
      prev = r.hash;
    }
    return { ok: true, rows: rows.length, brokenAt: null };
  }

  /** Resumen del dia para el panel: en que modo esta y cuanto lleva de cada tope. */
  async status() {
    const p = this.policy, now = this.now(), since = p.since(now);
    const rows = await this.db.query<{ kind: string; at: string; cost_usd: number; status: string }>(`SELECT kind, at, cost_usd, status FROM actions WHERE business = $1 AND at >= $2`, [this.cfg.businessId, since.month]);
    const out = rows.filter((r) => r.status === 'enviada' || r.status === 'simulada'), today = out.filter((r) => r.at >= since.day), isCall = (k: string) => (ACTION_KINDS as Record<string, { channel: string }>)[k]?.channel === 'llamada';
    return { mode: p.paused ? 'pausa' : p.simulation ? 'simulacion' : p.production ? 'produccion' : 'pruebas', outsideHours: p.outsideHours(now), testNumbers: p.testNumbers().length,
      today: { messages: today.filter((r) => !isCall(r.kind)).length, calls: today.filter((r) => isCall(r.kind)).length, usd: round(sum(today)), blocked: rows.filter((r) => r.at >= since.day && r.status === 'bloqueada').length, pending: rows.filter((r) => r.status === 'requiere_aprobacion' && r.at >= since.day).length },
      month: { usd: round(sum(out)) }, limits: { messages: p.limit('max_mensajes_dia'), calls: p.limit('max_llamadas_dia'), usdDay: p.limit('gasto_dia_usd'), usdMonth: p.limit('gasto_mes_usd') }, chain: await this.verify() };
  }
}

const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const sum = (rows: { cost_usd: number }[]) => rows.reduce((a, r) => a + Number(r.cost_usd || 0), 0);
const round = (v: number) => Math.round(v * 10_000) / 10_000;
/** Huella de una fila: sha256 de la huella anterior y de todos sus campos, en orden fijo. */
function fingerprint(prev: string, row: Record<string, unknown>): string {
  return createHash('sha256').update(prev + '\n' + JSON.stringify(Object.keys(row).sort().map((k) => [k, row[k]]))).digest('hex');
}
