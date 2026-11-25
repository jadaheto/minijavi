import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import { Vault } from '../connections/vault';
import { DbService } from '../db/db.service';
import { AlertsService } from '../ops/alerts.service';
import { UsageService } from '../usage/usage.service';

/**
 * Google de Javier (conexiones, etapa B; plan aprobado el 2026-11-24). SOLO LECTURA y solo en modo dueño.
 *
 * Por que API directa y no el conector MCP de Google: ese conector esta en vista previa (pide cuenta de Workspace y
 * permisos de escritura sobre el correo y la agenda). Aqui se piden UNICAMENTE permisos de lectura, asi que es Google
 * quien impide escribir: esta clase solo tiene `get()` y, aunque tuviera otra cosa, el permiso no alcanzaria.
 *
 * Documentacion leida el 2026-11-24 (developers.google.com/identity/protocols/oauth2/web-server y la referencia de
 * Calendar v3):
 *  - Autorizar: `https://accounts.google.com/o/oauth2/v2/auth` con client_id, redirect_uri (https, coincidencia exacta),
 *    response_type=code, scope, state, `access_type=offline` (para recibir el permiso de larga duracion) y
 *    `prompt=consent` (Google solo lo entrega en la primera autorizacion; con esto lo entrega siempre).
 *  - Cambiar el codigo y renovar: `POST https://oauth2.googleapis.com/token` (formulario). `invalid_grant` = el permiso
 *    vencio o fue revocado: hay que volver a conectar.
 *  - Revocar: `POST https://oauth2.googleapis.com/revoke?token=`.
 *  - Correo (referencia de Gmail v1, leida el mismo dia): `GET .../users/me/messages` (q con la sintaxis del buscador de
 *    Gmail, labelIds, maxResults) devuelve solo ids; `GET .../messages/{id}` con format=metadata + metadataHeaders (lista)
 *    o format=full (leer): cabeceras en `payload.headers`, texto en `payload.body.data` o en `payload.parts[]`, en
 *    base64url. `snippet` es un trozo corto del texto y `labelIds` trae UNREAD si no se ha leido.
 *  - Drive (referencia v3 y guias de busqueda y de formatos, leidas el mismo dia): `GET .../drive/v3/files` con `q`
 *    (`name contains 'x'`, `fullText contains 'x'`, `trashed = false`; la comilla y la barra invertida se escapan con
 *    barra invertida), orderBy, pageSize y fields; `GET .../files/{id}?alt=media` da el contenido de un archivo guardado
 *    en Drive; los documentos de Google se sacan con `GET .../files/{id}/export?mimeType=` (texto llano para
 *    documentos y presentaciones, CSV de la primera hoja para hojas de calculo; tope de 10 MB).
 *  - Agenda: `GET https://www.googleapis.com/calendar/v3/calendars/primary/events` con timeMin, timeMax (RFC 3339),
 *    singleEvents=true y orderBy=startTime (solo vale con singleEvents), maxResults, timeZone.
 *
 * El permiso de larga duracion vive CIFRADO (boveda de conexiones, `VAULT_KEY`) en la tabla `meta`, que no va en el
 * respaldo diario. Sin `VAULT_KEY` no se puede conectar. Lo leido es texto de terceros (una invitacion la escribe quien
 * invita): quien lo use debe tratarlo como dato.
 */
const META_KEY = 'google_auth';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth', TOKEN_URL = 'https://oauth2.googleapis.com/token', REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DRIVE = 'https://www.googleapis.com/drive/v3';
/** Permisos por parte. Cada parte nueva (correo, Drive) suma el suyo y pide volver a conectar: nunca se pide de mas. */
export const GOOGLE_SCOPES = { agenda: 'https://www.googleapis.com/auth/calendar.readonly', correo: 'https://www.googleapis.com/auth/gmail.readonly', drive: 'https://www.googleapis.com/auth/drive.readonly' } as const;
export type GooglePart = keyof typeof GOOGLE_SCOPES;
/** Lo unico que esta clase acepta tener: si Google devolviera un permiso que no es de lectura, no se guarda. */
const READ_ONLY = /^(openid|email|profile|https:\/\/www\.googleapis\.com\/auth\/(userinfo\.(email|profile)|[a-z.]+\.readonly))$/;

