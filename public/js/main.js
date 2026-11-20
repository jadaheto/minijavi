import { createAvatar } from './avatar.js';
import { SpeechPlayer, base64ToBytes } from './audio.js';
import { LipSync, VISEMES } from './lipsync.js';
import { startMic } from './mic.js';
import { connect } from './socket.js';
import { createBackdrop, emojiBurst, floatEmoji } from './fx.js';
import { createMusic, imageColor } from './music.js';
import { createTeslaPanel } from './tesla.js';
import { BrowserVoice } from './browser-voice.js';
import { createGate } from './mic-gate.js';

const $ = (id) => document.getElementById(id);
const STATE_TEXT = { idle: 'En espera', listening: 'Escuchando', thinking: 'Pensando', speaking: 'Hablando', away: 'Suspendido' };
const REQUIRED = [...VISEMES, 'mouthSmile', 'eyeBlink', 'browUp'];
const STANDBY_TEXT = 'Háblame o toca la pantalla para conversar';
const ERRORS = {
  codigo: 'Escribe el código de acceso.', ocupado: 'Estoy ocupado con otra persona. Intenta en un momento.',
  tiempo: 'Llegamos al tiempo máximo. Háblame para empezar otra conversación.', inactividad: '',
  escucha: 'Se perdió la conexión con el servicio de escucha. Háblame para reintentar.',
};

const avatar = await createAvatar($('stage'));
const missing = REQUIRED.filter((n) => !avatar.morphNames.includes(n));
if (missing.length) console.warn('Al modelo le faltan morph targets:', missing);
if (new URLSearchParams(location.search).get('subs') === '0') $('subtitles').classList.add('off'); // subtitulos opcionales: ?subs=0

