/** Parte un texto en fragmentos de ~900 caracteres respetando parrafos; el titulo de la seccion acompana a cada uno. */
export function chunk(text: string, max = 900): string[] {
  const out: string[] = [];
  let heading = '', cur = '';
  const push = () => { const t = cur.trim(); if (t.length > 20) out.push(heading && !t.startsWith(heading) ? `${heading}\n${t}` : t); cur = ''; };
  for (const para of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const p = para.trim(); if (!p) continue;
    const h = p.match(/^#{1,6}\s+(.+)$/m);
    if (h && p.startsWith('#')) { push(); heading = h[1].trim(); }
    if (cur.length + p.length > max) push();
    if (p.length > max) { for (let i = 0; i < p.length; i += max) { cur = p.slice(i, i + max); push(); } continue; }
    cur += (cur ? '\n\n' : '') + p;
  }
  push();
  return out;
}
