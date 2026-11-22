import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BusinessConfig, loadBusiness } from '../business/business';

/** Configuracion leida de variables de entorno y validada al arrancar. Las claves nunca salen del backend. */
@Injectable()
export class ConfigService {
  readonly port: number;
  /** Vacio = sin codigo de acceso. */
  readonly accessCode: string;
  readonly elevenApiKey: string;
  readonly elevenVoiceId: string;
  /** Voz: 'elevenlabs' (audio desde el servidor) o 'browser' (la voz del navegador). Sin clave de ElevenLabs es 'browser'. */
  readonly ttsProvider: 'elevenlabs' | 'browser';
  readonly browserVoice: string;
  readonly browserVoiceRate: number;
  readonly elevenModelId: string;
  readonly deepgramApiKey: string;
  readonly deepgramModel: string;
  readonly deepgramLanguage: string;
  readonly deepseekApiKey: string;
  readonly deepseekModel: string;
  readonly systemPrompt: string;
  readonly greeting: string;
  readonly timezone: string;
  readonly defaultCity: string;
  /** Clave para registrar dispositivos del dueño. Vacia = modo dueño desactivado. */
  readonly ownerSecret: string;
  readonly ownerDays: number;
  readonly ownerPrompt: string;
  /** Habla costeña: reglas y diccionario que se agregan al prompt ('' = apagada). HABLA_COSTENA=1 y HABLA_COSTENA_NIVEL. */
  readonly costenoPrompt: string;
  readonly dataDir: string;
  readonly planeMcpUrl: string;
  readonly planeApiKey: string;
  /** URL opcional a la que se avisa cada interesado nuevo (por ejemplo un webhook de n8n). */
  readonly leadsWebhookUrl: string;
  /** Bot de Telegram que avisa cada interesado nuevo. Ambos vacios = sin aviso. */
  readonly telegramBotToken: string;
  readonly telegramChatId: string;
  /** Escuchar los botones de Telegram (aprobar / rechazar). Solo un proceso por bot: en local, 0. */
  readonly telegramButtons: boolean;
  /** Direccion del QR de contacto (por ejemplo un enlace de WhatsApp). Vacia = sin QR. */
  /** WhatsApp Cloud API: plantilla que se envia a cada interesado. Sin token = desactivado. */
  readonly whatsappToken: string;
  readonly whatsappPhoneNumberId: string;
  readonly whatsappTemplate: string;
  readonly whatsappTemplateLang: string;
  /** Plantilla con el enlace de la demo (B3): cabecera con la imagen del negocio, {{1}} nombre, {{2}} negocio, boton /demo/{{1}}. */
  readonly whatsappDemoTemplate: string;
  readonly whatsappDemoTemplateLang: string;
  readonly whatsappHeaderImageUrl: string;
  readonly whatsappApiVersion: string;
  readonly whatsappDefaultCountry: string;
  /** Webhook de llamadas: token de verificacion, secreto de la app (firma de Meta) y secreto para eventos reenviados. */
  readonly whatsappVerifyToken: string;
  readonly whatsappAppSecret: string;
  readonly whatsappForwardSecret: string;
  /** Llamadas: modo (rechazar | prueba), IP publica del VPS, rango de puertos UDP del audio y limites. */
  /** n8n: webhook al que se reenvian los mensajes de WhatsApp y secreto compartido (cabecera X-Forward-Secret). */
  readonly n8nWebhookUrl: string;
  readonly n8nSecret: string;
  /** Negocio al que pertenecen los datos nuevos (decisiones, ajustes). Hoy hay uno solo; las tablas ya lo llevan. */
  readonly businessId: string;
  /** Jev (TypeSafe) decide si hay clave; sin ella la capa de decisiones usa DeepSeek. */
  readonly jevApiKey: string;
  readonly jevModel: string;
  /** Modelo capaz para encargos largos del dueño, de cualquier proveedor (ver llm/capable.service.ts). Sin proveedor = no existe. */
  readonly capableProvider: string;
  readonly capableModel: string;
  readonly capableKey: string;
  readonly capableUrl: string;
  /** '' = lo propio del proveedor; 'chat' o 'responses' fuerza la API de OpenAI que se usa. */
  readonly capableApi: string;
  /** Campos extra para el cuerpo de la peticion (JSON), por ejemplo {"reasoning_effort":"low"}. */
  readonly capableExtra: Record<string, unknown>;
  /** Segundos que se espera a que el modelo capaz EMPIECE a responder; pasado ese tiempo el turno sigue con el modelo de siempre. */
  readonly capableWaitSeconds: number;
  /** Dias que se conserva el registro de decisiones. */
  readonly decisionsKeepDays: number;
  /** Quien responde los mensajes de WhatsApp: 'avatar' (por defecto), 'n8n' (se reenvian a N8N_WEBHOOK_URL) u 'off'. */
  readonly whatsappReplies: 'avatar' | 'n8n' | 'off';
  /** Minutos sin mensajes para dar por cerrado un chat de WhatsApp (resumen, embudo e informe). */
  readonly waIdleMinutes: number;
  /** Tope de mensajes que se le responden a un mismo numero por hora. */
  readonly waMaxPerHour: number;
  /** Taller de programacion (solo modo dueño): Claude Code con la suscripcion de Javier. Sin token = desactivado. */
  readonly claudeToken: string;
  readonly claudeBin: string;
  readonly claudeModel: string;
  /** Usuario del sistema con el que corre Claude Code (via sudo). Vacio = el mismo usuario del avatar (solo para local). */
  readonly tallerUser: string;
  readonly tallerMaxMinutes: number;
  readonly tallerMaxTurns: number;
  readonly tallerMaxProjects: number;
  readonly tallerNice: number;
  /** Cada cuantos segundos el avatar cuenta en voz como va el encargo (0 = no lo cuenta solo). */
  readonly tallerStatusSeconds: number;
  /** Musica de YouTube en modo dueño. Sin clave = sin musica. */
  readonly youtubeApiKey: string;
  /** Spotify como primera fuente de musica (la cuenta se conecta desde el panel). Faltando alguna = solo YouTube. */
  readonly spotifyClientId: string;
  readonly spotifyClientSecret: string;
  readonly spotifyRedirectUri: string;
  readonly spotifyMarket: string;
  /** Tesla (solo lectura, modo dueño). La cuenta se conecta desde el panel. Faltando alguna = sin Tesla. */
  readonly teslaClientId: string;
  readonly teslaClientSecret: string;
  readonly teslaRedirectUri: string;
  readonly teslaApiUrl: string;
  readonly teslaDailyCalls: number;
  /** Noticias de IA: webhook (https) que devuelve la pagina del boletin, y hora local desde la que se piden una vez al dia. */
  readonly newsUrl: string;
  readonly newsHour: number;
  /** Noticias de Colombia (Forbes, Blu Radio, El País, Pulzo), leidas por el servidor. NOTICIAS_COLOMBIA=0 las apaga. */
  readonly newsColombia: boolean;
  readonly newsColombiaMinutes: number;
  /** Medios cuya pagina se puede abrir para leer una nota completa (dominios, sin www). */
  readonly newsDomains: string[];
  /** Mercados de prediccion (Polymarket), solo consulta y solo modo dueño. Apagado salvo POLYMARKET=1. */
  readonly polymarket: boolean;
  readonly polymarketTopics: string[];
  /** Mapas (trayectos e imagen del mapa: clave de Google que NO sale del servidor) y cargadores (Open Charge Map). Solo modo dueño. */
  readonly googleMapsKey: string;
  readonly googleMapsMapId: string;
  readonly openChargeMapKey: string;
  readonly mapsDailyCalls: number;
  /** Proyecto de Plane que abre el tablero cuando Javier no dice cual (nombre o identificador). */
  readonly planeBoardProject: string;
  readonly musicDefaultQuery: string;
  readonly musicVolume: number;
  readonly musicDailySearches: number;
  readonly musicMaxMinutes: number;
  readonly suspendMaxMinutes: number;
  /** Modo carro (?carro=1): segundos tras cada respuesta en que se puede seguir sin decir el nombre, y tope de la sesion. */
  readonly carFollowSeconds: number;
  readonly carMaxMinutes: number;
  /** Umbral de volumen (0..1) de la compuerta del microfono en esperas largas; 0 = sin compuerta. */
  readonly micGateRms: number;
  /** PostgreSQL (postgres://usuario:clave@host:5432/base). Vacio = SQLite en DATA_DIR. */
  readonly databaseUrl: string;
  /** Vigilancia, respaldo diario y seguimiento de interesados (horas en la zona de Javier; -1 = apagado). */
  readonly alertCheckMinutes: number;
  readonly alertDeepseekBalance: number;
  readonly backupHour: number;
  readonly backupKeep: number;
  readonly backupTelegram: boolean;
  readonly followupHour: number;
  readonly followupDays: number;
  /** Resumen de la mañana por Telegram (pedido por Javier el 2026-11-21): hora local (-1 = apagado), dias (1 = lunes ... 7 = domingo) y si va tambien como nota de voz. */
  readonly briefHour: number;
  readonly briefDays: number[];
  readonly briefVoice: boolean;
  /** MODO=negocio: este servicio es el asistente de un cliente (archivo NEGOCIO_ARCHIVO, por defecto DATA_DIR/negocio.json). undefined = minijavi de Javier. */
  readonly business?: BusinessConfig;
  /** Clave con la que Javier lee el consumo de este cliente (GET /api/consumo). Vacia = apagado. */
  readonly reportSecret: string;
  /** Clave del panel del cliente en modo negocio (NEGOCIO_PANEL_CLAVE, minimo 12). Vacia = sin panel. */
  readonly businessPanelKey: string;
  /** "Crea tu propio asistente": documentos subidos a una demo (DEMO_DOCUMENTOS=0 lo apaga). Topes de tamaño, paginas, por IP, por dia y dias que se guardan. */
  readonly demoDocs: boolean;
  readonly demoDocMb: number;
  readonly demoDocPages: number;
  readonly demoDocPerIpHour: number;
  readonly demoDocDaily: number;
  readonly demoDocDays: number;
  /** Enlace /demo/<id> (B2): voz del asistente del negocio, minutos por conversacion y minutos por dia de cada demo. */
  readonly demoVoiceId: string;
  /** Avatares personalizados con foto (pago por Bre-B, aprobacion de Javier). */
  readonly avatarCustom: boolean;
  readonly avatarPrice: number;
  readonly avatarBrebKey: string;
  readonly avatarPhotoMb: number;
  readonly avatarPerIpHour: number;
  readonly avatarProofs: number;
  readonly avatarAttempts: number;
  readonly avatarDemoDays: number;
  readonly demoPageMinutes: number;
  readonly demoPageDailyMinutes: number;
  /** Tope de minutos de voz al dia entre TODAS las demos (cada minuto cuesta escucha, modelo y voz). */
  readonly demoPageTotalMinutes: number;
  /** Al cerrar una conversacion publica: analizarla con el modelo y avisar por Telegram si mostro interes. */
  readonly visitReports: boolean;
  /** Guardar tambien las conversaciones del sitio (no solo las llamadas). Apagado por defecto: implica avisar a los visitantes. */
  readonly saveConversations: boolean;
  /** Si la revision del sitio encuentra fallos, devolverselos una vez a Claude Code antes de avisar. */
  readonly tallerAutoFix: boolean;
  /** Ciclo del encargo: pasadas como maximo, comprobaciones seguidas sin cambios que lo detienen, y tope por comando de comprobacion. */
  readonly tallerMaxPasses: number;
  readonly tallerNoProgress: number;
  readonly tallerGateSeconds: number;
  /** npm con el que el servidor ejecuta las comprobaciones (en Docker, la ruta exacta que permite sudo). */
  readonly npmBin: string;
  /** Revisor independiente al cerrar un encargo (otro Claude Code, solo lectura). Informa, no bloquea. Modelo vacio = el del encargo. */
  readonly tallerReview: boolean;
  readonly tallerReviewSeconds: number;
  readonly tallerReviewModel: string;
  /** Respaldo del taller con el modelo capaz cuando la suscripcion de Claude no puede trabajar (se cobra por uso). */
  readonly tallerBackup: boolean;
  readonly tallerBackupDaily: number;
  /** Modelo "auto": del nivel mas bajo al mas alto, que modelo usa cada uno. Y tope de la auditoria (tres lectores en paralelo). */
  readonly tallerAutoModels: string[];
  readonly tallerAuditSeconds: number;
  /** Historial git de cada proyecto (fuera de su carpeta) y publicacion en GitHub desde el panel (solo con token). */
  readonly tallerGit: boolean;
  readonly tallerGitName: string;
  readonly tallerGitEmail: string;
  readonly tallerGithubToken: string;
  readonly tallerGithubApi: string;
  readonly tallerGithubUrl: string;
  /** Encargos por sesion de Claude Code antes de empezar una nueva (que arranca leyendo ESTADO.md). */
  readonly tallerSessionJobs: number;
  /** Fotos de Unsplash (vacia = sin busqueda) y generacion con Magnific (vacia = sin generacion). Topes por conversacion de visitante y por dia. */
  readonly unsplashAccessKey: string;
  readonly magnificApiKey: string;
  readonly imagesDailyGenerations: number;
  /** Generacion con OpenAI (va PRIMERO; Magnific queda de respaldo). Clave: OPENAI_API_KEY o la del modelo capaz si es de OpenAI. */
  readonly imageOpenAiKey: string;
  readonly imageOpenAiModel: string;
  readonly imageOpenAiQuality: string;
  readonly imagesPerSession: number;
  readonly imagesDailySearches: number;
  /** Precio en dolares por unidad de cada medida de consumo (opcional): USAGE_PRICES='{"deepgram_s":0.0001}'. */
  readonly usagePrices: Record<string, number>;
  readonly wakeWords: string[];
  /** Direccion publica del avatar (para enlaces y QR). Vacia = se toma de la conexion. */
  readonly publicUrl: string;
  readonly callMode: string;
  readonly callPublicIp: string;
  readonly callPortMin: number;
  readonly callPortMax: number;
  readonly callMax: number;
  readonly callTestSeconds: number;
  /** Base de conocimiento: embeddings de NVIDIA + Qdrant. Sin clave o sin direccion = desactivada. */
  readonly nvidiaApiKey: string;
  readonly embedModel: string;
  readonly qdrantUrl: string;
  readonly qdrantApiKey: string;
  readonly qdrantCollection: string;
  readonly knowledgeDir: string;
  readonly knowledgeTopK: number;
  readonly knowledgeMinScore: number;
  readonly contactUrl: string;
  readonly contactTitle: string;
  readonly contactCaption: string;
  readonly cardsFile: string;
  /** Tarjetas en pantalla (servicios y QR). Apagadas por defecto. */
  readonly cardsEnabled: boolean;
  /** Dias que se recuerda a un visitante (0 = sin memoria). */
  readonly visitorMemoryDays: number;
  readonly maxSessions: number;
  readonly sessionMaxSeconds: number;
  readonly idleSeconds: number;
  readonly bargeInWords: number;

