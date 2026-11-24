/**
 * Conexiones, etapa A2b: entrar a una aplicacion con la cuenta de Javier (OAuth 2.1 de MCP) en vez de pegar una clave.
 *
 * El flujo lo lleva el SDK oficial `@modelcontextprotocol/client` 2.4.0 (`auth()`, leido el 2026-11-24 en sus tipos):
 * descubre el servidor de autorizacion del conector (RFC 9728 y RFC 8414), arma la direccion de autorizacion con PKCE y
 * el parametro `resource`, cambia el codigo por los permisos, valida el emisor al volver y renueva cuando vencen. Aqui
 * solo se le da DONDE guardar: un `OAuthClientProvider` cuyo estado vive entero en un texto cifrado de la boveda.
 *
 * Como se identifica minijavi ante cada aplicacion (decidido con Javier el 2026-11-24), en este orden:
 *   1. Identificador (y secreto) que Javier creo en la consola de la aplicacion y pego en el panel.
 *   2. Documento publico de cliente (`/api/conexiones/cliente.json`), si el servidor lo admite y PUBLIC_URL es https.
 *   3. Registro automatico del cliente, si el servidor lo ofrece (el protocolo lo marca como obsoleto, pero hoy es lo
 *      que traen muchos conectores).
 *
 * Lo que este archivo NO hace: decidir que puede ejecutarse. Eso sigue en `ConnectionsService.call()`: con OAuth o con
 * clave, toda herramienta nace bloqueada y solo corre la que Javier confirmo como lectura.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Todo lo de una conexion por OAuth. Se guarda cifrado en `connections.secret`; nada de esto sale del servidor. */
export interface OAuthBlob {
  /** Cliente creado a mano por Javier en la consola de la aplicacion. */
  pre?: { id: string; secret?: string };
  /** Cliente que registro el SDK (registro automatico) o el que resolvio por el documento publico. */
  client?: Record<string, unknown>;
  tokens?: Record<string, unknown>;
  verifier?: string;
  discovery?: Record<string, unknown>;
  /** Permisos que Javier pidio a mano ('' = los que proponga el servidor). */
  scope?: string;
  /** Vuelta pendiente: valor al azar de un solo uso y cuando se emitio. */
  state?: string; stateAt?: number;
  /** Ya se aviso que hay que volver a conectar (para no repetir la alerta). */
  warned?: boolean;
}

export const OAUTH_STATE_MS = 10 * 60_000;
export const newState = () => randomBytes(24).toString('hex');
export function sameState(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Lo que minijavi declara de si mismo. Es lo mismo que publica `/api/conexiones/cliente.json`. */
export function clientMetadata(redirect: string, publicUrl: string, confidential = false): Record<string, unknown> {
  return {
    client_name: 'minijavi', ...(publicUrl.startsWith('https://') ? { client_uri: publicUrl } : {}), redirect_uris: [redirect],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...(confidential ? {} : { token_endpoint_auth_method: 'none' }),
  };
}

/** Hay que volver a pasar por la pagina de la aplicacion (los permisos vencieron o se revocaron) y no hay nadie para hacerlo. */
export class NeedsLogin extends Error { constructor() { super('hay que volver a conectar la cuenta'); this.name = 'NeedsLogin'; } }

/**
 * El almacen que usa el SDK. `interactive`: solo al conectar desde el panel se acepta una redireccion (se captura en
 * `authorizeUrl` para devolversela al panel). En el uso normal una redireccion significa que hay que reconectar: se
 * marca `needsLogin` y se corta, porque nadie esta mirando una pantalla.
 */
export class StoredProvider {
  authorizeUrl?: URL;
  needsLogin = false;
  constructor(private readonly blob: OAuthBlob, private readonly save: (b: OAuthBlob) => Promise<void>, private readonly o: { redirect: string; publicUrl: string; interactive: boolean }) {}

  get redirectUrl() { return this.o.redirect; }
  /** Documento publico de cliente: solo sin cliente a mano y con direccion publica https (lo exige el protocolo). */
  get clientMetadataUrl(): string | undefined { return !this.blob.pre && this.o.publicUrl.startsWith('https://') ? `${this.o.publicUrl}/api/conexiones/cliente.json` : undefined; }
  get clientMetadata() { return clientMetadata(this.o.redirect, this.o.publicUrl, !!this.blob.pre?.secret); }
  state() { return this.blob.state ?? ''; }
  clientInformation() { return this.blob.pre ? { client_id: this.blob.pre.id, ...(this.blob.pre.secret ? { client_secret: this.blob.pre.secret } : {}) } : this.blob.client; }
  async saveClientInformation(info: Record<string, unknown>) { if (this.blob.pre) return; this.blob.client = info; await this.save(this.blob); }
  tokens() { return this.blob.tokens; }
  async saveTokens(tokens: Record<string, unknown>) { this.blob.tokens = tokens; this.blob.warned = false; await this.save(this.blob); }
  redirectToAuthorization(url: URL) { if (!this.o.interactive) { this.needsLogin = true; throw new NeedsLogin(); } this.authorizeUrl = url; }
  async saveCodeVerifier(v: string) { this.blob.verifier = v; await this.save(this.blob); }
  codeVerifier() { if (!this.blob.verifier) throw new Error('no hay una autorización en curso'); return this.blob.verifier; }
  async saveDiscoveryState(s: Record<string, unknown>) { this.blob.discovery = s; await this.save(this.blob); }
  discoveryState() { return this.blob.discovery; }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'tokens') this.blob.tokens = undefined;
    if ((scope === 'all' || scope === 'client') && !this.blob.pre) this.blob.client = undefined; // el cliente creado a mano no se borra solo
    if (scope === 'all' || scope === 'verifier') this.blob.verifier = undefined;
    if (scope === 'all' || scope === 'discovery') this.blob.discovery = undefined;
    await this.save(this.blob);
  }
}

/** En que va una conexion por OAuth, para el panel. */
export function oauthStatus(b: OAuthBlob): 'conectada' | 'sin_autorizar' | 'reconectar' {
  if (b.warned) return 'reconectar';
  return b.tokens && typeof (b.tokens as { access_token?: unknown }).access_token === 'string' ? 'conectada' : 'sin_autorizar';
}

/** Los permisos que se van a pedir, sacados de la direccion de autorizacion (para mostrarlos antes de salir). */
export const scopesOf = (url: URL): string[] => (url.searchParams.get('scope') ?? '').split(/\s+/).filter(Boolean).slice(0, 40).map((s) => s.slice(0, 120));

/** La direccion a la que se manda a Javier debe ser https (http solo hacia esta misma maquina, en pruebas). */
export function safeAuthorizeUrl(url: URL | undefined): string | undefined {
  if (!url) return undefined;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return url.protocol === 'https:' || (url.protocol === 'http:' && local) ? url.toString() : undefined;
}

export const runAuth = (provider: StoredProvider, options: { serverUrl: string; scope?: string; authorizationCode?: string; iss?: string }): Promise<'AUTHORIZED' | 'REDIRECT'> =>
  (require('@modelcontextprotocol/client') as { auth: (p: unknown, o: unknown) => Promise<'AUTHORIZED' | 'REDIRECT'> }).auth(provider, options);
