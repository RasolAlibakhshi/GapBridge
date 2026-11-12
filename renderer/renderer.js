const $ = id => document.getElementById(id);
function drawRoots(roots) {
  const ul = $('roots'); ul.textContent = '';
  roots.forEach(p => {
    const li = document.createElement('li');
    const s = document.createElement('span'); s.textContent = p;
    const b = document.createElement('button'); b.className = 'x'; b.textContent = 'حذف';
    b.onclick = async () => drawRoots(await api.removeRoot(p));
    li.append(s, b); ul.append(li);
  });
  if (!roots.length) ul.textContent = 'هنوز پوشه‌ای اضافه نشده.';
  obRoots(roots);
}
function drawStatus(s) {
  const ok = s.connected || s.lastSeen;
  $('dot').className = 'dot' + (ok ? ' on' : '');
  $('st').textContent = s.connected ? 'افزونه‌ی کروم وصل است'
    : s.lastSeen ? 'افزونه کار می‌کند (آخرین ارتباط ' + new Date(s.lastSeen).toLocaleTimeString('fa-IR') + ')'
    : 'هنوز ارتباطی از افزونه نیامده؛ در popup افزونه «ذخیره» را بزن';
  obStatus(s);
}
function drawAuto(on) {
  $('auto').checked = on;
  $('automsg').textContent = on ? '⚠ فعال: نوشتن، ویرایش، حذف و اجرای دستور بدون تأیید انجام می‌شود.' : 'خاموش: برای نوشتن، ویرایش، حذف و اجرای دستور، پنجره‌ی تأیید باز می‌شود.';
  $('automsg').style.color = on ? '#f90' : '#9a9';
}
$('kill').onclick = () => api.killAll();
$('rot').onclick = () => api.rotateToken();
$('data').onclick = () => api.openData();
$('auto').onchange = async e => drawAuto(await api.setAuto(e.target.checked));
api.state().then(s => { drawRoots(s.roots); drawStatus(s); drawAuto(s.autoApprove); $('port').textContent = s.port; if (!s.onboarded) obShow(); });
api.onStatus(drawStatus);
// ---------- کنسول خطاها: منبع واحد در main؛ هر بار فهرست فیلترشده از main گرفته می‌شود ----------
const lgFilter = () => ({ level: $('llv').value, source: $('lsrc').value, q: $('lq').value });
const SRC = { main: 'برنامه', ui: 'رابط', ext: 'افزونه', tool: 'ابزار' };
let lgTm = 0, lgBusy = false, lgAgain = false;
function lgBadge(s) {
  const b = $('lbadge'); b.textContent = '';
  if (!s) return;
  if (s.error) { const x = document.createElement('span'); x.className = 'e'; x.textContent = `● ${s.error} خطا `; b.append(x); }
  if (s.warn) { const x = document.createElement('span'); x.className = 'w'; x.textContent = `● ${s.warn} هشدار`; b.append(x); }
}
function lgDraw(r) {
  const d = $('log'), rows = r.items || [];
  const near = d.scrollHeight - d.scrollTop - d.clientHeight < 40;
  const frag = document.createDocumentFragment();
  for (const e of rows.slice(-600)) {
    const el = document.createElement('div'); el.className = 'r ' + e.level;
    const t = document.createElement('span'); t.className = 't'; t.textContent = new Date(e.t).toLocaleTimeString('fa-IR') + ' ';
    const s = document.createElement('span'); s.className = 's'; s.textContent = `[${SRC[e.source] || e.source}] `;
    el.append(t, s, document.createTextNode(e.msg));
    if (e.n > 1) { const n = document.createElement('span'); n.className = 'n'; n.textContent = '×' + e.n; el.append(n); }
    if (e.stack) { const k = document.createElement('span'); k.className = 'k'; k.textContent = e.stack; el.append(k); }
    frag.append(el);
  }
  if (!rows.length) { const x = document.createElement('div'); x.className = 'empty'; x.textContent = r.stats?.total ? 'موردی با این فیلتر نیست.' : 'هنوز گزارشی نیست.'; frag.append(x); }
  if (rows.length > 600) { const x = document.createElement('div'); x.className = 'empty'; x.textContent = `فقط ۶۰۰ ردیف آخر از ${rows.length} نمایش داده شده؛ «کپی» همه را برمی‌دارد.`; frag.prepend(x); }
  d.replaceChildren(frag);
  if (near) d.scrollTop = d.scrollHeight;
  lgBadge(r.stats);
}
// درخواست هم‌زمان نمی‌فرستد؛ اگر وسط کار تغییری آمد، یک بار دیگر می‌خواند
async function lgRefresh() {
  lgTm = 0;
  if (lgBusy) { lgAgain = true; return; }
  lgBusy = true;
  try { lgDraw(await api.logList(lgFilter())); } catch {}
  lgBusy = false;
  if (lgAgain) { lgAgain = false; lgSoon(); }
}
const lgSoon = () => { if (!lgTm) lgTm = setTimeout(lgRefresh, 200); };
api.onLog(p => { if (p && p.stats) lgBadge(p.stats); lgSoon(); });
lgRefresh();
$('llv').onchange = lgRefresh; $('lsrc').onchange = lgRefresh; $('lq').oninput = lgSoon;
$('lcp').onclick = async () => { const r = await api.logCopy(lgFilter()); $('lmsg').textContent = `${r.count} ردیف (مطابق فیلتر) کپی شد ✓ — توکن و مسیر خانه پنهان شد`; };
$('lclr').onclick = async () => { if (!confirm('همهٔ گزارش‌ها پاک شود؟')) return; lgDraw(await api.logClear()); $('lmsg').textContent = 'گزارش پاک شد.'; };
$('add').onclick = async () => drawRoots(await api.addRoot());
$('tok').onclick = async () => { await api.copyToken(); $('tok').textContent = 'کپی شد ✓'; setTimeout(() => $('tok').textContent = 'کپی توکن (برای افزونه)', 1500); };
$('ins').onclick = async () => { await api.copyInstructions(); $('ins').textContent = 'کپی شد ✓'; setTimeout(() => $('ins').textContent = 'کپی دستورالعمل', 1500); };

