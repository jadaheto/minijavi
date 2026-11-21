import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { UsageService } from '../usage/usage.service';

export interface TtsChunk {
  /** Audio PCM 16 bits mono en base64, tal como lo entrega ElevenLabs. */
  audio: string;
  /** Caracteres con sus tiempos en segundos, relativos al inicio de ESTA peticion. Puede faltar en algunos fragmentos. */
  align?: { chars: string[]; starts: number[]; ends: number[] };
}

export const TTS_SAMPLE_RATE = 24000;

/**
 * ElevenLabs "stream with timestamps".
 * Verificado con la documentacion y una llamada real el 2026-11-13:
 *  - POST /v1/text-to-speech/{voice_id}/stream/with-timestamps?output_format=pcm_24000
 *  - la respuesta es JSON delimitado por saltos de linea; cada linea trae audio_base64 y (a veces) alignment;
 *  - los tiempos de alignment son relativos a toda la peticion, no al fragmento.
 */
@Injectable()
export class ElevenLabsService {
  private readonly log = new Logger(ElevenLabsService.name);
  constructor(private readonly cfg: ConfigService, private readonly usage: UsageService) {}

  /** `voice`: otra voz para esta conversacion (la demo de un negocio usa la suya); por defecto la de Javier. */
  async *stream(text: string, signal?: AbortSignal, lang = 'es', voice = ''): AsyncGenerator<TtsChunk> {
    const url =
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice || this.cfg.elevenVoiceId)}` +
      `/stream/with-timestamps?output_format=pcm_${TTS_SAMPLE_RATE}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': this.cfg.elevenApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: this.cfg.elevenModelId, language_code: lang }),
      signal,
    });
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      this.log.error(`ElevenLabs respondio ${res.status}: ${detail}`);
      throw new Error(`ElevenLabs respondio ${res.status}`);
    }
    this.usage.add('eleven_calls'); this.usage.add('eleven_chars', text.length);
    const decoder = new TextDecoder();
    let pending = '';
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(part, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        const chunk = this.parse(line);
        if (chunk) yield chunk;
      }
    }
    const last = this.parse(pending.trim());
    if (last) yield last;
  }

  private parse(line: string): TtsChunk | null {
    if (!line) return null;
    try {
      const d = JSON.parse(line);
      if (!d.audio_base64) return null;
      const a = d.alignment;
      return {
        audio: d.audio_base64,
        align: a
          ? { chars: a.characters, starts: a.character_start_times_seconds, ends: a.character_end_times_seconds }
          : undefined,
      };
    } catch {
      this.log.warn('Linea de ElevenLabs que no es JSON; se descarta');
      return null;
    }
  }
}
