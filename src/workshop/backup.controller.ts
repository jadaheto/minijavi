import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { WorkshopBackupService } from './backup.service';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Entrada del respaldo del taller: Claude Code (formato Anthropic Messages) -> modelo capaz. Solo responde a la propia
 * maquina (lo que llega por el proxy de Easypanel trae otra direccion o la cabecera X-Forwarded-For) y con la clave
 * temporal de un encargo en curso. Para cualquier otro, la ruta no existe (404).
 */
@Controller('taller-llm')
export class WorkshopBackupController {
  constructor(private readonly backup: WorkshopBackupService) {}

  @Post('v1/messages')
  async messages(@Req() req: Request, @Res() res: Response, @Body() body: any) {
    const auth = String(req.headers.authorization ?? ''), token = String(req.headers['x-api-key'] ?? '') || (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '');
    if (!LOOPBACK.has(String(req.socket.remoteAddress)) || req.headers['x-forwarded-for'] || !token || !this.backup.valid(token)) { res.status(404).json({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }); return; }
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    let ping: NodeJS.Timeout | undefined;
    await this.backup.handle(body, {
      head: (status, sse) => {
        res.status(status);
        if (!sse) return;
        res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
        // Mientras el modelo razona no llega nada: un ping mantiene viva la conexion.
        ping = setInterval(() => { if (!res.writableEnded) res.write('event: ping\ndata: {"type":"ping"}\n\n'); }, 10_000);
      },
      sse: (e) => { if (!res.writableEnded) res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`); },
      json: (v) => { if (!res.writableEnded) res.json(v); },
    }, abort.signal).catch(() => undefined);
    clearInterval(ping);
    if (!res.writableEnded) res.end();
  }
}