const lips = new LipSync();
// Voz del navegador: se usa cuando el servidor avisa que no tiene voz propia (sin clave de ElevenLabs).
const browserVoice = new BrowserVoice(
  (chars, starts, ends) => { lips.add(chars, starts, ends); for (let i = 0; i < chars.length; i++) subChars.push({ c: chars[i], t: starts[i] }); },
  (t) => { lips.cut(t); subChars = subChars.filter((x) => x.t < t); subShown = Math.min(subShown, subChars.length); },
);
let serverPlayer = null; // reproductor del audio que manda el servidor (ElevenLabs)
// Musica de fondo (modo dueño): el servidor manda la cola; aqui suena en el mini reproductor y baja cuando alguien habla.
// Panel animado del Tesla (modo dueño): aparece cuando el avatar consulta el carro.
const tesla = createTeslaPanel($('tesla'));
// Vista previa del panel con datos de EJEMPLO (no consulta el carro): abrir con ?demo=tesla. Se repite para ver la animacion.
if (new URLSearchParams(location.search).get('demo') === 'tesla') {
  const demo = [
    { focus: 'bateria', name: 'Ejemplo', live: true, level: 64, rangeKm: 322, limit: 80, charging: 'Charging', minutesLeft: 90, kw: 11, locked: true, doors: [false, false, false, false], trunks: [false, false], windows: [false, false, false, false], sentry: true, inside: 27, outside: 31, climateOn: false, odoKm: 16093, version: '2026.32.1' },
    { focus: 'seguridad', name: 'Ejemplo', live: false, ageMin: 190, level: 17, rangeKm: 80, limit: 80, charging: 'Disconnected', locked: false, doors: [true, false, false, true], trunks: [false, true], windows: [true, false, false, false], sentry: false, inside: 34, outside: 31, climateOn: true, odoKm: 16093, version: '2026.32.1' },
    { focus: 'todo', name: 'Ejemplo', live: true, level: 41, rangeKm: 205, limit: 90, charging: 'Stopped', locked: true, doors: [false, false, false, false], trunks: [false, false], windows: [false, false, false, false], sentry: false, inside: 22, outside: 24, climateOn: true, odoKm: 16093, version: '2026.32.1' },
  ];
  let i = 0; const next = () => tesla.show(demo[i++ % demo.length]);
  setTimeout(() => { $('gate').hidden = true; next(); setInterval(next, 9000); }, 1500);
}
// Spotify: el reproductor web pide su token al servidor por el mismo socket (solo lo entrega en sesiones del dueño).
let tokenWaiters = [];
const spotifyToken = () => new Promise((resolve, reject) => {
  if (!socket) return reject(new Error('sin conexión'));
  tokenWaiters.push({ resolve, reject }); socket.send({ type: 'spotify_token' });
  setTimeout(() => reject(new Error('el servidor no entregó el token')), 8000);
});
// Con Spotify la caratula de lo que suena se ve grande y entera al lado del avatar (que se corre para no taparla), y el
// fondo toma su color. Sus reglas no permiten recortarla, difuminarla ni poner nada encima.
// El color se lee de la misma imagen ya cargada (las dos caratulas se piden con CORS: si una se pidiera sin el, el
// navegador reutilizaria esa copia y no dejaria leer el color).
let coverFor = '';
function setCover(track) {
  const bg = $('cover-bg'), art = $('cover-art'), img = art.querySelector('img'), url = track?.image || '';
  art.hidden = !url; document.body.classList.toggle('cover', !!url);
  if (!url) { coverFor = ''; bg.classList.remove('on'); return; }
  img.alt = `Carátula de ${track.album || track.title}`; art.href = track.url || 'https://open.spotify.com/'; art.title = 'Abrir en Spotify';
  if (coverFor === url) return;
  coverFor = url;
  const paint = (ok) => { if (coverFor !== url) return; const c = ok ? imageColor(img) : null; bg.style.backgroundColor = c ? `rgb(${c.join(',')})` : '#191414'; bg.classList.add('on'); }; // sin poder leerla: el color de Spotify
  img.onload = () => paint(true); img.onerror = () => paint(false);
  img.src = url;
}
const music = createMusic($('music'), (st) => socket?.send({ type: 'music', ...st }), { getToken: spotifyToken, onCover: setCover });
let duckUntil = 0;
function onMusic(msg) {
  if (msg.action === 'play') music.play(msg.queue, msg.index, msg.volume, msg.source);
  else if (msg.action === 'pause') music.pause();
  else if (msg.action === 'resume') music.resume();
  else if (msg.action === 'stop') music.stop();
  else if (msg.action === 'volume') music.setVolume(msg.volume);
}
// Taller de programacion (modo dueño): mientras Claude Code trabaja, el fondo es un editor, las gafas reflejan el
// codigo y arriba se ve en que va. Los fondos que pide una respuesta mandan mientras el avatar habla.
let work = null;
const restScene = () => (activity ? ACTIVITIES[activity].scene : work ? 'codigo' : null);
// Modo suspension: el avatar deja de responder (sigue oyendo solo su nombre) y se entretiene con una actividad que va
// rotando. `dormant`: la suspension ya vencio en el servidor; el microfono no se envia y solo despierta con un toque.
const ACTIVITIES = {
  juego: { scene: 'pong', label: '🏓 Jugando ping-pong' },
  dormir: { scene: 'noche', label: '😴 Durmiendo', emoji: ['💤'], every: 1.5 },
  leer: { scene: 'codigo', label: '📖 Leyendo código' },
  musica: { scene: 'ecualizador', label: '🎧 Oyendo música', emoji: ['🎵', '🎶'], every: 0.9 },
};
let suspended = false, dormant = false, wakeWord = 'Javi', activity = null, actUntil = 0, actQueue = [], floatAt = 0, startleAt = 0, awayNotice = '';
function setActivity(name) {
  if (name === activity) return;
  activity = name; avatar.setActivity(name);
  $('away').hidden = !name || !live;
  if (name) $('away-text').textContent = `${ACTIVITIES[name].label} · di «${wakeWord}» o toca la pantalla`;
  $('away-notice').textContent = awayNotice;
  if (state !== 'speaking') backdrop.show(restScene());
}
function setSuspended(on, notice) {
  suspended = !!on; awayNotice = on ? (notice || '') : '';
  $('away-notice').textContent = awayNotice;
  if (!on) { setActivity(null); if (state === 'away') setState(live ? 'listening' : 'idle'); }
  else { hideCard(); $('sub-user').textContent = ''; if (state !== 'speaking' && state !== 'thinking') setState('away'); }
}
const restState = () => (suspended || dormant ? 'away' : live ? 'listening' : 'idle');
/** Va cambiando de actividad cada medio minuto, mas o menos, sin repetir hasta haber pasado por todas. */
function runActivities(now) {
  if (state !== 'away') { if (activity) setActivity(null); actUntil = 0; return; }
  if (now >= actUntil) {
    if (!actQueue.length) actQueue = Object.keys(ACTIVITIES).sort(() => Math.random() - 0.5).filter((a, i) => i || a !== activity);
    setActivity(actQueue.shift()); actUntil = now + 26000 + Math.random() * 16000; startleAt = now + 9000 + Math.random() * 9000;
  }
  const a = ACTIVITIES[activity];
  if (a.emoji && now >= floatAt) { floatAt = now + a.every * 1000; floatEmoji($('fx'), a.emoji); }
  if (activity === 'juego') { const b = backdrop.ball; avatar.look(b.x * 0.9, b.y * 0.7); }
  if (activity === 'dormir' && now >= startleAt) { startleAt = now + 14000 + Math.random() * 12000; avatar.react('sorpresa'); } // se despierta sobresaltado y vuelve a dormirse
  if (activity === 'leer' && now >= startleAt) { startleAt = now + 8000 + Math.random() * 8000; avatar.react(Math.random() < 0.5 ? 'pensativo' : 'alegria'); }
}
function setWork(msg) {
  work = msg && msg.active ? msg : null;
  avatar.setWork(!!work, work?.code);
  $('work').hidden = !work;
  if (work) {
    const min = Math.floor((work.seconds || 0) / 60), sec = String((work.seconds || 0) % 60).padStart(2, '0');
    const agents = work.agentsTotal ? ` · ${work.agentsTotal} ${work.agentsTotal === 1 ? 'agente' : 'agentes'}` : '';
    $('work-text').textContent = `${work.project} · ${work.model} · ${min}:${sec} · ${work.steps} pasos${agents} · ${work.activity}`;
  }
  if (state !== 'speaking') backdrop.show(restScene());
}
const backdrop = createBackdrop($('backdrop'));
backdrop.onScore = (who) => { if (activity === 'juego') avatar.react(who === 'avatar' ? 'celebracion' : 'pena'); };
let audioCtx = null, player = null, socket = null, mic = null;
let state = 'idle', live = false, connecting = false, speechId = -1, subChars = [], subShown = 0, wasPlaying = false, closeReason = '';
// Modo espera: tras el primer toque el microfono queda abierto en el navegador (sin enviar nada). Cuando alguien habla,
// la conversacion arranca sola y lo que dijo mientras se conectaba se envia desde este pequeno buffer.
let armed = false, loud = 0, retryAt = 0;
const prebuffer = [];
// Compuerta del microfono: suspendido, o con musica o un encargo en curso y 20 s sin que nadie hable, el audio solo se
// envia cuando hay voz. El servidor decide si se usa y con que umbral (`ready.gate`).
let gate = null, lastTalk = 0;
const ecoMode = (now) => !!gate && (suspended || ((!!work || music.active || car) && state === 'listening' && now - lastTalk > 20000));

