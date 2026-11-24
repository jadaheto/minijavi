import { Body, Controller, Delete, Get, Header, HttpException, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '../config/config.service';
import { clientMetadata } from './oauth';
import { OwnerService } from '../owner/owner.service';
import { ConnectionsService, Refused } from './connections.service';

/**
 * Conexiones, lado del panel. Todo exige un dispositivo registrado del dueño. La clave de una conexion se puede ESCRIBIR
 * (al crearla) pero ningun metodo la devuelve. "Probar" ejecuta una herramienta por el mismo punto unico que usara el
 * avatar: si no es de lectura confirmada, se bloquea igual.
 */
@Controller('owner/connections')
export class ConnectionsController {
  constructor(private readonly conns: ConnectionsService, private readonly owner: OwnerService) {}
  private require(req: Request) { if (!this.owner.verify(req.headers.cookie)) throw new HttpException({ error: 'no_autorizado' }, 401); }
  private async safe<T>(fn: () => Promise<T>): Promise<T> { try { return await fn(); } catch (e) { if (e instanceof Refused) throw new HttpException({ error: 'rechazado', message: e.message }, 400); throw new HttpException({ error: 'fallo', message: 'No se pudo completar.' }, 500); } }

  @Get()
  async list(@Req() req: Request) {
    this.require(req);
    if (this.conns.problem) return { problem: this.conns.problem, items: [], log: [] };
    const items = await this.conns.list(), oauth = await this.conns.oauthStates();
    return { problem: '', voice: this.conns.voiceOn, oauthRedirect: this.conns.oauthRedirect, items: await Promise.all(items.map(async (c) => ({ ...c, ...(c.auth_kind === 'oauth' ? { oauth: oauth[c.id] ?? 'sin_autorizar' } : {}), tools: (await this.conns.tools(c.id)).map(({ schema, fingerprint, ...t }) => ({ ...t, params: paramNames(schema) })) }))), log: await this.conns.recent(60) };
  }

  @Post()
  add(@Req() req: Request, @Body() body: { name?: string; url?: string; authKind?: string; authHeader?: string; secret?: string }) {
    this.require(req);
    return this.safe(async () => { const c = await this.conns.add({ name: String(body?.name ?? ''), url: String(body?.url ?? ''), authKind: body?.authKind, authHeader: body?.authHeader, secret: body?.secret });
      const found = await this.conns.discover(c.id).catch((e) => ({ error: e instanceof Refused ? e.message : 'no se pudieron leer las herramientas' })); return { ok: true, id: c.id, found }; });
  }

  /**
   * Conectar con la cuenta de Javier (OAuth). Devuelve la direccion de la aplicacion y los permisos que se van a pedir;
   * el panel se los muestra y es Javier quien pulsa para ir. Con `id`, reconecta una conexion que ya existe.
   */
  @Post('oauth')
  oauth(@Req() req: Request, @Body() body: { id?: number; name?: string; url?: string; clientId?: string; clientSecret?: string; scope?: string }) {
    this.require(req);
    return this.safe(() => this.conns.oauthStart({ id: Number(body?.id) || undefined, name: body?.name, url: body?.url, clientId: body?.clientId, clientSecret: body?.clientSecret, scope: body?.scope }));
  }

  @Patch(':id')
  async toggle(@Req() req: Request, @Param('id') id: string, @Body() body: { enabled?: boolean }) {
    this.require(req);
    if (!(await this.safe(() => this.conns.setEnabled(Number(id) || 0, body?.enabled === true)))) throw new HttpException({ error: 'no_existe' }, 404);
    return { ok: true };
  }

  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string) {
    this.require(req);
    if (!(await this.safe(() => this.conns.remove(Number(id) || 0)))) throw new HttpException({ error: 'no_existe' }, 404);
    return { ok: true };
  }

  @Post(':id/descubrir')
  discover(@Req() req: Request, @Param('id') id: string) { this.require(req); return this.safe(() => this.conns.discover(Number(id) || 0)); }

  @Post(':id/clasificar')
  classify(@Req() req: Request, @Param('id') id: string, @Body() body: { tool?: string; klass?: string; sure?: boolean }) {
    this.require(req);
    return this.safe(() => this.conns.classify(Number(id) || 0, String(body?.tool ?? ''), String(body?.klass ?? ''), body?.sure === true));
  }

  @Post(':id/probar')
  test(@Req() req: Request, @Param('id') id: string, @Body() body: { tool?: string; args?: Record<string, unknown> }) {
    this.require(req);
    return this.conns.call({ owner: true, via: 'panel' }, Number(id) || 0, String(body?.tool ?? ''), body?.args && typeof body.args === 'object' ? body.args : {});
  }
}
/**
 * Lo que las aplicaciones necesitan ver de minijavi SIN sesion: su documento publico de cliente y la vuelta tras
 * autorizar. La vuelta no puede exigir la cookie del dueño (es SameSite=Strict y no llega al volver desde otro sitio):
 * la protege el `state` de un solo uso. No devuelve datos: solo redirige al panel con el resultado.
 */
@Controller('api/conexiones')
export class ConnectionsPublicController {
  constructor(private readonly conns: ConnectionsService, private readonly cfg: ConfigService) {}

  @Get('cliente.json')
  @Header('Cache-Control', 'public, max-age=3600')
  client() {
    if (!this.conns.enabled || !this.cfg.publicUrl.startsWith('https://')) throw new HttpException({ error: 'no_existe' }, 404);
    return { client_id: `${this.cfg.publicUrl}/api/conexiones/cliente.json`, ...clientMetadata(this.conns.oauthRedirect, this.cfg.publicUrl) };
  }

  @Get('callback')
  async callback(@Query('code') code: string | undefined, @Query('state') state: string | undefined, @Query('iss') iss: string | undefined, @Query('error') error: string | undefined, @Res() res: Response) {
    const r = await this.conns.oauthFinish({ code, state, iss, error }).catch(() => ({ ok: false, why: 'no se pudo completar' } as { ok: boolean; name?: string; why?: string }));
    res.redirect(302, `/dueno.html?conexion=${r.ok ? 'ok' : 'error'}${r.why ? `&motivo=${encodeURIComponent(r.why.slice(0, 160))}` : ''}#conexiones`);
  }
}

/** Los nombres de los parametros de una herramienta, para mostrarlos (el esquema completo no hace falta en el panel). */
function paramNames(schema: string): string[] { try { return Object.keys(JSON.parse(schema)?.properties ?? {}).slice(0, 12); } catch { return []; } }
