import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { UsageService } from '../usage/usage.service';

/**
 * Datos del Tesla de Javier, SOLO LECTURA y solo en modo dueño. Documentacion leida el 2026-11-19
 * (developer.tesla.com/docs/fleet-api):
 *  - Autorizar: https://auth.tesla.com/oauth2/v3/authorize (response_type=code, client_id, redirect_uri, scope, state).
 *  - Token: POST https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token (form-urlencoded; `audience` = URL base de la
 *    region). El token de refresco es DE UN SOLO USO: cada refresco entrega uno nuevo que hay que guardar; vence a los 3 meses.
 *  - Permisos pedidos: `openid offline_access vehicle_device_data`. NO se pide `vehicle_cmds`: sin el, Tesla rechaza
 *    cualquier comando (abrir, arrancar, despertar), lo pida quien lo pida. Tampoco `vehicle_location`.
 *  - Lectura: GET /api/1/vehicles; GET /api/1/vehicles/{vin}/vehicle_data (llamada en vivo; 408 si el carro no esta en
 *    linea) y /vehicle_data_cached (lo ultimo que reporto; nunca lo despierta; puede tener horas).
 *  - Se cobra por uso (todo lo que responda < 500): por eso hay cache y un tope diario propio.
 * NO documentado en las paginas leidas: los nombres de los campos de vehicle_data y sus unidades. Los que se usan aqui
 * hay que confirmarlos con una respuesta real (`fields()` deja ver que nombres llegaron, sin valores).
 */
const SCOPES = 'openid offline_access vehicle_device_data';
const META_KEY = 'tesla_auth';
const AUTH_URL = 'https://auth.tesla.com/oauth2/v3/authorize';
const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const REFRESH_DAYS = 90;
const API_HOST = /^fleet-api\.prd\.[a-z]{2}\.vn\.cloud\.tesla\.(com|cn)$/;

interface Stored { refresh: string; at: string; base: string; }
export interface TeslaVehicle { vin: string; name: string; state: string; }
export interface TeslaReport { vehicle: TeslaVehicle; live: boolean; at?: number; data: any; }

export class TeslaError extends Error { constructor(message: string, readonly status = 0) { super(message); } }

@Injectable()
export class TeslaService implements OnModuleInit {
  private readonly log = new Logger(TeslaService.name);
  private stored?: Stored;
  private access?: { token: string; until: number };
  private refreshing?: Promise<string>;
  private readonly states = new Map<string, { until: number; redirect: string }>();
  private vehiclesAt = 0; private vehicleList: TeslaVehicle[] = [];
  private readonly reports = new Map<string, { at: number; report: TeslaReport }>();
  private day = ''; private used = 0;
  private seen: Record<string, string[]> = {};
  lastError = '';

  constructor(private readonly cfg: ConfigService, private readonly db: DbService, private readonly usage: UsageService) {}

  get configured() { return !!(this.cfg.teslaClientId && this.cfg.teslaClientSecret && this.cfg.teslaRedirectUri); }
  get connected() { return this.configured && !!this.stored?.refresh; }

  async onModuleInit() {
    if (!this.configured) return;
    try {
      const raw = (await this.db.query('SELECT value FROM meta WHERE key = $1', [META_KEY]))[0]?.value;
      if (raw) this.stored = JSON.parse(String(raw));
    } catch (e) { this.log.warn(`no se pudo leer la conexión de Tesla: ${(e as Error).message}`); }
    this.log.log(`Tesla: ${this.connected ? 'cuenta conectada' : 'configurado, falta conectar la cuenta desde el panel'}`);
  }

  get status() {
    const at = this.stored?.at ? new Date(this.stored.at) : undefined;
    return { configured: this.configured, connected: this.connected, since: at?.toISOString() ?? '', expires: at ? new Date(at.getTime() + REFRESH_DAYS * 86400_000).toISOString() : '',
      vehicles: this.vehicleList.map((v) => v.name || 'Tesla'), usedToday: this.today(), dailyLimit: this.cfg.teslaDailyCalls, error: this.lastError };
  }
  /** Nombres de los campos que llegaron en la ultima respuesta (sin valores), para confirmar que el codigo lee los correctos. */
  fields() { return this.seen; }

  private today() { const d = new Date().toISOString().slice(0, 10); if (d !== this.day) { this.day = d; this.used = 0; } return this.used; }

