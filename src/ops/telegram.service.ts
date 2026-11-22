import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

export interface TgButton { text: string; data: string }
/** Un boton pulsado en un mensaje del bot. `answer` le responde a quien lo pulso; `edit` cambia el mensaje y le quita los botones. */
export interface TgPress { data: string; answer(text: string): Promise<void>; edit(text: string): Promise<void> }

/**
 * Telegram con botones (etapa 2b, pedida por Javier el 2026-11-18). Hasta ahora el avatar solo ENVIABA por Telegram; para
 * que Javier apruebe o rechace con un toque hay que recibir la pulsacion. Decision de Javier: por consulta periodica
 * (getUpdates con espera larga), sin registrar un webhook en el bot.
 * Verificado en core.telegram.org/bots/api el 2026-11-18:
 *  - sendMessage con reply_markup {inline_keyboard: [[{text, callback_data}]]}; callback_data de 1 a 64 bytes.
 *  - getUpdates {offset, timeout, allowed_updates}: se confirma lo recibido pidiendo offset = ultimo update_id + 1; las
 *    novedades se guardan 24 horas; NO funciona si el bot tiene un webhook (getWebhookInfo.url no vacio).
 *  - La pulsacion llega como update.callback_query {id, from, message{message_id, chat{id}}, data}; hay que responder con
 *    answerCallbackQuery o el boton se queda "cargando".
 *  - editMessageText {chat_id, message_id, text, reply_markup} cambia el mensaje (teclado vacio = sin botones).
 * Seguridad: solo cuenta una pulsacion hecha en el chat configurado (TELEGRAM_CHAT_ID). Nunca se borra ni se cambia el
 * webhook del bot: si tiene uno, los botones quedan apagados y se aprueba desde el panel.
 * OJO: solo UN proceso puede consultar un mismo bot. Un servidor local con el mismo token le quitaria las pulsaciones a
 * produccion: en local usar TELEGRAM_BUTTONS=0 (o dejar el token vacio).
 */
