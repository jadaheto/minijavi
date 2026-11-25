import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { UsageService } from '../usage/usage.service';

/** Un elemento de la galeria en pantalla: una foto (thumb/full) o un boceto en vivo (frame = direccion de la pagina). */
export interface GalleryItem { thumb?: string; full?: string; frame?: string; label: string; credit?: string; link?: string; }
/** Galeria de la sesion: lo que se esta mostrando al lado del avatar y cual esta seleccionada (va de fondo). */
export interface GalleryState { title: string; kind: 'fotos' | 'bocetos' | 'generadas' | 'portafolio' | ''; items: GalleryItem[]; index: number; }

const FORMATS: Record<string, string> = { horizontal: 'widescreen_16_9', cuadrada: 'square_1_1', vertical: 'social_story_9_16' };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OPENAI_SIZES: Record<string, string> = { horizontal: '1536x1024', cuadrada: '1024x1024', vertical: '1024x1536' };
/** El proveedor rechazo la descripcion por su filtro de contenido: no se reintenta con otro. */
class Blocked extends Error {}

/**
 * Imagenes para la galeria del avatar (pedido por Javier el 2026-11-18).
 *
 * BUSQUEDA: Unsplash (Pexels tenia pausada la entrega de claves). Documentacion leida ese dia:
 *  - GET https://api.unsplash.com/search/photos?query=&per_page=(max 30)&orientation=landscape|portrait|squarish&content_filter=low|high
 *    con cabecera `Authorization: Client-ID <clave de acceso>`. Modo demo: 50 peticiones por hora.
 *  - EXIGEN usar directamente las direcciones `urls.*` que devuelve la API (enlazar, no copiar) y dar credito al fotografo
 *    y a Unsplash. `content_filter=high` quita contenido no apto para publico joven.
 *  - De cada resultado se usa urls.small, urls.regular, alt_description, user.name y links.html. Estos tres ultimos nombres
 *    NO se confirmaron en la lectura de la documentacion (se cortaba antes): comprobar con la primera busqueda real.
 *
 * GENERACION: Magnific (la API de Freepik), modelo Mystic. Documentacion leida ese dia:
 *  - POST https://api.magnific.com/v1/ai/mystic con cabecera `x-magnific-api-key`; cuerpo {prompt, aspect_ratio, resolution
 *    (1k|2k|4k), filter_nsfw (true y no se puede apagar)} -> {data: {task_id, status}}.
 *  - GET /v1/ai/mystic/{task-id} -> data.status CREATED|IN_PROGRESS|COMPLETED|FAILED y data.generated[] con la direccion.
 *  - La direccion caduca a los 30 minutos: la imagen se descarga y se guarda en DATA_DIR/imagenes. Cobra por creditos;
 *    el precio por imagen no esta en la documentacion.
 * SIN PROBAR con claves reales al escribir esto (Javier aun no las habia puesto): solo con respuestas simuladas.
 */
@Injectable()
export class ImagesService implements OnModuleInit {
  private readonly log = new Logger(ImagesService.name);
  private readonly cache = new Map<string, { at: number; items: GalleryItem[] }>();
  private day = ''; private used = 0; private generated = 0;
  private readonly dir: string;
  constructor(private readonly cfg: ConfigService, private readonly usage: UsageService, private readonly db: DbService) { this.dir = resolve(cfg.dataDir, 'imagenes'); } // absoluta: res.sendFile no acepta rutas relativas

  /** Hay busqueda de fotos. */
  get enabled() { return !!this.cfg.unsplashAccessKey; }
  /** Hay generacion de imagenes. */
  get canGenerate() { return !!this.cfg.imageOpenAiKey || !!this.cfg.magnificApiKey; }
  /** Quien genera, en orden, para el panel y los registros. */
  get generators(): string[] { return [this.cfg.imageOpenAiKey ? `OpenAI (${this.cfg.imageOpenAiModel})` : '', this.cfg.magnificApiKey ? 'Magnific' : ''].filter(Boolean); }
  newState(): GalleryState { return { title: '', kind: '', items: [], index: 0 }; }
  private today() { const t = new Date().toISOString().slice(0, 10); if (t !== this.day) { this.day = t; this.used = 0; this.generated = 0; } }

