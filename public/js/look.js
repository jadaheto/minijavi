// «Mira esto» (camara V2): cuando el servidor pide una mirada, se toma UNA foto de la camara, se reduce y se envia para
// que el avatar la describa. Es el unico punto de la pagina donde una imagen de la camara sale del navegador, y solo
// ocurre cuando la persona lo pidio (por voz o con el boton). Mientras tanto el recuadro muestra «Viendo…».
const MAX_SIDE = 1024, MAX_CHARS = 560_000;

/** Foto actual del video como JPEG en base64 (sin el prefijo), o '' si no se pudo. Baja la calidad hasta que quepa. */
export function snapshot(video) {
  const w = video?.videoWidth || 0, h = video?.videoHeight || 0; if (!w || !h) return '';
  const k = Math.min(1, MAX_SIDE / Math.max(w, h)), c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  for (const q of [0.8, 0.6, 0.4]) { const d = c.toDataURL('image/jpeg', q).split(',')[1] || ''; if (d && d.length <= MAX_CHARS) return d; }
  return '';
}

/**
 * @param call  la barra de la videollamada (para saber si la camara esta encendida y tomar su video)
 * @param view  el recuadro de la imagen propia (ahi se muestra que el avatar esta viendo)
 * @param send  envia un mensaje al servidor
 */
export function createLook(call, view, send) {
  const tag = document.createElement('span'); tag.className = 'self-seeing'; tag.textContent = 'Viendo…'; tag.hidden = true; tag.setAttribute('role', 'status');
  view.append(tag);
  let timer = 0;
  return {
    /** El servidor pide una mirada (la persona dijo «mira esto»). */
    take() {
      const data = call.video ? snapshot(call.video) : '';
      if (!data) { send({ type: 'photo', off: true }); call.hint?.('Enciende la cámara para que pueda ver.'); return false; }
      send({ type: 'photo', data });
      clearTimeout(timer); tag.hidden = false; view.classList.add('seeing'); timer = setTimeout(() => { tag.hidden = true; view.classList.remove('seeing'); }, 2200);
      return true;
    },
  };
}