api.state().then(s => { $('hk1').value = s.hotkeys.copy || 'CommandOrControl+Shift+G'; $('hk2').value = s.hotkeys.reset || 'CommandOrControl+Shift+R'; if (!s.win) $('winrow').style.display = 'none'; });
$('hks').onclick = async () => { await api.setHotkeys({ copy: $('hk1').value, reset: $('hk2').value }); $('hkmsg').textContent = 'ذخیره شد (اگر ثبت نشد، در گزارش زنده پیام می‌آید)'; };
$('shon').onclick = async () => { $('hkmsg').textContent = (await api.shellMenu(true)) ? 'نصب شد' : 'ناموفق'; };
$('shoff').onclick = async () => { $('hkmsg').textContent = (await api.shellMenu(false)) ? 'حذف شد' : 'ناموفق'; };
async function drawJobs() {
  const ul = $('jobs'), js = await api.jobs(); ul.textContent = '';
  if (!js.length) { ul.textContent = 'کاری در حال اجرا نیست.'; return; }
  js.forEach(j => {
    const li = document.createElement('li'), sp = document.createElement('span');
    sp.textContent = `${j.id} [${j.status}] ${j.command.slice(0, 50)}`; li.append(sp);
    if (j.status === 'running') { const b = document.createElement('button'); b.className = 'x'; b.textContent = 'توقف'; b.onclick = () => api.jobKill(j.id); li.append(b); }
    ul.append(li);
  });
}
drawJobs(); setInterval(drawJobs, 3000);

