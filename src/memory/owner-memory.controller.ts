import { Body, Controller, Get, Header, HttpException, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { OwnerService } from '../owner/owner.service';
import { OwnerMemoryService, SECTION_LABEL, SECTIONS } from './owner-memory.service';

/** La memoria del dueño en el panel: verla, agregar, corregir, aprobar lo propuesto y borrar. Solo dispositivo registrado. */
@Controller('owner/memoria')
export class OwnerMemoryController {
  constructor(private readonly memory: OwnerMemoryService, private readonly owner: OwnerService) {}
  private require(req: Request) { if (!this.owner.verify(req.headers.cookie)) throw new HttpException({ error: 'no_autorizado' }, 401); }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() req: Request) {
    this.require(req);
    return { enabled: this.memory.enabled, used: this.memory.used, max: this.memory.max, sections: SECTIONS.map((id) => ({ id, label: SECTION_LABEL[id] })), items: this.memory.list() };
  }

  @Post()
  async add(@Req() req: Request, @Body() body: { text?: unknown; section?: unknown }) {
    this.require(req);
    const r = await this.memory.add(body?.text, body?.section, 'panel');
    if (!r.ok) throw new HttpException({ ok: false, message: `No se guardó: ${r.reason}.` }, 400);
    return { ok: true, id: r.item.id, repeated: !!r.repeated, moved: r.moved.length };
  }

  @Post(':id')
  async act(@Req() req: Request, @Param('id') id: string, @Body() body: { accion?: string; text?: unknown; section?: unknown }) {
    this.require(req);
    const n = Number(id), action = String(body?.accion ?? '');
    if (!Number.isInteger(n) || n <= 0) throw new HttpException({ ok: false, message: 'Ese recuerdo no existe.' }, 404);
    if (action === 'borrar') { if (!(await this.memory.remove(n))) throw new HttpException({ ok: false, message: 'Ese recuerdo no existe.' }, 404); return { ok: true }; }
    if (!['aprobar', 'cambiar'].includes(action)) throw new HttpException({ ok: false, message: 'Acción desconocida.' }, 400);
    const r = await this.memory.change(n, action === 'aprobar' ? { approve: true } : { ...(body.text !== undefined ? { text: body.text } : {}), ...(body.section !== undefined ? { section: body.section } : {}) });
    if (!r.ok) throw new HttpException({ ok: false, message: `No se pudo: ${r.reason}.` }, r.reason === 'ese recuerdo no existe' ? 404 : 400);
    return { ok: true, moved: r.moved.length };
  }
}
