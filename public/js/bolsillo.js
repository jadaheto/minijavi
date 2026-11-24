// Vista previa del "Javi de bolsillo": la cara 2D en una pantalla redonda como la de la placa, conversando con el
// servidor real (mismo micrófono, misma voz y mismo lip sync que la página del avatar). Sirve para ver cómo quedará
// antes de tener la placa. No muestra paneles, fondos ni música: la placa no los tendrá.
import { loadFace, createFace, createMind } from './cara2d.js';
import { SpeechPlayer, base64ToBytes } from './audio.js';
import { LipSync } from './lipsync.js';
import { startMic } from './mic.js';
import { connect } from './socket.js';

const $ = (id) => document.getElementById(id);
const TEXT = { idle: 'Toca la pantalla para hablar', listening: 'Escuchando', thinking: 'Pensando', speaking: 'Hablando', away: 'Suspendido: toca para despertarlo' };
const face = createFace($('face'), await loadFace('bolsillo'));
const mini = createFace($('mini'), await loadFace('bolsillo/mini')); // la cara pequeña que acompaña a las tarjetas
const mind = createMind(), lips = new LipSync();
let socket = null, mic = null, audioCtx = null, player = null, live = false, speechId = -1, wasPlaying = false, suspended = false, closeReason = '';
let demo = null; // demostración sin servidor: { t, said }
// Modo placa: con un pase, el servidor manda el audio en binario y la boca ya calculada ([milisegundo, recorte]).
let gadget = false, keys = [], keyAt = 0;

// Tarjetas (Tesla, clima, dólar…): una cifra grande y hasta tres renglones. Varias tarjetas pasan solas; se quitan
// unos segundos después de que el avatar termina de hablar, o con un toque.
let tiles = null; // { list, index, next, seconds, until }
let coverReady = false; // ya llegó una carátula (trama binaria de tipo 2: 150 x 150 en RGB565)
/** Pinta la carátula tal como la recibe la placa. */
function drawCover(bytes) {
  const w = bytes[2] | (bytes[3] << 8), h = bytes[4] | (bytes[5] << 8); if (w !== 150 || h !== 150 || bytes.length < 6 + w * h * 2) return;
  const ctx = $('tile-cover').getContext('2d'), img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) { const v = bytes[6 + i * 2] | (bytes[7 + i * 2] << 8); img.data[i * 4] = ((v >> 11) & 31) * 255 / 31; img.data[i * 4 + 1] = ((v >> 5) & 63) * 255 / 63; img.data[i * 4 + 2] = (v & 31) * 255 / 31; img.data[i * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0); coverReady = true;
}
const el = (tag, text) => { const e = document.createElement(tag); e.textContent = text; return e; };
function drawTile() {
  const t = tiles.list[tiles.index];
  $('tile').dataset.tone = t.tone || 'info';
  $('tile-title').textContent = t.title; $('tile-unit').textContent = t.unit || '';
  // Música: en vez de una cifra va la carátula, entera y sin nada encima (solo direcciones de los servidores de imágenes de Spotify).
  const cover = typeof t.image === 'string' && /^https:\/\/([a-z0-9-]+\.)*(scdn\.co|spotifycdn\.com)\//.test(t.image) ? t.image : '';
  if (cover) { const img = new Image(); img.src = cover; img.alt = ''; $('tile-big').replaceChildren(img); $('tile-unit').textContent = t.big; } else $('tile-big').textContent = t.big;
  $('tile').classList.toggle('has-cover', !!cover);
  // Tarjeta de música con la carátula que mandó el servidor (ya reducida, como le llega a la placa).
  const music = t.kind === 'music' && !!t.cover && coverReady;
  $('tile').classList.toggle('music', music); $('music-help').hidden = !music;
  if (music) $('tile-title').textContent = (t.playing === false ? 'En pausa · ' : '') + t.title;
  $('tile-lines').replaceChildren(...(t.lines || []).map((l) => el('span', l)));
  const ring = $('tile-arc').parentElement; ring.classList.toggle('none', t.ring === undefined);
  $('tile-arc').style.strokeDashoffset = '1395'; // el anillo se llena desde cero cada vez
  if (t.ring !== undefined) requestAnimationFrame(() => requestAnimationFrame(() => { $('tile-arc').style.strokeDashoffset = String(1395 * (1 - t.ring / 100)); }));
  $('tile-dots').replaceChildren(...(tiles.list.length > 1 ? tiles.list.map((_, i) => el(i === tiles.index ? 'b' : 'i', '●')) : []));
}
function showTiles(list, seconds) {
  if (!Array.isArray(list) || !list.length) return;
  tiles = { list, index: 0, next: performance.now() + 4500, seconds: seconds || 12, until: 0 };
  $('tile').hidden = false; $('screen').classList.add('has-tile'); drawTile();
}
function hideTiles() { tiles = null; $('tile').hidden = true; $('screen').classList.remove('has-tile'); }
function tickTiles(now) {
  if (!tiles) return;
  if (tiles.list.length > 1 && now >= tiles.next) { tiles.index = (tiles.index + 1) % tiles.list.length; tiles.next = now + 4500; drawTile(); }
  if (mind.state === 'speaking') tiles.until = 0; // mientras habla, se queda
  else { tiles.until ||= now + Math.max(tiles.seconds * 1000, (tiles.list.length - tiles.index) * 4500); if (now >= tiles.until) hideTiles(); } // un aviso que nadie tocó NO queda como visto: sigue pendiente en el panel y en Telegram
}

