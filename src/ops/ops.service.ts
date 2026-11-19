import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { LeadsService } from '../leads/leads.service';
import { AlertsService } from './alerts.service';

/** Tablas que entran en el respaldo, en orden de restauracion. */
export const BACKUP_TABLES = ['leads', 'conversations', 'visitors', 'uso', 'devices', 'projects', 'jobs', 'portfolio', 'visits', 'wa_messages', 'wa_chats', 'generated_images', 'settings', 'decisions', 'optouts', 'actions', 'approvals', 'catalog', 'job_runs', 'job_gates'] as const;

/**
 * Tareas de fondo (pedido por Javier el 2026-11-18):
 *  - Vigilancia cada ALERT_CHECK_MINUTES: base de datos, Deepgram (GET /v1/projects), DeepSeek (GET /user/balance, que
 *    ademas da el saldo) y ElevenLabs (cualquier respuesta HTTP cuenta: la clave de Javier no tiene permisos de lectura).
 *    Consultas probadas con sus claves ese dia. Los cambios de estado los avisa AlertsService por Telegram.
 *  - Respaldo diario a BACKUP_HOUR: todas las tablas en un JSON comprimido en DATA_DIR/respaldos (se guardan
 *    BACKUP_KEEP) y, si BACKUP_TELEGRAM no es 0, tambien a Telegram para tener una copia fuera del servidor.
 *  - Seguimiento a FOLLOWUP_HOUR: lista de interesados que llevan FOLLOWUP_DAYS o mas en estado "nuevo".
 * Lo que ya corrio hoy se anota en la tabla `meta`, asi un reinicio no lo repite.
 */
