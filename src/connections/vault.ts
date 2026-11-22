import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Boveda de las conexiones (etapa A, aprobada por Javier el 2026-11-22): los tokens de las aplicaciones conectadas se
 * guardan CIFRADOS en la base (AES-256-GCM). La clave maestra sale de `VAULT_KEY`, que vive solo en el entorno: quien
 * tenga una copia de la base (un respaldo, por ejemplo) no puede leer los tokens sin ella.
 *  - Cada valor lleva su propio vector al azar y su sello de autenticidad: un valor alterado no se descifra.
 *  - Sin `VAULT_KEY` (minimo 32 caracteres) no hay boveda y las conexiones quedan apagadas.
 *  - Cambiar `VAULT_KEY` deja ilegibles los tokens guardados: hay que volver a escribirlos en el panel.
 */
export class Vault {
  private readonly key?: Buffer;
  constructor(secret: string) { if (secret.length >= 32) this.key = scryptSync(secret, 'minijavi-conexiones-v1', 32); }
  get ready() { return !!this.key; }

  seal(plain: string): string {
    if (!this.key) throw new Error('la bóveda no está configurada');
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
  }
  /** Devuelve el texto original, o lanza si el valor fue alterado o se cifro con otra clave. Nunca devuelve basura. */
  open(sealed: string): string {
    if (!this.key) throw new Error('la bóveda no está configurada');
    const [v, iv, tag, body] = String(sealed).split('.');
    if (v !== 'v1' || !iv || !tag || body === undefined) throw new Error('valor de la bóveda con formato desconocido');
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url')); d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
    } catch { throw new Error('no se pudo abrir el valor de la bóveda (¿cambió VAULT_KEY?)'); }
  }
}