@Injectable()
export class TelegramService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(TelegramService.name);
  private handler?: (press: TgPress) => Promise<void>;
  private prefixed = new Map<string, (press: TgPress) => Promise<void>>();
  private stop = new AbortController();
  private offset = 0;
  /** Por que no hay botones ('' = funcionando o aun sin arrancar). Lo muestra el panel. */
  problem = '';
  polling = false;

  constructor(private readonly cfg: ConfigService) {}
  get enabled() { return !!(this.cfg.telegramBotToken && this.cfg.telegramChatId); }
  private api(method: string, body: unknown, signal?: AbortSignal) {
    return fetch(`https://api.telegram.org/bot${this.cfg.telegramBotToken}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(10_000) });
  }

  /** Quien atiende las pulsaciones (la bandeja de aprobaciones). */
  onPress(fn: (press: TgPress) => Promise<void>) { this.handler = fn; }
  /** Otro modulo atiende los botones cuyo dato empieza por `prefix` (por ejemplo "avp:"); el resto sigue yendo a la bandeja. */
  onPrefix(prefix: string, fn: (press: TgPress) => Promise<void>) { this.prefixed.set(prefix, fn); }

  /**
   * Foto (JPG, PNG, WebP) o documento a Javier, con pie y botones. Bot API leida el 2026-11-21: sendPhoto (hasta 10 MB) y
   * sendDocument (hasta 50 MB) aceptan `caption` (0 a 1024) y `reply_markup`; en multipart el teclado va como texto JSON
   * (la pagina lo describe como "objeto serializado en JSON"; no dice mas). Devuelve el id del mensaje o null.
   */
  async sendMedia(file: Buffer, mime: string, filename: string, caption: string, buttons: TgButton[] = []): Promise<number | null> {
    if (!this.enabled) return null;
    const photo = /^image\/(jpeg|png|webp)$/.test(mime) && file.length < 10 * 1024 * 1024;
    try {
      const form = new FormData();
      form.append('chat_id', this.cfg.telegramChatId); form.append('caption', caption.slice(0, 1024));
      if (buttons.length) form.append('reply_markup', JSON.stringify({ inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data.slice(0, 64) }))] }));
      form.append(photo ? 'photo' : 'document', new Blob([new Uint8Array(file)], { type: mime }), filename);
      const res = await fetch(`https://api.telegram.org/bot${this.cfg.telegramBotToken}/${photo ? 'sendPhoto' : 'sendDocument'}`, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
      const d: any = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) { this.log.warn(`Telegram respondió ${res.status} al enviar un archivo`); return null; }
      return Number(d.result?.message_id) || null;
    } catch (e) { this.log.warn(`no se pudo enviar el archivo por Telegram (${(e as Error).name})`); return null; }
  }
  /** Cambia el pie de una foto o documento ya enviado y le quita los botones (editMessageCaption). */
  async editCaption(messageId: number, caption: string): Promise<void> {
    if (!this.enabled || !messageId) return;
    await this.api('editMessageCaption', { chat_id: this.cfg.telegramChatId, message_id: messageId, caption: caption.slice(0, 1024), reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
  }

  /** Mensaje a Javier, con botones si se dan. Devuelve el id del mensaje, o null si no salio. Los errores no llevan la direccion (trae el token). */
  async send(text: string, buttons: TgButton[] = []): Promise<number | null> {
    if (!this.enabled) return null;
    try {
      const res = await this.api('sendMessage', { chat_id: this.cfg.telegramChatId, text: text.slice(0, 3900), ...(buttons.length ? { reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data.slice(0, 64) }))] } } : {}) });
      const d: any = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) { this.log.warn(`Telegram respondió ${res.status} al enviar`); return null; }
      return Number(d.result?.message_id) || null;
    } catch (e) { this.log.warn(`no se pudo enviar por Telegram (${(e as Error).name})`); return null; }
  }
  /** Cambia el texto de un mensaje ya enviado y le quita los botones. */
  async edit(messageId: number, text: string): Promise<void> {
    if (!this.enabled || !messageId) return;
    await this.api('editMessageText', { chat_id: this.cfg.telegramChatId, message_id: messageId, text: text.slice(0, 3900), reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
  }

  onApplicationBootstrap() { if (this.enabled && this.cfg.telegramButtons && (this.handler || this.prefixed.size)) void this.start(); else if (this.enabled && !this.cfg.telegramButtons) this.problem = 'los botones están apagados (TELEGRAM_BUTTONS=0)'; }
  onModuleDestroy() { this.stop.abort(); }

  private async start() {
    try {
      // Solo se mira si hay webhook; si lo hay, no se toca: lo puso Javier u otro sistema.
      const info: any = await (await this.api('getWebhookInfo', {})).json();
      if (info?.result?.url) { this.problem = 'el bot tiene un webhook registrado; los botones no funcionan así (aprueba desde el panel)'; this.log.warn(`botones de Telegram apagados: ${this.problem}`); return; }
    } catch { /* sin red al arrancar: se intenta la consulta igual */ }
    this.polling = true; this.log.log('botones de Telegram: escuchando pulsaciones');
    void this.loop();
  }

  private async loop() {
    let wait = 1000;
    while (!this.stop.signal.aborted) {
      try {
        const res = await this.api('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['callback_query'] }, AbortSignal.any([this.stop.signal, AbortSignal.timeout(35_000)]));
        const d: any = await res.json().catch(() => ({}));
        if (res.status === 409) { this.problem = 'otro proceso está leyendo las pulsaciones de este bot (¿un servidor local con el mismo token?)'; await sleep(30_000, this.stop.signal); continue; }
        if (!res.ok || !d.ok) throw new Error(`Telegram respondió ${res.status}`);
        this.problem = ''; wait = 1000;
        for (const u of d.result ?? []) { this.offset = Math.max(this.offset, Number(u.update_id) + 1); await this.handle(u).catch((e) => this.log.warn(`pulsación sin atender: ${(e as Error).message}`)); }
      } catch (e) {
        if (this.stop.signal.aborted) return;
        if ((e as Error).name !== 'TimeoutError') { this.problem = 'no se pudo consultar a Telegram'; await sleep(wait, this.stop.signal); wait = Math.min(60_000, wait * 2); }
      }
    }
  }

  /** Una novedad de Telegram. Publico para poder probarlo sin red. */
  async handle(update: any): Promise<void> {
    const q = update?.callback_query;
    if (!q?.id || typeof q.data !== 'string') return;
    const answer = async (text: string) => { await this.api('answerCallbackQuery', { callback_query_id: q.id, text: text.slice(0, 190) }).catch(() => undefined); };
    // Solo vale una pulsacion hecha en el chat de Javier. Cualquier otra se contesta sin efecto.
    if (String(q.message?.chat?.id ?? '') !== String(this.cfg.telegramChatId)) { this.log.warn('pulsación de un chat que no es el configurado: ignorada'); await answer('No autorizado.'); return; }
    const messageId = Number(q.message?.message_id) || 0;
    const media = !!(q.message?.photo || q.message?.document); // una foto o un documento se editan por su pie
    const press: TgPress = { data: q.data, answer, edit: (text) => (media ? this.editCaption(messageId, text) : this.edit(messageId, text)) };
    const own = [...this.prefixed.entries()].find(([p]) => q.data.startsWith(p));
    if (own) { await own[1](press); return; }
    if (!this.handler) { await answer('Sin efecto.'); return; }
    await this.handler(press);
  }
}
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
