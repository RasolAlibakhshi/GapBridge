// ترمینال تعاملی داخل Gap Bridge.
// اگر ماژول PTY نصب باشد از آن استفاده می‌شود (رنگ، ANSI، اندازه‌ی پنجره، Ctrl+C واقعی).
// اگر نباشد، پوسته با لوله‌های stdin/stdout اجرا می‌شود و ورودی به‌صورت محلی ویرایش و نمایش داده می‌شود.
// تنها یک نشست هم‌زمان نگه داشته می‌شود؛ start دوباره، نشست قبلی را می‌بندد.

'use strict';
const { spawn, exec } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const MAXBUF = 200000;
const isWin = process.platform === 'win32';

function tryRequire(id) { try { return require(id); } catch { return null; } }
// اولین ماژول PTY موجود. هیچ‌کدام جزو وابستگی‌های اجباری نیستند.
const ptyMod = ['@lydell/node-pty', 'node-pty-prebuilt-multiarch', 'node-pty']
  .map(tryRequire).find(m => m && typeof m.spawn === 'function') || null;

// ---------- پاک‌سازی خروجی (برای خواندن مدل و نمایش پاک) ----------
const RE_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const RE_CSI = /\u001b\[[0-?]*[ -\/]*[@-~]/g;
const RE_ESC = /\u001b[@-Z\\-_]/g;
function applyBackspaces(s) {
  if (!s.includes('\u0008')) return s;
  let out = '';
  for (const ch of s) { if (ch === '\u0008') out = out.slice(0, -1); else out += ch; }
  return out;
}
function clean(s) {
  return applyBackspaces(String(s))
    .replace(RE_OSC, '').replace(RE_CSI, '').replace(RE_ESC, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

// ---------- پوسته‌ی پیش‌فرض ----------
function shellInfo() {
  if (isWin) return { key: 'cmd', name: 'cmd.exe', file: process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe', args: [] };
  const sh = process.env.SHELL || '/bin/bash';
  return { key: 'sh', name: path.basename(sh), file: sh, args: [] };
}

let S = null, seq = 0;

// ---------- نمایش محلی (فقط به رابط کاربری، نه به پوسته) ----------
function emit(s, text) {
  if (!text) return;
  s.buf = (s.buf + text).slice(-MAXBUF);
  s.total += text.length; // شمارنده‌ی کل؛ برای «خروجی از فلان نقطه به بعد»
  try { s.onData?.(text); } catch {}
}

// هر بار خروجی تازه آمد، تایمر «سکوت» را از نو می‌چینیم.
// در حالت لوله، پوسته‌ی غیرویندوزی prompt چاپ نمی‌کند؛ پس خودمان یکی می‌سازیم.
function armQuiet(s) {
  clearTimeout(s.quietTimer);
  s.quietTimer = setTimeout(() => {
    if (S !== s || !s.alive) return;
    if (isWin) return; // cmd.exe خودش prompt را چاپ می‌کند
    realCwd(s);
    emit(s, `\r\n\u001b[90m${s.cwd}\u001b[0m $ `);
    s.prompt = null;
  }, 1100);
}

function feed(s, d) {
  if (!s || S !== s) return;
  s.lastOut = Date.now();
  emit(s, String(d));
  if (!s.pty) armQuiet(s);
}

function end(s, code) {
  if (!s.alive) return;
  s.alive = false;
  clearTimeout(s.quietTimer);
  emit(s, `\r\n\u001b[90m[ترمینال بسته شد — کد ${code == null ? 0 : code}]\u001b[0m\r\n`);
  try { s.onExit?.(code == null ? 0 : code); } catch {}
}

// ---------- حالت لوله: ویرایشگر خط محلی ----------
// متن چاپ‌شده در خط جاری = prompt واقعی روی صفحه. برای بازکشیدن خط از آن استفاده می‌کنیم.
function capturePrompt(s) {
  const i = s.buf.lastIndexOf('\n');
  const tail = applyBackspaces(clean(s.buf.slice(i + 1)));
  s.prompt = tail.length <= 200 ? tail : '';
}
function redraw(s) {
  emit(s, '\r\u001b[K' + (s.prompt || '') + s.line);
  const back = s.line.length - s.pos;
  if (back > 0) emit(s, `\u001b[${back}D`);
}
function realCwd(s) { // لینوکس: پوشهٔ واقعی پوسته؛ دقیق‌تر از حدسِ trackCd برای «cd x && …»
  const pid = s.ch && s.ch.pid;
  if (!pid || process.platform !== 'linux') return;
  try { s.cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch {}
}
function trackCd(s, line) {
  const m = /^\s*cd(?:\s+(.*))?\s*$/.exec(line);
  if (!m) return;
  let t = (m[1] || '').replace(/^["']|["']$/g, '').trim();
  if (t === '') t = os.homedir();
  const abs = path.resolve(s.cwd, t);
  try { if (fs.statSync(abs).isDirectory()) s.cwd = abs; } catch {}
}
// بستن فرزندانِ پوسته، نه خود پوسته (Ctrl+C در حالت لوله به پوسته نمی‌رسد).
function kidsOf(pid) { // لینوکس: فرزندان مستقیم از /proc (بدون نیاز به pkill)
  const out = [];
  try {
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try { const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]); if (ppid === pid) out.push(Number(d)); } catch {}
    }
  } catch {}
  return out;
}
function killKids(s) {
  const pid = (s.ch && s.ch.pid) || (s.term && s.term.pid);
  if (!pid) return;
  try {
    if (isWin) exec(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`, { windowsHide: true }, () => {});
    else if (process.platform === 'linux' && fs.existsSync('/proc/self/stat')) {
      const sig = (k, ps) => ps.forEach(p => { try { process.kill(p, k); } catch {} });
      sig('SIGTERM', kidsOf(pid));
      setTimeout(() => sig('SIGKILL', kidsOf(pid)), 1000);
    }
    else exec(`pkill -TERM -P ${pid} || true; sleep 1; pkill -KILL -P ${pid} || true`, () => {});
  } catch {}
}
function submit(s) {
  const line = s.line;
  emit(s, '\r\n');
  if (line.trim()) { s.hist.push(line); if (s.hist.length > 200) s.hist.shift(); }
  s.hi = s.hist.length;
  trackCd(s, line);
  s.line = ''; s.pos = 0; s.prompt = null;
  try { s.ch.stdin.write(line + (isWin ? '\r\n' : '\n')); } catch (e) { emit(s, `\u001b[31m${e.message}\u001b[0m\r\n`); }
  armQuiet(s);
}
function key(s, ch) {
  if (ch === '\r' || ch === '\n') return submit(s);
  if (ch === '\u007f' || ch === '\u0008') {
    if (s.pos > 0) { if (s.prompt === null) capturePrompt(s); s.line = s.line.slice(0, s.pos - 1) + s.line.slice(s.pos); s.pos--; redraw(s); }
    return;
  }
  if (ch === '\u0003') { // Ctrl+C
    emit(s, '^C\r\n'); s.line = ''; s.pos = 0; s.prompt = null; killKids(s); armQuiet(s); return;
  }
  if (ch === '\u0004') { // Ctrl+D
    if (!s.line) { try { s.ch.stdin.end(); } catch {} }
    return;
  }
  if (ch === '\u0015') { if (s.prompt === null) capturePrompt(s); s.line = ''; s.pos = 0; redraw(s); return; }
  if (ch === '\u000c') { emit(s, '\u001b[2J\u001b[H'); s.prompt = null; redraw(s); return; }
  if (ch === '\t') { try { s.ch.stdin.write('\t'); } catch {} return; }
  const code = ch.codePointAt(0);
  if (code < 0x20) return;
  if (s.prompt === null) capturePrompt(s);
  s.line = s.line.slice(0, s.pos) + ch + s.line.slice(s.pos);
  s.pos += ch.length;
  redraw(s);
}
function escKey(s, t) {
  if (s.prompt === null) capturePrompt(s);
  const fin = t[t.length - 1];
  if (fin === 'A' || fin === 'B') { // بالا/پایین = تاریخچه
    if (!s.hist.length) return;
    s.hi += fin === 'A' ? -1 : 1;
    if (s.hi < 0) s.hi = 0;
    if (s.hi > s.hist.length) s.hi = s.hist.length;
    s.line = s.hi === s.hist.length ? '' : s.hist[s.hi];
    s.pos = s.line.length;
    return redraw(s);
  }
  if (fin === 'C') { if (s.pos < s.line.length) { s.pos++; redraw(s); } return; }
  if (fin === 'D') { if (s.pos > 0) { s.pos--; redraw(s); } return; }
  if (fin === 'H' || t === '\u001b[1~' || t === '\u001b[7~') { s.pos = 0; return redraw(s); }
  if (fin === 'F' || t === '\u001b[4~' || t === '\u001b[8~') { s.pos = s.line.length; return redraw(s); }
  if (t === '\u001b[3~') { // Delete
    if (s.pos < s.line.length) { s.line = s.line.slice(0, s.pos) + s.line.slice(s.pos + 1); redraw(s); }
    return;
  }
}
const TOK = /\u001b\[[0-9;?]*[A-Za-z~]|[\s\S]/gu;
function pipeInput(s, str) {
  for (const t of str.match(TOK) || []) {
    if (t.length > 1 && t[0] === '\u001b') escKey(s, t);
    else key(s, t);
  }
}

// ---------- API ----------
function start(opts = {}) {
  stop();
  const sh = shellInfo();
  let cwd = opts.cwd && typeof opts.cwd === 'string' ? opts.cwd : '';
  try { if (!cwd || !fs.statSync(cwd).isDirectory()) cwd = os.homedir(); } catch { cwd = os.homedir(); }
  const s = {
    id: 't' + (++seq), shell: sh, cwd, buf: '', started: Date.now(), alive: true, pty: !!ptyMod,
    cols: Math.max(20, Math.min(400, Number(opts.cols) || 100)), rows: Math.max(5, Math.min(200, Number(opts.rows) || 30)),
    line: '', pos: 0, prompt: null, hist: [], hi: 0, quietTimer: null, total: 0, lastOut: Date.now(),
    onData: opts.onData, onExit: opts.onExit,
  };
  S = s;
  if (ptyMod) {
    try {
      s.term = ptyMod.spawn(sh.file, sh.args, {
        name: 'xterm-256color', cols: s.cols, rows: s.rows, cwd, env: process.env, useConpty: true,
      });
      s.term.onData(d => feed(s, d));
      s.term.onExit(e => end(s, e && e.exitCode));
    } catch (e) {
      s.alive = false; S = null;
      throw new Error('اجرای PTY ناموفق بود: ' + e.message);
    }
  } else {
    s.ch = spawn(sh.file, sh.args, {
      cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { TERM: 'xterm-256color' }),
    });
    s.ch.stdout.on('data', d => feed(s, d.toString('utf8')));
    s.ch.stderr.on('data', d => feed(s, d.toString('utf8')));
    s.ch.on('error', e => { emit(s, `\r\n\u001b[31m${e.message}\u001b[0m\r\n`); end(s, -1); });
    s.ch.on('exit', c => end(s, c));
    s.ch.stdin.on('error', () => {});
  }
  return view();
}

function write(data) {
  const s = S;
  if (!s || !s.alive) return false;
  const str = String(data == null ? '' : data);
  if (!str) return true;
  if (s.pty) { try { s.term.write(str); } catch { return false; } return true; }
  pipeInput(s, str);
  return true;
}

// فرمانِ دستیار: از ویرایشگر خط رد می‌شود و یک خط کامل می‌فرستد.
// اگر کاربر نیمه‌کاره چیزی تایپ کرده باشد، آن خط کنار گذاشته می‌شود.
function send(cmd) {
  const s = S;
  if (!s || !s.alive) return false;
  const line = String(cmd == null ? '' : cmd).replace(/[\r\n]+$/, '');
  if (/[\r\n]/.test(line)) throw new Error('فرمان ترمینال باید یک خط باشد');
  if (s.pty) {
    try { s.term.write((isWin ? '' : '\u0015') + line + '\r'); } catch { return false; } // Ctrl+U در bash/zsh خط نیمه‌کاره را پاک می‌کند؛ در cmd معادل امنی نیست
    return true;
  }
  if (s.prompt === null) capturePrompt(s);
  s.line = line; s.pos = line.length;
  redraw(s);
  submit(s);
  return true;
}

// شمارنده‌ی فعلی خروجی؛ با since(mark) فقط خروجی تازه را می‌گیریم.
function mark() { return S ? S.total : 0; }
function since(m, max = 20000) {
  if (!S) return '';
  const n = S.total - (Number(m) || 0);
  if (n <= 0) return '';
  const raw = n >= S.buf.length ? S.buf : S.buf.slice(-n);
  const t = applyBackspaces(clean(raw));
  return t.length > max ? '…' + t.slice(-max) : t;
}
// صبر تا وقتی خروجی quietMs ساکت بماند یا سقف زمان برسد.
function settle(maxMs = 3000, quietMs = 700) {
  const t0 = Date.now();
  return new Promise(res => {
    const tick = () => {
      const s = S, now = Date.now();
      if (!s || !s.alive || now - t0 >= maxMs || (now - t0 >= quietMs && now - s.lastOut >= quietMs)) return res();
      setTimeout(tick, 100);
    };
    setTimeout(tick, 100);
  });
}

function resize(cols, rows) {
  const s = S; if (!s) return false;
  s.cols = Math.max(20, Math.min(400, Number(cols) || s.cols));
  s.rows = Math.max(5, Math.min(200, Number(rows) || s.rows));
  if (s.pty && s.alive) { try { s.term.resize(s.cols, s.rows); } catch {} }
  return true;
}

function stop() {
  const s = S;
  if (!s) return false;
  S = null;
  clearTimeout(s.quietTimer);
  s.alive = false;
  try {
    if (s.pty) s.term.kill();
    else if (s.ch) {
      try { s.ch.stdin.end(); } catch {}
      if (s.ch.pid) {
        if (isWin) exec(`taskkill /pid ${s.ch.pid} /T /F`, { windowsHide: true }, () => {});
        else { try { s.ch.kill('SIGKILL'); } catch {} }
      }
    }
  } catch {}
  return true;
}

function view() {
  if (!S) return { running: false, pty: !!ptyMod, shell: shellInfo(), cwd: os.homedir(), id: null, secs: 0, bytes: 0 };
  const s = S;
  return {
    id: s.id, running: s.alive, pty: s.pty, shell: s.shell, cwd: s.cwd,
    cols: s.cols, rows: s.rows, started: s.started,
    secs: Math.round(((s.alive ? Date.now() : s.ended || Date.now()) - s.started) / 1000),
    bytes: s.buf.length,
  };
}

// متن قابل‌خواندن؛ برای ابزارهای مدل.
function read(n = 4000) {
  if (!S) return '';
  const t = clean(S.buf);
  const k = Math.max(0, Math.min(20000, Number(n) || 4000));
  return k ? t.slice(-k) : t;
}

module.exports = { start, write, send, mark, since, settle, resize, stop, view, read, clean, shellInfo, pty: !!ptyMod, MAXBUF };
