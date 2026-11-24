import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { UsageService } from '../usage/usage.service';
import { SpotifyService } from './spotify.service';
import type { SpotifyDevice } from './spotify.service';
import { musicTile } from '../gadget/tiles';

export type MusicSource = 'spotify' | 'youtube';
/** `channel` es el canal (YouTube) o los artistas (Spotify). `uri`, `image`, `url` y `album` solo vienen de Spotify. */
export interface Track { id: string; title: string; channel: string; source?: MusicSource; uri?: string; image?: string; url?: string; album?: string; }
/**
 * Musica de una sesion: la cola la decide el servidor; el navegador la reproduce y avisa cuando cambia de cancion.
 * `query` es la ultima busqueda (para repetirla en YouTube si el reproductor de Spotify falla en el navegador);
 * `note` explica por que no suena Spotify; `spotifyOff` evita reintentarlo en esta sesion tras un fallo del reproductor.
 */
export interface MusicState { queue: Track[]; index: number; volume: number; playing: boolean; since: number; source: MusicSource; query: string; note: string; spotifyOff: boolean;
  /** Control remoto (placa de bolsillo): la música suena en otro dispositivo de Javier; aquí solo se dan las órdenes. */
  remote?: boolean; device?: { id: string; name: string }; }

/** Resultado de una orden del control remoto: lo que el avatar debe decir y, si hay algo sonando, su tarjeta. */
export interface RemoteResult { text: string; tile?: Record<string, unknown>; }

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

  // ---------- control remoto de Spotify (placa de bolsillo) ----------
  /** Hay Spotify configurado: la placa puede ofrecer el control remoto (si falta conectar o el permiso, la orden lo explica). */
  get remoteAvailable() { return !!this.spotify?.configured; }

  /** Elige dónde sonar: el que pidió Javier ("celular", "computador", un nombre); si no, el que ya está activo; si no, el celular. */
  pickDevice(devices: SpotifyDevice[], wanted = ''): SpotifyDevice | undefined {
    const w = wanted.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    if (w) {
      const type = /celu|telef|movil|iphone|android/.test(w) ? 'smartphone' : /compu|portatil|mac|pc|laptop/.test(w) ? 'computer' : /parlante|bocina|altavoz/.test(w) ? 'speaker' : /carro|tesla|auto/.test(w) ? 'automobile' : /tele|tv/.test(w) ? 'tv' : '';
      const hit = devices.find((d) => d.name.toLowerCase().includes(w)) ?? (type ? devices.find((d) => d.type === type) : undefined);
      if (hit) return hit;
      return undefined; // pidió uno que no está: no se manda a otro sin decirle
    }
    return devices.find((d) => d.active) ?? devices.find((d) => d.type === 'smartphone') ?? devices.find((d) => d.type === 'computer') ?? devices[0];
  }

  /** Orden dada con un toque en la pantalla de la placa: igual que por voz, pero siempre devuelve la tarjeta de lo que quedó. */
  async remoteTouch(m: MusicState, cmd: 'pausar' | 'continuar' | 'siguiente' | 'anterior'): Promise<RemoteResult> {
    const out = await this.remote(m, cmd, {});
    if (out.tile || !this.spotify?.canRemote || /^No se pudo/.test(out.text)) return out;
    try { // pausar no trae tarjeta: se pregunta qué quedó (en pausa) para dibujarla
      await new Promise((r) => setTimeout(r, 600));
      const p = await this.spotify.playback();
      if (p?.title) return { text: out.text, tile: musicTile({ device: p.device?.name ?? m.device?.name ?? 'Spotify', playing: p.playing, title: p.title, artist: p.artist, image: p.image }) };
    } catch { /* sin tarjeta: queda el texto */ }
    return out;
  }

  /** Una orden del control remoto. Nunca lanza: lo que falle vuelve como texto para que el avatar lo diga. */
  async remote(m: MusicState, action: string, args: { query?: string; where?: string; volume?: string }): Promise<RemoteResult> {
    const sp = this.spotify;
    if (!sp?.configured) return { text: 'Spotify no está configurado en el servidor.' };
    if (!sp.connected) return { text: 'Spotify no está conectado: Javier debe conectarlo en el panel, en Dispositivos.' };
    if (!sp.canRemote) return { text: 'La cuenta de Spotify se conectó antes de que existiera el control remoto: Javier debe pulsar "Volver a conectar" en el panel (Dispositivos) para dar el permiso que falta. Díselo así.' };
    const names = (list: SpotifyDevice[]) => list.map((d) => d.name).join(', ');
    const playing = async (wait = 0): Promise<RemoteResult | undefined> => {
      if (wait) await new Promise((r) => setTimeout(r, wait)); // Spotify no garantiza el orden: se le da un momento antes de preguntar qué quedó sonando
      const p = await sp.playback();
      if (!p || !p.title) return undefined;
      if (p.device) m.device = { id: p.device.id, name: p.device.name };
      return { text: `${p.playing ? 'Suena' : 'Está en pausa'} "${p.title}" de ${p.artist}${p.device ? ` en ${p.device.name}` : ''}.`, tile: musicTile({ device: p.device?.name ?? 'Spotify', playing: p.playing, title: p.title, artist: p.artist, image: p.image }) };
    };
    try {
      switch (action) {
        case 'poner': {
          const query = String(args.query || this.cfg.musicDefaultQuery);
          const [tracks, devices] = await Promise.all([sp.search(query), sp.devices()]);
          if (!tracks.length) return { text: 'No encontré música con esa búsqueda en Spotify. Pídele otra forma de decirlo.' };
          if (!devices.length) return { text: 'No hay ningún dispositivo con Spotify abierto. Dile a Javier que abra Spotify en el celular o en el computador y lo vuelva a pedir.' };
          const dev = this.pickDevice(devices, args.where);
          if (!dev) return { text: `No veo ese dispositivo con Spotify abierto. Los que hay son: ${names(devices)}. Pregúntale en cuál.` };
          await sp.playOn(dev.id, tracks.map((t) => t.uri!).filter(Boolean));
          m.queue = tracks; m.index = 0; m.source = 'spotify'; m.query = query; m.device = { id: dev.id, name: dev.name };
          const t = tracks[0];
          return { text: `Suena "${t.title}" de ${t.channel} en ${dev.name}, por Spotify. Hay ${tracks.length - 1} más en cola.${devices.length > 1 ? ` (Otros dispositivos disponibles: ${names(devices.filter((d) => d.id !== dev.id))}.)` : ''}`,
            tile: musicTile({ device: dev.name, playing: true, title: t.title, artist: t.channel, image: t.image }) };
        }
        case 'pausar': case 'quitar': await sp.command('pause', m.device?.id); return { text: 'Música en pausa.' };
        case 'continuar': await sp.command('resume', m.device?.id); return (await playing(700)) ?? { text: 'Sigue la música.' };
        case 'siguiente': case 'anterior': await sp.command(action === 'siguiente' ? 'next' : 'previous', m.device?.id); return (await playing(900)) ?? { text: 'Listo, cambié de canción.' };
        case 'volumen': {
          const v = String(args.volume ?? '').toLowerCase(), n = Number(v.replace(/[^0-9.]/g, ''));
          let target = Number.isFinite(n) && /\d/.test(v) ? n : NaN;
          if (Number.isNaN(target)) { const now = (await sp.playback())?.device?.volume ?? 50; target = v.includes('sub') ? now + 15 : v.includes('baj') ? now - 15 : now; }
          target = Math.round(Math.max(0, Math.min(100, target)));
          await sp.setVolume(target, m.device?.id);
          return { text: `Volumen de Spotify en ${target} por ciento. (Algunos dispositivos, como los celulares, no dejan cambiarlo desde fuera: si no cambió, díselo.)` };
        }
        case 'que_suena': return (await playing()) ?? { text: 'En Spotify no hay nada sonando ahora.' };
        default: return { text: 'No conozco esa acción de música.' };
      }
    } catch (e) {
      const why = (e as Error).message;
      this.log.warn(`música (control remoto): ${action} falló: ${why}`);
      return { text: `No se pudo: ${why}.${/40[34]/.test(why) ? ' Puede que no haya ningún dispositivo con Spotify abierto: dile que lo abra en el celular o el computador.' : ''}` };
    }
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
