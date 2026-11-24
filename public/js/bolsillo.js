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
const mind = createMind(), lips = new LipSync();
let socket = null, mic = null, audioCtx = null, player = null, live = false, speechId = -1, wasPlaying = false, suspended = false, closeReason = '';
let demo = null; // demostración sin servidor: { t, said }
// Modo placa: con un pase, el servidor manda el audio en binario y la boca ya calculada ([milisegundo, recorte]).
let gadget = false, keys = [], keyAt = 0;

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
    case 'suspend': suspended = !!msg.on; if (mind.state !== 'speaking') setState(rest()); break;
    case 'interrupt': stopSpeech(); setState(rest()); break;
  }
}

/** Audio de la placa: 4 bytes de cabecera (tipo 1, 0, número de la respuesta) y PCM de 16 bits. */
function onBinary(data) {
  const b = new Uint8Array(data); if (b.length < 6 || b[0] !== 1) return;
  if ((b[2] | (b[3] << 8)) !== (speechId & 0xffff)) return; // de una respuesta que ya se cortó
  if (mind.state !== 'speaking') { setState('speaking'); mind.raiseBrows(); }
  player.push(b.subarray(4));
}

function shutdown(message) {
  live = false; suspended = false; stopSpeech(); setState('idle');
  if (message) $('status').textContent = message;
}

async function begin() {
  if (demo) { demo = null; lips.reset(); }
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
  socket = connect('', visitor, { onMessage, onBinary, onClose: ({ wasReady }) => shutdown(closeReason || (wasReady ? '' : 'No pude conectar. Intenta de nuevo.')) }, pase ? { gadget: pase } : {});
}

// Demostración sin micrófono ni servidor: recorre los estados y "dice" una frase moviendo la boca con el mismo lip sync.
const DEMO = [
  { at: 0, state: 'listening', said: '«Javi, ¿cómo va la batería del carro?»' },
  { at: 2.2, state: 'thinking' },
  { at: 3.6, say: 'Tu carro tiene ochenta por ciento de batería. Te alcanza para ir y volver.' },
  { at: 9.2, state: 'listening', react: 'alegria', said: 'Reacción: alegría' },
  { at: 12.4, react: 'sorpresa', said: 'Reacción: sorpresa' },
  { at: 15.6, react: 'pena', said: 'Reacción: pena' },
  { at: 18.8, react: 'pensativo', said: 'Reacción: pensativo' },
  { at: 22, state: 'away', said: 'Suspendido' },
  { at: 26, state: 'idle', said: '' },
];
function startDemo() {
  if (live) { socket?.close(); shutdown(''); }
  demo = { t: 0, step: 0, speakAt: -1 }; lips.reset(); $('said').textContent = '';
}
function runDemo(dt) {
  demo.t += dt;
  while (demo.step < DEMO.length && DEMO[demo.step].at <= demo.t) {
    const s = DEMO[demo.step++];
    if (s.state) setState(s.state);
    if (s.react) mind.react(s.react);
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
  face.draw(shown.frames, shown.dx, shown.dy);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
if (new URLSearchParams(location.search).get('demo') === '1') startDemo();
// Para pruebas: poner un cuadro a mano o leer lo que se está mostrando.
window.__bolsillo = { get shown() { return shown; }, get state() { return mind.state; }, react: (n) => mind.react(n), state_: setState, demo: startDemo, message: onMessage, draw: (frames) => face.draw(frames, 0, 0) };
