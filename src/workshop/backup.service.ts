import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import { CapableModelService } from '../llm/capable.service';
import { ItemStore, ResponsesHttpError, responsesEvents } from '../llm/openai-responses';
import { UsageService } from '../usage/usage.service';
import { BridgeStream, bridgeRequest, errorBody, SseEvent } from './anthropic-bridge';

/**
 * Respaldo del taller (pedido por Javier el 2026-11-19): si Claude Code no puede trabajar con la suscripcion (limite,
 * saldo o credencial), la pasada se repite con el MISMO Claude Code apuntando a este servidor, que traduce cada peticion
 * al modelo capaz (OpenAI, API Responses). Asi siguen las mismas herramientas, reglas y comprobaciones.
 *
 * - La clave de OpenAI no sale del servidor: el proceso del taller recibe una clave al azar que solo vale mientras dura
 *   ese encargo y solo desde la misma maquina (`backup.controller.ts`).
 * - Esto SI se cobra por uso: hay un tope de encargos con respaldo por dia (TALLER_RESPALDO_DIA).
 * - Solo existe si el modelo capaz es de OpenAI por la API Responses; con otro proveedor queda apagado y se dice por que.
 */
@Injectable()
export class WorkshopBackupService {
  private readonly log = new Logger(WorkshopBackupService.name);
  private readonly tokens = new Set<string>();
  private readonly items = new ItemStore(4000);
  private day = ''; private used = 0;

  constructor(private readonly cfg: ConfigService, private readonly capable: CapableModelService, private readonly usage: UsageService) {}

  /** Por que no hay respaldo ('' = lo hay). */
  get problem(): string {
    if (!this.cfg.tallerBackup) return 'está apagado (TALLER_RESPALDO=0)';
    if (!this.capable.enabled) return this.capable.problem || 'no hay modelo capaz configurado (MODELO_CAPAZ_*)';
    if (!this.capable.responsesTarget) return `el modelo capaz (${this.capable.label}) no es de OpenAI por la API Responses, la única que el respaldo sabe usar`;
    return '';
  }
  get available() { return !this.problem; }
  get label() { return this.capable.label; }
  get status() { return { available: this.available, model: this.available ? this.label : '', problem: this.problem, usedToday: this.today(), dailyMax: this.cfg.tallerBackupDaily }; }

  private today() { const d = new Date().toISOString().slice(0, 10); if (d !== this.day) { this.day = d; this.used = 0; } return this.used; }
  /** Por que NO se puede usar ahora ('' = se puede). El tope es por dia y se reinicia con el servidor. */
  refuse(): string {
    if (this.problem) return this.problem;
    const max = this.cfg.tallerBackupDaily;
    return max > 0 && this.today() >= max ? `ya se usó ${max} ${max === 1 ? 'vez' : 'veces'} hoy, que es el tope diario` : '';
  }

  /** Clave temporal para un encargo. */
  issue(): string { this.today(); this.used++; this.usage.add('respaldo_jobs'); const t = randomBytes(32).toString('hex'); this.tokens.add(t); return t; }
  revoke(token: string) { this.tokens.delete(token); }
  valid(token: string): boolean {
    const a = Buffer.from(token);
    for (const t of this.tokens) { const b = Buffer.from(t); if (a.length === b.length && timingSafeEqual(a, b)) return true; }
    return false;
  }

  /** Entorno de Claude Code para trabajar contra este servidor. No lleva ninguna clave real. */
  env(token: string): Record<string, string> {
    const model = this.cfg.capableModel;
    return {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${this.cfg.port}/taller-llm`, ANTHROPIC_AUTH_TOKEN: token,
      ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    };
  }

  /**
   * Atiende una peticion de Claude Code (formato Anthropic). `send` escribe un evento SSE; `signal` se corta si Claude Code
   * cierra la conexion. Devuelve la respuesta completa cuando la peticion no es en streaming.
   */
  async handle(body: any, out: { head: (status: number, sse: boolean) => void; sse: (e: SseEvent) => void; json: (v: unknown) => void }, signal?: AbortSignal): Promise<void> {
    const target = this.capable.responsesTarget;
    if (!target) { out.head(503, false); out.json(errorBody(503, 'el respaldo del taller no está disponible')); return; }
    const stream = body?.stream === true, bridge = new BridgeStream(target.model, this.items);
    let started = false;
    try {
      for await (const ev of responsesEvents(target.url, target.key, bridgeRequest(body, target.model, target.extra, this.items), signal)) {
        if (!started) { started = true; this.usage.add('respaldo_calls'); if (stream) { out.head(200, true); for (const e of bridge.start()) out.sse(e); } }
        const events = bridge.push(ev);
        if (stream) for (const e of events) out.sse(e);
        if (bridge.finished) break;
      }
    } catch (e) {
      if (signal?.aborted) return;
      const status = e instanceof ResponsesHttpError ? e.status : 502, msg = `${this.label}: ${(e as Error).message}`;
      this.log.warn(`respaldo del taller: ${status} ${msg}`);
      if (!started) { out.head(status, false); out.json(errorBody(status, msg)); } else if (stream) out.sse({ event: 'error', data: errorBody(status, msg) });
      return;
    }
    this.usage.add('respaldo_in', bridge.usage.input); this.usage.add('respaldo_out', bridge.usage.output);
    if (bridge.failed) { this.log.warn(`respaldo del taller: ${bridge.failed}`); if (!stream) { out.head(502, false); out.json(errorBody(502, bridge.failed)); } return; }
    if (!stream) { out.head(200, false); out.json(bridge.message()); }
    else if (!bridge.finished) out.sse({ event: 'error', data: errorBody(502, 'la respuesta se cortó antes de terminar') });
  }
}
