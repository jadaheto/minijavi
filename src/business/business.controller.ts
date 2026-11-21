import { Controller, Get, Header, HttpException, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import { UsageService } from '../usage/usage.service';
import { BusinessService } from './business.service';

/**
 * `GET /api/modo`: la pagina pregunta que es este servicio (minijavi de Javier, o el asistente de un negocio con su marca).
 * `GET /api/consumo?dias=30` con cabecera `X-Reporte-Secret`: Javier lee el consumo de este cliente para cobrarlo.
 */
@Controller('api')
export class BusinessController {
  constructor(private readonly biz: BusinessService, private readonly cfg: ConfigService, private readonly usage: UsageService) {}

  @Get('modo')
  @Header('Cache-Control', 'no-store')
  mode() { return this.biz.on ? this.biz.info() : { modo: 'javier' }; }

  @Get('consumo')
  @Header('Cache-Control', 'no-store')
  async consumo(@Req() req: Request, @Query('dias') dias: string) {
    const given = Buffer.from(String(req.headers['x-reporte-secret'] ?? '')), want = Buffer.from(this.cfg.reportSecret);
    if (!this.cfg.reportSecret || given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpException({ error: 'no_autorizado' }, 401);
    const days = await this.usage.days(Math.min(92, Math.max(1, Number(dias) || 30)));
    return { negocio: this.biz.on ? this.biz.config.nombre : 'minijavi', dias: days };
  }
}
