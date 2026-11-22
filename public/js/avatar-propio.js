// Avatar personalizado con foto: solicitud, pago por Bre-B y comprobante.
//   /avatar.html?d=<demo>  empieza (o retoma) la solicitud de esa demostración.
//   /avatar.html?t=<clave> es el enlace del QR: sirve para subir el comprobante desde otro dispositivo y ver el estado.
(() => {
  const q = new URLSearchParams(location.search), $ = (id) => document.getElementById(id);
  const demo = /^[a-z0-9-]{3,48}$/.test(q.get('d') || '') ? q.get('d') : '';
  const API = '/demo/avatar-propio';
  const estado = $('estado'), say = (text, tone = '') => { estado.textContent = text; estado.dataset.tone = tone; };
  const show = (id) => { for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== id; };
  const store = { get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento: la clave vive en esta página */ } } };
  let token = /^[0-9a-f]{32}$/.test(q.get('t') || '') ? q.get('t') : '';
  if (!token && demo) token = store.get(`avatar-propio:${demo}`);
  let view = null, timer = 0;
  const TITLES = { PENDIENTE_VALIDACION: '⏳ Comprobante en revisión', PAGO_APROBADO: '✅ Pago confirmado', GENERANDO_AVATAR: '🎨 Creando tu avatar', AVATAR_GENERADO: '🎨 Activando tu avatar', AVATAR_ACTIVADO: '🎉 Tu avatar está activo', COMPLETADO: '🎉 Tu avatar está listo', ERROR_GENERACION: '⚠️ Tuvimos un problema', PAGO_RECHAZADO: '✖️ Pago sin confirmar' };

  const json = async (r) => ({ status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) });
  const refresh = async (qr = false) => {
    const r = await json(await fetch(`${API}/estado?t=${token}${qr ? '&qr=1' : ''}`, { cache: 'no-store' }));
    if (!r.ok) { view = null; return null; }
    view = r.data; return view;
  };
  const demoLink = () => (view?.demo ? `/demo/${view.demo}` : demo ? `/demo/${demo}` : '/');

  function render(step) {
    clearTimeout(timer);
    if (!view) return;
    $('p-valor').textContent = `${view.price} COP`; $('p-llave').textContent = view.key;
    if (view.canPay) {
      if (view.state === 'PAGO_RECHAZADO') say(view.message, 'bad');
      if (step === 'comprobante') {
        show('s-comprobante');
        $('qr').hidden = $('qr-texto').hidden = !view.qr || !!q.get('t'); if (view.qr) $('qr').src = view.qr; // quien llegó por el QR ya está en el otro dispositivo
      } else show('s-pago');
      return;
    }
    show('s-estado');
    $('e-titulo').textContent = TITLES[view.state] || 'Tu solicitud';
    $('e-texto').textContent = view.message;
    $('e-ref').textContent = `Solicitud #${view.id}`;
    $('e-demo').href = demoLink();
    const c = $('e-contacto'); c.hidden = !/^https:\/\//.test(view.contact || '') || !['PAGO_RECHAZADO', 'ERROR_GENERACION'].includes(view.state); if (!c.hidden) c.href = view.contact;
    say('');
    if (!['COMPLETADO', 'AVATAR_ACTIVADO', 'PAGO_RECHAZADO'].includes(view.state)) timer = setTimeout(async () => { const before = view.state; if (await refresh(true)) render(view.state === before ? undefined : 'comprobante'); }, 15000);
  }

  async function start() {
    if (token && await refresh(true)) { if (demo) store.set(`avatar-propio:${demo}`, token); return render(q.get('t') ? 'comprobante' : undefined); }
    token = '';
    if (!demo) { $('no-texto').textContent = 'Este enlace no es válido. Ábrelo desde tu demostración.'; return show('s-no'); }
    const r = await json(await fetch(`${API}/info?d=${demo}`, { cache: 'no-store' }));
    $('no-volver').href = `/demo/${demo}`;
    if (!r.ok || !r.data.available) { $('no-texto').textContent = r.data.reason || 'Esta opción no está disponible por ahora.'; return show('s-no'); }
    $('get').textContent = r.data.get; $('precio').textContent = `${r.data.price} COP`; $('consent').textContent = r.data.consent; $('mb').textContent = `Máximo ${r.data.mb} MB.`;
    $('ya').hidden = !r.data.inProgress;
    show('s-foto');
  }

  const phone = () => $('tel').value.replace(/[^\d+]/g, '');
  async function send(file) {
    $('elegir').disabled = $('ya').disabled = true; say(file ? 'Revisando tu foto…' : 'Buscando tu solicitud…', 'busy');
    try {
      // Sin foto (retomar): un cuerpo mínimo; el servidor devuelve la solicitud abierta si el número coincide.
      const r = await json(await fetch(`${API}/solicitud?d=${demo}${$('ok').checked ? '&autoriza=1' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-WhatsApp': phone() }, body: file || new Blob([new Uint8Array(1)]) }));
      if (!r.ok) return say(r.data.message || 'No se pudo enviar. Intenta de nuevo.', 'bad');
      token = r.data.token; store.set(`avatar-propio:${demo}`, token);
      say(r.data.resumed ? 'Ya tenías una solicitud; seguimos con esa.' : 'Foto recibida.', 'ok');
      if (await refresh(true)) render();
    } catch { say('No se pudo enviar. Revisa la conexión.', 'bad'); }
    finally { $('elegir').disabled = $('ya').disabled = false; $('foto').value = ''; }
  }
  $('elegir').addEventListener('click', () => {
    if (phone().replace(/\D/g, '').length < 10) return say('Escribe tu número de WhatsApp.', 'bad');
    if (!$('ok').checked) return say('Primero marca la autorización.', 'bad');
    $('foto').click();
  });
  $('foto').addEventListener('change', () => { const f = $('foto').files && $('foto').files[0]; if (f) void send(f); });
  $('ya').addEventListener('click', () => { if (phone().replace(/\D/g, '').length < 10) return say('Escribe tu número de WhatsApp.', 'bad'); void send(null); });

  $('copiar').addEventListener('click', async () => {
    const key = $('p-llave').textContent;
    try { await navigator.clipboard.writeText(key); $('copiar').textContent = 'Copiada ✓'; }
    catch { const r = document.createRange(); r.selectNodeContents($('p-llave')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); $('copiar').textContent = 'Selecciónala y copia'; }
    setTimeout(() => { $('copiar').textContent = 'Copiar'; }, 2500);
  });
  $('pague').addEventListener('click', () => { say(''); render('comprobante'); });
  $('c-volver').addEventListener('click', () => { say(''); render(); });
  $('subir').addEventListener('click', () => $('comp').click());
  $('comp').addEventListener('change', async () => {
    const f = $('comp').files && $('comp').files[0]; if (!f) return;
    $('subir').disabled = true; say('Subiendo…', 'busy');
    try {
      const r = await json(await fetch(`${API}/comprobante?t=${token}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f }));
      if (!r.ok && r.status !== 409) return say(r.data.message || 'No se pudo subir.', 'bad');
      say(r.ok ? '' : r.data.message || '', r.ok ? '' : 'bad');
      if (await refresh()) render();
    } catch { say('No se pudo subir. Revisa la conexión.', 'bad'); }
    finally { $('subir').disabled = false; $('comp').value = ''; }
  });

  start().catch(() => { $('no-texto').textContent = 'No se pudo cargar. Revisa la conexión e intenta de nuevo.'; show('s-no'); });
})();
