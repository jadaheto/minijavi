import { Body, Controller, Get, Header, HttpException, Optional, Param, Post, Req, Res } from '@nestjs/common';
import type { Request } from 'express';
import { AVATARS } from '../business/business';
import { WorkshopService } from '../workshop/workshop.service';
import type { Response } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DemoDocsService } from './demo-docs.service';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const HEX = /^#[0-9a-f]{6}$/i;
/** Los colores del avatar personalizado, solo si son tres #rrggbb (o vacios). */
const tintMeta = (t?: { piel?: string; pelo?: string; ojos?: string }) => { const v = [t?.piel, t?.pelo, t?.ojos].map((x) => (HEX.test(String(x ?? '')) ? String(x).toLowerCase() : '')); return v.some(Boolean) ? `\n  <meta name="minijavi-demo-tinte" content="${v.join(',')}">` : ''; };
const WHY = { no_existe: 'Esta demostración no existe.', vencida: 'Esta demostración ya venció.', no_lista: 'Esta demostración todavía se está preparando. Intenta en un rato.', limite: 'Esta demostración llegó a su límite de uso de hoy. Vuelve mañana.' };

/**
 * B2: el enlace de la demo de un negocio (`/demo/<id>`). Es la misma pagina del avatar: el servidor le agrega `<base>`
 * (para que sus rutas relativas sigan apuntando a la raiz), noindex y el id de la demo; el navegador lo manda en el saludo
 * y el servidor arma la conversacion como asistente de ese negocio. Si la demo no se puede abrir, una pagina corta lo dice.
 */
@Controller('demo')
export class DemoPageController {
  private html?: string;
  constructor(private readonly docs: DemoDocsService, @Optional() private readonly workshop?: WorkshopService) {}

  @Get(':id')
  async page(@Param('id') id: string, @Res() res: Response) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    const p = await this.docs.page(String(id));
    if ('error' in p) {
      res.status(p.error === 'limite' || p.error === 'no_lista' ? 200 : 404).type('html');
      return res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Demostración</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1420;color:#eef2f8;font:17px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box;text-align:center}</style></head><body><main><h1>🤖</h1><p>${WHY[p.error]}</p></main></body></html>`);
    }
    this.html ??= readFileSync(join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
    const out = this.html
      .replace('<head>', `<head>\n  <base href="/">\n  <meta name="robots" content="noindex, nofollow">\n  <meta name="minijavi-demo" content="${esc(p.id)}">${p.config.imagen && /^[A-Za-z0-9._-]+$/.test(p.config.imagen) ? `\n  <meta name="minijavi-demo-image" content="/imagenes/${esc(p.config.imagen)}">` : ''}\n  <meta name="minijavi-demo-avatars" content="${AVATARS.join(',')}">${p.config.avatar && (AVATARS as readonly string[]).includes(p.config.avatar) ? `\n  <meta name="minijavi-demo-avatar" content="${p.config.avatar}">${tintMeta(p.config.tinte)}` : ''}${!p.config.imagen && p.config.portada && /^[a-z0-9-]+$/.test(p.config.portada) && this.workshop?.hasSite(p.config.portada) ? `\n  <meta name="minijavi-demo-portada" content="/p/${esc(p.config.portada)}/">` : ''}`)
      .replace(/<title>[^<]*<\/title>/, `<title>Asistente de ${esc(p.business)}</title>`);
    return res.type('html').send(out);
  }

  /**
   * Elegir el avatar del catalogo para esta demo. Lo puede hacer quien tenga el enlace (es solo la cara del asistente);
   * se guarda en la demo y no toca nada mas. Tope por IP para que no sirva de martillo contra la base.
   */
  private picks = new Map<string, { n: number; until: number }>();
  @Post(':id/avatar')
  @Header('Cache-Control', 'no-store')
  async avatar(@Param('id') id: string, @Body() body: { avatar?: unknown }, @Req() req: Request) {
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '').split(',').pop()!.trim(), now = Date.now();
    if (this.picks.size > 5000) for (const [k, v] of this.picks) if (v.until < now) this.picks.delete(k);
    const p = this.picks.get(ip); const cur = p && p.until > now ? p : { n: 0, until: now + 3600_000 };
    if (++cur.n > 30) throw new HttpException({ ok: false, message: 'Demasiados cambios. Intenta más tarde.' }, 429);
    this.picks.set(ip, cur);
    const avatar = String(body?.avatar ?? '');
    if (!(AVATARS as readonly string[]).includes(avatar)) throw new HttpException({ ok: false, message: 'Ese avatar no existe.' }, 400);
    if (!(await this.docs.setAvatar(String(id), avatar))) throw new HttpException({ ok: false, message: 'Esta demostración no está disponible.' }, 404);
    return { ok: true, avatar };
  }
}