interface Stored { refresh: string; scope: string; since: string; account: string }
export interface AgendaEvent { title: string; start: string; end: string; allDay: boolean; time: string; where: string; tentative: boolean; others: number }
export interface AgendaDay { date: string; label: string; events: AgendaEvent[] }
export interface Agenda { title: string; from: string; to: string; days: AgendaDay[]; total: number; truncated: boolean }
export interface MailItem { id: string; from: string; subject: string; date: string; when: string; snippet: string; unread: boolean }
export interface MailFull extends MailItem { to: string; text: string; truncated: boolean; attachments: number }
export interface DriveFile { id: string; name: string; kind: string; mime: string; when: string; owner: string; readable: boolean }
export interface DriveDoc extends DriveFile { text: string; truncated: boolean; note: string }
export class GoogleError extends Error { constructor(message: string, readonly status = 0) { super(message); } }

const clean = (s: unknown, max: number) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

@Injectable()
export class GoogleService implements OnModuleInit {
  private readonly log = new Logger(GoogleService.name);
  private readonly vault: Vault;
  private stored?: Stored;
  private access?: { token: string; until: number };
  private refreshing?: Promise<string>;
  private readonly states = new Map<string, { until: number; redirect: string }>();
  private readonly cache = new Map<string, { at: number; value: Agenda }>();
  private readonly mailCache = new Map<string, { at: number; value: MailItem[] }>();
  private readonly fileCache = new Map<string, { at: number; value: DriveFile[] }>();
  private used = { day: '', n: 0 };
  private lastError = '';
  private warned = false;
  /** Para las pruebas: la hora "de ahora". */
  now: () => Date = () => new Date();

  constructor(private readonly cfg: ConfigService, private readonly db: DbService, @Optional() private readonly usage?: UsageService, @Optional() private readonly alerts?: AlertsService) {
    this.vault = new Vault(cfg.vaultKey);
  }

  /** Por que no existe en este servidor ('' = existe). */
  get problem(): string {
    if (this.cfg.business) return 'no existe en el modo negocio';
    if (!this.cfg.googleEnabled) return 'está apagado (GOOGLE=0)';
    if (!this.cfg.googleClientId || !this.cfg.googleClientSecret) return 'faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET';
    if (!this.cfg.ownerSecret) return 'el modo dueño está desactivado';
    if (!this.vault.ready) return 'falta VAULT_KEY para guardar el permiso cifrado';
    if (!this.redirect) return 'falta PUBLIC_URL (o GOOGLE_REDIRECT_URI): Google no sabría a dónde volver';
    return '';
  }
  get configured() { return !this.problem; }
  get connected() { return this.configured && !!this.stored?.refresh; }
  get redirect(): string { return this.cfg.googleRedirectUri || (this.cfg.publicUrl ? `${this.cfg.publicUrl}/api/google/callback` : ''); }
  /** Las partes para las que el permiso guardado alcanza. */
  has(part: GooglePart) { return this.connected && (this.stored!.scope.split(/\s+/).includes(GOOGLE_SCOPES[part])); }
  private wanted() { return Object.values(GOOGLE_SCOPES).join(' '); }

  get status() {
    const parts = (Object.keys(GOOGLE_SCOPES) as GooglePart[]).filter((p) => this.has(p));
    return { configured: this.configured, problem: this.problem, connected: this.connected, since: this.stored?.since ?? '', account: this.stored?.account ?? '', parts, missing: this.connected ? (Object.keys(GOOGLE_SCOPES) as GooglePart[]).filter((p) => !this.has(p)) : [],
      redirect: this.redirect, error: this.lastError, usedToday: this.used.day === this.day() ? this.used.n : 0, dailyLimit: this.cfg.googleDailyCalls };
  }

  async onModuleInit() {
    if (!this.configured) return;
    try {
      const raw = (await this.db.query<{ value: string }>('SELECT value FROM meta WHERE key = $1', [META_KEY]))[0]?.value;
      if (raw) this.stored = JSON.parse(this.vault.open(raw)) as Stored;
    } catch (e) { this.lastError = 'no se pudo abrir el permiso guardado (¿cambió VAULT_KEY?): vuelve a conectar'; this.log.warn(`Google: ${(e as Error).message}`); }
  }

