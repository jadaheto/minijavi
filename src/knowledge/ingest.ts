// Carga los documentos de KNOWLEDGE_DIR en Qdrant. Uso: npm run conocimiento
//   <KNOWLEDGE_DIR>/publico/*.md|.txt  -> lo que puede saber cualquier visitante
//   <KNOWLEDGE_DIR>/privado/*.md|.txt  -> solo para el modo dueño
// Se puede ejecutar en local contra el Qdrant remoto: los documentos no necesitan estar en el repositorio.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
if (existsSync('.env')) process.loadEnvFile('.env');
import { ConfigService } from '../config/config.service';
import { KnowledgeService } from './knowledge.service';

export { chunk } from './chunk';
import { chunk } from './chunk';

async function main() {
  const cfg = new ConfigService(); const kb = new KnowledgeService(cfg);
  if (!kb.enabled) throw new Error('Faltan NVIDIA_API_KEY o QDRANT_URL');
  const [probe] = await kb.embed(['prueba'], 'passage');
  await kb.ensureCollection(probe.length);
  let total = 0;
  for (const scope of ['publico', 'privado'] as const) {
    const dir = join(cfg.knowledgeDir, scope);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => /\.(md|txt)$/i.test(f)).sort()) {
      const parts = chunk(readFileSync(join(dir, file), 'utf8'));
      await kb.replaceSource(`${scope}/${file}`, scope, parts);
      console.log(`${scope}/${file}: ${parts.length} fragmentos`);
      total += parts.length;
    }
  }
  console.log(`Listo: ${total} fragmentos cargados. La coleccion "${cfg.qdrantCollection}" tiene ${await kb.count()} puntos.`);
}
if (require.main === module) main().catch((e) => { console.error(`No se pudo cargar: ${e.message}`); process.exit(1); });
