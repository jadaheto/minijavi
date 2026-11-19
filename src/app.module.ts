import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';
import { ConfigService } from './config/config.service';
import { HealthController } from './health/health.controller';
import { SessionGateway } from './session/session.gateway';
import { DeepSeekService } from './llm/deepseek.service';
import { DeepgramService } from './stt/deepgram.service';
import { ToolsService } from './tools/tools.service';
import { OwnerController } from './owner/owner.controller';
import { OwnerService } from './owner/owner.service';
import { PlaneMcpService } from './mcp/plane-mcp.service';
import { LeadsService } from './leads/leads.service';
import { CardsService } from './cards/cards.service';
import { CallsController } from './calls/calls.controller';
import { KnowledgeService } from './knowledge/knowledge.service';
import { KnowledgeController } from './knowledge/knowledge.controller';
import { N8nController } from './n8n/n8n.controller';
import { WorkshopService } from './workshop/workshop.service';
import { WorkshopBackupService } from './workshop/backup.service';
import { WorkshopBackupController } from './workshop/backup.controller';
import { MusicService } from './music/music.service';
import { SpotifyService } from './music/spotify.service';
import { SpotifyController } from './music/spotify.controller';
import { SitesController } from './workshop/sites.controller';
import { WhatsAppService } from './whatsapp/whatsapp.service';
import { WaChatService } from './whatsapp/wa-chat.service';
import { SettingsService } from './settings/settings.service';
import { DecisionsService } from './decisions/decisions.service';
import { CapableModelService } from './llm/capable.service';
import { PolicyService } from './policy/policy.service';
import { ActionsService } from './policy/actions.service';
import { ApprovalsService } from './policy/approvals.service';
import { CatalogService } from './policy/catalog.service';
import { TelegramService } from './ops/telegram.service';
import { OptOutService } from './security/optout.service';
import { InjectionGuard } from './security/injection.guard';
import { MemoryService } from './memory/memory.service';
import { ElevenLabsService } from './tts/elevenlabs.service';
import { UsageService } from './usage/usage.service';
import { DbService } from './db/db.service';
import { ImagesService } from './images/images.service';
import { AlertsService } from './ops/alerts.service';
import { OpsService } from './ops/ops.service';
import { PortfolioService } from './portfolio/portfolio.service';
import { VisitsService } from './visits/visits.service';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      exclude: ['/health', '/owner/{*path}', '/webhooks/{*path}', '/knowledge/{*path}', '/n8n/{*path}', '/p/{*path}', '/imagenes/{*path}', '/formulario', '/api/{*path}'],
    }),
  ],
  controllers: [HealthController, OwnerController, CallsController, KnowledgeController, N8nController, SitesController, WorkshopBackupController, SpotifyController],
  providers: [ConfigService, DbService, AlertsService, OpsService, UsageService, ImagesService, PortfolioService, WorkshopService, WorkshopBackupService, SpotifyService, MusicService, ElevenLabsService, DeepgramService, DeepSeekService, ToolsService, OwnerService, PlaneMcpService, WhatsAppService, KnowledgeService, LeadsService, VisitsService, CardsService, MemoryService, SessionGateway, WaChatService, SettingsService, DecisionsService, CapableModelService, PolicyService, ActionsService, ApprovalsService, CatalogService, TelegramService, OptOutService, InjectionGuard],
})
export class AppModule {}
