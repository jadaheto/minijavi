import { emitNotice } from '../notices/bus';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

/** Estado de un servicio vigilado, para el panel. */
export interface ServiceState { ok: boolean; detail: string; since: string; }

/**
 * Avisos a Javier por Telegram cuando algo de lo que depende el avatar falla (pedido el 2026-11-18).
 * Dos fuentes: las comprobaciones periodicas de OpsService (`set`) y los fallos reales durante las conversaciones
 * (`report`, que avisa si un mismo servicio falla 3 veces en 10 minutos). Un aviso por caida y otro al recuperarse.
 */
@Injectable()
export class AlertsService {
  private readonly log = new Logger(AlertsService.name);
  private readonly states = new Map<string, ServiceState & { fails: number; alerted: boolean }>();
  private readonly recent = new Map<string, number[]>();
  private readonly lastSent = new Map<string, number>();
  constructor(private readonly cfg: ConfigService) {}

  get enabled() { return !!(this.cfg.telegramBotToken && this.cfg.telegramChatId); }
  status(): Record<string, ServiceState> { return Object.fromEntries([...this.states].map(([k, v]) => [k, { ok: v.ok, detail: v.detail, since: v.since }])); }

  /** Resultado de una comprobacion. Avisa tras `after` fallos seguidos (un tropiezo aislado de red no cuenta) y al volver. */
  set(service: string, ok: boolean, detail = '', after = 3) {
    const prev = this.states.get(service), now = new Date().toISOString();
    if (ok) {
      if (prev && !prev.ok && prev.alerted) { void this.send(`✅ ${service} volvió a funcionar.`); emitNotice({ source: 'servicios', title: 'Volvió a funcionar', body: service, word: 'OK', tone: 'ok' }); }
      this.states.set(service, { ok: true, detail, since: prev?.ok ? prev.since : now, fails: 0, alerted: false });
      return;
    }
    const fails = (prev?.fails ?? 0) + 1;
    const alert = fails === after;
    this.states.set(service, { ok: false, detail, since: prev && !prev.ok ? prev.since : now, fails, alerted: !!prev?.alerted || alert });
    if (alert) { void this.send(`⚠️ ${service} no está funcionando: ${detail || 'sin detalle'}`); emitNotice({ source: 'servicios', title: 'No está funcionando', body: service, tone: 'bad' }); }
  }

  /** Fallo real en una conversacion (la voz no salio, el modelo no respondio...). */
  report(service: string, detail: string) {
    const now = Date.now(), list = (this.recent.get(service) ?? []).filter((t) => now - t < 10 * 60_000);
    list.push(now); this.recent.set(service, list);
    if (list.length < 3 || now - (this.lastSent.get(service) ?? 0) < 30 * 60_000) return;
    this.lastSent.set(service, now);
    void this.send(`⚠️ ${service} falló ${list.length} veces en los últimos 10 minutos durante conversaciones. Último error: ${detail.slice(0, 200)}`);
  }

  /** Mensaje de texto a Javier. Devuelve '' o el motivo del fallo (sin la direccion, que lleva el token). */
  async send(text: string): Promise<string> {
    if (!this.enabled) { this.log.warn(`aviso sin enviar (Telegram no configurado): ${text.slice(0, 120)}`); return 'Telegram no está configurado'; }
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.cfg.telegramBotToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.cfg.telegramChatId, text: `🤖 Avatar: ${text}`.slice(0, 3900) }), signal: AbortSignal.timeout(8000) });
      if (!res.ok) { this.log.warn(`Telegram respondió ${res.status} al enviar un aviso`); return `Telegram respondió ${res.status}`; }
      return '';
    } catch (e) { this.log.warn(`no se pudo enviar el aviso (${(e as Error).name})`); return (e as Error).name; }
  }

  /** Archivo a Javier (el respaldo diario). */
  async sendFile(file: Buffer, filename: string, mime: string, caption: string): Promise<string> {
    if (!this.enabled) return 'Telegram no está configurado';
    try {
      const form = new FormData();
      form.append('chat_id', this.cfg.telegramChatId); form.append('caption', caption.slice(0, 1000));
      form.append('document', new Blob([new Uint8Array(file)], { type: mime }), filename);
      const res = await fetch(`https://api.telegram.org/bot${this.cfg.telegramBotToken}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
      return res.ok ? '' : `Telegram respondió ${res.status}`;
    } catch (e) { return (e as Error).name; }
  }

  /** Nota de voz (Ogg/Opus) al chat de Javier, con pie opcional. Devuelve '' si salio o el motivo si no. */
  async sendVoice(audio: Buffer, caption = ''): Promise<string> {
    if (!this.enabled) return 'Telegram no está configurado';
    try {
      const form = new FormData();
      form.append('chat_id', this.cfg.telegramChatId); if (caption) form.append('caption', caption.slice(0, 1000));
      form.append('voice', new Blob([new Uint8Array(audio)], { type: 'audio/ogg' }), 'resumen.ogg');
      const res = await fetch(`https://api.telegram.org/bot${this.cfg.telegramBotToken}/sendVoice`, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
      return res.ok ? '' : `Telegram respondió ${res.status}`;
    } catch (e) { return (e as Error).name; }
  }

  /** Foto al chat de Javier (sendPhoto, campo "photo", pie hasta 1024). Devuelve '' si salio o el motivo si no. */
  async sendPhoto(image: Buffer, mime: string, caption = ''): Promise<string> {
    if (!this.enabled) return 'Telegram no está configurado';
    try {
      const form = new FormData();
      form.append('chat_id', this.cfg.telegramChatId); if (caption) form.append('caption', caption.slice(0, 1000));
      form.append('photo', new Blob([new Uint8Array(image)], { type: mime }), `imagen.${mime.split('/')[1] || 'jpg'}`);
      const res = await fetch(`https://api.telegram.org/bot${this.cfg.telegramBotToken}/sendPhoto`, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
      return res.ok ? '' : `Telegram respondió ${res.status}`;
    } catch (e) { return (e as Error).name; }
  }
}
