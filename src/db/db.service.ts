import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool, types } from 'pg';
import { ConfigService } from '../config/config.service';

/**
 * Base de datos del avatar (pedido por Javier el 2026-11-18: una base "de verdad" en vez de archivos en DATA_DIR).
 *  - Con DATABASE_URL: PostgreSQL (libreria `pg`, un Pool). Es lo que va en produccion.
 *  - Sin DATABASE_URL: SQLite en DATA_DIR/leads.db, como antes. Sirve para desarrollo y como respaldo: si la variable
 *    falta, el avatar sigue funcionando.
 * Las consultas se escriben UNA vez, con $1, $2... usados en orden y una sola vez cada uno (en SQLite se cambian por ?).
 * Las fechas son TIMESTAMPTZ en Postgres y texto ISO en SQLite; hacia el codigo siempre salen como texto ISO.
 * La primera vez copia lo que habia en los archivos viejos (leads.db, uso.db, devices.json, proyectos.json) y NO los borra.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS leads (
     id {{ID}}, created_at {{TS}} NOT NULL, name TEXT NOT NULL, contact TEXT NOT NULL, company TEXT NOT NULL DEFAULT '',
     interest TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'nuevo', notes TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '')`,
  // Conversaciones: llamadas de WhatsApp y, si SAVE_CONVERSATIONS=1, las del sitio.
  `CREATE TABLE IF NOT EXISTS conversations (
     id {{ID}}, at {{TS}} NOT NULL, kind TEXT NOT NULL, who TEXT NOT NULL DEFAULT '', seconds INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, transcript TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS visitors (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', visits INTEGER NOT NULL DEFAULT 0, updated_at {{TS}} NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS uso (day TEXT NOT NULL, key TEXT NOT NULL, value {{REAL}} NOT NULL DEFAULT 0, PRIMARY KEY (day, key))`,
  `CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at {{TS}} NOT NULL, last_seen {{TS}} NOT NULL)`,
  // Proyectos del taller: los campos para consultar van en columnas y el registro completo en `data` (JSON).
  `CREATE TABLE IF NOT EXISTS projects (slug TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, updated_at {{TS}} NOT NULL, data TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS jobs (
     id {{ID}}, slug TEXT NOT NULL, at {{TS}} NOT NULL, seconds INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL DEFAULT '', ok INTEGER NOT NULL DEFAULT 0, repair INTEGER NOT NULL DEFAULT 0,
     turns INTEGER NOT NULL DEFAULT 0, usd {{REAL}} NOT NULL DEFAULT 0, issues INTEGER, task TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '')`,
  // Portafolio: casos reales de Javier que el avatar puede contar (los carga el en el panel o por voz).
  `CREATE TABLE IF NOT EXISTS portfolio (
     id {{ID}}, created_at {{TS}} NOT NULL, updated_at {{TS}} NOT NULL, title TEXT NOT NULL, sector TEXT NOT NULL DEFAULT '', client TEXT NOT NULL DEFAULT '',
     problem TEXT NOT NULL DEFAULT '', solution TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', tech TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '',
     image TEXT NOT NULL DEFAULT '', visible INTEGER NOT NULL DEFAULT 1)`,
  // Visitas: una fila por conversacion publica terminada (sitio o llamada), con un resumen SIN transcripcion ni contacto.
  // Alimenta el informe por Telegram y el embudo del panel.
  `CREATE TABLE IF NOT EXISTS visits (
     id {{ID}}, at {{TS}} NOT NULL, kind TEXT NOT NULL, seconds INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, interested INTEGER NOT NULL DEFAULT 0,
     demo_offered INTEGER NOT NULL DEFAULT 0, demo_done INTEGER NOT NULL DEFAULT 0, lead INTEGER NOT NULL DEFAULT 0, cases INTEGER NOT NULL DEFAULT 0,
     interest TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', asked TEXT NOT NULL DEFAULT '', objections TEXT NOT NULL DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS visits_at ON visits (at)`,
  // Ajustes editables desde el panel (pesos, umbrales, interruptores), por negocio.
  `CREATE TABLE IF NOT EXISTS settings (business TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at {{TS}} NOT NULL, PRIMARY KEY (business, key))`,
  // Registro de cada decision de la capa de decisiones: que se pregunto, quien respondio y que se uso al final.
  // detail = JSON por pregunta {valor, probabilidades, confianza, quien, respaldo}; shadow = se decidio sin efecto;
  // agree = en modo sombra, si el proveedor principal coincidio con la referencia; mark = revision de Javier (ok | mal).
  `CREATE TABLE IF NOT EXISTS decisions (
     id {{ID}}, business TEXT NOT NULL, at {{TS}} NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL,
     backup INTEGER NOT NULL DEFAULT 0, defaulted INTEGER NOT NULL DEFAULT 0, shadow INTEGER NOT NULL DEFAULT 0, agree INTEGER, ms INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,
     detail TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL DEFAULT '', mark TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS decisions_at ON decisions (business, at)`,
  // Contactos que pidieron no ser contactados. contact = telefono con indicativo (solo digitos) o correo en minusculas.
  // lifted_at '' = marca vigente; solo Javier la quita, desde el panel.
  `CREATE TABLE IF NOT EXISTS optouts (id {{ID}}, business TEXT NOT NULL, contact TEXT NOT NULL, at {{TS}} NOT NULL, source TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '',
     marked_by TEXT NOT NULL DEFAULT 'avatar', decision_id INTEGER, lifted_at TEXT NOT NULL DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS optouts_contact ON optouts (business, contact)`,
  // Avisos para los dispositivos del dueño (Javi de bolsillo). `untrusted`: el detalle lo escribió alguien de fuera.
  `CREATE TABLE IF NOT EXISTS notices (id {{ID}}, business TEXT NOT NULL, at {{TS}} NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', word TEXT NOT NULL DEFAULT '',
    tone TEXT NOT NULL DEFAULT 'info', untrusted INTEGER NOT NULL DEFAULT 0, ref_kind TEXT NOT NULL DEFAULT '', ref_id TEXT NOT NULL DEFAULT '', seen_at {{TS}})`,
  // Bitacora de acciones por iniciativa propia (etapa 2). SOLO se agregan filas: ningun codigo las cambia ni las borra, y
  // cada una guarda la huella de la anterior (prev_hash -> hash), asi que una fila alterada o quitada rompe la cadena.
  `CREATE TABLE IF NOT EXISTS actions (
     id {{ID}}, business TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, channel TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '', lead_id INTEGER,
     trigger TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', cost_usd {{REAL}} NOT NULL DEFAULT 0,
     simulated INTEGER NOT NULL DEFAULT 0, decisions TEXT NOT NULL DEFAULT '', ref INTEGER, prev_hash TEXT NOT NULL DEFAULT '', hash TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS actions_at ON actions (business, at)`,
  `CREATE INDEX IF NOT EXISTS actions_contact ON actions (business, contact)`,
  // Bandeja de aprobaciones (etapa 2b): lo que el avatar quiere hacer y necesita el si de Javier. No vencen.
  // payload = lo necesario para ejecutarla al aprobar; nonce = va en los botones de Telegram; result = que paso al decidir.
  `CREATE TABLE IF NOT EXISTS approvals (
     id {{ID}}, business TEXT NOT NULL, created_at TEXT NOT NULL, kind TEXT NOT NULL, contact TEXT NOT NULL DEFAULT '', lead_id INTEGER, trigger TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '',
     why TEXT NOT NULL DEFAULT '', cost_usd {{REAL}} NOT NULL DEFAULT 0, consent INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pendiente',
     decided_at TEXT NOT NULL DEFAULT '', decided_by TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', nonce TEXT NOT NULL DEFAULT '', tg_message INTEGER, retry_at TEXT NOT NULL DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS approvals_status ON approvals (business, status)`,
  // Catalogo de precios (etapa 2c): lo unico que el avatar puede decir que cuesta algo. Vacio = no dice precios.
  `CREATE TABLE IF NOT EXISTS catalog (id {{ID}}, business TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price {{REAL}} NOT NULL, currency TEXT NOT NULL DEFAULT 'COP',
     unit TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, updated_at {{TS}} NOT NULL)`,
  // Imagenes generadas con IA: el archivo vive en DATA_DIR/imagenes; aqui queda con que descripcion se pidio.
  `CREATE TABLE IF NOT EXISTS generated_images (id {{ID}}, at {{TS}} NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '', format TEXT NOT NULL DEFAULT '', bytes INTEGER NOT NULL DEFAULT 0)`,
  // Chat de WhatsApp: los mensajes de cada numero (memoria del hilo) y el estado de la conversacion abierta.
  // open_at y last_at son texto ISO ('' = sin conversacion abierta): se comparan como texto en las dos bases.
  `CREATE TABLE IF NOT EXISTS wa_messages (id {{ID}}, phone TEXT NOT NULL, at {{TS}} NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS wa_messages_phone ON wa_messages (phone, id)`,
  `CREATE TABLE IF NOT EXISTS wa_chats (phone TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', last_at TEXT NOT NULL DEFAULT '', open_at TEXT NOT NULL DEFAULT '',
     turns INTEGER NOT NULL DEFAULT 0, leads TEXT NOT NULL DEFAULT '', cases INTEGER NOT NULL DEFAULT 0)`,
  // Entrega y lectura de lo que se le envia a cada numero por WhatsApp (avisos `statuses` de Meta): lo ultimo de cada tipo.
  `CREATE TABLE IF NOT EXISTS wa_delivery (phone TEXT PRIMARY KEY, sent_at TEXT NOT NULL DEFAULT '', delivered_at TEXT NOT NULL DEFAULT '', read_at TEXT NOT NULL DEFAULT '', failed_at TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '')`,
  // Lo que opina Javier de la calificacion de un interesado (bien | mal), con el puntaje que tenia al marcarla.
  `CREATE TABLE IF NOT EXISTS knowledge_docs (id {{ID}}, created_at TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT 'privado', status TEXT NOT NULL, kind TEXT NOT NULL DEFAULT '', pages INTEGER NOT NULL DEFAULT 0, chars INTEGER NOT NULL DEFAULT 0, chunks INTEGER NOT NULL DEFAULT 0, doc_id TEXT NOT NULL DEFAULT '', file_id TEXT NOT NULL DEFAULT '', modified TEXT NOT NULL DEFAULT '', synced_at TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '')`,
  // Memoria del dueño: lo que Javier le pide recordar al avatar (fija por secciones, o `nota`); `pendiente` = propuesta sin aprobar.
  `CREATE TABLE IF NOT EXISTS owner_memory (id {{ID}}, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, section TEXT NOT NULL DEFAULT 'sobre', text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'activa', origin TEXT NOT NULL DEFAULT '', used_at TEXT NOT NULL DEFAULT '')`,
  // Tareas de agentes ADK asignadas a Javier en Plane (por etiqueta): cuales ya se avisaron, la ficha del flujo y en que va cada una.
  `CREATE TABLE IF NOT EXISTS adk_tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, key TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '', due TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'nueva', seen_at TEXT NOT NULL, told_at TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', spec TEXT NOT NULL DEFAULT '', spec_at TEXT NOT NULL DEFAULT '', comment_at TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS lead_marks (lead_id INTEGER PRIMARY KEY, at TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0, level TEXT NOT NULL DEFAULT '', mark TEXT NOT NULL)`,
  // Archivos que el avatar creo en el Drive de Javier (solo puede tocar los suyos): que, cuando y de donde salio el texto.
  `CREATE TABLE IF NOT EXISTS google_created (id {{ID}}, at TEXT NOT NULL, kind TEXT NOT NULL, file_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', chars INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT '', theme TEXT NOT NULL DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS leads_created ON leads (created_at)`,
  `CREATE INDEX IF NOT EXISTS conversations_at ON conversations (at)`,
  `CREATE INDEX IF NOT EXISTS jobs_at ON jobs (at)`,
  // Taller con gates: un ciclo por encargo (por que se detuvo) y cada comprobacion de cada pasada con su salida literal.
  // run_at es el inicio del encargo en texto ISO: une los gates con su ciclo.
  `CREATE TABLE IF NOT EXISTS job_runs (id {{ID}}, business TEXT NOT NULL, slug TEXT NOT NULL, at TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', passes INTEGER NOT NULL DEFAULT 1, stop TEXT NOT NULL,
     verified INTEGER NOT NULL DEFAULT 0, seconds INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, usd {{REAL}} NOT NULL DEFAULT 0, failing TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '', review TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS job_gates (id {{ID}}, business TEXT NOT NULL, slug TEXT NOT NULL, run_at TEXT NOT NULL, pass INTEGER NOT NULL, at TEXT NOT NULL, gate TEXT NOT NULL, kind TEXT NOT NULL,
     ok INTEGER NOT NULL, exit_code INTEGER, seconds INTEGER NOT NULL DEFAULT 0, output TEXT NOT NULL DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS job_gates_run ON job_gates (slug, run_at)`,
  // Documentos de las demos "Crea tu propio asistente" (2026-11-21): la ficha del negocio y el estado. El texto completo
  // vive en Qdrant (scope demo). Se borran al vencer (expires_at); NO van en el respaldo diario (datos de terceros, 7 dias).
  // Modo negocio (C2): pedidos y citas que toma el asistente del cliente, y chats pasados a una persona (el asistente calla hasta until_at).
  `CREATE TABLE IF NOT EXISTS orders (id {{ID}}, at {{TS}} NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', when_text TEXT NOT NULL DEFAULT '', total {{REAL}} NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'nuevo', channel TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS handoffs (phone TEXT PRIMARY KEY, until_at TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '')`,
  // Uso del enlace de cada demo por dia (segundos de voz y charlas): para los topes y para saber si el cliente la abrio.
  `CREATE TABLE IF NOT EXISTS demo_usage (day TEXT NOT NULL, demo TEXT NOT NULL, seconds {{REAL}} NOT NULL DEFAULT 0, sessions INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, demo))`,
  // Conexiones con otras aplicaciones (etapa A, 2026-11-22). `secret` va CIFRADO con VAULT_KEY (boveda). Fuera del respaldo
  // diario: sin la clave maestra no sirve, y con ella no debe viajar en un archivo. connection_log = cada llamada o bloqueo.
  `CREATE TABLE IF NOT EXISTS connections (
     id {{ID}}, business TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, auth_kind TEXT NOT NULL DEFAULT 'ninguna', auth_header TEXT NOT NULL DEFAULT '',
     secret TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_used_at TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '', tools_at TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS connection_tools (
     connection_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', schema TEXT NOT NULL DEFAULT '', klass TEXT NOT NULL DEFAULT 'escritura', confirmed INTEGER NOT NULL DEFAULT 0,
     suggested TEXT NOT NULL DEFAULT 'escritura', hint TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL DEFAULT '', seen_at TEXT NOT NULL DEFAULT '', gone INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (connection_id, name))`,
  `CREATE TABLE IF NOT EXISTS connection_log (
     id {{ID}}, business TEXT NOT NULL, at TEXT NOT NULL, connection TEXT NOT NULL, tool TEXT NOT NULL, klass TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, ms INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '')`,
  // Avatares personalizados (2026-11-21): una fila por solicitud. Los archivos (foto y comprobantes) viven en DATA_DIR/avatares.
  // token = la clave del cliente para seguir su solicitud (va en el QR del comprobante); nonce = va en los botones de Telegram.
  // Fuera del respaldo diario: son datos personales de terceros con plazo de borrado.
  `CREATE TABLE IF NOT EXISTS avatar_requests (
     id {{ID}}, demo TEXT NOT NULL, lead_id INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', token TEXT NOT NULL, state TEXT NOT NULL,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL, price INTEGER NOT NULL DEFAULT 0, consent_at TEXT NOT NULL DEFAULT '', consent_text TEXT NOT NULL DEFAULT '', dir TEXT NOT NULL DEFAULT '',
     photo TEXT NOT NULL DEFAULT '', proof TEXT NOT NULL DEFAULT '', proof_hash TEXT NOT NULL DEFAULT '', proofs INTEGER NOT NULL DEFAULT 0, nonce TEXT NOT NULL DEFAULT '', tg_message INTEGER,
     decided_at TEXT NOT NULL DEFAULT '', decided_by TEXT NOT NULL DEFAULT '', reject_reason TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, portrait TEXT NOT NULL DEFAULT '',
     base_avatar TEXT NOT NULL DEFAULT '', colors TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', wa_status TEXT NOT NULL DEFAULT '', wa_at TEXT NOT NULL DEFAULT '',
     photo_deleted_at TEXT NOT NULL DEFAULT '', proof_deleted_at TEXT NOT NULL DEFAULT '')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS avatar_requests_token ON avatar_requests (token)`,
  `CREATE INDEX IF NOT EXISTS avatar_requests_demo ON avatar_requests (demo)`,
  `CREATE TABLE IF NOT EXISTS demos (id TEXT PRIMARY KEY, business TEXT NOT NULL, created_at {{TS}} NOT NULL, expires_at {{TS}} NOT NULL, status TEXT NOT NULL, profile TEXT NOT NULL DEFAULT '', chunks INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT '', lead_id INTEGER NOT NULL DEFAULT 0, consent_at {{TS}} NOT NULL, error TEXT NOT NULL DEFAULT '')`,
];

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly log = new Logger(DbService.name);
  readonly kind: 'postgres' | 'sqlite';
  private pool?: Pool;
  private lite?: DatabaseSync;
  /** Termina cuando el esquema existe y lo viejo ya se copio. Toda consulta espera a esto. */
  readonly ready: Promise<void>;

  constructor(private readonly cfg: ConfigService) {
    this.kind = cfg.databaseUrl ? 'postgres' : 'sqlite';
    mkdirSync(cfg.dataDir, { recursive: true });
    if (this.kind === 'postgres') {
      types.setTypeParser(1184, (v) => new Date(v).toISOString()); // timestamptz -> texto ISO
      types.setTypeParser(20, (v) => Number(v));                   // bigint (COUNT) -> numero
      this.pool = new Pool({ connectionString: cfg.databaseUrl, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 8000 });
      this.pool.on('error', (e) => this.log.error(`PostgreSQL: ${e.message}`)); // conexion inactiva que se cayo: el Pool abre otra
    } else {
      this.lite = new DatabaseSync(join(cfg.dataDir, 'leads.db'));
    }
    this.ready = this.init();
    this.ready.catch(() => { /* el error se informa al arrancar (onModuleInit de quien consulta) */ });
  }

  private async raw<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (this.pool) return (await this.pool.query(sql, params as any[])).rows as T[];
    const stmt = this.lite!.prepare(sql.replace(/\$\d+/g, '?'));
    const args = params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p)) as any[];
    return (/^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql) ? stmt.all(...args) : (stmt.run(...args), [])) as T[];
  }

  /** Consulta con parametros $1..$n. Devuelve las filas (para INSERT/UPDATE/DELETE, usar RETURNING si hacen falta). */
  async query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
    await this.ready;
    return this.raw<T>(sql, params);
  }

  private async init() {
    const pg = this.kind === 'postgres';
    const t0 = Date.now();
    for (const ddl of SCHEMA) {
      await this.raw(ddl.replace(/{{ID}}/g, pg ? 'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT')
        .replace(/{{TS}}/g, pg ? 'TIMESTAMPTZ' : 'TEXT').replace(/{{REAL}}/g, pg ? 'DOUBLE PRECISION' : 'REAL'));
    }
    // Autorizacion explicita (etapa 2): cuando y por donde la persona autorizo que la contacten. Va en las dos bases.
    if (pg) { await this.raw(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS quote_at TEXT NOT NULL DEFAULT ''`); await this.raw(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_at TEXT NOT NULL DEFAULT ''`); await this.raw(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_source TEXT NOT NULL DEFAULT ''`); }
    else if (!(await this.raw<{ name: string }>('SELECT name FROM pragma_table_info($1)', ['leads'])).some((c) => c.name === 'consent_at')) {
      await this.raw(`ALTER TABLE leads ADD COLUMN consent_at TEXT NOT NULL DEFAULT ''`); await this.raw(`ALTER TABLE leads ADD COLUMN consent_source TEXT NOT NULL DEFAULT ''`);
    }
    // Calificacion (etapa 3a): a que interesados pertenece cada visita. Solo sus numeros, nunca su contacto.
    if (pg) await this.raw(`ALTER TABLE google_created ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT ''`);
    else if (!(await this.raw<{ name: string }>('SELECT name FROM pragma_table_info($1)', ['google_created'])).some((c) => c.name === 'theme')) await this.raw(`ALTER TABLE google_created ADD COLUMN theme TEXT NOT NULL DEFAULT ''`);
    if (pg) await this.raw(`ALTER TABLE visits ADD COLUMN IF NOT EXISTS lead_ids TEXT NOT NULL DEFAULT ''`);
    else if (!(await this.raw<{ name: string }>('SELECT name FROM pragma_table_info($1)', ['visits'])).some((c) => c.name === 'lead_ids')) await this.raw(`ALTER TABLE visits ADD COLUMN lead_ids TEXT NOT NULL DEFAULT ''`);
    // Cuando pidio precio (etapa 2c). '' = no lo ha pedido.
    if (!pg && !(await this.raw<{ name: string }>('SELECT name FROM pragma_table_info($1)', ['leads'])).some((c) => c.name === 'quote_at')) await this.raw(`ALTER TABLE leads ADD COLUMN quote_at TEXT NOT NULL DEFAULT ''`);
    if (!pg) { // SQLite de antes: la tabla leads ya existia sin la columna `source`
      const cols = await this.raw<{ name: string }>('SELECT name FROM pragma_table_info($1)', ['leads']);
      if (!cols.some((c) => c.name === 'source')) await this.raw(`ALTER TABLE leads ADD COLUMN source TEXT NOT NULL DEFAULT ''`);
    }
    await this.importLegacy();
    // Una sola vez: los interesados que ya existian se guardaron siempre con autorizacion (hablada, por chat o con la casilla
    // del formulario), asi que heredan su fecha y su origen. De aqui en adelante '' significa "sin autorizacion registrada".
    if (!(await this.raw('SELECT value FROM meta WHERE key = $1', ['consent_v1'])).length) {
      await this.raw(pg ? `UPDATE leads SET consent_at = to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), consent_source = source WHERE consent_at = ''`
        : `UPDATE leads SET consent_at = created_at, consent_source = source WHERE consent_at = ''`);
      await this.raw('INSERT INTO meta (key, value) VALUES ($1, $2)', ['consent_v1', new Date().toISOString()]);
    }
    this.log.log(`base de datos lista: ${pg ? 'PostgreSQL' : 'SQLite en DATA_DIR (sin DATABASE_URL)'} en ${Date.now() - t0} ms`);
  }

  /** Copia una sola vez lo que habia en los archivos de DATA_DIR. Los archivos quedan donde estaban, como respaldo. */
  private async importLegacy() {
    if ((await this.raw('SELECT value FROM meta WHERE key = $1', ['legacy_v1'])).length) return;
    const pg = this.kind === 'postgres', dir = this.cfg.dataDir, n: Record<string, number> = {};
    const count = (k: string) => { n[k] = (n[k] ?? 0) + 1; };
    const oldDb = join(dir, 'leads.db');
    const has = (db: DatabaseSync, table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (existsSync(oldDb)) {
      const old = new DatabaseSync(oldDb);
      try {
        if (pg && has(old, 'leads')) { // en SQLite la tabla es la misma: no hay nada que copiar
          const cols = (old.prepare('SELECT name FROM pragma_table_info(?)').all('leads') as any[]).map((c) => c.name);
          for (const l of old.prepare('SELECT * FROM leads ORDER BY id').all() as any[]) {
            await this.raw('INSERT INTO leads (id, created_at, name, contact, company, interest, detail, status, notes, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING',
              [l.id, l.created_at, l.name, l.contact, l.company, l.interest, l.detail, l.status, l.notes, cols.includes('source') ? l.source : '']);
            count('interesados');
          }
          await this.raw(`SELECT setval(pg_get_serial_sequence('leads', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM leads), 1))`);
        }
        if (pg && has(old, 'visitors')) for (const v of old.prepare('SELECT * FROM visitors').all() as any[]) {
          await this.raw('INSERT INTO visitors (id, name, summary, visits, updated_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING', [v.id, v.name, v.summary, v.visits, v.updated_at]); count('visitantes');
        }
        if (has(old, 'calls')) for (const c of old.prepare('SELECT * FROM calls ORDER BY id').all() as any[]) {
          await this.raw('INSERT INTO conversations (at, kind, who, seconds, turns, transcript) VALUES ($1, $2, $3, $4, $5, $6)', [c.at, 'llamada', c.who, c.seconds, c.turns, c.transcript]); count('llamadas');
        }
      } finally { old.close(); }
    }
    const usoDb = join(dir, 'uso.db');
    if (existsSync(usoDb)) {
      const old = new DatabaseSync(usoDb);
      try {
        if (has(old, 'uso')) for (const u of old.prepare('SELECT * FROM uso').all() as any[]) {
          await this.raw('INSERT INTO uso (day, key, value) VALUES ($1, $2, $3) ON CONFLICT (day, key) DO NOTHING', [u.day, u.key, u.value]); count('medidas de consumo');
        }
      } finally { old.close(); }
    }
    const json = (file: string): any[] => { try { const d = JSON.parse(readFileSync(join(dir, file), 'utf8')); return Array.isArray(d) ? d : []; } catch { return []; } };
    for (const d of json('devices.json')) if (d?.id) {
      await this.raw('INSERT INTO devices (id, name, created_at, last_seen) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [String(d.id), String(d.name ?? 'Dispositivo'), d.createdAt, d.lastSeen ?? d.createdAt]); count('dispositivos');
    }
    for (const p of json('proyectos.json')) if (p?.slug) {
      await this.raw('INSERT INTO projects (slug, name, status, updated_at, data) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (slug) DO NOTHING', [String(p.slug), String(p.name ?? p.slug), String(p.status ?? 'libre'), p.updatedAt ?? new Date().toISOString(), JSON.stringify(p)]); count('proyectos');
    }
    await this.raw('INSERT INTO meta (key, value) VALUES ($1, $2)', ['legacy_v1', new Date().toISOString()]);
    const done = Object.entries(n).map(([k, v]) => `${v} ${k}`).join(', ');
    this.log.log(done ? `datos anteriores copiados a la base: ${done}` : 'no habia datos anteriores que copiar');
  }

  async onModuleDestroy() { try { await this.pool?.end(); this.lite?.close(); } catch { /* ya cerrada */ } }
}
