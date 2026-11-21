import { Controller, Get, Header, HttpCode, HttpException, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '../config/config.service';
import { DemoDocsService } from './demo-docs.service';

const ipOf = (req: Request) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').pop()!.trim();
const TOKEN = /^[0-9a-f]{32}$/;

/**
 * Subida del documento de una demo: desde la pantalla (boton) o desde el celular (pagina /subir.html con el QR).
 * El cuerpo es el archivo tal cual; el tipo se comprueba por sus bytes. Sin cookie: lo protege la clave de un solo uso.
 */
@Controller('demo/documento')
export class DemoDocsController {
  constructor(private readonly docs: DemoDocsService, private readonly cfg: ConfigService) {}

  @Post()
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async upload(@Req() req: Request, @Query('t') t: string, @Query('autoriza') autoriza: string) {
    if (!this.docs.enabled) throw new HttpException({ ok: false, message: 'La subida de documentos no está disponible.' }, 503);
    if (!TOKEN.test(String(t ?? ''))) throw new HttpException({ ok: false, message: 'Enlace inválido.' }, 400);
    const max = this.cfg.demoDocMb * 1024 * 1024, chunks: Buffer[] = []; let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) { size += c.length; if (size > max) throw new HttpException({ ok: false, message: `El archivo pesa más de ${this.cfg.demoDocMb} MB.` }, 413); chunks.push(c); }
    const out = await this.docs.receive(t, Buffer.concat(chunks), ipOf(req), autoriza === '1' || autoriza === 'true');
    if (!out.ok) throw new HttpException({ ok: false, message: out.message }, out.status);
    return { ok: true, message: out.message };
  }

  @Get('estado')
  @Header('Cache-Control', 'no-store')
  status(@Query('t') t: string) {
    const s = TOKEN.test(String(t ?? '')) ? this.docs.state(t) : undefined;
    if (!s) throw new HttpException({ ok: false, message: 'El enlace venció o no existe.' }, 404);
    return { ok: true, ...s };
  }
}