  async search(query: string, count = 6): Promise<GalleryItem[]> {
    const q = query.replace(/\s+/g, ' ').trim().slice(0, 100), key = q.toLowerCase(), n = Math.min(8, Math.max(1, Math.round(count) || 6));
    if (!q) return [];
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.items.slice(0, n);
    this.today();
    if (this.used >= this.cfg.imagesDailySearches) throw new Error('se alcanzó el tope de búsquedas de imágenes de hoy');
    this.used++; this.usage.add('image_searches');
    const url = new URL('https://api.unsplash.com/search/photos');
    url.search = new URLSearchParams({ query: q, per_page: '8', orientation: 'landscape', content_filter: 'high' }).toString();
    let res: Response;
    try { res = await fetch(url, { headers: { Authorization: `Client-ID ${this.cfg.unsplashAccessKey}`, 'Accept-Version': 'v1' }, signal: AbortSignal.timeout(6000) }); }
    catch (e) { throw new Error(`no se pudo conectar con Unsplash (${(e as Error).name})`); }
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok) { this.log.warn(`Unsplash respondió ${res.status}`); throw new Error(res.status === 403 ? 'Unsplash llegó a su límite por hora; se puede reintentar más tarde' : `Unsplash respondió ${res.status}`); }
    const clean = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const own = (v: unknown) => { const s = String(v ?? ''); return /^https:\/\/([a-z0-9-]+\.)?unsplash\.com\//i.test(s) ? s : ''; }; // solo direcciones de Unsplash
    const items: GalleryItem[] = (Array.isArray(d.results) ? d.results : []).map((p: any) => {
      const author = clean(p?.user?.name, 60);
      return { thumb: own(p?.urls?.small), full: own(p?.urls?.regular), label: clean(p?.alt_description ?? p?.description, 120) || q,
        credit: author ? `Foto de ${author} en Unsplash` : 'Foto de Unsplash', link: own(p?.links?.html) || 'https://unsplash.com' };
    }).filter((i: GalleryItem) => i.thumb && i.full);
    this.cache.set(key, { at: Date.now(), items });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    return items.slice(0, n);
  }

  /** Antes de lanzar una generacion: '' si se puede, o el motivo por el que no. Cuenta el intento. */
  reserveGeneration(count = 1): string {
    if (!this.canGenerate) return 'la generación de imágenes no está configurada';
    this.today();
    if (this.generated + count > this.cfg.imagesDailyGenerations) return 'se alcanzó el tope de imágenes generadas de hoy';
    this.generated += count; this.usage.add('image_generations', count);
    return '';
  }

  /** Descripcion y formato con que se genero una imagen guardada (para pedir cambios sobre ella). */
  async source(name: string): Promise<{ prompt: string; format: string } | undefined> {
    if (!this.file(name)) return undefined;
    const row = (await this.db.query<any>('SELECT prompt, format FROM generated_images WHERE name = $1', [name]).catch(() => []))[0];
    return { prompt: String(row?.prompt ?? ''), format: FORMATS[String(row?.format)] ? String(row.format) : 'horizontal' };
  }

  private async store(img: { buf: Buffer; type: string }, prompt: string, fmt: string): Promise<string> {
    if (img.buf.length < 500 || img.buf.length > 20 * 1024 * 1024) throw new Error('la imagen generada no tiene un tamaño válido');
    mkdirSync(this.dir, { recursive: true });
    const name = `${randomBytes(12).toString('hex')}.${img.type === 'image/png' ? 'png' : img.type === 'image/webp' ? 'webp' : 'jpg'}`;
    writeFileSync(join(this.dir, name), img.buf);
    await this.db.query('INSERT INTO generated_images (at, name, prompt, format, bytes) VALUES ($1, $2, $3, $4, $5)', [new Date().toISOString(), name, prompt.slice(0, 1500), fmt, img.buf.length])
      .catch((e) => this.log.warn(`la imagen se guardó pero no quedó anotada: ${(e as Error).message}`));
    return name;
  }

