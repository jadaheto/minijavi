import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { VIEWS, type ViewId, catalogPrompt, checkModel, loadStyles, portraitPrompt, renderImages, styleReference, viewPrompt } from './avatar-studio';

/**
 * `npm run avatar -- <orden>`: el estudio de avatares desde la terminal (lo usa la skill `crear-avatar`).
 *   comprobar                              ¿la cuenta tiene el modelo de imagen? (no gasta)
 *   prompt <id | "descripción">            muestra el prompt, sin generar
 *   catalogo <id | "descripción"> [n]      n candidatos (3) de un personaje, con la imagen de referencia del estilo
 *   vistas <imagen> [perfil,atras,...]     las otras vistas del MISMO personaje (para modelarlo)
 *   retrato <foto> [n]                     la persona de la foto en el estilo de los avatares
 * Opciones: --salida <carpeta> (por defecto ./avatares-salida) · --calidad low|medium|high.
 * Cada imagen generada se cobra en OpenAI. La clave no se muestra. Sale con 1 si algo falla.
 */
async function main() {
  try { process.loadEnvFile('.env'); } catch { /* sin .env: variables del entorno */ }
  const args = process.argv.slice(2), opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] ?? '' : ''; };
  const out = resolve(opt('salida') || 'avatares-salida'), quality = opt('calidad');
  const [cmd, what = '', extra = ''] = args;
  const o = { key: process.env.OPENAI_API_KEY || process.env.MODELO_CAPAZ_KEY || '', model: process.env.IMAGEN_OPENAI_MODELO || process.env.IMAGEN_RESPALDO_MODELO || 'gpt-image-2.6-flare',
    quality: ['low', 'medium', 'high'].includes(quality) ? quality : 'medium' };
  const s = loadStyles();
  const describe = (w: string) => s.catalogo.find((c) => c.id === w)?.descripcion ?? w;
  const slug = (w: string) => (s.catalogo.some((c) => c.id === w) ? w : w.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'personaje');
  const save = (name: string, bufs: Buffer[]) => { mkdirSync(out, { recursive: true }); bufs.forEach((b, i) => { const f = join(out, bufs.length > 1 ? `${name}-${i + 1}.jpg` : `${name}.jpg`); writeFileSync(f, b); console.log(`✓ ${f}`); }); };
  const count = (v: string) => Math.min(4, Math.max(1, Number(v) || 0));

  if (cmd === 'comprobar') {
    const c = await checkModel(o); console.log(`${c.ok ? '✓' : '✗'} ${c.detail}`); if (!c.ok) process.exit(1);
  } else if (cmd === 'prompt' && what) {
    console.log(catalogPrompt(s, describe(what)));
  } else if (cmd === 'catalogo' && what) {
    if (describe(what).length < 20) throw new Error(`"${what}" no está en el catálogo (${s.catalogo.map((c) => c.id).join(', ')}); para un personaje nuevo escribe su descripción entre comillas`);
    const t0 = Date.now(); save(slug(what), await renderImages(o, catalogPrompt(s, describe(what)), [styleReference(s)], extra ? count(extra) : 3));
    console.log(`(${o.model}, calidad ${o.quality}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } else if (cmd === 'vistas' && what) {
    const img = readFileSync(what), name = basename(what).replace(/\.[a-z]+$/i, '');
    const want = (extra ? extra.split(',') : [...VIEWS]).filter((v): v is ViewId => (VIEWS as readonly string[]).includes(v));
    if (!want.length) throw new Error(`vistas válidas: ${VIEWS.join(', ')}`);
    let failed = 0;
    await Promise.all(want.map(async (v) => { try { save(`${name}-${v}`, await renderImages(o, viewPrompt(s, v), [img], 1)); } catch (e) { failed++; console.log(`✗ ${v}: ${(e as Error).message}`); } }));
    if (failed) process.exit(1);
  } else if (cmd === 'retrato' && what) {
    const t0 = Date.now(); save(`${basename(what).replace(/\.[a-z]+$/i, '')}-avatar`, await renderImages(o, portraitPrompt(s), [styleReference(s), readFileSync(what)], extra ? count(extra) : 1));
    console.log(`(${o.model}, calidad ${o.quality}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } else {
    console.log('Uso: npm run avatar -- comprobar | prompt <id|"descripción"> | catalogo <id|"descripción"> [n] | vistas <imagen> [vistas] | retrato <foto> [n]   [--salida carpeta] [--calidad low|medium|high]');
    process.exit(cmd ? 1 : 0);
  }
}
main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
