/**
 * API "Responses" de OpenAI (`POST {url}/responses`), con `fetch` directo y SSE. Guías leídas el 2026-11-19
 * (developers.openai.com: function-calling, streaming-responses, reasoning, migrate-to-responses). Hace falta porque los
 * modelos gpt-6.x solo aceptan herramientas por esta API (por /chat/completions responden 400).
 *
 * Se usa SIN estado (`store: false`): en cada petición se manda todo el historial. Los modelos que razonan exigen que,
 * junto a cada llamada a herramienta, vuelvan los ítems de razonamiento que la acompañaron (traen `encrypted_content`):
 * por eso se guarda la salida completa de cada respuesta que pidió herramientas (`ItemStore`) y se repone tal cual.
 *
 * NO confirmado en la documentación leída (se comprobó con llamadas reales): que el consumo llegue en
 * `response.completed`, y la forma del evento `error`.
 */

export class ResponsesHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Salida completa de las respuestas que pidieron herramientas, por el `call_id` de cada llamada. */
export class ItemStore {
  private readonly map = new Map<string, unknown[]>();
  constructor(private readonly max = 2000) {}
  save(output: any[]) {
    const ids = output.filter((i) => i?.type === 'function_call' && i.call_id).map((i) => String(i.call_id));
    for (const id of ids) { this.map.set(id, output); if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!); }
  }
  get(callId: string): unknown[] | undefined { return this.map.get(callId); }
}

/** Campos extra escritos para /chat/completions (MODELO_CAPAZ_EXTRA) llevados a esta API; lo que no aplica se descarta. */
export function extraForResponses(extra: Record<string, unknown>): Record<string, unknown> {
  const { reasoning_effort, max_tokens: _a, max_completion_tokens: _b, stream_options: _c, stream: _d, messages: _e, ...rest } = extra as any;
  return reasoning_effort ? { ...rest, reasoning: { ...(rest.reasoning ?? {}), effort: reasoning_effort } } : rest;
}

/** Herramienta en formato de chat ({function: {...}}) o de Anthropic ({name, input_schema}) -> forma plana de Responses. */
export function flatTool(name: string, description: string | undefined, parameters: unknown) {
  return { type: 'function', name, description: description ?? '', parameters: parameters ?? { type: 'object', properties: {} }, strict: false };
}

/** Eventos del stream, ya interpretados (cada uno trae `type`). Lanza `ResponsesHttpError` si la API no acepta la petición. */
export async function* responsesEvents(url: string, key: string, body: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<any> {
  const res = await fetch(`${url}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, stream: true, store: false }), signal });
  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => '');
    let msg = raw; try { msg = JSON.parse(raw)?.error?.message ?? raw; } catch { /* no era JSON */ }
    throw new ResponsesHttpError(res.status, String(msg).replace(/\s+/g, ' ').slice(0, 400));
  }
  const decoder = new TextDecoder();
  let pending = '';
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(part, { stream: true });
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let ev: any; try { ev = JSON.parse(data); } catch { continue; }
      if (ev && typeof ev.type === 'string') yield ev;
    }
  }
}

/** Consumo de una respuesta terminada (0 si no vino). */
export function responseUsage(ev: any): { input: number; output: number; cached: number } {
  const u = ev?.response?.usage ?? {};
  return { input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0, cached: Number(u.input_tokens_details?.cached_tokens) || 0 };
}

/** Texto de por qué falló una respuesta (`response.failed` o `error`). */
export function responseFailure(ev: any): string {
  return String(ev?.response?.error?.message ?? ev?.error?.message ?? ev?.message ?? 'la respuesta falló sin explicación').replace(/\s+/g, ' ').slice(0, 400);
}
