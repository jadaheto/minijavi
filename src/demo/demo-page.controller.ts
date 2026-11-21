import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DemoDocsService } from './demo-docs.service';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const WHY = { no_existe: 'Esta demostración no existe.', vencida: 'Esta demostración ya venció.', no_lista: 'Esta demostración todavía se está preparando. Intenta en un rato.', limite: 'Esta demostración llegó a su límite de uso de hoy. Vuelve mañana.' };

/**
 * B2: el enlace de la demo de un negocio (`/demo/<id>`). Es la misma pagina del avatar: el servidor le agrega `<base>`
 * (para que sus rutas relativas sigan apuntando a la raiz), noindex y el id de la demo; el navegador lo manda en el saludo
 * y el servidor arma la conversacion como asistente de ese negocio. Si la demo no se puede abrir, una pagina corta lo dice.
 */
@Controller('demo')
export class DemoPageController {
  private html?: string;
  constructor(private readonly docs: DemoDocsService) {}

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
      .replace('<head>', `<head>\n  <base href="/">\n  <meta name="robots" content="noindex, nofollow">\n  <meta name="minijavi-demo" content="${esc(p.id)}">${p.config.imagen && /^[A-Za-z0-9._-]+$/.test(p.config.imagen) ? `\n  <meta name="minijavi-demo-image" content="/imagenes/${esc(p.config.imagen)}">` : ''}`)
      .replace(/<title>[^<]*<\/title>/, `<title>Asistente de ${esc(p.business)}</title>`);
    return res.type('html').send(out);
  }
}
