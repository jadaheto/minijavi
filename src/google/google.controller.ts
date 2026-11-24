import { Controller, Delete, Get, HttpException, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { OwnerService } from '../owner/owner.service';
import { GoogleService } from './google.service';

/**
 * Conectar la cuenta de Google de Javier (solo lectura). Empezar, consultar y desconectar exigen un dispositivo del
 * dueño. La vuelta de Google (`/api/google/callback`) no puede exigir la cookie (es SameSite=Strict y no llega al volver
 * desde otro sitio): la protege el `state`, al azar, de un solo uso y de 10 minutos. No devuelve datos: redirige al panel.
 */
@Controller()
export class GoogleController {
  constructor(private readonly google: GoogleService, private readonly owner: OwnerService) {}
  private require(req: Request) { if (!this.owner.verify(req.headers.cookie)) throw new HttpException({ error: 'no_autorizado' }, 401); }

  @Get('owner/google')
  status(@Req() req: Request) { this.require(req); return this.google.status; }

  @Post('owner/google/connect')
  connect(@Req() req: Request) {
    this.require(req);
    if (!this.google.configured) throw new HttpException({ error: 'sin_configurar', message: this.google.problem }, 404);
    return { url: this.google.authUrl() };
  }

  @Delete('owner/google')
  async disconnect(@Req() req: Request) { this.require(req); await this.google.disconnect(); return { ok: true }; }

  @Get('api/google/callback')
  async callback(@Query('code') code: string | undefined, @Query('state') state: string | undefined, @Query('error') error: string | undefined, @Res() res: Response) {
    let result = 'ok', why = '';
    if (error || !code || !state) result = error === 'access_denied' ? 'cancelado' : 'error';
    else try { await this.google.finish(String(code), String(state)); } catch (e) { result = 'error'; why = String((e as Error).message ?? '').replace(/https?:\/\/\S+/g, '').slice(0, 160); }
    res.redirect(302, `/dueno.html?google=${result}${why ? `&motivo=${encodeURIComponent(why)}` : ''}#dispositivos`);
  }
}
