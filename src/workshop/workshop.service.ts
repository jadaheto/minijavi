import { designRules } from './design-check';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { DecisionsService } from '../decisions/decisions.service';
import { QUESTIONS } from '../decisions/questions';
import { Audit, runAudit } from './audit';
import { ProjectGit, Published, PublishResult } from './git';
import { DbService } from '../db/db.service';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import * as QRCode from 'qrcode';
import { ConfigService } from '../config/config.service';
import { UsageService } from '../usage/usage.service';
import { SiteCheck } from './site-check';
import { runReview } from './reviewer';
import { ACCOUNT_FAILURE, accountFailure, explainClaudeError } from './errors';
import { WorkshopBackupService } from './backup.service';
import { blockedReason, detectGates, evaluateStop, GateResult, missingGate, repairPrompt, runGate, StopReason, treeHash, weakest } from './gates';

export interface Project {
  slug: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;        // sesion de Claude Code: se retoma en cada encargo para que recuerde lo hecho
  status: 'libre' | 'trabajando' | 'error';
  lastTask?: string;
  lastSummary?: string;      // informe final del ultimo encargo
  model?: string;            // modelo del ultimo encargo
  unseen?: boolean;          // termino y aun no se le ha contado a Javier
  jobs: number;
  check?: SiteCheck;         // revision automatica del sitio publicado tras el ultimo encargo
  repaired?: boolean;        // el ultimo encargo necesito una correccion automatica
  sessionJobs?: number;      // encargos hechos en la sesion actual de Claude Code (al llegar al tope se empieza una nueva)
  run?: RunInfo;             // como cerro el ciclo del ultimo encargo: por que se detuvo y que dijo cada gate
  audit?: Audit;             // ultima auditoria pedida por Javier (tres lectores de solo lectura)
  github?: Published;        // ultima publicacion en GitHub (desde el panel)
}
/** Resultado del ciclo de un encargo (pasadas + comprobaciones del servidor). */
export interface RunInfo {
  at: string; stop: StopReason; passes: number; seconds: number;
  gates: { id: string; kind: string; label: string; ok: boolean; exit: number | null; seconds: number; output: string }[];
  /** Opinion del revisor independiente (informa, no decide). `error` = no hubo revision y por que. */
  review?: { verdict?: 'aprobar' | 'rechazar'; checks?: { check: string; pass: boolean; reason: string }[]; summary?: string; error?: string; seconds: number; attempts: number };
  /** El encargo lo termino el modelo de respaldo, y por que la suscripcion no pudo. */
  backup?: { model: string; reason: string };
}
/** Estado del ciclo en curso. */
interface Run {
  project: Project; task: string; formUrl: string; model: { id: string; label: string }; t0: number; deadline: number;
  pass: number; maxPasses: number;
  stale: number; weak?: string; hash?: string; // comprobaciones seguidas con el mismo gate en rojo y los archivos iguales
  seen: Set<string>;                            // gates que ya existieron en este encargo (si desaparecen, fallan)
  usd: number; turns: number;
  decision?: number | null;                     // decision del modelo "auto": al cerrar se anota como le fue
  backup?: { token: string; model: string; reason: string }; // el encargo siguio con el modelo de respaldo
  steppedDown?: boolean;                        // Fable no pudo (limite o cuenta): ya se intento con Opus
}
interface Job {
  slug: string; proc?: ChildProcess; t0: number; activity: string; spoken: string; steps: number; timer?: NodeJS.Timeout; cancelled?: boolean; timedOut?: boolean;
  model: string; agents: Set<string>; agentsTotal: number; code: string[]; run: Run; checking?: boolean;
  readers?: Set<ChildProcess>; // lectores en curso (revisor o auditoria), para poder cancelarlos
}
const GATE_ORDER = ['sitio', 'pruebas', 'lint', 'diseno']; // lo que funciona se arregla antes que lo que se ve
/** Modelos de Claude Code que Javier puede elegir por voz (verificados con su suscripcion el 2026-11-17). */
export const MODELS = [
  { key: 'fable', id: 'claude-fable-5-2', label: 'Fable 5.2' },
  { key: 'opus', id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { key: 'sonnet', id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { key: 'haiku', id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
] as const;
/** Lo que se muestra y se cuenta mientras Claude Code trabaja. */
export interface WorkState {
  active: boolean; project?: string; model?: string; activity?: string; spoken?: string;
  steps?: number; agents?: number; agentsTotal?: number; seconds?: number; code?: string[];
  pass?: number; passes?: number; checking?: boolean;
}
export interface JobDone { project: Project; ok: boolean; summary: string; seconds: number; site: boolean; check?: SiteCheck; stop: StopReason; }

/** Nombre de carpeta seguro: minusculas, digitos y guiones. */
export function slugify(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

const RULES = (slug: string, formUrl: string) => `
Trabajas para Javier Hermosilla, que te da los encargos hablando con su avatar de voz; no puede ver tu pantalla ni contestarte mientras trabajas.
- Trabaja SOLO dentro de la carpeta actual (el proyecto "${slug}"). No leas ni toques nada fuera de ella.
- Si el resultado se puede ver en un navegador (landing, página, app web sin servidor), deja la versión lista para publicar en la carpeta "sitio/" con un "sitio/index.html". Debe ser estática y funcionar desde una subruta: usa rutas RELATIVAS y no dependas de un servidor propio. Esa carpeta se publica sola.
- Formularios de contacto: envía un POST JSON a ${formUrl} con {proyecto: "${slug}", nombre, contacto, mensaje, autoriza: true}. Incluye una casilla de autorización de tratamiento de datos y no envíes sin ella. Responde {ok: true} si se guardó.
- Si el encargo es grande o tiene partes independientes (varias páginas o módulos, frontend y backend, investigar y luego construir), reparte el trabajo entre varios subagentes en paralelo con la herramienta Agent, y al final integra y verifica tú el resultado. Si es pequeño, hazlo directamente.
- No dejes procesos corriendo (servidores, watchers) al terminar. Si pruebas algo con un servidor, apágalo.
- No inventes datos de Javier, precios ni testimonios; si faltan, usa textos claramente marcados para completar y dilo en el informe.
- Si te falta una decisión importante, toma la opción más razonable y dilo; si de verdad no puedes seguir, pregunta en el informe.
- Memoria del proyecto: mantén en la raíz un archivo ESTADO.md corto (máximo 40 líneas, texto plano) con: qué es el proyecto y para quién, decisiones tomadas y su motivo, estructura de archivos, cómo probarlo y qué quedó pendiente. Si existe, léelo ANTES de empezar; actualízalo SIEMPRE antes de terminar. Cada cierto tiempo empezarás sin recordar la conversación anterior y ese archivo será lo único que tengas: escribe ahí lo que necesitarías saber, no la historia de lo que pasó.
- Comprobar es parte del trabajo: antes de terminar, PRUEBA lo que hiciste. Abre los archivos que escribiste, verifica que cada enlace, imagen, estilo y script local exista con ese nombre exacto, ejecuta lo que se pueda ejecutar (node --check, pruebas, un servidor temporal y curl) y corrige lo que falle. Cuando termines, el servidor ejecuta sus propias comprobaciones: revisa los enlaces y archivos de "sitio/" y, si el package.json del proyecto tiene los scripts "test" o "lint", corre npm test y npm run lint. Si algo falla te devuelve la salida literal para otra pasada, y a Javier se le dice el resultado real de esas comprobaciones, no lo que tú afirmes. Si el proyecto tiene código con lógica (no una página estática), déjale un script "test" real que la compruebe.
- Termina con un informe BREVE en español, en texto plano sin markdown (se leerá en voz alta): qué hiciste, qué quedó pendiente y, si aplica, la pregunta que necesitas que te respondan. Cierra con dos frases: "Comprobado:" (qué verificaste y cómo) y "Sin comprobar:" (lo que no pudiste verificar). No digas que algo funciona si no lo probaste.`;

/**
 * Taller de programacion del dueño: cada proyecto es una carpeta en DATA_DIR/proyectos y los encargos los ejecuta
 * Claude Code (`claude -p`) con la suscripcion de Javier (CLAUDE_CODE_OAUTH_TOKEN). Solo se usa desde el modo dueño:
 * la documentacion de Claude Code (legal-and-compliance) no permite usar la suscripcion para atender a terceros.
 *
 * Verificado el 2026-11-17 con la documentacion y una ejecucion real (Claude Code 2.1.326):
 *  - `claude -p <texto> --output-format stream-json --verbose`: una linea JSON por evento; `system/init` trae session_id,
 *    `assistant` trae bloques text / tool_use y la ultima linea es `result` {is_error, result, session_id, num_turns}.
 *  - `--resume <session_id>` retoma la conversacion; `--permission-mode acceptEdits` + `--allowedTools`.
 * Aislamiento: en produccion se ejecuta como otro usuario del sistema (TALLER_USER, via sudo) con un entorno que solo
 * lleva el token de Claude Code, para que los comandos que ejecute no puedan leer las claves ni los datos del avatar.
 */
@Injectable()
export class WorkshopService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(WorkshopService.name);
  private readonly root: string;
  private projects: Project[] = [];
  private job?: Job;
  private progressListeners: ((w: WorkState) => void)[] = [];
  private lastEmit = 0; private emitTimer?: NodeJS.Timeout;
  private listeners: ((d: JobDone) => void)[] = [];

  private auditListeners: ((p: Project) => void)[] = [];
  private readonly git: ProjectGit;

  constructor(private readonly cfg: ConfigService, private readonly usage: UsageService, private readonly db: DbService, @Optional() private readonly decisions?: DecisionsService, @Optional() private readonly backup?: WorkshopBackupService) {
    this.root = resolve(cfg.dataDir, 'proyectos');
    this.git = new ProjectGit(cfg, this.root);
    if (!this.enabled) return;
    mkdirSync(this.root, { recursive: true });
    // El usuario del taller debe poder crear archivos aqui; lo demas de DATA_DIR queda solo para el avatar.
    if (cfg.tallerUser) try { chmodSync(this.root, 0o1777); } catch { /* volumen de otro dueño */ }
  }

  /** Los proyectos se cargan de la base al arrancar y se mantienen en memoria; cada cambio se guarda en la base. */
  async onModuleInit() {
    if (!this.enabled) return;
    for (const r of await this.db.query<{ data: string }>('SELECT data FROM projects ORDER BY updated_at')) try { this.projects.push(JSON.parse(r.data)); } catch { /* registro dañado */ }
    for (const p of this.projects) if (p.status === 'trabajando') { p.status = 'error'; p.lastSummary = 'El servidor se reinició mientras trabajaba; el encargo quedó a medias y no se reanudó solo.'; p.unseen = true; this.save(p); }
    this.log.log(`taller activo: ${this.projects.length} proyectos${this.cfg.tallerUser ? `, usuario ${this.cfg.tallerUser}` : ' (sin usuario separado)'}`);
  }

  /**
   * Con todos los servicios ya creados: los datos del avatar que existian de antes (interesados, dispositivos) dejan de
   * ser legibles para otros usuarios. Los nuevos ya nacen asi por el umask de main.ts.
   */
  onApplicationBootstrap() {
    if (!this.enabled || !this.cfg.tallerUser) return;
    const data = resolve(this.cfg.dataDir);
    try { chmodSync(data, 0o711); } catch { /* volumen de otro dueño */ }
    for (const n of readdirSync(data)) { const f = join(data, n); try { if (statSync(f).isFile()) chmodSync(f, 0o600); } catch { /* no es nuestro */ } }
  }

  get enabled() { return !!this.cfg.claudeToken; }
  onModuleDestroy() { const j = this.job; this.job = undefined; j?.proc?.kill('SIGTERM'); for (const p of j?.readers ?? []) p.kill('SIGTERM'); }
  onAudit(fn: (p: Project) => void) { this.auditListeners.push(fn); }
  pendingAudits(): Project[] { return this.projects.filter((p) => p.audit?.unseen); }
  markAuditSeen(slug: string) { const p = this.projects.find((x) => x.slug === slug); if (p?.audit?.unseen) { p.audit.unseen = false; this.save(p); } }
  onDone(fn: (d: JobDone) => void) { this.listeners.push(fn); }
  onProgress(fn: (w: WorkState) => void) { this.progressListeners.push(fn); }

  /** Modelo por defecto (CLAUDE_MODEL) y el que corresponde a lo que pidio Javier ("sonnet", "Opus 5.5", un id completo). */
  get defaultModel() { return MODELS.find((m) => m.id === this.cfg.claudeModel || m.key === this.cfg.claudeModel) ?? { key: '', id: this.cfg.claudeModel, label: this.cfg.claudeModel }; }
  model(name?: string) {
    const n = String(name ?? '').toLowerCase();
    return (n && MODELS.find((m) => n.includes(m.key) || n === m.id)) || this.defaultModel;
  }

  /** Estado del encargo en curso, para la pantalla (actividad, agentes, lineas de codigo) y para la voz. */
  state(): WorkState {
    const j = this.job; if (!j) return { active: false };
    const p = this.projects.find((x) => x.slug === j.slug);
    return {
      active: true, project: p?.name ?? j.slug, model: MODELS.find((m) => m.id === j.model)?.label ?? j.model, activity: j.activity, spoken: j.spoken,
      steps: j.steps, agents: j.agents.size, agentsTotal: j.agentsTotal, seconds: Math.round((Date.now() - j.t0) / 1000), code: j.code.slice(-14),
      pass: j.run.pass, passes: j.run.maxPasses, checking: !!j.checking,
    };
  }
  /** Avisa el progreso como mucho una vez por segundo. */
  private emit(now = false) {
    clearTimeout(this.emitTimer);
    const wait = now ? 0 : 1000 - (Date.now() - this.lastEmit);
    if (wait > 0) { this.emitTimer = setTimeout(() => this.emit(true), wait); return; }
    this.lastEmit = Date.now();
    const st = this.state();
    for (const fn of this.progressListeners) try { fn(st); } catch { /* un oyente roto no detiene el trabajo */ }
  }

  private save(p: Project) {
    void this.db.query('INSERT INTO projects (slug, name, status, updated_at, data) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (slug) DO UPDATE SET name = excluded.name, status = excluded.status, updated_at = excluded.updated_at, data = excluded.data',
      [p.slug, p.name, p.status, p.updatedAt, JSON.stringify(p)]).catch((e) => this.log.error(`No se pudo guardar el proyecto ${p.slug}: ${(e as Error).message}`));
  }
  /** Encargos terminados, del mas reciente al mas antiguo (para el panel). */
  jobs(limit = 100) { return this.db.query('SELECT id, slug, at, seconds, model, ok, repair, turns, usd, issues, task FROM jobs ORDER BY id DESC LIMIT $1', [Math.min(500, Math.max(1, limit))]); }
  list(): Project[] { return [...this.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  dir(slug: string) { return join(this.root, slug); }
  hasSite(slug: string) { return existsSync(join(this.dir(slug), 'sitio', 'index.html')); }
  unseen(): Project[] { return this.projects.filter((p) => p.unseen); }
  markSeen(slug: string) { const p = this.projects.find((x) => x.slug === slug); if (p?.unseen) { p.unseen = false; this.save(p); } }

  /** Busca un proyecto por nombre aproximado (lo dicta una persona: "la landing del cafe" -> "landing-cafe"). */
  find(name: string): Project | undefined {
    const s = slugify(name);
    if (!s) return undefined;
    return this.projects.find((p) => p.slug === s)
      ?? this.projects.find((p) => p.slug.includes(s) || s.includes(p.slug))
      ?? this.projects.find((p) => s.split('-').filter((w) => w.length > 2).every((w) => p.slug.includes(w)));
  }

  /** Que esta haciendo ahora, para contarlo en voz. */
  progress(): string {
    if (!this.job) return 'El taller está libre, no hay ningún encargo en curso.';
    const p = this.projects.find((x) => x.slug === this.job!.slug);
    const min = Math.max(1, Math.round((Date.now() - this.job.t0) / 60000));
    const st = this.state();
    return `Trabajando en "${p?.name ?? this.job.slug}" con ${st.model} hace ${min} min (${this.job.run.pass > 1 ? `pasada ${this.job.run.pass} de ${this.job.run.maxPasses}, ` : ''}${this.job.steps} pasos${st.agentsTotal ? `, ${st.agentsTotal} subagentes lanzados` : ''}). Ahora: ${this.job.activity}. Encargo: ${p?.lastTask ?? ''}`;
  }
  busy() { return this.job?.slug; }

  /**
   * Borra un proyecto: su carpeta (codigo y sitio publicado) y su registro. El historial de encargos se conserva.
   * En produccion los archivos son del usuario del taller, asi que primero los borra el (sudo solo permite `claude` y
   * `rm` como ese usuario, ver Dockerfile) y despues el avatar quita la carpeta, que es suya. rm no sigue enlaces simbolicos.
   */
  async remove(slug: string): Promise<string | null> {
    const i = this.projects.findIndex((p) => p.slug === slug);
    if (i < 0) return 'no_existe';
    if (this.job?.slug === slug) return 'ocupado';
    const dir = this.dir(slug);
    if (resolve(dir) !== join(this.root, slug) || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) return 'no_existe';
    if (this.cfg.tallerUser && existsSync(dir)) spawnSync('sudo', ['-n', '-u', this.cfg.tallerUser, '/bin/rm', '-rf', '--', dir], { stdio: 'ignore', timeout: 60_000 });
    try { rmSync(dir, { recursive: true, force: true }); } catch (e) { this.log.warn(`no se pudo borrar ${slug}: ${(e as Error).message}`); }
    if (existsSync(dir)) return 'archivos';
    await this.db.query('DELETE FROM projects WHERE slug = $1', [slug]);
    this.git.remove(slug);
    this.projects.splice(i, 1);
    this.log.log(`taller: proyecto "${slug}" borrado`);
    return null;
  }

  cancel(): string {
    if (!this.job) return 'No hay ningún encargo en curso.';
    const job = this.job;
    job.cancelled = true;
    job.proc?.kill('SIGTERM'); for (const p of job.readers ?? []) p.kill('SIGTERM');
    setTimeout(() => { job.proc?.kill('SIGKILL'); for (const p of job.readers ?? []) p.kill('SIGKILL'); }, 5000).unref();
    return 'Encargo cancelado. Lo que alcanzó a hacer queda en el proyecto.';
  }

  /**
   * Empieza un encargo y vuelve enseguida; el resultado llega por `onDone`.
   * Devuelve el texto para el modelo (si empezo o por que no).
   *
   * Un encargo es un CICLO: pasada de Claude Code -> el servidor ejecuta los gates (`gates.ts`) -> si alguno falla, otra
   * pasada en la misma sesion con la salida literal del gate mas debil. Se detiene cuando todo pasa o por un limite
   * (pasadas, sin progreso, tiempo). A Javier se le avisa UNA vez, al cerrar el ciclo, con el resultado real.
   */
  start(projectName: string, task: string, formUrl: string, createIfMissing: boolean, modelName?: string, decision?: number | null): string {
    if (!this.enabled) return 'El taller no está configurado (falta CLAUDE_CODE_OAUTH_TOKEN).';
    task = task.trim();
    if (task.length < 8) return 'Falta describir el encargo con más detalle.';
    if (this.job) return `Ya hay un encargo en curso en el proyecto "${this.job.slug}". Hay que esperar a que termine o cancelarlo.`;
    let p = this.find(projectName);
    if (!p) {
      const slug = slugify(projectName);
      if (slug.length < 2) return 'Falta el nombre del proyecto.';
      if (!createIfMissing) return `No existe un proyecto parecido a "${projectName}". Proyectos: ${this.projects.map((x) => x.name).join(', ') || 'ninguno'}. Si es nuevo, vuelve a llamar con nuevo: true.`;
      if (this.projects.length >= this.cfg.tallerMaxProjects) return `Ya hay ${this.projects.length} proyectos, que es el máximo configurado.`;
      const now = new Date().toISOString();
      p = { slug, name: projectName.trim().slice(0, 60), createdAt: now, updatedAt: now, status: 'libre', jobs: 0 };
      this.projects.push(p);
    }
    const project = p;
    // Sesion de Claude Code: retomarla le da memoria, pero cada encargo relee toda la conversacion anterior. Tras
    // TALLER_SESSION_JOBS encargos se empieza una sesion nueva que arranca leyendo ESTADO.md (si el proyecto ya lo tiene;
    // si no, se sigue retomando hasta que lo escriba). Las pasadas de correccion de un encargo siguen en su misma sesion.
    let prompt = task;
    if (project.sessionId && (project.sessionJobs ?? project.jobs) >= this.cfg.tallerSessionJobs && existsSync(join(this.dir(project.slug), 'ESTADO.md'))) {
      this.log.log(`taller: sesión nueva para "${project.slug}" tras ${project.sessionJobs ?? project.jobs} encargos`);
      project.sessionId = undefined; project.sessionJobs = 0;
      prompt = `(Empiezas una sesión nueva sobre un proyecto que ya existe y no recuerdas la conversación anterior. Lee primero ESTADO.md y revisa los archivos que haga falta antes de cambiar nada.)\n\n${task}`;
    }
    else if (!project.sessionId && project.jobs > 0 && existsSync(join(this.dir(project.slug), 'ESTADO.md'))) {
      prompt = `(Empiezas una sesión nueva sobre un proyecto que ya existe y no recuerdas la conversación anterior. Lee primero ESTADO.md y revisa los archivos que haga falta antes de cambiar nada.)\n\n${task}`;
    }
    const model = this.model(modelName);
    const cwd = this.dir(project.slug);
    try { mkdirSync(cwd, { recursive: true, mode: 0o777 }); if (this.cfg.tallerUser) chmodSync(cwd, 0o777); } catch (e) { return `No se pudo crear la carpeta del proyecto: ${(e as Error).message}`; }

    const t0 = Date.now();
    const run: Run = { project, task, formUrl, model, t0, deadline: t0 + this.cfg.tallerMaxMinutes * 60_000, pass: 0, maxPasses: this.cfg.tallerAutoFix ? this.cfg.tallerMaxPasses : 1, stale: 0, seen: new Set(), usd: 0, turns: 0, decision };
    const job: Job = { slug: project.slug, t0, activity: 'empezando', spoken: 'está empezando', steps: 0, model: model.id, agents: new Set(), agentsTotal: 0, code: [], run };
    this.job = job;
    const err = this.pass(job, prompt);
    if (err) { this.job = undefined; return err; }
    project.sessionJobs = (project.sessionJobs ?? 0) + 1;
    project.status = 'trabajando'; project.lastTask = task.slice(0, 500); project.updatedAt = new Date().toISOString(); project.jobs++; project.unseen = false; project.model = model.label;
    this.save(project);
    this.log.log(`taller: encargo en "${project.slug}" con ${model.label}${project.sessionId ? ' (retoma sesión)' : ''}: ${task.slice(0, 120)}`);
    this.emit(true);
    return `Encargo iniciado en el proyecto "${project.name}"${project.jobs > 1 ? ' (continúa lo anterior)' : ' (proyecto nuevo)'} con el modelo ${model.label}. Claude Code está trabajando en segundo plano y puede tardar varios minutos. ` +
      'Dile a Javier que ya empezó y que le avisarás cuando termine; mientras tanto puede seguir hablando contigo.';
  }

  /** Lanza una pasada de Claude Code. Devuelve un texto solo si no pudo arrancar. */
  private pass(job: Job, prompt: string): string | undefined {
    const run = job.run, project = run.project, model = run.model;
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
      // Con el respaldo no hay busqueda web: es una herramienta del servidor de Anthropic.
      '--allowedTools', `Bash,Read,Edit,Write,Glob,Grep,WebFetch,${run.backup ? '' : 'WebSearch,'}TodoWrite,Agent,Task`, '--max-turns', String(this.cfg.tallerMaxTurns),
      '--append-system-prompt', RULES(project.slug, run.formUrl) + (this.cfg.tallerDesign && designRules() ? `\n${designRules()}\n` : '')];
    if (project.sessionId) args.push('--resume', project.sessionId);
    if (model.id && !run.backup) args.push('--model', model.id);
    // Entorno minimo: nada de las claves del avatar llega a Claude Code ni a los comandos que ejecute.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, LANG: 'C.UTF-8', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      // Con el respaldo no va la credencial de la suscripcion: va la direccion de este servidor y una clave temporal.
      ...(run.backup && this.backup ? this.backup.env(run.backup.token) : { CLAUDE_CODE_OAUTH_TOKEN: this.cfg.claudeToken }),
    };
    let cmd = this.cfg.claudeBin, argv = args;
    if (this.cfg.tallerUser) {
      // sudo solo permite ejecutar claude como el usuario del taller (ver Dockerfile); la carpeta del proyecto queda abierta para el.
      argv = ['-n', '-H', '-u', this.cfg.tallerUser, `--preserve-env=${Object.keys(env).join(',')}`, this.cfg.claudeBin, ...args];
      cmd = 'sudo';
    } else { env.HOME = process.env.HOME; }

    let proc: ChildProcess;
    try { proc = spawn(cmd, argv, { cwd: this.dir(project.slug), env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return `No se pudo iniciar Claude Code: ${(e as Error).message}`; }
    try { if (proc.pid && this.cfg.tallerNice) require('node:os').setPriority(proc.pid, this.cfg.tallerNice); } catch { /* sin permiso para cambiar la prioridad */ }
    run.pass++;
    job.proc = proc; job.checking = false;
    // El tiempo maximo es de TODO el encargo (todas las pasadas y sus comprobaciones), no de cada pasada.
    job.timer = setTimeout(() => { job.activity = 'tiempo agotado'; job.timedOut = true; proc.kill('SIGTERM'); setTimeout(() => proc.kill('SIGKILL'), 5000).unref(); }, Math.max(1000, run.deadline - Date.now()));

    const passT0 = Date.now();
    let pending = '', result: any, stderr = '', lastText = '', closed = false;
    proc.stdout!.on('data', (d: Buffer) => {
      pending += d.toString('utf8');
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl); pending = pending.slice(nl + 1);
        let ev: any; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.session_id && ev.type === 'system') project.sessionId = ev.session_id;
        if (ev.type === 'assistant') {
          for (const b of ev.message?.content ?? []) {
            if (b.type === 'text' && b.text?.trim()) lastText = b.text.trim();
            if (b.type === 'tool_use') {
              job.steps++;
              const d = describe(b.name, b.input); job.activity = d.screen; job.spoken = d.spoken;
              if (b.name === 'Agent' || b.name === 'Task') { job.agents.add(b.id); job.agentsTotal++; }
              // Lineas reales de lo que esta escribiendo o ejecutando: se ven reflejadas en las gafas del avatar.
              const src = String(b.input?.content ?? b.input?.new_string ?? b.input?.command ?? b.input?.prompt ?? '');
              for (const l of src.split('\n')) { const t = l.replace(/\s+$/, '').slice(0, 64); if (t.trim()) job.code.push(t); }
              if (job.code.length > 60) job.code.splice(0, job.code.length - 60);
            }
          }
          this.emit();
        }
        if (ev.type === 'user') { // resultado de una herramienta: si era un subagente, ya termino
          for (const b of Array.isArray(ev.message?.content) ? ev.message.content : []) if (b.type === 'tool_result' && job.agents.delete(b.tool_use_id)) this.emit();
        }
        if (ev.type === 'result') result = ev;
      }
    });
    proc.stderr!.on('data', (d: Buffer) => { stderr = (stderr + d.toString('utf8')).slice(-600); });
    const finish = (code: number | null, err?: Error) => {
      if (this.job !== job || closed) return;
      closed = true; clearTimeout(job.timer); job.proc = undefined;
      void this.afterPass(job, { code, err, result, lastText, stderr, passT0, prompt }).catch((e) => {
        this.log.error(`taller: fallo al cerrar la pasada de "${project.slug}": ${(e as Error).message}`);
        if (this.job === job) this.close(job, 'fallo', [], `El servidor falló al comprobar el resultado: ${(e as Error).message}`);
      });
    };
    proc.on('error', (e) => finish(null, e));
    proc.on('close', (code) => finish(code));
    return undefined;
  }

  /** Termino una pasada: se ejecutan los gates y se decide, en codigo, si hay otra pasada o por que se detiene. */
  private async afterPass(job: Job, r: { code: number | null; err?: Error; result: any; lastText: string; stderr: string; passT0: number; prompt: string }) {
    const run = job.run, project = run.project, dir = this.dir(project.slug), { result, lastText } = r;
    const seconds = Math.round((Date.now() - r.passT0) / 1000);
    // Consumo de la pasada. total_cost_usd es el equivalente a precio de API que informa Claude Code; con la suscripcion no se cobra aparte.
    // Con el respaldo esa cifra no vale (Claude Code la calcula con precios de Anthropic): el consumo real va en respaldo_in/out.
    const turns = Number(result?.num_turns) || 0, usd = run.backup ? 0 : Number(result?.total_cost_usd) || 0;
    this.usage.add('claude_jobs'); this.usage.add('claude_s', seconds); this.usage.add('claude_turns', turns); this.usage.add('claude_usd', usd);
    run.turns += turns; run.usd += usd;
    if (result?.session_id) project.sessionId = result.session_id;
    let ok = !!result && !result.is_error && r.code === 0;
    let summary = String(result?.result ?? '').trim() || lastText;
    if (job.cancelled) { ok = false; summary = 'El encargo se canceló antes de terminar.' + (lastText ? ` Lo último que dijo: ${lastText}` : ''); }
    else if (job.timedOut) { ok = false; summary = `Se acabó el tiempo (${this.cfg.tallerMaxMinutes} min) y el encargo quedó a medias.` + (lastText ? ` Lo último que dijo: ${lastText}` : ''); }
    else if (result?.subtype === 'error_max_turns') { ok = false; summary = `Llegó al máximo de pasos y quedó a medias. ${lastText}`; }
    else if (!ok) {
      const raw = `${summary} ${r.stderr}`, known = explainClaudeError(raw);
      summary = known ? `Claude Code no pudo trabajar: ${known}.` : `Claude Code falló${r.err ? `: ${r.err.message}` : ''}. ${summary || r.stderr.replace(/\s+/g, ' ').slice(-300) || `código ${r.code}`}`;
    }
    // ESCALON previo (pedido por Javier el 2026-11-21): si el encargo iba con Fable 5.2 y fallo por limite o cuenta, la
    // misma pasada se repite con Opus 5.5 (misma suscripcion, misma sesion). Si Opus tampoco puede, sigue el relevo al respaldo.
    if (!ok && !job.cancelled && !job.timedOut && !run.backup && !run.steppedDown && result?.subtype !== 'error_max_turns' && run.model.id === MODELS[0].id && run.deadline - Date.now() > 60_000
      && accountFailure(`${String(result?.result ?? '')} ${lastText} ${r.stderr}`)) {
      const before = run.model, opus = MODELS[1];
      run.steppedDown = true; run.model = { id: opus.id, label: opus.label }; project.model = opus.label; run.pass--;
      job.model = opus.label; job.activity = 'Fable no pudo: sigue con Opus'; job.spoken = 'sigue trabajando con Opus, porque Fable llegó a su límite';
      this.log.warn(`taller: "${project.slug}": Fable 5.2 no pudo (límite o cuenta); la pasada se repite con Opus 5.5`);
      const err = this.pass(job, r.prompt);
      if (!err) { this.save(project); this.emit(true); return; }
      run.pass++; run.model = before; project.model = before.label;
    }
    // RELEVO: si lo que fallo es la cuenta o el servicio (limite, credencial, saldo o saturacion) y hay modelo de respaldo, la MISMA pasada se repite
    // con el respaldo, en sesion nueva (la de la suscripcion no se puede retomar con otro proveedor). Una vez por encargo.
    if (!ok && !job.cancelled && !job.timedOut && !run.backup && result?.subtype !== 'error_max_turns') {
      const kind = accountFailure(`${String(result?.result ?? '')} ${lastText} ${r.stderr}`), why = kind ? (this.backup ? this.backup.refuse() : 'no está configurado') : '';
      if (kind && !why && this.backup && run.deadline - Date.now() > 60_000) {
        run.backup = { token: this.backup.issue(), model: this.backup.label, reason: ACCOUNT_FAILURE[kind] };
        this.log.warn(`taller: "${project.slug}": ${run.backup.reason}; el encargo sigue con el respaldo (${run.backup.model})`);
        const before = { sessionId: project.sessionId, model: run.model };
        project.sessionId = undefined; run.model = { id: '', label: `${run.backup.model} (respaldo)` }; project.model = run.model.label; run.pass--;
        job.model = run.backup.model; job.activity = 'la suscripción no pudo: sigue con el modelo de respaldo'; job.spoken = 'sigue trabajando con el modelo de respaldo, porque la suscripción de Claude no pudo';
        const err = this.pass(job, `(Mensaje del servidor. Continúas un encargo que otro modelo no pudo hacer o dejó a medias, y no recuerdas nada de lo anterior: lee ESTADO.md si existe y revisa los archivos antes de cambiar nada.${r.prompt === run.task ? '' : ` El encargo original de Javier era: «${run.task.slice(0, 3000)}».`})\n\n${r.prompt}`);
        if (!err) { this.save(project); this.emit(true); return; }
        this.backup.revoke(run.backup.token); run.backup = undefined; run.pass++; project.sessionId = before.sessionId; run.model = before.model; project.model = before.model.label;
        summary += ` No se pudo pasar al modelo de respaldo: ${err}`;
      } else if (kind && why) summary += ` No se usó el modelo de respaldo: ${why}.`;
    }
    let stop: StopReason | undefined = job.cancelled ? 'cancelado' : job.timedOut ? 'tiempo' : !ok ? 'fallo' : undefined;

    // CHECK: lo ejecuta el servidor, diga lo que diga el informe. Si la pasada no termino bien solo se mira el sitio
    // (no ejecuta nada), para que el panel muestre en que estado quedo lo publicado.
    const gates = detectGates(dir, { design: this.cfg.tallerDesign && !run.task.startsWith('Encargo de BOCETOS') }).filter((g) => !stop || g.kind === 'sitio');
    const results: GateResult[] = [];
    job.checking = true;
    for (const g of gates) {
      if (job.cancelled) break;
      if (g.kind !== 'sitio') { job.activity = `comprobando: ${g.label}`; job.spoken = 'está ejecutando las comprobaciones'; this.emit(true); }
      results.push(await runGate(g, dir, { npmBin: this.cfg.npmBin, user: this.cfg.tallerUser, nice: this.cfg.tallerNice, onProc: (p) => { job.proc = p; },
        seconds: Math.max(5, Math.min(this.cfg.tallerGateSeconds, Math.round((run.deadline - Date.now()) / 1000))) }));
    }
    job.checking = false; job.proc = undefined;
    if (this.job !== job) return; // el servidor se esta apagando
    if (!stop) {
      for (const id of run.seen) if (!gates.some((g) => g.id === id)) results.push(missingGate(id));
      for (const g of gates) run.seen.add(g.id);
      results.sort((a, b) => GATE_ORDER.indexOf(a.id) - GATE_ORDER.indexOf(b.id));
      if (job.cancelled) stop = 'cancelado';
    }
    const site = results.find((x) => x.kind === 'sitio')?.site;
    const at = new Date().toISOString(), runAt = new Date(run.t0).toISOString();
    void this.db.query('INSERT INTO jobs (slug, at, seconds, model, ok, repair, turns, usd, issues, task, summary) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
      [project.slug, new Date(r.passT0).toISOString(), seconds, run.model.label, ok ? 1 : 0, run.pass > 1 ? 1 : 0, turns, usd, site ? site.issues.length : null, (run.pass > 1 ? `(Pasada ${run.pass}, corrección tras las comprobaciones) ` : '') + run.task.slice(0, 2000), summary.slice(0, 4000)])
      .catch((e) => this.log.error(`No se pudo guardar el encargo: ${(e as Error).message}`));
    for (const g of results) void this.db.query('INSERT INTO job_gates (business, slug, run_at, pass, at, gate, kind, ok, exit_code, seconds, output) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
      [this.cfg.businessId, project.slug, runAt, run.pass, at, g.id, g.kind, g.ok ? 1 : 0, g.exit, g.seconds, g.output])
      .catch((e) => this.log.error(`No se pudo guardar el gate: ${(e as Error).message}`));

    if (!stop) {
      const w = weakest(results), hash = w ? treeHash(dir) : '';
      run.stale = w ? (w.id === run.weak && hash === run.hash ? run.stale + 1 : 1) : 0;
      run.weak = w?.id; run.hash = hash;
      stop = evaluateStop({ results, pass: run.pass, maxPasses: run.maxPasses, stale: run.stale, maxStale: this.cfg.tallerNoProgress, msLeft: run.deadline - Date.now(), blocked: !!blockedReason(summary) });
      if (!stop && w) {
        this.log.warn(`taller: "${project.slug}" pasada ${run.pass}: falla ${results.filter((x) => !x.ok).map((x) => x.id).join(', ')}; va otra pasada`);
        job.activity = `pasada ${run.pass + 1}: corrigiendo «${w.id}»`; job.spoken = `está corrigiendo lo que encontró la comprobación, va en la pasada ${run.pass + 1}`;
        project.lastSummary = summary.slice(0, 4000); this.save(project);
        const err = this.pass(job, repairPrompt(results, run.pass, run.maxPasses));
        if (!err) { this.emit(true); return; } // el aviso a Javier sale cuando se cierre el ciclo
        stop = 'fallo'; summary = `${err} ${summary}`;
      }
    }
    stop ??= 'fallo';
    // Revisor independiente: solo si Claude Code termino su trabajo. Informa; no cambia por que se detuvo el ciclo.
    let review: RunInfo['review'];
    if (this.cfg.tallerReview && ['verificado', 'sin_comprobar', 'pasadas', 'sin_progreso'].includes(stop)) {
      job.checking = true; job.activity = 'revisor independiente: leyendo el resultado'; job.spoken = 'ya terminó, y un revisor independiente está leyendo el resultado'; this.emit(true);
      const out = await runReview(dir, run.task, results, run.formUrl, { claudeBin: this.cfg.claudeBin, token: this.cfg.claudeToken, user: this.cfg.tallerUser, nice: this.cfg.tallerNice, seconds: this.cfg.tallerReviewSeconds,
        model: this.cfg.tallerReviewModel ? this.model(this.cfg.tallerReviewModel).id : run.model.id, env: run.backup && this.backup ? this.backup.env(run.backup.token) : undefined, track: this.tracker(job), cancelled: () => !!job.cancelled || this.job !== job });
      job.checking = false;
      if (this.job !== job) return;
      const reviewUsd = run.backup ? 0 : out.ok ? out.review.usd : out.usd;
      this.usage.add('claude_usd', reviewUsd); run.usd += reviewUsd;
      if (!job.cancelled) review = out.ok ? { verdict: out.review.verdict, checks: out.review.checks, summary: out.review.summary, seconds: out.review.seconds, attempts: out.review.attempts } : { error: out.error.slice(0, 300), seconds: out.seconds, attempts: out.attempts };
      if (review?.error) this.log.warn(`taller: no hubo revisión de "${project.slug}": ${review.error}`);
    }
    this.close(job, stop, results, summary, review);
  }

  /** Estado del respaldo, para el panel. */
  get backupStatus() { return this.backup?.status ?? { available: false, model: '', problem: 'no está configurado', usedToday: 0, dailyMax: 0 }; }
  get canPublish() { return this.git.canPublish; }
  versions(slug: string) { return this.git.versions(slug); }
  /** Publica el historial del proyecto en GitHub. Solo lo llama el panel del dueño (un clic); nunca la voz ni un encargo. */
  async publish(slug: string, repo: string): Promise<PublishResult> {
    const p = this.projects.find((x) => x.slug === slug);
    if (!p) return { ok: false, error: 'No existe ese proyecto.' };
    if (this.job?.slug === slug) return { ok: false, error: 'El proyecto tiene un trabajo en curso; espera a que termine.' };
    const r = await this.git.publish(slug, repo);
    if (r.ok) { p.github = r.published; this.save(p); this.log.log(`taller: "${slug}" publicado en ${r.published.repo} (${r.published.branch}, ${r.published.commit.slice(0, 7)})`); }
    else this.log.warn(`taller: no se publicó "${slug}": ${r.error}`);
    return r;
  }

  private tracker(job: Job) { return (p: ChildProcess, alive: boolean) => { job.readers ??= new Set(); if (alive) job.readers.add(p); else job.readers.delete(p); }; }

  /**
   * Modelo "auto": la capa de decisiones juzga que tan exigente es el encargo y el CODIGO lo traduce a un modelo
   * (TALLER_AUTO_MODELS). Si nadie decide, si la respuesta fue por defecto o si el tipo esta en modo sombra, se usa el
   * modelo por defecto. Devuelve el modelo y la decision, para anotar despues como le fue.
   */
  async pickModel(task: string, subject = ''): Promise<{ model: string; decision: number | null; auto: boolean }> {
    const fallback = { model: this.defaultModel.key || this.defaultModel.id, decision: null, auto: false };
    if (!this.decisions) return fallback;
    try {
      const d = await this.decisions.decide('modelo_taller', { encargo: task.slice(0, 2000), proyecto_ya_existe: !!this.find(subject) }, QUESTIONS.modelo_taller, { subject });
      const a = d.answers.nivel, id = await d.id;
      if (a.by === 'defecto') return { ...fallback, decision: id };
      const levels = this.cfg.tallerAutoModels, key = levels[Math.max(0, Math.min(levels.length - 1, Math.round(a.value)))];
      return MODELS.some((m) => m.key === key) ? { model: key, decision: id, auto: true } : { ...fallback, decision: id };
    } catch (e) { this.log.warn(`taller: no se pudo elegir el modelo: ${(e as Error).message}`); return fallback; }
  }

  /**
   * Auditoria pedida por Javier: tres lectores de solo lectura en paralelo (`audit.ts`). Ocupa el taller mientras corre
   * (un trabajo a la vez) pero no cambia nada del proyecto ni su estado. El resultado llega por `onAudit`.
   */
  audit(projectName: string, formUrl: string): string {
    if (!this.enabled) return 'El taller no está configurado (falta CLAUDE_CODE_OAUTH_TOKEN).';
    if (this.job) return `Ya hay un trabajo en curso en el proyecto "${this.job.slug}". Hay que esperar a que termine o cancelarlo.`;
    const project = this.find(projectName);
    if (!project) return `No existe un proyecto parecido a "${projectName}". Proyectos: ${this.projects.map((x) => x.name).join(', ') || 'ninguno'}.`;
    const dir = this.dir(project.slug);
    if (!this.files(project.slug, 1).length) return `El proyecto "${project.name}" no tiene archivos que auditar.`;
    const model = this.cfg.tallerReviewModel ? this.model(this.cfg.tallerReviewModel) : this.defaultModel, t0 = Date.now();
    const run: Run = { project, task: 'Auditoría del proyecto', formUrl, model, t0, deadline: t0 + this.cfg.tallerAuditSeconds * 1000, pass: 1, maxPasses: 1, stale: 0, seen: new Set(), usd: 0, turns: 0 };
    const job: Job = { slug: project.slug, t0, activity: 'auditoría: tres revisores leyendo el proyecto', spoken: 'tiene tres revisores leyendo el proyecto', steps: 0, model: model.id, agents: new Set(), agentsTotal: 3, code: [], run, checking: true };
    this.job = job; this.emit(true);
    this.log.log(`taller: auditoría de "${project.slug}" con ${model.label}`);
    void runAudit(dir, formUrl, { claudeBin: this.cfg.claudeBin, token: this.cfg.claudeToken, user: this.cfg.tallerUser, nice: this.cfg.tallerNice, seconds: this.cfg.tallerAuditSeconds, model: model.id, track: this.tracker(job), cancelled: () => !!job.cancelled || this.job !== job })
      .then(({ audit, usd }) => {
        if (this.job !== job) return;
        this.job = undefined; this.emit(true);
        this.usage.add('claude_usd', usd);
        if (job.cancelled) { this.log.log(`taller: auditoría de "${project.slug}" cancelada`); return; }
        project.audit = { at: new Date(t0).toISOString(), model: model.label, ...audit, unseen: true };
        this.save(project);
        this.log.log(`taller: auditoría de "${project.slug}" en ${audit.seconds} s: ${audit.findings.length} hallazgos${audit.failed.length ? `, sin resultado de: ${audit.failed.join(', ')}` : ''}`);
        for (const fn of this.auditListeners) try { fn(project); } catch (e) { this.log.error(`aviso de la auditoría: ${(e as Error).message}`); }
      })
      .catch((e) => { if (this.job === job) { this.job = undefined; this.emit(true); } this.log.error(`taller: la auditoría de "${project.slug}" falló: ${(e as Error).message}`); });
    return `Auditoría iniciada en el proyecto "${project.name}": tres revisores independientes lo están leyendo (no cambian nada) y tarda unos minutos. Dile a Javier que le avisas cuando termine.`;
  }

  /**
   * Como le va al taller (ultimos dias): cuantos encargos cierran verificados, cuantas pasadas toman, cuanto cuestan
   * (equivalente de API que informa Claude Code) y que comprobacion bloquea mas. Sale de `job_runs`, sin ningun modelo.
   */
  async metrics(days = 30) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = await this.db.query<{ passes: number; stop: string; verified: number; usd: number; failing: string; review: string }>('SELECT passes, stop, verified, usd, failing, review FROM job_runs WHERE business = $1 AND at >= $2', [this.cfg.businessId, since]);
    const closed = rows.filter((r) => r.stop !== 'cancelado'), verified = closed.filter((r) => Number(r.verified) === 1);
    const passes = closed.map((r) => Number(r.passes)).sort((a, b) => a - b), usd = rows.reduce((a, r) => a + Number(r.usd), 0);
    const count = (list: string[]) => { const m: Record<string, number> = {}; for (const k of list) if (k) m[k] = (m[k] ?? 0) + 1; return m; };
    const blocking = Object.entries(count(closed.flatMap((r) => r.failing.split(',')))).sort((a, b) => b[1] - a[1]).map(([gate, n]) => ({ gate, n }));
    return {
      days, runs: closed.length, cancelled: rows.length - closed.length, verified: verified.length, unchecked: closed.filter((r) => r.stop === 'sin_comprobar').length,
      rate: closed.length ? verified.length / closed.length : null,
      avgPasses: passes.length ? passes.reduce((a, b) => a + b, 0) / passes.length : null, p90Passes: passes.length ? passes[Math.min(passes.length - 1, Math.ceil(passes.length * 0.9) - 1)] : null,
      usd, usdPerVerified: verified.length ? usd / verified.length : null, stops: count(closed.map((r) => r.stop)), blocking, reviews: count(closed.map((r) => r.review)),
    };
  }

  /** Cierra el encargo: guarda el resultado real del ciclo y avisa una sola vez. */
  private close(job: Job, stop: StopReason, results: GateResult[], summary: string, review?: RunInfo['review']) {
    const run = job.run, project = run.project;
    clearTimeout(job.timer); this.job = undefined; this.emit(true);
    // La clave temporal del respaldo deja de valer, y el siguiente encargo vuelve a intentar con la suscripcion en sesion nueva.
    if (run.backup) { this.backup?.revoke(run.backup.token); project.sessionId = undefined; project.sessionJobs = 0; }
    const seconds = Math.round((Date.now() - run.t0) / 1000), site = results.find((x) => x.kind === 'sitio')?.site;
    project.status = stop === 'fallo' || stop === 'tiempo' ? 'error' : 'libre';
    project.check = site; project.repaired = run.pass > 1;
    project.run = { at: new Date(run.t0).toISOString(), stop, passes: run.pass, seconds, gates: results.map((g) => ({ id: g.id, kind: g.kind, label: g.label, ok: g.ok, exit: g.exit, seconds: g.seconds, output: g.output.slice(0, 2500) })), review, ...(run.backup ? { backup: { model: run.backup.model, reason: run.backup.reason } } : {}) };
    project.lastSummary = summary.slice(0, 4000); project.updatedAt = new Date().toISOString(); project.unseen = true;
    this.save(project);
    void this.db.query('INSERT INTO job_runs (business, slug, at, model, passes, stop, verified, seconds, turns, usd, failing, task, review) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
      [this.cfg.businessId, project.slug, project.run.at, run.model.label, run.pass, stop, stop === 'verificado' ? 1 : 0, seconds, run.turns, run.usd, results.filter((g) => !g.ok).map((g) => g.id).join(','), run.task.slice(0, 2000), review?.verdict ?? ''])
      .catch((e) => this.log.error(`No se pudo guardar el ciclo del encargo: ${(e as Error).message}`));
    // Version del proyecto tal como quedo, con el resultado real en el mensaje (sirve para volver atras tambien si quedo mal).
    void this.git.commit(project.slug, `[${stop}] ${run.task.split('\n')[0]}`).catch(() => undefined);
    if (run.decision) void this.decisions?.outcome(run.decision, `${run.model.label}: ${stop} en ${run.pass} ${run.pass === 1 ? 'pasada' : 'pasadas'}`);
    this.log.log(`taller: "${project.slug}" cerró en ${seconds} s, ${run.pass} ${run.pass === 1 ? 'pasada' : 'pasadas'}, ${job.steps} pasos: ${stop}${results.length ? ` (${results.map((g) => `${g.id} ${g.ok ? 'pasa' : 'FALLA'}`).join(', ')})` : ''}${review?.verdict ? `; el revisor recomienda ${review.verdict}` : ''}`);
    const done: JobDone = { project, ok: stop === 'verificado' || stop === 'sin_comprobar', summary: project.lastSummary, seconds, site: this.hasSite(project.slug), check: site, stop };
    for (const fn of this.listeners) try { fn(done); } catch (e) { this.log.error(`aviso del taller: ${(e as Error).message}`); }
  }

  /**
   * Ruta real de un archivo publicado (`sitio/`) de un proyecto, o null si no existe o se sale de la carpeta
   * (un enlace simbolico hacia fuera no se sirve: el taller escribe ahi y no debe poder publicar archivos del avatar).
   */
  siteFile(slug: string, rel: string): string | null {
    if (!/^[a-z0-9-]{2,40}$/.test(slug) || !this.projects.some((p) => p.slug === slug)) return null;
    const base = join(this.dir(slug), 'sitio');
    if (rel.split('/').some((part) => part.startsWith('.'))) return null;
    try {
      const realBase = realpathSync(base);
      if (realBase !== resolve(base)) return null;
      let target = realpathSync(resolve(base, rel || '.'));
      if (statSync(target).isDirectory()) target = realpathSync(join(target, 'index.html'));
      if (target !== realBase && !target.startsWith(realBase + sep)) return null;
      return statSync(target).isFile() ? target : null;
    } catch { return null; }
  }

  /** Bocetos publicados de un proyecto: sitio/bocetos/<n>/index.html, con el nombre y la frase que dejo Claude Code en bocetos.json. */
  sketches(slug: string): { n: number; name: string; desc: string }[] {
    const base = join(this.dir(slug), 'sitio', 'bocetos');
    let meta: any[] = [];
    try { const d = JSON.parse(readFileSync(join(base, 'bocetos.json'), 'utf8')); if (Array.isArray(d)) meta = d; } catch { /* sin descripciones */ }
    const clean = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const out: { n: number; name: string; desc: string }[] = [];
    for (let n = 1; n <= 6; n++) if (this.siteFile(slug, `bocetos/${n}/index.html`)) {
      const m = meta.find((x) => Number(x?.n) === n);
      out.push({ n, name: clean(m?.nombre, 40) || `Boceto ${n}`, desc: clean(m?.descripcion, 160) });
    }
    return out;
  }

  /** Direccion publica del sitio de un proyecto ('' si no tiene). */
  siteUrl(slug: string, origin: string): string { return this.hasSite(slug) ? `${this.cfg.publicUrl || origin}/p/${slug}/` : ''; }

  /** Tarjeta para la pantalla del avatar: nombre, enlace y codigo QR del sitio publicado. */
  async card(slug: string, origin: string): Promise<{ title: string; lines: string[]; qr: string; caption: string } | null> {
    const p = this.projects.find((x) => x.slug === slug), url = this.siteUrl(slug, origin);
    if (!p || !url) return null;
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: 'M' });
    return { title: p.name, lines: [url.replace(/^https?:\/\//, '')], qr, caption: 'Escanea para abrirlo' };
  }

  /** Archivos del proyecto (sin dependencias instaladas), para mostrarlos en el panel. */
  files(slug: string, max = 200): string[] {
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      let names: string[]; try { names = readdirSync(dir).sort(); } catch { return; }
      for (const n of names) {
        if (out.length >= max || n === 'node_modules' || n === '.git') continue;
        const full = join(dir, n);
        let st; try { st = statSync(full, { throwIfNoEntry: false }); } catch { continue; }
        if (!st) continue;
        if (st.isDirectory()) walk(full, rel + n + '/'); else out.push(rel + n);
      }
    };
    walk(this.dir(slug), '');
    return out;
  }
}

/** Describe lo que esta haciendo Claude Code: version para la pantalla y version para decir en voz. */
function describe(tool: string, input: any): { screen: string; spoken: string } {
  const path = String(input?.file_path ?? input?.path ?? ''), file = path.split('/').slice(-2).join('/'), base = path.split('/').pop() ?? '';
  switch (tool) {
    case 'Write': return { screen: `escribiendo ${file}`, spoken: `está escribiendo el archivo ${base}` };
    case 'Edit': return { screen: `editando ${file}`, spoken: `está editando el archivo ${base}` };
    case 'Read': return { screen: `leyendo ${file}`, spoken: `está revisando el archivo ${base}` };
    case 'Bash': return { screen: `$ ${String(input?.command ?? '').replace(/\s+/g, ' ').slice(0, 60)}`, spoken: 'está ejecutando comandos' };
    case 'WebFetch': case 'WebSearch': return { screen: 'consultando en internet', spoken: 'está consultando en internet' };
    case 'TodoWrite': return { screen: 'organizando los pasos', spoken: 'está organizando los pasos' };
    case 'Agent': case 'Task': { const d = String(input?.description ?? 'una parte del trabajo').slice(0, 60); return { screen: `agente: ${d}`, spoken: `acaba de lanzar un agente para ${d}` }; }
    default: return { screen: `usando ${tool}`, spoken: 'sigue trabajando' };
  }
}
