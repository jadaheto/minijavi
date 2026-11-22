import { ChildProcess, spawn } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Comprobacion «diseño» del taller (pedida por Javier el 2026-11-22). Dos partes, las dos sin navegador:
 *
 *  1. El comprobador de Hallmark (`vendor/hallmark/sloplint.mjs`, MIT, fijado a un commit: ver vendor/hallmark/ORIGEN.md).
 *     Lo ejecuta EL SERVIDOR sobre `sitio/`, sin shell, con argumentos fijos, como el usuario del taller y con un entorno
 *     sin claves. De todo lo que reporta solo hacen fallar las reglas de `content/taller-diseno.json` (las objetivas); las
 *     de gusto de sus autores no cuentan. No se instala su skill ni sus hooks.
 *  2. Comprobaciones propias, leyendo los archivos como datos: imagen sin `alt`, pagina sin `lang` o sin viewport, y
 *     scripts cargados desde otro servidor (las librerias van dentro del sitio).
 *
 * No ve el sitio: no detecta cosas montadas, desbordes reales ni que "se vea feo". Para eso haria falta un navegador.
 * Si el comprobador no se puede ejecutar (falta, se cuelga, salida ilegible) la parte 1 se OMITE y se dice: es una
 * comprobacion de calidad, no de seguridad, y no debe trabar todos los encargos por un fallo suyo.
 */
const ROOT = join(__dirname, '..', '..');
export const LINT_PATH = join(ROOT, 'vendor', 'hallmark', 'sloplint.mjs');
/** Los argumentos son SIEMPRE estos (los mismos que permite sudo en el Dockerfile). El directorio de trabajo es el proyecto. */
export const LINT_ARGV = [LINT_PATH, 'sitio', '--json', '--scope', 'page'];
/** Carpetas de `sitio/` que no se juzgan: las propuestas (bocetos) y las librerias copiadas. */
const SKIP = /^sitio\/(bocetos|vendor)\//;
const MAX_JSON = 4_000_000, MAX_ITEMS = 40;

export interface DesignRunner { user: string; seconds: number; nice: number; onProc?: (proc: ChildProcess | undefined) => void; nodeBin?: string; lintArgv?: string[] }
export interface DesignResult { ok: boolean; output: string; findings: string[]; linted: boolean; seconds: number }
interface Finding { gate: string; grade: string; file: string; line: number; evidence: string; fix?: string }

let blocking: Record<string, string> | undefined;
/** Las reglas del comprobador que hacen fallar, con su explicacion en español. */
export function blockingRules(file = join(ROOT, 'content', 'taller-diseno.json')): Record<string, string> {
  if (blocking && arguments.length === 0) return blocking;
  let out: Record<string, string> = {};
  try { const j = JSON.parse(readFileSync(file, 'utf8')); for (const [k, v] of Object.entries(j.bloquean ?? {})) if (/^[0-9A-Za-z]{1,6}$/.test(k) && typeof v === 'string') out[k] = v; } catch { out = {}; }
  if (arguments.length === 0) blocking = out;
  return out;
}

let rules: string | undefined;
/** El texto de reglas de diseño que recibe Claude Code en cada encargo (prompts/taller-diseno.md). */
export function designRules(): string {
  if (rules === undefined) { try { rules = readFileSync(join(ROOT, 'prompts', 'taller-diseno.md'), 'utf8').trim().replace('{{LIBS}}', join(ROOT, 'public', 'vendor')); } catch { rules = ''; } }
  return rules;
}

/** Paginas HTML de `sitio/` (sin bocetos ni librerias), como rutas relativas al proyecto. */
function pages(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: string[]; try { names = readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      if (out.length >= 60) return;
      const full = join(d, n), rel = relative(dir, full).split('\\').join('/');
      if (SKIP.test(`${rel}/`)) continue;
      let st; try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full); else if (/\.html?$/i.test(n) && st.size <= 2_000_000) out.push(rel);
    }
  };
  walk(join(dir, 'sitio'));
  return out;
}

