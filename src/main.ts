import 'reflect-metadata';
import { existsSync } from 'node:fs';
// En local las claves vienen de .env; en produccion, del entorno del contenedor.
if (existsSync('.env')) process.loadEnvFile('.env');

// Los archivos que crea el avatar (interesados, dispositivos, grabaciones) son solo para su usuario: el taller de
// programacion corre como otro usuario del sistema y no debe poder leerlos.
process.umask(0o077);

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true }); // el cuerpo crudo se usa para validar la firma del webhook
  // Respaldo del taller: Claude Code manda la conversacion entera en cada peticion (pasa de los 100 kB por defecto).
  // OJO: no pasar `json(...)` directo a app.use: Nest busca un middleware llamado "jsonParser" y, si lo encuentra, NO
  // registra su lector de JSON para el resto de las rutas (todas las peticiones POST llegarian sin cuerpo).
  const bigJson = json({ limit: '50mb' });
  app.use('/taller-llm', (req: any, res: any, next: any) => bigJson(req, res, next));
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableShutdownHooks();
  const cfg = app.get(ConfigService);
  await app.listen(cfg.port, '0.0.0.0');
  new Logger('main').log(`escuchando en el puerto ${cfg.port}`);
}
bootstrap().catch((e) => { console.error(`No se pudo arrancar: ${e.message}`); process.exit(1); });
