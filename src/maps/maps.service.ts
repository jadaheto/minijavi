import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import { UsageService } from '../usage/usage.service';

/**
 * Trayectos y cargadores (tercera entrega de paneles, pedida por Javier el 2026-11-20). Solo modo dueño.
 * Decisiones suyas: la ubicacion sale del navegador y, si no, la dice por voz; el mapa es una IMAGEN que pide el
 * servidor, para que la clave de Google no llegue al navegador (su clave no tiene restriccion y tiene APIs de pago).
 * Comprobado con sus claves el 2026-11-20 (y documentacion de Google leida ese dia para Embed y Routes):
 *  - Geocoding: GET maps.googleapis.com/maps/api/geocode/json?address&language&region&key -> results[0].geometry.location
 *    y formatted_address.
 *  - Routes: POST routes.googleapis.com/directions/v2:computeRoutes con X-Goog-Api-Key y X-Goog-FieldMask; con
 *    routingPreference TRAFFIC_AWARE `duration` trae el trafico y `staticDuration` no ("8180s"); se cobra como "Pro"
 *    (5.000 gratis al mes segun su tabla de precios).
 *  - Static Maps: GET maps.googleapis.com/maps/api/staticmap?size&scale&map_id&path=enc:<polilinea>&markers=...&key
 *    -> image/png (probado con y sin map_id). Su documentacion no se leyo: los parametros salen de la prueba.
 *  - Open Charge Map: GET api.openchargemap.io/v3/poi?latitude&longitude&distance&distanceunit=km&maxresults&compact=false
 *    &verbose=false, clave en la cabecera X-API-Key. Exige atribucion visible (datos CC BY 4.0) y uso moderado.
 * Los nombres de lugares y de cargadores son texto de terceros.
 */
export interface Place { lat: number; lng: number; label: string; }
export interface Route { seconds: number; staticSeconds: number; meters: number; polyline: string; }
export interface Charger { n: number; title: string; town: string; km: number; kw: number; fast: boolean; connectors: string[]; operator: string; usage: string; cost: string; operational: boolean | null; lat: number; lng: number; }

const clean = (s: unknown, max: number) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const okCoord = (lat: unknown, lng: unknown) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat as number) <= 90 && Math.abs(lng as number) <= 180;
export const validPlace = (lat: unknown, lng: unknown): boolean => okCoord(Number(lat), Number(lng)) && !(Number(lat) === 0 && Number(lng) === 0);
/** Distancia en linea recta, en km. */
export function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = (d: number) => (d * Math.PI) / 180, dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
/** Polilinea codificada de Google -> puntos, y de vuelta. Sirve para acortar una ruta larga antes de pedir la imagen. */
export function decodePolyline(enc: string): [number, number][] {
  const out: [number, number][] = []; let i = 0, lat = 0, lng = 0;
  const next = () => { let shift = 0, result = 0, b: number; do { b = enc.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i <= enc.length); return result & 1 ? ~(result >> 1) : result >> 1; };
  while (i < enc.length) { lat += next(); lng += next(); out.push([lat / 1e5, lng / 1e5]); }
  return out;
}
export function encodePolyline(points: [number, number][]): string {
  let out = '', pLat = 0, pLng = 0;
  const put = (v: number) => { let n = v < 0 ? ~(v << 1) : v << 1; while (n >= 0x20) { out += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; } out += String.fromCharCode(n + 63); };
  for (const [la, ln] of points) { const lat = Math.round(la * 1e5), lng = Math.round(ln * 1e5); put(lat - pLat); put(lng - pLng); pLat = lat; pLng = lng; }
  return out;
}
/** Deja la polilinea en un tamaño que cabe en la direccion de la imagen (quita puntos intermedios, conserva los extremos). */
export function shortenPolyline(enc: string, maxChars = 5200): string {
  if (enc.length <= maxChars) return enc;
  const pts = decodePolyline(enc);
  for (let step = 2; step < 400; step++) { const kept = pts.filter((_, i) => i % step === 0 || i === pts.length - 1), e = encodePolyline(kept); if (e.length <= maxChars) return e; }
  return encodePolyline([pts[0], pts[pts.length - 1]]);
}

