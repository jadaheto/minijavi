import { existsSync, readFileSync } from 'node:fs';

/**
 * "Modo negocio" (paquete para clientes, pedido por Javier el 2026-11-21): el MISMO motor de minijavi arranca como el
 * asistente de UN negocio. Cada cliente es un servicio aparte (su base, su dominio, su numero) con un archivo de
 * configuracion. En este modo no existe nada de Javier: ni modo dueño, ni taller, ni sus herramientas.
 */
export const AVATARS = ['hombre', 'mujer', 'joven', 'mayor', 'perro', 'gato', 'loro'] as const;
export type AvatarId = (typeof AVATARS)[number];
export interface BusinessConfig {
  nombre: string;
  /** Saludo del asistente al empezar (una frase). */
  saludo: string;
  /** Como habla: una o dos frases. */
  personalidad: string;
  /** Color principal de la marca (#rrggbb). */
  color: string;
  /** Avatar del catalogo. */
  avatar: AvatarId;
  /** Voz de ElevenLabs de este asistente (la elige Javier). Vacia = la voz por defecto del servidor. */
  voz: string;
  /** Hasta 3 preguntas sugeridas que se muestran en la pagina. */
  preguntas: string[];
  /** Nombre con el que se presenta el asistente (opcional; si falta: "el asistente virtual de <nombre>"). */
  asistente: string;
}

const txt = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Lee y valida el archivo del negocio. Lanza un error claro si falta o esta mal: el servicio no debe arrancar a medias. */
export function loadBusiness(file: string): BusinessConfig {
  if (!existsSync(file)) throw new Error(`MODO=negocio: falta el archivo del negocio (${file}). Copia clientes/ejemplo/negocio.json y complétalo.`);
  let j: any; try { j = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`MODO=negocio: ${file} no es un JSON válido (${(e as Error).message})`); }
  const nombre = txt(j.nombre, 80);
  if (nombre.length < 2) throw new Error(`MODO=negocio: en ${file} falta "nombre" (el nombre del negocio)`);
  const voz = txt(j.voz, 40);
  if (voz && !/^[A-Za-z0-9]{10,40}$/.test(voz)) throw new Error(`MODO=negocio: "voz" debe ser el id de una voz de ElevenLabs (letras y números)`);
  const avatar = AVATARS.includes(j.avatar) ? (j.avatar as AvatarId) : 'hombre';
  return {
    nombre, voz, avatar,
    saludo: txt(j.saludo, 200) || `¡Hola! Soy el asistente virtual de ${nombre}. ¿En qué te puedo ayudar?`,
    personalidad: txt(j.personalidad, 300) || 'Amable, breve y claro.',
    color: /^#[0-9a-f]{6}$/i.test(String(j.color)) ? String(j.color).toLowerCase() : '#3987e5',
    preguntas: (Array.isArray(j.preguntas) ? j.preguntas : []).map((q: unknown) => txt(q, 90)).filter((q: string) => q.length > 4).slice(0, 3),
    asistente: txt(j.asistente, 40),
  };
}
