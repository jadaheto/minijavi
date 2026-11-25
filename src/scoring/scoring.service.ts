import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { OptOutService, contactKey } from '../security/optout.service';
import { SettingsService } from '../settings/settings.service';

/**
 * Calificacion de interesados con puntos (etapa 3a; plan aprobado por Javier el 2026-11-24 "con las recomendadas").
 *
 * Cada interesado arranca en una base y suma o resta puntos segun lo que hizo o dejo de hacer. El resultado (0 a 100) lo
 * deja caliente, tibio o frio. Decisiones de Javier:
 *  - Los puntos salen de REGLAS escritas aqui, no de un modelo. Cada valor se puede cambiar en el panel (ajustes
 *    `puntos.*`) y cada interesado muestra su desglose.
 *  - El puntaje ORDENA y SUGIERE. No envia nada ni cambia el estado de nadie.
 *  - Quien pidio "no me contacten" no se califica: queda fuera del orden.
 *
 * No hay un registro aparte de señales: cada señal se DEDUCE de lo que ya esta guardado (interesados, bitacora de
 * acciones, mensajes de WhatsApp, demos, solicitudes de avatar). Asi el puntaje nunca queda desfasado: si la persona
 * responde, "no respondio" deja de contar sin que nadie tenga que borrar nada.
 *
 * Entrega 1: señales que ya se podian saber. La entrega 2 suma las que necesitan unir cada conversacion con su
 * interesado (hizo la demostracion, volvio, dijo que no le interesa) y los avisos de entrega y lectura de Meta.
 */
export interface SignalDef { id: string; sign: 1 | -1; points: number; label: string; hint: string }
export const SIGNALS: SignalDef[] = [
  { id: 'voz', sign: 1, points: 15, label: 'Dejó sus datos hablando', hint: 'Por voz en el sitio o en una llamada (no por un formulario).' },
  { id: 'necesidad', sign: 1, points: 10, label: 'Dijo empresa y una necesidad concreta', hint: 'Tiene empresa, un interés distinto de «otro» y un detalle.' },
  { id: 'cotizacion', sign: 1, points: 15, label: 'Pidió precio o cotización', hint: '' },
  { id: 'documento', sign: 1, points: 15, label: 'Subió un documento de su negocio', hint: 'Para la demostración con su propio negocio.' },
  { id: 'demo_abierta', sign: 1, points: 10, label: 'Abrió el enlace de su demo', hint: '' },
  { id: 'respondio', sign: 1, points: 10, label: 'Respondió el WhatsApp', hint: 'Escribió después de recibir la plantilla de bienvenida.' },
  { id: 'pago_avatar', sign: 1, points: 20, label: 'Pagó un avatar personalizado', hint: 'Con el pago ya aprobado.' },
  { id: 'demo_hecha', sign: 1, points: 15, label: 'Hizo la demostración en vivo', hint: 'En una conversación que quedó unida a este interesado.' },
  { id: 'volvio', sign: 1, points: 10, label: 'Volvió a conversar otro día', hint: 'Conversaciones o mensajes en dos días distintos o más.' },
  { id: 'telefono', sign: -1, points: 25, label: 'Contacto no válido', hint: 'Lo que dejó no es un celular ni un correo utilizable, o WhatsApp no pudo entregarle.' },
  { id: 'sin_respuesta', sign: -1, points: 15, label: 'No respondió el WhatsApp', hint: 'Pasaron los días de espera desde la plantilla y no escribió.' },
  { id: 'leyo', sign: -1, points: 10, label: 'Lo leyó y no respondió', hint: 'WhatsApp avisó que lo leyó y pasó el plazo sin escribir. Se suma a «no respondió».' },
  { id: 'no_interesado', sign: -1, points: 50, label: 'Dijo que no le interesa', hint: 'Su conversación más reciente terminó sin interés y con una objeción.' },
  { id: 'sin_documento', sign: -1, points: 10, label: 'No subió documento en la demostración', hint: 'Hizo la demostración y no subió nada de su negocio.' },
  { id: 'demo_sin_abrir', sign: -1, points: 20, label: 'No abrió su demo', hint: 'Se le envió el enlace y pasaron los días de espera sin abrirlo.' },
  { id: 'pago_pendiente', sign: -1, points: 30, label: 'No terminó el pago del avatar', hint: 'Empezó la solicitud y no pagó en el plazo.' },
  { id: 'sin_avance', sign: -1, points: 30, label: 'Sin avance', hint: 'Sigue en «nuevo» después del plazo.' },
  { id: 'inactivo', sign: -1, points: 20, label: 'Inactivo', hint: 'Sin ninguna actividad en el plazo.' },
  { id: 'inactivo_largo', sign: -1, points: 20, label: 'Inactivo hace mucho', hint: 'Sin ninguna actividad en el doble del plazo (o 30 días).' },
];
export const SCORE_DAYS = [
  { id: 'dias_whatsapp', def: 3, label: 'Días para dar por no respondido el WhatsApp' },
  { id: 'dias_demo', def: 3, label: 'Días para dar por no abierta la demo' },
  { id: 'dias_pago', def: 7, label: 'Días para dar por no terminado el pago' },
  { id: 'dias_avance', def: 10, label: 'Días en «nuevo» para marcar sin avance' },
  { id: 'dias_inactivo', def: 14, label: 'Días sin actividad para marcar inactivo' },
] as const;

