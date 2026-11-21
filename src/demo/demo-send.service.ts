import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '../config/config.service';
import { LeadsService } from '../leads/leads.service';
import { ApprovalsService } from '../policy/approvals.service';
import { PolicyService } from '../policy/policy.service';
import { WhatsAppService, toPhone } from '../whatsapp/whatsapp.service';
import { ImagesService } from '../images/images.service';
import { AlertsService } from '../ops/alerts.service';
import { DemoDocsService, DemoProfile } from './demo-docs.service';

/**
 * B3 (aprobado por Javier el 2026-11-21): cuando termina la conversacion de un visitante que subio el documento de su
 * negocio, se le propone a Javier enviarle el enlace de su demo por WhatsApp (plantilla `minijavi_demo`, con la imagen
 * generada del negocio en la cabecera). SIEMPRE con su aprobacion: pasa por la bandeja (Telegram con botones o panel)
 * y por la puerta de acciones (no contactar, horario, topes, simulacion, bitacora).
 *  - Solo si la persona dejo sus datos con autorizacion y su contacto es un numero de WhatsApp. Si no, Javier recibe el
 *    enlace por Telegram para compartirlo el mismo.
 *  - Imagen: la de la demo (OpenAI y, si falla, Magnific). Si las dos fallaron, la plantilla sale con la imagen de
 *    cabecera de minijavi y el aviso le dice a Javier como pedir la portada a Claude Code (herramienta `portada_demo`,
 *    solo en modo dueño: la suscripcion no puede arrancar sola por un visitante).
 */
@Injectable()
export class DemoSendService implements OnModuleInit {
  private readonly log = new Logger(DemoSendService.name);
  private readonly offered = new Set<string>();
  constructor(private readonly cfg: ConfigService, private readonly docs: DemoDocsService, private readonly leads: LeadsService, private readonly approvals: ApprovalsService,
    private readonly policy: PolicyService, private readonly whatsapp: WhatsAppService, private readonly images: ImagesService, @Optional() private readonly alerts?: AlertsService) {}

  onModuleInit() { this.approvals.register('enviar_demo', (p: { demoId: string; contact: string; name: string }) => this.execute(p)); }

  private link(id: string) { return `${this.cfg.publicUrl || 'https://yo.minijavi.com'}/demo/${id}`; }
  /** La imagen que ira en la cabecera: la del negocio o, si no hay, la de minijavi. */
  private header(profile: DemoProfile): { buf: Buffer; mime: string; own: boolean } {
    const name = profile.config?.imagen, file = name ? this.images.file(name) : null;
    if (file) return { buf: readFileSync(file), mime: /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg', own: true };
    return { buf: readFileSync(join(__dirname, '..', '..', 'public', 'img', 'cabecera.jpg')), mime: 'image/jpeg', own: false };
  }

  /**
   * Termino la conversacion: propone el envio (una vez por demo). `waitMs`: cuanto esperar a que la configuracion y la
   * imagen terminen de armarse (corren en segundo plano desde que se leyo el documento).
   */
  async offer(demoId: string, waitMs = 240_000): Promise<'aprobacion' | 'aviso' | 'nada'> {
    if (this.offered.has(demoId)) return 'nada';
    this.offered.add(demoId);
    try {
      let d = await this.docs.get(demoId), profile: DemoProfile | undefined;
      for (const t0 = Date.now(); d && d.status === 'listo'; d = await this.docs.get(demoId)) {
        profile = JSON.parse(d.profile || '{}');
        if (profile?.config?.imagenLista || Date.now() - t0 >= waitMs) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (!d || d.status !== 'listo' || !profile) return 'nada';
      if (profile.config?.propuesta) return 'nada'; // ya se le propuso a Javier (queda en la base: un despliegue no lo repite)
      await this.docs.patchConfig(demoId, { propuesta: true });
      const business = profile.negocio || d.business, url = this.link(demoId), img = this.header(profile);
      const noImage = img.own ? '' : `\n⚠️ No se pudo generar la imagen del negocio (${profile.config?.imagenError || 'OpenAI y Magnific fallaron'}): iría con tu imagen de cabecera. Si quieres una portada hecha por Claude Code para su enlace, dile al avatar en modo dueño: «haz la portada de la demo de ${business}».`;
      const lead = d.lead_id ? await this.leads.get(d.lead_id) : undefined;
      const phone = lead ? toPhone(lead.contact, this.cfg.whatsappDefaultCountry) : '';
      if (!lead || !phone || !this.whatsapp.enabled) {
        const why = !lead ? 'la persona no dejó sus datos' : !phone ? `su contacto (${lead.contact}) no es un WhatsApp` : 'WhatsApp no está configurado';
        await this.tell(img, `🤖 Demo lista: ${business}\n${url}\nNo se propone enviarla por WhatsApp: ${why}. Puedes compartir el enlace tú (dura ${this.cfg.demoDocDays} días).${noImage}`);
        return 'aviso';
      }
      await this.tell(img, `🤖 Demo lista: ${business} (de ${lead.name})\n${url}\nEnseguida te llega la solicitud para enviársela por WhatsApp.${noImage}`);
      const r = await this.approvals.submit({ kind: 'enviar_demo', contact: lead.contact, leadId: lead.id, consent: !!lead.consent_at, trigger: `demo lista: ${business}`,
        content: `Plantilla "${this.cfg.whatsappDemoTemplate}" para ${lead.name.split(/\s+/)[0]}: «…ya está lista la demostración del asistente de ${business}…», con ${img.own ? 'la imagen del negocio' : 'tu imagen de cabecera'} y el botón al enlace ${url}`,
        costUsd: this.policy.limit('costo_plantilla_usd') }, { demoId, contact: lead.contact, name: lead.name });
      this.log.log(`demo ${demoId}: envío por WhatsApp → ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
      return 'aprobacion';
    } catch (e) { this.offered.delete(demoId); this.log.warn(`demo ${demoId}: no se pudo proponer el envío (${(e as Error).message})`); return 'nada'; }
  }

  private async tell(img: { buf: Buffer; mime: string; own: boolean }, text: string) {
    if (!this.alerts?.enabled) return;
    const err = img.own ? await this.alerts.sendPhoto(img.buf, img.mime, text) : 'sin imagen propia';
    if (err) await this.alerts.send(text);
  }

  /** Javier aprobo: se envia la plantilla (la demo debe seguir viva). Devuelve '' o el motivo por el que no salio. */
  private async execute(p: { demoId: string; contact: string; name: string }): Promise<string> {
    const page = await this.docs.page(p.demoId);
    if ('error' in page && page.error !== 'limite') return page.error === 'vencida' ? 'la demo ya venció' : 'la demo ya no existe';
    const d = await this.docs.get(p.demoId); if (!d) return 'la demo ya no existe';
    const profile: DemoProfile = JSON.parse(d.profile || '{}'), img = this.header(profile);
    return this.whatsapp.sendDemo(p.contact, p.name, profile.negocio || d.business, p.demoId, img);
  }
}