// ---------- مرورگر Chromium ----------
let bBusy = false;
function drawBrowser(b) {
  $('bdot').className = 'dot' + (b.running ? ' on' : '');
  $('bst').textContent = b.running ? `در حال اجرا روی پورت ${b.port}${b.browser ? ' — ' + b.browser : ''}${b.ours ? '' : ' (خارج از Gap Bridge اجرا شده)'}`
    : b.resolved ? 'خاموش' : '⚠ مرورگر Chromium-محوری پیدا نشد؛ Chrome یا Edge نصب کنید یا «انتخاب دستی» را بزنید';
  const sel = $('bsel'); sel.textContent = '';
  const opts = [...b.found];
  if (b.exe && !opts.some(o => o.path === b.exe)) opts.push({ name: 'دستی', path: b.exe });
  opts.forEach(o => { const op = document.createElement('option'); op.value = o.path; op.textContent = `${o.name} — ${o.path}`; sel.append(op); });
  if (!opts.length) { const op = document.createElement('option'); op.textContent = 'پیدا نشد'; op.value = ''; sel.append(op); }
  sel.value = b.resolved || '';
  $('bagent').checked = b.agentLaunch; $('bauto').checked = b.autoStart; $('bhead').checked = b.headless;
  $('blaunch').disabled = bBusy || b.running || !b.resolved;
  $('bstop').disabled = bBusy || !b.ours;
}
const refreshBrowser = async () => { if (!bBusy) drawBrowser(await api.browserInfo()); };
$('bsel').onchange = async e => drawBrowser(await api.browserSet({ exe: e.target.value }));
$('bpick').onclick = async () => drawBrowser(await api.browserPick());
$('bagent').onchange = async e => drawBrowser(await api.browserSet({ agentLaunch: e.target.checked }));
$('bauto').onchange = async e => drawBrowser(await api.browserSet({ autoStart: e.target.checked }));
$('bhead').onchange = async e => drawBrowser(await api.browserSet({ headless: e.target.checked }));
$('blaunch').onclick = async () => {
  bBusy = true; $('blaunch').disabled = true; $('bst').textContent = 'در حال اجرا…';
  const r = await api.browserLaunch(); bBusy = false;
  drawBrowser(r.info); $('bmsg').textContent = r.ok ? 'مرورگر آماده است ✓ حالا دستیار می‌تواند از ابزارهای browser_* استفاده کند.' : '✗ ' + r.error;
};
$('bstop').onclick = async () => { const r = await api.browserStop(); drawBrowser(r.info); };
$('breset').onclick = async () => {
  if (!confirm('پروفایل مرورگر (کوکی‌ها و لاگین‌های این پروفایل) پاک شود؟')) return;
  const r = await api.browserResetProfile(); $('bmsg').textContent = r.ok ? 'پروفایل پاک شد' : '✗ ' + r.error;
};
refreshBrowser(); setInterval(refreshBrowser, 4000);