function setState(s) { mind.setState(s); $('screen').dataset.state = s; $('status').textContent = TEXT[s]; }
function stopSpeech() { player?.stop(); lips.reset(); speechId = -1; keys = []; keyAt = 0; }
const rest = () => (suspended ? 'away' : live ? 'listening' : 'idle');

function onMessage(msg) {
  switch (msg.type) {
    case 'ready':
      live = true; gadget = !!msg.gadget; setState('listening');
      if (gadget) $('said').textContent = 'Conectado como la placa, en modo dueño.';
      if (msg.tts === 'browser') $('said').textContent = 'Este servidor no tiene voz propia: la vista previa necesita la voz del servidor.';
      break;
    case 'error': closeReason = msg.reason === 'ocupado' ? 'Estoy ocupado con otra persona. Intenta en un momento.' : msg.reason === 'pase' ? 'El pase no sirve: está mal copiado, venció o fue revocado.' : msg.reason === 'sin_voz' ? 'Este servidor no tiene voz propia: la placa la necesita.' : ''; break;
    case 'mouth': if (msg.id === speechId && Array.isArray(msg.k)) keys.push(...msg.k); break;
    case 'user_partial': if (mind.state !== 'speaking') $('said').textContent = msg.text; break;
    case 'user_final': $('said').textContent = msg.text; setState('thinking'); break;
    case 'speech_start': stopSpeech(); speechId = msg.id; player.begin(msg.sampleRate); break;
    case 'audio':
      if (msg.id !== speechId) break;
      if (msg.align) lips.add(msg.align.chars, msg.align.starts, msg.align.ends);
      if (mind.state !== 'speaking') { setState('speaking'); mind.raiseBrows(); }
      player.push(base64ToBytes(msg.audio));
      break;
    case 'speech_end': if (msg.id === speechId) player.end(); break;
    case 'reaction': mind.react(msg.name); break;
    case 'tile': showTiles(msg.tiles, msg.seconds); break;
    case 'suspend': suspended = !!msg.on; if (mind.state !== 'speaking') setState(rest()); break;
    case 'interrupt': stopSpeech(); setState(rest()); break;
  }
}

/** Audio de la placa: 4 bytes de cabecera (tipo 1, 0, número de la respuesta) y PCM de 16 bits. */
function onBinary(data) {
  const b = new Uint8Array(data);
  if (b.length >= 6 && b[0] === 2) { drawCover(b); return; }
  if (b.length < 6 || b[0] !== 1) return;
  if ((b[2] | (b[3] << 8)) !== (speechId & 0xffff)) return; // de una respuesta que ya se cortó
  if (mind.state !== 'speaking') { setState('speaking'); mind.raiseBrows(); }
  player.push(b.subarray(4));
}

function shutdown(message) {
  live = false; suspended = false; stopSpeech(); hideTiles(); setState('idle');
  if (message) $('status').textContent = message;
}

