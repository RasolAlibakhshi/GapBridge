// ---------- toolbar icon status ----------
// gray = app not reachable, green = connected, orange = token missing/wrong
const WS_URL = 'ws://127.0.0.1:8765';
const STATES = {
  off: { color: '#8a8f98', title: 'Gap Bridge — برنامه وصل نیست' },
  paused: { color: '#374151', title: 'Gap Bridge — خاموش' },
  ok:  { color: '#22c55e', title: 'Gap Bridge — وصل است ✓' },
  bad: { color: '#f59e0b', title: 'Gap Bridge — توکن ندارد یا نامعتبر است' },
};
let state = null;

function draw(color, size) {
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.beginPath(); g.arc(size / 2, size / 2, size / 2 - 0.5, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff';
  g.font = `bold ${Math.round(size * 0.62)}px sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('G', size / 2, size / 2 + size * 0.04);
  return g.getImageData(0, 0, size, size);
}
function setState(s) {
  if (state === s) return;
  state = s;
  const { color, title } = STATES[s];
  chrome.action.setIcon({ imageData: { 16: draw(color, 16), 32: draw(color, 32), 48: draw(color, 48) } }).catch(() => {});
  chrome.action.setTitle({ title });
}

// ---------- persistent status connection ----------
let sock = null, pingTimer = null, retryTimer = null;

async function ensure() {
  const { enabled } = await chrome.storage.local.get('enabled');
  if (enabled === false) { setState('paused'); return; }
  if (sock && sock.readyState <= 1) return;
  const { token } = await chrome.storage.local.get('token');
  if (!token) { setState('bad'); return; }
  let ws;
  try { ws = new WebSocket(WS_URL); } catch { setState('off'); return; }
  sock = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'auth') {
      if (m.ok) {
        setState('ok');
        clearInterval(pingTimer);
        pingTimer = setInterval(() => { try { ws.send(JSON.stringify({ type: 'ping' })); } catch {} }, 20000);
        flushErrors();
      } else setState('bad');
    }
  };
  ws.onerror = () => setState('off');
  ws.onclose = () => {
    if (sock !== ws) return;
    sock = null; clearInterval(pingTimer);
    if (state === 'ok') setState('off');
    clearTimeout(retryTimer); retryTimer = setTimeout(ensure, 5000);
  };
}

function restart() {
  const old = sock; sock = null;
  try { old?.close(); } catch {}
  state = null;
  ensure();
}

chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('gb-keepalive', { periodInMinutes: 0.5 }); restart(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('gb-keepalive', { periodInMinutes: 0.5 }); restart(); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'gb-keepalive') ensure(); });
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && (ch.token || ch.enabled)) restart(); });
setState('off');
ensure();

// ---------- خطاهای افزونه → کنسول خطاهای برنامه ----------
// فقط روی اتصال احرازشده فرستاده می‌شود؛ تا آن موقع حداکثر ۲۰ مورد در صف می‌ماند (قدیمی‌ترها دور ریخته می‌شوند)
const errQueue = [];
let errLost = 0;
function reportError(level, where, message, stack) {
  errQueue.push({ type: 'client_error', level: level === 'warn' ? 'warn' : 'error', where: String(where || '').slice(0, 60),
    message: String(message ?? '').slice(0, 2000), stack: String(stack || '').slice(0, 4000) });
  while (errQueue.length > 20) { errQueue.shift(); errLost++; }
  flushErrors();
}
function flushErrors() {
  if (!sock || sock.readyState !== 1 || state !== 'ok') return;
  if (errLost) { errQueue.unshift({ type: 'client_error', level: 'warn', where: 'background', message: `${errLost} خطای قدیمی‌تر افزونه پیش از اتصال از صف بیرون افتاد`, stack: '' }); errLost = 0; }
  while (errQueue.length) { try { sock.send(JSON.stringify(errQueue[0])); errQueue.shift(); } catch { return; } }
}
self.addEventListener('error', e => reportError('error', 'background', e.message || String(e.error), e.error?.stack));
self.addEventListener('unhandledrejection', e => reportError('error', 'background', 'Promise ردشده: ' + (e.reason?.message || String(e.reason)), e.reason?.stack));

// ---------- tool calls: relays from the content script to the local app ----------
function callLocal(call, token) {
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done) { done = true; clearTimeout(t); try { ws.close(); } catch {} resolve(r); } };
    let ws;
    try { ws = new WebSocket(WS_URL); } catch (e) { return resolve({ ok: false, error: String(e) }); }
    const t = setTimeout(() => finish({ ok: false, error: 'timeout (۵ دقیقه)' }), 300000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
    ws.onerror = () => finish({ ok: false, error: 'اتصال به برنامه‌ی Gap Bridge ممکن نیست. برنامه باز است؟' });
    ws.onclose = () => finish({ ok: false, error: 'اتصال بسته شد (توکن اشتباه؟)' });
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.type === 'auth') { if (m.ok) ws.send(JSON.stringify({ type: 'call', call })); else finish({ ok: false, error: 'توکن نامعتبر' }); }
      else if (m.type === 'result') finish(m);
    };
  });
}

chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (msg.type === 'call') {
    chrome.storage.local.get(['token', 'enabled']).then(({ token, enabled }) =>
      enabled === false && msg.call.id !== 'ping' ? { ok: false, error: 'افزونه خاموش است' } : callLocal(msg.call, token || '')).then(send);
    return true;
  }
  // فقط از اسکریپت‌های خود افزونه (content script)
  if (msg.type === 'gb-error' && _s.id === chrome.runtime.id) {
    reportError(msg.level, 'content' + (_s.tab ? '#' + _s.tab.id : ''), msg.message, msg.stack);
  }
});
