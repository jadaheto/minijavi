import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { UsageService } from '../usage/usage.service';
import type { Track } from './music.service';

/**
 * Spotify como primera fuente de la musica del dueño. Documentacion leida el 2026-11-19 (developer.spotify.com):
 *  - Autorizacion (Authorization Code): GET accounts.spotify.com/authorize -> POST accounts.spotify.com/api/token con
 *    `Authorization: Basic base64(id:secreto)` y cuerpo form-urlencoded. El token de acceso dura 1 h; el de refresco, 6
 *    meses (no se extiende: luego hay que volver a conectar). Al refrescar puede venir o no un token de refresco nuevo.
 *  - Permisos: `streaming user-read-email user-read-private` (los pide el reproductor web) y
 *    `user-modify-playback-state` (PUT /v1/me/player/play, que hace el navegador).
 *  - Busqueda: GET api.spotify.com/v1/search?q&type=track&limit (maximo 10 desde febrero de 2026)&market.
 *  - Exige Premium. Limites: ventana de 30 s; 429 con `Retry-After`.
 * El secreto y el token de refresco no salen del servidor (el de refresco vive en la tabla `meta`, que no va en el
 * respaldo diario). El token de acceso (1 h) si llega al navegador del dueño: el reproductor web lo necesita.
 */
const SCOPES = 'streaming user-read-email user-read-private user-modify-playback-state';
const META_KEY = 'spotify_auth';
const REFRESH_DAYS = 180; // "6 meses" segun la documentacion; fecha aproximada para avisar en el panel

interface Stored { refresh: string; at: string; name?: string; scope?: string; }

@Injectable()
export class SpotifyService implements OnModuleInit {
  private readonly log = new Logger(SpotifyService.name);
  private stored?: Stored;
  private access?: { token: string; until: number };
  private refreshing?: Promise<string>;
  private readonly states = new Map<string, { until: number; redirect: string }>();
  private readonly cache = new Map<string, { at: number; tracks: Track[] }>();
  private pausedUntil = 0; // tras un 429 no se insiste hasta que pase la espera pedida
  lastError = '';

  constructor(private readonly cfg: ConfigService, private readonly db: DbService, private readonly usage: UsageService) {}

  /** Estan las tres variables (no dice si la cuenta esta conectada). */
  get configured() { return !!(this.cfg.spotifyClientId && this.cfg.spotifyClientSecret && this.cfg.spotifyRedirectUri); }
  get connected() { return this.configured && !!this.stored?.refresh; }

  async onModuleInit() {
    if (!this.configured) return;
    try {
      const raw = (await this.db.query('SELECT value FROM meta WHERE key = $1', [META_KEY]))[0]?.value;
      if (raw) this.stored = JSON.parse(String(raw));
    } catch (e) { this.log.warn(`no se pudo leer la conexión de Spotify: ${(e as Error).message}`); }
    this.log.log(`Spotify: ${this.connected ? 'cuenta conectada' : 'configurado, falta conectar la cuenta desde el panel'}`);
  }

  get status() {
    const at = this.stored?.at ? new Date(this.stored.at) : undefined;
    return { configured: this.configured, connected: this.connected, name: this.stored?.name ?? '', since: at?.toISOString() ?? '',
      expires: at ? new Date(at.getTime() + REFRESH_DAYS * 86400_000).toISOString() : '', error: this.lastError };
  }

  private basic() { return `Basic ${Buffer.from(`${this.cfg.spotifyClientId}:${this.cfg.spotifyClientSecret}`).toString('base64')}`; }

  /** Direccion a la que se manda al dueño para autorizar. `redirect` debe estar registrada en el panel de Spotify. */
  authUrl(redirect = this.cfg.spotifyRedirectUri): string {
    if (!this.configured) throw new Error('Spotify no está configurado');
    const now = Date.now();
    for (const [k, v] of this.states) if (v.until < now) this.states.delete(k);
    const state = randomBytes(24).toString('base64url');
    this.states.set(state, { until: now + 10 * 60_000, redirect });
    const url = new URL('https://accounts.spotify.com/authorize');
    url.search = new URLSearchParams({ client_id: this.cfg.spotifyClientId, response_type: 'code', redirect_uri: redirect, state, scope: SCOPES }).toString();
    return url.toString();
  }

