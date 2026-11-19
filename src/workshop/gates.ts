import { ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkSite, SiteCheck } from './site-check';

/**
 * Gates del taller (pedido por Javier el 2026-11-19, tomado del harness de su proyecto Claude Workspace):
 * comprobaciones que ejecuta EL SERVIDOR despues de cada pasada de Claude Code. El encargo solo queda "verificado"
 * cuando todas pasan; lo que diga Claude Code en su informe no cierra nada.
 *
 * Diferencias a proposito con el original:
 *  - Los gates no se declaran: se detectan (Javier da los encargos por voz). `sitio` si hay sitio/index.html;
 *    `pruebas` y `lint` si el package.json del proyecto trae esos scripts.
 *  - Un comando es SIEMPRE una lista fija de argumentos elegida aqui (npm test, npm run lint), nunca texto del
 *    proyecto, y se ejecuta sin shell, como el usuario del taller y con un entorno sin las claves del avatar.
 *  - No hay rubrica (era el autor poniendose nota).
 */

export type StopReason = 'verificado' | 'sin_comprobar' | 'pasadas' | 'sin_progreso' | 'tiempo' | 'bloqueado' | 'cancelado' | 'fallo';

/** Por que se detuvo el ciclo, en palabras para el panel y para el aviso. */
export const STOP_TEXT: Record<StopReason, string> = {
  verificado: 'todas las comprobaciones del servidor pasaron',
  sin_comprobar: 'terminó, pero el proyecto no tiene nada que el servidor pueda comprobar (ni sitio publicado ni pruebas)',
  pasadas: 'se alcanzó el máximo de pasadas y todavía hay comprobaciones que fallan',
  sin_progreso: 'la última pasada no cambió nada y sigue fallando lo mismo',
  tiempo: 'se acabó el tiempo del encargo',
  bloqueado: 'Claude Code dijo que necesita una decisión de Javier para seguir',
  cancelado: 'el encargo se canceló',
  fallo: 'Claude Code no pudo terminar la pasada',
};

export interface Gate { id: 'sitio' | 'pruebas' | 'lint'; kind: 'sitio' | 'comando'; argv?: string[]; label: string; }
export interface GateResult {
  id: string; kind: 'sitio' | 'comando'; label: string; ok: boolean;
  exit: number | null;   // codigo de salida del comando (null: no es un comando, no llego a ejecutarse o se corto)
  seconds: number;
  output: string;        // salida literal (recortada)
  site?: SiteCheck;
}

const COMMANDS: Record<'pruebas' | 'lint', { script: string; argv: string[] }> = {
  pruebas: { script: 'test', argv: ['test'] },
  lint: { script: 'lint', argv: ['run', 'lint'] },
};
const MAX_OUTPUT = 6000;

/** Scripts del package.json de la raiz del proyecto. El archivo lo escribe el taller: se lee como dato, con tope y sin seguir enlaces. */
function scripts(dir: string): Record<string, string> {
  try {
    const file = join(dir, 'package.json'), st = lstatSync(file);
    if (!st.isFile() || st.size > 200_000) return {};
    const s = JSON.parse(readFileSync(file, 'utf8'))?.scripts;
    return s && typeof s === 'object' ? Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === 'string' && v.trim()) as [string, string][]) : {};
  } catch { return {}; }
}

/** Comprobaciones que aplican HOY al proyecto. */
export function detectGates(dir: string): Gate[] {
  const out: Gate[] = [];
  try { if (lstatSync(join(dir, 'sitio', 'index.html')).isFile()) out.push({ id: 'sitio', kind: 'sitio', label: 'revisión del sitio publicado' }); } catch { /* sin sitio */ }
  const s = scripts(dir);
  // `npm init` deja un script test que solo falla ("no test specified"): no es una prueba.
  if (s.test && !/no test specified/i.test(s.test)) out.push({ id: 'pruebas', kind: 'comando', argv: COMMANDS.pruebas.argv, label: 'npm test' });
  if (s.lint) out.push({ id: 'lint', kind: 'comando', argv: COMMANDS.lint.argv, label: 'npm run lint' });
  return out;
}