  /**
   * Varias versiones de una vez (pedido por Javier el 2026-11-19: tres para elegir). Sin `base` son imagenes nuevas de la
   * descripcion; con `base` (nombre de una ya generada) son CAMBIOS sobre esa imagen: OpenAI la recibe y la edita
   * (`POST /v1/images/edits`). Mismo orden de proveedores que `generate`. Magnific no edita: si toca el respaldo, se vuelve
   * a generar desde la descripcion original mas los cambios (`edited` queda en false y se avisa).
   */
  async generateSet(prompt: string, format = 'horizontal', count = 3, base?: string, signal?: AbortSignal): Promise<{ names: string[]; provider: 'OpenAI' | 'Magnific'; fallback?: string; edited: boolean }> {
    let fmt = FORMATS[format] ? format : 'horizontal', basePrompt = '', baseFile: string | null = null;
    if (base) {
      const src = await this.source(base); baseFile = this.file(base);
      if (!src || !baseFile) throw new Error('la imagen que se quiere cambiar ya no existe');
      basePrompt = src.prompt; fmt = src.format;
    }
    const full = base ? `${basePrompt ? `${basePrompt}\nCambios pedidos: ` : ''}${prompt}` : prompt;
    let imgs: { buf: Buffer; type: string }[] = [], provider: 'OpenAI' | 'Magnific' = 'OpenAI', fallback: string | undefined, edited = false;
    if (this.cfg.imageOpenAiKey) {
      try {
        imgs = await this.viaOpenAi(base ? `Modifica esta imagen conservando todo lo demás igual (composición, sujeto y estilo). Cambios pedidos: ${prompt}` : prompt, fmt, signal, count, baseFile ?? undefined);
        edited = !!base; this.usage.add('image_openai', imgs.length);
      } catch (e) {
        if (e instanceof Blocked || !this.cfg.magnificApiKey || signal?.aborted) throw e;
        fallback = (e as Error).message; this.log.warn(`imagen: ${fallback}; se intenta con Magnific`);
      }
    }
    if (!imgs.length) {
      const done = await Promise.allSettled(Array.from({ length: count }, () => this.viaMagnific(full, fmt, signal)));
      imgs = done.flatMap((d) => (d.status === 'fulfilled' ? [d.value] : []));
      if (!imgs.length) throw (done[0] as PromiseRejectedResult).reason;
      provider = 'Magnific'; this.usage.add('image_magnific', imgs.length);
    }
    const names: string[] = [];
    for (const img of imgs.slice(0, count)) names.push(await this.store(img, full, fmt));
    this.log.log(`${names.length} imagen(es) ${edited ? 'editada(s)' : 'generada(s)'} con ${provider}`);
    return { names, provider, fallback, edited };
  }

