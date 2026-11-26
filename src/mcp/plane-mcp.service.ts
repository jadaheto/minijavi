import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown>; }

/** Solo consulta. Las herramientas del MCP que crean, modifican o borran no se exponen al modelo. */
const READ_ONLY = new Set([
  'get_me', 'list_projects', 'get_project', 'list_work_items', 'get_work_item', 'search_work_items', 'list_comments',
  'list_states', 'list_labels', 'list_members', 'list_cycles', 'list_cycle_work_items', 'list_modules', 'list_module_work_items',
]);
export const PLANE_PREFIX = 'plane_';

/**
 * Cliente del servidor MCP de Plane (HTTP, JSON-RPC). Verificado el 2026-11-13: responde JSON directo, sin sesion;
 * la clave va en la cabecera X-Plane-Api-Key y solo existe en el backend. Solo se usa en sesiones del dueño.
 */
@Injectable()
export class PlaneMcpService {
  private readonly log = new Logger(PlaneMcpService.name);
  private tools: McpTool[] | null = null;
  private id = 0;
  constructor(private readonly cfg: ConfigService) {}

  get enabled() { return !!(this.cfg.planeMcpUrl && this.cfg.planeApiKey); }

  private async rpc(method: string, params: unknown): Promise<any> {
    const res = await fetch(this.cfg.planeMcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Plane-Api-Key': this.cfg.planeApiKey },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`el MCP respondió ${res.status}`);
    const text = await res.text();
    // Puede llegar como JSON o como eventos (lineas "data: ...").
    const body = text.trimStart().startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).pop() ?? '{}';
    const d = JSON.parse(body);
    if (d.error) throw new Error(d.error.message ?? 'error del MCP');
    return d.result;
  }

  /** Definiciones (formato OpenAI) de las herramientas de consulta, con prefijo plane_. */
  async definitions(): Promise<unknown[]> {
    if (!this.enabled) return [];
    if (!this.tools) {
      try {
        const out = await this.rpc('tools/list', {});
        this.tools = (out?.tools ?? []).filter((t: McpTool) => READ_ONLY.has(t.name));
        this.log.log(`MCP de Plane: ${this.tools!.length} herramientas de consulta disponibles`);
      } catch (e) { this.log.error(`No se pudo listar el MCP de Plane: ${(e as Error).message}`); return []; }
    }
    return this.tools!.map((t) => ({
      type: 'function',
      function: { name: PLANE_PREFIX + t.name, description: `Plane (gestor de tareas de Javier): ${t.description ?? t.name}`, parameters: t.inputSchema ?? { type: 'object', properties: {} } },
    }));
  }

  /** Lectura con el resultado ya interpretado (para armar el tablero). Solo herramientas de consulta; lanza si falla. */
  async read(tool: string, args: Record<string, unknown>): Promise<any> {
    if (!this.enabled || !READ_ONLY.has(tool)) throw new Error('esa consulta de Plane no está permitida');
    const out = await this.rpc('tools/call', { name: tool, arguments: args });
    const text = (out?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    if (out?.isError) throw new Error(`Plane respondió un error: ${text.slice(0, 160)}`);
    try { return JSON.parse(text); } catch { if (out?.structuredContent) return out.structuredContent; throw new Error('Plane respondió algo que no se pudo leer'); }
  }

  /**
   * La UNICA escritura en Plane: agregar un comentario a una tarea (AD4, decidido por Javier el 2026-11-26). No se le
   * ofrece al modelo como herramienta: solo la usa el servicio de tareas de ADK, con un texto armado por el servidor y
   * despues del «sí» de Javier. Crear, cambiar o borrar tareas sigue sin existir aqui.
   */
  async comment(projectId: string, workItemId: string, text: string): Promise<void> {
    if (!this.enabled) throw new Error('Plane no está configurado');
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12).map((l) => `<p>${esc(l.slice(0, 400))}</p>`).join('');
    if (!html || !/^[0-9a-f-]{8,}$/i.test(projectId) || !/^[0-9a-f-]{8,}$/i.test(workItemId)) throw new Error('falta la tarea o el texto');
    const out = await this.rpc('tools/call', { name: 'add_comment', arguments: { project_id: projectId, work_item_id: workItemId, comment_html: html } });
    if (out?.isError) throw new Error(`Plane no aceptó el comentario: ${(out?.content ?? []).map((c: any) => c.text).join(' ').slice(0, 160)}`);
    this.log.log('comentario agregado a una tarea de Plane');
  }

  async call(name: string, rawArgs: string): Promise<string> {
    const tool = name.slice(PLANE_PREFIX.length);
    if (!this.enabled || !READ_ONLY.has(tool)) return 'Error: esa herramienta no está permitida.';
    let args: Record<string, unknown> = {};
    try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return 'Error: argumentos invalidos.'; }
    try {
      const out = await this.rpc('tools/call', { name: tool, arguments: args });
      const text = (out?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
      const body = (out?.isError ? 'Error de Plane: ' : '') + (text || JSON.stringify(out ?? {}));
      return body.length > 7000 ? body.slice(0, 7000) + '\n[resultado recortado]' : body;
    } catch (e) { return `Error al consultar Plane: ${(e as Error).message}.`; }
  }
}
