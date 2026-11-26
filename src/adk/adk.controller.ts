import { Body, Controller, Get, Header, HttpCode, HttpException, Optional, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '../config/config.service';
import { OwnerService } from '../owner/owner.service';
import { STOP_TEXT } from '../workshop/gates';
import { WorkshopService } from '../workshop/workshop.service';
import { AdkTasksService } from './adk-tasks.service';

const TOKEN = /^[0-9a-f]{32}$/;

/**
 * Subida del PDF del flujo de una tarea de ADK (enlace de un solo uso que el avatar le muestra a Javier, como boton o
 * QR; no lleva cookie porque tambien se abre desde el celular: la protege la clave, que solo se entrega en una sesion
 * del dueño) y la lista de tareas para el panel (dispositivo registrado).
 */
@Controller()
export class AdkController {
  constructor(private readonly adk: AdkTasksService, private readonly cfg: ConfigService, private readonly owner: OwnerService, @Optional() private readonly workshop?: WorkshopService) {}
  private require(req: Request) { if (!this.owner.verify(req.headers.cookie)) throw new HttpException({ error: 'no_autorizado' }, 401); }

  @Post('api/adk/flujo')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async upload(@Req() req: Request, @Query('t') t: string) {
    if (!this.adk.enabled || !TOKEN.test(String(t ?? '')) || !this.adk.state(t)) throw new HttpException({ ok: false, message: 'El enlace venció o no existe.' }, 404);
    const max = this.cfg.adkFlowMb * 1024 * 1024, chunks: Buffer[] = []; let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) { size += c.length; if (size > max) throw new HttpException({ ok: false, message: `El archivo pesa más de ${this.cfg.adkFlowMb} MB.` }, 413); chunks.push(c); }
    const out = await this.adk.receive(t, Buffer.concat(chunks));
    if (!out.ok) throw new HttpException({ ok: false, message: out.message }, out.status);
    return { ok: true, message: out.message };
  }

  @Get('api/adk/flujo/estado')
  @Header('Cache-Control', 'no-store')
  status(@Query('t') t: string) {
    const s = TOKEN.test(String(t ?? '')) ? this.adk.state(t) : undefined;
    if (!s) throw new HttpException({ ok: false, message: 'El enlace venció o no existe.' }, 404);
    return { ok: true, ...s };
  }

  /** Tareas de ADK vistas en Plane, para la pestaña «Agentes ADK» del panel: en que va cada una, su ficha y como le fue al taller. */
  @Get('owner/adk')
  @Header('Cache-Control', 'no-store')
  list(@Req() req: Request) {
    this.require(req);
    const projects = this.workshop?.list() ?? [];
    return { enabled: this.adk.enabled, canRead: this.adk.canRead, canTest: this.adk.canTest, buildProblem: this.adk.enabled ? this.adk.buildProblem : '', label: this.cfg.adkLabel, everyMin: this.cfg.adkCheckMin, minutes: this.cfg.adkMinutes,
      lastScan: this.adk.lastScan ? new Date(this.adk.lastScan).toISOString() : '', problem: this.adk.lastError,
      tasks: this.adk.list().map((t) => {
        const p = t.slug ? projects.find((x) => x.slug === t.slug) : undefined, r = p?.run;
        return { id: t.id, key: t.key, name: t.name, project: t.project, due: t.due, status: t.status, seen_at: t.seen_at, agent: t.agent, summary: t.summary, spec: t.spec.slice(0, 6000), spec_at: t.spec_at, slug: t.slug, comment_at: t.comment_at,
          comment: t.status === 'hecha' && !t.comment_at && t.slug ? this.adk.commentText(t) : '',
          work: p ? { name: p.name, status: p.status, model: p.model ?? '', stop: r?.stop ?? '', stopText: r ? STOP_TEXT[r.stop] : '', passes: r?.passes ?? 0, seconds: r?.seconds ?? 0, gates: (r?.gates ?? []).map((g) => ({ label: g.label, ok: g.ok })), summary: String(p.lastSummary ?? '').slice(0, 3000), download: `./owner/projects/${p.slug}/descargar` } : null };
      }).reverse() };
  }

  /** Mirar Plane ahora, sin esperar a la proxima vuelta. */
  @Post('owner/adk/revisar')
  async scan(@Req() req: Request) {
    this.require(req);
    const r = await this.adk.scan();
    if (r.error) throw new HttpException({ ok: false, message: `No se pudo revisar Plane: ${r.error}.` }, 502);
    return { ok: true, found: r.found, fresh: r.fresh.length };
  }

  /**
   * Lo que se puede hacer con una tarea desde el panel: descartarla, recuperarla, o dejar el comentario en Plane (el
   * clic de Javier es su «sí»; el texto lo arma el servidor). Construir se pide por voz: necesita el PDF y su confirmacion.
   */
  @Post('owner/adk/:id')
  async act(@Req() req: Request, @Param('id') id: string, @Body() body: { accion?: string }) {
    this.require(req);
    const t = this.adk.list().find((x) => x.id === String(id)), action = String(body?.accion ?? '');
    if (!t) throw new HttpException({ ok: false, message: 'Esa tarea no existe.' }, 404);
    if (action === 'descartar') { if (t.status === 'en_curso') throw new HttpException({ ok: false, message: 'El taller la está construyendo: cancela el encargo primero.' }, 409); await this.adk.setStatus(t.id, 'descartada'); return { ok: true, message: 'Descartada: no se vuelve a avisar.' }; }
    if (action === 'recuperar') { if (t.status !== 'descartada') throw new HttpException({ ok: false, message: 'Esa tarea no está descartada.' }, 409); const built = !!t.slug && this.workshop?.list().find((x) => x.slug === t.slug)?.status === 'libre'; // ya estaba construida: vuelve a «construidos»
      await this.adk.setStatus(t.id, built ? 'hecha' : t.spec ? 'aceptada' : 'nueva'); return { ok: true, message: built ? 'Recuperada.' : 'Volvió a las pendientes.' }; }
    if (action === 'comentar') { const out = await this.adk.comment(t); if (!/^Comentario agregado/.test(out)) throw new HttpException({ ok: false, message: out.replace(/ Díselo.*$/, '') }, 409); return { ok: true, message: `Comentario agregado a ${t.key} en Plane.` }; }
    throw new HttpException({ ok: false, message: 'Acción desconocida.' }, 400);
  }
}
