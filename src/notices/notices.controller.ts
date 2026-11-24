import { Body, Controller, Get, HttpException, Optional, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '../config/config.service';
import { OwnerService } from '../owner/owner.service';
import { Notice, NoticesService } from './notices.service';
import { ApprovalsService } from '../policy/approvals.service';
import { TeslaService, teslaCard } from '../tesla/tesla.service';
import { weatherNow } from '../tools/weather';
import { wrapLines } from '../gadget/tiles';

const ipOf = (req: Request) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').pop()!.trim();

/**
 * Un aviso, como tarjeta para la pantalla pequeña (el mismo formato de las demás tarjetas). `approval`: si el aviso es de
 * una solicitud que sigue pendiente, lo que se aprobaría; entonces la tarjeta se puede aprobar dejando el dedo (`hold`).
 * Los pagos de avatar NUNCA llevan `hold`: hay que mirar el comprobante contra la cuenta, y eso no cabe en esta pantalla.
 */
export function noticeTile(n: Notice, approval?: { what: string; who: string }): Record<string, unknown> {
  const lines = approval ? [approval.what, approval.who, 'Deja el dedo 2 s: aprobar'] : [n.body, 'Toca para que te lo cuente'];
  return { kind: 'notice', id: n.id, title: n.title, big: n.word, tone: n.tone, lines: lines.filter(Boolean), source: n.source, ...(approval ? { hold: true } : {}), ...(n.ref ? { ref: n.ref } : {}) };
}

/**
 * Avisos para el "Javi de bolsillo". La placa los pide con su pase (cabecera `Authorization: Bearer mjb.…`), sin abrir una
 * conversación: enchufada, deja la petición esperando y el aviso le llega al instante; con batería, pregunta cada pocos
 * minutos. Solo dispositivos del dueño: sin pase válido, 401 (y los intentos fallidos cuentan para el bloqueo).
 */
@Controller('api/placa')
export class NoticesController {
  constructor(private readonly notices: NoticesService, private readonly owner: OwnerService, private readonly cfg: ConfigService,
    @Optional() private readonly approvals?: ApprovalsService, @Optional() private readonly tesla?: TeslaService) {}

  private async tile(n: Notice) {
    const pending = n.ref?.kind === 'aprobacion' && this.approvals ? await this.approvals.brief(Number(n.ref.id)).catch(() => undefined) : undefined;
    return noticeTile(n, pending);
  }

  private auth(req: Request) {
    const ip = ipOf(req), wait = this.owner.blockedFor(ip);
    if (wait) throw new HttpException({ error: 'bloqueado', seconds: wait }, 429);
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization ?? ''));
    if (this.cfg.business || !m || !this.owner.verifyGadget(m[1], ip)) throw new HttpException({ error: 'pase' }, 401);
  }

  /** `desde`: último aviso que la placa ya tiene. `espera`: segundos que puede quedarse esperando uno nuevo (0 a 25). */
  @Get('avisos')
  async list(@Req() req: Request, @Query('desde') after = '0', @Query('espera') wait = '0') {
    this.auth(req);
    const ctrl = new AbortController(); req.on('close', () => ctrl.abort()); // la placa cortó: no se sigue esperando
    const list = await this.notices.wait(Number(after) || 0, Math.max(0, Math.min(25, Number(wait) || 0)) * 1000, ctrl.signal);
    return { quiet: this.notices.quiet(), seconds: this.cfg.gadgetNoticeSeconds, notices: await Promise.all(list.map((n) => this.tile(n))) };
  }

  @Post('avisos/vistos')
  async seen(@Req() req: Request, @Body() body: { ids?: unknown }) {
    this.auth(req);
    await this.notices.seen((Array.isArray(body?.ids) ? body.ids : []).map((x) => Number(x)));
    return { ok: true };
  }

  /**
   * Aprobar desde la placa (dejando el dedo 2 s sobre el aviso). Solo sirve para un aviso de una solicitud de la bandeja
   * de aprobaciones: se pide por el número del AVISO, no de la solicitud, así que no se puede aprobar algo que no llegó
   * como aviso. Pasa por la misma puerta que el panel y Telegram (solo cuenta la primera decisión). Rechazar no se hace
   * desde aquí: en el panel o en Telegram.
   */
  @Post('avisos/:id/aprobar')
  async approve(@Req() req: Request, @Param('id') id: string) {
    this.auth(req);
    const n = await this.notices.get(Number(id));
    if (!n || n.ref?.kind !== 'aprobacion' || !this.approvals) throw new HttpException({ error: 'no_aprobable' }, 404);
    const r = await this.approvals.decide(Number(n.ref.id), true, 'placa');
    await this.notices.seen([n.id]);
    // «Aprobada» no siempre es «enviada»: si quedó en espera, no salió o falló, la tarjeta lo dice en ámbar.
    const text = r.text.replace(/^Aprobada[.,]?\s*(pero\s+)?/i, '').replace(/^./, (c) => c.toUpperCase());
    const sentOk = r.ok && /^Aprobada y enviada/.test(r.text);
    return { ok: r.ok, text: r.text, seconds: 12, tile: { kind: 'notice', id: n.id, title: r.ok ? 'Aprobada' : 'No se aprobó', big: sentOk ? 'Listo' : r.ok ? 'Ojo' : 'No', tone: sentOk ? 'ok' : 'warn', lines: wrapLines(sentOk ? 'Se envió.' : r.ok ? text || 'Quedó aprobada.' : r.text, 30, 3) } };
  }

  // ---------- reloj de reposo ----------
  private clockWeather?: { at: number; value: { temp: number; desc: string } | null };
  private clockTesla?: { at: number; value: { level: number; charging: boolean } | null };

  /**
   * Lo que muestra la placa cuando nadie le habla: hora, fecha, clima y batería del carro. La placa no tiene reloj propio:
   * toma la hora de aquí y sigue contando sola. El clima se consulta como mucho cada 20 min y el Tesla cada
   * `RELOJ_TESLA_MIN` (120; 0 = sin Tesla), nunca en el horario silencioso y sin despertar el carro.
   */
  @Get('reposo')
  async clock(@Req() req: Request) {
    this.auth(req);
    const now = Date.now(), tz = this.cfg.timezone;
    // Clima y carro se refrescan por detrás: la placa no espera por ellos (solo un momento la primera vez). Si una
    // consulta falla se conserva lo anterior y se reintenta a los 2 minutos.
    const RETRY = 2 * 60_000, jobs: Promise<unknown>[] = [];
    if (!this.clockWeather || now - this.clockWeather.at > 20 * 60_000) {
      const slot = (this.clockWeather = { at: now, value: this.clockWeather?.value ?? null });
      jobs.push(weatherNow(this.cfg.defaultCity).then((w) => { if (w) slot.value = { temp: w.temp, desc: w.desc.replace(/^./, (c) => c.toUpperCase()).slice(0, 22) }; else slot.at = now - 20 * 60_000 + RETRY; }).catch(() => { slot.at = now - 20 * 60_000 + RETRY; }));
    }
    const every = this.cfg.clockTeslaMinutes;
    if (every > 0 && this.tesla?.connected && !this.notices.quiet() && (!this.clockTesla || now - this.clockTesla.at > every * 60_000)) {
      const slot = (this.clockTesla = { at: now, value: this.clockTesla?.value ?? null });
      jobs.push(this.tesla.report().then((r) => { const c = teslaCard(r) as { level?: number; charging?: string }; if (typeof c.level === 'number') slot.value = { level: Math.round(c.level), charging: c.charging === 'Charging' }; }).catch(() => { slot.at = now - every * 60_000 + Math.max(RETRY, 15 * 60_000); })); // el carro, con más calma: cada consulta cuenta
    }
    const first = (jobs.length && !this.clockWeather.value) || (every > 0 && this.tesla?.connected && this.clockTesla && !this.clockTesla.value && jobs.length);
    if (first) await Promise.race([Promise.all(jobs), new Promise((ok) => setTimeout(ok, 3000))]);
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
    const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const date = new Intl.DateTimeFormat('es-CO', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(now));
    return { now, offset: Math.round((local - now) / 60_000), date: date.replace(/^./, (c) => c.toUpperCase()), quiet: this.notices.quiet(), weather: this.clockWeather.value, tesla: every > 0 ? this.clockTesla?.value ?? null : null };
  }
}
