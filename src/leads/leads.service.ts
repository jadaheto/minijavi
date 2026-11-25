import { emitNotice } from '../notices/bus';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { ApprovalsService } from '../policy/approvals.service';
import { PolicyService } from '../policy/policy.service';
import { WhatsAppService, toPhone } from '../whatsapp/whatsapp.service';
import { contactKey } from '../security/optout.service';

export const INTERESTS = ['chatbots', 'agentes_de_voz', 'bots_de_whatsapp', 'automatizacion', 'dashboards', 'despliegue_y_servidores', 'desarrollo_de_software', 'otro'] as const;
export const STATUSES = ['nuevo', 'contactado', 'en_conversacion', 'cliente', 'descartado'] as const;

export interface Lead {
  id: number; created_at: string; name: string; contact: string; company: string;
  interest: string; detail: string; status: string; notes: string;
  source: string;   // de donde llego: voz, llamada, formulario:<proyecto>
  quote_at: string;  // cuando pidio precio ('' = no lo ha pedido)
  consent_at: string; consent_source: string; // cuando y por donde autorizo que la contacten ('' = sin autorizacion registrada)
}
export interface Conversation { id: number; at: string; kind: string; who: string; seconds: number; turns: number; transcript: string; }
export interface NewLead { name: string; contact: string; company?: string; interest: string; detail?: string; source?: string; }

const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Personas interesadas en los servicios de Javier y conversaciones atendidas. Los datos viven en la base (DbService).
 */
@Injectable()
export class LeadsService {
  private readonly log = new Logger(LeadsService.name);
  constructor(private readonly cfg: ConfigService, private readonly whatsapp: WhatsAppService, private readonly db: DbService, private readonly approvals: ApprovalsService, private readonly policy: PolicyService) {
    // Asi se envia la plantilla cuando Javier la aprueba en la bandeja.
    approvals.register('plantilla_bienvenida', (p: { contact: string; name: string; interest: string }) => this.whatsapp.sendWelcome(p.contact, p.name, p.interest));
  }

  /** Donde se estan guardando los datos ('postgres' o 'sqlite'), para mostrarlo en el panel. */
  get dbKind() { return this.db.kind; }

  /** Guarda una conversacion terminada: llamada de WhatsApp ('llamada') o conversacion del sitio ('sitio'). */
  async logConversation(kind: 'llamada' | 'sitio' | 'whatsapp', who: string, seconds: number, lines: string[]) {
    try {
      await this.db.query('INSERT INTO conversations (at, kind, who, seconds, turns, transcript) VALUES ($1, $2, $3, $4, $5, $6)',
        [new Date().toISOString(), kind, clip(who, 120), Math.round(seconds), lines.filter((l) => l.startsWith('🧑')).length, lines.join('\n').slice(0, 12_000)]);
    } catch (e) { this.log.warn(`no se pudo registrar la conversación: ${(e as Error).message}`); }
  }
  callsSince(iso: string): Promise<Conversation[]> {
    return this.db.query<Conversation>(`SELECT id, at, kind, who, seconds, turns, transcript FROM conversations WHERE kind = 'llamada' AND at >= $1 ORDER BY id DESC LIMIT 30`, [iso]);
  }
  /** Conversaciones para el panel, sin la transcripcion (se pide aparte). */
  conversations(limit = 100): Promise<Omit<Conversation, 'transcript'>[]> {
    return this.db.query('SELECT id, at, kind, who, seconds, turns FROM conversations ORDER BY at DESC LIMIT $1', [Math.min(500, Math.max(1, limit))]) as any;
  }
  async conversation(id: number): Promise<Conversation | undefined> { return (await this.db.query<Conversation>('SELECT id, at, kind, who, seconds, turns, transcript FROM conversations WHERE id = $1', [id]))[0]; }
  async removeConversation(id: number): Promise<boolean> { return (await this.db.query('DELETE FROM conversations WHERE id = $1 RETURNING id', [id])).length > 0; }

  leadsSince(iso: string): Promise<Lead[]> { return this.db.query<Lead>('SELECT * FROM leads WHERE created_at >= $1 ORDER BY id DESC LIMIT 30', [iso]); }
  async countByStatus(status: string): Promise<number> { return Number((await this.db.query('SELECT COUNT(*) AS n FROM leads WHERE status = $1', [status]))[0]?.n ?? 0); }