// ---------- ترمینال ----------
// نمایشگر سبک ANSI؛ شبیه‌ساز کامل نیست. برنامه‌های تمام‌صفحه (vim، htop) درست دیده نمی‌شوند.
const term = (() => {
  const el = $('term'), MAXL = 2000;
  const PAL = ['#1b1f2a', '#ff6b6b', '#5fd38d', '#f5c451', '#6aa7ff', '#c792ea', '#56d4dd', '#d7e3ff',
    '#6b7280', '#ff8f8f', '#86efac', '#fde68a', '#93c5fd', '#e9b5ff', '#99f6e4', '#ffffff'];
  let lines = [[]], row = 0, col = 0, sty = null, pend = '', raf = 0, cols = 100, rows = 30, live = false;
  const cell = ch => ({ ch, s: sty });
  const cur = () => lines[row] || (lines[row] = []);
  function nl() {
    row++; while (lines.length <= row) lines.push([]);
    if (lines.length > MAXL) { const k = lines.length - MAXL; lines.splice(0, k); row -= k; }
  }
  function put(ch) {
    const L = cur(); while (L.length < col) L.push(cell(' '));
    L[col] = cell(ch); col++;
  }
  function top() { return Math.max(0, lines.length - rows); }
  function sgr(ps) {
    const a = ps === '' ? [0] : ps.split(';').map(Number);
    let s = Object.assign({}, sty || {});
    for (let i = 0; i < a.length; i++) {
      const n = a[i];
      if (n === 0) s = {};
      else if (n === 1) s.b = 1; else if (n === 22) delete s.b;
      else if (n === 4) s.u = 1; else if (n === 24) delete s.u;
      else if (n === 7) s.r = 1; else if (n === 27) delete s.r;
      else if (n >= 30 && n <= 37) s.fg = PAL[n - 30]; else if (n >= 90 && n <= 97) s.fg = PAL[n - 82];
      else if (n >= 40 && n <= 47) s.bg = PAL[n - 40]; else if (n >= 100 && n <= 107) s.bg = PAL[n - 92];
      else if (n === 39) delete s.fg; else if (n === 49) delete s.bg;
      else if ((n === 38 || n === 48) && a[i + 1] === 5) { const c = x256(a[i + 2]); if (n === 38) s.fg = c; else s.bg = c; i += 2; }
      else if ((n === 38 || n === 48) && a[i + 1] === 2) { const c = `rgb(${a[i + 2] | 0},${a[i + 3] | 0},${a[i + 4] | 0})`; if (n === 38) s.fg = c; else s.bg = c; i += 4; }
    }
    sty = Object.keys(s).length ? s : null;
  }
  function x256(n) {
    n = n | 0; if (n < 16) return PAL[n];
    if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
    n -= 16; const f = v => (v ? v * 40 + 55 : 0);
    return `rgb(${f(Math.floor(n / 36))},${f(Math.floor(n / 6) % 6)},${f(n % 6)})`;
  }
  function csi(p, f) {
    const priv = p[0] === '?'; if (priv) return; // ?25h و مانند آن: نادیده
    const a = p.split(';').map(x => parseInt(x, 10));
    const n = Number.isFinite(a[0]) && a[0] > 0 ? a[0] : 1;
    if (f === 'm') return sgr(p);
    if (f === 'K') {
      const L = cur(), m = a[0] || 0;
      if (m === 0) L.length = Math.min(L.length, col);
      else if (m === 1) for (let i = 0; i <= col && i < L.length; i++) L[i] = cell(' ');
      else lines[row] = [];
      return;
    }
    if (f === 'J') {
      const m = a[0] || 0;
      if (m === 2 || m === 3) { lines = [[]]; row = 0; col = 0; }
      else if (m === 0) { cur().length = Math.min(cur().length, col); lines.length = row + 1; }
      return;
    }
    if (f === 'H' || f === 'f') {
      const r = (Number.isFinite(a[0]) && a[0] > 0 ? a[0] : 1) - 1, c = (Number.isFinite(a[1]) && a[1] > 0 ? a[1] : 1) - 1;
      row = top() + r; while (lines.length <= row) lines.push([]); col = c; return;
    }
    if (f === 'A') { row = Math.max(top(), row - n); return; }
    if (f === 'B') { row += n; while (lines.length <= row) lines.push([]); return; }
    if (f === 'C') { col += n; return; }
    if (f === 'D') { col = Math.max(0, col - n); return; }
    if (f === 'G') { col = n - 1; return; }
    if (f === 'P') { cur().splice(col, n); return; }
    if (f === '@') { cur().splice(col, 0, ...Array.from({ length: n }, () => cell(' '))); return; }
    if (f === 'X') { const L = cur(); for (let i = col; i < col + n && i < L.length; i++) L[i] = cell(' '); return; }
    // سایر دستورها نادیده گرفته می‌شوند
  }
  function write(text) {
    let s = pend + text; pend = '';
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\u001b') {
        if (i + 1 >= s.length) { pend = s.slice(i); break; }
        const nx = s[i + 1];
        if (nx === '[') {
          let j = i + 2; while (j < s.length && !/[@-~]/.test(s[j])) j++;
          if (j >= s.length) { pend = s.slice(i); break; }
          csi(s.slice(i + 2, j), s[j]); i = j + 1; continue;
        }
        if (nx === ']') { // OSC (عنوان پنجره و…) تا BEL یا ESC\
          const b = s.indexOf('\u0007', i), e = s.indexOf('\u001b\\', i);
          const end = b < 0 ? e : e < 0 ? b : Math.min(b, e);
          if (end < 0) { if (s.length - i < 4096) pend = s.slice(i); break; }
          i = end + (s[end] === '\u0007' ? 1 : 2); continue;
        }
        i += (nx === '(' || nx === ')') ? 3 : 2; continue;
      }
      if (ch === '\r') col = 0;
      else if (ch === '\n') { nl(); col = 0; }
      else if (ch === '\b') col = Math.max(0, col - 1);
      else if (ch === '\t') { const t = (Math.floor(col / 8) + 1) * 8; while (col < t) put(' '); }
      else if (ch === '\u0007') { /* زنگ */ }
      else if (ch >= ' ' || ch > '\u007f') put(ch);
      i++;
    }
    schedule();
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(render); }
  function css(s) {
    if (!s) return '';
    let fg = s.fg, bg = s.bg; if (s.r) { const t = fg || '#d7e3ff'; fg = bg || '#03050c'; bg = t; }
    return (fg ? `color:${fg};` : '') + (bg ? `background:${bg};` : '') + (s.b ? 'font-weight:bold;' : '') + (s.u ? 'text-decoration:underline;' : '');
  }
  function render() {
    raf = 0;
    const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    const frag = document.createDocumentFragment();
    const showCur = live && document.activeElement === el;
    lines.forEach((L, r) => {
      let run = '', rs;
      const flush = () => { if (!run) return; const sp = document.createElement('span'); const c = css(rs); if (c) sp.style.cssText = c; sp.textContent = run; frag.append(sp); run = ''; };
      const n = showCur && r === row ? Math.max(L.length, col + 1) : L.length;
      for (let c = 0; c < n; c++) {
        const k = L[c] || { ch: ' ', s: null };
        if (showCur && r === row && c === col) { flush(); const sp = document.createElement('span'); sp.className = 'cu'; sp.textContent = k.ch; frag.append(sp); continue; }
        if (k.s !== rs) { flush(); rs = k.s; }
        run += k.ch;
      }
      flush();
      if (r < lines.length - 1) frag.append('\n');
    });
    el.textContent = ''; el.append(frag);
    if (stick) el.scrollTop = el.scrollHeight;
  }
  function clear() { lines = [[]]; row = 0; col = 0; sty = null; pend = ''; schedule(); }
  function measure() {
    const probe = document.createElement('span'); probe.textContent = 'M'.repeat(20);
    probe.style.cssText = 'visibility:hidden;position:absolute';
    el.append(probe); const w = probe.getBoundingClientRect().width / 20, h = probe.getBoundingClientRect().height; probe.remove();
    const cs = getComputedStyle(el), pw = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const ph = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (w > 0) cols = Math.max(20, Math.min(400, Math.floor(pw / w)));
    if (h > 0) rows = Math.max(5, Math.min(200, Math.floor(ph / h)));
    return { cols, rows };
  }
  return { el, write, clear, measure, schedule, setLive: v => { live = v; schedule(); } };
})();

