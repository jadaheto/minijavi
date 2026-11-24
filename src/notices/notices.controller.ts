import { Body, Controller, Get, HttpException, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '../config/config.service';
import { OwnerService } from '../owner/owner.service';
import { Notice, NoticesService } from './notices.service';

const ipOf = (req: Request) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').pop()!.trim();

/** Un aviso, como tarjeta para la pantalla pequeña (el mismo formato de las demás tarjetas). */
export function noticeTile(n: Notice): Record<string, unknown> {
  const when = new Date(n.at);
  return { kind: 'notice', id: n.id, title: n.title, big: n.word, tone: n.tone, lines: [n.body, Number.isNaN(when.getTime()) ? '' : `Toca para que te lo cuente`].filter(Boolean), source: n.source, ...(n.ref ? { ref: n.ref } : {}) };
}

/**
 * Avisos para el "Javi de bolsillo". La placa los pide con su pase (cabecera `Authorization: Bearer mjb.…`), sin abrir una
 * conversación: enchufada, deja la petición esperando y el aviso le llega al instante; con batería, pregunta cada pocos
 * minutos. Solo dispositivos del dueño: sin pase válido, 401 (y los intentos fallidos cuentan para el bloqueo).
 */
@Controller('api/placa')
export class NoticesController {
  constructor(private readonly notices: NoticesService, private readonly owner: OwnerService, private readonly cfg: ConfigService) {}

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
    return { quiet: this.notices.quiet(), seconds: this.cfg.gadgetNoticeSeconds, notices: list.map(noticeTile) };
  }

  @Post('avisos/vistos')
  async seen(@Req() req: Request, @Body() body: { ids?: unknown }) {
    this.auth(req);
    await this.notices.seen((Array.isArray(body?.ids) ? body.ids : []).map((x) => Number(x)));
    return { ok: true };
  }
}
