import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { LeadsService } from '../leads/leads.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { AlertsService } from '../ops/alerts.service';
import { UsageService } from '../usage/usage.service';
import { Funcion } from './business';

/**
 * El "mostrador" del modo negocio (C2, 2026-11-21): lo que el asistente de un cliente puede HACER ademas de responder
 * (tomar pedidos, agendar citas, guardar interesados, pasar a una persona) y los avisos al dueño del negocio.
 *  - Todo queda en la base del cliente (tablas orders, leads, handoffs) y se ve en su panel.
 *  - Avisos al dueño por las dos vias (decision de Javier): Telegram (el bot de ese servicio) y WhatsApp SIN plantilla.
 *    WhatsApp solo deja escribir texto libre dentro de las 24 h siguientes al ultimo mensaje del dueño: por eso el dueño
 *    manda un "hola" cada dia; aqui se anota cuando escribio y, si la ventana esta cerrada, el aviso va solo por Telegram.
 *    Antes de que se cierre se le recuerda por WhatsApp que responda para seguir recibiendo avisos.
 *  - Nada se guarda sin la confirmacion de la persona (`confirmado` / `autoriza`), y hay topes por conversacion.
 *  - En el chat de WhatsApp el contacto lo pone el servidor (el numero desde el que escriben), no el modelo.
 */
export interface Order { id: number; at: string; kind: 'pedido' | 'cita'; name: string; contact: string; detail: string; when_text: string; total: number; status: string; channel: string; notes: string }
export interface DeskContext { channel: 'voz' | 'whatsapp'; phone?: string; name?: string; counts: Record<string, number> }
const WINDOW_MS = 24 * 3600_000;
const txt = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const money = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
const LIMITS: Record<string, number> = { tomar_pedido: 3, agendar_cita: 2, guardar_interesado: 1, pasar_a_humano: 2 };