function drawTerm(v) {
  $('tdot').className = 'dot' + (v.running ? ' on' : '');
  const mode = v.pty ? 'PTY' : 'حالت ساده (بدون PTY)';
  $('tst').textContent = v.running ? `باز — ${v.shell?.name || ''} — ${mode} — ${v.cwd}` : `بسته — ${mode}`;
  $('tstart').textContent = v.running ? '↻ شروع دوباره' : '▶ شروع';
  $('tint').disabled = $('tstop').disabled = !v.running;
  term.setLive(!!v.running);
}
const refreshTerm = async () => drawTerm(await api.terminalView());
const sendKey = d => api.terminalWrite(d);

$('tstart').onclick = async () => {
  const v0 = await api.terminalView();
  if (v0.running && !confirm('نشست فعلی ترمینال بسته و یک نشست تازه باز شود؟')) return;
  term.clear();
  const { cols, rows } = term.measure();
  try { drawTerm(await api.terminalStart({ cols, rows })); term.el.focus(); }
  catch (e) { term.write(`\r\n\u001b[31m${e.message}\u001b[0m\r\n`); }
};
$('tint').onclick = () => { sendKey('\u0003'); term.el.focus(); };
$('tstop').onclick = async () => { await api.terminalStop(); term.write('\r\n\u001b[90m[بسته شد]\u001b[0m\r\n'); refreshTerm(); };
$('tclear').onclick = () => { term.clear(); term.el.focus(); };
$('tagent').onchange = async e => { e.target.checked = await api.terminalSetAgent(e.target.checked); };
api.state().then(s => { $('tagent').checked = s.termAgent !== false; });
api.onTermData(t => term.write(t));
api.onTermExit(() => refreshTerm());
api.onTermStarted(v => { term.clear(); term.write('\u001b[90m[نشست تازه توسط دستیار]\u001b[0m\r\n'); drawTerm(v); });

