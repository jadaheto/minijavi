import { flatTool, ItemStore, responseFailure, responseUsage } from '../llm/openai-responses';

/**
 * Traductor entre el formato de Anthropic (Messages, el unico que habla Claude Code) y la API Responses de OpenAI.
 * Solo traduce: no llama a nadie. Lo usa el respaldo del taller (`backup.service.ts`).
 *
 * Lo que NO pasa: bloques `thinking` del historial (se descartan; el razonamiento de OpenAI viaja cifrado en los items
 * guardados), herramientas de servidor de Anthropic (busqueda web) y `cache_control`.
 */

const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => (p?.type === 'text' ? String(p.text ?? '') : '')).join('') : '');
const imageUrl = (b: any): string | undefined => {
  const s = b?.source;
  if (s?.type === 'base64' && s.data) return `data:${s.media_type || 'image/png'};base64,${s.data}`;
  if (s?.type === 'url' && /^https:\/\//.test(String(s.url))) return String(s.url);
  return undefined;
};

/** Peticion de Claude Code -> cuerpo para la API Responses. El modelo lo pone el servidor, no la peticion. */
export function bridgeRequest(b: any, model: string, extra: Record<string, unknown>, store: ItemStore): Record<string, unknown> {
  const instructions = typeof b?.system === 'string' ? b.system : Array.isArray(b?.system) ? b.system.map((x: any) => String(x?.text ?? '')).filter(Boolean).join('\n\n') : '';
  const input: unknown[] = [];
  for (const m of Array.isArray(b?.messages) ? b.messages : []) {
    const blocks: any[] = typeof m?.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m?.content) ? m.content : [];
    if (m?.role === 'assistant') {
      const first = blocks.find((x) => x?.type === 'tool_use');
      const saved = first ? store.get(String(first.id)) : undefined;
      if (saved) { input.push(...saved); continue; } // la salida original, con su razonamiento
      const t = blocks.filter((x) => x?.type === 'text').map((x) => String(x.text ?? '')).join('').trim();
      if (t) input.push({ role: 'assistant', content: t });
      for (const u of blocks) if (u?.type === 'tool_use') input.push({ type: 'function_call', call_id: String(u.id), name: String(u.name), arguments: JSON.stringify(u.input ?? {}) });
      continue;
    }
    let parts: unknown[] = [];
    const flush = () => { if (parts.length) { input.push({ role: 'user', content: parts }); parts = []; } };
    for (const x of blocks) {
      if (x?.type === 'tool_result') {
        flush();
        const inner: any[] = Array.isArray(x.content) ? x.content : [];
        const out = (x.is_error ? 'ERROR: ' : '') + (textOf(x.content) || (inner.some((i) => i?.type === 'image') ? '(el resultado es una imagen; va a continuación)' : '(sin resultado)'));
        input.push({ type: 'function_call_output', call_id: String(x.tool_use_id), output: out });
        for (const i of inner) { const url = i?.type === 'image' ? imageUrl(i) : undefined; if (url) parts.push({ type: 'input_image', image_url: url }); }
      } else if (x?.type === 'text' && x.text) parts.push({ type: 'input_text', text: String(x.text) });
      else if (x?.type === 'image') { const url = imageUrl(x); if (url) parts.push({ type: 'input_image', image_url: url }); }
    }
    flush();
  }
  const tools = (Array.isArray(b?.tools) ? b.tools : []).filter((t: any) => t?.name && t.input_schema).map((t: any) => flatTool(String(t.name), t.description, t.input_schema));
  const tc = b?.tool_choice?.type;
  const choice = tc === 'any' ? 'required' : tc === 'none' ? 'none' : tc === 'tool' && b.tool_choice.name ? { type: 'function', name: String(b.tool_choice.name) } : undefined;
  return {
    model, input, ...(instructions ? { instructions } : {}), ...(tools.length ? { tools } : {}), ...(choice && tools.length ? { tool_choice: choice } : {}),
    max_output_tokens: Math.max(Number(b?.max_tokens) || 0, 16_000), // el razonamiento cuenta dentro del tope
    include: ['reasoning.encrypted_content'], ...extra,
  };
}

export interface SseEvent { event: string; data: Record<string, unknown> }

