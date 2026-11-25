import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { emitNotice } from '../notices/bus';
import { GoogleService } from './google.service';

/**
 * Avisos de correo nuevo (conexiones, etapa B3; decidido con Javier el 2026-11-24).
 *
 * Cada `CORREO_AVISOS_MIN` minutos (5; 0 = apagado) mira la bandeja PRINCIPAL sin leer del ultimo dia y, por cada correo
 * que no habia visto, emite un aviso al centro de avisos (`emitNotice`): de ahi sale a la placa y a lo que se conecte
 * despues. Se eligio preguntar cada pocos minutos y no los avisos instantaneos de Google porque esos exigen montar
 * Cloud Pub/Sub en el proyecto y renovar la suscripcion cada semana.
 *
 *  - La primera vez (o tras volver a conectar) NO avisa de lo que ya estaba: solo lo anota como visto.
 *  - Promociones, redes sociales y notificaciones quedan fuera (`category:primary`).
 *  - El aviso lleva remitente y asunto recortados, marcados como texto de terceros: se muestran como dato y, si el
 *    avatar los cuenta, van envueltos como tal. El cuerpo del correo no se lee aqui.
 *  - Como mucho 3 avisos por vuelta; si llegaron mas, uno solo que dice cuantos.
 *  - El horario silencioso lo impone el centro de avisos (quedan guardados y salen en la mañana).
 */
const META_KEY = 'google_mail_seen';
export const MAIL_WATCH_QUERY = 'in:inbox is:unread category:primary newer_than:1d';
const KEEP = 200;

@Injectable()
export class MailWatchService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(MailWatchService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private seen?: { account: string; ids: string[] };

  constructor(private readonly cfg: ConfigService, private readonly db: DbService, private readonly google: GoogleService) {}

  get enabled() { return this.cfg.mailNoticeMinutes > 0 && this.cfg.noticesEnabled && this.google.configured; }

  onApplicationBootstrap() {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.tick(), this.cfg.mailNoticeMinutes * 60_000); this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async load() {
    if (this.seen) return this.seen;
    try { const raw = (await this.db.query<{ value: string }>('SELECT value FROM meta WHERE key = $1', [META_KEY]))[0]?.value; this.seen = raw ? JSON.parse(raw) : undefined; } catch { /* se empieza de cero */ }
    return (this.seen ??= { account: '', ids: [] });
  }
  private async save() {
    await this.db.query('DELETE FROM meta WHERE key = $1', [META_KEY]);
    await this.db.query('INSERT INTO meta (key, value) VALUES ($1, $2)', [META_KEY, JSON.stringify(this.seen)]);
  }

  /** Una vuelta. Devuelve cuantos avisos emitio (para las pruebas). Nunca lanza. */
  async tick(): Promise<number> {
    if (this.running || !this.enabled || !this.google.has('correo')) return 0;
    this.running = true;
    try {
      const seen = await this.load(), account = this.google.status.account || 'cuenta';
      const list = await this.google.mail(MAIL_WATCH_QUERY, 10, true);
      // Cuenta nueva o primera vez: lo que ya estaba no es "nuevo".
      const first = seen.account !== account;
      const fresh = list.filter((m) => !seen.ids.includes(m.id));
      if (first) { this.seen = { account, ids: list.map((m) => m.id) }; await this.save(); return 0; }
      if (!fresh.length) return 0;
      seen.ids = [...fresh.map((m) => m.id), ...seen.ids].slice(0, KEEP); await this.save();
      if (fresh.length > 3) { emitNotice({ source: 'correo', title: `${fresh.length} correos nuevos`, body: fresh.slice(0, 3).map((m) => m.from).join(', '), word: 'Correo', tone: 'info', untrusted: true, ref: { kind: 'correo', id: fresh[0].id } }); return 1; }
      for (const m of [...fresh].reverse()) emitNotice({ source: 'correo', title: 'Correo nuevo', body: `${m.from}: ${m.subject}`, word: 'Correo', tone: 'info', untrusted: true, ref: { kind: 'correo', id: m.id } });
      return fresh.length;
    } catch (e) { this.log.warn(`avisos de correo: ${(e as Error).message}`); return 0; }
    finally { this.running = false; }
  }
}
