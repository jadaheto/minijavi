/**
 * Errores de Claude Code dichos en español y con lo que hay que hacer (T2, 2026-11-19). Los patrones vienen de
 * `system-messages.ts` del proyecto Claude Workspace de Javier; NO estan verificados uno por uno contra los mensajes
 * reales de esta version de Claude Code. Si ninguno coincide, se deja el texto original.
 */
const RULES: { pattern: RegExp; say: (m: RegExpMatchArray) => string }[] = [
  { pattern: /you'?ve hit your (?:session|usage|weekly)? ?limit(?:\s*[·\-—]\s*resets?\s*(?:at\s*)?([^\n.]+))?/i,
    say: (m) => `se alcanzó el límite de uso de la suscripción de Claude${m[1] ? `; se restablece ${m[1].trim().replace(/\bam\b/i, 'a. m.').replace(/\bpm\b/i, 'p. m.')}` : ''}. Hay que esperar o usar un modelo más liviano` },
  { pattern: /invalid (?:x-)?api[- ]?key|authentication_error|invalid bearer token|oauth token (?:has )?expired|credential.*(?:invalid|expired)|\b401\b/i,
    say: () => 'la credencial de Claude Code no es válida o venció. Hay que generar otra con "claude setup-token" y ponerla en CLAUDE_CODE_OAUTH_TOKEN' },
  { pattern: /credit balance is too low|insufficient credits?/i, say: () => 'la cuenta de Claude no tiene saldo' },
  { pattern: /overloaded|\b529\b/i, say: () => 'el servicio de Claude está saturado. Se puede reintentar en unos minutos' },
  { pattern: /rate limit|too many requests|\b429\b/i, say: () => 'Claude recibió demasiadas solicitudes seguidas. Se puede reintentar en un momento' },
  { pattern: /prompt is too long|context.*too (?:long|large)|maximum context/i, say: () => 'la conversación del proyecto ya no cabe en el contexto. El siguiente encargo debería empezar una sesión nueva' },
  { pattern: /fetch failed|network error|econnrefused|enotfound|socket hang up|econnreset|getaddrinfo/i, say: () => 'el servidor no pudo conectarse con Claude (problema de red)' },
  { pattern: /request timed out|timed? ?out|deadline exceeded/i, say: () => 'la solicitud a Claude tardó demasiado y se cortó' },
];

/** Explicacion en español si el texto coincide con un error conocido; si no, undefined. */
export function explainClaudeError(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  for (const r of RULES) { const m = text.match(r.pattern); if (m) return r.say(m); }
  return undefined;
}
