/**
 * Lo leido de una conexion no sale hacia otros lados (regla de la fase de conexiones). Aqui esta la parte que se puede
 * comprobar en codigo: si el texto que el modelo quiere mandar a otra herramienta (un encargo del taller, una nota de un
 * interesado, un caso del portafolio, la descripcion de una imagen) trae un tramo COPIADO de lo que se leyo.
 * Se comparan tramos de `N` palabras seguidas, sin mayusculas ni tildes. No detecta un texto parafraseado: para eso estan
 * las otras defensas (el contenido va envuelto como dato y el turno que lo lee no ejecuta acciones).
 */
const N = 8, MAX = 60_000;
const tokens = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) ?? [];
const grams = (t: string) => { const w = tokens(t), out: string[] = []; for (let i = 0; i + N <= w.length; i++) out.push(w.slice(i, i + N).join(' ')); return out; };

/** Anota lo leido (se guardan solo los tramos, hasta un tope: al llenarse se sueltan los mas viejos). */
export function remember(seen: Set<string>, text: string): void {
  for (const g of grams(text)) { seen.add(g); if (seen.size > MAX) seen.delete(seen.values().next().value as string); }
}
/** Los textos que lleva una llamada a herramienta (sus argumentos en JSON), sin los nombres de los campos. */
function strings(raw: string): string[] {
  const out: string[] = [], walk = (v: unknown, d: number) => { if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object' && d < 6) for (const x of Object.values(v)) walk(x, d + 1); };
  try { walk(JSON.parse(raw || '{}'), 0); } catch { out.push(raw); }
  return out;
}
/** ¿Los argumentos traen un tramo copiado de lo leido en una conexion? */
export function carries(rawArgs: string, seen: Set<string> | undefined): boolean {
  if (!seen?.size) return false;
  return strings(rawArgs).some((s) => grams(s).some((g) => seen.has(g)));
}
