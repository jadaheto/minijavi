// Videollamada con el avatar (V1, aprobada por Javier el 2026-11-25): una barra con camara, girar, microfono y colgar, y
// la imagen propia en un recuadro, como en una videollamada. En esta entrega NINGUNA imagen sale del navegador: la camara
// solo se muestra aqui. Empieza siempre apagada y se apaga al colgar o al cerrarse la conversacion.
const SVG = 'http://www.w3.org/2000/svg';
// Iconos propios, dibujados con figuras simples (trazo de 2 sobre una rejilla de 24).
const ICONS = {
  cam: [['rect', { x: 2.5, y: 6.5, width: 12.5, height: 11, rx: 2.5 }], ['path', { d: 'M15 10.5l6-3.2v9.400l-6-3.2z' }]],
  camOff: [['rect', { x: 2.5, y: 6.5, width: 12.5, height: 11, rx: 2.5 }], ['path', { d: 'M15 10.5l6-3.2v9.400l-6-3.2z' }], ['path', { d: 'M3 3.500l18 17', class: 'slash' }]],
  flip: [['path', { d: 'M4.500 11a7.500 7.500 0 0 1 13-4.200L20 9' }], ['path', { d: 'M20 4.500V9h-4.500' }], ['path', { d: 'M19.500 13a7.500 7.500 0 0 1-13 4.200L4 15' }], ['path', { d: 'M4 19.500V15h4.500' }]],
  eye: [['path', { d: 'M2 12s3.700-6.500 10-6.500S22 12 22 12s-3.700 6.500-10 6.500S2 12 2 12z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  mic: [['rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }], ['path', { d: 'M5.500 11.500a6.500 6.500 0 0 0 13 0' }], ['path', { d: 'M12 18v3M8.500 21h7' }]],
  micOff: [['rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }], ['path', { d: 'M5.500 11.500a6.500 6.500 0 0 0 13 0' }], ['path', { d: 'M12 18v3M8.500 21h7' }], ['path', { d: 'M3 3.500l18 17', class: 'slash' }]],
  hang: [['path', { d: 'M3.300 13.200c4.900-4.600 12.500-4.600 17.400 0 .7.700.700 1.700 0 2.400l-1.300 1.300c-.5.500-1.400.600-2 .200l-2.400-1.500c-.5-.300-.8-.900-.8-1.500v-1.300a10 10 0 0 0-4.400 0v1.300c0 .600-.300 1.200-.800 1.500l-2.400 1.500c-.600.400-1.500.300-2-.200l-1.300-1.300c-.700-.700-.700-1.700 0-2.400z', class: 'solid' }]],
};
function icon(name) {
  const s = document.createElementNS(SVG, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of ICONS[name]) { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); s.append(e); }
  return s;
}
/** Dibuja un boton: el icono en su circulo y, debajo, su nombre (lo que hace queda dicho con palabras). */
function draw(b, name, text, label) {
  const ico = document.createElement('span'); ico.className = 'call-ico'; ico.append(icon(name));
  const txt = document.createElement('span'); txt.className = 'call-txt'; txt.textContent = text;
  b.replaceChildren(ico, txt); b.setAttribute('aria-label', label); b.title = label;
}
function button(cls, label) { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.setAttribute('aria-label', label); b.title = label; return b; }

/**
 * @param bar   contenedor de la barra de botones
 * @param view  contenedor del recuadro con la imagen propia
 * @param on    { hang(), mute(boolean), camera(boolean) } avisos a la pagina
 */
export function createCall(bar, view, on = {}) {
  let stream = null, facing = 'user', muted = false, busy = false, canLook = false;
  const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.autoplay = true; video.setAttribute('aria-label', 'Tu cámara');
  const note = document.createElement('p'); note.className = 'call-note'; note.setAttribute('role', 'status');
  view.append(video);
  const bCam = button('call-btn', 'Encender la cámara'), bFlip = button('call-btn', 'Cambiar de cámara'), bLook = button('call-btn', 'Que mire lo que le muestro'), bMic = button('call-btn', 'Silenciar el micrófono'), bHang = button('call-btn hang', 'Colgar');
  const sep = document.createElement('span'); sep.className = 'call-sep'; sep.setAttribute('aria-hidden', 'true');
  bLook.classList.add('look');
  bar.append(bMic, bCam, bFlip, bLook, sep, bHang, note);
  const paint = () => {
    // Orden fijo: micrófono, cámara, girar, mirar y, separado al final, colgar. Girar y mirar solo con la cámara encendida.
    draw(bMic, muted ? 'micOff' : 'mic', muted ? 'Silenciado' : 'Micrófono', muted ? 'Activar el micrófono' : 'Silenciar el micrófono'); bMic.setAttribute('aria-pressed', String(muted)); bMic.classList.toggle('off', muted);
    draw(bCam, stream ? 'cam' : 'camOff', 'Cámara', stream ? 'Apagar la cámara' : 'Encender la cámara'); bCam.setAttribute('aria-pressed', String(!!stream)); bCam.classList.toggle('on', !!stream);
    draw(bFlip, 'flip', 'Girar', 'Cambiar de cámara'); bFlip.hidden = !stream;
    draw(bLook, 'eye', 'Mirar', 'Que mire lo que le muestro'); bLook.hidden = !stream || !canLook;
    draw(bHang, 'hang', 'Colgar', 'Colgar');
    view.hidden = !stream; view.classList.toggle('mirror', facing === 'user'); document.body.classList.toggle('cam', !!stream);
  };
  const say = (text) => { note.textContent = text; if (text) setTimeout(() => { if (note.textContent === text) note.textContent = ''; }, 5000); };
  const stopCam = () => { stream?.getTracks().forEach((t) => t.stop()); stream = null; video.srcObject = null; };
  async function startCam() {
    if (!navigator.mediaDevices?.getUserMedia) return say('Este navegador no deja usar la cámara.');
    // Solo video: el microfono ya lo maneja la conversacion. Imagen pequeña: es para verse, no para grabar.
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: facing, width: { ideal: 960 }, height: { ideal: 720 } } });
    stream.getVideoTracks()[0]?.addEventListener('ended', () => { stopCam(); paint(); on.camera?.(false); }); // la quitaron desde el navegador o el sistema
    video.srcObject = stream; await video.play().catch(() => undefined);
  }
  async function toggleCam(flip = false) {
    if (busy) return; busy = true;
    try {
      const was = !!stream; stopCam();
      if (flip) facing = facing === 'user' ? 'environment' : 'user';
      if (!was || flip) await startCam();
      say('');
    } catch (e) {
      stopCam(); say(e?.name === 'NotAllowedError' ? 'Necesito permiso para usar la cámara.' : e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError' ? 'No encontré una cámara en este dispositivo.' : 'No pude encender la cámara.');
    }
    busy = false; paint(); on.camera?.(!!stream);
  }
  bCam.addEventListener('click', () => toggleCam(false));
  bFlip.addEventListener('click', () => toggleCam(true));
  bMic.addEventListener('click', () => { muted = !muted; paint(); on.mute?.(muted); });
  bHang.addEventListener('click', () => on.hang?.());
  bLook.addEventListener('click', () => { if (stream) on.look?.(); });
  paint(); bar.hidden = true;
  return {
    /** La conversacion esta abierta: se muestra la barra. Al cerrarse, la camara se apaga y el microfono vuelve a su estado normal. */
    show(live) { bar.hidden = !live; if (!live) { if (stream) { stopCam(); on.camera?.(false); } if (muted) { muted = false; on.mute?.(false); } note.textContent = ''; paint(); } },
    get camera() { return !!stream; },
    get muted() { return muted; },
    /** El servidor dice si el avatar puede mirar en esta conversacion (aparece el boton del ojo con la camara encendida). */
    setLook(v) { canLook = !!v; paint(); },
    hint(text) { say(text); },
    /** El elemento de video (para tomar una foto cuando la persona lo pida: entrega V2). */
    get video() { return stream ? video : null; },
  };
}
