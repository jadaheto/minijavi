import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { ConfigService } from '../config/config.service';
import { UsageService } from '../usage/usage.service';
import { LlmEvent, ToolCall } from './deepseek.service';
import { extraForResponses, flatTool, ItemStore, responseFailure, responsesEvents, responseUsage } from './openai-responses';

/** Un proveedor conocido: donde queda su API, con que formato habla y como se le pide el tope de salida. */
interface Preset { url: string; format: 'openai' | 'anthropic'; api?: 'responses'; tokensField: string; extra?: Record<string, unknown>; verified: string }

/**
 * Proveedores del modelo capaz. Todos menos Anthropic hablan el formato "chat completions" de OpenAI.
 * Lo que dice `verified` salio de la documentacion oficial leida el 2026-11-18; lo que no se pudo leer queda marcado y se
 * comprueba con `npm run probar-modelo` (una pregunta y una herramienta reales contra el modelo configurado).
 */
export const PRESETS: Record<string, Preset> = {
  deepseek: { url: 'https://api.deepseek.com', format: 'openai', tokensField: 'max_tokens', extra: { thinking: { type: 'disabled' } }, verified: 'documentación y llamadas reales' },
  openai: { url: 'https://api.openai.com/v1', format: 'openai', api: 'responses', tokensField: 'max_completion_tokens', verified: 'API Responses (guías leídas el 2026-11-19 y probada con gpt-6.2-astra: pregunta y herramienta). Los gpt-6.x no aceptan herramientas por /chat/completions; MODELO_CAPAZ_API=chat vuelve a esa API' },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai', format: 'openai', tokensField: '', verified: 'probado con gemini-4-neon el 2026-11-18 (pregunta y herramienta); exige devolver la firma de razonamiento de cada llamada a herramienta, y el conector lo hace' },
  kimi: { url: 'https://api.moonshot.ai/v1', format: 'openai', tokensField: 'max_completion_tokens', verified: 'dirección, streaming y herramientas según su documentación' },
  grok: { url: 'https://api.x.ai/v1', format: 'openai', tokensField: '', verified: 'SIN verificar: su documentación solo describe otra API (Responses)' },
  anthropic: { url: '', format: 'anthropic', tokensField: 'max_tokens', verified: 'guía del SDK oficial; sin probar con una clave real' },
  otro: { url: '', format: 'openai', tokensField: '', verified: 'cualquier API compatible con OpenAI: hay que dar MODELO_CAPAZ_URL' },
};

/**
 * El "modelo capaz" (etapa 1c, pedido por Javier el 2026-11-18): un segundo modelo, de CUALQUIER proveedor, que solo se
 * usa en los encargos largos del dueño. Nunca en conversaciones publicas (tarda mas en empezar a responder).
 * Se configura con MODELO_CAPAZ_PROVEEDOR + MODELO_CAPAZ + MODELO_CAPAZ_KEY; sin eso no existe y nada mas cambia.
 * Recibe y devuelve lo mismo que DeepSeekService.chat (mensajes en formato OpenAI, eventos de texto y herramientas), asi
 * el resto del codigo no sabe que modelo respondio. Si falla antes de empezar a responder, quien llama usa el de siempre.
 */
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

@Injectable()
export class CapableModelService implements OnModuleInit {
  private readonly log = new Logger(CapableModelService.name);
  private readonly preset?: Preset;
  private readonly url: string = '';
  private readonly key: string = '';
  private anthropic?: Anthropic;
  /** Bloques completos de las respuestas de Anthropic que pidieron herramientas (incluyen su razonamiento): hay que devolverlos tal cual en la siguiente peticion del mismo turno. */
  private readonly kept = new Map<string, unknown[]>();
  /**
   * Campos propios del proveedor en una llamada a herramienta (Gemini manda `extra_content.google.thought_signature` y exige
   * recibirlo de vuelta en el historial; sin el responde 400). Se guardan por id de la llamada y se reponen al enviar.
   */
  private readonly extras = new Map<string, Record<string, unknown>>();
  /** Salida completa de las respuestas de la API Responses que pidieron herramientas (traen su razonamiento cifrado). */
  private readonly items = new ItemStore();
  /** Un proveedor que rechazo los campos opcionales: de ahi en adelante se le habla con el cuerpo minimo. */
  private minimal = false;
  readonly problem: string = '';