  constructor() {
    const env = process.env;
    const str = (name: string, def = '') => (env[name] ?? def).trim();
    const required = (name: string): string => {
      const v = str(name);
      if (!v) throw new Error(`Falta la variable de entorno ${name}`);
      return v;
    };
    const int = (name: string, def: number, min = 0): number => {
      const v = Number(str(name, String(def)));
      if (!Number.isInteger(v) || v < min) throw new Error(`${name} debe ser un entero >= ${min}`);
      return v;
    };
    this.port = int('PORT', 3000, 1);
    this.accessCode = str('ACCESS_CODE');
    this.elevenApiKey = str('ELEVENLABS_API_KEY');
    this.elevenVoiceId = str('ELEVENLABS_VOICE_ID');
    // Sin clave (o sin voz) de ElevenLabs habla el navegador; TTS_PROVIDER=browser lo fuerza aunque haya clave.
    const wanted = str('TTS_PROVIDER').toLowerCase();
    if (wanted && wanted !== 'browser' && wanted !== 'elevenlabs') throw new Error('TTS_PROVIDER debe ser elevenlabs o browser');
    if (wanted === 'elevenlabs' && !(this.elevenApiKey && this.elevenVoiceId)) throw new Error('TTS_PROVIDER=elevenlabs necesita ELEVENLABS_API_KEY y ELEVENLABS_VOICE_ID');
    this.ttsProvider = wanted === 'browser' || !(this.elevenApiKey && this.elevenVoiceId) ? 'browser' : 'elevenlabs';
    this.browserVoice = str('BROWSER_VOICE');
    this.browserVoiceRate = Number(str('BROWSER_VOICE_RATE', '1')) || 1;
    this.elevenModelId = str('ELEVENLABS_MODEL_ID', 'eleven_v4_turbo');
    this.deepgramApiKey = required('DEEPGRAM_API_KEY');
    this.deepgramModel = str('DEEPGRAM_MODEL', 'nova-3');
    this.deepgramLanguage = str('DEEPGRAM_LANGUAGE', 'multi');
    this.deepseekApiKey = required('DEEPSEEK_API_KEY');
    this.deepseekModel = str('DEEPSEEK_MODEL', 'deepseek-flash');
    this.timezone = str('TIMEZONE', 'America/Bogota');
    this.defaultCity = str('DEFAULT_CITY', 'Sincelejo');
    this.greeting = str('GREETING', '¡Hola! Soy Javier. ¿De qué quieres hablar?');
    this.maxSessions = int('MAX_SESSIONS', 2, 1);
    this.sessionMaxSeconds = int('SESSION_MAX_SECONDS', 600, 10);
    this.idleSeconds = int('IDLE_SECONDS', 120, 10);
    this.bargeInWords = int('BARGE_IN_WORDS', 3, 1);

    this.ownerSecret = str('OWNER_SECRET');
    this.ownerDays = int('OWNER_DAYS', 90, 1);
    this.dataDir = str('DATA_DIR', 'data');
    this.planeMcpUrl = str('PLANE_MCP_URL');
    this.planeApiKey = str('PLANE_API_KEY');
    this.leadsWebhookUrl = str('LEADS_WEBHOOK_URL');
    this.telegramBotToken = str('TELEGRAM_BOT_TOKEN');
    this.telegramChatId = str('TELEGRAM_CHAT_ID');
    this.telegramButtons = str('TELEGRAM_BUTTONS', '1') !== '0';
    this.whatsappToken = str('WHATSAPP_TOKEN');
    this.whatsappPhoneNumberId = str('WHATSAPP_PHONE_NUMBER_ID');
    this.whatsappTemplate = str('WHATSAPP_TEMPLATE');
    this.whatsappTemplateLang = str('WHATSAPP_TEMPLATE_LANG', 'es_MX');
    this.whatsappDemoTemplate = str('WHATSAPP_PLANTILLA_DEMO', 'minijavi_demo');
    this.whatsappDemoTemplateLang = str('WHATSAPP_PLANTILLA_DEMO_IDIOMA', 'es');
    this.whatsappHeaderImageUrl = str('WHATSAPP_HEADER_IMAGE_URL');
    this.whatsappApiVersion = str('WHATSAPP_API_VERSION', 'v27.0');
    this.whatsappDefaultCountry = str('WHATSAPP_DEFAULT_COUNTRY', '57');
    this.whatsappVerifyToken = str('WHATSAPP_VERIFY_TOKEN');
    this.whatsappAppSecret = str('WHATSAPP_APP_SECRET');
    this.whatsappForwardSecret = str('WHATSAPP_FORWARD_SECRET');
    this.n8nWebhookUrl = str('N8N_WEBHOOK_URL');
    this.n8nSecret = str('N8N_SECRET');
    this.businessId = str('BUSINESS_ID', 'principal').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'principal';
    this.jevApiKey = str('JEV_API_KEY');
    this.jevModel = str('JEV_MODEL', 'jev-1.14.0');
    this.capableProvider = str('MODELO_CAPAZ_PROVEEDOR').toLowerCase();
    this.capableModel = str('MODELO_CAPAZ');
    this.capableKey = str('MODELO_CAPAZ_KEY');
    this.capableUrl = str('MODELO_CAPAZ_URL').replace(/\/+$/, '');
    this.capableApi = ['chat', 'responses'].includes(str('MODELO_CAPAZ_API').toLowerCase()) ? str('MODELO_CAPAZ_API').toLowerCase() : '';
    let extra: unknown = {};
    try { extra = JSON.parse(str('MODELO_CAPAZ_EXTRA') || '{}'); } catch { throw new Error('MODELO_CAPAZ_EXTRA debe ser un objeto JSON, por ejemplo {"reasoning_effort":"low"}'); }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('MODELO_CAPAZ_EXTRA debe ser un objeto JSON');
    this.capableExtra = extra as Record<string, unknown>;
    this.capableWaitSeconds = int('MODELO_CAPAZ_ESPERA_S', 8, 1);
    this.decisionsKeepDays = int('DECISIONS_KEEP_DAYS', 90, 1);
    const replies = str('WHATSAPP_REPLIES', 'avatar').toLowerCase();
    this.whatsappReplies = replies === 'n8n' || replies === 'off' ? replies : 'avatar';
    this.waIdleMinutes = int('WHATSAPP_IDLE_MINUTES', 30, 2);
    this.waMaxPerHour = int('WHATSAPP_MAX_PER_HOUR', 40, 1);
    this.claudeToken = str('CLAUDE_CODE_OAUTH_TOKEN');
    this.claudeBin = str('CLAUDE_BIN', 'claude');
    this.claudeModel = str('CLAUDE_MODEL', 'claude-opus-5-5');
    this.tallerUser = str('TALLER_USER');
    this.tallerMaxMinutes = int('TALLER_MAX_MINUTES', 30, 1);
    this.tallerStatusSeconds = int('TALLER_STATUS_SECONDS', 90, 0);
    this.tallerMaxTurns = int('TALLER_MAX_TURNS', 200, 1);
    this.tallerMaxProjects = int('TALLER_MAX_PROJECTS', 50, 1);
    this.tallerNice = int('TALLER_NICE', 10, 0);
    this.youtubeApiKey = str('YOUTUBE_API_KEY');
    const spotifyOn = str('SPOTIFY', '1') !== '0';
    this.spotifyClientId = spotifyOn ? str('SPOTIFY_CLIENT_ID') : '';
    this.spotifyClientSecret = spotifyOn ? str('SPOTIFY_CLIENT_SECRET') : '';
    this.spotifyRedirectUri = spotifyOn ? str('SPOTIFY_REDIRECT_URI') : '';
    this.newsUrl = /^https:\/\/[^\s]+$/.test(str('NOTICIAS_URL')) ? str('NOTICIAS_URL') : '';
    this.newsHour = Math.min(23, int('NOTICIAS_HORA', 6, 0));
    this.newsColombia = str('NOTICIAS_COLOMBIA', '1') !== '0';
    this.newsColombiaMinutes = int('NOTICIAS_COLOMBIA_MINUTOS', 60, 10);
    this.newsDomains = str('NOTICIAS_DOMINIOS', 'theguardian.com,technologyreview.com,arstechnica.com,theverge.com,techcrunch.com,xataka.com').toLowerCase().split(',').map((d) => d.trim().replace(/^www\./, '')).filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d));
    this.planeBoardProject = str('PLANE_TABLERO_PROYECTO');
    this.googleMapsKey = str('GOOGLE_MAPS_KEY') || str('GOOGLE_MAPS_EMBED_KEY');
    this.googleMapsMapId = /^[A-Za-z0-9_-]{4,64}$/.test(str('GOOGLE_MAPS_MAP_ID')) ? str('GOOGLE_MAPS_MAP_ID') : '';
    this.openChargeMapKey = str('OPENCHARGEMAP_API_KEY');
    this.mapsDailyCalls = int('MAPAS_CONSULTAS_DIA', 150, 1);
    this.polymarket = str('POLYMARKET', '0') === '1';
    this.polymarketTopics = str('POLYMARKET_TEMAS', 'ai,tech,crypto,economy,politics,geopolitics').toLowerCase().split(',').map((t) => t.trim()).filter((t) => /^[a-z0-9-]{2,40}$/.test(t)).slice(0, 8);
    const teslaOn = str('TESLA', '1') !== '0';
    this.teslaClientId = teslaOn ? str('TESLA_CLIENT_ID') : '';
    this.teslaClientSecret = teslaOn ? str('TESLA_CLIENT_SECRET') : '';
    this.teslaRedirectUri = teslaOn ? str('TESLA_REDIRECT_URI') : '';
    // Region inicial (Norteamerica y Asia-Pacifico); al conectar, Tesla dice la region real de la cuenta.
    this.teslaApiUrl = /^https:\/\/fleet-api\.prd\.[a-z]{2}\.vn\.cloud\.tesla\.(com|cn)$/.test(str('TESLA_API_URL')) ? str('TESLA_API_URL') : 'https://fleet-api.prd.na.vn.cloud.tesla.com';
    this.teslaDailyCalls = int('TESLA_CONSULTAS_DIA', 60, 1);
    this.spotifyMarket = /^[A-Za-z]{2}$/.test(str('SPOTIFY_MARKET')) ? str('SPOTIFY_MARKET').toUpperCase() : 'CO';
    this.musicDefaultQuery = str('MUSIC_DEFAULT_QUERY', 'lofi para programar');
    this.musicVolume = Math.min(100, int('MUSIC_VOLUME', 15, 0));
    this.musicDailySearches = int('MUSIC_DAILY_SEARCHES', 80, 1);
    this.musicMaxMinutes = int('MUSIC_MAX_MINUTES', 90, 1);
    this.suspendMaxMinutes = int('SUSPEND_MAX_MINUTES', 120, 1);
    this.carFollowSeconds = Math.min(60, int('CARRO_SEGUIR_SEGUNDOS', 8, 0));
    this.carMaxMinutes = int('CARRO_MAX_MINUTOS', 180, 1);
    this.micGateRms = process.env.MIC_GATE === '0' ? 0 : Math.min(0.2, Math.max(0.002, Number(process.env.MIC_GATE_RMS) || 0.012));
    this.tallerAutoFix = process.env.TALLER_AUTO_FIX !== '0';
    this.tallerSessionJobs = int('TALLER_SESSION_JOBS', 4, 1);
    this.tallerMaxPasses = Math.min(10, int('TALLER_MAX_PASSES', 4, 1));
    this.tallerNoProgress = int('TALLER_NO_PROGRESS', 2, 2);
    this.tallerGateSeconds = int('TALLER_GATE_SECONDS', 300, 5);
    this.npmBin = str('NPM_BIN', this.tallerUser ? '/usr/local/bin/npm' : 'npm');
    this.tallerReview = process.env.TALLER_REVIEW !== '0';
    this.tallerReviewSeconds = int('TALLER_REVIEW_SECONDS', 240, 30);
    this.tallerReviewModel = str('TALLER_REVIEW_MODEL');
    this.tallerBackup = str('TALLER_RESPALDO', '1') !== '0';
    this.tallerBackupDaily = int('TALLER_RESPALDO_DIA', 0, 0);
    this.tallerAutoModels = str('TALLER_AUTO_MODELS', 'haiku,sonnet,opus').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 3);
    this.tallerAuditSeconds = int('TALLER_AUDIT_SECONDS', 300, 30);
    this.tallerGit = process.env.TALLER_GIT !== '0';
    this.tallerGitName = str('TALLER_GIT_NAME', 'Taller de minijavi').slice(0, 60);
    this.tallerGitEmail = str('TALLER_GIT_EMAIL', 'taller-minijavi@users.noreply.github.com').slice(0, 100);
    this.tallerGithubToken = str('TALLER_GITHUB_TOKEN');
    this.tallerGithubApi = str('TALLER_GITHUB_API', 'https://api.github.com').replace(/\/+$/, '');
    this.tallerGithubUrl = str('TALLER_GITHUB_URL', 'https://github.com').replace(/\/+$/, '');
    this.unsplashAccessKey = (process.env.UNSPLASH_ACCESS_KEY ?? '').trim();
    this.magnificApiKey = (process.env.MAGNIFIC_API_KEY ?? '').trim();
    this.imagesDailyGenerations = int('IMAGES_DAILY_GENERATIONS', 60, 0); // cada pedido genera 3 versiones
    this.imageOpenAiKey = str('IMAGEN_OPENAI', '1') === '0' ? '' : str('OPENAI_API_KEY') || (this.capableProvider === 'openai' ? this.capableKey : '');
    this.imageOpenAiModel = str('IMAGEN_OPENAI_MODELO') || str('IMAGEN_RESPALDO_MODELO') || 'gpt-image-2.6-flare'; // IMAGEN_RESPALDO_MODELO: el nombre que usa Javier en su .env
    this.imageOpenAiQuality = ['low', 'medium', 'high'].includes(str('IMAGEN_OPENAI_CALIDAD').toLowerCase()) ? str('IMAGEN_OPENAI_CALIDAD').toLowerCase() : 'medium';
    this.imagesPerSession = int('IMAGES_PER_SESSION', 4, 0);
    this.imagesDailySearches = int('IMAGES_DAILY_SEARCHES', 150, 1);
    this.databaseUrl = (process.env.DATABASE_URL ?? '').trim();
    if (this.databaseUrl && !/^postgres(ql)?:\/\//.test(this.databaseUrl)) throw new Error('DATABASE_URL debe empezar por postgres://');
    this.saveConversations = process.env.SAVE_CONVERSATIONS === '1';
    const hour = (name: string, def: number) => { const v = Number(process.env[name] ?? def); return Number.isInteger(v) && v >= -1 && v <= 23 ? v : def; };
    this.alertCheckMinutes = int('ALERT_CHECK_MINUTES', 5, 0);
    this.alertDeepseekBalance = Math.max(0, Number(process.env.ALERT_DEEPSEEK_BALANCE ?? 2) || 0);
    this.backupHour = hour('BACKUP_HOUR', 3);
    this.backupKeep = int('BACKUP_KEEP', 14, 1);
    this.backupTelegram = process.env.BACKUP_TELEGRAM !== '0';
    this.followupHour = hour('FOLLOWUP_HOUR', 8);
    this.followupDays = int('FOLLOWUP_DAYS', 2, 1);
    this.briefHour = hour('RESUMEN_HORA', 7);
    this.briefDays = [...new Set(str('RESUMEN_DIAS', '1,2,3,4,5').split(',').map((d) => Number(d.trim())).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))];
    this.briefVoice = str('RESUMEN_VOZ', '1') !== '0';
    this.reportSecret = str('REPORTE_SECRET').length >= 16 ? str('REPORTE_SECRET') : '';
    this.businessPanelKey = str('NEGOCIO_PANEL_CLAVE').length >= 12 ? str('NEGOCIO_PANEL_CLAVE') : '';
    this.demoDocs = str('DEMO_DOCUMENTOS', '1') !== '0';
    this.demoDocMb = Math.min(40, int('DEMO_DOC_MB', 10, 1));
    this.demoDocPages = int('DEMO_DOC_PAGINAS', 20, 1);
    this.demoDocPerIpHour = int('DEMO_DOC_POR_IP_HORA', 3, 1);
    this.demoDocDaily = int('DEMO_DOC_DIA', 30, 1);
    this.demoDocDays = int('DEMO_DOC_DIAS', 7, 1);
    this.demoVoiceId = /^[A-Za-z0-9]{10,40}$/.test(str('DEMO_VOZ_ID', 'k1LcwPlB8fqtr2BOqzNo')) ? str('DEMO_VOZ_ID', 'k1LcwPlB8fqtr2BOqzNo') : '';
    this.avatarCustom = str('AVATAR_PROPIO', '1') !== '0';
    this.avatarPrice = int('AVATAR_PRECIO', 19200, 1);
    this.avatarBrebKey = str('AVATAR_BREB_LLAVE', '3004576744').replace(/[^0-9A-Za-z@._+-]/g, '').slice(0, 60);
    this.avatarPhotoMb = Math.min(20, int('AVATAR_FOTO_MB', 8, 1));
    this.avatarPerIpHour = int('AVATAR_POR_IP_HORA', 5, 1);
    this.avatarProofs = int('AVATAR_COMPROBANTES', 3, 1);
    this.avatarAttempts = Math.min(5, int('AVATAR_INTENTOS', 3, 1));
    this.avatarDemoDays = Math.min(90, int('AVATAR_DEMO_DIAS', 30, 1));
    this.demoPageMinutes = int('DEMO_MIN_CHARLA', 5, 1);
    this.demoPageDailyMinutes = int('DEMO_MIN_DIA', 30, 1);
    this.demoPageTotalMinutes = int('DEMO_MIN_DIA_TOTAL', 120, 1);
    this.visitReports = process.env.VISIT_REPORTS !== '0';
    this.usagePrices = {};
    try { for (const [k, v] of Object.entries(JSON.parse(process.env.USAGE_PRICES || '{}'))) if (Number(v) > 0) this.usagePrices[k] = Number(v); }
    catch { throw new Error('USAGE_PRICES debe ser un JSON como {"deepgram_s":0.0001}'); }
    // Palabra para despertar y las formas en que el reconocedor suele escribirla. La primera es la que se muestra.
    this.wakeWords = (process.env.WAKE_WORDS || 'javi,javier,xavi,havi,habi,jabi,jabe,javy,jaby,yavi,yabi').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(',').map((w) => w.trim()).filter(Boolean);
    this.publicUrl = str('PUBLIC_URL').replace(/\/+$/, '');
    this.callMode = str('CALL_MODE', 'rechazar').toLowerCase();
    // Una llamada de WhatsApp no tiene navegador: sin voz del servidor no se puede atender.
    if (this.ttsProvider === 'browser' && this.callMode === 'conversar') this.callMode = 'rechazar';
    this.callPublicIp = str('CALL_PUBLIC_IP');
    this.callPortMin = int('CALL_UDP_PORT_MIN', 40000, 1024);
    this.callPortMax = int('CALL_UDP_PORT_MAX', 40009, 1024);
    this.callMax = int('CALL_MAX', 2, 1);
    this.callTestSeconds = int('CALL_TEST_SECONDS', 20, 5);
    this.nvidiaApiKey = str('NVIDIA_API_KEY');
    this.embedModel = str('EMBED_MODEL', 'nvidia/nemotron-3.5-embed-8b');
    this.qdrantUrl = str('QDRANT_URL').replace(/\/+$/, '');
    this.qdrantApiKey = str('QDRANT_API_KEY') || str('QDRANT__SERVICE__API_KEY');
    this.qdrantCollection = str('QDRANT_COLLECTION', 'minijavi');
    this.knowledgeDir = str('KNOWLEDGE_DIR', 'conocimiento');
    this.knowledgeTopK = int('KNOWLEDGE_TOP_K', 3, 1);
    this.knowledgeMinScore = Number(str('KNOWLEDGE_MIN_SCORE', '0.25'));
    this.contactUrl = str('CONTACT_URL');
    this.contactTitle = str('CONTACT_TITLE', 'Hablemos por WhatsApp');
    this.contactCaption = str('CONTACT_CAPTION', 'Escanea para escribirle a Javier');
    this.cardsFile = str('CARDS_FILE', 'content/tarjetas.json');
    this.cardsEnabled = ['true', '1', 'si', 'sí'].includes(str('CARDS_ENABLED', 'false').toLowerCase());
    this.visitorMemoryDays = int('VISITOR_MEMORY_DAYS', 90, 0);
    const ownerFile = str('OWNER_PROMPT_FILE', 'prompts/owner.md');
    this.ownerPrompt = existsSync(ownerFile) ? readFileSync(ownerFile, 'utf8').trim() : '';
    // Habla costeña (pedido por Javier el 2026-11-18): diccionario "Costeñol" de la UTB, pasado a prompts/costenol.md.
    const costeno = ['1', 'true', 'si', 'sí', 'on'].includes(str('HABLA_COSTENA', '0').toLowerCase());
    const costenoFile = str('HABLA_COSTENA_FILE', 'prompts/costenol.md');
    const nivel = str('HABLA_COSTENA_NIVEL', 'suave').toLowerCase();
    const dosis = nivel === 'fuerte' ? 'Úsalas con frecuencia: casi todas tus respuestas llevan una o dos, y puedes comerte la "d" de los participios (cansao, pelao) como se habla en la costa.'
      : nivel === 'medio' ? 'Usa una expresión en más o menos la mitad de tus respuestas, cuando caiga natural.'
      : 'Úsalas con medida: una expresión cada dos o tres respuestas, solo cuando caiga natural; la mayoría de tus frases siguen en español neutro.';
    this.costenoPrompt = costeno && existsSync(costenoFile) ? `

HABLA COSTEÑA: eres de Sucre, en la costa Caribe de Colombia, y hablas como se habla allá. Estas son expresiones costeñas con su significado y un ejemplo. ${dosis}
- Sirven también para ENTENDER a quien las use contigo.
- Que suene a conversación de verdad, no a lista: nunca metas varias seguidas ni las expliques, salvo que te pregunten qué significa una.
- Con alguien que viene a preguntar por tus servicios, mantén el respeto: saludos y muletillas amables ("ajá", "bacano", "pri" si hay confianza), nada que suene a burla.
- Nunca le digas a la persona algo que la ofenda (maco, calilla, fulero, pringacara), ni en broma.
- Si la persona habla en otro idioma, responde en ese idioma sin estas expresiones.
- Las cifras, los datos de contacto y las confirmaciones (repetir un número, pedir autorización) van siempre claros y en español neutro.
Expresiones:
${readFileSync(costenoFile, 'utf8').trim()}` : '';
    const file = str('SYSTEM_PROMPT_FILE', 'prompts/system.md');
    this.systemPrompt = str('SYSTEM_PROMPT') || (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
    if (!this.systemPrompt) throw new Error('No hay system prompt: define SYSTEM_PROMPT o SYSTEM_PROMPT_FILE');
    // MODO=negocio: este servicio es el asistente de un cliente. Se apaga EN CODIGO todo lo que es de Javier, aunque las
    // variables vengan puestas por error: modo dueño, taller, sus cuentas y herramientas, avisos y envios propios.
    if (str('MODO').toLowerCase() === 'negocio') {
      const b = loadBusiness(str('NEGOCIO_ARCHIVO') || join(this.dataDir, 'negocio.json'));
      Object.assign(this as any, {
        business: b, greeting: b.saludo, elevenVoiceId: b.voz || this.elevenVoiceId, costenoPrompt: '',
        ownerSecret: '', claudeToken: '', planeMcpUrl: '', youtubeApiKey: '', spotifyClientId: '', spotifyClientSecret: '', teslaClientId: '', teslaClientSecret: '',
        googleMapsKey: '', openChargeMapKey: '', polymarket: false, newsUrl: '', newsColombia: false, unsplashAccessKey: '', magnificApiKey: '', imageOpenAiKey: '',
        briefHour: -1, followupHour: -1, demoDocs: false, avatarCustom: false, callMode: 'rechazar', whatsappReplies: this.whatsappReplies === 'avatar' ? 'avatar' : 'off', n8nWebhookUrl: '', leadsWebhookUrl: '', visitorMemoryDays: 0, visitReports: false,
      });
    }
  }
}
