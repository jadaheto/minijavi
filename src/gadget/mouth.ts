/**
 * Javi de bolsillo: bocas calculadas en el servidor.
 *
 * El navegador recibe los caracteres con su tiempo y calcula la boca en cada cuadro (public/js/lipsync.js). Una placa
 * pequeña no debe hacer esa cuenta: recibe ya la lista "en el milisegundo T, muestra el recorte X". Este archivo es la
 * MISMA cuenta del navegador (misma tabla de sonidos, mismo suavizado, mismos umbrales de public/js/cara2d.js) corrida
 * aquí a pasos fijos. La verificación compara las dos para que no se separen.
 */
const VISEMES = ['viseme_PP', 'viseme_FF', 'viseme_DD', 'viseme_aa', 'viseme_E', 'viseme_I', 'viseme_O', 'viseme_U'] as const;
type Viseme = (typeof VISEMES)[number];
const STRENGTH: Record<Viseme, number> = { viseme_aa: 0.85, viseme_E: 0.7, viseme_I: 0.6, viseme_O: 0.75, viseme_U: 0.7, viseme_PP: 0.9, viseme_FF: 0.8, viseme_DD: 0.45 };
const SHORT: Record<Viseme, string> = { viseme_aa: 'a', viseme_E: 'e', viseme_I: 'i', viseme_O: 'o', viseme_U: 'u', viseme_PP: 'p', viseme_FF: 'f', viseme_DD: 'd' };
const PLAIN: Record<string, string> = { 'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u', 'ü': 'ü', 'ñ': 'ñ' };
const VOWEL: Record<string, Viseme> = { a: 'viseme_aa', e: 'viseme_E', i: 'viseme_I', y: 'viseme_I', o: 'viseme_O', u: 'viseme_U', 'ü': 'viseme_U' };
const norm = (c?: string) => { c = (c || '').toLowerCase(); return PLAIN[c] ?? c; };
const isLetter = (c: string) => /[a-zñü0-9]/.test(c);

/** Sonido de chars[i]: un visema, 'rest' (boca en reposo) o null (letra muda: sigue la forma anterior). */
export function visemeFor(chars: string[], i: number): Viseme | 'rest' | null {
  const c = norm(chars[i]), prev = norm(chars[i - 1]), next = norm(chars[i + 1]);
  if (!isLetter(c)) return 'rest';
  if (c === 'h') return null;
  if (c === 'u' && (prev === 'q' || (prev === 'g' && (next === 'e' || next === 'i')))) return null;
  if (VOWEL[c]) return VOWEL[c];
  if ('pbmv'.includes(c)) return 'viseme_PP';
  if (c === 'f') return 'viseme_FF';
  return 'viseme_DD';
}

/** Recorte de boca para unos pesos: el sonido que más pesa, a medias (1) o completo (2); '-' = boca quieta. */
export function mouthFrame(weights: Record<string, number>): string {
  let best: Viseme | '' = '', k = 0;
  for (const v of VISEMES) { const r = (weights[v] || 0) / STRENGTH[v]; if (r > k) { k = r; best = v; } }
  if (!best || k < 0.22) return '-';
  return `${SHORT[best]}${k > 0.62 ? 2 : 1}`;
}

export const MOUTH_STEP_MS = 20;
export type MouthKey = [ms: number, frame: string];

/** Bocas de UNA respuesta. Los tiempos son segundos desde el inicio del audio de esa respuesta (como los del navegador). */
export class MouthTrack {
  private events: { t0: number; t1: number; v: Viseme | 'rest' }[] = [];
  private cursor = 0;
  private readonly weights: Record<string, number> = Object.fromEntries(VISEMES.map((v) => [v, 0]));
  private ms = 0;      // hasta dónde va la cuenta
  private last = '-';

