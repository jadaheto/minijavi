/**
 * Avisos: de dónde salen.
 *
 * Cualquier parte del servidor que tenga algo que contarle a Javier (interesado nuevo, solicitud por aprobar, pago por
 * revisar, taller terminado, servicio caído; más adelante, correo y calendario por conexiones) lo emite aquí con
 * `emitNotice`. No sabe quién lo recibe: el centro de avisos (NoticesService) lo guarda y lo reparte.
 */
import { EventEmitter } from 'node:events';

export interface NoticeInput {
  /** De dónde viene: interesados | aprobaciones | avatares | taller | servicios | correo | calendario… */
  source: string;
  /** Qué pasó, en pocas palabras ("Interesado nuevo"). */
  title: string;
  /** El detalle, corto (nombre, asunto…). */
  body?: string;
  /** Palabra grande de la tarjeta ("Nuevo", "Aprobar", "Pago", "Listo", "Falla"). */
  word?: string;
  tone?: 'ok' | 'warn' | 'bad' | 'info';
  /**
   * `body` lo escribió alguien de fuera (el nombre que dictó un visitante, el asunto de un correo): se MUESTRA como dato,
   * nunca se ejecuta, y si el avatar lo cuenta en voz va marcado como texto de terceros.
   */
  untrusted?: boolean;
  /** A qué se refiere (para poder actuar después): por ejemplo { kind: 'aprobacion', id: 12 }. */
  ref?: { kind: string; id: number | string };
}

const bus = new EventEmitter();
bus.setMaxListeners(20);

/** Nunca lanza: un aviso que falla no puede tumbar lo que lo originó. */
export function emitNotice(n: NoticeInput): void { try { bus.emit('notice', n); } catch { /* sin centro de avisos: no pasa nada */ } }
export function onNotice(fn: (n: NoticeInput) => void): () => void { bus.on('notice', fn); return () => bus.off('notice', fn); }
