// Panel animado del Tesla (modo dueño): aparece cuando el avatar consulta el carro. Medidor de bateria que se llena,
// carga con movimiento, el carro visto desde arriba (seguros, puertas, baules, ventanas) y temperaturas.
// El servidor manda solo cifras y estados; aqui no se pide nada a Tesla. Los textos van con textContent.
const SHOW_MS = 16000;
const R = 84, CIRC = 2 * Math.PI * R;
const CHARGING = { Charging: 'Cargando', Complete: 'Carga completa', Disconnected: 'Desconectado', Stopped: 'Conectado, sin cargar', NoPower: 'Conectado, sin energía' };

const TEMPLATE = `
  <header class="tsl-head"><strong class="tsl-name"></strong><span class="tsl-when"></span></header>
  <section class="tsl-sec tsl-battery" data-sec="bateria carga">
    <div class="tsl-gauge"><svg viewBox="0 0 200 200" class="tsl-ring" aria-hidden="true">
      <circle class="tsl-track" cx="100" cy="100" r="${R}"/>
      <circle class="tsl-level" cx="100" cy="100" r="${R}" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}"/>
      <circle class="tsl-flow" cx="100" cy="100" r="${R}"/>
      <line class="tsl-limit" x1="174" y1="100" x2="194" y2="100"/>
    </svg>
    <div class="tsl-center"><span class="tsl-pct">–</span><span class="tsl-range"></span></div></div>
    <p class="tsl-charge"><svg viewBox="0 0 24 24" class="tsl-bolt" aria-hidden="true"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg><span></span></p>
  </section>
  <section class="tsl-sec tsl-security" data-sec="seguridad">
    <svg viewBox="0 0 120 210" class="tsl-car" aria-hidden="true">
      <rect class="tsl-part tsl-ft" x="24" y="8" width="72" height="44" rx="22"/>
      <rect class="tsl-part tsl-rt" x="24" y="158" width="72" height="44" rx="20"/>
      <rect class="tsl-body" x="22" y="6" width="76" height="198" rx="30"/>
      <rect class="tsl-glass" x="33" y="56" width="54" height="26" rx="9"/>
      <rect class="tsl-glass" x="33" y="134" width="54" height="20" rx="8"/>
      <rect class="tsl-part tsl-door" data-i="0" x="14" y="62" width="9" height="40" rx="4"/>
      <rect class="tsl-part tsl-door" data-i="1" x="97" y="62" width="9" height="40" rx="4"/>
      <rect class="tsl-part tsl-door" data-i="2" x="14" y="106" width="9" height="40" rx="4"/>
      <rect class="tsl-part tsl-door" data-i="3" x="97" y="106" width="9" height="40" rx="4"/>
      <g class="tsl-lock" transform="translate(60 106)"><rect x="-11" y="-3" width="22" height="17" rx="4"/><path class="tsl-shackle" d="M-6 -3v-5a6 6 0 0 1 12 0v5"/></g>
    </svg>
    <ul class="tsl-list"></ul>
  </section>
  <section class="tsl-sec tsl-climate" data-sec="clima"><div class="tsl-chips"></div></section>
  <footer class="tsl-foot" data-sec="todo"></footer>`;

