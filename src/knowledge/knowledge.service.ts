import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import { UsageService } from '../usage/usage.service';

export interface Chunk { text: string; source: string; scope: 'publico' | 'privado' | 'demo'; }
export interface Hit extends Chunk { score: number; }

/**
 * Base de conocimiento (RAG): embeddings de NVIDIA + busqueda vectorial en Qdrant. Probado el 2026-11-13:
 *  - POST https://integrate.api.nvidia.com/v1/embeddings {model, input[], input_type: "query" | "passage"}; el modelo
 *    nvidia/nemotron-3.5-embed-8b devuelve 4096 dimensiones y tarda ~125 ms por consulta.
 *  - Qdrant 1.20 por REST con cabecera "api-key". Una sola coleccion; cada punto lleva `scope` (publico | privado) y las
 *    sesiones publicas filtran por scope = publico, asi lo privado nunca llega a un visitante.
 */
@Injectable()
export class KnowledgeService {
  private readonly log = new Logger(KnowledgeService.name);
  private ready: Promise<boolean> | null = null;
  constructor(private readonly cfg: ConfigService, @Optional() private readonly usage?: UsageService) {} // sin UsageService en el script de carga

  get enabled() { return !!(this.cfg.nvidiaApiKey && this.cfg.qdrantUrl); }