  /**
   * Genera una imagen y la guarda en DATA_DIR/imagenes (se sirve en /imagenes/<nombre>). Orden pedido por Javier el
   * 2026-11-19: PRIMERO OpenAI y, si falla (sin saldo, caido, clave, tiempo), Magnific. Si OpenAI la rechaza por su filtro
   * de contenido NO se reintenta con el otro proveedor. Devuelve el nombre, quien la hizo y, si hubo relevo, por que.
   */
  async generate(prompt: string, format = 'horizontal', signal?: AbortSignal, quality?: 'low' | 'medium' | 'high'): Promise<{ name: string; provider: 'OpenAI' | 'Magnific'; fallback?: string }> {
    const fmt = FORMATS[format] ? format : 'horizontal';
    let img: { buf: Buffer; type: string } | undefined, provider: 'OpenAI' | 'Magnific' = 'OpenAI', fallback: string | undefined;
    if (this.cfg.imageOpenAiKey) {
      try { img = (await this.viaOpenAi(prompt, fmt, signal, 1, undefined, quality))[0]; this.usage.add('image_openai'); }
      catch (e) {
        if (e instanceof Blocked || !this.cfg.magnificApiKey || signal?.aborted) throw e;
        fallback = (e as Error).message; this.log.warn(`imagen: ${fallback}; se intenta con Magnific`);
      }
    }
    if (!img) { img = await this.viaMagnific(prompt, fmt, signal); provider = 'Magnific'; this.usage.add('image_magnific'); }
    const name = await this.store(img, prompt, fmt);
    this.log.log(`imagen generada con ${provider} (${Math.round(img.buf.length / 1024)} KB)`);
    return { name, provider, fallback };
  }

