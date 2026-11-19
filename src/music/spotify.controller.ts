import { Controller, Delete, Get, HttpException, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '../config/config.service';
import { OwnerService } from '../owner/owner.service';
import { SpotifyService } from './spotify.service';

/**
 * Conectar la cuenta de Spotify. Empezar y desconectar exigen un dispositivo del dueño. La vuelta de Spotify
 * (`/api/spotify/callback`, la direccion registrada por Javier) NO puede exigir la cookie del dueño: es SameSite=Strict y
 * el navegador no la envia al volver desde otro sitio. La protege el `state`: al azar, de un solo uso, vale 10 minutos y
 * solo se le entrega a un dispositivo registrado.
 */
@Controller()
export class SpotifyController {
  constructor(private readonly spotify: SpotifyService, private readonly owner: OwnerService, private readonly cfg: ConfigService) {}

  private require(req: Request) { if (!this.owner.verify(req.headers.cookie)) throw new HttpException({ error: 'no_autorizado' }, 401); }

  @Get('owner/spotify')
  status(@Req() req: Request) { this.require(req); return this.spotify.status; }

  @Post('owner/spotify/connect')
  connect(@Req() req: Request) {
    this.require(req);
    if (!this.spotify.configured) throw new HttpException({ error: 'sin_configurar' }, 404);
    // En local (sin proxy delante y entrando por 127.0.0.1) se vuelve a esta misma maquina; Spotify solo acepta http en
    // esa direccion exacta (no en "localhost") y tiene que estar registrada en su panel.
    const host = String(req.headers.host ?? ''), local = !req.headers['x-forwarded-for'] && /^127\.0\.0\.1(:\d+)?$/.test(host);
    return { url: this.spotify.authUrl(local ? `http://${host}/api/spotify/callback` : this.cfg.spotifyRedirectUri) };
  }

  @Delete('owner/spotify')
  async disconnect(@Req() req: Request) { this.require(req); await this.spotify.disconnect(); return { ok: true }; }

  @Get('api/spotify/callback')
  async callback(@Query('code') code: string | undefined, @Query('state') state: string | undefined, @Query('error') error: string | undefined, @Res() res: Response) {
    let result = 'ok';
    if (error || !code || !state) result = error === 'access_denied' ? 'cancelado' : 'error';
    else try { await this.spotify.finish(String(code), String(state)); } catch { result = 'error'; }
    res.redirect(302, `/dueno.html?spotify=${result}#dispositivos`);
  }
}