/** Un gate que existia en una pasada anterior y ya no aplica cuenta como fallo: quitar la prueba no es pasarla. */
export function missingGate(id: string): GateResult {
  const label = id === 'sitio' ? 'revisión del sitio publicado' : id === 'pruebas' ? 'npm test' : 'npm run lint';
  return { id, kind: id === 'sitio' ? 'sitio' : 'comando', label, ok: false, exit: null, seconds: 0,
    output: id === 'sitio' ? 'El sitio publicado (sitio/index.html) ya no existe.' : `El script de "${label}" ya no está en package.json. Quitar una comprobación no cuenta como pasarla: hay que restaurarla y dejarla en verde.` };
}

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  // En una salida larga lo que explica el fallo suele estar al final.
  return `${text.slice(0, 1500)}\n[... salida recortada ...]\n${text.slice(-(MAX_OUTPUT - 1500))}`;
}

export interface GateRunner {
  npmBin: string;
  user: string;          // usuario del taller ('' = el mismo proceso, solo en local)
  seconds: number;       // tope por comando
  nice: number;
  onProc?: (proc: ChildProcess | undefined) => void; // para poder cancelarlo
}

/** Ejecuta un gate. Nunca lanza: un comando que no arranca es un gate que falla. */
export function runGate(gate: Gate, dir: string, r: GateRunner): Promise<GateResult> {
  const t0 = Date.now();
  if (gate.kind === 'sitio') {
    const site = checkSite(join(dir, 'sitio'));
    return Promise.resolve({ id: gate.id, kind: 'sitio', label: gate.label, ok: site.ok, exit: null, seconds: 0, site,
      output: site.ok ? `Sin problemas en ${site.pages} páginas y ${site.files} archivos.` : site.issues.map((i) => `- ${i}`).join('\n') });
  }
  return new Promise((done) => {
    // Entorno minimo: ni las claves del avatar ni el token de Claude Code llegan a los comandos del proyecto.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8', CI: '1' };
    let cmd = r.npmBin, argv = gate.argv ?? [];
    // sudo solo permite estos dos comandos exactos como el usuario del taller (ver Dockerfile).
    if (r.user) { argv = ['-n', '-H', '-u', r.user, r.npmBin, ...argv]; cmd = 'sudo'; } else env.HOME = process.env.HOME;
    let out = '', settled = false, timedOut = false;
    const finish = (exit: number | null, extra = '') => {
      if (settled) return; settled = true; clearTimeout(timer); r.onProc?.(undefined);
      done({ id: gate.id, kind: 'comando', label: gate.label, ok: exit === 0 && !timedOut, exit, seconds: Math.round((Date.now() - t0) / 1000), output: clip((out + (extra ? `\n${extra}` : '')).trim()) });
    };
    let proc: ChildProcess;
    try { proc = spawn(cmd, argv, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { finish(null, `No se pudo ejecutar ${gate.label}: ${(e as Error).message}`); return; }
    r.onProc?.(proc);
    try { if (proc.pid && r.nice) require('node:os').setPriority(proc.pid, r.nice); } catch { /* sin permiso para cambiar la prioridad */ }
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGTERM'); setTimeout(() => proc.kill('SIGKILL'), 5000).unref(); }, r.seconds * 1000);
    const add = (d: Buffer) => { out += d.toString('utf8'); if (out.length > MAX_OUTPUT * 4) out = out.slice(0, 1500) + out.slice(-(MAX_OUTPUT * 3)); };
    proc.stdout!.on('data', add); proc.stderr!.on('data', add);
    proc.on('error', (e) => finish(null, `No se pudo ejecutar ${gate.label}: ${e.message}`));
    proc.on('close', (code) => finish(code, timedOut ? `Se cortó a los ${r.seconds} s sin terminar.` : ''));
  });
}

/**
 * Huella de los archivos del proyecto, para saber si una pasada cambio algo. No cuenta dependencias instaladas, git ni
 * ESTADO.md (Claude Code lo reescribe en cada pasada: no es progreso).
 */
export function treeHash(dir: string): string {
  const h = createHash('sha256');
  let files = 0, bytes = 0;
  const walk = (d: string, rel: string) => {
    let names: string[]; try { names = readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      if (files >= 4000 || n === 'node_modules' || n === '.git' || (rel === '' && n === 'ESTADO.md')) continue;
      const full = join(d, n);
      let st; try { st = lstatSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full, `${rel}${n}/`); continue; }
      files++; h.update(`${rel}${n}\0${st.size}\0`);
      // Contenido de los archivos pequeños (reescribir lo mismo no es un cambio); de los grandes, solo tamaño y fecha.
      if (st.isFile() && st.size <= 1_000_000 && bytes < 30_000_000) { try { h.update(readFileSync(full)); bytes += st.size; } catch { h.update(String(st.mtimeMs)); } }
      else h.update(String(st.mtimeMs));
    }
  };
  walk(dir, '');
  return h.digest('hex').slice(0, 16);
}

/** El gate que se ataca en la siguiente pasada: el primero que falla, en el orden sitio, pruebas, lint. */
export function weakest(results: GateResult[]): GateResult | undefined { return results.find((r) => !r.ok); }

/** Claude Code puede cerrar su informe con "BLOQUEADO: motivo" cuando necesita una decision de Javier. */
export function blockedReason(summary: string): string | undefined {
  return summary.match(/^\s*BLOQUEADO:\s*(.+)$/im)?.[1]?.trim().slice(0, 300);
}

/**
 * Decide, en codigo, si el ciclo sigue o por que se detiene. `undefined` = otra pasada.
 * El orden importa: lo primero que se mira es si ya paso todo.
 */
export function evaluateStop(p: { results: GateResult[]; pass: number; maxPasses: number; stale: number; maxStale: number; msLeft: number; blocked: boolean }): StopReason | undefined {
  if (!p.results.length) return 'sin_comprobar';
  if (p.results.every((r) => r.ok)) return 'verificado';
  if (p.blocked) return 'bloqueado';
  if (p.stale >= p.maxStale) return 'sin_progreso';
  if (p.pass >= p.maxPasses) return 'pasadas';
  if (p.msLeft < 60_000) return 'tiempo';
  return undefined;
}

/** Lo que se le devuelve a Claude Code para la siguiente pasada: el gate mas debil con su salida literal. */
export function repairPrompt(results: GateResult[], pass: number, maxPasses: number): string {
  const w = weakest(results)!, others = results.filter((r) => !r.ok && r !== w).map((r) => `«${r.id}» (${r.label})`);
  return `(Mensaje del servidor, no de Javier. Pasada ${pass + 1} de ${maxPasses}.) Después de tu trabajo el servidor ejecutó las comprobaciones del proyecto y no todas pasaron. A Javier todavía no se le ha avisado.

Falló «${w.id}» (${w.label}${w.exit !== null ? `, código de salida ${w.exit}` : ''}). Salida literal:
-----
${w.output || '(sin salida)'}
-----
${others.length ? `También fallan ${others.join(' y ')}; se atienden después.\n` : ''}
En esta pasada arregla ÚNICAMENTE lo que hace fallar «${w.id}». No cambies nada más, y no quites, vacíes ni desactives la comprobación para que pase: el servidor lo cuenta como fallo. Ejecuta tú mismo la comprobación y mira que pase antes de terminar.
Termina con el informe completo del encargo original (no solo de esta corrección). Si no puedes resolverlo sin una decisión de Javier, escribe como última línea: BLOQUEADO: <el motivo en una frase>.`;
}