  private async save(s: Stored | undefined) {
    this.stored = s; this.access = undefined; this.cache.clear(); this.mailCache.clear(); this.fileCache.clear();
    if (!s) { await this.db.query('DELETE FROM meta WHERE key = $1', [META_KEY]); return; }
    const sealed = this.vault.seal(JSON.stringify(s));
    await this.db.query('DELETE FROM meta WHERE key = $1', [META_KEY]);
    await this.db.query('INSERT INTO meta (key, value) VALUES ($1, $2)', [META_KEY, sealed]);
  }

  // ---------- conectar ----------
  /** Direccion de Google para autorizar. El `state` es al azar, de un solo uso y vale 10 minutos. */
  authUrl(redirect = this.redirect): string {
    if (!this.configured) throw new GoogleError(`Google no está disponible: ${this.problem}`);
    const now = Date.now(); for (const [k, v] of this.states) if (v.until < now) this.states.delete(k);
    const state = randomBytes(24).toString('hex'); this.states.set(state, { until: now + 10 * 60_000, redirect });
    const q = new URLSearchParams({ client_id: this.cfg.googleClientId, redirect_uri: redirect, response_type: 'code', scope: this.wanted(), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state });
    return `${AUTH_URL}?${q.toString()}`;
  }

  private async token(form: Record<string, string>): Promise<any> {
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.cfg.googleClientId, client_secret: this.cfg.googleClientSecret, ...form }).toString(), signal: AbortSignal.timeout(10_000) });
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok || !d.access_token) throw Object.assign(new GoogleError(`Google respondió ${res.status} al pedir el acceso${d.error ? ` (${clean(d.error, 40)})` : ''}`, res.status), { code: String(d.error ?? '') });
    return d;
  }

  /** La vuelta de Google: cambia el codigo por los permisos. Solo se guardan si son de lectura. */
  async finish(code: string, state: string): Promise<void> {
    const st = this.states.get(state); this.states.delete(state);
    if (!st || st.until < Date.now()) throw new GoogleError('esa autorización no existe, ya se usó o venció');
    const d = await this.token({ grant_type: 'authorization_code', code, redirect_uri: st.redirect });
    const scope = clean(d.scope, 2000), granted = scope.split(' ').filter(Boolean);
    const extra = granted.filter((s) => !READ_ONLY.test(s));
    if (extra.length) { void this.revoke(String(d.refresh_token || d.access_token)); throw new GoogleError('Google devolvió un permiso que no es de solo lectura; no se guardó nada'); }
    if (!d.refresh_token) throw new GoogleError('Google no entregó el permiso de larga duración; quita el acceso de minijavi en tu cuenta de Google y conecta de nuevo');
    if (!granted.some((s) => (Object.values(GOOGLE_SCOPES) as string[]).includes(s))) throw new GoogleError('no diste ninguno de los permisos que se pidieron');
    this.access = { token: String(d.access_token), until: Date.now() + (Number(d.expires_in) || 3000) * 1000 - 60_000 };
    const stored: Stored = { refresh: String(d.refresh_token), scope, since: new Date().toISOString(), account: '' };
    this.stored = stored; this.lastError = ''; this.warned = false;
    // De quien es la cuenta: el calendario principal se llama como el correo. Si no se puede leer, queda vacio.
    if (granted.includes(GOOGLE_SCOPES.agenda)) stored.account = await this.get(`${CALENDAR}/calendars/primary`).then((c: any) => clean(c?.id, 120)).catch(() => '');
    await this.save(stored); this.access = { token: String(d.access_token), until: Date.now() + (Number(d.expires_in) || 3000) * 1000 - 60_000 };
    this.log.log('Google conectado');
  }

  private async revoke(token: string) { await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(8000) }).catch(() => undefined); }

  /** Desconectar: se le pide a Google que anule el permiso y se borra de aqui. */
  async disconnect(): Promise<void> { const t = this.stored?.refresh; await this.save(undefined); this.lastError = ''; if (t) await this.revoke(t); }

  private async accessToken(): Promise<string> {
    if (!this.connected) throw new GoogleError('Google no está conectado: se conecta en el panel, en Dispositivos');
    if (this.access && this.access.until > Date.now()) return this.access.token;
    this.refreshing ??= (async () => {
      try {
        const d = await this.token({ grant_type: 'refresh_token', refresh_token: this.stored!.refresh });
        this.access = { token: String(d.access_token), until: Date.now() + (Number(d.expires_in) || 3000) * 1000 - 60_000 };
        return this.access.token;
      } catch (e) {
        if ((e as { code?: string }).code === 'invalid_grant') { // vencio o Javier lo revoco: no hay forma de renovarlo sin el
          await this.save(undefined); this.lastError = 'el permiso venció o fue revocado: vuelve a conectar';
          if (!this.warned) { this.warned = true; void this.alerts?.send('📅 Google dejó de dar acceso (el permiso venció o se revocó). Vuelve a conectarlo en el panel → Dispositivos.'); }
          throw new GoogleError('el permiso de Google venció o fue revocado: hay que volver a conectarlo en el panel');
        }
        throw e;
      } finally { this.refreshing = undefined; }
    })();
    return this.refreshing;
  }

  private day(at = this.now()) { return new Intl.DateTimeFormat('en-CA', { timeZone: this.cfg.timezone }).format(at); }

  /** Unica forma de hablar con Google: GET. Cuenta para el tope diario propio. */
  private async get(url: string, params: Record<string, string> | URLSearchParams = {}, background = false): Promise<any> {
    const today = this.day(); if (this.used.day !== today) this.used = { day: today, n: 0 };
    // Las consultas de fondo (revisar si llego correo) no gastan el tope de las que pide Javier; se cuentan aparte.
    if (!background) { if (this.used.n >= this.cfg.googleDailyCalls) throw new GoogleError('se llegó al tope de consultas a Google de hoy'); this.used.n++; }
    this.usage?.add(background ? 'google_fondo' : 'google_calls');
    const token = await this.accessToken(), q = (params instanceof URLSearchParams ? params : new URLSearchParams(params)).toString();
    const res = await fetch(q ? `${url}?${q}` : url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 401) this.access = undefined;
    if (!res.ok) {
      // Google explica el motivo en el cuerpo. El mas comun al estrenar una parte: la API no esta encendida en el proyecto.
      const body: any = await res.json().catch(() => ({})), reasons = JSON.stringify([body?.error?.status, body?.error?.errors, body?.error?.details] ).slice(0, 1500), api = /gmail/.test(url) ? 'Gmail API' : /calendar/.test(url) ? 'Google Calendar API' : /drive/.test(url) ? 'Google Drive API' : 'esa API';
      if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used in project|is disabled/i.test(reasons + String(body?.error?.message ?? ''))) { this.log.warn(`Google: ${api} no está encendida en el proyecto`); throw new GoogleError(`la ${api} no está encendida en tu proyecto de Google Cloud: hay que habilitarla ahí (APIs y servicios → Biblioteca) y esperar un par de minutos`, 403); }
      if (res.status === 403 && /insufficient|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i.test(reasons + String(body?.error?.message ?? ''))) throw new GoogleError('el permiso guardado no alcanza para eso: vuelve a conectar Google en el panel y acepta todos los permisos', 403);
      if ((res.status === 403 || res.status === 429) && /rateLimit|quota|RESOURCE_EXHAUSTED/i.test(reasons)) throw new GoogleError('Google pide esperar: se llegó a su límite de consultas por ahora', res.status);
      const why: Record<number, string> = { 401: 'Google rechazó el acceso', 403: 'Google no permite esa consulta (403, sin más detalle)', 404: 'Google no encontró lo pedido', 429: 'Google pide esperar un momento' };
      this.log.warn(`Google respondió ${res.status} en ${new URL(url).pathname}`);
      throw new GoogleError(why[res.status] ?? `Google respondió ${res.status}`, res.status);
    }
    return res.json();
  }

  // ---------- agenda ----------
  /** Minutos de diferencia entre la hora del negocio y UTC en ese instante. */
  private offset(at: Date): number {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: this.cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((x) => [x.type, x.value]));
    return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - at.getTime()) / 60_000);
  }
  /** El instante en que empieza ese dia (AAAA-MM-DD) en la hora del negocio. */
  private startOf(day: string): Date { const [y, m, d] = day.split('-').map(Number), guess = new Date(Date.UTC(y, m - 1, d)); return new Date(guess.getTime() - this.offset(guess) * 60_000); }
  private shift(day: string, n: number): string { const [y, m, d] = day.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }

  /**
   * La agenda del calendario principal. `when`: hoy | manana | semana (hoy y los 6 dias siguientes) | AAAA-MM-DD.
   * No trae lo cancelado ni lo que Javier rechazo. Los titulos y lugares son texto de terceros.
   */
  async agenda(when = 'hoy'): Promise<Agenda> {
    if (!this.has('agenda')) throw new GoogleError(this.connected ? 'el permiso guardado no incluye la agenda: vuelve a conectar Google en el panel' : 'Google no está conectado: se conecta en el panel, en Dispositivos');
    const today = this.day(), key = String(when || 'hoy').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const first = /^\d{4}-\d{2}-\d{2}$/.test(key) && !Number.isNaN(Date.parse(key)) ? key : key === 'manana' ? this.shift(today, 1) : today, span = key === 'semana' ? 7 : 1;
    const hit = this.cache.get(`${first}/${span}`); if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const from = this.startOf(first), to = this.startOf(this.shift(first, span));
    const d = await this.get(`${CALENDAR}/calendars/primary/events`, { timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '60', timeZone: this.cfg.timezone });
    const days = new Map<string, AgendaEvent[]>(); for (let i = 0; i < span; i++) days.set(this.shift(first, i), []);
    const hour = new Intl.DateTimeFormat('es-CO', { timeZone: this.cfg.timezone, hour: 'numeric', minute: '2-digit', hour12: true });
    let total = 0;
    for (const e of Array.isArray(d?.items) ? d.items : []) {
      if (e?.status === 'cancelled') continue;
      const me = Array.isArray(e.attendees) ? e.attendees.find((a: any) => a?.self) : undefined;
      if (me?.responseStatus === 'declined') continue;
      const allDay = typeof e.start?.date === 'string', s = allDay ? this.startOf(e.start.date) : new Date(e.start?.dateTime), end = allDay ? this.startOf(String(e.end?.date ?? e.start.date)) : new Date(e.end?.dateTime ?? e.start?.dateTime);
      if (Number.isNaN(s.getTime())) continue;
      // Un evento de varios dias aparece en cada dia del rango que toca.
      for (const [day, list] of days) {
        const a = this.startOf(day), b = this.startOf(this.shift(day, 1));
        if (s < b && (end > a || (+end === +s && s >= a))) list.push({ title: clean(e.summary, 80) || '(sin título)', start: s.toISOString(), end: Number.isNaN(end.getTime()) ? s.toISOString() : end.toISOString(), allDay, time: allDay ? 'Todo el día' : s < a ? 'Sigue' : hour.format(s).replace(/ /g, ' '),
          where: clean(e.location, 60), tentative: e.status === 'tentative' || me?.responseStatus === 'tentative' || me?.responseStatus === 'needsAction', others: Array.isArray(e.attendees) ? Math.max(0, e.attendees.filter((x: any) => !x?.self && !x?.resource).length) : 0 });
      }
      total++;
    }
    const label = new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
    const out: Agenda = { title: span > 1 ? 'Esta semana' : first === today ? 'Hoy' : first === this.shift(today, 1) ? 'Mañana' : label.format(new Date(`${first}T12:00:00Z`)), from: from.toISOString(), to: to.toISOString(), total, truncated: !!d?.nextPageToken,
      days: [...days].map(([date, events]) => ({ date, label: (date === today ? 'Hoy · ' : date === this.shift(today, 1) ? 'Mañana · ' : '') + label.format(new Date(`${date}T12:00:00Z`)), events })) };
    this.cache.set(`${first}/${span}`, { at: Date.now(), value: out });
    return out;
  }

  // ---------- correo ----------
  private header(m: any, name: string): string { const h = (Array.isArray(m?.payload?.headers) ? m.payload.headers : []).find((x: any) => String(x?.name).toLowerCase() === name); return clean(h?.value, 200); }
  private mailItem(m: any): MailItem {
    // El remitente llega como «Nombre <direccion>»: se muestra el nombre; la direccion solo si no hay nombre.
    const rawFrom = String((Array.isArray(m?.payload?.headers) ? m.payload.headers : []).find((x: any) => String(x?.name).toLowerCase() === 'from')?.value ?? '');
    const named = /^\s*"?([^"<]*?)"?\s*<([^>]*)>\s*$/.exec(rawFrom), from = clean(named ? named[1] || named[2] : rawFrom, 60);
    const at = new Date(Number(m?.internalDate) || NaN);
    const when = Number.isNaN(at.getTime()) ? '' : new Intl.DateTimeFormat('es-CO', { timeZone: this.cfg.timezone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(at).replace(/\u00a0/g, ' ');
    return { id: String(m?.id ?? ''), from: from || '(sin remitente)', subject: clean(this.header(m, 'subject'), 120) || '(sin asunto)', date: Number.isNaN(at.getTime()) ? '' : at.toISOString(), when,
      snippet: clean(htmlToText(String(m?.snippet ?? '')), 160), unread: Array.isArray(m?.labelIds) && m.labelIds.includes('UNREAD') };
  }

  /**
   * Busca correos. `query` usa la sintaxis del buscador de Gmail (from:, subject:, is:unread, newer_than:2d...); vacia =
   * los mas recientes de la bandeja de entrada. Devuelve remitente, asunto, fecha y un trozo corto: no el cuerpo.
   * Todo es texto de terceros.
   */
  async mail(query = '', max = 6, background = false): Promise<MailItem[]> {
    if (!this.has('correo')) throw new GoogleError(this.connected ? 'el permiso guardado no incluye el correo: vuelve a conectar Google en el panel' : 'Google no está conectado: se conecta en el panel, en Dispositivos');
    const q = clean(query, 200), n = Math.max(1, Math.min(10, Math.floor(max) || 6)), key = `${q}/${n}`;
    const hit = this.mailCache.get(key); if (hit && Date.now() - hit.at < 45_000) return hit.value;
    const list = await this.get(`${GMAIL}/messages`, { maxResults: String(n), ...(q ? { q } : { labelIds: 'INBOX' }) }, background);
    const ids: string[] = (Array.isArray(list?.messages) ? list.messages : []).map((m: any) => String(m?.id ?? '')).filter((id: string) => /^[A-Za-z0-9_-]{6,40}$/.test(id)).slice(0, n);
    const out: MailItem[] = [];
    for (const id of ids) { // uno por uno: son pocos, y asi no se dispara el limite por segundo de Gmail
      const m = await this.get(`${GMAIL}/messages/${id}`, new URLSearchParams([['format', 'metadata'], ['metadataHeaders', 'From'], ['metadataHeaders', 'Subject'], ['metadataHeaders', 'Date']]), background).catch(() => null);
      if (m) out.push(this.mailItem(m));
    }
    this.mailCache.set(key, { at: Date.now(), value: out }); if (this.mailCache.size > 30) this.mailCache.delete(this.mailCache.keys().next().value!);
    return out;
  }

  /** Un correo completo (texto llano, hasta 6.000 caracteres). No marca nada como leido: el permiso es de solo lectura. */
  async mailRead(id: string): Promise<MailFull> {
    if (!this.has('correo')) throw new GoogleError('el permiso guardado no incluye el correo: vuelve a conectar Google en el panel');
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(String(id))) throw new GoogleError('ese correo no existe');
    const m = await this.get(`${GMAIL}/messages/${id}`, { format: 'full' });
    const body = mailBody(m?.payload), MAX = 6000;
    return { ...this.mailItem(m), to: clean(this.header(m, 'to'), 120), text: body.text.slice(0, MAX), truncated: body.text.length > MAX, attachments: body.attachments };
  }

  // ---------- Drive ----------
  /** Igual que `get`, pero devuelve texto (el contenido de un archivo) y corta lo que pase de `maxBytes`. */
  private async getText(url: string, params: Record<string, string>, maxBytes: number): Promise<{ text: string; cut: boolean }> {
    const today = this.day(); if (this.used.day !== today) this.used = { day: today, n: 0 };
    if (this.used.n >= this.cfg.googleDailyCalls) throw new GoogleError('se llegó al tope de consultas a Google de hoy');
    this.used.n++; this.usage?.add('google_calls');
    const res = await fetch(`${url}?${new URLSearchParams(params).toString()}`, { headers: { Authorization: `Bearer ${await this.accessToken()}` }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 401) this.access = undefined;
    if (!res.ok) { this.log.warn(`Google respondió ${res.status} en ${new URL(url).pathname.replace(/files\/[^/]+/, 'files/<id>')}`); throw new GoogleError(res.status === 403 ? 'Google no deja leer ese archivo (puede ser muy grande o no tener permiso de descarga)' : res.status === 404 ? 'Google no encontró ese archivo' : `Google respondió ${res.status}`, res.status); }
    const reader = res.body?.getReader(); if (!reader) return { text: '', cut: false };
    const chunks: Buffer[] = []; let size = 0, cut = false;
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) { chunks.push(Buffer.from(value.subarray(0, Math.max(0, value.length - (size - maxBytes))))); cut = true; void reader.cancel().catch(() => undefined); break; } chunks.push(Buffer.from(value)); }
    return { text: Buffer.concat(chunks).toString('utf8'), cut };
  }

  private driveFile(f: any): DriveFile {
    const mime = String(f?.mimeType ?? ''), at = new Date(String(f?.modifiedTime ?? ''));
    const kinds: Record<string, string> = { 'application/vnd.google-apps.document': 'Documento', 'application/vnd.google-apps.spreadsheet': 'Hoja de cálculo', 'application/vnd.google-apps.presentation': 'Presentación', 'application/vnd.google-apps.folder': 'Carpeta', 'application/vnd.google-apps.form': 'Formulario', 'application/pdf': 'PDF' };
    const kind = kinds[mime] ?? (mime.startsWith('image/') ? 'Imagen' : mime.startsWith('video/') ? 'Video' : mime.startsWith('audio/') ? 'Audio' : mime.startsWith('text/') ? 'Texto' : /word|officedocument\.wordprocessing/.test(mime) ? 'Word' : /excel|officedocument\.spreadsheet/.test(mime) ? 'Excel' : /powerpoint|officedocument\.presentation/.test(mime) ? 'PowerPoint' : 'Archivo');
    return { id: String(f?.id ?? ''), name: clean(f?.name, 100) || '(sin nombre)', kind, mime, owner: clean(f?.owners?.[0]?.displayName, 50),
      when: Number.isNaN(at.getTime()) ? '' : new Intl.DateTimeFormat('es-CO', { timeZone: this.cfg.timezone, day: 'numeric', month: 'short', year: 'numeric' }).format(at),
      readable: ['application/vnd.google-apps.document', 'application/vnd.google-apps.spreadsheet', 'application/vnd.google-apps.presentation', 'application/json'].includes(mime) || mime.startsWith('text/') };
  }

  /**
   * Busca archivos en Drive por nombre o por contenido; sin texto, los modificados mas recientemente. No trae la papelera
   * ni carpetas. Los nombres (y lo que haya dentro) pueden ser de terceros: tambien llegan archivos que otros compartieron.
   */
  async files(query = '', max = 6): Promise<DriveFile[]> {
    if (!this.has('drive')) throw new GoogleError(this.connected ? 'el permiso guardado no incluye Drive: vuelve a conectar Google en el panel' : 'Google no está conectado: se conecta en el panel, en Dispositivos');
    const text = clean(query, 120), n = Math.max(1, Math.min(10, Math.floor(max) || 6)), key = `${text}/${n}`;
    const hit = this.fileCache.get(key); if (hit && Date.now() - hit.at < 45_000) return hit.value;
    const quoted = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); // en la consulta de Drive, la comilla y la barra invertida van escapadas
    const base = "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
    const d = await this.get(`${DRIVE}/files`, { q: text ? `(name contains '${quoted}' or fullText contains '${quoted}') and ${base}` : base, pageSize: String(n), fields: 'files(id,name,mimeType,modifiedTime,owners(displayName))', ...(text ? {} : { orderBy: 'modifiedTime desc' }) });
    const out = (Array.isArray(d?.files) ? d.files : []).filter((f: any) => /^[A-Za-z0-9_-]{10,100}$/.test(String(f?.id ?? ''))).slice(0, n).map((f: any) => this.driveFile(f));
    this.fileCache.set(key, { at: Date.now(), value: out }); if (this.fileCache.size > 30) this.fileCache.delete(this.fileCache.keys().next().value!);
    return out;
  }

  /**
   * El texto de un archivo (hasta 6.000 caracteres). Documentos y presentaciones de Google salen como texto llano, las
   * hojas de calculo como CSV de su primera hoja, y los archivos de texto tal cual. PDF, Word, imagenes y demas NO se leen
   * aqui: se devuelve solo su ficha, con una nota.
   */
  async fileRead(id: string): Promise<DriveDoc> {
    if (!this.has('drive')) throw new GoogleError('el permiso guardado no incluye Drive: vuelve a conectar Google en el panel');
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(String(id))) throw new GoogleError('ese archivo no existe');
    const meta = this.driveFile(await this.get(`${DRIVE}/files/${id}`, { fields: 'id,name,mimeType,modifiedTime,owners(displayName)' })), MAX = 6000;
    if (!meta.readable) return { ...meta, text: '', truncated: false, note: `es ${meta.kind === 'Archivo' ? 'un archivo' : `un ${meta.kind}`.replace('un Imagen', 'una imagen').replace('un Hoja', 'una hoja').replace('un Presentación', 'una presentación')} y aquí solo se pueden leer documentos, hojas de cálculo, presentaciones de Google y archivos de texto` };
    const google = meta.mime.startsWith('application/vnd.google-apps.');
    const r = google ? await this.getText(`${DRIVE}/files/${id}/export`, { mimeType: meta.mime.endsWith('spreadsheet') ? 'text/csv' : 'text/plain' }, 400_000) : await this.getText(`${DRIVE}/files/${id}`, { alt: 'media' }, 400_000);
    const text = r.text.replace(/^﻿/, '').replace(/\r/g, '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return { ...meta, text: text.slice(0, MAX), truncated: r.cut || text.length > MAX, note: meta.mime.endsWith('spreadsheet') ? 'solo la primera hoja' : '' };
  }
}

