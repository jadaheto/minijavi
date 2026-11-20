// WebSocket hacia el backend. La URL se deriva de la pagina: sirve igual en local y detras de un proxy con HTTPS (wss).
export function connect(code, visitor, handlers, extra = {}) {
  const url = new URL('ws', window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  let ready = false;
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', code, visitor, ...extra })));
  ws.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'ready') ready = true;
    handlers.onMessage?.(msg);
  });
  ws.addEventListener('close', (ev) => handlers.onClose?.({ code: ev.code, wasReady: ready }));
  const open = () => ws.readyState === WebSocket.OPEN;
  return {
    send: (obj) => { if (open()) ws.send(JSON.stringify(obj)); },
    sendAudio: (buffer) => { if (open() && ready) ws.send(buffer); },
    close: () => ws.close(),
  };
}