@Injectable()
export class MapsService {
  private readonly log = new Logger(MapsService.name);
  private readonly images = new Map<string, { at: number; buf: Buffer }>();
  private readonly geo = new Map<string, { at: number; place: Place }>();
  private day = ''; private used = 0;

  constructor(private readonly cfg: ConfigService, private readonly usage: UsageService) {}

  /** Hay trayectos y mapa (clave de Google). */
  get enabled() { return !!this.cfg.googleMapsKey; }
  /** Hay busqueda de cargadores (clave de Open Charge Map). */
  get chargersEnabled() { return !!this.cfg.openChargeMapKey; }

  /** Tope diario propio: las APIs de Google usadas aqui son de pago pasada su cuota gratis. */
  private spend(n = 1) {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== this.day) { this.day = d; this.used = 0; }
    if (this.used + n > this.cfg.mapsDailyCalls) throw new Error('se alcanzó el tope de consultas de mapas de hoy');
    this.used += n; this.usage.add('maps_calls', n);
  }
  private async google(url: string, init?: RequestInit): Promise<Response> {
    try { return await fetch(url, { ...init, signal: AbortSignal.timeout(9000) }); }
    catch (e) { throw new Error(`no se pudo conectar con Google Maps (${(e as Error).name})`); } // sin el mensaje: podria traer la direccion con la clave
  }

  /** Un lugar dicho por voz ("Montería", "aeropuerto de Cartagena") -> coordenadas. Se prefiere Colombia. */
  async geocode(text: string): Promise<Place> {
    const q = clean(text, 120), key = q.toLowerCase();
    if (q.length < 2) throw new Error('falta el lugar');
    const hit = this.geo.get(key);
    if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.place;
    this.spend();
    const res = await this.google(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&language=es&region=co&key=${this.cfg.googleMapsKey}`);
    const d: any = await res.json().catch(() => ({}));
    const loc = d?.results?.[0]?.geometry?.location;
    if (d?.status === 'ZERO_RESULTS' || (d?.status === 'OK' && !loc)) throw new Error(`no encontré el lugar "${q}"`);
    if (!res.ok || d?.status !== 'OK' || !validPlace(loc?.lat, loc?.lng)) { this.log.warn(`geocoding: ${res.status} ${String(d?.status)}`); throw new Error(`Google Maps no pudo ubicar el lugar (${clean(d?.status ?? res.status, 30)})`); }
    const place = { lat: Number(loc.lat), lng: Number(loc.lng), label: clean(d.results[0].formatted_address, 90) || q };
    this.geo.set(key, { at: Date.now(), place });
    if (this.geo.size > 200) this.geo.delete(this.geo.keys().next().value!);
    return place;
  }

  /** Ruta en carro con el trafico de este momento. */
  async route(a: { lat: number; lng: number }, b: { lat: number; lng: number }): Promise<Route> {
    this.spend();
    const point = (p: { lat: number; lng: number }) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
    const res = await this.google('https://routes.googleapis.com/directions/v2:computeRoutes', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.cfg.googleMapsKey, 'X-Goog-FieldMask': 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline' },
      body: JSON.stringify({ origin: point(a), destination: point(b), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', languageCode: 'es', units: 'METRIC' }) });
    const d: any = await res.json().catch(() => ({}));
    const r = d?.routes?.[0], secs = (v: unknown) => Number(String(v ?? '').replace(/s$/, ''));
    if (res.ok && !r) throw new Error('no hay una ruta en carro entre esos dos puntos');
    if (!res.ok || !(secs(r.duration) > 0)) { this.log.warn(`routes: ${res.status} ${clean(d?.error?.status, 40)}`); throw new Error(`Google Maps no pudo calcular la ruta (${clean(d?.error?.status ?? res.status, 40)})`); }
    return { seconds: secs(r.duration), staticSeconds: secs(r.staticDuration) || secs(r.duration), meters: Number(r.distanceMeters) || 0, polyline: String(r.polyline?.encodedPolyline ?? '') };
  }

  /**
   * Imagen del mapa (ruta y/o puntos numerados) pedida a Google por el servidor. Devuelve una direccion propia
   * (/mapas/<codigo al azar>) que vive 20 minutos; '' si no se pudo (el panel sale sin mapa).
   */
  async mapImage(o: { polyline?: string; markers: { lat: number; lng: number; label: string; color: string }[] }): Promise<string> {
    try {
      this.spend();
      const q = new URLSearchParams({ size: '640x400', scale: '2', language: 'es' });
      if (this.cfg.googleMapsMapId) q.set('map_id', this.cfg.googleMapsMapId);
      if (o.polyline) q.append('path', `color:0x4f8dffff|weight:5|enc:${shortenPolyline(o.polyline)}`);
      for (const m of o.markers.slice(0, 12)) q.append('markers', `color:${m.color}|label:${m.label.slice(0, 1)}|${m.lat.toFixed(5)},${m.lng.toFixed(5)}`);
      q.set('key', this.cfg.googleMapsKey);
      const res = await this.google(`https://maps.googleapis.com/maps/api/staticmap?${q}`);
      const type = (res.headers.get('content-type') ?? '').split(';')[0], buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok || type !== 'image/png' || buf.length < 500 || buf.length > 6_000_000) { this.log.warn(`static map: ${res.status} ${type}`); return ''; }
      const now = Date.now();
      for (const [k, v] of this.images) if (now - v.at > 20 * 60_000) this.images.delete(k);
      if (this.images.size >= 40) this.images.delete(this.images.keys().next().value!);
      const token = randomBytes(12).toString('hex');
      this.images.set(token, { at: now, buf });
      return `/mapas/${token}.png`;
    } catch (e) { this.log.warn(`no se pudo armar el mapa: ${(e as Error).message}`); return ''; }
  }
  image(token: string): Buffer | undefined { const v = /^[a-f0-9]{24}$/.test(token) ? this.images.get(token) : undefined; return v && Date.now() - v.at < 20 * 60_000 ? v.buf : undefined; }

  /** Cargadores publicos alrededor de un punto (Open Charge Map), los mas cercanos primero. */
  async chargers(at: { lat: number; lng: number }, radiusKm: number, max = 8): Promise<Charger[]> {
    const q = new URLSearchParams({ latitude: at.lat.toFixed(5), longitude: at.lng.toFixed(5), distance: String(Math.round(radiusKm)), distanceunit: 'km', maxresults: '30', compact: 'false', verbose: 'false' });
    let res: Response;
    this.usage.add('charger_searches');
    try { res = await fetch(`https://api.openchargemap.io/v3/poi?${q}`, { headers: { 'X-API-Key': this.cfg.openChargeMapKey, 'User-Agent': 'minijavi/1.0 (asistente personal)', Accept: 'application/json' }, signal: AbortSignal.timeout(9000) }); }
    catch (e) { throw new Error(`no se pudo conectar con Open Charge Map (${(e as Error).name})`); }
    const d: any = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(d)) throw new Error(`Open Charge Map respondió ${res.status}`);
    const list = d.map((p: any) => {
      const lat = Number(p?.AddressInfo?.Latitude), lng = Number(p?.AddressInfo?.Longitude);
      if (!validPlace(lat, lng)) return undefined;
      const cons = Array.isArray(p.Connections) ? p.Connections : [];
      const kw = Math.max(0, ...cons.map((c: any) => Number(c?.PowerKW) || 0));
      return { title: clean(p.AddressInfo.Title, 70) || 'Cargador', town: clean(p.AddressInfo.Town || p.AddressInfo.StateOrProvince, 40), km: Math.round(haversine(at, { lat, lng }) * 10) / 10, kw: Math.round(kw),
        fast: cons.some((c: any) => c?.Level?.IsFastChargeCapable === true) || kw >= 40, connectors: [...new Set<string>(cons.map((c: any) => clean(c?.ConnectionType?.Title, 30)).filter(Boolean))].slice(0, 4),
        operator: clean(p.OperatorInfo?.Title, 50), usage: clean(p.UsageType?.Title, 50), cost: clean(p.UsageCost, 40), operational: typeof p.StatusType?.IsOperational === 'boolean' ? p.StatusType.IsOperational : null, lat, lng };
    }).filter((c): c is Omit<Charger, 'n'> => !!c && c.operational !== false);
    list.sort((a, b) => a.km - b.km);
    return list.slice(0, max).map((c, i) => ({ ...c, n: i + 1 }));
  }
}
