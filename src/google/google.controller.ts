import { Controller, Delete, Get, HttpException, Param, Post, Query, Req, Res } from '@nestjs/common';
import * as QRCode from 'qrcode';
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
  async status(@Req() req: Request) {
    this.require(req);
    const st = this.google.status;
    return st.connected ? { ...st, created: await this.google.created(8).catch(() => []), createdToday: await this.google.createdToday().catch(() => undefined) } : st;
  }

  /**
   * Lo que el avatar ha creado en el Drive de Javier (documentos, hojas y presentaciones), para la seccion «Creados» del
   * panel: titulo, tipo, fecha, de donde salio, lo que se le agrego despues, su enlace y un QR para abrirlo en el celular.
   * Solo muestra: desde aqui no se borra ni se cambia nada.
   */
  @Get('owner/google/creados')
  async createdFiles(@Req() req: Request) {
    this.require(req);
    const st = this.google.status, path: Record<string, string> = { documento: 'document', hoja: 'spreadsheets', presentacion: 'presentation' };
    const files = await Promise.all((await this.google.createdFiles(100)).map(async (f) => {
      const link = `https://docs.google.com/${path[f.kind]}/d/${encodeURIComponent(f.id)}/edit`;
      return { ...f, link, qr: await QRCode.toDataURL(link, { margin: 1, width: 240, errorCorrectionLevel: 'M' }).catch(() => undefined), thumb: f.kind === 'presentacion' && st.connected };
    }));
    return { configured: st.configured, connected: st.connected, canCreate: this.google.has('crear'), today: await this.google.createdToday().catch(() => undefined), files };
  }

  /** La miniatura de la portada de una presentacion creada por el avatar. La baja el servidor; la direccion de Google no sale de aqui. */
  @Get('owner/google/creados/:id/miniatura')
  async thumbnail(@Req() req: Request, @Param('id') id: string, @Res() res: Response) {
    this.require(req);
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(String(id))) throw new HttpException({ error: 'no_existe' }, 404);
    let buf: Buffer; try { buf = await this.google.thumbnail(String(id)); } catch { throw new HttpException({ error: 'sin_miniatura' }, 404); }
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' }).send(buf);
  }

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
