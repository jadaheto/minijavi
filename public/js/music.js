// Mini reproductor de musica de fondo. Dos fuentes, la elige el servidor:
//  - Spotify (primera): su reproductor web oficial (Web Playback SDK; exige Premium). Sus reglas: la caratula se muestra
//    entera, sin recortar, difuminar ni poner nada encima, con los datos de la cancion y un enlace a Spotify.
//  - YouTube (respaldo): su reproductor oficial (IFrame API), siempre visible y sin nada encima (minimo 200x200 px).
// El servidor decide la cola; aqui se reproduce, se pasa sola a la siguiente y se baja el volumen cuando alguien habla.
// Si el reproductor de Spotify no puede (sin Premium, navegador sin soporte, no arranca), se avisa al servidor con
// `failed` y este manda la misma busqueda por YouTube.
const DUCK = 4; // volumen mientras alguien habla
const SPOTIFY_START_MS = 12000; // tiempo para que Spotify empiece a sonar antes de darlo por fallido

/** Color medio de una imagen ya cargada (para el fondo). `null` si el navegador no deja leerla. */
export function imageColor(img) {
  try {
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data; let r = 0, gr = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4; return [r / n, gr / n, b / n].map(Math.round);
  } catch { return null; }
}

export function createMusic(box, onChange, { getToken, onCover } = {}) {
  const $ = (s) => box.querySelector(s);
  const label = $('.music-title'), artist = $('.music-artist'), vol = $('.music-vol'), cover = $('.music-cover'), coverImg = $('.music-cover img'), open = $('.music-open'), toggleBtn = $('[data-act="toggle"]');
  let source = '', queue = [], index = 0, volume = 15, ducked = false, playing = false;
  const level = () => (ducked ? Math.min(volume, DUCK) : volume);
  const setPlaying = (on) => { playing = on; if (toggleBtn) { toggleBtn.textContent = on ? '⏸' : '▶'; toggleBtn.setAttribute('aria-label', on ? 'Pausar' : 'Continuar'); } };

  function show() {
    const t = queue[index], sp = source === 'spotify';
    box.dataset.source = source;
    // Spotify: titulo y artistas en dos renglones, tal como los entrega; YouTube: un renglon.
    label.textContent = !t ? '' : sp ? t.title : `♪ ${t.title} — ${t.channel}`; label.title = label.textContent;
    artist.textContent = sp && t ? t.channel : '';
    cover.hidden = open.hidden = !(sp && t);
    if (sp && t) { // metadatos y caratula tal como los entrega Spotify, enlazados a Spotify
      if (t.image) { if (coverImg.src !== t.image) coverImg.src = t.image; coverImg.alt = `Carátula de ${t.album || t.title}`; } else coverImg.removeAttribute('src');
      cover.href = open.href = t.url || 'https://open.spotify.com/';
    }
    onCover?.(sp && t?.image ? t : null);
  }
  const applyVolume = () => {
    try { if (source === 'spotify') sp?.setVolume(level() / 100).catch(() => undefined); else yt?.setVolume(level()); } catch { /* aun no esta listo */ }
    vol.textContent = `vol ${volume}%`;
  };

  // ---------- YouTube ----------
  let yt = null, ytReady = null, ytErrors = 0;
  function loadYouTube() {
    if (ytReady) return ytReady;
    ytReady = new Promise((resolve, reject) => {
      window.onYouTubeIframeAPIReady = () => {
        yt = new window.YT.Player('music-player', {
          width: 240, height: 200, playerVars: { playsinline: 1, origin: location.origin },
          events: { onReady: () => resolve(), onStateChange: onYtState, onError: onYtError },
        });
      };
      const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.onerror = () => { ytReady = null; reject(new Error('no se pudo cargar YouTube')); };
      document.head.append(s);
    });
    return ytReady;
  }
  function ytStart() { show(); applyVolume(); yt.loadVideoById(queue[index].id); }
  function ytStep(n) { if (!queue.length) return; index = (index + n + queue.length) % queue.length; ytStart(); onChange({ index, playing: true }); }
  function onYtState(ev) {
    if (source !== 'youtube') return;
    if (ev.data === 1) { ytErrors = 0; applyVolume(); setPlaying(true); onChange({ index, playing: true }); } // reproduciendo
    else if (ev.data === 2) { setPlaying(false); onChange({ index, playing: false }); }                      // pausa (tambien si se pauso en el reproductor)
    else if (ev.data === 0) ytStep(1);                                                                       // termino: la siguiente de la cola
  }
  // Video borrado, privado o que no permite insertarse: se pasa al siguiente (sin dar vueltas si fallan todos).
  function onYtError() { if (source !== 'youtube') return; if (++ytErrors < queue.length) ytStep(1); else { setPlaying(false); onChange({ index, playing: false }); label.textContent = 'No se pudo reproducir esa música.'; } }

  // ---------- Spotify ----------
  let sp = null, spReady = null, spDevice = '', spRun = 0, spTimer = 0;
  function spotifyFailed(reason) {
    if (source !== 'spotify') return;
    spRun++; clearTimeout(spTimer); source = ''; queue = []; setPlaying(false);
    try { sp?.pause().catch(() => undefined); } catch { /* sin reproductor */ }
    show(); label.textContent = 'Spotify no pudo; probando YouTube…';
    onChange({ failed: String(reason || 'sin detalle').slice(0, 120) });
  }
  function loadSpotify() {
    if (spReady) return spReady;
    spReady = new Promise((resolve, reject) => {
      const fail = (m) => { spReady = null; try { sp?.disconnect(); } catch { /* nada */ } sp = null; reject(new Error(m)); };
      const timer = setTimeout(() => fail('el reproductor de Spotify no respondió'), SPOTIFY_START_MS);
      const init = () => {
        sp = new window.Spotify.Player({ name: 'minijavi', volume: level() / 100, getOAuthToken: (cb) => { getToken().then(cb, () => { clearTimeout(timer); fail('no hay token de Spotify'); }); } });
        sp.addListener('ready', ({ device_id }) => { spDevice = device_id; clearTimeout(timer); resolve(); });
        sp.addListener('not_ready', () => { spDevice = ''; });
        sp.addListener('player_state_changed', onSpState);
        sp.addListener('autoplay_failed', () => spotifyFailed('el navegador no dejó iniciar el audio'));
        for (const ev of ['initialization_error', 'authentication_error', 'account_error', 'playback_error'])
          sp.addListener(ev, ({ message }) => { if (!spDevice) { clearTimeout(timer); fail(`${ev}: ${message}`); } else spotifyFailed(`${ev}: ${message}`); });
        sp.connect().then((ok) => { if (!ok) { clearTimeout(timer); fail('el reproductor de Spotify no se pudo conectar'); } });
      };
      if (window.Spotify?.Player) return init();
      window.onSpotifyWebPlaybackSDKReady = init;
      const s = document.createElement('script'); s.src = 'https://sdk.scdn.co/spotify-player.js'; s.onerror = () => { clearTimeout(timer); fail('no se pudo cargar el reproductor de Spotify'); };
      document.head.append(s);
    });
    return spReady;
  }
  async function spStart() {
    const run = ++spRun; clearTimeout(spTimer);
    show();
    try {
      await loadSpotify();
      const token = await getToken();
      if (run !== spRun) return;
      // Toda la cola, empezando por la elegida: Spotify pasa sola a la siguiente.
      const uris = [...queue.slice(index), ...queue.slice(0, index)].map((t) => t.uri);
      const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(spDevice)}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ uris }) });
      if (!res.ok) throw new Error(`Spotify respondió ${res.status} al reproducir`);
      if (run !== spRun) return;
      applyVolume();
      spTimer = setTimeout(() => { if (run === spRun && !playing) spotifyFailed('no empezó a sonar'); }, SPOTIFY_START_MS);
    } catch (e) { if (run === spRun) spotifyFailed(e.message); }
  }
  function onSpState(state) {
    if (source !== 'spotify' || !state) return;
    const uri = state.track_window?.current_track?.uri, i = queue.findIndex((t) => t.uri === uri);
    if (i >= 0 && i !== index) { index = i; show(); }
    if (!state.paused) clearTimeout(spTimer);
    setPlaying(!state.paused);
    onChange({ index, playing: !state.paused });
  }

  // Botones del reproductor (anterior, pausa, siguiente): hacen lo mismo que las ordenes de voz.
  box.addEventListener('click', (ev) => {
    const act = ev.target.closest?.('[data-act]')?.dataset.act;
    if (!act || !queue.length) return;
    if (source === 'spotify') { (act === 'toggle' ? sp?.togglePlay() : act === 'next' ? sp?.nextTrack() : sp?.previousTrack())?.catch(() => undefined); return; }
    if (act === 'toggle') { if (playing) yt?.pauseVideo(); else yt?.playVideo(); } else ytStep(act === 'next' ? 1 : -1);
  });

  return {
    async play(q, i, v, src) {
      const next = src === 'spotify' ? 'spotify' : 'youtube';
      // Al cambiar de fuente se calla la otra: nunca suenan dos a la vez.
      if (next !== 'spotify') { spRun++; clearTimeout(spTimer); try { sp?.pause().catch(() => undefined); } catch { /* sin reproductor */ } }
      if (next !== 'youtube') try { yt?.stopVideo(); } catch { /* sin reproductor */ }
      source = next; queue = q || []; index = i || 0; if (Number.isFinite(v)) volume = v; ytErrors = 0; setPlaying(false);
      if (!queue.length) return;
      box.hidden = false; show(); // visible antes de reproducir
      if (source === 'spotify') return spStart();
      try { await loadYouTube(); if (source === 'youtube') ytStart(); } catch (e) { label.textContent = e.message; onChange({ index, playing: false }); }
    },
    pause() { if (source === 'spotify') sp?.pause().catch(() => undefined); else yt?.pauseVideo(); },
    resume() { if (!queue.length) return; box.hidden = false; if (source === 'spotify') sp?.resume().catch(() => undefined); else yt?.playVideo(); },
    stop() {
      spRun++; clearTimeout(spTimer);
      try { sp?.pause().catch(() => undefined); } catch { /* sin reproductor */ }
      try { yt?.stopVideo(); } catch { /* sin reproductor */ }
      queue = []; source = ''; setPlaying(false); box.hidden = true; onCover?.(null);
    },
    setVolume(v) { volume = Math.max(0, Math.min(100, v)); applyVolume(); },
    /** Baja la musica mientras alguien habla (el avatar o la persona) y la devuelve a su volumen despues. */
    duck(on) { if (on !== ducked) { ducked = on; if (queue.length) applyVolume(); } },
    get active() { return queue.length > 0; },
  };
}