/** Comprobaciones propias, sobre el HTML leido como texto. */
export function ownChecks(dir: string): string[] {
  const out: string[] = [];
  for (const rel of pages(dir)) {
    let html: string; try { html = readFileSync(join(dir, rel), 'utf8'); } catch { continue; }
    const body = html.replace(/<!--[\s\S]*?-->/g, '');
    const line = (i: number) => body.slice(0, i).split('\n').length;
    if (!/<html\b[^>]*\blang\s*=\s*["']?[a-z]{2}/i.test(body)) out.push(`${rel}: <html> sin atributo lang (por ejemplo lang="es")`);
    if (!/<meta\b[^>]*name\s*=\s*["']?viewport/i.test(body)) out.push(`${rel}: falta <meta name="viewport"> (en celular se ve en miniatura)`);
    for (const m of body.matchAll(/<img\b[^>]*>/gi)) if (!/\balt\s*=/.test(m[0])) out.push(`${rel}:${line(m.index!)} imagen sin alt: ${m[0].slice(0, 80)} (pon alt con lo que muestra, o alt="" si es de adorno)`);
    for (const m of body.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)/gi)) out.push(`${rel}:${line(m.index!)} script cargado desde otro servidor (${m[1].slice(0, 70)}): copia la librería a sitio/vendor/ y enlázala con ruta relativa`);
  }
  return out;
}

/** Ejecuta el comprobador y devuelve sus hallazgos, o `null` si no se pudo ejecutar o no se entiende su salida. */
function lint(dir: string, r: DesignRunner): Promise<Finding[] | null> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8', CI: '1' };
    const node = r.nodeBin ?? process.execPath, args = r.lintArgv ?? LINT_ARGV;
    let cmd = node, argv = args;
    if (r.user) { argv = ['-n', '-H', '-u', r.user, node, ...args]; cmd = 'sudo'; } else env.HOME = process.env.HOME;
    let out = '', settled = false, big = false;
    const finish = (v: Finding[] | null) => { if (settled) return; settled = true; clearTimeout(timer); r.onProc?.(undefined); done(v); };
    let proc: ChildProcess;
    try { proc = spawn(cmd, argv, { cwd: dir, env, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { finish(null); return; }
    r.onProc?.(proc);
    try { if (proc.pid && r.nice) require('node:os').setPriority(proc.pid, r.nice); } catch { /* sin permiso para cambiar la prioridad */ }
    const timer = setTimeout(() => { proc.kill('SIGKILL'); finish(null); }, r.seconds * 1000);
    proc.stdout!.on('data', (d: Buffer) => { if (out.length < MAX_JSON) out += d.toString('utf8'); else big = true; });
    proc.on('error', () => finish(null));
    proc.on('close', (code) => {
      // 0 = limpio, 1 = con hallazgos; cualquier otra salida es que no corrio bien.
      if (big || (code !== 0 && code !== 1)) return finish(null);
      try {
        const j = JSON.parse(out);
        if (!Array.isArray(j?.findings)) return finish(null);
        finish(j.findings.filter((f: any) => f && typeof f.gate === 'string' && typeof f.file === 'string').map((f: any) => ({ gate: f.gate, grade: String(f.grade), file: String(f.file).split('\\').join('/'), line: Number(f.line) || 0, evidence: String(f.evidence ?? '').slice(0, 160), fix: typeof f.fix === 'string' ? f.fix.slice(0, 160) : undefined })));
      } catch { finish(null); }
    });
  });
}

/** La comprobacion completa. Nunca lanza. */
export async function runDesign(dir: string, r: DesignRunner): Promise<DesignResult> {
  const t0 = Date.now(), rulesNow = blockingRules(), found = await lint(dir, r);
  const fromLint = (found ?? []).filter((f) => f.grade === 'FAIL' && f.gate in rulesNow && !SKIP.test(f.file.startsWith('sitio/') ? f.file : `sitio/${f.file}`))
    .map((f) => `${f.file}:${f.line} ${rulesNow[f.gate]} → ${f.evidence}`);
  const findings = [...new Set([...ownChecks(dir), ...fromLint])];
  const head = found === null ? 'El comprobador automático no se pudo ejecutar; solo se revisó lo básico (alt, lang, viewport, scripts externos). ' : '';
  const shown = findings.slice(0, MAX_ITEMS).map((f) => `- ${f}`).join('\n');
  return { ok: findings.length === 0, linted: found !== null, findings, seconds: Math.round((Date.now() - t0) / 1000),
    output: findings.length ? `${head}${findings.length} problema${findings.length === 1 ? '' : 's'} de diseño:\n${shown}${findings.length > MAX_ITEMS ? `\n(y ${findings.length - MAX_ITEMS} más del mismo tipo)` : ''}` : `${head}Sin problemas de diseño comprobables sin navegador.` };
}
