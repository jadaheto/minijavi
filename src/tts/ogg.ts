import { ConfigService } from '../config/config.service';

/**
 * Texto -> nota de voz Ogg/Opus mono 48 kHz con la voz de Javier en ElevenLabs (`output_format=opus_48000_32`).
 * Sirve para WhatsApp (exige Ogg con Opus mono) y para Telegram (sendVoice acepta .OGG con OPUS, MP3 o M4A; leido en
 * core.telegram.org/bots/api el 2026-11-21).
 */
export async function elevenOgg(cfg: ConfigService, text: string): Promise<Buffer> {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${cfg.elevenVoiceId}?output_format=opus_48000_32`, {
    method: 'POST', headers: { 'xi-api-key': cfg.elevenApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: cfg.elevenModelId, language_code: 'es' }), signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs respondió ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
