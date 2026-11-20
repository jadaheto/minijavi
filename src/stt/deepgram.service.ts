import { Injectable, Logger } from '@nestjs/common';
import WebSocket from 'ws';
import { ConfigService } from '../config/config.service';
import { UsageService } from '../usage/usage.service';

export interface SttHandlers {
  /** Texto reconocido. isFinal: el tramo ya no cambia. speechFinal: Deepgram detecto fin de frase. */
  onTranscript(text: string, isFinal: boolean, speechFinal: boolean, lang?: string): void;
  /** Respaldo del fin de frase: no hubo palabras nuevas durante utterance_end_ms. */
  onUtteranceEnd(): void;
  onClose(reason: string): void;
}
export interface SttStream { send(audio: Buffer): void; close(): void; }

/**
 * Deepgram en streaming (verificado con la documentacion el 2026-11-13):
 *  wss://api.deepgram.com/v1/listen, cabecera "Authorization: Token <clave>", audio linear16 a 16 kHz mono.
 *  Mensajes: Results (is_final, speech_final, channel.alternatives[0].transcript) y UtteranceEnd.
 *  Sin audio ni KeepAlive durante 10 s la conexion se cierra: se envia {"type":"KeepAlive"} cada 4 s.
 */
@Injectable()
export class DeepgramService {
  private readonly log = new Logger(DeepgramService.name);
  constructor(private readonly cfg: ConfigService, private readonly usage: UsageService) {}

  /**
   * `language` fija el idioma de esta escucha (el modo carro usa solo español); sin el, el configurado (multi).
   * `keyterms`: palabras que el modelo debe reconocer mejor (Keyterm Prompting de nova-3, documentacion leida el
   * 2026-11-20: parametro `keyterm` repetido por cada termino, tambien en streaming).
   */
  open(h: SttHandlers, language?: string, keyterms: string[] = []): SttStream {
    const q = new URLSearchParams({
      model: this.cfg.deepgramModel, language: language || this.cfg.deepgramLanguage,
      encoding: 'linear16', sample_rate: '16000', channels: '1',
      interim_results: 'true', endpointing: '300', utterance_end_ms: '1000', smart_format: 'true',
    });
    for (const k of keyterms.slice(0, 20)) q.append('keyterm', k);
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${q}`, { headers: { Authorization: `Token ${this.cfg.deepgramApiKey}` } });
    const pending: Buffer[] = [];
    let closed = false;
    const keep = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' })); }, 4000);
    ws.on('open', () => { for (const b of pending.splice(0)) ws.send(b); });
    ws.on('message', (raw) => {
      let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'Results') h.onTranscript((m.channel?.alternatives?.[0]?.transcript ?? '').trim(), !!m.is_final, !!m.speech_final, m.channel?.alternatives?.[0]?.languages?.[0]); // languages solo llega con language=multi
      else if (m.type === 'UtteranceEnd') h.onUtteranceEnd();
      else if (m.type === 'Error') this.log.error(`Deepgram: ${m.description ?? m.message ?? 'error'}`);
    });
    ws.on('unexpected-response', (_req, res) => this.log.error(`Deepgram rechazo la conexion: HTTP ${res.statusCode}`));
    ws.on('error', (e) => this.log.error(`Deepgram: ${e.message}`));
    ws.on('close', (code) => { clearInterval(keep); if (!closed) { closed = true; h.onClose(`codigo ${code}`); } });
    return {
      send: (audio) => {
        if (ws.readyState === WebSocket.OPEN) { ws.send(audio); this.usage.add('deepgram_s', audio.length / 32000); } // PCM 16 bits a 16 kHz
        else if (ws.readyState === WebSocket.CONNECTING && pending.length < 100) pending.push(audio);
      },
      close: () => {
        closed = true; clearInterval(keep);
        try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' })); ws.close(); } catch { /* ya cerrado */ }
      },
    };
  }
}