// ---------- avisos que llegan solos ----------
// Con el pase puesto, la página hace lo mismo que la placa enchufada: deja una petición esperando y el aviso llega al
// instante. Suena un tono corto y sale la tarjeta; tocarla abre la conversación para que el avatar lo cuente.
let lastNotice = 0, polling = '', pendingNotice = null;
function chime() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    for (const [f, at] of [[880, 0], [1320, 0.13]]) { const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.value = f; g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(0.18, t + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.22); o.connect(g).connect(audioCtx.destination); o.start(t + at); o.stop(t + at + 0.25); }
  } catch { /* sin audio todavía (el navegador pide un toque antes): el aviso sale igual */ }
}
function showNotices(list, seconds) {
  if (!list.length || live) return; // en plena conversación no se interrumpe: salen al terminar
  showTiles(list, seconds || 40); tiles.until = performance.now() + (seconds || 40) * 1000; chime();
}
async function pollNotices(pase) {
  if (polling === pase) return; polling = pase;
  while (polling === pase && $('pase').value.trim() === pase) {
    try {
      const r = await fetch(`api/placa/avisos?desde=${lastNotice}&espera=25`, { headers: { Authorization: `Bearer ${pase}` }, cache: 'no-store' });
      if (r.status === 401 || r.status === 429) { $('said').textContent = r.status === 401 ? 'El pase no sirve para los avisos.' : 'Demasiados intentos: espera unos minutos.'; break; }
      const d = await r.json();
      if (d.notices?.length) { lastNotice = Math.max(lastNotice, ...d.notices.map((n) => n.id)); showNotices(d.notices, d.seconds); }
    } catch { await new Promise((ok) => setTimeout(ok, 5000)); } // sin red: se reintenta
  }
  if (polling === pase) polling = '';
}
function markSeen(ids) { const pase = $('pase').value.trim(); if (pase && ids.length) fetch('api/placa/avisos/vistos', { method: 'POST', headers: { Authorization: `Bearer ${pase}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }).catch(() => undefined); }
/** Toque sobre un aviso: arriba, el avatar lo cuenta; sobre la cara, se quita sin más. Devuelve si lo atendió. */
function noticeTouch(ev) {
  const t = tiles && tiles.list[tiles.index]; if (!t || t.kind !== 'notice') return false;
  const ids = tiles.list.filter((x) => x.kind === 'notice' && x.id).map((x) => x.id);
  const box = $('screen').getBoundingClientRect(), y = ev ? ((ev.clientY - box.top) / box.height) * 466 : 0;
  hideTiles();
  if (y >= 270 || demo) { markSeen(ids); if (demo) $('said').textContent = y >= 270 ? 'Aviso quitado.' : 'Aquí se abriría la conversación y el avatar te lo cuenta.'; return true; }
  pendingNotice = ids; return false; // sigue a begin(): abre la conversación con esos avisos
}

/** Toque sobre la tarjeta de música: la carátula pausa o sigue, « y » cambian de canción. Devuelve si lo atendió. */
function musicTouch(ev) {
  const t = tiles && tiles.list[tiles.index]; if (!t || !$('tile').classList.contains('music') || !ev) return false;
  const box = $('screen').getBoundingClientRect(), x = ((ev.clientX - box.left) / box.width) * 466, y = ((ev.clientY - box.top) / box.height) * 466;
  if (y >= 270) return false; // sobre la cara: quita la tarjeta
  const cmd = x < 150 ? 'anterior' : x > 316 ? 'siguiente' : t.playing === false ? 'continuar' : 'pausar';
  if (demo || !live) demoMusic(cmd); else if (gadget) socket?.send({ type: 'music', cmd });
  if (tiles) tiles.until = 0;
  return true;
}

async function begin(ev) {
  if (tiles && musicTouch(ev)) return;
  if (tiles && noticeTouch(ev)) return;
  if (tiles) { hideTiles(); return; } // con una tarjeta en pantalla, el toque la quita
  if (demo) { demo = null; lips.reset(); }
  if (live && gadget && mind.state === 'speaking') { stopSpeech(); socket?.send({ type: 'stop' }); setState(rest()); return; } // como en la placa: un toque lo corta
  if (live) { if (suspended) socket?.send({ type: 'wake' }); return; }
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
    player ??= new SpeechPlayer(audioCtx);
    mic ??= await startMic(audioCtx, (buffer) => { if (live) socket?.sendAudio(buffer); });
  } catch (e) { shutdown(e?.name === 'NotAllowedError' ? 'Necesito permiso para usar el micrófono.' : 'No pude activar el micrófono.'); return; }
  $('status').textContent = 'Conectando…'; closeReason = '';
  let visitor = ''; try { visitor = localStorage.getItem('bolsillo-visitor') || crypto.randomUUID(); localStorage.setItem('bolsillo-visitor', visitor); } catch { /* sin almacenamiento: sin memoria de visitante */ }
  socket?.close();
  const pase = $('pase').value.trim();
  socket = connect('', visitor, { onMessage, onBinary, onClose: ({ wasReady }) => shutdown(closeReason || (wasReady ? '' : 'No pude conectar. Intenta de nuevo.')) }, pase ? { gadget: pase, ...(pendingNotice ? { notice: pendingNotice } : {}) } : {});
  pendingNotice = null;
}

// Demostración sin micrófono ni servidor: recorre los estados y "dice" una frase moviendo la boca con el mismo lip sync.
const DEMO = [
  { at: 0, state: 'listening', said: '«Javi, ¿cómo va la batería del carro?»' },
  { at: 2.2, state: 'thinking' },
  { at: 3.6, say: 'Tu carro tiene ochenta por ciento de batería. Te alcanza para ir y volver.', tiles: [{ title: 'Tesla de ejemplo', big: '80', unit: '%', ring: 80, tone: 'ok', lines: ['412 km de autonomía', 'Con seguro', 'Adentro 27° · afuera 31°'] }, { title: 'Clima de ejemplo', big: '31', unit: '°C', tone: 'info', lines: ['Parcialmente nublado', 'Máx 33° · mín 24°', 'Lluvia 20 %'] }] },
  { at: 9.2, state: 'listening', said: 'Las tarjetas se quedan unos segundos y se van solas (o con un toque)' },
  { at: 15, state: 'listening', said: '«Javi, pon salsa»', hide: true },
  { at: 17, state: 'thinking' },
  { at: 18.2, say: 'Listo, suena en tu celular.', music: 0 },
  { at: 20.5, state: 'listening', said: 'Música: toca la carátula para pausar, « y » para cambiar de canción. Se queda 20 segundos.' },
  { at: 42, state: 'idle', said: 'Aviso que llega solo: suena un tono y sale la tarjeta. Tocarla abre la conversación.', hide: true, notice: [{ kind: 'notice', id: 0, title: 'Interesado nuevo', big: 'Nuevo', tone: 'ok', lines: ['Marta de Ejemplo · Panadería', 'Toca para que te lo cuente'] }, { kind: 'notice', id: 0, title: 'Por aprobar', big: 'Aprobar', tone: 'warn', lines: ['Plantilla de bienvenida', 'Toca para que te lo cuente'] }] },
  { at: 54, react: 'alegria', said: 'Reacción: alegría', hide: true },
  { at: 57.4, react: 'sorpresa', said: 'Reacción: sorpresa' },
  { at: 60.6, react: 'pena', said: 'Reacción: pena' },
  { at: 63.8, react: 'pensativo', said: 'Reacción: pensativo' },
  { at: 67, state: 'away', said: 'Suspendido' },
  { at: 71, state: 'idle', said: '' },
];
// Música de EJEMPLO para la demostración: canciones inventadas y carátulas dibujadas aquí (no son de ningún disco).
const DEMO_SONGS = [['Tarde en la sabana', 'Los de Ejemplo', '#c2410c', '#fbbf24'], ['Brisa del río', 'Conjunto Demo', '#0e7490', '#a7f3d0'], ['Noche de porro', 'La Banda Prueba', '#6d28d9', '#f9a8d4']];
let demoSong = 0, demoPlaying = true;
function demoMusic(cmd) {
  if (cmd === 'siguiente') demoSong = (demoSong + 1) % DEMO_SONGS.length; else if (cmd === 'anterior') demoSong = (demoSong + DEMO_SONGS.length - 1) % DEMO_SONGS.length;
  else if (cmd === 'pausar') demoPlaying = false; else if (cmd === 'continuar') demoPlaying = true;
  const [title, artist, a, b] = DEMO_SONGS[demoSong], c = $('tile-cover').getContext('2d');
  const g = c.createLinearGradient(0, 0, 150, 150); g.addColorStop(0, a); g.addColorStop(1, b); c.fillStyle = g; c.fillRect(0, 0, 150, 150);
  c.fillStyle = 'rgba(255,255,255,0.9)'; c.beginPath(); c.arc(75, 70, 34, 0, 7); c.fill(); c.fillStyle = a; c.beginPath(); c.arc(75, 70, 9, 0, 7); c.fill();
  c.fillStyle = '#fff'; c.font = '600 12px system-ui, sans-serif'; c.textAlign = 'center'; c.fillText('CARÁTULA DE EJEMPLO', 75, 134);
  coverReady = true;
  showTiles([{ kind: 'music', cover: true, playing: demoPlaying, title: 'Spotify · Celular', big: demoPlaying ? 'Suena' : 'Pausa', tone: 'ok', lines: [title, artist] }], 20);
}

function startDemo() {
  if (live) { socket?.close(); shutdown(''); }
  hideTiles(); demo = { t: 0, step: 0, speakAt: -1 }; lips.reset(); $('said').textContent = '';
}
function runDemo(dt) {
  demo.t += dt;
  while (demo.step < DEMO.length && DEMO[demo.step].at <= demo.t) {
    const s = DEMO[demo.step++];
    if (s.state) setState(s.state);
    if (s.react) mind.react(s.react);
    if (s.tiles) showTiles(s.tiles, 6);
    if (s.notice) { showTiles(s.notice, 12); chime(); }
    if (s.music !== undefined) { demoSong = s.music; demoPlaying = true; demoMusic(''); }
    if (s.hide) hideTiles();
    if (s.said !== undefined) $('said').textContent = s.said;
    if (s.say) { // tiempos estimados: 14 caracteres por segundo, como la voz del navegador
      const chars = [...s.say], starts = chars.map((_, i) => i / 14), ends = chars.map((_, i) => (i + 1) / 14);
      lips.reset(); lips.add(chars, starts, ends); demo.speakAt = demo.t; demo.speakEnd = demo.t + chars.length / 14;
      setState('speaking'); mind.raiseBrows(); $('said').textContent = s.say;
    }
  }
  if (demo.speakAt >= 0 && demo.t > demo.speakEnd) { demo.speakAt = -1; lips.reset(); }
  if (demo.step >= DEMO.length) { demo = null; return -1; }
  return demo.speakAt >= 0 ? demo.t - demo.speakAt : -1;
}

$('device').addEventListener('click', begin);
$('demo').addEventListener('click', startDemo);
// Al pegar el pase empiezan a llegar los avisos, como en la placa.
$('pase').addEventListener('change', () => { const p = $('pase').value.trim(); if (p.startsWith('mjb.')) pollNotices(p); else polling = ''; });
$('real').addEventListener('click', () => { const on = $('device').classList.toggle('real'); $('real').setAttribute('aria-pressed', String(on)); });

let last = performance.now(), shown = null;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  let t = -1;
  if (demo) t = runDemo(dt);
  else {
    const playing = !!player && player.active;
    if (wasPlaying !== playing) { wasPlaying = playing; socket?.send({ type: 'playback', playing }); } // el servidor sabe cuándo termina de sonar
    if (mind.state === 'speaking' && !playing) { lips.reset(); setState(rest()); }
    t = playing ? player.time() : -1;
  }
  let given;
  if (gadget && !demo) { // la boca la dicta el servidor: se busca el último cambio que ya debió sonar
    const ms = t * 1000; while (keyAt < keys.length && keys[keyAt][0] <= ms) keyAt++;
    given = mind.state === 'speaking' && keyAt > 0 ? keys[keyAt - 1][1] : '-';
  }
  shown = mind.update(dt, lips.update(mind.state === 'speaking' ? t : -1, dt), given);
  if (tiles) mini.draw(shown.frames, 0, 0); else face.draw(shown.frames, shown.dx, shown.dy);
  tickTiles(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
if (new URLSearchParams(location.search).get('demo') === '1') startDemo();
// Para pruebas: poner un cuadro a mano o leer lo que se está mostrando.
window.__bolsillo = { tiles: showTiles, get tile() { return tiles && tiles.list[tiles.index]; }, get shown() { return shown; }, get state() { return mind.state; }, react: (n) => mind.react(n), state_: setState, demo: startDemo, message: onMessage, draw: (frames) => face.draw(frames, 0, 0) };