// Identificador al azar de este navegador, para que el avatar reconozca a quien vuelve. En un kiosco compartido se
// desactiva con ?kiosco=1 (todas las personas usarian el mismo navegador).
const KIOSK = new URLSearchParams(location.search).get('kiosco') === '1';
// Modo carro (?carro=1, pensado para el navegador del Tesla): el avatar solo atiende las frases que traen su nombre,
// como un asistente de voz; lo demas que se oiga en el carro se descarta en el servidor. Se recuerda en este navegador.
const carParam = new URLSearchParams(location.search).get('carro');
try { if (carParam === '1') localStorage.setItem('carro', '1'); else if (carParam === '0') localStorage.removeItem('carro'); } catch { /* sin almacenamiento */ }
const CAR = carParam === '1' || (carParam !== '0' && (() => { try { return localStorage.getItem('carro') === '1'; } catch { return false; } })());
let car = false;
function visitorId() {
  if (KIOSK) return undefined;
  try {
    let id = localStorage.getItem('minijavi_visitor');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('minijavi_visitor', id); }
    return id;
  } catch { return undefined; }
}
let cardTimer = null;
function showCard(card) {
  if (gallery) hideGallery(); // comparten el mismo lugar de la pantalla
  $('card-title').textContent = card.title || '';
  $('card-lines').replaceChildren(...(card.lines || []).map((t) => { const li = document.createElement('li'); li.textContent = t; return li; }));
  $('card-qr').hidden = !card.qr; if (card.qr) $('card-qr').src = card.qr;
  $('card-caption').textContent = card.caption || '';
  $('card').hidden = false;
  clearTimeout(cardTimer); cardTimer = setTimeout(hideCard, card.qr ? 30000 : 14000); // el QR se queda mas tiempo para alcanzar a escanearlo
}
function hideCard() { clearTimeout(cardTimer); $('card').hidden = true; }

