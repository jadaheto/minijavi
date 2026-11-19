import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigService } from '../config/config.service';

/**
 * Historial y publicacion de los proyectos del taller (T4, 2026-11-19).
 *  - El historial git de cada proyecto vive FUERA de su carpeta (`DATA_DIR/git/<slug>.git`, con la carpeta del proyecto
 *    como arbol de trabajo): el usuario del taller (Claude Code y los comandos que ejecute) no puede leerlo ni reescribirlo,
 *    y el token nunca queda cerca del proyecto.
 *  - Publicar es SOLO un clic del dueño en el panel: a un repositorio que ya exista, privado y donde el token pueda
 *    escribir; sin forzar; y nunca si algun archivo de alguna version tiene algo con forma de clave.
 *  - El token (TALLER_GITHUB_TOKEN) solo llega al proceso `git push` por su entorno (GIT_ASKPASS): no va en la direccion,
 *    ni en argumentos, ni en la configuracion del repositorio, ni en los registros.
 * GitHub, documentacion leida el 2026-11-19: push con un token fine-grained = Contents: write; `GET /repos/{owner}/{repo}`
 * trae `private`, `default_branch` y `permissions.push`; cabeceras Accept application/vnd.github+json y
 * X-GitHub-Api-Version 2026-03-10; en git por HTTPS el token va como contraseña.
 */

export interface Version { hash: string; at: string; message: string; }
export interface Published { repo: string; branch: string; at: string; commit: string; }
export type PublishResult = { ok: true; published: Published } | { ok: false; error: string; files?: string[] };

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** Cosas con forma de clave. Solo se informa en que archivo, nunca el texto encontrado. */
const SECRETS = ['-----BEGIN [A-Z ]*PRIVATE KEY-----', 'ghp_[A-Za-z0-9]{30,}', 'github_pat_[A-Za-z0-9_]{40,}', 'gh[ousr]_[A-Za-z0-9]{30,}', 'sk-ant-[A-Za-z0-9_-]{20,}', 'sk-[A-Za-z0-9]{32,}',
  'AKIA[0-9A-Z]{16}', 'xox[baprs]-[A-Za-z0-9-]{10,}', 'AIza[0-9A-Za-z_-]{35}', 'EAA[A-Za-z0-9]{60,}'].join('|');
const EXCLUDE = ['node_modules/', '.env', '.env.*', '!.env.example', '*.pem', '*.key', '.DS_Store', ''].join('\n');

export class ProjectGit {
  private readonly root: string;
  private readonly askpass: string;
  /** Un proyecto a la vez por repositorio: guardar y publicar no se pisan. */
  private queue = new Map<string, Promise<unknown>>();

  constructor(private readonly cfg: ConfigService, private readonly projects: string) {
    this.root = resolve(cfg.dataDir, 'git');
    this.askpass = join(this.root, 'askpass.sh');
  }

  get enabled() { return this.cfg.tallerGit; }
  get canPublish() { return this.enabled && !!this.cfg.tallerGithubToken; }
  private dir(slug: string) { return join(this.root, `${slug}.git`); }
  private valid(slug: string) { return /^[a-z0-9][a-z0-9-]{1,39}$/.test(slug); }

