import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { DemoDocsService } from '../demo/demo-docs.service';
import { ActionsService } from '../policy/actions.service';
import { UsageService } from '../usage/usage.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { AvatarGeneratorService } from './avatar-generator.service';
import { AvatarRequest, AvatarRequestsService } from './avatar-requests.service';

/**
 * Avatares personalizados, E4: avisarle al cliente por WhatsApp que su avatar esta listo, y borrar a tiempo lo que guardamos de el.
 *
 * AVISO. Plantilla `minijavi_avatar_listo` (creada por Javier; consultada en Meta el 2026-11-21: APPROVED, `es`, MARKETING,
 * cabecera IMAGEN, cuerpo {{1}} nombre, boton URL https://yo.minijavi.com/demo/{{1}}). La cabecera es el retrato real.
 * Sale por la puerta de acciones (`avatar_listo`, autonoma: el cliente pago y lo esta esperando, no pide aprobacion), asi
 * que mandan la pausa, "no contactar", el horario, los topes y el modo simulacion. El resultado se anota APARTE del estado
 * de la solicitud (`wa_status`): un avatar esta COMPLETADO aunque el WhatsApp no haya salido.
 *   '' sin intentar · enviada · simulada · en_espera: <motivo> (pasa solo: se reintenta) · bloqueada: <motivo> · fallo: <motivo>
 * Lo que no pasa solo se reenvia desde el panel.
 *
 * BORRADO (decision de Javier): foto original a los `AVATAR_FOTO_DIAS` (30) de completado; comprobantes a los
 * `AVATAR_COMPROBANTE_DIAS` (90) de decidido el pago; retrato mientras viva la demo; antes si el cliente lo pide (panel).
 * Una solicitud que nunca se pago suelta su foto a los 30 dias. La fila se conserva (sin archivos) como registro del pago.
 */
const DAY = 86400_000;