export type ScoreLevel = 'caliente' | 'tibio' | 'frio' | 'cliente' | 'descartado' | 'no_contactar';
export interface ScoreItem { id: string; label: string; points: number; at?: string }
export interface LeadScore { score: number | null; level: ScoreLevel; items: ScoreItem[]; lastActivity: string }
/** Lo minimo de un interesado que hace falta para calificarlo. */
export interface ScoredLead { id: number; created_at: string; contact: string; company: string; interest: string; detail: string; status: string; source: string; quote_at?: string }

const DAY = 86_400_000;
const PAID = ['PAGO_APROBADO', 'GENERANDO_AVATAR', 'AVATAR_GENERADO', 'AVATAR_ACTIVADO', 'COMPLETADO'], UNPAID = ['FOTO_RECIBIDA', 'PENDIENTE_PAGO'];
const ms = (iso: unknown) => { const t = Date.parse(String(iso ?? '')); return Number.isFinite(t) ? t : 0; };

@Injectable()
export class ScoringService {
  private readonly log = new Logger(ScoringService.name);
  /** Para las pruebas: la hora "de ahora". */
  now: () => Date = () => new Date();

  constructor(private readonly cfg: ConfigService, private readonly db: DbService, private readonly settings: SettingsService, @Optional() private readonly optout?: OptOutService) {
    const g = 'puntos';
    settings.define('puntos.base', { type: 'number', def: 40, min: 0, max: 100, label: 'Puntos con los que arranca cada interesado', group: g });
    settings.define('puntos.caliente', { type: 'number', def: 80, min: 1, max: 100, label: 'Desde cuántos puntos es caliente', group: g });
    settings.define('puntos.tibio', { type: 'number', def: 50, min: 0, max: 99, label: 'Desde cuántos puntos es tibio', group: g });
    for (const s of SIGNALS) settings.define(`puntos.${s.id}`, { type: 'number', def: s.points, min: 0, max: 100, label: `${s.sign > 0 ? 'Suma' : 'Resta'}: ${s.label}`, group: g, hint: s.hint || undefined });
    for (const d of SCORE_DAYS) settings.define(`puntos.${d.id}`, { type: 'number', def: d.def, min: 1, max: 365, label: d.label, group: g });
  }

  private pts(id: string) { return this.settings.number(`puntos.${id}`); }
  private days(id: (typeof SCORE_DAYS)[number]['id']) { return this.settings.number(`puntos.${id}`) * DAY; }
  /** La tabla vigente (para el panel): cada señal con sus puntos de ahora. */
  table() { return { base: this.pts('base'), hot: this.pts('caliente'), warm: Math.min(this.pts('tibio'), this.pts('caliente') - 1), signals: SIGNALS.map((s) => ({ id: s.id, label: s.label, hint: s.hint, points: s.sign * this.pts(s.id) })), days: Object.fromEntries(SCORE_DAYS.map((d) => [d.id, this.settings.number(`puntos.${d.id}`)])) }; }

  /** Los ajustes de la calificacion tal como los edita el panel (clave, etiqueta, valor, limites). */
  editable() { return this.settings.list().filter((s) => s.group === 'puntos'); }

  /** Los interesados de un nivel, de mayor a menor puntaje (para la voz y el resumen). */
  async top<T extends ScoredLead>(leads: T[], level: 'caliente' | 'tibio' | 'frio', max = 5): Promise<{ lead: T; rating: LeadScore }[]> {
    const scores = await this.forLeads(leads);
    return leads.map((lead) => ({ lead, rating: scores.get(lead.id)! })).filter((x) => x.rating?.level === level).sort((a, b) => (b.rating.score ?? 0) - (a.rating.score ?? 0)).slice(0, max);
  }

