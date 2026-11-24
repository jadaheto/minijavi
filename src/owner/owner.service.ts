import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';

export interface Device { id: string; name: string; createdAt: string; lastSeen: string; }

/** Los dispositivos de bolsillo (placas con pantalla pequeña) se distinguen por su identificador. */
export const GADGET_PREFIX = 'b-';
export const isGadget = (id: string) => id.startsWith(GADGET_PREFIX);

export const OWNER_COOKIE = 'minijavi_owner';

/**
 * Modo dueño: solo los dispositivos registrados con la clave OWNER_SECRET pueden usar las herramientas privadas.
 * Cada dispositivo recibe un pase firmado (cookie HttpOnly) que el servidor valida contra la lista de dispositivos,
 * asi se puede revocar uno sin cambiar la clave. Si OWNER_SECRET esta vacio, el modo dueño queda desactivado.
 */
@Injectable()
export class OwnerService implements OnModuleInit {
  private readonly log = new Logger(OwnerService.name);
  private readonly key: Buffer;
  private devices: Device[] = [];
  private readonly fails = new Map<string, { count: number; until: number }>();
  private recent: number[] = [];
  readonly enabled: boolean;

  constructor(private readonly cfg: ConfigService, private readonly db: DbService) {
    this.enabled = cfg.ownerSecret.length >= 16;
    if (cfg.ownerSecret && !this.enabled) this.log.warn('OWNER_SECRET tiene menos de 16 caracteres: el modo dueño queda desactivado');
    this.key = createHash('sha256').update(`minijavi-owner:${cfg.ownerSecret}`).digest();
  }

