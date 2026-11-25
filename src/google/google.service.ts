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
 *  - Leer mejor y crear (referencias de Docs v1, Sheets v4, Slides v1 y Drive v3 leidas el 2026-11-24): Sheets
 *    `GET .../spreadsheets/{id}` (pestañas) y `.../values:batchGet?ranges=` y Slides `GET .../presentations/{id}` aceptan
 *    `drive.readonly`. Crear: `POST .../drive/v3/files` (solo metadatos: nombre, tipo y carpeta) y
 *    `POST docs.googleapis.com/v1/documents/{id}:batchUpdate` (insertText, updateParagraphStyle, createParagraphBullets)
 *    aceptan `drive.file`. El valor `BULLET_DISC_CIRCLE_SQUARE` de las viñetas y la forma exacta de las diapositivas
 *    vienen de conocimiento previo, no de esas paginas: si el formato falla, el documento queda en texto llano.
 *  - Hojas y presentaciones nuevas (referencias de Sheets v4 y Slides v1 leidas el 2026-11-24): `POST
 *    .../spreadsheets/{id}/values:batchUpdate` y `.../spreadsheets/{id}:batchUpdate`, y `POST
 *    .../presentations/{id}:batchUpdate` (createSlide con `slideLayoutReference.predefinedLayout` y
 *    `placeholderIdMappings`, insertText, deleteObject, createImage con una `url` PUBLICA de hasta 2 KB) aceptan
 *    `drive.file`. Los identificadores propios van de 5 a 50 caracteres. De conocimiento previo, no de esas paginas: la
 *    forma de `placeholderIdMappings` ({layoutPlaceholder: {type, index}, objectId}), las medidas en EMU y que un archivo
 *    recien creado trae una diapositiva (o una hoja con id 0) por defecto. Por eso cada parte dudosa va en su propio
 *    envio: si falla, lo demas queda.
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
const DOCS = 'https://docs.googleapis.com/v1/documents', SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets', SLIDES = 'https://slides.googleapis.com/v1/presentations';
const FOLDER_KEY = 'google_folder', FOLDER_NAME = 'minijavi', MIME_FOLDER = 'application/vnd.google-apps.folder', MIME_DOC = 'application/vnd.google-apps.document', MIME_SHEET = 'application/vnd.google-apps.spreadsheet', MIME_SLIDES = 'application/vnd.google-apps.presentation';
const ID = '[A-Za-z0-9_-]{10,100}';
/** Permisos por parte. Cada parte nueva (correo, Drive) suma el suyo y pide volver a conectar: nunca se pide de mas. */
export const GOOGLE_SCOPES = { agenda: 'https://www.googleapis.com/auth/calendar.readonly', correo: 'https://www.googleapis.com/auth/gmail.readonly', drive: 'https://www.googleapis.com/auth/drive.readonly', crear: 'https://www.googleapis.com/auth/drive.file' } as const;
export type GooglePart = keyof typeof GOOGLE_SCOPES;
/**
 * Lo unico que esta clase acepta tener: permisos de lectura y UNO de escritura, `drive.file`, con el que Google solo deja
 * tocar los archivos que esta misma aplicacion creo (los demas siguen siendo de solo lectura). Cualquier otro no se guarda.
 */
const WRITE_OWN = 'https://www.googleapis.com/auth/drive.file';
const READ_ONLY = /^(openid|email|profile|https:\/\/www\.googleapis\.com\/auth\/(userinfo\.(email|profile)|[a-z.]+\.readonly))$/;