  level(score: number): 'caliente' | 'tibio' | 'frio' { const t = this.table(); return score >= t.hot ? 'caliente' : score >= t.warm ? 'tibio' : 'frio'; }

  /**
   * Califica una lista de interesados. `blocked`: quien pidio no ser contactado (lo decide quien llama, con la lista de
   * "no contactar"). Hace unas pocas consultas para todos, no una por interesado. Nunca lanza: si una fuente falla, sus
   * señales simplemente no cuentan.
   */
  async forLeads(leads: ScoredLead[], blocked: (contact: string) => boolean = (c) => this.optout?.blocked(c) ?? false): Promise<Map<number, LeadScore>> {
    const out = new Map<number, LeadScore>(); if (!leads.length) return out;
    const biz = this.cfg.businessId, now = this.now().getTime();
    const key = (c: string) => contactKey(c, this.cfg.whatsappDefaultCountry);
    const q = <T>(sql: string, params: unknown[] = []) => this.db.query<T>(sql, params).catch((e) => { this.log.warn(`calificación: ${(e as Error).message}`); return [] as T[]; });
    const [actions, inbound, demos, usage, avatars, visits, delivery] = await Promise.all([
      q<{ lead_id: number | null; contact: string; kind: string; status: string; at: string }>(`SELECT lead_id, contact, kind, status, at FROM actions WHERE business = $1 AND kind IN ('plantilla_bienvenida', 'enviar_demo') AND status = 'enviada'`, [biz]),
      q<{ phone: string; at: string }>(`SELECT phone, at FROM wa_messages WHERE role = 'user'`),
      q<{ id: string; lead_id: number; status: string; created_at: string }>(`SELECT id, lead_id, status, created_at FROM demos WHERE business = $1 AND lead_id > 0`, [biz]),
      q<{ demo: string; day: string; sessions: number }>('SELECT demo, day, sessions FROM demo_usage'),
      q<{ lead_id: number; state: string; created_at: string; updated_at: string }>('SELECT lead_id, state, created_at, updated_at FROM avatar_requests WHERE lead_id > 0'),
      q<{ at: string; lead_ids: string; interested: number; demo_done: number; objections: string }>(`SELECT at, lead_ids, interested, demo_done, objections FROM visits WHERE lead_ids <> ''`),
      q<{ phone: string; delivered_at: string; read_at: string; failed_at: string }>('SELECT phone, delivered_at, read_at, failed_at FROM wa_delivery'),
    ]);
    const dayOf = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: this.cfg.timezone }).format(new Date(t));
    const visitsOf = new Map<number, typeof visits>(); for (const v of visits) for (const id of String(v.lead_ids).split(',').map(Number).filter(Boolean)) (visitsOf.get(id) ?? visitsOf.set(id, []).get(id)!).push(v);
    const deliveryOf = new Map(delivery.map((d) => [key(d.phone) || d.phone, d]));
    const lastIn = new Map<string, number[]>(); for (const m of inbound) { const k = key(m.phone) || m.phone; (lastIn.get(k) ?? lastIn.set(k, []).get(k)!).push(ms(m.at)); }
    const opens = new Map<string, { n: number; last: number }>(); for (const u of usage) { const o = opens.get(u.demo) ?? { n: 0, last: 0 }; o.n += Number(u.sessions) || 0; o.last = Math.max(o.last, ms(`${u.day}T12:00:00Z`)); opens.set(u.demo, o); }

    for (const l of leads) {
      const items: ScoreItem[] = [], add = (id: string, at?: number) => { const d = SIGNALS.find((s) => s.id === id)!, p = this.pts(id); if (p > 0) items.push({ id, label: d.label, points: d.sign * p, ...(at ? { at: new Date(at).toISOString() } : {}) }); };
      const created = ms(l.created_at), k = key(l.contact), email = l.contact.includes('@');
      const mine = (a: { lead_id: number | null; contact: string }) => Number(a.lead_id) === l.id || (!!k && key(a.contact) === k);
      const msgs = (k && !email ? lastIn.get(k) : undefined) ?? [];
      const myDemos = demos.filter((d) => Number(d.lead_id) === l.id), myOpens = myDemos.map((d) => opens.get(d.id)).filter((o): o is { n: number; last: number } => !!o && o.n > 0);
      const myAvatars = avatars.filter((a) => Number(a.lead_id) === l.id);
      const myVisits = (visitsOf.get(l.id) ?? []).map((v) => ({ ...v, t: ms(v.at) })).sort((x, y) => x.t - y.t), dv = k && !email ? deliveryOf.get(k) : undefined;
      let last = Math.max(created, ms(l.quote_at), ...msgs, ...myVisits.map((v) => v.t), ...myOpens.map((o) => o.last), ...myDemos.map((d) => ms(d.created_at)), ...myAvatars.map((a) => ms(a.updated_at)));

      // --- lo que suma ---
      if (l.source === 'voz' || l.source === 'llamada') add('voz', created);
      if (l.company.trim() && l.interest !== 'otro' && l.detail.trim()) add('necesidad', created);
      if (l.quote_at) add('cotizacion', ms(l.quote_at));
      const doc = myDemos.find((d) => d.status === 'lista'); if (doc) add('documento', ms(doc.created_at));
      if (myOpens.length) add('demo_abierta', Math.max(...myOpens.map((o) => o.last)));
      const paid = myAvatars.find((a) => PAID.includes(a.state)); if (paid) add('pago_avatar', ms(paid.updated_at));
      const didDemo = myVisits.find((v) => Number(v.demo_done)); if (didDemo) add('demo_hecha', didDemo.t);
      const daysSeen = [...new Set([...myVisits.map((v) => v.t), ...msgs].filter(Boolean).sort((x, y) => x - y).map(dayOf))]; if (daysSeen.length >= 2) add('volvio', Math.max(...myVisits.map((v) => v.t), ...msgs));
      // --- WhatsApp: respondio despues de la plantilla, o paso el plazo sin responder ---
      const welcome = actions.filter((a) => a.kind === 'plantilla_bienvenida' && mine(a)).map((a) => ms(a.at)).sort((x, y) => x - y)[0];
      if (welcome) {
        const reply = msgs.filter((t) => t >= welcome).sort((x, y) => x - y)[0];
        if (reply) add('respondio', reply);
        else if (now - welcome >= this.days('dias_whatsapp')) { add('sin_respuesta', welcome + this.days('dias_whatsapp')); if (dv && ms(dv.read_at) >= welcome) add('leyo', ms(dv.read_at)); }
      }
      // --- lo que resta ---
      // Contacto que no sirve: no es celular ni correo, o WhatsApp dijo que no pudo entregar y despues no entrego nada.
      if (!k) add('telefono', created); else if (dv && ms(dv.failed_at) && ms(dv.failed_at) > Math.max(ms(dv.delivered_at), ms(dv.read_at)) && !msgs.length) add('telefono', ms(dv.failed_at));
      // Su conversacion mas reciente (posterior a registrarse) termino sin interes y con una objecion.
      const lastVisit = myVisits[myVisits.length - 1]; if (lastVisit && lastVisit.t > created + 3_600_000 && !Number(lastVisit.interested) && String(lastVisit.objections ?? '').trim()) add('no_interesado', lastVisit.t);
      if (didDemo && !myDemos.length) add('sin_documento', didDemo.t);
      const sentDemo = actions.filter((a) => a.kind === 'enviar_demo' && mine(a)).map((a) => ms(a.at)).sort((x, y) => x - y)[0];
      if (sentDemo && !myOpens.length && now - sentDemo >= this.days('dias_demo')) add('demo_sin_abrir', sentDemo + this.days('dias_demo'));
      const unpaid = !paid && myAvatars.find((a) => UNPAID.includes(a.state) && now - ms(a.created_at) >= this.days('dias_pago')); if (unpaid) add('pago_pendiente', ms(unpaid.created_at) + this.days('dias_pago'));
      if (l.status === 'nuevo' && now - created >= this.days('dias_avance')) add('sin_avance', created + this.days('dias_avance'));
      last = Math.max(last, welcome && msgs.some((t) => t >= welcome) ? Math.max(...msgs) : 0);
      const idle = now - last, long = Math.max(this.days('dias_inactivo') * 2, 30 * DAY);
      if (idle >= this.days('dias_inactivo')) add('inactivo', last + this.days('dias_inactivo'));
      if (idle >= long) add('inactivo_largo', last + long);

      const lastActivity = new Date(last).toISOString();
      if (blocked(l.contact)) { out.set(l.id, { score: null, level: 'no_contactar', items: [], lastActivity }); continue; }
      if (l.status === 'cliente' || l.status === 'descartado') { out.set(l.id, { score: null, level: l.status, items, lastActivity }); continue; }
      const score = Math.max(0, Math.min(100, this.pts('base') + items.reduce((a, i) => a + i.points, 0)));
      out.set(l.id, { score, level: this.level(score), items, lastActivity });
    }
    return out;
  }
}