  /** Interesados que siguen en "nuevo" desde hace `days` dias o mas, del mas antiguo al mas reciente. */
  pending(days: number): Promise<Lead[]> {
    return this.db.query<Lead>(`SELECT * FROM leads WHERE status = 'nuevo' AND created_at <= $1 ORDER BY created_at LIMIT 100`, [new Date(Date.now() - days * 86_400_000).toISOString()]);
  }
  /** Busca por numero (#12) o por parte del nombre o la empresa, entre los 200 mas recientes. */
  async find(who: string): Promise<Lead[]> {
    const q = who.trim(), id = Number(q.replace(/^#/, ''));
    if (/^#?\d+$/.test(q)) { const l = await this.get(id); return l ? [l] : []; }
    const plain = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const words = plain(q).split(/\s+/).filter((w) => w.length > 1);
    if (!words.length) return [];
    return (await this.list(200)).filter((l) => { const hay = plain(`${l.name} ${l.company}`); return words.every((w) => hay.includes(w)); });
  }

  async add(input: NewLead): Promise<Lead> {
    const row = [new Date().toISOString(), clip(input.name, 120), clip(input.contact, 160), clip(input.company, 120),
      INTERESTS.includes(input.interest as any) ? input.interest : 'otro', clip(input.detail, 800), clip(input.source, 60)];
    // Todo interesado se guarda con autorizacion (la herramienta exige `autoriza`, el formulario su casilla): queda anotada.
    const now = String(row[0]);
    const [saved] = await this.db.query<Lead>('INSERT INTO leads (created_at, name, contact, company, interest, detail, source, consent_at, consent_source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *', [...row, now, row[6]]);
    this.log.log(`interesado #${saved.id} registrado (${saved.interest}${saved.source ? ', ' + saved.source : ''})`);
    // Aviso para los dispositivos de Javier, venga de donde venga (voz, llamada, formulario, WhatsApp). El nombre lo escribió un tercero.
    emitNotice({ source: 'interesados', title: 'Interesado nuevo', body: `${saved.name}${saved.company ? ` · ${saved.company}` : ''}`, tone: 'ok', untrusted: true, ref: { kind: 'interesado', id: saved.id } });
    return saved;
  }

  async get(id: number): Promise<Lead | undefined> { return (await this.db.query<Lead>('SELECT * FROM leads WHERE id = $1', [id]))[0]; }
  /** Los interesados que dejaron ese mismo contacto (para unir una conversacion posterior con su interesado). */
  async idsForContact(contact: string): Promise<number[]> {
    const k = contactKey(contact, this.cfg.whatsappDefaultCountry); if (!k) return [];
    const rows = await this.db.query<{ id: number; contact: string }>('SELECT id, contact FROM leads');
    return rows.filter((r) => contactKey(r.contact, this.cfg.whatsappDefaultCountry) === k).map((r) => Number(r.id));
  }

  list(limit = 200): Promise<Lead[]> { return this.db.query<Lead>('SELECT * FROM leads ORDER BY id DESC LIMIT $1', [limit]); }
  async update(id: number, patch: { status?: string; notes?: string }): Promise<boolean> {
    const cur = await this.get(id); if (!cur) return false;
    const status = STATUSES.includes(patch.status as any) ? patch.status! : cur.status;
    const notes = patch.notes === undefined ? cur.notes : clip(patch.notes, 1000);
    await this.db.query('UPDATE leads SET status = $1, notes = $2 WHERE id = $3', [status, notes, id]);
    return true;
  }
  /** La persona pidio precio: queda anotado en el interesado (fecha y nota) y Javier recibe el aviso para cotizarle. */
  async quoteRequested(id: number, what: string): Promise<boolean> {
    const cur = await this.get(id); if (!cur) return false;
    const now = new Date(), note = `${now.toISOString().slice(0, 10)}: pidió cotización${what ? ` — ${clip(what, 240)}` : ''}`;
    await this.db.query('UPDATE leads SET quote_at = $1, notes = $2 WHERE id = $3', [now.toISOString(), clip(cur.notes ? `${cur.notes}\n${note}` : note, 1000), id]);
    void this.telegram(`💰 ${cur.name} (${cur.contact}) pidió precio. Le dije que tú le preparas la cotización.${what ? `\nLo que necesita: ${clip(what, 300)}` : ''}\nInteresado #${id}.`).catch(() => undefined);
    return true;
  }
  async remove(id: number): Promise<boolean> { return (await this.db.query('DELETE FROM leads WHERE id = $1 RETURNING id', [id])).length > 0; }

  async csv(): Promise<string> {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const cols: (keyof Lead)[] = ['id', 'created_at', 'name', 'contact', 'company', 'interest', 'detail', 'status', 'notes', 'source'];
    return [cols.join(','), ...(await this.list(10_000)).map((l) => cols.map((c) => esc(l[c])).join(','))].join('\n');
  }

  /** Cifras para el panel: totales, por estado, por interes, por origen y por dia (ultimos `days` dias, en la zona de Javier). */
  async stats(days = 30) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const group = (col: string) => this.db.query<{ k: string; n: number }>(`SELECT ${col} AS k, COUNT(*) AS n FROM leads GROUP BY ${col} ORDER BY n DESC`);
    const [byStatus, byInterest, bySource, recent, convs] = await Promise.all([group('status'), group('interest'), group('source'),
      this.db.query<{ created_at: string }>('SELECT created_at FROM leads WHERE created_at >= $1', [since]),
      this.db.query<{ at: string; kind: string; seconds: number }>('SELECT at, kind, seconds FROM conversations WHERE at >= $1', [since])]);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: this.cfg.timezone });
    const perDay: Record<string, { leads: number; llamadas: number; sitio: number }> = {};
    for (let i = days - 1; i >= 0; i--) perDay[day.format(new Date(Date.now() - i * 86_400_000))] = { leads: 0, llamadas: 0, sitio: 0 };
    for (const l of recent) { const d = perDay[day.format(new Date(l.created_at))]; if (d) d.leads++; }
    for (const c of convs) { const d = perDay[day.format(new Date(c.at))]; if (d) d[c.kind === 'llamada' ? 'llamadas' : 'sitio']++; }
    const n = (rows: { k: string; n: number }[]) => rows.map((r) => ({ k: r.k || 'sin dato', n: Number(r.n) }));
    return { total: byStatus.reduce((a, r) => a + Number(r.n), 0), byStatus: n(byStatus), byInterest: n(byInterest), bySource: n(bySource),
      days: Object.entries(perDay).map(([d, v]) => ({ day: d, ...v })), conversations: convs.length, talkSeconds: convs.reduce((a, c) => a + Number(c.seconds), 0) };
  }