interface Stored { refresh: string; scope: string; since: string; account: string }
export interface AgendaEvent { title: string; start: string; end: string; allDay: boolean; time: string; where: string; tentative: boolean; others: number }
export interface AgendaDay { date: string; label: string; events: AgendaEvent[] }
export interface Agenda { title: string; from: string; to: string; days: AgendaDay[]; total: number; truncated: boolean }
export interface MailItem { id: string; from: string; subject: string; date: string; when: string; snippet: string; unread: boolean }
export interface MailFull extends MailItem { to: string; text: string; truncated: boolean; attachments: number }
export interface DriveFile { id: string; name: string; kind: string; mime: string; when: string; owner: string; readable: boolean }
export interface DriveDoc extends DriveFile { text: string; truncated: boolean; note: string; /** Hojas de calculo: nombres de sus pestañas y cual se leyo. */ tabs?: string[]; tab?: string }
export interface CreatedFile { id: string; title: string; link: string; chars: number; styled: boolean; /** Presentaciones: cuantas diapositivas e imagenes quedaron. */ slides?: number; images?: number; rows?: number }
export interface SlideSpec { title: string; points: string[]; /** Direccion publica de la imagen de esta diapositiva (opcional). */ image?: string }
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
    const extra = granted.filter((s) => !READ_ONLY.test(s) && s !== WRITE_OWN);
    if (extra.length) { void this.revoke(String(d.refresh_token || d.access_token)); throw new GoogleError('Google devolvió un permiso que no es de los pedidos; no se guardó nada'); }
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
  async fileRead(id: string, tab = ''): Promise<DriveDoc> {
    if (!this.has('drive')) throw new GoogleError('el permiso guardado no incluye Drive: vuelve a conectar Google en el panel');
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(String(id))) throw new GoogleError('ese archivo no existe');
    const meta = this.driveFile(await this.get(`${DRIVE}/files/${id}`, { fields: 'id,name,mimeType,modifiedTime,owners(displayName)' })), MAX = 6000;
    if (!meta.readable) return { ...meta, text: '', truncated: false, note: `es ${meta.kind === 'Archivo' ? 'un archivo' : `un ${meta.kind}`.replace('un Imagen', 'una imagen').replace('un Hoja', 'una hoja').replace('un Presentación', 'una presentación')} y aquí solo se pueden leer documentos, hojas de cálculo, presentaciones de Google y archivos de texto` };
    // Hojas de calculo y presentaciones: por sus propias API (todas las pestañas; cada diapositiva con sus notas). Si esa
    // API no esta encendida en el proyecto o falla, se cae a la exportacion de Drive de siempre.
    if (meta.mime.endsWith('spreadsheet')) { const r = await this.sheetRead(id, tab).catch(() => null); if (r) return { ...meta, text: r.text.slice(0, MAX), truncated: r.text.length > MAX, note: r.tabs.length > 1 ? `pestaña «${r.tab}» de ${r.tabs.length}` : '', tabs: r.tabs, tab: r.tab }; }
    if (meta.mime.endsWith('presentation')) { const r = await this.slidesRead(id).catch(() => null); if (r) return { ...meta, text: r.text.slice(0, MAX), truncated: r.text.length > MAX, note: `${r.slides} diapositiva${r.slides === 1 ? '' : 's'}` }; }
    const google = meta.mime.startsWith('application/vnd.google-apps.');
    const r = google ? await this.getText(`${DRIVE}/files/${id}/export`, { mimeType: meta.mime.endsWith('spreadsheet') ? 'text/csv' : 'text/plain' }, 400_000) : await this.getText(`${DRIVE}/files/${id}`, { alt: 'media' }, 400_000);
    const text = r.text.replace(/^﻿/, '').replace(/\r/g, '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return { ...meta, text: text.slice(0, MAX), truncated: r.cut || text.length > MAX, note: meta.mime.endsWith('spreadsheet') ? 'solo la primera hoja' : '' };
  }

  /** Una hoja de calculo por la API de Sheets: sus pestañas y los valores de una (la pedida, o la primera). */
  private async sheetRead(id: string, tab: string): Promise<{ text: string; tabs: string[]; tab: string }> {
    const meta = await this.get(`${SHEETS}/${id}`, { fields: 'sheets.properties(title,sheetType)' });
    const tabs: string[] = (Array.isArray(meta?.sheets) ? meta.sheets : []).filter((x: any) => (x?.properties?.sheetType ?? 'GRID') === 'GRID').map((x: any) => clean(x?.properties?.title, 80)).filter(Boolean).slice(0, 40);
    if (!tabs.length) throw new GoogleError('la hoja no tiene pestañas');
    const want = clean(tab, 80).toLowerCase(), pick = tabs.find((t) => t.toLowerCase() === want) ?? tabs.find((t) => want && t.toLowerCase().includes(want)) ?? tabs[0];
    const d = await this.get(`${SHEETS}/${id}/values:batchGet`, { ranges: `'${pick.replace(/'/g, "''")}'!A1:Z200` });
    const rows: unknown[][] = Array.isArray(d?.valueRanges?.[0]?.values) ? d.valueRanges[0].values : [];
    return { tabs, tab: pick, text: rows.map((r) => (Array.isArray(r) ? r : []).map((c) => clean(c, 200)).join(' | ')).filter((l) => l.replace(/[| ]/g, '')).join('\n') };
  }

  /** Una presentacion por la API de Slides: el texto de cada diapositiva y sus notas del orador. */
  private async slidesRead(id: string): Promise<{ text: string; slides: number }> {
    const d = await this.get(`${SLIDES}/${id}`, { fields: 'slides(pageElements(shape(text(textElements(textRun(content)))),table(tableRows(tableCells(text(textElements(textRun(content))))))),slideProperties(notesPage(pageElements(shape(text(textElements(textRun(content))))))))' });
    const runs = (el: any): string => (Array.isArray(el?.shape?.text?.textElements) ? el.shape.text.textElements : []).map((t: any) => String(t?.textRun?.content ?? '')).join('')
      + (Array.isArray(el?.table?.tableRows) ? el.table.tableRows.map((r: any) => (r?.tableCells ?? []).map((c: any) => (c?.text?.textElements ?? []).map((t: any) => String(t?.textRun?.content ?? '')).join('').trim()).join(' | ')).join('\n') : '');
    const tidy = (t: string) => t.replace(/\r/g, '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
    const slides: any[] = Array.isArray(d?.slides) ? d.slides.slice(0, 80) : [];
    const text = slides.map((sl, k) => { const body = tidy((sl?.pageElements ?? []).map(runs).join('\n')), notes = tidy((sl?.slideProperties?.notesPage?.pageElements ?? []).map(runs).join('\n')); return `Diapositiva ${k + 1}:\n${body || '(sin texto)'}${notes ? `\nNotas: ${notes}` : ''}`; }).join('\n\n');
    return { text, slides: slides.length };
  }

  // ---------- crear ----------
  /**
   * Lo UNICO que esta clase envia para cambiar algo, y solo hacia dos cosas: crear un archivo en Drive (una carpeta, o un
   * documento, hoja o presentacion vacios) y escribir dentro de un archivo recien creado. No hay borrar, mover, compartir ni cambiar permisos. Ademas el
   * permiso (`drive.file`) solo alcanza a los archivos que esta aplicacion creo.
   */
  private async write(url: string, body: Record<string, unknown>, params: Record<string, string> = {}): Promise<any> {
    if (!this.has('crear')) throw new GoogleError(this.connected ? 'el permiso guardado no incluye crear documentos: vuelve a conectar Google en el panel' : 'Google no está conectado: se conecta en el panel, en Dispositivos');
    const ok = url === `${DRIVE}/files` ? [MIME_FOLDER, MIME_DOC, MIME_SHEET, MIME_SLIDES].includes(String(body.mimeType)) && !('permissions' in body)
      : new RegExp(`^https://docs\\.googleapis\\.com/v1/documents/${ID}:batchUpdate$`).test(url) || new RegExp(`^https://sheets\\.googleapis\\.com/v4/spreadsheets/${ID}(/values)?:batchUpdate$`).test(url) || new RegExp(`^https://slides\\.googleapis\\.com/v1/presentations/${ID}:batchUpdate$`).test(url);
    if (!ok) throw new GoogleError('esa operación no está permitida');
    const today = this.day(); if (this.used.day !== today) this.used = { day: today, n: 0 };
    if (this.used.n >= this.cfg.googleDailyCalls) throw new GoogleError('se llegó al tope de consultas a Google de hoy');
    this.used.n++; this.usage?.add('google_calls');
    const q = new URLSearchParams(params).toString();
    const res = await fetch(q ? `${url}?${q}` : url, { method: 'POST', headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (res.status === 401) this.access = undefined;
    if (!res.ok) {
      const err: any = await res.json().catch(() => ({})), why = JSON.stringify([err?.error?.status, err?.error?.errors, err?.error?.message]).slice(0, 800);
      this.log.warn(`Google respondió ${res.status} al crear (${new URL(url).hostname})`);
      if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used in project|is disabled/i.test(why)) throw new GoogleError(`la ${/docs\./.test(url) ? 'Google Docs API' : /sheets\./.test(url) ? 'Google Sheets API' : /slides\./.test(url) ? 'Google Slides API' : 'Google Drive API'} no está encendida en tu proyecto de Google Cloud`, 403);
      throw new GoogleError(res.status === 403 ? 'Google no dejó crear el archivo (permiso insuficiente)' : `Google respondió ${res.status} al crear`, res.status);
    }
    return res.json().catch(() => ({}));
  }

  /** La carpeta «minijavi» del Drive, creada por el avatar (solo en una carpeta suya puede poner archivos). Se recuerda su identificador. */
  private async folder(): Promise<string> {
    const saved = (await this.db.query<{ value: string }>('SELECT value FROM meta WHERE key = $1', [FOLDER_KEY]))[0]?.value;
    if (saved && /^[A-Za-z0-9_-]{10,100}$/.test(saved)) { const f = await this.get(`${DRIVE}/files/${saved}`, { fields: 'id,trashed' }).catch(() => null); if (f?.id && !f.trashed) return saved; }
    const made = await this.write(`${DRIVE}/files`, { name: FOLDER_NAME, mimeType: MIME_FOLDER }, { fields: 'id' });
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(String(made?.id ?? ''))) throw new GoogleError('Google no devolvió la carpeta creada');
    await this.db.query('DELETE FROM meta WHERE key = $1', [FOLDER_KEY]); await this.db.query('INSERT INTO meta (key, value) VALUES ($1, $2)', [FOLDER_KEY, made.id]);
    return made.id;
  }

  /** Cuantos archivos ha creado hoy (hora del negocio) y el tope. */
  async createdToday(): Promise<{ n: number; limit: number }> {
    const since = this.startOf(this.day()).toISOString();
    return { n: (await this.db.query('SELECT id FROM google_created WHERE at >= $1', [since])).length, limit: this.cfg.googleCreateDaily };
  }
  created(limit = 8) { return this.db.query<{ id: number; at: string; kind: string; file_id: string; title: string; chars: number; source: string }>('SELECT * FROM google_created ORDER BY id DESC LIMIT $1', [Math.min(50, limit)]); }

  /**
   * Crea un documento de Google NUEVO y privado en la carpeta «minijavi». `content` usa un formato minimo: "# " titulo de
   * seccion, "## " subtitulo, "- " viñeta; lo demas, parrafos. `source`: de donde salio el texto (para el registro).
   * No comparte el documento con nadie y no toca ningun otro archivo.
   */
  async createDoc(title: string, content: string, source = 'dictado'): Promise<CreatedFile> {
    const name = clean(title, 120), text = String(content ?? '').replace(/\r/g, '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, 30_000);
    if (name.length < 2) throw new GoogleError('falta el título del documento');
    if (text.length < 10) throw new GoogleError('falta el contenido del documento');
    const today = await this.createdToday();
    if (today.limit <= 0) throw new GoogleError('crear documentos está apagado (GOOGLE_CREAR_DIA=0)');
    if (today.n >= today.limit) throw new GoogleError(`ya se crearon ${today.n} archivos hoy, que es el tope`);
    const made = await this.write(`${DRIVE}/files`, { name, mimeType: MIME_DOC, parents: [await this.folder()] }, { fields: 'id,webViewLink' });
    const id = String(made?.id ?? ''); if (!/^[A-Za-z0-9_-]{10,100}$/.test(id)) throw new GoogleError('Google no devolvió el documento creado');
    await this.db.query('INSERT INTO google_created (at, kind, file_id, title, chars, source) VALUES ($1, $2, $3, $4, $5, $6)', [new Date().toISOString(), 'documento', id, name, text.length, clean(source, 60)]);
    this.usage?.add('google_creados');
    // El texto entero de una vez, y despues el formato sobre los tramos que le tocan (las posiciones cuentan desde 1).
    const { plain, styles } = docRequests(text);
    await this.write(`${DOCS}/${id}:batchUpdate`, { requests: [{ insertText: { location: { index: 1 }, text: plain } }] });
    let styled = true;
    if (styles.length) await this.write(`${DOCS}/${id}:batchUpdate`, { requests: styles }).catch((e) => { styled = false; this.log.warn(`documento creado sin formato: ${(e as Error).message}`); });
    const link = typeof made.webViewLink === 'string' && made.webViewLink.startsWith('https://docs.google.com/') ? made.webViewLink : `https://docs.google.com/document/d/${id}/edit`;
    return { id, title: name, link, chars: plain.length, styled };
  }

  /** Crea el archivo vacio en la carpeta propia y lo anota. Comun a hojas y presentaciones. */
  private async newFile(kind: 'hoja' | 'presentacion', mime: string, title: string, chars: number, source: string): Promise<{ id: string; name: string }> {
    const name = clean(title, 120); if (name.length < 2) throw new GoogleError('falta el título');
    const today = await this.createdToday();
    if (today.limit <= 0) throw new GoogleError('crear archivos está apagado (GOOGLE_CREAR_DIA=0)');
    if (today.n >= today.limit) throw new GoogleError(`ya se crearon ${today.n} archivos hoy, que es el tope`);
    const made = await this.write(`${DRIVE}/files`, { name, mimeType: mime, parents: [await this.folder()] }, { fields: 'id' });
    const id = String(made?.id ?? ''); if (!new RegExp(`^${ID}$`).test(id)) throw new GoogleError('Google no devolvió el archivo creado');
    await this.db.query('INSERT INTO google_created (at, kind, file_id, title, chars, source) VALUES ($1, $2, $3, $4, $5, $6)', [new Date().toISOString(), kind, id, name, chars, clean(source, 60)]);
    this.usage?.add('google_creados');
    return { id, name };
  }

  /**
   * Crea una hoja de calculo NUEVA y privada con una tabla. Los valores se escriben TAL CUAL (`RAW`): un texto que
   * empiece por "=" queda como texto y no se ejecuta como formula (los datos pueden venir de terceros).
   */
  async createSheet(title: string, header: string[], rows: unknown[][], source = 'dictado'): Promise<CreatedFile> {
    const cell = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : clean(v, 500));
    const head = (Array.isArray(header) ? header : []).slice(0, 26).map((h) => clean(h, 80)), body = (Array.isArray(rows) ? rows : []).slice(0, 500).map((r) => (Array.isArray(r) ? r : [r]).slice(0, 26).map(cell));
    if (!head.filter(Boolean).length) throw new GoogleError('faltan los nombres de las columnas');
    if (!body.length) throw new GoogleError('la tabla no tiene filas');
    const chars = JSON.stringify(body).length, f = await this.newFile('hoja', MIME_SHEET, title, chars, source);
    await this.write(`${SHEETS}/${f.id}/values:batchUpdate`, { valueInputOption: 'RAW', data: [{ range: 'A1', values: [head, ...body] }] });
    // Encabezado en negrita y fijo. Va aparte: si la primera pestaña no tiene el identificador esperado, la tabla ya quedo.
    let styled = true;
    await this.write(`${SHEETS}/${f.id}:batchUpdate`, { requests: [
      { repeatCell: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
      { updateSheetProperties: { properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    ] }).catch((e) => { styled = false; this.log.warn(`hoja creada sin formato: ${(e as Error).message}`); });
    return { id: f.id, title: f.name, link: `https://docs.google.com/spreadsheets/d/${f.id}/edit`, chars, styled, rows: body.length };
  }

  /**
   * Crea una presentacion NUEVA y privada: portada, y una diapositiva por punto con su titulo, sus viñetas y, si trae,
   * su imagen a la derecha. Las imagenes las baja Google de la direccion publica que se le pasa; cada una va en su propio
   * envio para que una que falle no deje la presentacion sin las demas.
   */
  async createSlides(title: string, subtitle: string, slides: SlideSpec[], source = 'redactado'): Promise<CreatedFile> {
    const list = (Array.isArray(slides) ? slides : []).slice(0, 12).map((x) => ({ title: clean(x?.title, 120), points: (Array.isArray(x?.points) ? x.points : []).map((q) => clean(q, 220)).filter(Boolean).slice(0, 6), image: typeof x?.image === 'string' && /^https:\/\/[^\s]{8,1900}$/.test(x.image) ? x.image : '' })).filter((x) => x.title);
    if (!list.length) throw new GoogleError('la presentación no tiene diapositivas');
    const chars = JSON.stringify(list).length, f = await this.newFile('presentacion', MIME_SLIDES, title, chars, source);
    // Lo que el archivo traia al nacer (una diapositiva vacia) se quita al final, cuando ya existen las nuestras.
    const before: string[] = await this.get(`${SLIDES}/${f.id}`, { fields: 'slides(objectId)' }).then((d: any) => (Array.isArray(d?.slides) ? d.slides : []).map((x: any) => String(x?.objectId ?? '')).filter(Boolean)).catch(() => []);
    const { requests, images } = slideRequests(f.name, clean(subtitle, 160), list);
    await this.write(`${SLIDES}/${f.id}:batchUpdate`, { requests });
    let placed = 0, styled = true;
    for (const img of images) await this.write(`${SLIDES}/${f.id}:batchUpdate`, { requests: [img] }).then(() => { placed++; }).catch((e) => { styled = false; this.log.warn(`presentación: una imagen no entró (${(e as Error).message})`); });
    if (before.length) await this.write(`${SLIDES}/${f.id}:batchUpdate`, { requests: before.map((objectId) => ({ deleteObject: { objectId } })) }).catch(() => { styled = false; });
    return { id: f.id, title: f.name, link: `https://docs.google.com/presentation/d/${f.id}/edit`, chars, styled, slides: list.length + 1, images: placed };
  }
}

/**
 * Las ordenes para armar una presentacion: una portada (diseño TITLE) y, por cada punto, una diapositiva con titulo y
 * viñetas. Si la diapositiva lleva imagen se usa el diseño de dos columnas: el texto a la izquierda y, en vez de la
 * columna derecha, la imagen. Las imagenes se devuelven aparte para enviarlas una por una. Medidas en EMU (una
 * diapositiva 16:9 mide 9.144.000 x 5.143.500).
 */
export function slideRequests(title: string, subtitle: string, slides: SlideSpec[]): { requests: Record<string, unknown>[]; images: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = [], images: Record<string, unknown>[] = [];
  const map = (type: string, index: number, objectId: string) => ({ layoutPlaceholder: { type, index }, objectId });
  requests.push({ createSlide: { objectId: 'mj_portada', insertionIndex: 0, slideLayoutReference: { predefinedLayout: 'TITLE' }, placeholderIdMappings: [map('CENTERED_TITLE', 0, 'mj_portada_t'), map('SUBTITLE', 0, 'mj_portada_s')] } });
  requests.push({ insertText: { objectId: 'mj_portada_t', text: title } });
  if (subtitle) requests.push({ insertText: { objectId: 'mj_portada_s', text: subtitle } });
  slides.forEach((sl, k) => {
    const n = String(k + 1).padStart(2, '0'), page = `mj_dia_${n}`, t = `${page}_t`, b = `${page}_b`, r = `${page}_r`;
    requests.push({ createSlide: { objectId: page, insertionIndex: k + 1, slideLayoutReference: { predefinedLayout: sl.image ? 'TITLE_AND_TWO_COLUMNS' : 'TITLE_AND_BODY' }, placeholderIdMappings: [map('TITLE', 0, t), map('BODY', 0, b), ...(sl.image ? [map('BODY', 1, r)] : [])] } });
    requests.push({ insertText: { objectId: t, text: sl.title } });
    if (sl.points.length) requests.push({ insertText: { objectId: b, text: sl.points.join('\n') } });
    if (sl.image) {
      requests.push({ deleteObject: { objectId: r } });
      images.push({ createImage: { objectId: `${page}_img`, url: sl.image, elementProperties: { pageObjectId: page, size: { width: { magnitude: 3_900_000, unit: 'EMU' }, height: { magnitude: 2_600_000, unit: 'EMU' } }, transform: { scaleX: 1, scaleY: 1, translateX: 4_850_000, translateY: 1_500_000, unit: 'EMU' } } } });
    }
  });
  return { requests, images };
}

/**
 * El contenido de un documento, de su formato minimo a lo que pide la API de Docs: el texto llano completo y, aparte, el
 * formato de cada tramo (titulos y viñetas). Las posiciones son las del documento: cuentan desde 1 y en unidades UTF-16
 * (las mismas de `length` en JavaScript).
 */
export function docRequests(content: string): { plain: string; styles: Record<string, unknown>[] } {
  const styles: Record<string, unknown>[] = []; let plain = '', at = 1;
  for (const raw of content.split('\n')) {
    const h1 = /^#\s+(.*)$/.exec(raw), h2 = /^##\s+(.*)$/.exec(raw), li = /^\s*[-*•]\s+(.*)$/.exec(raw);
    const line = (h2?.[1] ?? h1?.[1] ?? li?.[1] ?? raw).replace(/\*\*(.+?)\*\*/g, '$1').trimEnd(), range = { startIndex: at, endIndex: at + line.length + 1 };
    if (line) {
      if (h2 || h1) styles.push({ updateParagraphStyle: { range, paragraphStyle: { namedStyleType: h2 ? 'HEADING_2' : 'HEADING_1' }, fields: 'namedStyleType' } });
      else if (li) styles.push({ createParagraphBullets: { range, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });
    }
    plain += `${line}\n`; at += line.length + 1;
  }
  return { plain, styles: styles.slice(0, 400) };
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
