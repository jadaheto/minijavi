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
import { TeslaService } from './tesla/tesla.service';
import { TeslaController } from './tesla/tesla.controller';
import { NewsService } from './news/news.service';
import { ColombiaNewsService } from './news/colombia.service';
import { PolymarketService } from './markets/polymarket.service';
import { PanelsService } from './panels/panels.service';
import { MapsService } from './maps/maps.service';
import { MapsController } from './maps/maps.controller';
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
import { BriefService } from './brief/brief.service';
import { DemoDocsService } from './demo/demo-docs.service';
import { DemoDocsController } from './demo/demo-docs.controller';
import { AvatarOwnerController, AvatarRequestsController } from './avatars/avatar-requests.controller';
import { AvatarRequestsService } from './avatars/avatar-requests.service';
import { AvatarGeneratorService } from './avatars/avatar-generator.service';
import { AvatarCareService } from './avatars/avatar-care.service';
import { ConnectionsController } from './connections/connections.controller';
import { ConnectionsService } from './connections/connections.service';
import { DemoPageController } from './demo/demo-page.controller';
import { DemoSendService } from './demo/demo-send.service';
import { BusinessService } from './business/business.service';
import { BusinessController } from './business/business.controller';
import { BusinessDeskService } from './business/desk.service';
import { BusinessPanelController } from './business/panel.controller';
import { PortfolioService } from './portfolio/portfolio.service';
import { VisitsService } from './visits/visits.service';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      exclude: ['/health', '/owner/{*path}', '/webhooks/{*path}', '/knowledge/{*path}', '/n8n/{*path}', '/p/{*path}', '/imagenes/{*path}', '/formulario', '/api/{*path}', '/mapas/{*path}', '/demo/{*path}', '/negocio/{*path}'],
    }),
  ],
  controllers: [ConnectionsController, AvatarRequestsController, AvatarOwnerController, DemoDocsController, DemoPageController, BusinessController, BusinessPanelController, HealthController, OwnerController, CallsController, KnowledgeController, N8nController, SitesController, WorkshopBackupController, SpotifyController, TeslaController, MapsController],
  providers: [ConfigService, DbService, AlertsService, OpsService, UsageService, ImagesService, PortfolioService, WorkshopService, WorkshopBackupService, SpotifyService, TeslaService, NewsService, ColombiaNewsService, PolymarketService, PanelsService, MapsService, BriefService, DemoDocsService, DemoSendService, AvatarRequestsService, AvatarGeneratorService, AvatarCareService, ConnectionsService, BusinessService, BusinessDeskService, MusicService, ElevenLabsService, DeepgramService, DeepSeekService, ToolsService, OwnerService, PlaneMcpService, WhatsAppService, KnowledgeService, LeadsService, VisitsService, CardsService, MemoryService, SessionGateway, WaChatService, SettingsService, DecisionsService, CapableModelService, PolicyService, ActionsService, ApprovalsService, CatalogService, TelegramService, OptOutService, InjectionGuard],
})
export class AppModule {}
