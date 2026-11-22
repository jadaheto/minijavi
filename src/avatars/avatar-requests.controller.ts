import { Body, Controller, Get, Header, HttpCode, HttpException, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '../config/config.service';
import { OwnerService } from '../owner/owner.service';
import { AvatarRequestsService } from './avatar-requests.service';

const ipOf = (req: Request) => String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '').split(',').pop()!.trim();

/**
 * Avatar personalizado con foto, lado del cliente. Sin cookie: la solicitud se protege con el numero de WhatsApp de la demo
 * (para crearla) y con su clave al azar (para seguirla y subir el comprobante; es la que va en el QR).
 * Los archivos llegan como cuerpo crudo (application/octet-stream) y su tipo se comprueba por sus bytes.
 */
@Controller('demo/avatar-propio')
export class AvatarRequestsController {
  constructor(private readonly reqs: AvatarRequestsService, private readonly cfg: ConfigService) {}

  private async body(req: Request): Promise<Buffer> {
    const max = this.cfg.avatarPhotoMb * 1024 * 1024, chunks: Buffer[] = []; let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) { size += c.length; if (size > max) throw new HttpException({ ok: false, message: `El archivo pesa más de ${this.cfg.avatarPhotoMb} MB.` }, 413); chunks.push(c); }
    return Buffer.concat(chunks);
  }

  @Get('info')
  @Header('Cache-Control', 'no-store')
  info(@Query('d') d: string) { return this.reqs.info(String(d ?? '')); }

  @Post('solicitud')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async create(@Req() req: Request, @Query('d') d: string, @Query('autoriza') autoriza: string) {
    // El numero va en una cabecera, no en la direccion: las direcciones quedan en registros de servidores y proxys.
    const out = await this.reqs.create(String(d ?? ''), String(req.headers['x-whatsapp'] ?? '').slice(0, 24), await this.body(req), ipOf(req), autoriza === '1');
    if (!out.ok) throw new HttpException({ ok: false, message: out.message }, out.status);
    return out;
  }

  @Get('estado')
  @Header('Cache-Control', 'no-store')
  async status(@Query('t') t: string, @Query('qr') qr: string) {
    const v = await this.reqs.view(String(t ?? ''), qr === '1');
    if (!v) throw new HttpException({ ok: false, message: 'El enlace no es válido.' }, 404);
    return { ok: true, ...v };
  }

  @Post('foto')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async retake(@Req() req: Request, @Query('t') t: string) {
    const out = await this.reqs.retake(String(t ?? ''), await this.body(req), ipOf(req));
    if (!out.ok) throw new HttpException({ ok: false, message: out.message }, out.status);
    return out;
  }

  @Get('retrato')
  async portrait(@Query('t') t: string, @Res() res: Response) {
    const img = await this.reqs.portrait(String(t ?? ''));
    if (!img) throw new HttpException({ ok: false }, 404);
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('image/jpeg').send(img);
  }

  @Post('comprobante')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async proof(@Req() req: Request, @Query('t') t: string) {
    const out = await this.reqs.proof(String(t ?? ''), await this.body(req), ipOf(req));
    if (!out.ok) throw new HttpException({ ok: false, message: out.message }, out.status);
    return out;
  }
}

/** Avatar personalizado, lado de Javier: lista, decidir el pago y ver la foto o el comprobante. Solo dispositivo registrado. */
@Controller('owner/avatares')
export class AvatarOwnerController {
  constructor(private readonly reqs: AvatarRequestsService, private readonly owner: OwnerService) {}
  private require(req: Request) { if (!this.owner.verify(req.headers.cookie)) throw new HttpException({ error: 'no_autorizado' }, 401); }

  @Get()
  async list(@Req() req: Request) {
    this.require(req);
    // Ni la clave del cliente, ni la de los botones, ni la carpeta salen del servidor.
    return { problem: this.reqs.problem, items: (await this.reqs.list()).map(({ token, nonce, dir, proof_hash, consent_text, ...r }) => r) };
  }

  @Post(':id')
  async decide(@Req() req: Request, @Param('id') id: string, @Body() body: { decision?: string; motivo?: string }) {
    this.require(req);
    if (body?.decision === 'reintentar') { const t = await this.reqs.retry(Number(id) || 0); if (!t.ok) throw new HttpException({ error: 'no_aplica', message: t.text }, 409); return t; }
    if (body?.decision !== 'aprobar' && body?.decision !== 'rechazar') throw new HttpException({ error: 'decision_invalida' }, 400);
    const r = await this.reqs.decide(Number(id) || 0, body.decision === 'aprobar', 'panel', String(body.motivo ?? ''));
    if (!r.ok) throw new HttpException({ error: 'no_aplica', message: r.text }, 409);
    return r;
  }

  @Get(':id/:which')
  async file(@Req() req: Request, @Param('id') id: string, @Param('which') which: string, @Res() res: Response) {
    this.require(req);
    const f = which === 'foto' || which === 'comprobante' || which === 'retrato' ? await this.reqs.file(Number(id) || 0, which) : undefined;
    if (!f) throw new HttpException({ error: 'no_existe' }, 404);
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.type(f.mime).send(f.data);
  }
}
