import { Body, Controller, Get, Header, HttpCode, HttpException, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '../config/config.service';
import { GoogleService } from '../google/google.service';
import { OwnerService } from '../owner/owner.service';
import { KnowledgeDocsService } from './knowledge-docs.service';

const TOKEN = /^[0-9a-f]{32}$/;

/**
 * Subida de un documento de conocimiento (el enlace de un solo uso que el avatar le muestra a Javier, como boton o QR) y
 * su manejo desde el panel. La subida no lleva cookie (se abre tambien desde el celular): la protege la clave de un solo
 * uso, que solo se entrega en una sesion del dueño. Lo del panel exige un dispositivo registrado.
 */
@Controller()
export class KnowledgeDocsController {
  constructor(private readonly docs: KnowledgeDocsService, private readonly cfg: ConfigService, private readonly owner: OwnerService, private readonly google: GoogleService) {}
  private require(req: Request) { if (!this.owner.verify(req.headers.cookie)) throw new HttpException({ error: 'no_autorizado' }, 401); }

  @Post('api/conocimiento/documento')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async upload(@Req() req: Request, @Query('t') t: string) {
    if (!this.docs.enabled) throw new HttpException({ ok: false, message: 'La subida de documentos no está disponible.' }, 503);
    if (!TOKEN.test(String(t ?? '')) || !this.docs.state(t)) throw new HttpException({ ok: false, message: 'El enlace venció o no existe.' }, 404);
    const max = this.cfg.knowDocMb * 1024 * 1024, chunks: Buffer[] = []; let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) { size += c.length; if (size > max) throw new HttpException({ ok: false, message: `El archivo pesa más de ${this.cfg.knowDocMb} MB.` }, 413); chunks.push(c); }
    const out = await this.docs.receive(t, Buffer.concat(chunks));
    if (!out.ok) throw new HttpException({ ok: false, message: out.message }, out.status);
    return { ok: true, message: out.message };
  }

  @Get('api/conocimiento/documento/estado')
  @Header('Cache-Control', 'no-store')
  status(@Query('t') t: string) {
    const s = TOKEN.test(String(t ?? '')) ? this.docs.state(t) : undefined;
    if (!s) throw new HttpException({ ok: false, message: 'El enlace venció o no existe.' }, 404);
    return { ok: true, ...s };
  }

  /** Los documentos, para la seccion «Conocimiento» del panel. El texto no viaja: solo la ficha de cada uno. */
  @Get('owner/conocimiento')
  list(@Req() req: Request) {
    this.require(req);
    const link = (id: string, kind: 'document' | 'file') => (id ? `https://${kind === 'document' ? 'docs' : 'drive'}.google.com/${kind}/d/${encodeURIComponent(id)}/${kind === 'document' ? 'edit' : 'view'}` : '');
    return { enabled: this.docs.enabled, problem: this.docs.problem, max: this.cfg.knowDocMax, syncMin: this.cfg.knowSyncMin, google: this.google.connected, canCreate: this.google.has('crear'),
      docs: this.docs.list().map((d) => ({ ...d, link: link(d.doc_id, 'document'), original: link(d.file_id, 'file') })) };
  }

  @Post('owner/conocimiento/sincronizar')
  async syncAll(@Req() req: Request) { this.require(req); return this.docs.sync(); }

  @Post('owner/conocimiento/:id')
  async act(@Req() req: Request, @Param('id') id: string, @Body() body: { accion?: string; alcance?: string }) {
    this.require(req);
    const n = Number(id), scope = body?.alcance === 'publico' ? 'publico' : 'privado';
    if (!Number.isInteger(n) || !this.docs.list().some((d) => d.id === n)) throw new HttpException({ error: 'no_existe' }, 404);
    try {
      if (body?.accion === 'guardar') { const r = await this.docs.confirm(n, scope); return { ok: true, drive: r.drive, note: r.note }; }
      if (body?.accion === 'alcance') { await this.docs.setScope(n, scope); return { ok: true }; }
      if (body?.accion === 'sincronizar') return { ok: true, ...(await this.docs.sync(n)) };
      if (body?.accion === 'quitar') { await this.docs.remove(n); return { ok: true }; }
    } catch (e) { throw new HttpException({ error: 'fallo', message: String((e as Error).message).slice(0, 200) }, 409); }
    throw new HttpException({ error: 'accion_desconocida' }, 400);
  }
}
