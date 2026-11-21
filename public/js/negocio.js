// Panel del cliente (modo negocio): pedidos, citas, interesados y chats en pausa. Todo con textContent: los datos los escribieron clientes.
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter((k) => k !== null && k !== undefined)); return e; };
  const api = (path, opts) => fetch(`negocio/panel/${path}`, { credentials: 'same-origin', ...opts });
  const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const fecha = (iso) => { try { return new Date(iso).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
  const pesos = (n) => (n > 0 ? `$${Math.round(n).toLocaleString('es-CO')}` : '');
  let data = null, tab = 'pedidos';
  const TABS = [['pedidos', 'Pedidos'], ['citas', 'Citas'], ['interesados', 'Interesados'], ['pausas', 'Chats en pausa']];

  function order(o) {
    const li = el('li'); li.dataset.status = o.status;
    const head = el('div', { className: 'row' }, el('strong', { textContent: `#${o.id} · ${o.name || 'Sin nombre'}` }), el('span', { className: `tag ${o.status === 'nuevo' ? 'warn' : o.status === 'atendido' ? 'ok' : ''}`, textContent: o.status }), el('small', { textContent: `${fecha(o.at)} · ${o.channel === 'whatsapp' ? 'WhatsApp' : 'voz'}` }));
    li.append(head, el('div', { textContent: o.detail }));
    const extra = [o.when_text && (o.kind === 'cita' ? `Para: ${o.when_text}` : `Entrega: ${o.when_text}`), pesos(o.total) && `Total: ${pesos(o.total)}`, o.contact && `Contacto: ${o.contact}`, o.notes && `Notas: ${o.notes}`].filter(Boolean).join(' · ');
    if (extra) li.append(el('small', { textContent: extra }));
    const set = (estado) => async () => { await post(`pedidos/${o.id}`, { estado }); load(); };
    const row = el('div', { className: 'row' });
    if (o.status !== 'atendido') row.append(Object.assign(el('button', { type: 'button', textContent: 'Marcar atendido' }), { onclick: set('atendido') }));
    if (o.status !== 'cancelado') row.append(Object.assign(el('button', { type: 'button', className: 'ghost', textContent: 'Cancelar' }), { onclick: set('cancelado') }));
    if (o.status !== 'nuevo') row.append(Object.assign(el('button', { type: 'button', className: 'ghost', textContent: 'Volver a nuevo' }), { onclick: set('nuevo') }));
    li.append(row); return li;
  }
  function draw() {
    $('nombre').textContent = data.negocio;
    const a = data.avisos, box = $('avisos'); box.replaceChildren(el('h2', { textContent: 'Avisos' }));
    box.append(el('div', { className: 'row' }, el('span', { className: `tag ${a.telegram ? 'ok' : ''}`, textContent: a.telegram ? 'Telegram: activo' : 'Telegram: sin configurar' }),
      el('span', { className: `tag ${a.open ? 'ok' : 'warn'}`, textContent: !a.whatsapp ? 'WhatsApp: sin número del dueño' : a.open ? `WhatsApp ${a.whatsapp}: activo` : `WhatsApp ${a.whatsapp}: cerrado` })));
    if (a.whatsapp && !a.open) box.append(el('small', { textContent: 'Para recibir los avisos por WhatsApp, escribe "hola" desde ese número al número del negocio. Dura 24 horas; repítelo cada día.' }));
    const counts = { pedidos: data.pedidos.filter((o) => o.status === 'nuevo').length, citas: data.citas.filter((o) => o.status === 'nuevo').length, interesados: data.interesados.length, pausas: data.pausas.length };
    $('tabs').replaceChildren(...TABS.map(([k, label]) => { const b = el('button', { type: 'button', textContent: `${label}${counts[k] ? ` (${counts[k]})` : ''}` }); b.setAttribute('aria-selected', String(k === tab)); b.onclick = () => { tab = k; draw(); }; return b; }));
    const list = $('lista'), empty = $('vacio'); list.replaceChildren(); $('titulo').textContent = TABS.find(([k]) => k === tab)[1];
    let items = [];
    if (tab === 'pedidos' || tab === 'citas') items = data[tab].map(order);
    else if (tab === 'interesados') items = data.interesados.map((l) => el('li', {}, el('strong', { textContent: l.name }), el('div', { textContent: l.detail || '' }), el('small', { textContent: `${l.contact} · ${fecha(l.at)} · ${l.source}` })));
    else items = data.pausas.map((p) => { const b = el('button', { type: 'button', textContent: 'Ya lo atendí: que el asistente vuelva a responder' }); b.onclick = async () => { await post(`pausas/${encodeURIComponent(p.phone)}/quitar`); load(); };
      return el('li', {}, el('strong', { textContent: `${p.name || 'Cliente'} (+${p.phone})` }), el('div', { textContent: p.reason }), el('small', { textContent: `El asistente no responde ahí hasta ${fecha(p.until_at)}` }), el('div', { className: 'row' }, b)); });
    list.append(...items); empty.hidden = items.length > 0;
    empty.textContent = { pedidos: 'Todavía no hay pedidos.', citas: 'Todavía no hay solicitudes de cita.', interesados: 'Todavía no hay interesados.', pausas: 'Ningún chat está en manos de una persona.' }[tab];
  }
  async function load() {
    const r = await api('datos');
    if (r.status === 401) { $('login').hidden = false; $('panel').hidden = true; return; }
    if (!r.ok) { $('login').hidden = false; $('login-error').textContent = r.status === 404 ? 'El panel no está activo en este servicio.' : 'No se pudo cargar.'; return; }
    data = await r.json(); $('login').hidden = true; $('panel').hidden = false; draw();
  }
  $('login-form').addEventListener('submit', async (e) => { e.preventDefault(); const r = await post('entrar', { clave: $('clave').value }); const d = await r.json().catch(() => ({}));
    if (!r.ok) { $('login-error').textContent = d.message || 'No se pudo entrar.'; return; } $('clave').value = ''; $('login-error').textContent = ''; load(); });
  load(); setInterval(() => { if (data && !document.hidden) load(); }, 30000);
})();