const KEYS = { Enter: '\r', Backspace: '\u007f', Tab: '\t', Escape: '\u001b', ArrowUp: '\u001b[A', ArrowDown: '\u001b[B',
  ArrowRight: '\u001b[C', ArrowLeft: '\u001b[D', Home: '\u001b[H', End: '\u001b[F', Delete: '\u001b[3~',
  PageUp: '\u001b[5~', PageDown: '\u001b[6~', Insert: '\u001b[2~' };
term.el.addEventListener('keydown', e => {
  if (e.isComposing) return;
  const sel = String(getSelection() || '');
  // Ctrl+C با متن انتخاب‌شده = کپی؛ Ctrl+Shift+C همیشه کپی؛ Ctrl+V / Ctrl+Shift+V = چسباندن (رویداد paste)
  if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && (sel || e.shiftKey)) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) return;
  let d = null;
  if (KEYS[e.key] && !e.ctrlKey && !e.metaKey) d = KEYS[e.key];
  else if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
    const c = e.key.toLowerCase().charCodeAt(0);
    if (c >= 97 && c <= 122) d = String.fromCharCode(c - 96);
    else if (e.key === '[') d = '\u001b'; else if (e.key === '\\') d = '\u001c'; else if (e.key === ']') d = '\u001d';
  } else if (!e.ctrlKey && !e.metaKey && e.key.length >= 1 && [...e.key].length === 1) d = (e.altKey ? '\u001b' : '') + e.key;
  if (d == null) return;
  e.preventDefault(); sendKey(d);
});
document.addEventListener('paste', e => {
  if (document.activeElement !== term.el) return;
  const t = e.clipboardData?.getData('text/plain'); if (!t) return;
  e.preventDefault(); sendKey(t.replace(/\r?\n/g, '\r'));
});
term.el.addEventListener('focus', () => term.schedule());
term.el.addEventListener('blur', () => term.schedule());
let rzT = 0;
new ResizeObserver(() => { clearTimeout(rzT); rzT = setTimeout(() => { const { cols, rows } = term.measure(); api.terminalResize(cols, rows); }, 200); }).observe(term.el);
refreshTerm(); setInterval(refreshTerm, 3000);

// ---------- دسترسی‌ها، تاریخچه، ممیزی ----------
(function () {
  const L = { default: 'پیش‌فرض', ask: 'همیشه بپرس', auto: 'خودکار', deny: 'رد' };
  async function drawPerms() {
    const p = await api.perms(), box = $('permrows'); box.textContent = '';
    for (const g of Object.keys(p.groups)) {
      const row = document.createElement('div'); row.className = 'row';
      const lb = document.createElement('span'); lb.textContent = p.groups[g] + ': ';
      const sel = document.createElement('select');
      for (const m of p.modes) { const o = document.createElement('option'); o.value = m; o.textContent = L[m] || m; sel.appendChild(o); }
      sel.value = p.perms[g];
      sel.onchange = async () => { await api.setPerm(g, sel.value); drawPerms(); };
      row.append(lb, sel); box.appendChild(row);
    }
  }
  async function drawHist() {
    const ul = $('hist'), items = await api.historyList(50); ul.textContent = '';
    if (!items.length) { const li = document.createElement('li'); li.textContent = 'هنوز تغییری ثبت نشده'; ul.appendChild(li); return; }
    for (const e of items) {
      const li = document.createElement('li');
      const s = document.createElement('span'); s.dir = 'ltr';
      s.textContent = `${new Date(e.t).toLocaleString('fa-IR')}  ${e.op}  ${e.target}${e.created ? '  (فایل تازه)' : ''}${e.changed ? '  (بعداً تغییر کرده)' : ''}`;
      li.appendChild(s);
      if (e.restored) { li.append(' ✓ بازگردانی‌شده'); }
      else { const b = document.createElement('button'); b.className = 'ghost'; b.textContent = '↶ بازگردانی';
        b.onclick = async () => { const r = await api.historyRestore(e.id); $('hmsg').textContent = r.ok ? 'بازگردانی شد' : (r.cancelled ? '' : 'ناموفق: ' + r.error); drawHist(); };
        li.appendChild(b); }
      ul.appendChild(li);
    }
  }
  async function drawAudit() {
    const rows = await api.auditTail({ n: 200, q: $('aq').value, kind: $('ak').value, ok: $('ao').value });
    $('alog').textContent = ((rows && rows.items) || []).map(r => JSON.stringify(r)).join('\n');
  }
  $('ago').onclick = drawAudit;
  api.onHistoryChanged(drawHist);
  drawPerms(); drawHist(); drawAudit();
})();