@Injectable()
export class AvatarCareService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AvatarCareService.name);
  private readonly root: string;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly cfg: ConfigService, private readonly db: DbService, private readonly reqs: AvatarRequestsService, private readonly gen: AvatarGeneratorService,
    private readonly demos: DemoDocsService, private readonly actions: ActionsService, private readonly whatsapp: WhatsAppService, @Optional() private readonly usage?: UsageService) {
    this.root = join(cfg.dataDir, 'avatares');
  }

  onModuleInit() {
    if (!this.cfg.avatarCustom) return;
    this.gen.onCompleted = (r) => void this.notify(r.id).catch(() => undefined);
    const every = (ms: number, fn: () => Promise<unknown>) => { const t = setInterval(() => void fn().catch(() => undefined), ms); t.unref(); this.timers.push(t); };
    every(5 * 60_000, () => this.flush()); every(60 * 60_000, () => this.purge());
    setTimeout(() => { void this.flush().catch(() => undefined); void this.purge().catch(() => undefined); }, 60_000).unref();
  }
  onModuleDestroy() { this.timers.forEach(clearInterval); }

  private one(id: number) { return this.db.query<AvatarRequest>('SELECT * FROM avatar_requests WHERE id = $1', [id]).then((r) => r[0]); }
  private dirOf(r: AvatarRequest) { return /^[0-9a-f]{24}$/.test(r.dir) ? join(this.root, r.dir) : ''; }

  /** Envia (o reintenta) el aviso de "tu avatar esta listo". `force`: Javier lo pidio desde el panel. Devuelve como quedo. */
  async notify(id: number, force = false): Promise<string> {
    const r = await this.one(id);
    if (!r || r.state !== 'COMPLETADO') return 'la solicitud no está completada';
    if (r.wa_status === 'enviada') return 'enviada'; // nunca dos veces
    if (!force && r.wa_status && !r.wa_status.startsWith('en_espera')) return r.wa_status;
    const dir = this.dirOf(r), portrait = dir ? join(dir, 'retrato.jpg') : '';
    let status: string;
    if (!portrait || !existsSync(portrait)) status = 'fallo: ya no existe el retrato';
    else if (!(await this.demos.get(r.demo))) status = 'fallo: la demostración ya no existe';
    else {
      const first = r.name.split(/\s+/)[0] || r.name;
      // Tomar el turno antes de enviar: dos vueltas a la vez no mandan dos mensajes.
      const [mine] = await this.db.query<AvatarRequest>(`UPDATE avatar_requests SET wa_status = 'enviando' WHERE id = $1 AND wa_status = $2 RETURNING *`, [r.id, r.wa_status]);
      if (!mine) return 'ya se está enviando';
      const out = await this.actions.run({ kind: 'avatar_listo', contact: r.phone, leadId: r.lead_id || undefined, consent: true, trigger: 'avatar personalizado listo (pago aprobado)', content: `Plantilla ${this.cfg.whatsappAvatarTemplate} a ${first}: su avatar personalizado ya está activo en su demostración (${r.demo}), con su retrato en la cabecera.` },
        () => this.whatsapp.sendAvatarReady(r.phone, r.name, r.demo, { buf: readFileSync(portrait), mime: 'image/jpeg' }));
      status = out.status === 'enviada' || out.status === 'simulada' ? out.status : out.status === 'bloqueada' && out.temporary ? `en_espera: ${out.reason}` : `${out.status === 'fallo' ? 'fallo' : 'bloqueada'}: ${out.reason}`;
    }
    await this.db.query('UPDATE avatar_requests SET wa_status = $1, wa_at = $2 WHERE id = $3', [status.slice(0, 240), new Date().toISOString(), r.id]);
    if (status === 'enviada') this.usage?.add('avatar_whatsapp');
    this.log.log(`avatar #${r.id}: aviso por WhatsApp → ${status}`);
    return status;
  }

  /** Los completados que aun no se han avisado, o que esperaban su momento (horario, tope del dia, pausa). */
  async flush(): Promise<number> {
    const rows = await this.db.query<AvatarRequest>(`SELECT * FROM avatar_requests WHERE state = 'COMPLETADO' AND (wa_status = '' OR wa_status LIKE 'en_espera%') ORDER BY id LIMIT 20`);
    for (const r of rows) await this.notify(r.id).catch((e) => this.log.warn(`avatar #${r.id}: aviso sin enviar (${(e as Error).message})`));
    return rows.length;
  }

  /** Borrado automatico por plazo. Publico para poder probarlo con otra fecha. */
  async purge(now = Date.now()): Promise<{ photos: number; proofs: number; portraits: number }> {
    const done = { photos: 0, proofs: 0, portraits: 0 }, iso = new Date(now).toISOString();
    const older = (at: string, days: number) => !!at && now - Date.parse(at) > days * DAY;
    for (const r of await this.db.query<AvatarRequest>(`SELECT * FROM avatar_requests WHERE photo_deleted_at = '' OR proof_deleted_at = '' OR portrait <> ''`)) {
      const dir = this.dirOf(r); if (!dir) continue;
      // Foto: 30 dias despues de completado; o 30 dias sin pagar (solicitud abandonada).
      const stale = r.state === 'COMPLETADO' ? older(r.updated_at, this.cfg.avatarPhotoDays) : (r.state === 'PENDIENTE_PAGO' || r.state === 'PAGO_RECHAZADO') && older(r.updated_at, this.cfg.avatarPhotoDays);
      if (!r.photo_deleted_at && stale) { if (/^[a-z0-9.-]+$/.test(r.photo)) rmSync(join(dir, r.photo), { force: true }); await this.db.query('UPDATE avatar_requests SET photo_deleted_at = $1 WHERE id = $2', [iso, r.id]); done.photos++; }
      // Comprobantes: 90 dias despues de la decision (o del ultimo cambio, si nunca se decidio).
      if (!r.proof_deleted_at && r.proofs > 0 && r.state !== 'PENDIENTE_VALIDACION' && older(r.decided_at || r.updated_at, this.cfg.avatarProofDays)) {
        if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.startsWith('comprobante-')) rmSync(join(dir, f), { force: true });
        await this.db.query(`UPDATE avatar_requests SET proof_deleted_at = $1, proof = '' WHERE id = $2`, [iso, r.id]); done.proofs++;
      }
      // Retrato: mientras viva la demo.
      if (r.portrait && r.state === 'COMPLETADO') {
        const d = await this.demos.get(r.demo);
        if (!d || Date.parse(d.expires_at) < now) { rmSync(join(dir, 'retrato.jpg'), { force: true }); await this.db.query(`UPDATE avatar_requests SET portrait = '' WHERE id = $1`, [r.id]); done.portraits++; }
      }
    }
    if (done.photos || done.proofs || done.portraits) this.log.log(`avatares: borrado por plazo → ${done.photos} fotos, ${done.proofs} comprobantes, ${done.portraits} retratos`);
    return done;
  }

  /**
   * El cliente pidio borrar sus datos (lo hace Javier en el panel): se van YA la foto, los comprobantes y el retrato, y su
   * demo vuelve al avatar por defecto. La fila queda, sin archivos. No aplica mientras hay un pago por decidir o un avatar generandose.
   */
  async erase(id: number): Promise<{ ok: boolean; text: string }> {
    const r = await this.one(id);
    if (!r) return { ok: false, text: 'Esa solicitud no existe.' };
    if (['PENDIENTE_VALIDACION', 'PAGO_APROBADO', 'GENERANDO_AVATAR', 'AVATAR_GENERADO'].includes(r.state)) return { ok: false, text: 'Primero decide el pago o espera a que termine la generación.' };
    const dir = this.dirOf(r); if (dir) rmSync(dir, { recursive: true, force: true });
    const iso = new Date().toISOString();
    await this.db.query(`UPDATE avatar_requests SET photo_deleted_at = $1, proof_deleted_at = $2, proof = '', portrait = '', colors = '' WHERE id = $3`, [r.photo_deleted_at || iso, r.proof_deleted_at || iso, r.id]);
    const d = await this.demos.get(r.demo);
    if (d) { let cfgNow: any = {}; try { cfgNow = JSON.parse(d.profile).config ?? {}; } catch { /* sin configuracion */ }
      if (cfgNow.avatarPropio === r.id) await this.demos.patchConfig(r.demo, { avatar: '', tinte: undefined, avatarPropio: undefined }); }
    this.log.log(`avatar #${r.id}: datos borrados a pedido`);
    return { ok: true, text: 'Foto, comprobantes y retrato borrados.' };
  }
}