  async embed(texts: string[], type: 'query' | 'passage', signal?: AbortSignal): Promise<number[][]> {
    const res = await fetch('https://integrate.api.nvidia.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.nvidiaApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.cfg.embedModel, input: texts, input_type: type, encoding_format: 'float', truncate: 'END' }),
      signal: signal ?? AbortSignal.timeout(20_000),
    });
    this.usage?.add('nvidia_calls');
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`embeddings: ${res.status} ${String(d.detail ?? d.title ?? '').slice(0, 120)}`);
    if (!Array.isArray(d.data)) throw new Error('embeddings: respuesta sin datos');
    return d.data.map((x: any) => x.embedding);
  }

  private async qdrant(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
    const res = await fetch(`${this.cfg.qdrantUrl}${path}`, {
      method, headers: { 'api-key': this.cfg.qdrantApiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: signal ?? AbortSignal.timeout(20_000),
    });
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`qdrant ${method} ${path}: ${res.status} ${JSON.stringify(d.status ?? d).slice(0, 160)}`);
    return d.result;
  }

  /** Crea la coleccion si no existe (el tamano del vector sale del modelo). */
  async ensureCollection(size: number) {
    const name = this.cfg.qdrantCollection;
    const exists = await this.qdrant('GET', `/collections/${name}/exists`).then((r) => !!r?.exists).catch(() => false);
    if (!exists) {
      await this.qdrant('PUT', `/collections/${name}`, { vectors: { size, distance: 'Cosine' } });
      await this.qdrant('PUT', `/collections/${name}/index`, { field_name: 'scope', field_schema: 'keyword' });
      await this.qdrant('PUT', `/collections/${name}/index`, { field_name: 'source', field_schema: 'keyword' });
      this.log.log(`coleccion ${name} creada (${size} dimensiones)`);
    }
  }

  /** Reemplaza todo lo que habia de un archivo por sus fragmentos nuevos. */
  async replaceSource(source: string, scope: Chunk['scope'], texts: string[], extra: Record<string, unknown> = {}) {
    const name = this.cfg.qdrantCollection;
    await this.qdrant('POST', `/collections/${name}/points/delete?wait=true`, { filter: { must: [{ key: 'source', match: { value: source } }] } });
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16);
      const vectors = await this.embed(batch, 'passage');
      const points = batch.map((text, k) => {
        const h = createHash('sha256').update(`${source}#${i + k}`).digest('hex');
        const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
        return { id, vector: vectors[k], payload: { text, source, scope, ...extra } };
      });
      await this.qdrant('PUT', `/collections/${name}/points?wait=true`, { points });
    }
  }

  async count(): Promise<number> { return (await this.qdrant('POST', `/collections/${this.cfg.qdrantCollection}/points/count`, { exact: true }))?.count ?? 0; }

  /** Fragmentos mas parecidos a la pregunta. Las sesiones publicas solo ven scope = publico. */
  async search(query: string, owner: boolean, signal?: AbortSignal): Promise<Hit[]> {
    if (!this.enabled) return [];
    // La primera vez comprueba que la coleccion exista y tenga contenido; si no, no se gasta una consulta por turno.
    this.ready ??= this.count().then((n) => n > 0).catch(() => false);
    if (!(await this.ready)) return [];
    const [vector] = await this.embed([query], 'query', signal);
    const out = await this.qdrant('POST', `/collections/${this.cfg.qdrantCollection}/points/query`, {
      query: vector, limit: this.cfg.knowledgeTopK, with_payload: true, score_threshold: this.cfg.knowledgeMinScore,
      // El dueño ve lo publico y lo privado; nadie ve aqui los documentos de las demos (solo su propia demo, con searchDemo).
      filter: owner ? { must_not: [{ key: 'scope', match: { value: 'demo' } }] } : { must: [{ key: 'scope', match: { value: 'publico' } }] },
    }, signal);
    return (out?.points ?? []).map((p: any) => ({ text: p.payload?.text ?? '', source: p.payload?.source ?? '', scope: p.payload?.scope, score: p.score }));
  }
  // ---- Documentos de las demos ("Crea tu propio asistente"): scope 'demo' y campo `demo` con el id de la demo. ----
  /** Guarda los fragmentos del documento de una demo (reemplaza los que tuviera). */
  async addDemo(id: string, texts: string[]): Promise<number> {
    const [probe] = await this.embed([texts[0] ?? 'x'], 'passage');
    await this.ensureCollection(probe.length);
    await this.qdrant('PUT', `/collections/${this.cfg.qdrantCollection}/index`, { field_name: 'demo', field_schema: 'keyword' }).catch(() => undefined); // ya existe: da igual
    await this.replaceSource(`demo:${id}`, 'demo', texts, { demo: id });
    this.ready = null;
    return texts.length;
  }
  /** Fragmentos del documento de ESA demo (nunca de otra, ni de la base de Javier). */
  async searchDemo(id: string, query: string, signal?: AbortSignal): Promise<Hit[]> {
    if (!this.enabled) return [];
    const [vector] = await this.embed([query], 'query', signal);
    const out = await this.qdrant('POST', `/collections/${this.cfg.qdrantCollection}/points/query`, {
      query: vector, limit: 4, with_payload: true, score_threshold: Math.min(this.cfg.knowledgeMinScore, 0.2),
      filter: { must: [{ key: 'scope', match: { value: 'demo' } }, { key: 'demo', match: { value: id } }] },
    }, signal);
    return (out?.points ?? []).map((p: any) => ({ text: p.payload?.text ?? '', source: p.payload?.source ?? '', scope: p.payload?.scope, score: p.score }));
  }
  /** Borra todo lo de una demo. */
  async deleteDemo(id: string): Promise<void> {
    if (!this.enabled) return;
    await this.qdrant('POST', `/collections/${this.cfg.qdrantCollection}/points/delete?wait=true`, { filter: { must: [{ key: 'demo', match: { value: id } }] } });
  }

  // ---- Documentos que Javier sube por voz (source `doc:<id>`, alcance publico o privado) ----
  /** Guarda (reemplazando) los fragmentos de un documento. */
  async addSource(source: string, scope: 'publico' | 'privado', texts: string[], extra: Record<string, unknown> = {}): Promise<number> {
    if (!texts.length) { await this.deleteSource(source); return 0; }
    const [probe] = await this.embed([texts[0]], 'passage');
    await this.ensureCollection(probe.length);
    await this.replaceSource(source, scope, texts, extra);
    this.ready = null;
    return texts.length;
  }
  /** Borra todos los fragmentos de un documento. */
  async deleteSource(source: string): Promise<void> {
    if (!this.enabled) return;
    // Si la coleccion aun no existe no hay nada que borrar.
    await this.qdrant('POST', `/collections/${this.cfg.qdrantCollection}/points/delete?wait=true`, { filter: { must: [{ key: 'source', match: { value: source } }] } }).catch((e) => { if (!/: 404 /.test(String((e as Error).message))) throw e; });
    this.ready = null;
  }

  /** Tras cargar documentos, para que la siguiente busqueda vuelva a comprobar el contenido. */
  refresh() { this.ready = null; }
}
