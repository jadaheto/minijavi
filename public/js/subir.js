// Pagina del celular para subir el documento de la demo (enlace de un solo uso que trae el QR de la pantalla).
(() => {
  const qs = new URLSearchParams(location.search), t = qs.get('t') || '', know = qs.get('c') === '1'; // c=1: documento de conocimiento del dueño
  const api = know ? '/api/conocimiento/documento' : '/demo/documento';
  const $ = (id) => document.getElementById(id), estado = $('estado'), pick = $('pick'), file = $('file'), ok = $('ok');
  const say = (text, tone = '') => { estado.textContent = text; estado.dataset.tone = tone; };
  if (know) {
    document.title = 'Sube el documento'; $('titulo').textContent = '📚 Sube el documento'; $('permiso').hidden = true; ok.checked = true; file.accept += ',.md,.docx';
    $('texto').textContent = 'Un PDF (también escaneado), una foto, un Word o un texto. El avatar lo lee, te cuenta de qué trata y tú decides si lo guarda.'; $('tope').textContent = 'PDF, JPG, PNG, Word o texto · el enlace sirve 15 minutos';
  }
  if (!/^[0-9a-f]{32}$/.test(t)) { say('Este enlace no es válido. Escanea de nuevo el código de la pantalla.', 'bad'); pick.disabled = true; return; }
  pick.addEventListener('click', () => { if (!ok.checked) return say('Primero marca la autorización.', 'bad'); file.click(); });
  let timer = 0;
  const poll = async () => {
    try {
      const r = await fetch(`${api}/estado?t=${t}`, { cache: 'no-store' }); const d = await r.json();
      if (!r.ok) return say(d.message || 'El enlace venció.', 'bad');
      say(d.message || '', d.state === 'listo' ? 'ok' : d.state === 'error' ? 'bad' : 'busy');
      if (d.state === 'leyendo') timer = setTimeout(poll, 3000);
    } catch { timer = setTimeout(poll, 5000); }
  };
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0]; if (!f) return;
    pick.disabled = true; say('Subiendo…', 'busy');
    try {
      const r = await fetch(`${api}?t=${t}&autoriza=1`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { pick.disabled = false; return say(d.message || 'No se pudo subir.', 'bad'); }
      say(d.message || 'Recibido.', 'busy'); clearTimeout(timer); timer = setTimeout(poll, 2500);
    } catch { pick.disabled = false; say('No se pudo subir. Revisa la conexión.', 'bad'); }
  });
})();