// ---------- راهنمای شروع ----------
// obRoots/obStatus از drawRoots/drawStatus صدا زده می‌شوند (تعریف تابع hoist می‌شود، پس ترتیب مهم نیست)
function obMark(n, on, msg) {
  const li = $('ob' + n); if (!li) return;
  li.classList.toggle('done', !!on); li.querySelector('.ck').textContent = on ? '✓' : '○';
  if (msg !== undefined && $('ob' + n + 'm')) $('ob' + n + 'm').textContent = msg;
}
function obRoots(roots) { obMark(1, roots.length > 0, roots.length ? roots.length + ' پوشه: ' + roots[0] : ''); }
function obStatus(s) {
  const ok = !!(s.connected || s.lastSeen);
  $('obdot').className = 'dot' + (ok ? ' on' : '');
  obMark(4, ok, ok ? 'وصل شد ✓ حالا در چت gapgpt.app دکمهٔ «کپی دستورالعمل» را بزنید یا از popup افزونه استفاده کنید.' : 'منتظر اتصال…');
  if (ok) { obMark(2, true); obMark(3, true); }
}
function obShow() { $('ob').classList.add('on'); $('obadd').focus(); }
function obHide() { $('ob').classList.remove('on'); }
$('obopen').onclick = obShow;
$('obadd').onclick = async () => drawRoots(await api.addRoot());
$('obext').onclick = async () => {
  const r = await api.openExtensionDir();
  if (r.error && !r.dir) return obMark(2, false, 'خطا: ' + r.error);
  obMark(2, true, (r.error ? 'پوشه باز نشد؛ ' : 'مسیر کپی شد: ') + r.dir + (r.updated ? ' — نسخهٔ جدید؛ در chrome://extensions «بارگذاری دوباره» را بزنید' : ''));
};
$('obtok').onclick = async () => { await api.copyToken(); obMark(3, true); $('obtok').textContent = 'کپی شد ✓'; setTimeout(() => $('obtok').textContent = 'کپی توکن', 1500); };
$('oblater').onclick = obHide;
$('obdone').onclick = async () => { await api.onboardDone(true); obHide(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('ob').classList.contains('on')) obHide(); });

// ---------- به‌روزرسانی ----------
(() => {
  function draw(i) {
    $('uver').textContent = i.version;
    if (document.activeElement !== $('uurl')) $('uurl').value = i.url;
    $('uauto').checked = i.auto;
    $('ucheck').disabled = !i.supported || i.stage === 'checking' || i.stage === 'downloading';
    $('umsg').textContent = i.error ? '✗ ' + i.error : !i.supported ? i.reason : i.msg || (i.url ? 'آمادهٔ بررسی.' : 'آدرس سرور خالی است؛ به‌روزرسانی خاموش است.');
  }
  const save = async () => draw(await api.updateSet({ url: $('uurl').value, auto: $('uauto').checked }));
  $('usave').onclick = save;
  $('uauto').onchange = save;
  $('ucheck').onclick = async () => { const i = await api.updateSet({ url: $('uurl').value }); if (i.error) return draw(i); $('ucheck').disabled = true; draw(await api.updateCheck()); };
  api.onUpdate(s => { $('umsg').textContent = s.msg; $('ucheck').disabled = s.stage === 'checking' || s.stage === 'downloading'; });
  api.updateInfo().then(draw);
})();
