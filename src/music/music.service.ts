import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { UsageService } from '../usage/usage.service';
import { SpotifyService } from './spotify.service';

export type MusicSource = 'spotify' | 'youtube';
/** `channel` es el canal (YouTube) o los artistas (Spotify). `uri`, `image`, `url` y `album` solo vienen de Spotify. */
export interface Track { id: string; title: string; channel: string; source?: MusicSource; uri?: string; image?: string; url?: string; album?: string; }
/**
 * Musica de una sesion: la cola la decide el servidor; el navegador la reproduce y avisa cuando cambia de cancion.
 * `query` es la ultima busqueda (para repetirla en YouTube si el reproductor de Spotify falla en el navegador);
 * `note` explica por que no suena Spotify; `spotifyOff` evita reintentarlo en esta sesion tras un fallo del reproductor.
 */
export interface MusicState { queue: Track[]; index: number; volume: number; playing: boolean; since: number; source: MusicSource; query: string; note: string; spotifyOff: boolean; }

const decode = (t: string) => t.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/**
 * Busqueda de musica en YouTube (Data API v3). Verificado con la documentacion y una llamada real el 2026-11-17:
 *  GET https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&q=...&key=...
 *  -> items[].id.videoId, snippet.title, snippet.channelTitle. videoEmbeddable exige type=video.
 * La cuota por defecto es de solo 100 busquedas al dia: cada busqueda trae varias canciones (sirven para "la siguiente"),
 * se guarda 24 h y hay un tope diario propio. La reproduccion la hace el navegador con el reproductor oficial (IFrame
 * API), visible y de al menos 200x200 px, como exigen las politicas de YouTube; no se extrae el audio.
 */
@Injectable()
export class MusicService {
  private readonly log = new Logger(MusicService.name);
  private readonly cache = new Map<string, { at: number; tracks: Track[] }>();
  private day = ''; private used = 0;
  constructor(private readonly cfg: ConfigService, private readonly usage: UsageService, @Optional() private readonly spotify?: SpotifyService) {}

  get youtube() { return !!this.cfg.youtubeApiKey; }
  /** Hay musica si existe cualquiera de las dos fuentes (Spotify cuenta desde que esta configurado, aunque falte conectarlo). */
  get enabled() { return this.youtube || !!this.spotify?.configured; }
  newState(): MusicState { return { queue: [], index: 0, volume: this.cfg.musicVolume, playing: false, since: 0, source: 'youtube', query: '', note: '', spotifyOff: false }; }

  /**
   * Busca primero en Spotify y, si no esta conectado, falla o no trae nada, en YouTube. `note` dice por que no fue Spotify.
   * Lanza solo si ninguna fuente pudo.
   */
  async find(query: string, skipSpotify = false): Promise<{ tracks: Track[]; source: MusicSource; note: string }> {
    let note = '';
    if (this.spotify?.configured && !skipSpotify) {
      if (!this.spotify.connected) note = 'Spotify no está conectado (se conecta en el panel)';
      else try {
        const tracks = await this.spotify.search(query);
        if (tracks.length) return { tracks, source: 'spotify', note: '' };
        note = 'Spotify no encontró nada con esa búsqueda';
      } catch (e) { note = (e as Error).message; this.log.warn(`Spotify falló, se sigue con YouTube: ${note}`); }
    }
    if (!this.youtube) { if (note) throw new Error(note); return { tracks: [], source: 'youtube', note }; }
    return { tracks: await this.search(query), source: 'youtube', note };
  }

  /** El reproductor de Spotify fallo en el navegador: la misma busqueda sigue en YouTube. `undefined` = no hay como seguir. */
  async fallback(m: MusicState, reason: string): Promise<Record<string, unknown> | undefined> {
    if (m.source !== 'spotify' || !m.queue.length) return undefined;
    m.spotifyOff = true; m.note = `el reproductor de Spotify falló en este navegador (${reason.replace(/\s+/g, ' ').slice(0, 80)})`;
    this.log.warn(`música: ${m.note}; se sigue con YouTube`);
    let tracks: Track[] = [];
    if (this.youtube) try { tracks = await this.search(m.query || this.cfg.musicDefaultQuery); } catch (e) { this.log.warn(`YouTube tampoco pudo: ${(e as Error).message}`); }
    if (!tracks.length) { m.queue = []; m.index = 0; m.playing = false; m.since = 0; return { action: 'stop' }; }
    m.queue = tracks; m.index = 0; m.source = 'youtube'; m.playing = true;
    return { action: 'play', source: 'youtube', queue: m.queue, index: 0, volume: m.volume };
  }

  /** Token de acceso de Spotify para el reproductor del navegador del dueño. */
  async spotifyToken(): Promise<string> { if (!this.spotify) throw new Error('Spotify no está configurado'); return this.spotify.accessToken(); }

  async search(query: string): Promise<Track[]> {
    const q = query.replace(/\s+/g, ' ').trim().slice(0, 120), key = q.toLowerCase();
    if (!q) return [];
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.tracks;
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.used = 0; }
    if (this.used >= this.cfg.musicDailySearches) throw new Error('se alcanzó el tope de búsquedas de música de hoy');
    this.used++; this.usage.add('youtube_searches');
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.search = new URLSearchParams({ part: 'snippet', q, type: 'video', videoEmbeddable: 'true', videoSyndicated: 'true', maxResults: '10', safeSearch: 'moderate', key: this.cfg.youtubeApiKey }).toString();
    let res: Response;
    try { res = await fetch(url, { signal: AbortSignal.timeout(6000) }); }
    catch (e) { throw new Error(`no se pudo conectar con YouTube (${(e as Error).name})`); } // sin el mensaje: podria traer la URL con la clave
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok) { this.log.warn(`YouTube respondió ${res.status}: ${String(d.error?.errors?.[0]?.reason ?? 'sin detalle')}`); throw new Error(`YouTube respondió ${res.status}${d.error?.errors?.[0]?.reason === 'quotaExceeded' ? ' (se acabó la cuota de hoy)' : ''}`); }
    const tracks: Track[] = (d.items ?? []).filter((i: any) => i.id?.videoId)
      .map((i: any) => ({ source: 'youtube' as const, id: String(i.id.videoId), title: decode(String(i.snippet?.title ?? '')).slice(0, 100), channel: decode(String(i.snippet?.channelTitle ?? '')).slice(0, 60) }));
    this.cache.set(key, { at: Date.now(), tracks });
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value!);
    this.log.log(`música: "${q}" -> ${tracks.length} resultados (búsqueda ${this.used}/${this.cfg.musicDailySearches} de hoy)`);
    return tracks;
  }
}
