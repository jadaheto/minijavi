// Carga los documentos del negocio de este servicio. Uso: npm run negocio:cargar [carpeta]
// Por defecto lee DATA_DIR/documentos (PDF, tambien escaneados, fotos y texto). Necesita MODO=negocio.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
if (existsSync('.env')) process.loadEnvFile('.env');
import { NestFactory } from '@nestjs/core';

async function main() {
  process.env.MODO = process.env.MODO || 'negocio';
  const { AppModule } = await import('../app.module');
  const { BusinessService } = await import('./business.service');
  const { ConfigService } = await import('../config/config.service');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const biz = app.get(BusinessService), cfg = app.get(ConfigService);
  const dir = process.argv[2] || join(cfg.dataDir, 'documentos');
  console.log(`Cargando los documentos de "${biz.config.nombre}" desde ${dir}…`);
  const out = await biz.ingest(dir);
  for (const r of out) console.log(` ${r.ok ? '✓' : '✗'} ${r.file}: ${r.note}${r.ok ? ` · ${r.chunks} fragmentos` : ''}`);
  console.log(out.some((r) => r.ok) ? 'Listo. Reinicia el servicio para que tome la ficha nueva.' : 'No se cargó ningún documento.');
  await app.close(); process.exit(out.some((r) => r.ok) ? 0 : 1);
}
main().catch((e) => { console.error(`No se pudo cargar: ${e.message}`); process.exit(1); });