// Galeria: fotos (Pexels) o bocetos en vivo (paginas del taller), numerados al lado del avatar. La seleccionada se pone
// ademas de fondo. Los bocetos van en iframes aislados (sandbox): son paginas escritas por Claude Code.
let gallery = null;
function frameOf(url) { const f = document.createElement('iframe'); f.src = url; f.setAttribute('sandbox', 'allow-scripts'); f.setAttribute('scrolling', 'no'); f.tabIndex = -1; f.loading = 'lazy'; f.title = ''; return f; }
function selectGallery(index, tell) {
  if (!gallery) return;
  gallery.index = Math.max(0, Math.min(gallery.items.length - 1, index));
  const item = gallery.items[gallery.index];
  [...$('gallery-items').children].forEach((el, i) => { el.classList.toggle('on', i === gallery.index); if (i === gallery.index) el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
  const bg = $('photo-bg');
  if (item.frame) bg.replaceChildren(frameOf(item.frame)); else { const img = new Image(); img.src = item.full || item.thumb; img.alt = ''; bg.replaceChildren(img); }
  bg.classList.add('on');
  const credit = $('gallery-credit'); credit.replaceChildren();
  if (gallery.kind === 'fotos') { // condiciones de Unsplash: credito al fotografo y a Unsplash, con enlace
    const a = document.createElement('a'); a.href = item.link || 'https://unsplash.com'; a.target = '_blank'; a.rel = 'noopener'; a.textContent = item.credit || 'Fotos de Unsplash';
    credit.append(a);
  } else credit.textContent = gallery.kind === 'generadas' ? `${item.credit || ''} · ${item.label || ''}` : item.label || '';
  if (tell) socket?.send({ type: 'gallery', index: gallery.index });
}
function showGallery(msg) {
  if (msg.action === 'hide' || !msg.items?.length) { hideGallery(); return; }
  if (msg.action === 'select' && gallery && gallery.items.length === msg.items.length) { selectGallery(msg.index, false); return; }
  gallery = { kind: msg.kind, items: msg.items, index: msg.index || 0 };
  hideCard(); $('gallery-title').textContent = msg.title || '';
  document.body.classList.add('showing'); // el avatar se achica a la esquina y la imagen se ve en grande
  $('gallery-items').replaceChildren(...msg.items.map((item, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'gallery-item'; b.setAttribute('aria-label', `${i + 1}: ${item.label || ''}`);
    if (item.frame) b.append(frameOf(item.frame)); else { const img = new Image(); img.src = item.thumb; img.alt = item.label || ''; img.loading = 'lazy'; b.append(img); }
    const num = document.createElement('span'); num.textContent = String(i + 1); b.append(num);
    b.addEventListener('click', () => selectGallery(i, true));
    return b;
  }));
  $('gallery').hidden = false;
  // Las miniaturas de bocetos son la pagina completa (1280 px de ancho) reducida al ancho de la miniatura.
  requestAnimationFrame(() => { for (const el of $('gallery-items').children) { const f = el.querySelector('iframe'); if (f) f.style.transform = `scale(${el.clientWidth / 1280})`; } });
  selectGallery(gallery.index, false);
}
function hideGallery() { gallery = null; document.body.classList.remove('showing'); $('gallery').hidden = true; $('gallery-items').replaceChildren(); $('photo-bg').classList.remove('on'); setTimeout(() => { if (!gallery) $('photo-bg').replaceChildren(); }, 900); }

function setState(s) {
  if (s === state) return;
  state = s; avatar.setState(s);
  $('status').dataset.state = s; $('status-text').textContent = car && live && s === 'listening' ? `Di «${wakeWord}…»` : STATE_TEXT[s];
}
function stopSpeech() { player?.stop(); lips.reset(); speechId = -1; subChars = []; }

function onMessage(msg) {
  switch (msg.type) {
    case 'ready':
      live = true; connecting = false; $('gate').hidden = true; $('mic').hidden = false; setState('listening');
      gate = msg.gate > 0 ? createGate({ rms: msg.gate }) : null; lastTalk = performance.now();
      if (msg.wake) wakeWord = msg.wake[0].toUpperCase() + msg.wake.slice(1);
      car = !!msg.car; if (car) setState('listening'); // modo carro: el letrero dice como llamarlo
      $('owner').hidden = !msg.owner; // aviso visible de que esta sesion tiene las herramientas privadas
      if (msg.tts === 'browser') { browserVoice.configure(msg.voice, msg.rate); player = browserVoice; } else player = serverPlayer;
      for (const b of prebuffer.splice(0)) socket.sendAudio(b);
      break;
    case 'error':
      closeReason = ERRORS[msg.reason] ?? 'Ocurrió un problema. Háblame para reintentar.';
      if (msg.reason === 'codigo') { $('code').hidden = false; armed = false; }
      if (msg.reason === 'ocupado') retryAt = performance.now() + 15000;
      if (msg.reason === 'suspension') { closeReason = ''; dormant = true; } // sigue suspendido, ya sin oir: solo despierta con un toque
      break;
    case 'user_partial':
      if (state !== 'speaking') { $('sub-user').textContent = msg.text; }
      lastTalk = performance.now();
      duckUntil = performance.now() + 2500; // la persona esta hablando: la musica baja un momento
      break;
    case 'user_final':
      $('sub-user').textContent = msg.text; $('sub-avatar').textContent = ''; hideCard(); setState('thinking'); break;
    case 'speech_start':
      stopSpeech(); speechId = msg.id; subShown = 0; player.begin(msg.sampleRate); backdrop.show(restScene()); break;
    case 'audio':
      if (msg.id !== speechId) break;
      if (msg.align) { lips.add(msg.align.chars, msg.align.starts, msg.align.ends); for (let i = 0; i < msg.align.chars.length; i++) subChars.push({ c: msg.align.chars[i], t: msg.align.starts[i] }); }
      if (state !== 'speaking') { setState('speaking'); avatar.raiseBrows(); }
      player.push(base64ToBytes(msg.audio));
      break;
    case 'say': // frase para decir con la voz del navegador
      if (msg.id !== speechId) break;
      if (state !== 'speaking') { setState('speaking'); avatar.raiseBrows(); }
      browserVoice.speak(msg.text, msg.lang);
      break;
    case 'speech_end':
      if (msg.id === speechId) player.end();
      break;
    case 'reaction': // gesto del avatar + emojis
      avatar.react(msg.name); emojiBurst($('fx'), msg.name); break;
    case 'scene':
      backdrop.show(msg.name); break;
    case 'card':
      showCard(msg); break;
    case 'demo': // demostracion en vivo: el avatar esta haciendo de asistente de otro negocio
      $('demo').hidden = !msg.on; $('demo').textContent = msg.on ? `Demostración: asistente de ${msg.title}` : ''; break;
    case 'gallery': // fotos o bocetos al lado del avatar
      showGallery(msg); break;
    case 'music': // musica de fondo
      onMusic(msg); break;
    case 'tesla': // estado del carro
      hideCard(); if (gallery) hideGallery(); tesla.show(msg); break;
    case 'spotify_token': { // respuesta al token pedido por el reproductor de Spotify
      const w = tokenWaiters; tokenWaiters = [];
      for (const x of w) msg.token ? x.resolve(msg.token) : x.reject(new Error(msg.error || 'sin token'));
      break; }
    case 'work': // progreso del taller de programacion
      setWork(msg); break;
    case 'suspend': // entra o sale del modo suspension
      setSuspended(msg.on, msg.notice); break;
    case 'interrupt': // el usuario hablo encima: se corta el audio y la boca vuelve a reposo
      stopSpeech(); $('sub-avatar').textContent = ''; backdrop.show(restScene()); setState(restState()); break;
  }
}

/** Fin de la conversacion: vuelve al modo espera (o a la tarjeta inicial si aun no hay microfono). */
function shutdown(message) {
  live = false; connecting = false; prebuffer.length = 0; loud = 0;
  retryAt = Math.max(retryAt, performance.now() + 2500);
  suspended = false; awayNotice = ''; $('away').hidden = true;
  setWork(null); music.stop(); tesla.hide(); stopSpeech(); hideCard(); hideGallery(); setState(dormant ? 'away' : 'idle'); if (!dormant) { setActivity(null); backdrop.show(null); }
  $('sub-user').textContent = ''; $('sub-avatar').textContent = '';
  $('mic').hidden = true; $('owner').hidden = true; $('demo').hidden = true; $('gate').hidden = false;
  $('gate').classList.toggle('standby', armed);
  $('gate-text').textContent = dormant ? 'Estoy suspendido. Toca la pantalla para despertarme.' : armed ? (message || STANDBY_TEXT) : 'Toca para empezar a conversar. El navegador te pedirá permiso para usar el micrófono.';
  $('gate-error').textContent = armed ? '' : (message || '');
  if (armed && message && !dormant) setTimeout(() => { if (!live && !connecting && !dormant) $('gate-text').textContent = STANDBY_TEXT; }, 6000);
}

function startSession() {
  if (live || connecting) return;
  connecting = true; closeReason = '';
  socket?.close();
  socket = connect($('code').value, visitorId(), { onMessage, onClose: ({ wasReady }) => shutdown(closeReason || (wasReady ? '' : 'No pude conectar. Intenta de nuevo.')) }, CAR ? { car: true } : {});
}

function onMicChunk(buffer) {
  if (live) {
    const now = performance.now();
    if (state === 'speaking' || state === 'thinking') lastTalk = now;
    if (!gate) socket.sendAudio(buffer); else for (const b of gate.push(buffer, ecoMode(now))) socket.sendAudio(b);
    return;
  }
  if (!armed || dormant) return; // suspendido sin sesion: no se oye nada; solo despierta con un toque
  prebuffer.push(buffer); if (prebuffer.length > 50) prebuffer.shift(); // ~2 s
  if (connecting || performance.now() < retryAt) { loud = 0; return; }
  // Deteccion simple de voz por volumen: ~0,25 s seguidos por encima del umbral.
  const pcm = new Int16Array(buffer); let sum = 0;
  for (let i = 0; i < pcm.length; i += 4) sum += pcm[i] * pcm[i];
  const rms = Math.sqrt(sum / (pcm.length / 4)) / 32768;
  loud = rms > 0.03 ? loud + 1 : Math.max(0, loud - 1);
  if (loud >= 6) { loud = 0; startSession(); }
}

async function begin() {
  $('gate-error').textContent = '';
  try {
    // El gesto del usuario habilita el audio y el microfono del navegador.
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
    serverPlayer ??= new SpeechPlayer(audioCtx); player ??= serverPlayer;
    if (!mic) mic = await startMic(audioCtx, onMicChunk);
    armed = true; retryAt = 0; dormant = false;
    startSession();
  } catch (e) {
    armed = false;
    shutdown(e?.name === 'NotAllowedError' ? 'Necesito permiso para usar el micrófono.' : 'No pude activar el micrófono.');
  }
}
$('gate-form').addEventListener('submit', (ev) => { ev.preventDefault(); begin(); });
$('gate').addEventListener('click', (ev) => { if ($('gate').classList.contains('standby') && ev.target.id !== 'code') begin(); });

// Bucle de animacion: la boca sigue el tiempo real del audio.
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  const playing = !!player && player.active;
  if (wasPlaying !== playing) { wasPlaying = playing; socket?.send({ type: 'playback', playing }); } // el servidor sabe cuando termina de sonar
  if (state === 'speaking' && !playing) { lips.reset(); setState(restState()); if (state === 'away') $('sub-avatar').textContent = ''; setTimeout(() => { if (state !== 'speaking') backdrop.show(restScene()); }, 2500); }
  const t = playing ? player.time() : -1;
  const w = lips.update(state === 'speaking' ? t : -1, dt);
  for (const v of VISEMES) avatar.setMorph(v, Math.max(w[v], avatar.exprMouth[v] || 0));
  if (state === 'speaking' && subChars.length) { // subtitulos que avanzan con la voz
    let n = subShown;
    while (n < subChars.length && subChars[n].t <= t + 0.25) n++;
    if (n !== subShown) { subShown = n; $('sub-avatar').textContent = subChars.slice(0, n).map((x) => x.c).join(''); }
  }
  if (music.active) music.duck(playing || state === 'speaking' || state === 'thinking' || now < duckUntil);
  runActivities(now);
  avatar.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// Suspendido con la sesion abierta: un toque en cualquier parte lo despierta.
window.addEventListener('pointerdown', () => { if (live && suspended) socket?.send({ type: 'wake' }); });
// Con imagenes en pantalla el avatar esta pequeño en la esquina: tocarlo las quita y lo devuelve a su tamaño.
$('stage').addEventListener('click', () => { if (gallery) { hideGallery(); socket?.send({ type: 'gallery', hide: true }); } });
window.__avatarDebug = {
  react: (n) => { avatar.react(n); emojiBurst($('fx'), n); }, scene: (n) => backdrop.show(n), card: showCard, gallery: showGallery, work: setWork, music: onMusic, tesla: (d) => tesla.show(d), message: onMessage,
  standby: () => { armed = true; shutdown(''); }, suspend: setSuspended, activity: (n) => { setActivity(n); actUntil = performance.now() + 600000; },
  get weights() { return { ...lips.weights }; }, get state() { return state; }, get time() { return player ? player.time() : -1; }, morphNames: avatar.morphNames, missing,
};