  /** Texto del aviso de un interesado. */
  message(lead: Lead, whatsapp?: string): string {
    return [
      '🔔 Nuevo interesado',
      `👤 ${lead.name}${lead.company ? ` — ${lead.company}` : ''}`,
      `📞 ${lead.contact}`,
      `🧩 ${lead.interest.replaceAll('_', ' ')}`,
      lead.detail ? `📝 ${lead.detail}` : '',
      whatsapp === undefined ? '' : whatsapp === '' ? '✅ Plantilla de WhatsApp enviada' : `⚠️ WhatsApp no enviado: ${whatsapp}`,
      `#${lead.id} · ${new Intl.DateTimeFormat('es-CO', { timeZone: this.cfg.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(lead.created_at))}`,
    ].filter(Boolean).join('\n');
  }

  /** Envia un mensaje por el bot de Telegram. Devuelve '' si salio bien o el motivo del fallo. */
  async telegram(text: string): Promise<string> {
    if (!this.cfg.telegramBotToken || !this.cfg.telegramChatId) return 'Telegram no está configurado';
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.cfg.telegramBotToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.cfg.telegramChatId, text }), signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return '';
      const d: any = await res.json().catch(() => ({}));
      return `Telegram respondió ${res.status}: ${d.description ?? 'sin detalle'}`;
    } catch (e) { return `no se pudo conectar con Telegram: ${(e as Error).name}`; } // sin el mensaje: podria traer la URL con el token
  }

  /**
   * Tras guardar un interesado: le envia la plantilla de WhatsApp y avisa a Javier por Telegram (y por webhook si hay).
   * Devuelve '' si la plantilla se envio, el motivo si no, o undefined si WhatsApp no esta configurado.
   */
  /**
   * Interesado nuevo: avisa a Javier y, si corresponde, envia la plantilla de bienvenida. La plantilla es un envio por
   * iniciativa propia a un numero que la persona dicto, asi que pasa por la puerta de acciones (pausa, no contactar,
   * numeros de prueba, aprobacion, horario, topes, simulacion). Devuelve '' si salio de verdad, o por que no salio.
   */
  async announce(lead: Lead): Promise<string | undefined> {
    let wa: string | undefined;
    // Quien deja sus datos escribiendo por WhatsApp ya esta en ese chat: no se le manda ademas la plantilla de bienvenida.
    if (this.whatsapp.enabled && lead.source !== 'whatsapp') {
      if (!toPhone(lead.contact, this.cfg.whatsappDefaultCountry)) wa = 'el contacto no es un número de WhatsApp';
      else {
        const r = await this.approvals.submit({ kind: 'plantilla_bienvenida', contact: lead.contact, leadId: lead.id, consent: !!lead.consent_at, trigger: `interesado nuevo: ${lead.name}`,
          content: `Plantilla "${this.cfg.whatsappTemplate}" para ${lead.name.split(/\s+/)[0]}, interés: ${lead.interest.replaceAll('_', ' ')}`, costUsd: this.policy.limit('costo_plantilla_usd') },
          { contact: lead.contact, name: lead.name, interest: lead.interest });
        wa = r.status === 'enviada' ? '' : r.status === 'simulada' ? 'simulación: no se envió nada (quedó en la bitácora)' : r.status === 'requiere_aprobacion' ? 'espera tu aprobación (en el panel, pestaña Aprobaciones; si usas Telegram, te llegó aparte con botones)' : r.reason || 'no se envió';
      }
    }
    void this.notify(lead, wa);
    return wa;
  }

  /** Envia un archivo por el bot de Telegram (por ejemplo la grabacion de una llamada). Devuelve '' o el motivo del fallo. */
  async telegramFile(file: Buffer, filename: string, caption: string): Promise<string> {
    if (!this.cfg.telegramBotToken || !this.cfg.telegramChatId) return 'Telegram no está configurado';
    try {
      const form = new FormData();
      form.append('chat_id', this.cfg.telegramChatId);
      form.append('caption', caption.slice(0, 1000));
      form.append('document', new Blob([new Uint8Array(file)], { type: 'audio/wav' }), filename);
      const res = await fetch(`https://api.telegram.org/bot${this.cfg.telegramBotToken}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
      if (res.ok) return '';
      const d: any = await res.json().catch(() => ({}));
      return `Telegram respondió ${res.status}: ${d.description ?? 'sin detalle'}`;
    } catch (e) { return `no se pudo enviar el archivo a Telegram: ${(e as Error).name}`; }
  }

  /** Envia un texto largo partido en mensajes de hasta ~3.800 caracteres. */
  async telegramLong(text: string) {
    for (let i = 0; i < text.length; i += 3800) { const err = await this.telegram(text.slice(i, i + 3800)); if (err) return err; }
    return '';
  }

  /** Avisos de un interesado nuevo: Telegram y, si esta configurado, un webhook (por ejemplo n8n). */
  private async notify(lead: Lead, whatsapp?: string) {
    if (this.cfg.telegramBotToken && this.cfg.telegramChatId) {
      const err = await this.telegram(this.message(lead, whatsapp));
      if (err) this.log.warn(`aviso de interesado #${lead.id}: ${err}`); else this.log.log(`interesado #${lead.id} avisado por Telegram`);
    }
    if (!this.cfg.leadsWebhookUrl) return;
    try {
      const res = await fetch(this.cfg.leadsWebhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'nuevo_interesado', lead }), signal: AbortSignal.timeout(8000) });
      if (!res.ok) this.log.warn(`el aviso de interesado respondió ${res.status}`);
    } catch (e) { this.log.warn(`no se pudo enviar el aviso de interesado: ${(e as Error).message}`); }
  }
}
