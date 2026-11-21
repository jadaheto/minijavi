import { Controller, Get, HttpException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MapsService } from './maps.service';

/**
 * Sirve la imagen de un mapa que el servidor le pidio a Google para un panel del dueño. La direccion lleva un codigo al
 * azar que solo conoce la sesion que lo pidio y vence a los 20 minutos (como las imagenes generadas).
 */
@Controller('mapas')
export class MapsController {
  constructor(private readonly maps: MapsService) {}
  @Get(':file')
  get(@Param('file') file: string, @Res() res: Response) {
    const buf = this.maps.image(String(file).replace(/\.png$/, ''));
    if (!buf) throw new HttpException('no existe', 404);
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=600', 'X-Content-Type-Options': 'nosniff' }).send(buf);
  }
}
