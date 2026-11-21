import { Body, Controller, Get, Header, HttpCode, HttpException, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import { LeadsService } from '../leads/leads.service';
import { BusinessService } from './business.service';
import { BusinessDeskService } from './desk.service';

const ipOf = (req: Request) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').pop()!.trim();
const COOKIE = 'negocio_panel', DAYS = 30;

/**
 * Panel del cliente en modo negocio (`/negocio.html`): sus pedidos, citas, interesados y chats en pausa. Entra con la
 * clave NEGOCIO_PANEL_CLAVE (la define Javier al instalar); queda una cookie firmada HttpOnly por 30 dias. 5 intentos
 * fallidos por direccion cada 15 minutos. Solo existe en modo negocio y con clave configurada.
 */
@Controller('negocio/panel')
export class BusinessPanelController {
  private readonly fails = new Map<string, number[]>();
  constructor(private readonly cfg: ConfigService, private readonly biz: BusinessService, private readonly desk: BusinessDeskService, private readonly leads: LeadsService) {}

  private sign(exp: number) { return createHmac('sha256', this.cfg.businessPanelKey).update(`panel.${exp}`).digest('hex'); }
  private require(req: Request) {
    if (!this.biz.on || !this.cfg.businessPanelKey) throw new HttpException({ error: 'no_existe' }, 404);
    const raw = /(?:^|;\s*)negocio_panel=([^;]+)/.exec(String(req.headers.cookie ?? ''))?.[1] ?? '', [exp, mac] = decodeURIComponent(raw).split('.');
    const want = Buffer.from(this.sign(Number(exp))), got = Buffer.from(String(mac ?? ''));
    if (!(Number(exp) > Date.now()) || want.length !== got.length || !timingSafeEqual(want, got)) throw new HttpException({ error: 'sin_sesion' }, 401);
  }

  @Post('entrar')
  @HttpCode(200)
  login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: { clave?: string }) {
    if (!this.biz.on || !this.cfg.businessPanelKey) throw new HttpException({ error: 'no_existe' }, 404);
    const ip = ipOf(req), now = Date.now(), list = (this.fails.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    if (list.length >= 5) throw new HttpException({ error: 'bloqueado', message: 'Demasiados intentos. Espera 15 minutos.' }, 429);
    const a = Buffer.from(String(body?.clave ?? '')), b = Buffer.from(this.cfg.businessPanelKey);
    if (a.length !== b.length || !timingSafeEqual(a, b)) { list.push(now); this.fails.set(ip, list); throw new HttpException({ error: 'clave', message: 'Clave incorrecta.' }, 401); }
    const exp = now + DAYS * 86400_000, https = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(`${exp}.${this.sign(exp)}`)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${DAYS * 86400}${https ? '; Secure' : ''}`);
    return { ok: true };
  }

  @Get('datos')
  @Header('Cache-Control', 'no-store')
  async data(@Req() req: Request) {
    this.require(req);
    const orders = await this.desk.orders();
    return { negocio: this.biz.config.nombre, funciones: this.biz.config.funciones, avisos: this.desk.windowInfo(),
      pedidos: orders.filter((o) => o.kind === 'pedido'), citas: orders.filter((o) => o.kind === 'cita'),
      interesados: (await this.leads.list(200)).map((l) => ({ id: l.id, at: l.created_at, name: l.name, contact: l.contact, detail: l.detail, status: l.status, source: l.source })),
      pausas: await this.desk.pauses() };
  }

  @Post('pedidos/:id')
  @HttpCode(200)
  async setOrder(@Req() req: Request, @Param('id') id: string, @Body() body: { estado?: string; notas?: string }) {
    this.require(req);
    if (!(await this.desk.setStatus(Number(id), String(body?.estado ?? ''), body?.notas))) throw new HttpException({ error: 'invalido' }, 400);
    return { ok: true };
  }

  /** El dueño ya atendio ese chat: el asistente vuelve a responder ahi. */
  @Post('pausas/:phone/quitar')
  @HttpCode(200)
  async resume(@Req() req: Request, @Param('phone') phone: string) { this.require(req); await this.desk.resume(String(phone)); return { ok: true }; }
}