  /** La lista de dispositivos se carga de la base al arrancar y se mantiene en memoria (se consulta en cada peticion). */
  async onModuleInit() {
    const rows = await this.db.query<{ id: string; name: string; created_at: string; last_seen: string }>('SELECT id, name, created_at, last_seen FROM devices ORDER BY created_at');
    this.devices = rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastSeen: r.last_seen }));
    // El ultimo uso cambia en cada peticion: se guarda cada cierto tiempo, no cada vez.
    setInterval(() => { for (const d of this.devices) if (d.lastSeen !== this.savedSeen.get(d.id)) this.store(d); }, 60_000).unref();
  }
  private readonly savedSeen = new Map<string, string>();
  private store(d: Device) {
    this.savedSeen.set(d.id, d.lastSeen);
    void this.db.query('INSERT INTO devices (id, name, created_at, last_seen) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen', [d.id, d.name, d.createdAt, d.lastSeen])
      .catch((e) => this.log.error(`No se pudo guardar el dispositivo: ${(e as Error).message}`));
  }

  private sign(payload: string) { return createHmac('sha256', this.key).update(payload).digest('base64url'); }

  /** Segundos que debe esperar esta IP antes de volver a intentar (0 = puede intentar). */
  blockedFor(ip: string): number {
    const f = this.fails.get(ip);
    return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
  }

  /** Registra un dispositivo si la clave es correcta. Devuelve el pase o null. */
  register(secret: string, name: string, ip: string): { token: string; device: Device } | null {
    if (!this.enabled || this.blockedFor(ip)) return null;
    // Tope global: aunque cambien de direccion, no mas de 20 intentos fallidos cada 15 minutos.
    const now0 = Date.now(); this.recent = this.recent.filter((t) => now0 - t < 15 * 60_000);
    if (this.recent.length >= 20) return null;
    const a = createHash('sha256').update(secret).digest(), b = createHash('sha256').update(this.cfg.ownerSecret).digest();
    if (!timingSafeEqual(a, b)) {
      this.recent.push(Date.now());
      const f = this.fails.get(ip) ?? { count: 0, until: 0 };
      f.count++; if (f.count >= 5) { f.until = Date.now() + 15 * 60_000; f.count = 0; }
      this.fails.set(ip, f);
      this.log.warn(`intento fallido de registro de dispositivo desde ${ip}`);
      return null;
    }
    this.fails.delete(ip);
    const now = new Date().toISOString();
    const device: Device = { id: randomBytes(12).toString('hex'), name: (name || 'Dispositivo').slice(0, 60), createdAt: now, lastSeen: now };
    this.devices.push(device); this.store(device);
    const exp = Date.now() + this.cfg.ownerDays * 86_400_000;
    const payload = `${device.id}.${exp}`;
    this.log.log(`dispositivo registrado: ${device.name}`);
    return { token: `${payload}.${this.sign(payload)}`, device };
  }

  /** Valida el pase de una peticion (cabecera Cookie). Devuelve el dispositivo o null. */
  verify(cookieHeader: string | undefined): Device | null {
    if (!this.enabled || !cookieHeader) return null;
    const m = cookieHeader.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${OWNER_COOKIE}=`));
    if (!m) return null;
    const [id, exp, sig] = decodeURIComponent(m.slice(OWNER_COOKIE.length + 1)).split('.');
    if (!id || !exp || !sig) return null;
    const good = Buffer.from(this.sign(`${id}.${exp}`)), got = Buffer.from(sig);
    if (good.length !== got.length || !timingSafeEqual(good, got) || Number(exp) < Date.now()) return null;
    const device = this.devices.find((d) => d.id === id);
    if (!device) return null; // revocado
    device.lastSeen = new Date().toISOString();
    return device;
  }

  /**
   * Pase para un "Javi de bolsillo" (una placa sin navegador): lo crea Javier desde el panel y se graba en la placa.
   * Va firmado con otro prefijo, así que NO sirve como cookie: abre conversaciones de voz en modo dueño, nunca el panel.
   * Vence a los `BOLSILLO_DIAS` (0 = no vence) y se revoca como cualquier dispositivo.
   */
  issueGadget(name: string): { token: string; device: Device; expires: string | null } | null {
    if (!this.enabled) return null;
    const now = new Date().toISOString();
    const device: Device = { id: GADGET_PREFIX + randomBytes(12).toString('hex'), name: (name || 'Javi de bolsillo').slice(0, 60), createdAt: now, lastSeen: now };
    this.devices.push(device); this.store(device);
    const exp = this.cfg.gadgetDays ? Date.now() + this.cfg.gadgetDays * 86_400_000 : 0;
    const payload = `${device.id}.${exp}`;
    this.log.log(`dispositivo de bolsillo creado: ${device.name}`);
    return { token: `mjb.${payload}.${this.sign(`bolsillo:${payload}`)}`, device, expires: exp ? new Date(exp).toISOString() : null };
  }

  /** Valida el pase que manda la placa al abrir la conversación. Los intentos fallidos cuentan como los de la clave. */
  verifyGadget(token: unknown, ip: string): Device | null {
    if (!this.enabled || typeof token !== 'string' || token.length > 200 || this.blockedFor(ip)) return null;
    const now = Date.now(); this.recent = this.recent.filter((t) => now - t < 15 * 60_000);
    if (this.recent.length >= 20) return null;
    const [tag, id, exp, sig] = token.split('.');
    let device: Device | undefined;
    if (tag === 'mjb' && id && exp && sig && isGadget(id) && /^\d+$/.test(exp)) {
      const good = Buffer.from(this.sign(`bolsillo:${id}.${exp}`)), got = Buffer.from(sig);
      if (good.length === got.length && timingSafeEqual(good, got) && (exp === '0' || Number(exp) > now)) device = this.devices.find((d) => d.id === id); // si no está, fue revocado
    }
    if (!device) {
      this.recent.push(now);
      const f = this.fails.get(ip) ?? { count: 0, until: 0 };
      f.count++; if (f.count >= 5) { f.until = now + 15 * 60_000; f.count = 0; }
      this.fails.set(ip, f);
      this.log.warn(`pase de dispositivo de bolsillo rechazado desde ${ip}`);
      return null;
    }
    device.lastSeen = new Date().toISOString();
    return device;
  }

  list(): Device[] { return this.devices; }
  revoke(id: string): boolean {
    const n = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length !== n) {
      void this.db.query('DELETE FROM devices WHERE id = $1', [id]).catch((e) => this.log.error(`No se pudo borrar el dispositivo: ${(e as Error).message}`));
      return true;
    }
    return false;
  }
  get maxAgeSeconds() { return this.cfg.ownerDays * 86_400; }
}
