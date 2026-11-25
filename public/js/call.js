// Videollamada con el avatar (V1, aprobada por Javier el 2026-11-25): una barra con camara, girar, microfono y colgar, y
// la imagen propia en un recuadro, como en una videollamada. En esta entrega NINGUNA imagen sale del navegador: la camara
// solo se muestra aqui. Empieza siempre apagada y se apaga al colgar o al cerrarse la conversacion.
const SVG = 'http://www.w3.org/2000/svg';
const ICONS = {
  cam: 'M4 7h9a2 2 0 0 1 2 2v1.6l4-2.4v7.6l-4-2.4V15a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z',
  camOff: 'M3 3l18 18M9.5 7H13a2 2 0 0 1 2 2v1.6l4-2.4v7.6l-2.2-1.3M15 15a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1',
  flip: 'M7 7h8.5l-2.2-2.2M17 17H8.500l2.2 2.2M17 7a5 5 0 0 1 2 4M7 17a5 5 0 0 1-2-4',
  eye: 'M2 12s3.600-6.500 10-6.500S22 12 22 12s-3.600 6.500-10 6.500S2 12 2 12zM12 9.200a2.800 2.800 0 1 0 0 5.600 2.800 2.800 0 0 0 0-5.600z',
  mic: 'M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6',
  micOff: 'M3 3l18 18M9 6a3 3 0 0 1 6 0v5M9 9v2a3 3 0 0 0 4.5 2.6M6 11a6 6 0 0 0 9.5 4.9M18 11a6 6 0 0 1-.4 2.1M12 17v4M9 21h6',
  hang: 'M3 14.500c5-4.700 13-4.700 18 0l-2.200 2.300-3.300-1.800v-2.300a9 9 0 0 0-7 0v2.300l-3.300 1.800z',
};
function icon(name) {
  const s = document.createElementNS(SVG, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', ICONS[name]); s.append(p); return s;
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
  bar.append(bCam, bFlip, bLook, bMic, bHang, note);
  const paint = () => {
    bCam.replaceChildren(icon(stream ? 'cam' : 'camOff')); bCam.setAttribute('aria-pressed', String(!!stream)); bCam.setAttribute('aria-label', stream ? 'Apagar la cámara' : 'Encender la cámara'); bCam.title = bCam.getAttribute('aria-label');
    bFlip.replaceChildren(icon('flip')); bFlip.hidden = !stream;
    bLook.replaceChildren(icon('eye')); bLook.hidden = !stream || !canLook;
    bMic.replaceChildren(icon(muted ? 'micOff' : 'mic')); bMic.setAttribute('aria-pressed', String(muted)); bMic.classList.toggle('off', muted); bMic.setAttribute('aria-label', muted ? 'Activar el micrófono' : 'Silenciar el micrófono'); bMic.title = bMic.getAttribute('aria-label');
    bHang.replaceChildren(icon('hang'));
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
