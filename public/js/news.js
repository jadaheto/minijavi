// Panel de noticias de inteligencia artificial: la lista numerada o una noticia abierta en grande con su codigo QR.
// Los textos vienen de un webhook (titulares de medios): siempre se ponen con textContent, nunca como HTML.
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

export function createNewsPanel(box, onPick) {
  let items = [], index = 0, day = '', title = '';
  const hide = () => { box.hidden = true; box.replaceChildren(); document.body.classList.remove('news'); items = []; index = 0; };
  const meta = (it) => [it.source, it.date].filter(Boolean).join(' · ');

  function head(title, back) {
    const h = el('header', 'nws-head');
    if (back) { const b = el('button', 'nws-back', '‹ Lista'); b.type = 'button'; b.addEventListener('click', () => { index = 0; draw(); onPick?.(0); }); h.append(b); }
    h.append(el('strong', 'nws-title', title));
    const x = el('button', 'nws-close', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Quitar las noticias'); x.addEventListener('click', () => { hide(); onPick?.(0); });
    h.append(x);
    return h;
  }

  function draw() {
    box.replaceChildren();
    box.dataset.view = index ? 'open' : 'list';
    if (!index) {
      box.append(head(title || 'Noticias'));
      const list = el('ol', 'nws-list');
      for (const it of items) {
        const li = el('li', 'nws-item'); li.style.animationDelay = `${0.08 * it.n}s`;
        const btn = el('button', 'nws-row'); btn.type = 'button';
        const text = el('span', 'nws-text'); text.append(el('span', 'nws-h', it.title), el('small', 'nws-meta', meta(it)));
        btn.append(el('span', 'nws-n', String(it.n)), text);
        btn.addEventListener('click', () => { index = it.n; draw(); onPick?.(it.n); });
        li.append(btn); list.append(li);
      }
      box.append(list, el('p', 'nws-hint', 'Di «ve al artículo 3» o toca uno'));
      return;
    }
    const it = items[index - 1];
    box.append(head(`Noticia ${it.n} de ${items.length}`, true));
    const art = el('article', 'nws-open');
    art.append(el('span', 'nws-n big', String(it.n)), el('h2', 'nws-h big', it.title), el('p', 'nws-meta', meta(it)));
    if (it.summary) art.append(el('p', 'nws-sum', it.summary));
    if (it.qr && /^data:image\/png;base64,/.test(it.qr)) {
      const qr = el('div', 'nws-qr'), img = el('img'); img.src = it.qr; img.alt = 'Código QR para leer la noticia completa';
      qr.append(img, el('small', '', 'Escanéalo para leer la nota completa'));
      art.append(qr);
    }
    box.append(art);
    // Las demas, en una tira de numeros para saltar de una a otra.
    const nav = el('nav', 'nws-nav');
    for (const o of items) { const b = el('button', o.n === it.n ? 'on' : '', String(o.n)); b.type = 'button'; b.title = o.title; b.addEventListener('click', () => { index = o.n; draw(); onPick?.(o.n); }); nav.append(b); }
    box.append(nav);
  }

  return {
    show(msg) {
      if (msg.action === 'hide' || !Array.isArray(msg.items) || !msg.items.length) return hide();
      items = msg.items.slice(0, 8); day = msg.day || ''; title = msg.title || ''; index = Math.max(0, Math.min(items.length, Number(msg.index) || 0));
      draw();
      box.hidden = false; document.body.classList.add('news');
      box.classList.remove('in'); void box.offsetWidth; box.classList.add('in');
    },
    hide,
    get active() { return !box.hidden; },
  };
}