  private async token(body: Record<string, string>): Promise<any> {
    let res: Response;
    try { res = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { Authorization: this.basic(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(8000) }); }
    catch (e) { throw new Error(`no se pudo conectar con Spotify (${(e as Error).name})`); }
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok || !d.access_token) throw Object.assign(new Error(`Spotify respondió ${res.status}${d.error ? ` (${String(d.error).slice(0, 60)})` : ''}`), { code: String(d.error ?? '') });
    return d;
  }

  private async save(s: Stored | undefined) {
    this.stored = s;
    if (s) await this.db.query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [META_KEY, JSON.stringify(s)]);
    else await this.db.query('DELETE FROM meta WHERE key = $1', [META_KEY]);
  }

  /** Vuelta de Spotify tras autorizar. El `state` lo emitio este servidor a un dispositivo del dueño y vale una vez. */
  async finish(code: string, state: string): Promise<void> {
    const st = this.states.get(state);
    this.states.delete(state);
    if (!st || st.until < Date.now()) throw new Error('la autorización venció o no la inició este panel');
    const d = await this.token({ grant_type: 'authorization_code', code, redirect_uri: st.redirect });
    if (!d.refresh_token) throw new Error('Spotify no entregó el permiso para seguir conectado');
    this.access = { token: String(d.access_token), until: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
    let name = '';
    try { // solo para mostrar en el panel a que cuenta quedo conectado
      const me = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${this.access.token}` }, signal: AbortSignal.timeout(6000) });
      if (me.ok) name = String(((await me.json()) as any)?.display_name ?? '').slice(0, 60);
    } catch { /* sin nombre */ }
    await this.save({ refresh: String(d.refresh_token), at: new Date().toISOString(), name, scope: String(d.scope ?? '') });
    this.lastError = '';
    this.log.log('Spotify: cuenta conectada');
  }

  async disconnect() { this.access = undefined; this.cache.clear(); await this.save(undefined); this.log.log('Spotify: cuenta desconectada'); }

  /** Token de acceso vigente (se renueva solo). Lanza si no hay cuenta conectada o Spotify ya no acepta la conexion. */
  async accessToken(): Promise<string> {
    if (!this.connected) throw new Error('Spotify no está conectado');
    if (this.access && this.access.until - Date.now() > 60_000) return this.access.token;
    this.refreshing ??= (async () => {
      try {
        const d = await this.token({ grant_type: 'refresh_token', refresh_token: this.stored!.refresh });
        this.access = { token: String(d.access_token), until: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
        if (d.refresh_token && d.refresh_token !== this.stored!.refresh) await this.save({ ...this.stored!, refresh: String(d.refresh_token) });
        this.lastError = '';
        return this.access.token;
      } catch (e) {
        if ((e as any).code === 'invalid_grant') { // vencio (6 meses) o Javier quito el permiso en su cuenta
          await this.save(undefined).catch(() => undefined); this.access = undefined;
          this.lastError = 'La conexión con Spotify venció o fue revocada: hay que volver a conectar la cuenta en el panel.';
          throw new Error('la conexión con Spotify venció; hay que volver a conectarla en el panel');
        }
        this.lastError = (e as Error).message;
        throw e;
      } finally { this.refreshing = undefined; }
    })();
    return this.refreshing;
  }

  async search(query: string): Promise<Track[]> {
    const q = query.replace(/\s+/g, ' ').trim().slice(0, 120), key = q.toLowerCase();
    if (!q) return [];
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.tracks;
    if (Date.now() < this.pausedUntil) throw new Error('Spotify pidió esperar por exceso de peticiones');
    const token = await this.accessToken();
    this.usage.add('spotify_searches');
    const url = new URL('https://api.spotify.com/v1/search');
    url.search = new URLSearchParams({ q, type: 'track', limit: '10', market: this.cfg.spotifyMarket }).toString();
    let res: Response;
    try { res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) }); }
    catch (e) { throw new Error(`no se pudo conectar con Spotify (${(e as Error).name})`); }
    if (res.status === 429) { const s = Math.min(3600, Number(res.headers.get('retry-after')) || 30); this.pausedUntil = Date.now() + s * 1000; throw new Error(`Spotify pidió esperar ${s} s por exceso de peticiones`); }
    if (res.status === 401) this.access = undefined; // el siguiente intento pide un token nuevo
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Spotify respondió ${res.status}${d.error?.message ? ` (${String(d.error.message).slice(0, 80)})` : ''}`);
    const clean = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const https = (u: unknown, host: RegExp) => { try { const x = new URL(String(u)); return x.protocol === 'https:' && host.test(x.hostname) ? x.toString() : ''; } catch { return ''; } };
    const tracks: Track[] = (d.tracks?.items ?? []).filter((t: any) => t && /^[A-Za-z0-9]{10,40}$/.test(String(t.id)) && t.is_playable !== false)
      .map((t: any) => ({
        source: 'spotify' as const, id: String(t.id), uri: `spotify:track:${t.id}`,
        title: clean(t.name, 100), channel: clean((t.artists ?? []).map((a: any) => a?.name).filter(Boolean).join(', '), 80), album: clean(t.album?.name, 80),
        // La caratula solo puede venir de los servidores de imagenes de Spotify (se muestra tal cual, sin recortar).
        image: https(t.album?.images?.[0]?.url, /(^|\.)(scdn\.co|spotifycdn\.com)$/),
        url: https(t.external_urls?.spotify, /^open\.spotify\.com$/) || `https://open.spotify.com/track/${t.id}`,
      }));
    this.cache.set(key, { at: Date.now(), tracks });
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value!);
    this.log.log(`música (Spotify): "${q}" -> ${tracks.length} resultados`);
    return tracks;
  }
}