/** Convierte los eventos de la API Responses en los eventos SSE de Anthropic que espera Claude Code. */
export class BridgeStream {
  private next = 0;
  private open?: { kind: 'text' | 'tool'; index: number; output?: number; sentArgs?: boolean };
  private readonly output: any[] = [];
  private tool = false;
  finished = false;
  failed = '';
  usage = { input: 0, output: 0, cached: 0 };
  /** Lo acumulado, para responder sin streaming. */
  readonly content: any[] = [];
  stopReason = 'end_turn';

  constructor(private readonly model: string, private readonly store: ItemStore, private readonly id = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`) {}

  start(): SseEvent[] {
    return [{ event: 'message_start', data: { type: 'message_start', message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } } }];
  }
  private close(out: SseEvent[]) {
    if (!this.open) return;
    out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: this.open.index } });
    this.open = undefined;
  }
  push(ev: any): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.finished) return out;
    if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string' && ev.delta) {
      if (this.open?.kind !== 'text') {
        this.close(out);
        this.open = { kind: 'text', index: this.next++ };
        this.content.push({ type: 'text', text: '' });
        out.push({ event: 'content_block_start', data: { type: 'content_block_start', index: this.open.index, content_block: { type: 'text', text: '' } } });
      }
      this.content[this.open.index].text += ev.delta;
      out.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: this.open.index, delta: { type: 'text_delta', text: ev.delta } } });
    } else if (ev.type === 'response.output_item.added' && ev.item?.type === 'function_call') {
      this.close(out);
      this.tool = true;
      this.open = { kind: 'tool', index: this.next++, output: ev.output_index };
      this.content.push({ type: 'tool_use', id: String(ev.item.call_id), name: String(ev.item.name), input: {}, _args: '' });
      out.push({ event: 'content_block_start', data: { type: 'content_block_start', index: this.open.index, content_block: { type: 'tool_use', id: String(ev.item.call_id), name: String(ev.item.name), input: {} } } });
    } else if (ev.type === 'response.function_call_arguments.delta' && this.open?.kind === 'tool' && typeof ev.delta === 'string' && ev.delta) {
      this.open.sentArgs = true; this.content[this.open.index]._args += ev.delta;
      out.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: this.open.index, delta: { type: 'input_json_delta', partial_json: ev.delta } } });
    } else if (ev.type === 'response.output_item.done' && ev.item) {
      this.output.push(ev.item);
      if (ev.item.type === 'function_call' && this.open?.kind === 'tool') {
        const args = String(ev.item.arguments || '{}');
        if (!this.open.sentArgs) { this.content[this.open.index]._args = args; out.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: this.open.index, delta: { type: 'input_json_delta', partial_json: args } } }); }
        this.close(out);
      } else if (ev.item.type === 'message') this.close(out);
    } else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') {
      this.close(out);
      this.usage = responseUsage(ev);
      if (this.tool) this.store.save(this.output);
      this.stopReason = this.tool ? 'tool_use' : ev.type === 'response.incomplete' ? 'max_tokens' : 'end_turn';
      for (const c of this.content) if (c.type === 'tool_use') { try { c.input = JSON.parse(c._args || '{}'); } catch { c.input = {}; } delete c._args; }
      out.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: this.stopReason, stop_sequence: null }, usage: { input_tokens: Math.max(0, this.usage.input - this.usage.cached), cache_read_input_tokens: this.usage.cached, output_tokens: this.usage.output } } });
      out.push({ event: 'message_stop', data: { type: 'message_stop' } });
      this.finished = true;
    } else if (ev.type === 'response.failed' || ev.type === 'error') {
      this.failed = responseFailure(ev); this.finished = true;
      out.push({ event: 'error', data: errorBody(500, this.failed) });
    }
    return out;
  }
  /** El mensaje completo, para una peticion sin streaming. */
  message() {
    return { id: this.id, type: 'message', role: 'assistant', model: this.model, content: this.content, stop_reason: this.stopReason, stop_sequence: null,
      usage: { input_tokens: Math.max(0, this.usage.input - this.usage.cached), cache_read_input_tokens: this.usage.cached, output_tokens: this.usage.output } };
  }
}

/** Error con la forma de Anthropic (Claude Code lo muestra tal cual). */
export function errorBody(status: number, message: string) {
  const type = status === 401 || status === 403 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status === 400 || status === 404 || status === 422 ? 'invalid_request_error' : status === 529 || status === 503 ? 'overloaded_error' : 'api_error';
  return { type: 'error', error: { type, message } };
}