@Injectable()
export class BusinessDeskService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(BusinessDeskService.name);
  private ownerLast = 0; private reminded = 0; private timer?: NodeJS.Timeout;
  private readonly forwarded = new Map<string, number>();
  constructor(private readonly cfg: ConfigService, private readonly db: DbService, private readonly leads: LeadsService, private readonly wa: WhatsAppService,
    private readonly usage: UsageService, @Optional() private readonly alerts?: AlertsService) {}

  get on() { return !!this.cfg.business; }
  private get b() { return this.cfg.business!; }
  private has(f: Funcion) { return this.on && this.b.funciones.includes(f); }

  async onModuleInit() {
    if (!this.on) return;
    try { this.ownerLast = Number((await this.db.query('SELECT value FROM meta WHERE key = $1', ['dueno_ultimo']))[0]?.value) || 0; } catch { /* base nueva */ }
    this.timer = setInterval(() => void this.remind().catch(() => undefined), 10 * 60_000); this.timer.unref();
  }
  onModuleDestroy() { clearInterval(this.timer); }

  // ---------- avisos al dueño del negocio ----------
  isOwner(phone: string) { return !!this.b.duenoWhatsapp && phone.replace(/\D/g, '') === this.b.duenoWhatsapp; }
  /** ¿Se le puede escribir texto libre al dueño ahora? (escribio en las ultimas 24 h) */
  windowOpen(now = Date.now()) { return !!this.b.duenoWhatsapp && this.wa.canSend && now - this.ownerLast < WINDOW_MS - 60_000; }
  windowInfo() { return { whatsapp: this.b.duenoWhatsapp ? `+${this.b.duenoWhatsapp}` : '', open: this.windowOpen(), last: this.ownerLast ? new Date(this.ownerLast).toISOString() : '', telegram: !!this.alerts?.enabled }; }

  /** El dueño le escribio al numero del negocio: se abre su ventana de 24 h. Devuelve la respuesta para el. */
  async ownerWrote(now = Date.now()): Promise<string> {
    this.ownerLast = now; this.reminded = 0;
    await this.db.query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', ['dueno_ultimo', String(now)]).catch(() => undefined);
    const news = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE status = 'nuevo'`).then((r) => Number(r[0]?.n) || 0).catch(() => 0);
    return `✅ Listo: por 24 horas te aviso aquí cada pedido, cita o cliente que pida hablar con una persona.${news ? ` Tienes ${news} sin atender en tu panel.` : ''} Mañana escríbeme "hola" de nuevo para seguir recibiendo los avisos.`;
  }

  /** Aviso al dueño: Telegram y, si su ventana esta abierta, WhatsApp. Devuelve por donde salio. */
  async notify(text: string): Promise<string[]> {
    const via: string[] = [];
    if (this.alerts?.enabled && !(await this.alerts.send(text))) via.push('telegram');
    if (this.windowOpen()) { try { await this.wa.sendText(this.b.duenoWhatsapp, text.slice(0, 3500)); via.push('whatsapp'); } catch (e) { this.log.warn(`aviso al dueño por WhatsApp: ${(e as Error).message}`); } }
    else if (this.b.duenoWhatsapp && this.alerts?.enabled && this.ownerLast && Date.now() - this.reminded > WINDOW_MS) {
      this.reminded = Date.now(); void this.alerts.send(`ℹ️ ${this.b.nombre}: tu ventana de WhatsApp está cerrada, así que los avisos solo llegan por aquí. Escríbele "hola" al número del negocio para volver a recibirlos por WhatsApp.`);
    }
    if (!via.length) this.log.warn(`aviso al dueño sin enviar (ni Telegram ni ventana de WhatsApp abierta): ${text.slice(0, 80)}`);
    return via;
  }

  /** Faltando menos de 2 horas para que se cierre la ventana (y de dia), se le recuerda una vez que escriba "hola". */
  async remind(now = Date.now()): Promise<boolean> {
    if (!this.on || !this.windowOpen(now) || this.reminded > this.ownerLast) return false;
    const left = WINDOW_MS - (now - this.ownerLast);
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: this.cfg.timezone, hour: '2-digit', hour12: false }).format(new Date(now))) % 24;
    if (left > 2 * 3600_000 || hour < 8 || hour >= 21) return false;
    this.reminded = now;
    await this.wa.sendText(this.b.duenoWhatsapp, `⏰ ${this.b.nombre}: en un rato WhatsApp deja de permitirme escribirte. Respóndeme "hola" para seguir recibiendo aquí los avisos de pedidos y citas.`).catch((e) => this.log.warn(`recordatorio al dueño: ${(e as Error).message}`));
    return true;
  }

  // ---------- pasar a una persona ----------
  async paused(phone: string, now = Date.now()): Promise<boolean> {
    const r = (await this.db.query<{ until_at: string }>('SELECT until_at FROM handoffs WHERE phone = $1', [phone]))[0];
    return !!r && Date.parse(r.until_at) > now;
  }
  async resume(phone: string) { await this.db.query('DELETE FROM handoffs WHERE phone = $1', [phone.replace(/\D/g, '')]); }
  pauses() { return this.db.query<{ phone: string; until_at: string; reason: string; name: string }>('SELECT * FROM handoffs WHERE until_at > $1 ORDER BY until_at', [new Date().toISOString()]); }
  /** Mientras el chat esta en manos de una persona, lo que escribe el cliente se le reenvia al dueño (uno cada 2 minutos por chat). */
  async forward(phone: string, name: string, text: string) {
    if (Date.now() - (this.forwarded.get(phone) ?? 0) < 120_000) return;
    this.forwarded.set(phone, Date.now());
    await this.notify(`💬 ${name || 'Cliente'} (+${phone}) sigue escribiendo (el asistente está en pausa): «${txt(text, 300)}»`);
  }

  // ---------- herramientas ----------
  definitions(): unknown[] {
    const d: unknown[] = [], fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => d.push({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
    if (this.has('pedidos')) fn('tomar_pedido', 'Registra un pedido del cliente y le avisa al negocio. Úsala SOLO después de repetirle el pedido completo (productos, cantidades, entrega) y de que la persona lo confirme. Los precios deben ser los del negocio; si un producto no tiene precio en su información, deja el precio vacío.',
      { productos: { type: 'array', items: { type: 'object', properties: { nombre: { type: 'string' }, cantidad: { type: 'number' }, precio: { type: 'number', description: 'Precio unitario según la información del negocio; omítelo si no está.' } }, required: ['nombre', 'cantidad'] } },
        nombre: { type: 'string', description: 'Nombre de quien pide.' }, contacto: { type: 'string', description: 'Teléfono de contacto que la persona confirmó (en el chat de WhatsApp se toma solo).' },
        entrega: { type: 'string', description: 'Recoge en el local, o la dirección de domicilio, y para cuándo.' }, notas: { type: 'string' }, confirmado: { type: 'boolean', description: 'true solo si la persona confirmó el pedido que le repetiste.' } }, ['productos', 'nombre', 'confirmado']);
    if (this.has('citas')) fn('agendar_cita', 'Registra una solicitud de cita o reserva y le avisa al negocio, que es quien la confirma. Úsala SOLO después de repetirle servicio, día y hora y de que la persona lo confirme. No prometas que la cita ya está confirmada.',
      { servicio: { type: 'string' }, fecha: { type: 'string', description: 'Día, como lo dijo la persona (por ejemplo "sábado 28").' }, hora: { type: 'string' }, nombre: { type: 'string' }, contacto: { type: 'string', description: 'Teléfono de contacto confirmado (en el chat de WhatsApp se toma solo).' }, notas: { type: 'string' },
        confirmado: { type: 'boolean' } }, ['servicio', 'fecha', 'nombre', 'confirmado']);
    if (this.has('interesados')) fn('guardar_interesado', 'Guarda los datos de una persona interesada para que el negocio la contacte. Úsala SOLO con su nombre, su contacto confirmado y su autorización para guardar los datos.',
      { nombre: { type: 'string' }, contacto: { type: 'string' }, interes: { type: 'string', description: 'Qué le interesa.' }, autoriza: { type: 'boolean', description: 'true solo si autorizó que guarden sus datos.' } }, ['nombre', 'interes', 'autoriza']);
    if (this.has('humano')) fn('pasar_a_humano', 'Avisa al negocio para que una persona atienda. Úsala cuando la persona lo pida, cuando haya una queja o un problema que no puedes resolver, o cuando pregunte algo importante que no está en la información del negocio.',
      { motivo: { type: 'string', description: 'Qué necesita la persona, en una frase.' }, nombre: { type: 'string' }, contacto: { type: 'string', description: 'Teléfono para devolverle la llamada (en el chat de WhatsApp se toma solo).' } }, ['motivo']);
    return d;
  }

  async run(name: string, rawArgs: string, ctx: DeskContext): Promise<{ text: string }> {
    let a: any; try { a = JSON.parse(rawArgs || '{}'); } catch { return { text: 'NO se guardó: los datos llegaron mal formados. Vuelve a intentarlo.' }; }
    const allowed = { tomar_pedido: 'pedidos', agendar_cita: 'citas', guardar_interesado: 'interesados', pasar_a_humano: 'humano' } as Record<string, Funcion>;
    if (!allowed[name] || !this.has(allowed[name])) return { text: 'Esa función no existe en este asistente.' };
    if ((ctx.counts[name] ?? 0) >= LIMITS[name]) return { text: 'NO se guardó: ya se registraron varios en esta conversación. Dile que el negocio ya tiene sus datos y lo contactará.' };
    // En WhatsApp el contacto es el numero desde el que escriben; en voz, el que la persona dicto y confirmo.
    const contact = ctx.channel === 'whatsapp' && ctx.phone ? `+${ctx.phone}` : txt(a.contacto, 40), who = txt(a.nombre, 80) || ctx.name || '';
    // Por voz la escucha puede perder un digito: un celular colombiano (empieza por 3) debe tener 10.
    const needContact = () => { const d = contact.replace(/\D/g, '').replace(/^57(?=3\d{9}$)/, '');
      if (d.length < 7) return 'NO se guardó: falta un teléfono de contacto. Pídeselo, repíteselo y vuelve a llamar la herramienta.';
      if (ctx.channel === 'voz' && d.startsWith('3') && d.length !== 10) return `NO se guardó: el celular parece incompleto (tiene ${d.length} dígitos y deben ser 10). Pídele que lo repita despacio, repíteselo dígito por dígito y vuelve a llamar la herramienta.`;
      return ''; };
    const save = async (kind: 'pedido' | 'cita', detail: string, when: string, total: number) => {
      const [row] = await this.db.query<Order>('INSERT INTO orders (at, kind, name, contact, detail, when_text, total, channel, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *', [new Date().toISOString(), kind, who, contact, detail, when, total, ctx.channel, txt(a.notas, 300)]);
      ctx.counts[name] = (ctx.counts[name] ?? 0) + 1; this.usage.add(kind === 'pedido' ? 'negocio_pedidos' : 'negocio_citas');
      return row;
    };
    try {
      if (name === 'tomar_pedido') {
        if (a.confirmado !== true) return { text: 'NO se guardó: primero repítele el pedido completo y espera a que lo confirme.' };
        const items = (Array.isArray(a.productos) ? a.productos : []).map((p: any) => ({ n: txt(p?.nombre, 80), q: Math.max(1, Math.min(999, Math.round(Number(p?.cantidad) || 1))), p: Number(p?.precio) > 0 ? Number(p.precio) : 0 })).filter((p: any) => p.n).slice(0, 20);
        if (!items.length || who.length < 2) return { text: 'NO se guardó: falta el nombre de la persona o los productos.' };
        const miss = needContact(); if (miss) return { text: miss };
        const total = items.every((i: any) => i.p) ? items.reduce((s: number, i: any) => s + i.p * i.q, 0) : 0;
        const detail = items.map((i: any) => `${i.q} × ${i.n}${i.p ? ` (${money(i.p)} c/u)` : ''}`).join('; ');
        const o = await save('pedido', detail, txt(a.entrega, 200), total);
        void this.notify(`🧾 Pedido #${o.id} — ${this.b.nombre}\n${who} (${contact})\n${detail}${total ? `\nTotal: ${money(total)}` : ''}${o.when_text ? `\nEntrega: ${o.when_text}` : ''}${o.notes ? `\nNotas: ${o.notes}` : ''}\nPor ${ctx.channel === 'whatsapp' ? 'WhatsApp' : 'el avatar de voz'}.`);
        return { text: `Pedido guardado con el número ${o.id}${total ? `, total ${money(total)}` : ''}. Ya se le avisó al negocio. Dile que quedó registrado y que el negocio lo confirma y coordina el pago y la entrega; no inventes tiempos de entrega.` };
      }
      if (name === 'agendar_cita') {
        if (a.confirmado !== true) return { text: 'NO se guardó: primero repítele servicio, día y hora y espera a que confirme.' };
        const servicio = txt(a.servicio, 120), when = [txt(a.fecha, 60), txt(a.hora, 40)].filter(Boolean).join(', ');
        if (!servicio || !when || who.length < 2) return { text: 'NO se guardó: falta el servicio, el día o el nombre.' };
        const miss = needContact(); if (miss) return { text: miss };
        const o = await save('cita', servicio, when, 0);
        void this.notify(`📅 Solicitud de cita #${o.id} — ${this.b.nombre}\n${who} (${contact})\n${servicio}\nPara: ${when}${o.notes ? `\nNotas: ${o.notes}` : ''}\nConfírmale tú la disponibilidad.`);
        return { text: `Solicitud de cita guardada con el número ${o.id}. Dile que quedó anotada y que el negocio le confirma la disponibilidad; NO digas que ya está confirmada.` };
      }
      if (name === 'guardar_interesado') {
        if (a.autoriza !== true) return { text: 'NO se guardó: falta su autorización para guardar los datos. Pídesela.' };
        if (who.length < 2) return { text: 'NO se guardó: falta el nombre.' };
        const miss = needContact(); if (miss) return { text: miss };
        const lead = await this.leads.add({ name: who, contact, company: '', interest: 'otro', detail: txt(a.interes, 400), source: ctx.channel === 'whatsapp' ? 'whatsapp' : 'voz' } as any);
        ctx.counts[name] = (ctx.counts[name] ?? 0) + 1;
        void this.notify(`👤 Interesado — ${this.b.nombre}\n${who} (${contact})\nLe interesa: ${txt(a.interes, 300)}`);
        return { text: `Guardado con el número ${lead.id}. Dile que el negocio lo contactará.` };
      }
      // pasar_a_humano
      const reason = txt(a.motivo, 300) || 'pidió hablar con una persona';
      if (ctx.channel === 'whatsapp' && ctx.phone) {
        const until = new Date(Date.now() + this.b.humanoMinutos * 60_000).toISOString();
        await this.db.query('INSERT INTO handoffs (phone, until_at, reason, name) VALUES ($1, $2, $3, $4) ON CONFLICT (phone) DO UPDATE SET until_at = excluded.until_at, reason = excluded.reason, name = excluded.name', [ctx.phone, until, reason, who]);
      } else { const miss = needContact(); if (miss) return { text: 'NO se avisó: para que una persona lo llame hace falta su nombre y un teléfono. Pídeselos y vuelve a llamar la herramienta.' }; }
      ctx.counts[name] = (ctx.counts[name] ?? 0) + 1; this.usage.add('negocio_humano');
      const via = await this.notify(`🙋 Piden atención de una persona — ${this.b.nombre}\n${who || 'Cliente'} (${contact || 'sin teléfono'})\nMotivo: ${reason}${ctx.channel === 'whatsapp' ? `\nEl asistente no responderá en ese chat durante ${this.b.humanoMinutos} minutos: escríbele tú desde WhatsApp Business.` : ''}`);
      return { text: via.length ? `Aviso enviado al negocio. Dile que una persona del negocio ${ctx.channel === 'whatsapp' ? 'le escribirá por este chat' : 'lo contactará'} en cuanto pueda${ctx.channel === 'whatsapp' ? '; después de decírselo no sigas respondiendo sobre ese tema' : ''}.` : 'No se pudo avisar al negocio en este momento. Dile que por favor se comunique directamente con el negocio.' };
    } catch (e) { this.log.error(`${name}: ${(e as Error).message}`); return { text: 'NO se guardó por un problema técnico. Discúlpate y dile que se comunique directamente con el negocio.' }; }
  }

  // ---------- panel del cliente ----------
  orders(limit = 200) { return this.db.query<Order>('SELECT * FROM orders ORDER BY id DESC LIMIT $1', [limit]); }
  async setStatus(id: number, status: string, notes?: string): Promise<boolean> {
    if (!['nuevo', 'atendido', 'cancelado'].includes(status)) return false;
    const cur = (await this.db.query<Order>('SELECT * FROM orders WHERE id = $1', [id]))[0]; if (!cur) return false;
    await this.db.query('UPDATE orders SET status = $1, notes = $2 WHERE id = $3', [status, notes === undefined ? cur.notes : txt(notes, 300), id]);
    return true;
  }
}