  /** Agrega un tramo de caracteres con sus tiempos y devuelve los cambios de boca hasta el final de ese tramo. */
  add(chars: string[], starts: number[], ends: number[]): MouthKey[] {
    let end = 0;
    for (let i = 0; i < chars.length; i++) {
      const v = visemeFor(chars, i);
      if (Number.isFinite(ends[i])) end = Math.max(end, ends[i]);
      if (v === null || !Number.isFinite(starts[i]) || !Number.isFinite(ends[i])) continue;
      this.events.push({ t0: starts[i], t1: ends[i], v });
    }
    return this.run(end * 1000 - 60); // el final del tramo se cuenta cuando llegue el siguiente (la boca mira 30 ms adelante)
  }

  /** Fin de la respuesta: la boca vuelve a reposo. `until`: segundos de audio enviados. */
  close(until: number): MouthKey[] { return this.run(until * 1000 + 300); }

  private run(untilMs: number): MouthKey[] {
    const out: MouthKey[] = [], dt = MOUTH_STEP_MS / 1000, k = 1 - Math.exp(-dt / 0.06);
    while (this.ms + MOUTH_STEP_MS <= untilMs) {
      this.ms += MOUTH_STEP_MS;
      const look = this.ms / 1000 + 0.03; // la boca se adelanta un poco al sonido
      while (this.cursor < this.events.length - 1 && this.events[this.cursor].t1 <= look) this.cursor++;
      const e = this.events[this.cursor];
      const target = e && look >= e.t0 && look < e.t1 + 0.04 ? e.v : 'rest';
      for (const v of VISEMES) this.weights[v] += ((v === target ? STRENGTH[v] : 0) - this.weights[v]) * k;
      const frame = mouthFrame(this.weights);
      if (frame !== this.last) { this.last = frame; out.push([this.ms, frame]); }
    }
    return out;
  }
}

/** Trama binaria de audio para la placa: 4 bytes de cabecera (tipo 1, 0, número de la respuesta en 16 bits) + PCM16. */
export const GADGET_AUDIO = 1;
export function audioFrame(id: number, pcm: Buffer): Buffer {
  const head = Buffer.alloc(4); head[0] = GADGET_AUDIO; head.writeUInt16LE(id & 0xffff, 2);
  return Buffer.concat([head, pcm]);
}

/** Lo único que se le envía a la placa además del audio: lo demás (paneles, fondos, música, galería) no tiene dónde verse. */
export const GADGET_TYPES = new Set(['ready', 'error', 'user_final', 'speech_start', 'speech_end', 'mouth', 'reaction', 'suspend', 'interrupt']);

/**
 * Baja el audio de 24 kHz a 16 kHz para la placa (su códec trabaja a 16 kHz, como en los ejemplos del fabricante).
 * Por cada 3 muestras salen 2, después de un filtro corto [1, 2, 1] / 4 para que no aparezcan silbidos. Guarda entre
 * llamadas las muestras que aún no alcanzan para producir salida, así el audio de una respuesta sale continuo.
 */
export class Downsampler {
  private rest: number[] = [];
  private prev = 0;

  push(pcm: Buffer): Buffer {
    const x = this.rest; for (let i = 0; i + 1 < pcm.length; i += 2) x.push(pcm.readInt16LE(i));
    const groups = Math.floor((x.length - 1) / 3); // cada grupo de 3 necesita ver una muestra más
    if (groups <= 0) return Buffer.alloc(0);
    const out = Buffer.alloc(groups * 4);
    for (let g = 0; g < groups; g++) {
      const a = x[g * 3], b = x[g * 3 + 1], c = x[g * 3 + 2], d = x[g * 3 + 3];
      const f0 = (this.prev + 2 * a + b) / 4, f1 = (a + 2 * b + c) / 4, f2 = (b + 2 * c + d) / 4;
      out.writeInt16LE(Math.round(f0), g * 4); out.writeInt16LE(Math.round((f1 + f2) / 2), g * 4 + 2);
      this.prev = c;
    }
    this.rest = x.slice(groups * 3);
    return out;
  }
}
export const GADGET_RATES = [16000, 24000];