  private async save(s: Stored | undefined) {
    this.stored = s;
    if (s) await this.db.query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [META_KEY, JSON.stringify(s)]);
    else await this.db.query('DELETE FROM meta WHERE key = $1', [META_KEY]);
  }

  authUrl(redirect = this.cfg.teslaRedirectUri): string {
    if (!this.configured) throw new Error('Tesla no está configurado');
    const now = Date.now();
    for (const [k, v] of this.states) if (v.until < now) this.states.delete(k);
    const state = randomBytes(24).toString('base64url');
    this.states.set(state, { until: now + 10 * 60_000, redirect });
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({ response_type: 'code', client_id: this.cfg.teslaClientId, redirect_uri: redirect, scope: SCOPES, state }).toString();
    return url.toString();
  }

  private async token(body: Record<string, string>): Promise<any> {
    let res: Response;
    try { res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(10_000) }); }
    catch (e) { throw new TeslaError(`no se pudo conectar con Tesla (${(e as Error).name})`); }
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok || !d.access_token) throw Object.assign(new TeslaError(`Tesla respondió ${res.status} al pedir el acceso${d.error ? ` (${String(d.error).slice(0, 60)})` : ''}`, res.status), { code: String(d.error ?? '') });
    return d;
  }

  /** Vuelta de Tesla tras autorizar. El `state` lo emitio este servidor a un dispositivo del dueño y vale una vez. */
  async finish(code: string, state: string): Promise<void> {
    const st = this.states.get(state);
    this.states.delete(state);
    if (!st || st.until < Date.now()) throw new Error('la autorización venció o no la inició este panel');
    let base = this.cfg.teslaApiUrl;
    const d = await this.token({ grant_type: 'authorization_code', client_id: this.cfg.teslaClientId, client_secret: this.cfg.teslaClientSecret, code, audience: base, redirect_uri: st.redirect });
    if (!d.refresh_token) throw new Error('Tesla no entregó el permiso para seguir conectado (falta offline_access)');
    this.access = { token: String(d.access_token), until: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
    try { // la cuenta puede vivir en otra region: Tesla dice cual es su URL base
      const r = await fetch(`${base}/api/1/users/region`, { headers: { Authorization: `Bearer ${this.access.token}` }, signal: AbortSignal.timeout(8000) });
      const u = new URL(String(((await r.json()) as any)?.response?.fleet_api_base_url ?? ''));
      if (r.ok && u.protocol === 'https:' && API_HOST.test(u.hostname)) base = u.origin;
    } catch { /* se queda con la region configurada */ }
    await this.save({ refresh: String(d.refresh_token), at: new Date().toISOString(), base });
    this.lastError = ''; this.vehiclesAt = 0; this.reports.clear();
    this.log.log(`Tesla: cuenta conectada (${new URL(base).hostname})`);
  }

  async disconnect() { this.access = undefined; this.vehicleList = []; this.vehiclesAt = 0; this.reports.clear(); await this.save(undefined); this.log.log('Tesla: cuenta desconectada'); }

  private async accessToken(): Promise<string> {
    if (!this.connected) throw new TeslaError('Tesla no está conectado: se conecta en el panel, pestaña Dispositivos');
    if (this.access && this.access.until - Date.now() > 60_000) return this.access.token;
    this.refreshing ??= (async () => {
      try {
        const d = await this.token({ grant_type: 'refresh_token', client_id: this.cfg.teslaClientId, refresh_token: this.stored!.refresh });
        // El token de refresco es de un solo uso: el nuevo se guarda ANTES de usar el acceso; si se perdiera, habria que reconectar.
        if (d.refresh_token) await this.save({ ...this.stored!, refresh: String(d.refresh_token) });
        this.access = { token: String(d.access_token), until: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
        this.lastError = '';
        return this.access.token;
      } catch (e) {
        const code = String((e as any).code ?? '');
        if (code === 'login_required' || code === 'invalid_grant' || (e as TeslaError).status === 401) {
          await this.save(undefined).catch(() => undefined); this.access = undefined;
          this.lastError = 'La conexión con Tesla venció o fue revocada: hay que volver a conectar la cuenta en el panel.';
          throw new TeslaError('la conexión con Tesla venció; hay que volver a conectarla en el panel');
        }
        this.lastError = (e as Error).message;
        throw e;
      } finally { this.refreshing = undefined; }
    })();
    return this.refreshing;
  }

  /** Una lectura de la API (solo GET: esta clase no tiene como enviar comandos). Cuenta para el tope diario. */
  private async get(path: string): Promise<any> {
    if (this.today() >= this.cfg.teslaDailyCalls) throw new TeslaError('se alcanzó el tope de consultas al Tesla de hoy');
    const token = await this.accessToken();
    this.used++; this.usage.add('tesla_calls');
    let res: Response;
    try { res = await fetch(`${this.stored!.base}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) }); }
    catch (e) { throw new TeslaError(`no se pudo conectar con Tesla (${(e as Error).name})`); }
    const d: any = await res.json().catch(() => ({}));
    if (res.ok) return d.response;
    const detail = String(d.error ?? '').replace(/\s+/g, ' ').slice(0, 120);
    if (res.status === 401) this.access = undefined;
    const why: Record<number, string> = {
      401: 'Tesla no aceptó el acceso (puede estar apagado el acceso remoto del carro)', 402: 'la cuenta de desarrollador de Tesla no tiene un medio de pago o superó su límite',
      403: 'la autorización no incluye ese dato', 408: 'el carro está dormido o sin conexión', 412: 'la aplicación de Tesla no está registrada en esta región',
      421: 'la cuenta está en otra región de Tesla', 429: 'Tesla pidió esperar por exceso de consultas',
    };
    this.log.warn(`Tesla respondió ${res.status} en ${path.replace(/[A-HJ-NPR-Z0-9]{17}/, '<vin>')}: ${detail}`);
    throw new TeslaError(why[res.status] ?? `Tesla respondió ${res.status}`, res.status);
  }

  async vehicles(maxAgeMs = 60_000): Promise<TeslaVehicle[]> {
    if (Date.now() - this.vehiclesAt < maxAgeMs) return this.vehicleList;
    const list = await this.get('/api/1/vehicles');
    this.vehicleList = (Array.isArray(list) ? list : []).filter((v: any) => typeof v?.vin === 'string' && /^[A-HJ-NPR-Z0-9]{17}$/.test(v.vin))
      .map((v: any) => ({ vin: v.vin, name: String(v.display_name ?? '').replace(/\s+/g, ' ').slice(0, 40), state: String(v.state ?? '').toLowerCase() }));
    this.vehiclesAt = Date.now();
    return this.vehicleList;
  }

  /**
   * Estado del carro sin despertarlo: si esta en linea se le pregunta en vivo; si no (o si no contesta), se usa lo
   * ultimo que reporto a Tesla. `which` elige por nombre cuando hay varios.
   */
  async report(which = ''): Promise<TeslaReport> {
    const all = await this.vehicles();
    if (!all.length) throw new TeslaError('la cuenta de Tesla no tiene vehículos');
    const key = which.trim().toLowerCase(), vehicle = (key && all.find((v) => v.name.toLowerCase().includes(key))) || all[0];
    const hit = this.reports.get(vehicle.vin);
    if (hit && Date.now() - hit.at < 60_000) return hit.report;
    let report: TeslaReport | undefined;
    if (vehicle.state === 'online') {
      try { report = { vehicle, live: true, data: await this.get(`/api/1/vehicles/${vehicle.vin}/vehicle_data`) }; }
      catch (e) { if (![408, 503, 540].includes((e as TeslaError).status)) throw e; } // no contesto: se usa lo guardado
    }
    report ??= { vehicle, live: false, data: await this.get(`/api/1/vehicles/${vehicle.vin}/vehicle_data_cached`).catch((e) => { if ((e as TeslaError).status === 404) throw new TeslaError('el carro está dormido y Tesla no tiene datos guardados de él'); throw e; }) };
    const d = report.data ?? {};
    report.at = Math.max(0, ...['charge_state', 'vehicle_state', 'climate_state'].map((b) => Number(d[b]?.timestamp) || 0)) || undefined;
    this.seen = Object.fromEntries(Object.entries(d).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v)).map(([k, v]) => [k, Object.keys(v as object).sort()]));
    this.reports.set(vehicle.vin, { at: Date.now(), report });
    return report;
  }
}

const MI_KM = 1.609344;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * El informe en frases para el modelo. Solo dice lo que vino: un campo ausente se omite, no se inventa.
 * Tesla entrega distancias en millas (NO confirmado en la documentacion leida): se pasan a kilometros.
 */
export function describeTesla(r: TeslaReport, timezone: string): string {
  const d = r.data ?? {}, c = d.charge_state ?? {}, v = d.vehicle_state ?? {}, k = d.climate_state ?? {};
  const out: string[] = [];
  const name = r.vehicle.name || 'el Tesla';
  if (r.live) out.push(`Datos en vivo de ${name}.`);
  else {
    const age = r.at ? Math.round((Date.now() - r.at) / 60_000) : undefined;
    out.push(`${name} está dormido o sin conexión; estos son los últimos datos que reportó${age === undefined ? ' (sin fecha)' : age < 90 ? ` hace ${age} minutos` : ` hace ${Math.round(age / 60)} horas`}${r.at ? ` (${new Intl.DateTimeFormat('es-CO', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(r.at))})` : ''}. Dile a Javier que no son de este momento.`);
  }
  const level = num(c.battery_level), range = num(c.battery_range), limit = num(c.charge_limit_soc);
  if (level !== undefined) out.push(`Batería: ${level} %${range !== undefined ? `, unos ${Math.round(range * MI_KM)} km de autonomía` : ''}${limit !== undefined ? ` (límite de carga ${limit} %)` : ''}.`);
  const charging = typeof c.charging_state === 'string' ? c.charging_state : '';
  if (charging) {
    const state: Record<string, string> = { Charging: 'cargando', Complete: 'carga completa', Disconnected: 'desconectado del cargador', Stopped: 'conectado pero sin cargar', NoPower: 'conectado sin energía' };
    const left = num(c.time_to_full_charge), power = num(c.charger_power);
    out.push(`Carga: ${state[charging] ?? charging}${charging === 'Charging' && left ? `, faltan ${left >= 1 ? `${Math.floor(left)} h ${Math.round((left % 1) * 60)} min` : `${Math.round(left * 60)} min`}` : ''}${charging === 'Charging' && power ? ` a ${power} kW` : ''}.`);
  }
  if (typeof v.locked === 'boolean') {
    const open = (['df', 'dr', 'pf', 'pr'] as const).filter((x) => num(v[x])).length, trunks = (['ft', 'rt'] as const).filter((x) => num(v[x])).length;
    const windows = (['fd_window', 'fp_window', 'rd_window', 'rp_window'] as const).filter((x) => num(v[x])).length;
    out.push(`Seguros: ${v.locked ? 'puestos' : 'SIN poner'}${open ? `; ${open} puerta(s) abierta(s)` : ''}${trunks ? '; un baúl abierto' : ''}${windows ? `; ${windows} ventana(s) abierta(s)` : ''}${typeof v.sentry_mode === 'boolean' ? `; modo centinela ${v.sentry_mode ? 'encendido' : 'apagado'}` : ''}.`);
  }
  const inside = num(k.inside_temp), outside = num(k.outside_temp);
  if (inside !== undefined || outside !== undefined || typeof k.is_climate_on === 'boolean')
    out.push(`Clima: ${[inside !== undefined ? `adentro ${Math.round(inside)} °C` : '', outside !== undefined ? `afuera ${Math.round(outside)} °C` : '', typeof k.is_climate_on === 'boolean' ? `aire ${k.is_climate_on ? 'encendido' : 'apagado'}` : ''].filter(Boolean).join(', ')}.`);
  const odo = num(v.odometer);
  if (odo !== undefined) out.push(`Kilometraje: ${Math.round(odo * MI_KM).toLocaleString('es-CO')} km.`);
  if (typeof v.car_version === 'string' && v.car_version) out.push(`Software: ${v.car_version.split(' ')[0]}.`);
  if (out.length === 1) out.push('Tesla respondió, pero sin los datos esperados (batería, seguros, clima).');
  return out.join('\n');
}

export type TeslaFocus = 'bateria' | 'carga' | 'seguridad' | 'clima' | 'todo';
/** Los mismos datos, en cifras, para el panel animado del navegador. Solo lleva lo que vino; nada de identificadores del carro. */
export function teslaCard(r: TeslaReport, focus: TeslaFocus = 'todo'): Record<string, unknown> {
  const d = r.data ?? {}, c = d.charge_state ?? {}, v = d.vehicle_state ?? {}, k = d.climate_state ?? {};
  const range = num(c.battery_range), odo = num(v.odometer), left = num(c.time_to_full_charge);
  const open = (keys: string[]) => (keys.some((x) => num(v[x]) !== undefined) ? keys.map((x) => !!num(v[x])) : undefined);
  return {
    focus, name: r.vehicle.name || 'Tesla', live: r.live, ageMin: !r.live && r.at ? Math.max(0, Math.round((Date.now() - r.at) / 60_000)) : undefined,
    level: num(c.battery_level), rangeKm: range === undefined ? undefined : Math.round(range * MI_KM), limit: num(c.charge_limit_soc),
    charging: typeof c.charging_state === 'string' ? c.charging_state : undefined, minutesLeft: left ? Math.round(left * 60) : undefined, kw: num(c.charger_power) || undefined,
    locked: typeof v.locked === 'boolean' ? v.locked : undefined, doors: open(['df', 'pf', 'dr', 'pr']), trunks: open(['ft', 'rt']), windows: open(['fd_window', 'fp_window', 'rd_window', 'rp_window']),
    sentry: typeof v.sentry_mode === 'boolean' ? v.sentry_mode : undefined,
    inside: num(k.inside_temp), outside: num(k.outside_temp), climateOn: typeof k.is_climate_on === 'boolean' ? k.is_climate_on : undefined,
    odoKm: odo === undefined ? undefined : Math.round(odo * MI_KM), version: typeof v.car_version === 'string' ? v.car_version.split(' ')[0].slice(0, 20) : undefined,
  };
}