  /**
   * OpenAI, `POST /v1/images/generations` (referencia leida el 2026-11-19 y probada con gpt-image-2.6-flare): los modelos
   * GPT Image devuelven siempre la imagen en `data[0].b64_json`. No se confirmo en la documentacion la forma exacta del
   * rechazo por contenido: se reconoce por `moderation_blocked` o por las palabras de su mensaje.
   */
  private async viaOpenAi(prompt: string, format: string, signal?: AbortSignal, n = 1, editFile?: string, quality?: string): Promise<{ buf: Buffer; type: string }[]> {
    // Con `editFile` se editan imagenes: `POST /v1/images/edits` en JSON, con la imagen como data URL en `images[].image_url`
    // (referencia leida el 2026-11-19). `n` (1 a 10) pide varias versiones en una sola peticion, en las dos rutas.
    const common = { model: this.cfg.imageOpenAiModel, prompt: prompt.slice(0, 4000), size: OPENAI_SIZES[format], quality: quality ?? this.cfg.imageOpenAiQuality, output_format: 'jpeg', n };
    let body: Record<string, unknown> = common, path = 'generations';
    if (editFile) {
      const buf = readFileSync(editFile), mime = editFile.endsWith('.png') ? 'image/png' : editFile.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      body = { ...common, images: [{ image_url: `data:${mime};base64,${buf.toString('base64')}` }] }; path = 'edits';
    }
    let res: Response;
    try {
      res = await fetch(`https://api.openai.com/v1/images/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${this.cfg.imageOpenAiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(240_000) });
    } catch (e) { throw new Error(`no se pudo conectar con OpenAI (${(e as Error).name})`); }
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = String(d?.error?.code ?? ''), msg = String(d?.error?.message ?? '').replace(/\s+/g, ' ').slice(0, 200);
      if (code === 'moderation_blocked' || code === 'content_policy_violation' || /safety system|content policy|moderation/i.test(msg)) throw new Blocked('el filtro de contenido de OpenAI rechazó esa descripción');
      throw new Error(`OpenAI respondió ${res.status}${code === 'insufficient_quota' ? ' (la cuenta no tiene saldo)' : res.status === 401 ? ' (clave inválida)' : msg ? ` (${msg})` : ''}`);
    }
    const out = (Array.isArray(d?.data) ? d.data : []).map((x: any) => String(x?.b64_json ?? '')).filter(Boolean).map((b64: string) => ({ buf: Buffer.from(b64, 'base64'), type: 'image/jpeg' }));
    if (!out.length) throw new Error('OpenAI terminó sin entregar la imagen');
    return out;
  }

  /** Magnific (Mystic): crea la tarea, la consulta hasta que termina (~2 min como maximo) y descarga la imagen. */
  private async viaMagnific(prompt: string, format: string, signal?: AbortSignal): Promise<{ buf: Buffer; type: string }> {
    const headers = { 'x-magnific-api-key': this.cfg.magnificApiKey, 'Content-Type': 'application/json' };
    const api = 'https://api.magnific.com/v1/ai/mystic';
    const res = await fetch(api, { method: 'POST', headers, body: JSON.stringify({ prompt: prompt.slice(0, 1500), aspect_ratio: FORMATS[format], resolution: '1k' }), signal: signal ?? AbortSignal.timeout(20_000) });
    const d: any = await res.json().catch(() => ({}));
    const id = String(d?.data?.task_id ?? '');
    if (!res.ok || !/^[\w-]{6,80}$/.test(id)) throw new Error(`Magnific respondió ${res.status}${res.status === 401 ? ' (clave inválida)' : ''}`);
    let urlOut = String(d?.data?.generated?.[0] ?? '');
    for (let i = 0; !urlOut && i < 60; i++) { // hasta ~2 minutos
      await wait(2000);
      const r = await fetch(`${api}/${id}`, { headers, signal: AbortSignal.timeout(10_000) });
      const t: any = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Magnific respondió ${r.status} al consultar la imagen`);
      if (t?.data?.status === 'FAILED') throw new Error('Magnific no pudo generar la imagen');
      if (t?.data?.status === 'COMPLETED') { urlOut = String(t.data.generated?.[0] ?? ''); if (!urlOut) throw new Error('Magnific terminó sin entregar la imagen (pudo bloquearla su filtro de contenido)'); }
    }
    if (!urlOut) throw new Error('la imagen tardó demasiado');
    if (!/^https:\/\//.test(urlOut)) throw new Error('Magnific devolvió una dirección no válida');
    const img = await fetch(urlOut, { signal: AbortSignal.timeout(30_000) });
    const type = (img.headers.get('content-type') ?? '').split(';')[0];
    if (!img.ok || !/^image\/(jpeg|png|webp)$/.test(type)) throw new Error('no se pudo descargar la imagen generada');
    return { buf: Buffer.from(await img.arrayBuffer()), type };
  }

  /** Ruta en disco de una imagen generada, o null si el nombre no es valido o no existe. */
  file(name: string): string | null {
    if (!/^[a-f0-9]{24}\.(jpg|png|webp)$/.test(name)) return null;
    const full = join(this.dir, name);
    try { return statSync(full).isFile() ? full : null; } catch { return null; }
  }

  /**
   * Las imagenes generadas se conservan todas (pedido por Javier el 2026-11-18: antes solo quedaban las ultimas 200) y se
   * anotan en la tabla `generated_images` con su descripcion, para verlas, descargarlas o borrarlas en el panel.
   * Al arrancar se anotan las que ya estaban en la carpeta de antes (sin descripcion).
   */
  async onModuleInit() {
    try {
      const known = new Set((await this.db.query<{ name: string }>('SELECT name FROM generated_images')).map((r) => r.name));
      for (const n of readdirSync(this.dir)) {
        if (known.has(n) || !this.file(n)) continue;
        const st = statSync(join(this.dir, n));
        await this.db.query('INSERT INTO generated_images (at, name, prompt, format, bytes) VALUES ($1, $2, $3, $4, $5)', [st.mtime.toISOString(), n, '', '', st.size]);
      }
    } catch { /* aun no hay carpeta de imagenes */ }
  }
  listGenerated(limit = 300): Promise<GeneratedImage[]> { return this.db.query<GeneratedImage>('SELECT * FROM generated_images ORDER BY at DESC LIMIT $1', [Math.min(1000, Math.max(1, limit))]); }
  async removeGenerated(id: number): Promise<boolean> {
    const row = (await this.db.query<GeneratedImage>('DELETE FROM generated_images WHERE id = $1 RETURNING name', [id]))[0];
    if (!row) return false;
    const f = this.file(row.name); if (f) try { unlinkSync(f); } catch { /* ya no estaba */ }
    return true;
  }
}

/** Una imagen generada con IA y guardada en DATA_DIR/imagenes. */
export interface GeneratedImage { id: number; at: string; name: string; prompt: string; format: string; bytes: number }
