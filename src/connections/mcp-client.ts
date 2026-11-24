/**
 * Cliente MCP sobre el SDK oficial `@modelcontextprotocol/client` 2.4.0 (Apache-2.0). Leido el 2026-11-22 en su
 * repositorio (README, package.json y fuentes): se importa `Client` y `StreamableHTTPClientTransport` de la raiz; el
 * paquete trae compilacion CommonJS; `versionNegotiation: { mode: 'auto' }` prueba la revision moderna y cae al
 * `initialize` de los servidores anteriores (por defecto NO negocia); las cabeceras fijas van en `requestInit.headers`;
 * `listTools()` sin cursor junta todas las paginas; `callTool(params, opciones)` devuelve `content[]` e `isError`;
 * el tiempo de espera por defecto del SDK es 60 s (aqui se pasa uno propio).
 * Se carga con `require` y tipos propios minimos: el proyecto compila a CommonJS y los tipos del paquete son de ESM.
 */
export interface McpToolInfo { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }
export interface McpCallResult { text: string; isError: boolean }
export interface McpTarget { url: string; headers: Record<string, string>; /** Conexion por OAuth: el almacen de sus permisos (el SDK pone la cabecera y renueva cuando vencen). */ authProvider?: unknown }

const sdk = () => require('@modelcontextprotocol/client') as { Client: any; StreamableHTTPClientTransport: any };

/** Abre una conexion, ejecuta `fn` y la cierra siempre. Una conexion por operacion: sin estado entre llamadas. */
async function withClient<T>(t: McpTarget, ms: number, fn: (client: any, opts: { timeout: number; signal: AbortSignal }) => Promise<T>): Promise<T> {
  const { Client, StreamableHTTPClientTransport } = sdk();
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms + 2000);
  const client = new Client({ name: 'minijavi', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  // redirectPolicy por defecto: mismo origen. Asi una redireccion no se lleva la cabecera con el token a otro servidor.
  const transport = new StreamableHTTPClientTransport(new URL(t.url), { requestInit: { headers: t.headers }, ...(t.authProvider ? { authProvider: t.authProvider } : {}) });
  const opts = { timeout: ms, signal: ctl.signal };
  try { await client.connect(transport, opts); return await fn(client, opts); }
  finally { clearTimeout(timer); await client.close().catch(() => undefined); }
}

export function listTools(t: McpTarget, ms = 15_000): Promise<McpToolInfo[]> {
  return withClient(t, ms, async (c, o) => {
    const out = await c.listTools(undefined, o);
    return (Array.isArray(out?.tools) ? out.tools : []).slice(0, 300).map((x: any) => ({ name: String(x?.name ?? ''), description: typeof x?.description === 'string' ? x.description : undefined,
      inputSchema: x?.inputSchema && typeof x.inputSchema === 'object' ? x.inputSchema : undefined, annotations: x?.annotations && typeof x.annotations === 'object' ? { readOnlyHint: x.annotations.readOnlyHint === true, destructiveHint: x.annotations.destructiveHint !== false } : undefined }));
  });
}

export function callTool(t: McpTarget, name: string, args: Record<string, unknown>, ms = 20_000): Promise<McpCallResult> {
  return withClient(t, ms, async (c, o) => {
    const r = await c.callTool({ name, arguments: args }, o);
    const text = (Array.isArray(r?.content) ? r.content : []).map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : b?.type ? `[${b.type}]` : '')).filter(Boolean).join('\n');
    return { text: text || (r?.structuredContent ? JSON.stringify(r.structuredContent) : ''), isError: r?.isError === true };
  });
}

/** Un error del SDK o de la red, en una frase sin datos sensibles (nunca la URL completa ni cabeceras). */
export function explain(e: unknown): string {
  const err = e as any, status = Number(err?.data?.status ?? err?.status) || 0, name = String(err?.name ?? '');
  if (name === 'NeedsLogin' || err?.cause?.name === 'NeedsLogin') return 'hay que volver a conectar la cuenta (los permisos vencieron o se revocaron)';
  if (status === 401 || status === 403 || name === 'UnauthorizedError') return 'el servidor rechazó la clave (401/403)';
  if (status === 404) return 'el servidor respondió 404: la dirección no es la de un conector MCP';
  if (status) return `el servidor respondió ${status}`;
  if (name === 'AbortError' || /timed? ?out|timeout/i.test(String(err?.message))) return 'el servidor no respondió a tiempo';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(String(err?.message) + String(err?.cause?.code ?? ''))) return 'no se pudo conectar con el servidor';
  return `falló: ${String(err?.message ?? 'error sin detalle').replace(/https?:\/\/\S+/g, '(dirección)').slice(0, 160)}`;
}