export function createTeslaPanel(box) {
  let timer = 0, raf = 0, charging = false;
  const $ = (s) => box.querySelector(s);
  const hide = () => { clearTimeout(timer); cancelAnimationFrame(raf); box.hidden = true; document.body.classList.remove('tesla'); };
  box.addEventListener('click', hide);

  function chip(parent, label, value, cls = '') {
    const e = document.createElement('span'); e.className = `tsl-chip ${cls}`.trim();
    const l = document.createElement('small'); l.textContent = label;
    const v = document.createElement('b'); v.textContent = value;
    e.append(l, v); parent.append(e);
  }
  function item(parent, text, state) { const li = document.createElement('li'); li.textContent = text; li.dataset.state = state; parent.append(li); }

  function show(d) {
    cancelAnimationFrame(raf); clearTimeout(timer); charging = d.charging === 'Charging';
    box.innerHTML = TEMPLATE; // plantilla fija, sin datos; los valores se ponen abajo con textContent
    box.dataset.focus = d.focus || 'todo';
    $('.tsl-name').textContent = d.name || 'Tesla';
    const age = Number(d.ageMin);
    $('.tsl-when').textContent = d.live ? 'En vivo' : Number.isFinite(age) ? (age < 90 ? `Hace ${age} min` : `Hace ${Math.round(age / 60)} h`) : 'Último dato';
    $('.tsl-when').dataset.live = d.live ? '1' : '0';

    // Bateria: el anillo se llena y el numero sube hasta el nivel real.
    const level = Number.isFinite(d.level) ? Math.max(0, Math.min(100, d.level)) : null, battery = $('.tsl-battery');
    battery.hidden = level === null;
    if (level !== null) {
      const ring = $('.tsl-level'), pct = $('.tsl-pct'), tone = level < 20 ? 'low' : level < 50 ? 'mid' : 'ok';
      battery.dataset.tone = tone;
      $('.tsl-range').textContent = Number.isFinite(d.rangeKm) ? `${d.rangeKm} km` : '';
      const limit = $('.tsl-limit');
      limit.style.display = Number.isFinite(d.limit) ? '' : 'none';
      if (Number.isFinite(d.limit)) limit.setAttribute('transform', `rotate(${d.limit * 3.6} 100 100)`);
      const charging = d.charging === 'Charging';
      battery.classList.toggle('charging', charging);
      const line = $('.tsl-charge'), parts = [CHARGING[d.charging] || ''];
      if (charging && d.minutesLeft) parts.push(`faltan ${d.minutesLeft >= 60 ? `${Math.floor(d.minutesLeft / 60)} h ${d.minutesLeft % 60} min` : `${d.minutesLeft} min`}`);
      if (charging && d.kw) parts.push(`${d.kw} kW`);
      line.hidden = !parts[0]; line.querySelector('span').textContent = parts.filter(Boolean).join(' · ');
      const t0 = performance.now(), dur = 1500;
      const step = (now) => {
        const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3), v = level * e;
        ring.setAttribute('stroke-dashoffset', String(CIRC * (1 - v / 100))); pct.textContent = `${Math.round(v)}%`;
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }

    // Seguridad: el carro desde arriba; lo abierto se separa y se pone en rojo.
    const sec = $('.tsl-security'), list = $('.tsl-list');
    const anyOpen = (a) => Array.isArray(a) && a.some(Boolean), count = (a) => (Array.isArray(a) ? a.filter(Boolean).length : 0);
    sec.hidden = typeof d.locked !== 'boolean' && !Array.isArray(d.doors);
    if (!sec.hidden) {
      sec.dataset.locked = d.locked === true ? '1' : d.locked === false ? '0' : '';
      box.querySelectorAll('.tsl-door').forEach((el) => el.classList.toggle('open', !!d.doors?.[Number(el.dataset.i)]));
      $('.tsl-ft').classList.toggle('open', !!d.trunks?.[0]); $('.tsl-rt').classList.toggle('open', !!d.trunks?.[1]);
      if (typeof d.locked === 'boolean') item(list, d.locked ? 'Seguros puestos' : 'Sin seguro', d.locked ? 'ok' : 'bad');
      if (Array.isArray(d.doors)) item(list, anyOpen(d.doors) ? `${count(d.doors)} puerta${count(d.doors) > 1 ? 's' : ''} abierta${count(d.doors) > 1 ? 's' : ''}` : 'Puertas cerradas', anyOpen(d.doors) ? 'bad' : 'ok');
      if (anyOpen(d.trunks)) item(list, 'Baúl abierto', 'bad');
      if (Array.isArray(d.windows)) item(list, anyOpen(d.windows) ? `${count(d.windows)} ventana${count(d.windows) > 1 ? 's' : ''} abierta${count(d.windows) > 1 ? 's' : ''}` : 'Ventanas cerradas', anyOpen(d.windows) ? 'bad' : 'ok');
      if (typeof d.sentry === 'boolean') item(list, `Centinela ${d.sentry ? 'encendido' : 'apagado'}`, d.sentry ? 'ok' : 'off');
    }

    const chips = $('.tsl-chips');
    if (Number.isFinite(d.inside)) chip(chips, 'Adentro', `${Math.round(d.inside)}°`, d.inside >= 30 ? 'hot' : d.inside <= 18 ? 'cold' : '');
    if (Number.isFinite(d.outside)) chip(chips, 'Afuera', `${Math.round(d.outside)}°`);
    if (typeof d.climateOn === 'boolean') chip(chips, 'Aire', d.climateOn ? 'Encendido' : 'Apagado', d.climateOn ? 'on' : '');
    $('.tsl-climate').hidden = !chips.children.length;

    const foot = $('.tsl-foot'), bits = [];
    if (Number.isFinite(d.odoKm)) bits.push(`${Number(d.odoKm).toLocaleString('es-CO')} km recorridos`);
    if (d.version) bits.push(`Software ${d.version}`);
    foot.textContent = bits.join(' · '); foot.hidden = !bits.length;

    box.hidden = false; document.body.classList.add('tesla');
    box.classList.remove('in'); void box.offsetWidth; box.classList.add('in'); // reinicia la animacion de entrada
    timer = setTimeout(hide, SHOW_MS);
  }
  return { show, hide, get active() { return !box.hidden; }, /** Esta cargando (para el fondo). */ get charging() { return charging; } };
}
