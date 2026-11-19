import { Body, Controller, Delete, Get, HttpException, Param, Patch, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import type { Request, Response } from 'express';
import { LeadsService, STATUSES } from '../leads/leads.service';
import { OWNER_COOKIE, OwnerService } from './owner.service';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import * as QRCode from 'qrcode';
import { WorkshopService } from '../workshop/workshop.service';
import { UsageService } from '../usage/usage.service';
import { ImagesService } from '../images/images.service';
import { DecisionsService } from '../decisions/decisions.service';
import { Kind, KINDS, QUESTIONS } from '../decisions/questions';
import { SettingsService } from '../settings/settings.service';
import { OptOutService } from '../security/optout.service';
import { CapableModelService } from '../llm/capable.service';
import { ACTION_KINDS, ActionsService } from '../policy/actions.service';
import { ApprovalsService } from '../policy/approvals.service';
import { PolicyService } from '../policy/policy.service';
import { CatalogService } from '../policy/catalog.service';
import { TelegramService } from '../ops/telegram.service';
import { MusicService } from '../music/music.service';
import { AlertsService } from '../ops/alerts.service';
import { OpsService } from '../ops/ops.service';
import { Case, PortfolioService } from '../portfolio/portfolio.service';
import { VisitsService } from '../visits/visits.service';

// Detras del proxy, la ultima direccion de X-Forwarded-For la puso el proxy (las anteriores las puede inventar el cliente).
const ipOf = (req: Request) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').pop()!.trim();
const isHttps = (req: Request) => req.secure || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';

/** Registro y administracion de los dispositivos del dueño. La pagina es public/owner.html. */
@Controller('owner')
export class OwnerController {
  constructor(private readonly owner: OwnerService, private readonly leads: LeadsService, private readonly workshop: WorkshopService, private readonly usage: UsageService, private readonly images: ImagesService, private readonly music: MusicService, private readonly alerts: AlertsService, private readonly ops: OpsService, private readonly cfg: ConfigService, private readonly portfolio: PortfolioService, private readonly visits: VisitsService, private readonly decisions: DecisionsService, private readonly settings: SettingsService, private readonly optout: OptOutService, private readonly capable: CapableModelService, private readonly actions: ActionsService, private readonly approvals: ApprovalsService, private readonly telegram: TelegramService, private readonly policy: PolicyService, private readonly catalog: CatalogService) {}
  private get followDays() { return this.cfg.followupDays; }

  private cookie(req: Request, value: string, maxAge: number) {
    return `${OWNER_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
  }
  private require(req: Request) {
    const device = this.owner.verify(req.headers.cookie);
    if (!device) throw new HttpException({ error: 'no_autorizado' }, 401);
    return device;
  }

  @Get('status')
  status(@Req() req: Request) {
    const device = this.owner.verify(req.headers.cookie);
    return { enabled: this.owner.enabled, registered: !!device, device: device?.name ?? null };
  }

  @Post('register')
  register(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: { secret?: string; name?: string }) {
    const ip = ipOf(req);
    if (!this.owner.enabled) throw new HttpException({ error: 'desactivado' }, 404);
    const wait = this.owner.blockedFor(ip);
    if (wait) throw new HttpException({ error: 'bloqueado', seconds: wait }, 429);
    const out = this.owner.register(String(body?.secret ?? ''), String(body?.name ?? ''), ip);
    if (!out) throw new HttpException({ error: 'clave' }, 401);
    res.setHeader('Set-Cookie', this.cookie(req, out.token, this.owner.maxAgeSeconds));
    return { ok: true, device: out.device.name };
  }

  @Get('devices')
  devices(@Req() req: Request) {
    const me = this.require(req);
    return this.owner.list().map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen, current: d.id === me.id }));
  }

  @Delete('devices/:id')
  revoke(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('id') id: string) {
    const me = this.require(req);
    const ok = this.owner.revoke(id);
    if (ok && id === me.id) res.setHeader('Set-Cookie', this.cookie(req, '', 0));
    return { ok };
  }

  // ---- consumo por dia de cada proveedor ----
  @Get('usage')
  async usageDays(@Req() req: Request) { this.require(req); return { days: await this.usage.days(30) }; }

  // ---- panel: cifras generales, conversaciones y encargos ----
  @Get('summary')
  async summary(@Req() req: Request) {
    this.require(req);
    const [stats, usage, funnel] = await Promise.all([this.leads.stats(30), this.usage.days(30), this.visits.funnel(30)]);
    const projects = this.workshop.list();
    // Que funciones tienen su clave puesta: sirve para ver de un vistazo por que el avatar dice que no puede hacer algo.
    const features = { 'Taller de programación': this.workshop.enabled, 'Música': this.music.enabled, 'Búsqueda de fotos': this.images.enabled, 'Generación de imágenes': this.images.canGenerate };
    return { db: this.leads.dbKind, features, services: this.alerts.status(), alerts: this.alerts.enabled, pending: (await this.leads.pending(this.followDays)).length, stats, funnel, reports: this.cfg.visitReports, portfolio: this.portfolio.visible().length, usage, approvals: (await this.approvals.pending()).length, workshop: { enabled: this.workshop.enabled, projects: projects.length, busy: this.workshop.busy() ?? null, jobs: projects.reduce((a, p) => a + (p.jobs || 0), 0) } };
  }

  /** Respaldo completo de la base, para descargar desde el panel. */
  @Get('backup')
  async backup(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.require(req);
    const { name, file } = await this.ops.dump();
    res.setHeader('Content-Type', 'application/gzip'); res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    return new StreamableFile(file);
  }

  @Get('conversations')
  async conversations(@Req() req: Request) { this.require(req); return { conversations: await this.leads.conversations(200) }; }

  @Get('conversations/:id')
  async conversation(@Req() req: Request, @Param('id') id: string) {
    this.require(req);
    const c = await this.leads.conversation(Number(id));
    if (!c) throw new HttpException({ error: 'no_existe' }, 404);
    return c;
  }

  @Delete('conversations/:id')
  async removeConversation(@Req() req: Request, @Param('id') id: string) { this.require(req); return { ok: await this.leads.removeConversation(Number(id)) }; }

  // ---- visitas: resumen de cada conversacion publica (sin transcripcion) ----
  @Get('visits')
  async listVisits(@Req() req: Request) { this.require(req); return { visits: await this.visits.list(300) }; }

  @Delete('visits/:id')
  async removeVisit(@Req() req: Request, @Param('id') id: string) { this.require(req); return { ok: await this.visits.remove(Number(id)) }; }

  // ---- portafolio: casos reales que el avatar puede contar ----
  private caseOut(c: Case) { return { ...c, visible: !!Number(c.visible), image: c.image ? `./imagenes/${c.image}` : '' }; }
  private async trying<T>(fn: () => Promise<T>): Promise<T> { try { return await fn(); } catch (e) { throw new HttpException({ error: 'invalido', message: (e as Error).message }, 400); } }

  @Get('portfolio')
  listCases(@Req() req: Request) { this.require(req); return { cases: this.portfolio.list().map((c) => this.caseOut(c)) }; }

  @Post('portfolio')
  async addCase(@Req() req: Request, @Body() body: Record<string, unknown>) { this.require(req); return this.caseOut(await this.trying(() => this.portfolio.save(body ?? {}))); }

  @Patch('portfolio/:id')
  async updateCase(@Req() req: Request, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    this.require(req);
    if (!this.portfolio.get(Number(id))) throw new HttpException({ error: 'no_existe' }, 404);
    return this.caseOut(await this.trying(() => this.portfolio.save(body ?? {}, Number(id))));
  }

  @Delete('portfolio/:id')
  async removeCase(@Req() req: Request, @Param('id') id: string) { this.require(req); return { ok: await this.portfolio.remove(Number(id)) }; }

  /** Foto de un caso: el cuerpo de la peticion es la imagen (el panel la reduce antes de enviarla). Tope 5 MB. */
  @Post('portfolio/:id/image')
  async caseImage(@Req() req: Request, @Param('id') id: string) {
    this.require(req);
    if (!this.portfolio.get(Number(id))) throw new HttpException({ error: 'no_existe' }, 404);
    const MAX = 5 * 1024 * 1024, chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) { size += chunk.length; if (size > MAX) throw new HttpException({ error: 'invalido', message: 'la foto pesa más de 5 MB' }, 413); chunks.push(chunk); }
    return this.caseOut(await this.trying(() => this.portfolio.setImage(Number(id), Buffer.concat(chunks))));
  }

  @Delete('portfolio/:id/image')
  async removeCaseImage(@Req() req: Request, @Param('id') id: string) { this.require(req); return { ok: await this.portfolio.clearImage(Number(id)) }; }

  @Get('jobs')
  async jobs(@Req() req: Request) { this.require(req); return { jobs: await this.workshop.jobs(100) }; }

  // ---- interesados (solo desde un dispositivo registrado) ----
  @Get('leads')
  async listLeads(@Req() req: Request) { this.require(req); return { statuses: STATUSES, leads: (await this.leads.list()).map((l) => ({ ...l, blocked: this.optout.blocked(l.contact) })) }; }

  // ---- no contactar: la lista se ve, se amplia a mano y solo aqui se quita una marca ----
  @Get('optouts')
  async optouts(@Req() req: Request) { this.require(req); return { optouts: await this.optout.list() }; }
  @Post('optouts')
  async addOptout(@Req() req: Request, @Body() body: { contact?: string; note?: string }) {
    this.require(req);
    const contact = String(body?.contact ?? '');
    if (!this.optout.key(contact)) throw new HttpException({ error: 'escribe un teléfono (con indicativo) o un correo' }, 400);
    return { ok: true, added: await this.optout.mark(contact, 'panel', String(body?.note ?? 'Marcado por Javier'), 'javier') };
  }
  @Delete('optouts/:id')
  async liftOptout(@Req() req: Request, @Param('id') id: string) { this.require(req); return { ok: await this.optout.lift(Number(id)) }; }

  @Get('leads.csv')
  async csv(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.require(req);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="interesados.csv"');
    return '\ufeff' + (await this.leads.csv());
  }

  @Patch('leads/:id')
  async updateLead(@Req() req: Request, @Param('id') id: string, @Body() body: { status?: string; notes?: string }) {
    this.require(req); return { ok: await this.leads.update(Number(id), body ?? {}) };
  }

  @Delete('leads/:id')
  async removeLead(@Req() req: Request, @Param('id') id: string) { this.require(req); return { ok: await this.leads.remove(Number(id)) }; }

  // ---- autonomia: politica (limites que pone Javier) y bitacora de lo que el avatar hizo por su cuenta ----
  @Get('policy')
  async policyView(@Req() req: Request) {
    this.require(req);
    return { status: await this.actions.status(), settings: this.settings.list().filter((s) => s.group === 'politica' || s.group === 'horario'), kinds: ACTION_KINDS };
  }
  /** La bitacora solo se consulta: no hay forma de cambiarla ni de borrarla desde el panel. */
  @Get('actions')
  async actionsView(@Req() req: Request, @Query('status') status?: string, @Query('kind') kind?: string, @Query('q') q?: string, @Query('days') days?: string) {
    this.require(req);
    return { actions: await this.actions.list({ status: String(status ?? ''), kind: String(kind ?? ''), q: String(q ?? '').slice(0, 80), days: Math.min(365, Math.max(1, Number(days) || 30)) }), chain: await this.actions.verify(), kinds: ACTION_KINDS };
  }

  // ---- catalogo de precios: vacio = el avatar no dice precios ni envia ofertas ----
  @Get('catalog')
  catalogView(@Req() req: Request) { this.require(req); return { items: this.catalog.list(), empty: this.catalog.empty }; }
  @Post('catalog')
  async addPrice(@Req() req: Request, @Body() body: Record<string, unknown>) { this.require(req); try { return { ok: true, item: await this.catalog.save(body as any) }; } catch (e) { throw new HttpException({ error: (e as Error).message }, 400); } }
  @Patch('catalog/:id')
  async editPrice(@Req() req: Request, @Param('id') id: string, @Body() body: Record<string, unknown>) { this.require(req); try { return { ok: true, item: await this.catalog.save(body as any, Number(id)) }; } catch (e) { throw new HttpException({ error: (e as Error).message }, 400); } }
  @Delete('catalog/:id')
  async removePrice(@Req() req: Request, @Param('id') id: string) { this.require(req); return { ok: await this.catalog.remove(Number(id)) }; }

  // ---- bandeja de aprobaciones ----
  @Get('approvals')
  async approvalsView(@Req() req: Request) {
    this.require(req);
    const strip = (a: any) => ({ ...a, payload: undefined, nonce: undefined }); // lo que ejecuta la accion y la clave de los botones no salen del servidor
    return { pending: (await this.approvals.pending()).map(strip), waiting: (await this.approvals.waiting()).map(strip), recent: (await this.approvals.recent()).map(strip), kinds: ACTION_KINDS, telegram: { enabled: this.telegram.enabled, buttons: this.telegram.polling, problem: this.telegram.problem }, simulation: this.policy.simulation };
  }
  @Post('approvals/:id')
  async decideApproval(@Req() req: Request, @Param('id') id: string, @Body() body: { decision?: string }) {
    this.require(req);
    if (body?.decision !== 'aprobar' && body?.decision !== 'rechazar') throw new HttpException({ error: 'decision debe ser aprobar o rechazar' }, 400);
    return this.approvals.decide(Number(id), body.decision === 'aprobar', 'panel');
  }

  // ---- capa de decisiones: quien decide, registro, umbrales y prueba ----
  @Get('decisions')
  async decisionsView(@Req() req: Request, @Query('kind') kind?: string) {
    this.require(req);
    return { status: await this.decisions.status(), route: await this.decisions.routeStats(), capableModel: this.capable.label, capableProblem: this.capable.problem, settings: this.settings.list().filter((s) => s.group === 'ruta'), decisions: await this.decisions.list(100, typeof kind === 'string' && kind in KINDS ? kind : '') };
  }
  @Patch('settings')
  async setSetting(@Req() req: Request, @Body() body: { key?: string; value?: unknown }) {
    this.require(req);
    const err = await this.settings.set(String(body?.key ?? ''), body?.value);
    if (err) throw new HttpException({ error: err }, 400);
    return { ok: true };
  }
  @Patch('decisions/:id')
  async markDecision(@Req() req: Request, @Param('id') id: string, @Body() body: { mark?: string }) { this.require(req); return { ok: await this.decisions.mark(Number(id), String(body?.mark ?? '')) }; }
  /** Prueba un texto contra un tipo de decision, sin efectos: sirve para ver quien decide y con que confianza. */
  @Post('decisions/test')
  async testDecision(@Req() req: Request, @Body() body: { kind?: string; text?: string }) {
    this.require(req);
    const kind = String(body?.kind ?? ''), text = String(body?.text ?? '').trim().slice(0, 2000);
    if (!(kind in KINDS) || text.length < 2) throw new HttpException({ error: 'faltan kind o text' }, 400);
    const d = await this.decisions.decide(kind, text, QUESTIONS[kind as Kind], { subject: 'prueba del panel', budgetMs: 8000 });
    await d.id;
    return { shadow: d.shadow, ms: d.ms, answers: d.answers, logged: (await this.decisions.list(1, kind))[0] ?? null };
  }

  // ---- imagenes generadas con IA ----
  @Get('images')
  async generatedImages(@Req() req: Request) {
    this.require(req);
    return { enabled: this.images.canGenerate, images: (await this.images.listGenerated()).map((i) => ({ ...i, url: `/imagenes/${i.name}` })) };
  }
  @Delete('images/:id')
  async removeImage(@Req() req: Request, @Param('id') id: string) { this.require(req); return { ok: await this.images.removeGenerated(Number(id)) }; }

  // ---- taller de programacion (solo desde un dispositivo registrado) ----
  @Get('projects')
  async projects(@Req() req: Request) {
    this.require(req);
    const origin = `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
    const projects = await Promise.all(this.workshop.list().map(async (p) => {
      const url = this.workshop.siteUrl(p.slug, origin);
      return {
        slug: p.slug, name: p.name, status: p.status, updatedAt: p.updatedAt, jobs: p.jobs, lastTask: p.lastTask ?? '', lastSummary: p.lastSummary ?? '', check: p.check ?? null, repaired: !!p.repaired, run: p.run ?? null,
        url, qr: url ? await QRCode.toDataURL(url, { margin: 1, width: 240 }) : '', files: this.workshop.files(p.slug, 60),
      };
    }));
    return { enabled: this.workshop.enabled, busy: this.workshop.busy() ?? null, progress: this.workshop.progress(), projects, metrics: this.workshop.enabled ? await this.workshop.metrics(30) : null };
  }

  /** Borra el proyecto con su codigo y su sitio publicado. No se puede deshacer. */
  @Delete('projects/:slug')
  async removeProject(@Req() req: Request, @Param('slug') slug: string) {
    this.require(req);
    const err = await this.workshop.remove(slug);
    if (err) throw new HttpException({ error: err }, err === 'no_existe' ? 404 : err === 'ocupado' ? 409 : 500);
    return { ok: true };
  }

  /** Descarga el proyecto como .tar.gz (sin node_modules ni .git). tar no sigue enlaces simbolicos. */
  @Get('projects/:slug/descargar')
  download(@Req() req: Request, @Param('slug') slug: string, @Res() res: Response) {
    this.require(req);
    if (!this.workshop.list().some((p) => p.slug === slug)) throw new HttpException({ error: 'no_existe' }, 404);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.tar.gz"`);
    const tar = spawn('tar', ['-czf', '-', '--exclude=node_modules', '--exclude=.git', '-C', dirname(this.workshop.dir(slug)), slug], { stdio: ['ignore', 'pipe', 'ignore'] });
    tar.stdout.pipe(res);
    tar.on('error', () => res.destroy());
    res.on('close', () => tar.kill());
  }
}
