// Tarjeta de la demo "Crea tu propio asistente": boton para subir el documento del negocio desde esta pantalla, QR para
// subirlo desde el celular y el estado de la lectura. Los textos van con textContent; el QR solo como imagen incrustada.
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

export function createDemoDoc(box) {
  let token = '', hideTimer = 0;
  const hide = () => { clearTimeout(hideTimer); box.hidden = true; box.replaceChildren(); token = ''; };
  const status = el('p', 'dd-status');
  const setStatus = (text, tone = '') => { status.textContent = text; status.dataset.tone = tone; };

  let endpoint = '/demo/documento';
  async function send(file, consent) {
    if (!file) return;
    if (consent && !consent.checked) { setStatus('Marca la autorización para continuar.', 'bad'); return; }
    setStatus('Subiendo…', 'busy');
    try {
      const r = await fetch(`${endpoint}?t=${encodeURIComponent(token)}&autoriza=1`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const d = await r.json().catch(() => ({}));
      setStatus(d.message || (r.ok ? 'Recibido.' : 'No se pudo subir.'), r.ok ? 'busy' : 'bad');
    } catch { setStatus('No se pudo subir. Revisa la conexión.', 'bad'); }
  }

  return {
    /** La demo empezo con enlace de subida (o termino). */
    demo(msg) {
      if (!msg.on) return hide();
      if (!msg.upload?.token) return;
      clearTimeout(hideTimer); token = msg.upload.token; endpoint = '/demo/documento'; box.replaceChildren();
      const head = el('header', 'dd-head'); head.append(el('strong', '', `📄 Tu documento para ${msg.title || 'tu negocio'}`));
      const x = el('button', 'nws-close', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Ocultar'); x.addEventListener('click', hide); head.append(x);
      const hint = el('p', 'dd-hint', 'Sube un PDF (también escaneado) o una foto con tus productos y precios, y el asistente te atenderá con tu información.');
      const consent = el('input'); consent.type = 'checkbox'; consent.id = 'dd-ok';
      const lab = el('label', 'dd-consent'); lab.htmlFor = 'dd-ok'; lab.append(consent, el('span', '', ` Autorizo guardar este documento ${msg.upload.days || 7} días para armar mi demostración.`));
      const input = el('input'); input.type = 'file'; input.accept = 'application/pdf,image/jpeg,image/png,image/webp,text/plain,.pdf,.txt'; input.hidden = true;
      input.addEventListener('change', () => send(input.files?.[0], consent));
      const pick = el('button', 'dd-pick', 'Subir documento'); pick.type = 'button'; pick.addEventListener('click', () => { if (!consent.checked) { setStatus('Primero marca la autorización.', 'bad'); return; } input.click(); });
      const row = el('div', 'dd-row'), left = el('div', 'dd-left');
      left.append(hint, lab, pick, input, el('small', 'dd-max', `Máximo ${msg.upload.mb || 10} MB · PDF, JPG, PNG o texto`));
      row.append(left);
      if (typeof msg.upload.qr === 'string' && /^data:image\/png;base64,/.test(msg.upload.qr)) {
        const qr = el('figure', 'dd-qr'), img = el('img'); img.src = msg.upload.qr; img.alt = 'Código QR para subir el documento desde el celular';
        qr.append(img, el('figcaption', '', 'o desde tu celular')); row.append(qr);
      }
      setStatus('');
      box.append(head, row, status);
      box.hidden = false; box.classList.remove('in'); void box.offsetWidth; box.classList.add('in');
    },
    /** Modo dueño: Javier quiere subir un documento para que el avatar sepa mas (sin casilla: es su propio avatar). */
    knowledge(msg) {
      if (!/^[0-9a-f]{32}$/.test(String(msg.token || ''))) return;
      clearTimeout(hideTimer); token = msg.token; endpoint = '/api/conocimiento/documento'; box.replaceChildren();
      const head = el('header', 'dd-head'); head.append(el('strong', '', `📚 Sube el documento${msg.title ? `: ${msg.title}` : ''}`));
      const x = el('button', 'nws-close', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Ocultar'); x.addEventListener('click', hide); head.append(x);
      const hint = el('p', 'dd-hint', 'Un PDF (también escaneado), una foto, un Word o un texto. Lo leo, te cuento de qué trata y tú decides si lo guardo.');
      const input = el('input'); input.type = 'file'; input.accept = 'application/pdf,image/jpeg,image/png,image/webp,text/plain,.pdf,.txt,.md,.docx'; input.hidden = true;
      input.addEventListener('change', () => send(input.files?.[0], null));
      const pick = el('button', 'dd-pick', 'Subir documento'); pick.type = 'button'; pick.addEventListener('click', () => input.click());
      const row = el('div', 'dd-row'), left = el('div', 'dd-left');
      left.append(hint, pick, input, el('small', 'dd-max', `Máximo ${msg.mb || 10} MB · sirve 15 minutos`));
      row.append(left);
      if (typeof msg.qr === 'string' && /^data:image\/png;base64,/.test(msg.qr)) {
        const qr = el('figure', 'dd-qr'), img = el('img'); img.src = msg.qr; img.alt = 'Código QR para subir el documento desde el celular';
        qr.append(img, el('figcaption', '', 'o desde tu celular')); row.append(qr);
      }
      setStatus('');
      box.append(head, row, status);
      box.hidden = false; box.classList.remove('in'); void box.offsetWidth; box.classList.add('in');
    },
    /** Avance de la lectura (llega del servidor, sirva la subida de aqui o del celular). */
    update(msg) {
      if (box.hidden) return;
      const tone = msg.state === 'listo' ? 'ok' : msg.state === 'error' ? 'bad' : 'busy';
      setStatus(msg.message || '', tone);
      box.querySelector('.dd-pick')?.toggleAttribute('disabled', msg.state !== 'error');
      if (msg.state === 'listo') { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 8000); }
    },
    hide,
    get active() { return !box.hidden; },
  };
}