  constructor(private readonly cfg: ConfigService, private readonly usage: UsageService) {
    const name = cfg.capableProvider;
    if (!name && !cfg.capableModel) return;
    const preset = PRESETS[name];
    if (!preset) { this.problem = `MODELO_CAPAZ_PROVEEDOR debe ser uno de: ${Object.keys(PRESETS).join(', ')}`; return; }
    if (!cfg.capableModel) { this.problem = 'falta MODELO_CAPAZ (el nombre del modelo)'; return; }
    this.url = (cfg.capableUrl || preset.url).replace(/\/+$/, '');
    this.key = cfg.capableKey || (name === 'deepseek' ? cfg.deepseekApiKey : '');
    if (!this.key) { this.problem = 'falta MODELO_CAPAZ_KEY'; return; }
    if (preset.format === 'openai' && !/^https:\/\//.test(this.url)) { this.problem = 'falta MODELO_CAPAZ_URL (debe empezar por https://)'; return; }
    this.preset = preset;
  }
  onModuleInit() {
    if (this.problem) this.log.warn(`modelo capaz sin configurar bien: ${this.problem}`);
    else if (this.preset) this.log.log(`modelo capaz: ${this.label}`);
  }

  get enabled() { return !!this.preset; }
  /** "proveedor: modelo", para el panel y los registros. */
  get label() { return this.preset ? `${this.cfg.capableProvider}: ${this.cfg.capableModel}` : ''; }

  /** Misma forma que DeepSeekService.chat. */
  chat(messages: unknown[], tools: unknown[], signal?: AbortSignal, maxTokens = 4000): AsyncGenerator<LlmEvent> {
    if (!this.preset) throw new Error('no hay modelo capaz configurado');
    if (this.preset.format === 'anthropic') return this.chatAnthropic(messages as OpenAiMessage[], tools as OpenAiTool[], signal, maxTokens);
    return this.usesResponses ? this.chatResponses(messages as OpenAiMessage[], tools as OpenAiTool[], signal, maxTokens) : this.chatOpenAi(messages, tools, signal, maxTokens);
  }
  /** OpenAI se habla por su API Responses, salvo que MODELO_CAPAZ_API diga otra cosa. */
  get usesResponses() { return !!this.preset && this.preset.format === 'openai' && (this.cfg.capableApi ? this.cfg.capableApi === 'responses' : this.preset.api === 'responses'); }
  /** Para el respaldo del taller: a donde y con que clave se llama a la API Responses (la clave no sale del servidor). */
  get responsesTarget() { return this.usesResponses ? { url: this.url, key: this.key, model: this.cfg.capableModel, extra: extraForResponses(this.cfg.capableExtra) } : undefined; }

  /** ¿Puede leer documentos (PDF con sus imagenes, fotos)? Solo OpenAI por la API Responses. */
  get readsFiles() { return this.usesResponses && this.cfg.capableProvider === 'openai'; }
  /**
   * Lee un archivo con el modelo capaz y devuelve su respuesta en texto. Documentacion de OpenAI leida el 2026-11-21
   * (guia "File inputs"): `{type: "input_file", filename, file_data: "data:application/pdf;base64,..."}`; para PDF el
   * modelo recibe el texto extraido Y la imagen de cada pagina (por eso sirve con PDF escaneados); 50 MB por archivo.
   * Las fotos van como `input_image` con una data URL; el texto plano, como texto.
   */
  async readFile(file: { name: string; mime: string; data: Buffer }, prompt: string, maxOut = 32000, signal?: AbortSignal): Promise<string> {
    if (!this.readsFiles) throw new Error('el modelo capaz no puede leer archivos (hace falta OpenAI)');
    const b64 = file.data.toString('base64');
    const part = file.mime === 'application/pdf' ? { type: 'input_file', filename: file.name, file_data: `data:application/pdf;base64,${b64}` }
      : file.mime === DOCX ? { type: 'input_file', filename: file.name, file_data: `data:${DOCX};base64,${b64}` } // Word: el modelo recibe solo su texto
      : file.mime.startsWith('image/') ? { type: 'input_image', image_url: `data:${file.mime};base64,${b64}` }
      : { type: 'input_text', text: `Contenido del archivo ${file.name}:\n${file.data.toString('utf8').slice(0, 120_000)}` };
    const body = { model: this.cfg.capableModel, input: [{ role: 'user', content: [part, { type: 'input_text', text: prompt }] }], max_output_tokens: maxOut, ...extraForResponses(this.cfg.capableExtra) };
    let out = '';
    try {
      for await (const ev of responsesEvents(this.url, this.key, body, signal)) {
        if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') out += ev.delta;
        else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') { const u = responseUsage(ev); this.usage.add('capaz_calls'); this.usage.add('capaz_in', u.input); this.usage.add('capaz_out', u.output); }
        else if (ev.type === 'response.failed' || ev.type === 'error') throw new Error(responseFailure(ev));
      }
    } catch (e) { throw new Error(`${this.label} ${(e as any).status ? `respondió ${(e as any).status}: ` : 'falló: '}${(e as Error).message}`); }
    return out;
  }

  // ---- OpenAI, API Responses (ver openai-responses.ts) ----
  private async *chatResponses(messages: OpenAiMessage[], tools: OpenAiTool[], signal: AbortSignal | undefined, maxTokens: number): AsyncGenerator<LlmEvent> {
    const { instructions, input } = toResponsesInput(messages, this.items);
    const body = {
      model: this.cfg.capableModel, input, ...(instructions ? { instructions } : {}),
      ...(tools.length ? { tools: tools.map((t) => flatTool(t.function.name, t.function.description, t.function.parameters)) } : {}),
      max_output_tokens: Math.max(maxTokens, 8000), // el razonamiento cuenta dentro del tope: se deja espacio
      include: ['reasoning.encrypted_content'], ...extraForResponses(this.cfg.capableExtra),
    };
    const output: any[] = [];
    let counted = false;
    try {
      for await (const ev of responsesEvents(this.url, this.key, body, signal)) {
        if (!counted) { counted = true; this.usage.add('capaz_calls'); }
        if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string' && ev.delta) yield { type: 'text', delta: ev.delta };
        else if (ev.type === 'response.output_item.done' && ev.item) output.push(ev.item);
        else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') { const u = responseUsage(ev); this.usage.add('capaz_in', u.input); this.usage.add('capaz_out', u.output); }
        else if (ev.type === 'response.failed' || ev.type === 'error') throw new Error(responseFailure(ev));
      }
    } catch (e) { throw new Error(`${this.label} ${(e as any).status ? `respondió ${(e as any).status}: ` : 'falló: '}${(e as Error).message}`); }
    const calls = output.filter((i) => i.type === 'function_call' && i.name);
    if (!calls.length) return;
    this.items.save(output);
    yield { type: 'tool_calls', calls: calls.map((c) => ({ id: String(c.call_id), name: String(c.name), arguments: String(c.arguments || '{}') })) };
  }

  // ---- Formato OpenAI (chat completions con SSE) ----
  private async *chatOpenAi(messages: unknown[], tools: unknown[], signal: AbortSignal | undefined, maxTokens: number): AsyncGenerator<LlmEvent> {
    // El historial guarda las llamadas a herramientas en su forma comun (id, nombre, argumentos): aqui se les repone lo propio del proveedor.
    const withExtras = (messages as OpenAiMessage[]).map((m) => (m.role === 'assistant' && m.tool_calls?.some((c) => this.extras.has(c.id))
      ? { ...m, tool_calls: m.tool_calls.map((c) => ({ ...c, ...this.extras.get(c.id) })) } : m));
    const base = { model: this.cfg.capableModel, messages: withExtras, stream: true, ...(tools.length ? { tools } : {}) };
    // Cuerpo completo: tope de salida, consumo en el ultimo fragmento y lo propio del proveedor. Si el proveedor lo rechaza
    // con un 400 (cada uno acepta campos distintos), se repite una vez con el cuerpo minimo y se recuerda para las siguientes.
    const full = { ...base, ...(this.preset!.tokensField ? { [this.preset!.tokensField]: maxTokens } : {}), stream_options: { include_usage: true }, ...this.preset!.extra, ...this.cfg.capableExtra };
    const post = (body: unknown) => fetch(`${this.url}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    let res = await post(this.minimal ? { ...base, ...this.cfg.capableExtra } : full);
    if (res.status === 400 && !this.minimal) {
      const why = (await res.text().catch(() => '')).slice(0, 300);
      this.log.warn(`${this.label} rechazó la petición completa (${why.replace(/\s+/g, ' ')}); se repite con el cuerpo mínimo`);
      res = await post({ ...base, ...this.cfg.capableExtra });
      if (res.ok) this.minimal = true; // el problema eran los campos opcionales: se recuerda. Si tampoco sirvio, el fallo es otro.
    }
    if (!res.ok || !res.body) throw new Error(`${this.label} respondió ${res.status}: ${(await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)}`);
    this.usage.add('capaz_calls');
    const calls: ToolCall[] = [], extra: Record<string, unknown>[] = [], decoder = new TextDecoder();
    let pending = '';
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(part, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let d: any; try { d = JSON.parse(data); } catch { continue; }
        if (d.usage) { this.usage.add('capaz_in', Number(d.usage.prompt_tokens) || 0); this.usage.add('capaz_out', Number(d.usage.completion_tokens) || 0); }
        const delta = d.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content) yield { type: 'text', delta: delta.content };
        for (const tc of delta.tool_calls ?? []) {
          // Casi todos mandan `index`; el que no, manda cada llamada completa con su id: una entrada nueva por id.
          const i = Number.isInteger(tc.index) ? tc.index : tc.id ? calls.length : Math.max(0, calls.length - 1);
          const c = (calls[i] ??= { id: '', name: '', arguments: '' });
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name = tc.function.name;
          if (tc.function?.arguments) c.arguments += tc.function.arguments;
          const { index: _i, id: _id, type: _t, function: _f, ...own } = tc; // lo que no es estandar se conserva tal cual
          if (Object.keys(own).length) (extra[i] ??= {}), Object.assign(extra[i], own);
        }
      }
    }
    const ready: ToolCall[] = [];
    calls.forEach((c, i) => {
      if (!c || !c.name) return;
      const id = c.id || `call_${Date.now()}_${i}`;
      if (extra[i]) { this.extras.set(id, extra[i]); if (this.extras.size > 400) this.extras.delete(this.extras.keys().next().value!); }
      ready.push({ ...c, id });
    });
    if (ready.length) yield { type: 'tool_calls', calls: ready };
  }

  // ---- Anthropic (SDK oficial; su API usa otro formato de mensajes y de herramientas) ----
  private async *chatAnthropic(messages: OpenAiMessage[], tools: OpenAiTool[], signal: AbortSignal | undefined, maxTokens: number): AsyncGenerator<LlmEvent> {
    this.anthropic ??= new Anthropic({ apiKey: this.key, ...(this.cfg.capableUrl ? { baseURL: this.cfg.capableUrl } : {}) });
    const { system, messages: msgs } = toAnthropic(messages, this.kept);
    // El razonamiento viene activado por defecto en los modelos actuales y cuenta dentro de max_tokens: se deja espacio de sobra.
    const stream = this.anthropic.messages.stream({
      model: this.cfg.capableModel, max_tokens: Math.max(maxTokens, 16_000), ...(system ? { system } : {}), messages: msgs as Anthropic.MessageParam[],
      ...(tools.length ? { tools: tools.map((t) => ({ name: t.function.name, description: t.function.description ?? '', input_schema: (t.function.parameters ?? { type: 'object', properties: {} }) as Anthropic.Tool.InputSchema })) } : {}),
      ...(this.cfg.capableExtra as object),
    }, { signal });
    for await (const ev of stream) if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && ev.delta.text) yield { type: 'text', delta: ev.delta.text };
    const final = await stream.finalMessage();
    this.usage.add('capaz_calls'); this.usage.add('capaz_in', final.usage.input_tokens); this.usage.add('capaz_out', final.usage.output_tokens);
    const uses = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!uses.length) return;
    this.kept.set(uses[0].id, final.content);
    if (this.kept.size > 200) this.kept.delete(this.kept.keys().next().value!);
    yield { type: 'tool_calls', calls: uses.map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) })) };
  }
}

interface OpenAiTool { function: { name: string; description?: string; parameters?: unknown } }
interface OpenAiMessage { role: string; content?: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }

/**
 * Historial en formato OpenAI -> formato de Anthropic: los mensajes `system` van aparte; una respuesta con herramientas
 * pasa a bloques `tool_use` (o a los bloques originales guardados, si esa respuesta fue de Anthropic); cada resultado
 * `tool` pasa a un bloque `tool_result` dentro de un mensaje del usuario; los mensajes seguidos del mismo rol se unen.
 */
export function toAnthropic(messages: OpenAiMessage[], kept: Map<string, unknown[]> = new Map()): { system: string; messages: { role: 'user' | 'assistant'; content: unknown[] }[] } {
  const system: string[] = [], out: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
  const text = (c: unknown) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => (p?.type === 'text' ? p.text : '')).join('') : '');
  const push = (role: 'user' | 'assistant', blocks: unknown[]) => { if (!blocks.length) return; const last = out[out.length - 1]; if (last?.role === role) last.content.push(...blocks); else out.push({ role, content: [...blocks] }); };
  for (const m of messages) {
    if (m.role === 'system') { const t = text(m.content).trim(); if (t) system.push(t); continue; }
    if (m.role === 'tool') { push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: text(m.content) || '(sin resultado)' }]); continue; }
    if (m.role === 'assistant') {
      const saved = m.tool_calls?.length ? kept.get(m.tool_calls[0].id) : undefined;
      if (saved) { push('assistant', saved); continue; }
      const t = text(m.content).trim(), blocks: unknown[] = t ? [{ type: 'text', text: t }] : [];
      for (const c of m.tool_calls ?? []) { let input: unknown = {}; try { input = JSON.parse(c.function.arguments || '{}'); } catch { /* argumentos mal formados: van vacios */ } blocks.push({ type: 'tool_use', id: c.id, name: c.function.name, input }); }
      push('assistant', blocks);
      continue;
    }
    const t = text(m.content).trim();
    if (t) push('user', [{ type: 'text', text: t }]);
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(Inicio de la conversación.)' }] }); // su API exige empezar por el usuario
  return { system: system.join('\n\n'), messages: out };
}

/**
 * Historial en formato OpenAI (chat) -> entrada de la API Responses: los `system` van en `instructions`; una respuesta
 * con herramientas pasa a los items originales guardados (con su razonamiento) o, si no estan, a items `function_call`;
 * cada resultado `tool` pasa a `function_call_output`.
 */
export function toResponsesInput(messages: OpenAiMessage[], kept: ItemStore): { instructions: string; input: unknown[] } {
  const system: string[] = [], input: unknown[] = [];
  const text = (c: unknown) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => (p?.type === 'text' ? p.text : '')).join('') : '');
  for (const m of messages) {
    if (m.role === 'system') { const t = text(m.content).trim(); if (t) system.push(t); continue; }
    if (m.role === 'tool') { input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: text(m.content) || '(sin resultado)' }); continue; }
    if (m.role === 'assistant') {
      const saved = m.tool_calls?.length ? kept.get(m.tool_calls[0].id) : undefined;
      if (saved) { input.push(...saved); continue; }
      const t = text(m.content).trim();
      if (t) input.push({ role: 'assistant', content: t });
      for (const c of m.tool_calls ?? []) input.push({ type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments || '{}' });
      continue;
    }
    if (Array.isArray(m.content)) {
      const parts = (m.content as any[]).map((p) => (p?.type === 'text' ? { type: 'input_text', text: String(p.text ?? '') } : p?.type === 'image_url' ? { type: 'input_image', image_url: String(p.image_url?.url ?? p.image_url ?? '') } : null)).filter(Boolean);
      if (parts.length) input.push({ role: 'user', content: parts });
    } else { const t = text(m.content).trim(); if (t) input.push({ role: 'user', content: t }); }
  }
  return { instructions: system.join('\n\n'), input };
}
