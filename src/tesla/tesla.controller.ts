import { Controller, Delete, Get, HttpException, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '../config/config.service';
import { OwnerService } from '../owner/owner.service';
import { TeslaService } from './tesla.service';

/**
 * Conectar la cuenta de Tesla (mismo esquema que Spotify). Empezar, consultar y desconectar exigen un dispositivo del
 * dueño. La vuelta (`/api/tesla/callback`) no puede exigir la cookie (SameSite=Strict): la protege el `state` de un solo uso.
 */
@Controller()
export class TeslaController {
  constructor(private readonly tesla: TeslaService, private readonly owner: OwnerService, private readonly cfg: ConfigService) {}

  private require(req: Request) { if (!this.owner.verify(req.headers.cookie)) throw new HttpException({ error: 'no_autorizado' }, 401); }

  @Get('owner/tesla')
  status(@Req() req: Request) { this.require(req); return { ...this.tesla.status, fields: this.tesla.fields() }; }

  @Post('owner/tesla/connect')
  connect(@Req() req: Request) {
    this.require(req);
    if (!this.tesla.configured) throw new HttpException({ error: 'sin_configurar' }, 404);
    const host = String(req.headers.host ?? ''), local = !req.headers['x-forwarded-for'] && /^127\.0\.0\.1(:\d+)?$/.test(host);
    return { url: this.tesla.authUrl(local ? `http://${host}/api/tesla/callback` : this.cfg.teslaRedirectUri) };
  }

  @Delete('owner/tesla')
  async disconnect(@Req() req: Request) { this.require(req); await this.tesla.disconnect(); return { ok: true }; }

  @Get('api/tesla/callback')
  async callback(@Query('code') code: string | undefined, @Query('state') state: string | undefined, @Query('error') error: string | undefined, @Res() res: Response) {
    let result = 'ok';
    if (error || !code || !state) result = error === 'access_denied' || error === 'login_cancelled' ? 'cancelado' : 'error';
    else try { await this.tesla.finish(String(code), String(state)); } catch { result = 'error'; }
    res.redirect(302, `/dueno.html?tesla=${result}#dispositivos`);
  }
}