/** Texto de una parte de un correo (base64url). */
const decode = (data: unknown) => { try { return Buffer.from(String(data ?? ''), 'base64url').toString('utf8'); } catch { return ''; } };
/** HTML de un correo a texto llano: sin etiquetas, estilos ni guiones, con los saltos de parrafo. */
export function htmlToText(html: string): string {
  return html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#(\d+);/g, (_m, n) => { const c = Number(n); return c > 31 && c < 0x10ffff ? String.fromCodePoint(c) : ' '; });
}
/** El cuerpo legible de un mensaje: prefiere el texto llano; si solo hay HTML, lo convierte. Cuenta los adjuntos. */
export function mailBody(payload: any): { text: string; attachments: number } {
  let plain = '', html = '', attachments = 0;
  const walk = (p: any, depth: number) => {
    if (!p || typeof p !== 'object' || depth > 8) return;
    if (p.filename) { attachments++; return; }
    if (p.mimeType === 'text/plain' && p.body?.data && !plain) plain = decode(p.body.data);
    else if (p.mimeType === 'text/html' && p.body?.data && !html) html = decode(p.body.data);
    for (const c of Array.isArray(p.parts) ? p.parts.slice(0, 30) : []) walk(c, depth + 1);
  };
  walk(payload, 0);
  const text = (plain || htmlToText(html)).replace(/\r/g, '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, attachments };
}

/** La agenda en texto, para el modelo (va envuelta como dato por quien la use). */
export function describeAgenda(a: Agenda): string {
  if (!a.total) return `${a.title}: no hay nada en la agenda.`;
  return a.days.filter((d) => d.events.length).map((d) => `${d.label}:\n${d.events.map((e) => `- ${e.time}: ${e.title}${e.where ? ` (${e.where})` : ''}${e.others ? `, con ${e.others} ${e.others === 1 ? 'persona' : 'personas'} más` : ''}${e.tentative ? ' [sin confirmar]' : ''}`).join('\n')}`).join('\n') + (a.truncated ? '\n(Hay más eventos que no caben aquí.)' : '');
}