  private serial<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.queue.get(slug) ?? Promise.resolve()).then(fn, fn);
    this.queue.set(slug, next.catch(() => undefined));
    return next;
  }

  /** Ejecuta git sin shell, sin la configuracion del sistema ni del usuario, y sin pedir nada por teclado. */
  private git(slug: string, args: string[], opts: { env?: NodeJS.ProcessEnv; ms?: number } = {}): Promise<{ code: number | null; out: string }> {
    return new Promise((done) => {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: this.root, LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...opts.env };
      let out = '', settled = false;
      const finish = (code: number | null, extra = '') => { if (settled) return; settled = true; clearTimeout(timer); done({ code, out: (out + extra).slice(-6000) }); };
      let proc;
      try { proc = spawn('git', ['--git-dir', this.dir(slug), '--work-tree', join(this.projects, slug), '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args], { cwd: this.root, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (e) { finish(null, `no se pudo ejecutar git: ${(e as Error).message}`); return; }
      const timer = setTimeout(() => { proc.kill('SIGKILL'); finish(null, '\ngit no terminó a tiempo'); }, opts.ms ?? 60_000);
      const add = (d: Buffer) => { out = (out + d.toString('utf8')).slice(-12_000); };
      proc.stdout!.on('data', add); proc.stderr!.on('data', add);
      proc.on('error', (e) => finish(null, `no se pudo ejecutar git: ${e.message}`));
      proc.on('close', (code) => finish(code));
    });
  }

  private async init(slug: string): Promise<boolean> {
    if (existsSync(join(this.dir(slug), 'HEAD'))) return true;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const r = await this.git(slug, ['init', '-q', '-b', 'main']);
    if (r.code !== 0) return false;
    for (const [k, v] of [['core.bare', 'false'], ['user.name', this.cfg.tallerGitName], ['user.email', this.cfg.tallerGitEmail], ['core.fsmonitor', 'false'], ['gc.auto', '0']]) await this.git(slug, ['config', k, v]);
    try { mkdirSync(join(this.dir(slug), 'info'), { recursive: true }); writeFileSync(join(this.dir(slug), 'info', 'exclude'), EXCLUDE); } catch { /* se guarda sin exclusiones propias */ }
    return true;
  }

  /** Guarda una version del proyecto. Devuelve el commit, '' si no habia cambios, o undefined si no se pudo. */
  commit(slug: string, message: string): Promise<string | undefined> {
    if (!this.enabled || !this.valid(slug)) return Promise.resolve(undefined);
    return this.serial(slug, async () => {
      if (!existsSync(join(this.projects, slug)) || !(await this.init(slug))) return undefined;
      // --ignore-errors: un archivo que el taller dejo sin permiso de lectura no impide guardar el resto.
      await this.git(slug, ['add', '-A', '--ignore-errors']);
      const staged = await this.git(slug, ['diff', '--cached', '--quiet']);
      if (staged.code === 0) return '';
      const text = message.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Cambios del taller';
      if ((await this.git(slug, ['commit', '-q', '-m', text])).code !== 0) return undefined;
      return (await this.git(slug, ['rev-parse', 'HEAD'])).out.trim().slice(0, 40);
    });
  }

  async versions(slug: string, max = 30): Promise<Version[]> {
    if (!this.enabled || !this.valid(slug) || !existsSync(join(this.dir(slug), 'HEAD'))) return [];
    const r = await this.git(slug, ['log', '-n', String(max), '--format=%H%x1f%cI%x1f%s']);
    if (r.code !== 0) return [];
    return r.out.split('\n').filter(Boolean).map((l) => { const [hash, at, message] = l.split('\x1f'); return { hash, at, message: message ?? '' }; });
  }

  /** Archivos de CUALQUIER version guardada (se publica el historial completo) que tienen algo con forma de clave. */
  private async secrets(slug: string): Promise<string[]> {
    const revs = (await this.git(slug, ['rev-list', '--max-count=300', 'HEAD'])).out.split('\n').filter((x) => /^[0-9a-f]{40}$/.test(x));
    if (!revs.length) return [];
    // -e: el patron empieza por guiones y sin esto git lo toma como una opcion (y no encontraba nada).
    const r = await this.git(slug, ['grep', '-lIE', '-e', SECRETS, ...revs, '--']);
    if (r.code === 1) return []; // 1 = nada encontrado
    if (r.code !== 0) return ['(no se pudo revisar: git grep falló)']; // si la revision falla, no se publica
    return [...new Set(r.out.split('\n').filter(Boolean).map((l) => l.slice(l.indexOf(':') + 1)))].slice(0, 10);
  }

  /** Publica el historial en un repositorio de GitHub que ya existe. Lo llama solo el panel del dueño. */
  publish(slug: string, repo: string): Promise<PublishResult> {
    const token = this.cfg.tallerGithubToken;
    const clean = (s: string) => (token ? s.split(token).join('***') : s).replace(/\s+/g, ' ').trim().slice(-400);
    if (!this.canPublish) return Promise.resolve({ ok: false, error: 'Falta TALLER_GITHUB_TOKEN en el servidor.' });
    repo = repo.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '');
    if (!this.valid(slug) || !REPO.test(repo)) return Promise.resolve({ ok: false, error: 'Escribe el repositorio como dueño/nombre.' });
    return this.serial(slug, async (): Promise<PublishResult> => {
      const head = (await this.git(slug, ['rev-parse', '--verify', '-q', 'HEAD'])).out.trim();
      if (!/^[0-9a-f]{40}$/.test(head)) return { ok: false, error: 'Este proyecto todavía no tiene ninguna versión guardada.' };
      // 1. El repositorio debe existir, ser privado y aceptar escritura con este token.
      let info: any;
      try {
        const res = await fetch(`${this.cfg.tallerGithubApi}/repos/${repo}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'taller' }, signal: AbortSignal.timeout(15_000) });
        if (res.status === 404) return { ok: false, error: `GitHub no encuentra ${repo}, o el token no tiene acceso a ese repositorio. Créalo vacío y privado y agrégalo al token.` };
        if (res.status === 401) return { ok: false, error: 'GitHub rechazó el token (venció o no es válido).' };
        if (!res.ok) return { ok: false, error: `GitHub respondió ${res.status} al consultar el repositorio.` };
        info = await res.json();
      } catch (e) { return { ok: false, error: `No se pudo consultar GitHub: ${clean((e as Error).message)}` }; }
      if (info?.private !== true) return { ok: false, error: `${repo} es público. El taller solo publica en repositorios privados.` };
      if (info?.permissions?.push !== true) return { ok: false, error: `El token no tiene permiso de escritura en ${repo} (necesita Contents: lectura y escritura).` };
      // 2. Nada con forma de clave en ninguna version.
      const files = await this.secrets(slug);
      if (files.length) return { ok: false, error: 'No se publicó: hay archivos con algo que parece una clave, en la versión actual o en una anterior.', files };
      // 3. Push sin forzar. El token viaja solo por el entorno de este proceso.
      const branch = /^[\w./-]{1,100}$/.test(String(info.default_branch ?? '')) ? String(info.default_branch) : 'main';
      this.writeAskpass();
      const r = await this.git(slug, ['push', '--porcelain', `${this.cfg.tallerGithubUrl}/${repo}.git`, `HEAD:refs/heads/${branch}`],
        { ms: 120_000, env: { GIT_ASKPASS: this.askpass, TALLER_GH_USER: repo.split('/')[0], TALLER_GH_TOKEN: token } });
      if (r.code !== 0) {
        const out = clean(r.out);
        if (/non-fast-forward|fetch first|rejected/i.test(out)) return { ok: false, error: `${repo} ya tiene otra historia en la rama ${branch} y el taller no fuerza el push. Usa un repositorio vacío.` };
        // Visto con GitHub real (2026-11-19): `permissions.push` de la API refleja al DUEÑO, no al token; un token sin Contents: write pasa esa consulta y falla aqui con 403.
        if (/write access to repository not granted|returned error: 403/i.test(out)) return { ok: false, error: `GitHub no dejó escribir en ${repo}: al token le falta el permiso Contents en "Read and write" para ese repositorio.` };
        if (/authentication failed|returned error: 401/i.test(out)) return { ok: false, error: 'GitHub rechazó el token al subir (venció o no es válido).' };
        if (/workflow/i.test(out)) return { ok: false, error: 'GitHub rechazó el push porque el proyecto trae archivos de GitHub Actions y el token no tiene el permiso Workflows.' };
        return { ok: false, error: `El push falló: ${out || 'sin detalle'}` };
      }
      return { ok: true, published: { repo, branch, at: new Date().toISOString(), commit: head } };
    });
  }

  /** Programa que git llama para pedir usuario y clave: responde con lo que trae el entorno del proceso. No contiene el token. */
  private writeAskpass() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeFileSync(this.askpass, '#!/bin/sh\ncase "$1" in\n  Username*) printf "%s\\n" "$TALLER_GH_USER" ;;\n  *) printf "%s\\n" "$TALLER_GH_TOKEN" ;;\nesac\n', { mode: 0o700 });
    chmodSync(this.askpass, 0o700);
  }

  /** Al borrar un proyecto se borra tambien su historial. */
  remove(slug: string) { if (this.valid(slug)) try { rmSync(this.dir(slug), { recursive: true, force: true }); } catch { /* nada que borrar */ } }
}