@Injectable()
export class OpsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(OpsService.name);
  private timers: NodeJS.Timeout[] = [];
  constructor(private readonly cfg: ConfigService, private readonly db: DbService, private readonly leads: LeadsService, private readonly alerts: AlertsService) {}

  onApplicationBootstrap() {
    if (this.cfg.alertCheckMinutes > 0) {
      this.timers.push(setTimeout(() => void this.check(), 20_000), setInterval(() => void this.check(), this.cfg.alertCheckMinutes * 60_000));
    }
    this.timers.push(setInterval(() => void this.daily(), 60_000));
    for (const t of this.timers) t.unref();
  }
  onModuleDestroy() { for (const t of this.timers) { clearTimeout(t); clearInterval(t); } }

  private async meta(key: string, value?: string): Promise<string> {
    if (value === undefined) return String((await this.db.query('SELECT value FROM meta WHERE key = $1', [key]))[0]?.value ?? '');
    await this.db.query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, value]);
    return value;
  }
  private local() {
    const now = new Date();
    return { day: new Intl.DateTimeFormat('en-CA', { timeZone: this.cfg.timezone }).format(now), hour: Number(new Intl.DateTimeFormat('en-GB', { timeZone: this.cfg.timezone, hour: '2-digit', hour12: false }).format(now)) % 24 };
  }

  // ---------- vigilancia ----------
  async check() {
    const probe = async (name: string, fn: () => Promise<string>) => {
      try { this.alerts.set(name, true, await fn()); } catch (e) { this.alerts.set(name, false, (e as Error).message.slice(0, 160)); }
    };
    const get = async (url: string, headers: Record<string, string>) => fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    await Promise.all([
      (async () => { try { await this.db.query('SELECT 1 AS ok'); this.alerts.set('La base de datos', true, this.db.kind); } catch (e) { this.alerts.set('La base de datos', false, (e as Error).message.slice(0, 160), 2); } })(),
      probe('Deepgram (escucha)', async () => { const r = await get('https://api.deepgram.com/v1/projects', { Authorization: `Token ${this.cfg.deepgramApiKey}` }); if (!r.ok) throw new Error(r.status === 401 ? 'la clave fue rechazada' : `respondió ${r.status}`); return ''; }),
      probe('DeepSeek (modelo)', async () => {
        const r = await get('https://api.deepseek.com/user/balance', { Authorization: `Bearer ${this.cfg.deepseekApiKey}` });
        if (!r.ok) throw new Error(r.status === 401 ? 'la clave fue rechazada' : `respondió ${r.status}`);
        const d: any = await r.json().catch(() => ({})), b = Array.isArray(d.balance_infos) ? d.balance_infos[0] : undefined;
        if (d.is_available === false) throw new Error('la cuenta no tiene saldo disponible');
        const total = Number(b?.total_balance);
        if (Number.isFinite(total)) {
          const low = total < this.cfg.alertDeepseekBalance;
          this.alerts.set('El saldo de DeepSeek', !low, `${total.toFixed(2)} ${b.currency ?? ''}`.trim() + (low ? ` (por debajo de ${this.cfg.alertDeepseekBalance})` : ''), 1);
          return `saldo ${total.toFixed(2)} ${b.currency ?? ''}`.trim();
        }
        return '';
      }),
      ...(this.cfg.ttsProvider === 'browser' ? [] : [probe('ElevenLabs (voz)', async () => { const r = await get('https://api.elevenlabs.io/v1/models', { 'xi-api-key': this.cfg.elevenApiKey }); if (r.status >= 500) throw new Error(`respondió ${r.status}`); return ''; })]),
    ]);
  }

  // ---------- tareas diarias ----------
  private running = false;
  private async daily() {
    if (this.running) return; this.running = true;
    try {
      const { day, hour } = this.local();
      if (this.cfg.backupHour >= 0 && hour >= this.cfg.backupHour && (await this.meta('backup_day')) !== day) { await this.meta('backup_day', day); await this.backup(true); }
      if (this.cfg.followupHour >= 0 && hour >= this.cfg.followupHour && (await this.meta('followup_day')) !== day) { await this.meta('followup_day', day); await this.followUp(); }
    } catch (e) { this.log.warn(`tareas diarias: ${(e as Error).message}`); }
    finally { this.running = false; }
  }

  /** Vuelca todas las tablas a un JSON comprimido. Devuelve el archivo en memoria y su nombre. */
  async dump(): Promise<{ name: string; file: Buffer; rows: number }> {
    const tables: Record<string, unknown[]> = {}; let rows = 0;
    for (const t of BACKUP_TABLES) { tables[t] = await this.db.query(`SELECT * FROM ${t}`); rows += tables[t].length; }
    const file = gzipSync(Buffer.from(JSON.stringify({ app: 'minijavi', version: 1, at: new Date().toISOString(), db: this.db.kind, tables })));
    return { name: `minijavi-${this.local().day}.json.gz`, file, rows };
  }

  async backup(send: boolean): Promise<string> {
    try {
      const { name, file, rows } = await this.dump();
      const dir = resolve(this.cfg.dataDir, 'respaldos');
      mkdirSync(dir, { recursive: true }); writeFileSync(resolve(dir, name), file, { mode: 0o600 });
      for (const old of readdirSync(dir).filter((n) => /^minijavi-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(n)).sort().reverse().slice(this.cfg.backupKeep)) unlinkSync(resolve(dir, old));
      let where = 'guardado en el servidor';
      if (send && this.cfg.backupTelegram && this.alerts.enabled) {
        const err = await this.alerts.sendFile(file, name, 'application/gzip', `🗄 Respaldo diario del avatar: ${rows} registros. Guárdalo; contiene datos de tus interesados.`);
        where += err ? ` (no se pudo enviar a Telegram: ${err})` : ' y enviado a Telegram';
      }
      this.log.log(`respaldo ${name}: ${rows} registros, ${Math.round(file.length / 1024)} KB, ${where}`);
      this.alerts.set('El respaldo diario', true, `${name}, ${rows} registros`);
      return name;
    } catch (e) { this.alerts.set('El respaldo diario', false, (e as Error).message.slice(0, 160), 1); throw e; } // un respaldo fallido se avisa de una
  }

  /** Aviso de la mañana: interesados que siguen sin contactar. */
  async followUp(): Promise<number> {
    const pending = await this.leads.pending(this.cfg.followupDays);
    if (!pending.length) return 0;
    const days = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
    const lines = pending.slice(0, 15).map((l) => `• ${l.name}${l.company ? ` (${l.company})` : ''} — ${l.interest.replace(/_/g, ' ')} — ${l.contact} — hace ${days(l.created_at)} días`);
    await this.alerts.send(`📋 ${pending.length === 1 ? 'Hay 1 interesado' : `Hay ${pending.length} interesados`} sin contactar desde hace ${this.cfg.followupDays} días o más:\n${lines.join('\n')}${pending.length > 15 ? `\n… y ${pending.length - 15} más` : ''}\n\nPuedes decirle al avatar: "marca a ${pending[0].name.split(' ')[0]} como contactado".`);
    return pending.length;
  }
}
