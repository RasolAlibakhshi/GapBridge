const { app, BrowserWindow, ipcMain, dialog, clipboard, Tray, Menu, nativeImage, Notification, globalShortcut } = require('electron');
const tokens = require('./lib/tokens');
const rag = require('./lib/rag');
const jobs = require('./lib/jobs');
const chromium = require('./lib/browser');
const terminal = require('./lib/terminal');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const { WebSocketServer } = require('ws');
const LIB = n => require(path.join(__dirname, 'lib', n));
const perms = LIB('perms');
const auditLog = LIB('audit');
const historyLib = LIB('history');
const diff = LIB('diff');
const updaterLib = LIB('updater');
const logbuf = LIB('logbuf');
const logs = logbuf.create({ max: 1000 }); // کنسول خطاها: فقط در حافظه
let updater = null; // در whenReady ساخته می‌شود
let history = null; // در whenReady ساخته می‌شود

const PORT = 8765;
let win, cfg, cfgFile, connected = 0, lastSeen = 0, tray, wssRef;

// ---------- config ----------
function loadCfg() {
  cfgFile = path.join(app.getPath('userData'), 'config.json');
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { cfg = {}; }
  cfg.roots = cfg.roots || [];
  cfg.autoApprove = cfg.autoApprove === true;
  cfg.token = cfg.token || crypto.randomBytes(16).toString('hex');
  cfg.browser = Object.assign({ exe: '', headless: false, autoStart: false, agentLaunch: true }, cfg.browser || {});
  cfg.terminal = Object.assign({ agent: true, cols: 100, rows: 30 }, cfg.terminal || {});
  cfg.perms = perms.normalize(cfg.perms);
  // کاربرانی که از نسخهٔ قبل آمده‌اند و پوشه دارند، راهنمای شروع را نمی‌بینند
  if (typeof cfg.onboarded !== 'boolean') cfg.onboarded = cfg.roots.length > 0;
  cfg.update = Object.assign({ url: '', auto: false }, cfg.update || {});
  saveCfg();
}
function saveCfg() { fs.mkdirSync(path.dirname(cfgFile), { recursive: true }); fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2)); }
// log(msg, level='info'|'warn'|'error', source='main'|'ui'|'ext'|'tool', {stack})؛ سطح همیشه از محل فراخوانی، نه از متن
function log(msg, level = 'info', source = 'main', extra) {
  try {
    const e = logs.add(level, source, msg, extra);
    const l = `[${new Date(e.t).toLocaleTimeString('fa-IR')}] ${e.msg}`;
    (e.level === 'error' ? console.error : e.level === 'warn' ? console.warn : console.log)(l);
    const wc = win && !win.isDestroyed() ? win.webContents : null;
    if (wc && !wc.isDestroyed()) wc.send('log', { entry: e, stats: logs.stats() });
  } catch {}
}
// فقط مشاهده: رفتار پیش‌فرض Electron/Node (پنجرهٔ خطا، چاپ هشدار) عوض نمی‌شود
process.on('uncaughtExceptionMonitor', (err, origin) => log(`${origin === 'unhandledRejection' ? 'Promise ردشدهٔ مدیریت‌نشده' : 'استثنای مدیریت‌نشده'}: ${err?.message || err}`, 'error', 'main', { stack: err?.stack }));
process.on('warning', w => log(`هشدار Node: ${w?.name}: ${w?.message}`, 'warn', 'main', { stack: w?.stack }));
app.on('child-process-gone', (_, d) => { if (!app.isQuitting && d.reason !== 'clean-exit') log(`پروسهٔ ${d.type}${d.name ? ' (' + d.name + ')' : ''} بسته شد: ${d.reason} (کد ${d.exitCode})`, d.reason === 'killed' ? 'warn' : 'error'); });
function status() { win?.webContents.send('status', { connected, lastSeen, port: PORT }); updateTray(); }

// ---------- path safety ----------
const norm = p => (process.platform === 'win32' ? p.toLowerCase() : p);
function inside(root, t) {
  const r = norm(root), x = norm(t);
  return x === r || x.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}
function realish(p) { // realpath of the deepest existing ancestor + remaining parts
  let cur = p; const rest = [];
  while (!fs.existsSync(cur)) { const par = path.dirname(cur); if (par === cur) break; rest.unshift(path.basename(cur)); cur = par; }
  return path.join(fs.realpathSync(cur), ...rest);
}
function safe(p) {
  if (!cfg.roots.length) throw new Error('هیچ پوشه‌ای مجاز نشده است');
  const abs = path.resolve(cfg.roots[0], p || '.');
  const real = realish(abs);
  for (const r of cfg.roots) if (inside(realish(r), real)) return real;
  throw new Error('مسیر خارج از پوشه‌های مجاز است: ' + abs);
}

// ---------- approval ----------
// ---- ایمنی: پشتیبان، لیست سیاه، گزارش، توقف فوری ----
const DANGER = /\b(format|diskpart|shutdown|bcdedit|cipher\s+\/w)\b|\b(del|erase)\b[^\n]*\/s|\b(rd|rmdir)\b[^\n]*\/s|\breg(\.exe)?\s+(delete|add)\b|rm\s+-rf?\s+[\/~]|remove-item[^\n]*-recurse|\bvssadmin\b|\btakeown\b|\bicacls\b[^\n]*\/grant/i;
const children = new Set();
const auditFile = () => path.join(app.getPath('userData'), 'audit.log');
function audit(c, ok, info) {
  auditLog.append(auditFile(), { ev: 'tool', fs: c.fs, path: c.path, url: c.url, command: c.command != null ? String(c.command).slice(0, 500) : undefined, ok, info: String(info || '').slice(0, 200) });
}
// پوشهٔ خیلی بزرگ: پشتیبان‌گیری کامل عملی نیست
function dirOver(p, maxFiles = 20000, maxBytes = 500e6) {
  let files = 0, bytes = 0; const st = [p];
  while (st.length) {
    const d = st.pop(); let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const x of ents) {
      const f = path.join(d, x.name);
      if (x.isDirectory()) st.push(f); else { files++; try { bytes += fs.lstatSync(f).size; } catch {} }
      if (files > maxFiles || bytes > maxBytes) return { over: true, files, bytes };
    }
  }
  return { over: false, files, bytes };
}
// tracked: پشتیبان پیش از تغییر ← تغییر ← ثبت در تاریخچه (Undo). required: اگر پشتیبان نشد، عملیات انجام نشود.
async function tracked(op, target, fn, opt = {}) {
  if (opt.skip) return await fn();
  if (!history) { if (opt.required) throw new Error('تاریخچه آماده نیست؛ برای ایمنی عملیات انجام نشد'); return await fn(); }
  let e;
  try { e = history.before(target, op); e.pre = historyLib.fingerprint(target); }
  catch (x) {
    if (opt.required) throw new Error('پشتیبان‌گیری ناموفق؛ برای ایمنی عملیات انجام نشد: ' + x.message);
    log('پشتیبان‌گیری ناموفق (عملیات بدون Undo ادامه یافت): ' + x.message, 'warn'); return await fn();
  }
  let r;
  try { r = await fn(); }
  catch (x) {
    // اگر چیزی تغییر کرده بود، رکورد بماند تا بشود برگرداند
    if (!historyLib.sameFp(e.pre, historyLib.fingerprint(target))) { delete e.pre; history.after(e); log('عملیات نیمه‌کاره ماند؛ بازگردانی در تاریخچه موجود است', 'warn', 'tool'); }
    else history.discard(e);
    throw x;
  }
  delete e.pre;
  const id = history.after(e);
  win?.webContents.send('history-changed');
  return r && typeof r === 'object' ? { ...r, undo_id: id } : r;
}
// approve(group, …): تصمیم بر پایهٔ دسترسی همان دسته؛ deny بی‌درنگ خطا می‌دهد؛ همه در گزارش ممیزی ثبت می‌شوند
function groupDenied(group) { const e = new Error(`دسترسی «${perms.GROUPS[group] || group}» در تنظیمات Gap Bridge بسته (رد همیشگی) است`); e.denied = true; return e; }
function assertAllowed(group) { if (cfg.perms?.[group] === 'deny') throw groupDenied(group); }
async function approve(group, message, detail, force) {
  const d = perms.decide(cfg.perms, group, cfg.autoApprove, force);
  const first = String(detail).split('\n')[0].slice(0, 300);
  const rec = (ok, how) => auditLog.append(auditFile(), { ev: 'approve', group, title: message, detail: first, ok, how });
  if (d === 'deny') { rec(false, 'deny'); throw groupDenied(group); }
  if (d === 'auto') { log(`اجرای خودکار (بدون پرسش): ${message} — ${first.slice(0, 150)}`); rec(true, 'auto'); return true; }
  win?.show(); win?.focus();
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['اجازه', 'رد'], defaultId: 1, cancelId: 1,
    title: 'تأیید درخواست', message, detail: String(detail).slice(0, 3200), noLink: true,
  });
  const ok = r.response === 0;
  rec(ok, 'user'); if (!ok) log('رد شد: ' + message);
  return ok;
}
const cut = (s, n) => (s.length > n ? s.slice(0, n) + `\n...[بریده شد، ${s.length - n} کاراکتر دیگر]` : s);

// ---------- tools ----------
const SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv', 'dist', 'build']);
function tree(dir, depth, max, out, prefix = '') {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  ents.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  for (const d of ents) {
    if (out.length >= max) { if (out[out.length - 1] !== '...[بریده شد]') out.push('...[بریده شد]'); return; }
    out.push(prefix + d.name + (d.isDirectory() ? '/' : ''));
    if (d.isDirectory() && depth > 1 && !SKIP.has(d.name)) tree(path.join(dir, d.name), depth - 1, max, out, prefix + '  ');
  }
}
function search(dir, re, glob, out, max) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of ents) {
    if (out.length >= max) return;
    const f = path.join(dir, d.name);
    if (d.isDirectory()) { if (!SKIP.has(d.name)) search(f, re, glob, out, max); continue; }
    if (glob && !glob.test(d.name)) continue;
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.size > 1e6) continue;
    let t; try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (t.includes('\0')) continue;
    const lines = t.split('\n');
    for (let i = 0; i < lines.length && out.length < max; i++) if (re.test(lines[i])) out.push(`${f}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
  }
}
function missing(p, e) {
  if (e.code !== 'ENOENT') return e;
  let d = path.dirname(p), hint = '';
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  try { hint = fs.readdirSync(d, { withFileTypes: true }).slice(0, 60).map(x => x.name + (x.isDirectory() ? '/' : '')).join(', '); } catch {}
  return new Error(`وجود ندارد: ${p}\nنزدیک‌ترین پوشه‌ی موجود: ${d}\nمحتوا: ${hint || '(خالی)'}`);
}
async function handle(c) {
  try { const r = await handle2(c); audit(c, true); return r; } catch (e) {
    audit(c, false, e.message);
    if (e.code === 'ENOENT' && typeof c.path === 'string') { try { throw missing(safe(c.path), e); } catch (x) { throw x; } }
    throw e;
  }
}
// ---------- download: آدرس‌های عمومی ----------
// هر آدرس (و هر هاپ ریدایرکت) باید http/https باشد و به IP عمومی resolve شود.
const PRIV = new (require('net').BlockList)();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) PRIV.addSubnet(a, n, 'ipv4');
// ::/96 شامل :: و ::1 و ::7f00:1. آدرس‌های ::ffff:x (مثل ::ffff:7f00:1) را BlockList خودش با قانون‌های IPv4 بالا می‌سنجد؛
// قانون ::ffff:0:0/96 نگذارید چون BlockList هر IPv4 را هم با آن تطبیق می‌دهد و همه چیز بسته می‌شود.
for (const [a, n] of [['::', 96], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIV.addSubnet(a, n, 'ipv6');
const isPrivateIp = a => { const v = require('net').isIP(a); return !v || PRIV.check(a, v === 6 ? 'ipv6' : 'ipv4'); };
const PRIV_ERR = 'آدرس محلی/خصوصی مجاز نیست';
async function assertPublicUrl(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error('فقط http/https');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = require('net').isIP(host) ? [{ address: host }] : await require('dns').promises.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error(PRIV_ERR);
}
// همان IPی که به آن وصل می‌شویم بررسی می‌شود (نه یک lookup جدا)، تا DNS rebinding بی‌اثر شود.
function publicLookup(host, opts, cb) {
  require('dns').lookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) return cb(Object.assign(new Error(PRIV_ERR), { code: 'EPRIVATE' }));
    opts.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
  });
}
function getPublic(u, signal) {
  return new Promise((resolve, reject) => {
    const req = require(u.protocol === 'https:' ? 'https' : 'http').get(u, { signal, lookup: publicLookup }, resolve);
    req.on('error', reject);
  });
}

// ---------- browser automation (Chrome DevTools Protocol) ----------
// Chrome/Edge must be started with --remote-debugging-port=9222.
let browserTargetId = null;
async function browserTargets() {
  const r = await fetch('http://127.0.0.1:9222/json');
  if (!r.ok) throw new Error(`CDP پاسخ نداد (${r.status})`);
  return r.json();
}
async function browserTarget(create = false, url = 'about:blank') {
  let targets = await browserTargets();
  let t = browserTargetId && targets.find(x => x.id === browserTargetId && x.type === 'page');
  if (!t && create) {
    const r = await fetch(`http://127.0.0.1:9222/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!r.ok) throw new Error(`ساخت تب مرورگر ناموفق بود (${r.status})`);
    t = await r.json();
  }
  if (!t) t = targets.find(x => x.type === 'page');
  if (!t?.webSocketDebuggerUrl) throw new Error('تب مرورگر پیدا نشد؛ Chrome/Edge را با --remote-debugging-port=9222 اجرا کنید.');
  browserTargetId = t.id;
  return t;
}
async function cdp(target, method, params = {}) {
  const ws = new (require('ws'))(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('مهلت اتصال CDP تمام شد')), 8000);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', e => { clearTimeout(timer); reject(e); });
  });
  const id = Math.floor(Math.random() * 1e9);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error(`مهلت اجرای CDP تمام شد: ${method}`)); }, 20000);
      ws.on('message', raw => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.id !== id) return;
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result || {});
        ws.close();
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  } finally { try { ws.close(); } catch {} }
}
async function browserTool(c) {
  const name = c.fs;
  assertAllowed('browser');
  let t;
  // اگر مرورگر دیباگ باز نیست و کاربر اجازه داده، با تأیید اجرا شود
  if (!(await chromium.probe(9222)) && cfg.browser.agentLaunch && browserExe()) {
    if (!(await approve('browser', 'اجرای مرورگر Chromium', `${browserExe()}\nپروفایل جدا: ${browserProfile()}`))) throw new Error('کاربر اجرای مرورگر را رد کرد');
    await startBrowser();
  }
  try { t = await browserTarget(name === 'browser_open', c.url || 'about:blank'); }
  catch (e) { throw new Error(`${e.message}\nبرای فعال‌سازی: Chrome/Edge را با گزینه --remote-debugging-port=9222 باز کنید.`); }
  if (name === 'browser_open') return { target: t.id, url: t.url, title: t.title };
  // کارهای تغییردهنده در مرورگر (که ممکن است در حساب‌های واردشده اجرا شوند) تأیید می‌خواهند
  const ACT = { browser_navigate: 'رفتن به نشانی در مرورگر', browser_click: 'کلیک در مرورگر', browser_type: 'تایپ در مرورگر', browser_eval: 'اجرای JavaScript در مرورگر' };
  if (ACT[name]) {
    const detail = `تب: ${t.title || ''} — ${t.url || ''}\n` + (c.url ? `نشانی: ${c.url}` : c.selector ? `selector: ${c.selector}${c.text != null ? `\nمتن: ${String(c.text).slice(0, 300)}` : ''}` : String(c.expression || '').slice(0, 1500));
    if (!(await approve('browser', ACT[name], detail))) throw new Error('کاربر رد کرد');
  }
  if (name === 'browser_navigate') {
    if (!c.url) throw new Error('url لازم است');
    await cdp(t, 'Page.enable'); await cdp(t, 'Page.navigate', { url: String(c.url) });
    return { navigated: String(c.url), target: t.id };
  }
  if (name === 'browser_click' || name === 'browser_type') {
    if (!c.selector) throw new Error('selector لازم است');
    const selector = JSON.stringify(String(c.selector));
    const action = name === 'browser_click'
      ? `const e=document.querySelector(${selector}); if(!e) throw new Error('element not found'); e.click(); 'clicked'`
      : `const e=document.querySelector(${selector}); if(!e) throw new Error('element not found'); e.focus(); if('value' in e){const p=Object.getPrototypeOf(e),d=Object.getOwnPropertyDescriptor(p,'value'); if(d?.set)d.set.call(e,${JSON.stringify(String(c.text ?? ''))});else e.value=${JSON.stringify(String(c.text ?? ''))}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));} else {e.textContent=${JSON.stringify(String(c.text ?? ''))}; e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(String(c.text ?? ''))}}));} 'typed'`;
    const out = await cdp(t, 'Runtime.evaluate', { expression: action, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || 'خطای اجرای صفحه');
    return { action: name, result: out.result?.value };
  }
  if (name === 'browser_eval' || name === 'browser_get_text') {
    const expression = name === 'browser_get_text'
      ? (c.selector ? `(()=>{const e=document.querySelector(${JSON.stringify(String(c.selector))});return e?e.innerText:null})()` : 'document.body.innerText')
      : String(c.expression || '');
    if (!expression) throw new Error('expression لازم است');
    const out = await cdp(t, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text || 'خطای اجرای جاوااسکریپت');
    return { value: cut(JSON.stringify(out.result?.value ?? null), 30000), target: t.id };
  }

  if (name === 'browser_dom' || name === 'browser_snapshot') {
    const expr = `(()=>{const q='a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable=true],[onclick]';
const esc=s=>CSS.escape(s);const sel=e=>{if(e.id)return '#'+esc(e.id);const p=[];let n=e;while(n&&n.nodeType===1&&p.length<4){let t=n.tagName.toLowerCase();const par=n.parentElement;if(par){const sib=[...par.children].filter(x=>x.tagName===n.tagName);if(sib.length>1)t+=':nth-of-type('+(sib.indexOf(n)+1)+')';}p.unshift(t);if(n.id){p[0]='#'+esc(n.id);break}n=par}return p.join('>')};
const out=[];for(const e of document.querySelectorAll(q)){const r=e.getBoundingClientRect();const cs=getComputedStyle(e);if(r.width<2||r.height<2||cs.visibility==='hidden'||cs.display==='none'||r.bottom<0||r.top>innerHeight*3)continue;
const txt=(e.innerText||e.value||e.getAttribute('aria-label')||e.title||e.placeholder||'').trim().replace(/\\s+/g,' ').slice(0,80);
const o={i:out.length,tag:e.tagName.toLowerCase(),sel:sel(e),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};
if(txt)o.text=txt;if(e.type&&e.tagName!=='BUTTON')o.type=e.type;if(e.name)o.name=e.name;if(e.tagName==='A')o.href=e.href.slice(0,120);if(e.disabled)o.disabled=true;if(e.type==='password')delete o.text;out.push(o);if(out.length>=150)break}
return {url:location.href,title:document.title,viewport:[innerWidth,innerHeight],elements:out}})()`;
    const r = await cdp(t, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'خطا در استخراج DOM');
    const dom = r.result.value;
    if (name === 'browser_dom') return dom;
    // visual context: عکس کوچک از ناحیهٔ مشخص (clip) یا ناحیهٔ دید، با مقیاس کم
    await cdp(t, 'Page.enable');
    const cl = c.region; const [vw, vh] = dom.viewport;
    const clip = cl ? { x: cl.x, y: cl.y, width: cl.width, height: cl.height, scale: 1 } : { x: 0, y: 0, width: vw, height: vh, scale: Math.min(1, 800 / vw) };
    const shot = await cdp(t, 'Page.captureScreenshot', { format: 'jpeg', quality: 60, clip });
    const dir = path.join(app.getPath('userData'), 'browser-screenshots'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `snap-${Date.now()}.jpg`); fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return { ...dom, screenshot: file, screenshot_bytes: Buffer.byteLength(shot.data, 'base64') };
  }
  if (name === 'browser_screenshot') {
    await cdp(t, 'Page.enable');
    const out = await cdp(t, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const dir = path.join(app.getPath('userData'), 'browser-screenshots'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `screenshot-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(out.data, 'base64'));
    return { screenshot: file, bytes: Buffer.byteLength(out.data, 'base64'), target: t.id };
  }
  throw new Error('ابزار مرورگر ناشناخته: ' + name);
}

// ---------- مدیریت مرورگر از رابط گرافیکی ----------
const browserProfile = () => path.join(app.getPath('userData'), 'chromium-profile');
function browserExe() {
  if (cfg.browser.exe && fs.existsSync(cfg.browser.exe)) return cfg.browser.exe;
  return chromium.detect()[0]?.path || '';
}
async function startBrowser() {
  const exe = browserExe();
  const r = await chromium.launch({ exe, port: 9222, profileDir: browserProfile(), headless: cfg.browser.headless });
  log(`مرورگر اجرا شد: ${r.browser || exe}`);
  browserTargetId = null;
  return r;
}
async function browserInfo() {
  return { ...cfg.browser, resolved: browserExe(), found: chromium.detect(), profile: browserProfile(), port: 9222, ...(await chromium.status(9222)) };
}
ipcMain.handle('browserInfo', () => browserInfo());
ipcMain.handle('browserSet', async (_, o = {}) => {
  if (typeof o.exe === 'string') cfg.browser.exe = o.exe;
  for (const k of ['headless', 'autoStart', 'agentLaunch']) if (typeof o[k] === 'boolean') cfg.browser[k] = o[k];
  saveCfg(); return browserInfo();
});
ipcMain.handle('browserPick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'انتخاب فایل اجرایی مرورگر', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Browser', extensions: ['exe'] }] : [] });
  if (!r.canceled && r.filePaths[0]) { cfg.browser.exe = r.filePaths[0]; saveCfg(); }
  return browserInfo();
});
ipcMain.handle('browserLaunch', async () => {
  try { await startBrowser(); return { ok: true, info: await browserInfo() }; }
  catch (e) { log('خطای اجرای مرورگر: ' + e.message, 'error'); return { ok: false, error: e.message, info: await browserInfo() }; }
});
ipcMain.handle('browserStop', async () => { const ok = chromium.stop(); if (ok) log('مرورگر بسته شد'); browserTargetId = null; await new Promise(r => setTimeout(r, 600)); return { ok, info: await browserInfo() }; });
ipcMain.handle('browserResetProfile', async () => {
  if ((await chromium.status(9222)).ours) return { ok: false, error: 'اول مرورگر را ببندید' };
  try { fs.rmSync(browserProfile(), { recursive: true, force: true }); log('پروفایل مرورگر پاک شد'); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

async function handle2(c) {
  if (typeof c.fs === 'string' && c.fs.startsWith('browser_')) return browserTool(c);
  switch (c.fs) {
    case 'tree': {
      const p = safe(c.path); const out = [];
      tree(p, Math.min(c.depth || 3, 8), 500, out);
      return { path: p, tree: out.join('\n') };
    }
    case 'search': {
      const p = safe(c.path); if (!c.query) throw new Error('query لازم است');
      let re; try { re = c.regex ? new RegExp(c.query, 'i') : new RegExp(String(c.query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } catch (e) { throw new Error('regex نامعتبر'); }
      const glob = c.glob ? new RegExp('^' + String(c.glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') : null;
      const out = []; search(p, re, glob, out, 100);
      return { matches: out, truncated: out.length >= 100 };
    }

    case 'attach_file': {
      const p = safe(c.path);
      const st = fs.statSync(p);
      if (!st.isFile()) throw new Error('مسیر فایل نیست');
      if (st.size > 15e6) throw new Error('فایل بزرگ‌تر از ۱۵ مگابایت است');
      const ext = path.extname(p).slice(1).toLowerCase();
      const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv', html: 'text/html', js: 'text/javascript', py: 'text/x-python', zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
      if (!(await approve('attach', 'ارسال فایل به چت', `${p}\n(${st.size} بایت) به صفحهٔ gapgpt ضمیمه می‌شود`))) throw new Error('کاربر رد کرد');
      return { _attach: { name: path.basename(p), mime: MIME[ext] || 'application/octet-stream', size: st.size, b64: fs.readFileSync(p).toString('base64') } };
    }
    case 'download_file': {
      const u = new URL(String(c.url || ''));
      await assertPublicUrl(u);
      let p = safe(c.path);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, path.basename(u.pathname) || 'download');
      p = safe(p);
      if (!(await approve('write', 'دانلود فایل', `${u.href}\n→ ${p}${fs.existsSync(p) ? '\n(جایگزین فایل موجود)' : ''}`))) throw new Error('کاربر رد کرد');
      const max = 200e6;
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 120000);
      try {
        let cur = u, res;
        for (let hop = 0; ; hop++) {
          await assertPublicUrl(cur);
          res = await getPublic(cur, ctl.signal);
          const loc = res.headers.location;
          if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
            res.resume();
            if (hop >= 5) throw new Error('ریدایرکت بیش از حد');
            cur = new URL(loc, cur);
            continue;
          }
          break;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); throw new Error('HTTP ' + res.statusCode); }
        const len = +res.headers['content-length'] || 0;
        if (len > max) { res.destroy(); throw new Error('فایل خیلی بزرگ است'); }
        const chunks = []; let n = 0;
        for await (const ch of res) { n += ch.length; if (n > max) throw new Error('فایل از ۲۰۰ مگابایت بیشتر شد'); chunks.push(ch); }
        return await tracked('download', p, () => {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, Buffer.concat(chunks));
          return { path: p, size: n, type: res.headers['content-type'] };
        });
      } finally { clearTimeout(to); }
    }
    case 'count_tokens': {
      const p = safe(c.path); const st = fs.statSync(p);
      if (st.isDirectory()) return { path: p, ...tokens.dirTokens(p, SKIP) };
      return tokens.fileTokens(p);
    }
    case 'index_files': {
      const p = safe(c.path); const r = rag.build(p, SKIP); return { root: p, ...r };
    }
    case 'semantic_search': {
      const p = safe(c.path); if (!c.query) throw new Error('query لازم است');
      return { results: rag.query(p, String(c.query), Math.min(c.k || 8, 20)) };
    }
    case 'run_background': {
      const cwd = safe(c.cwd || '.'); const cmd = String(c.command || ''); if (!cmd) throw new Error('command لازم است');
      const danger = DANGER.test(cmd);
      if (!(await approve('run', danger ? '⚠ دستور خطرناک (پس‌زمینه)' : 'اجرای دستور در پس‌زمینه', `پوشه: ${cwd}\n\n${cmd}`, danger))) throw new Error('کاربر رد کرد');
      const j = jobs.start({ command: cmd, cwd, timeoutSec: Number(c.timeout_sec) || 3600,
        onLog: (id, l) => log(`[${id}] ${l}`, 'info', 'tool'),
        onDone: j => { log(`کار ${j.id} پایان یافت: ${j.status} (کد ${j.code})`, j.status === 'done' ? 'info' : 'warn', 'tool'); notify('Gap Bridge', `کار ${j.id} ${j.status === 'done' ? 'با موفقیت تمام شد' : 'پایان یافت: ' + j.status}`); push({ type: 'job_done', job: jobs.view(j, 1500) }); } });
      children.add(j.ch); j.ch.on('close', () => children.delete(j.ch));
      return { job_id: j.id, status: 'running', note: 'با job_status وضعیت را بپرس؛ پایان کار اعلان دسکتاپ هم می‌دهد.' };
    }
    case 'job_status': { const j = jobs.get(String(c.job_id)); if (!j) throw new Error('کار پیدا نشد'); return jobs.view(j, Math.min(c.tail || 4000, 20000)); }
    case 'job_list': return { jobs: jobs.list() };
    case 'job_kill': return { killed: jobs.kill(String(c.job_id)) };
    case 'terminal_run': {
      if (!cfg.terminal.agent) throw new Error('ترمینال برای دستیار در تنظیمات غیرفعال است');
      const cmd = String(c.command || '').trim(); if (!cmd) throw new Error('command لازم است');
      const fresh = !terminal.view().running;
      // cwd فقط هنگام شروع نشست تازه به کار می‌رود و باید داخل roots باشد.
      const cwd = fresh ? (c.cwd ? safe(c.cwd) : (cfg.roots[0] || require('os').homedir())) : terminal.view().cwd;
      const danger = DANGER.test(cmd);
      if (!(await approve('run', danger ? '⚠ دستور خطرناک (ترمینال)' : 'اجرای دستور در ترمینال', `پوشه: ${cwd}${fresh ? ' (نشست تازه)' : ''}\n\n${cmd}`, danger))) throw new Error('کاربر رد کرد');
      if (fresh) { terminal.start({ cwd, cols: cfg.terminal.cols, rows: cfg.terminal.rows, ...termSink }); win?.webContents.send('term-started', terminal.view()); }
      const m = terminal.mark();
      if (!terminal.send(cmd)) throw new Error('ارسال به ترمینال ناموفق بود');
      log(`ترمینال ← ${cmd.slice(0, 150)}`, 'info', 'tool');
      const wait = Math.min(Math.max(Number(c.wait_sec) || 3, 0.5), 30) * 1000;
      await terminal.settle(wait);
      const v = terminal.view();
      return { output: terminal.since(m), running: v.running, id: v.id, pty: v.pty, cwd: v.cwd,
        note: 'اگر دستور هنوز در حال اجراست، با terminal_read ادامه‌ی خروجی را بخوان یا با terminal_interrupt متوقف کن.' };
    }
    case 'terminal_read': {
      if (!cfg.terminal.agent) throw new Error('ترمینال در تنظیمات غیرفعال است');
      const n = Math.min(Number(c.chars) || 4000, 20000);
      return { output: terminal.read(n), ...terminal.view() };
    }
    case 'terminal_interrupt': {
      if (!cfg.terminal.agent) throw new Error('ترمینال در تنظیمات غیرفعال است');
      terminal.write('\u0003'); // Ctrl+C
      return { interrupted: true, ...terminal.view() };
    }
    case 'list_roots': return { roots: cfg.roots };
    case 'list_dir': {
      const p = safe(c.path);
      return fs.readdirSync(p, { withFileTypes: true }).map(d => ({ name: d.name, type: d.isDirectory() ? 'dir' : 'file', size: d.isFile() ? fs.statSync(path.join(p, d.name)).size : undefined }));
    }
    case 'read_file': {
      const p = safe(c.path);
      let t = fs.readFileSync(p, 'utf8');
      if (c.start_line || c.end_line) t = t.split('\n').slice((c.start_line || 1) - 1, c.end_line || undefined).join('\n');
      return { path: p, content: cut(t, 60000) };
    }
    case 'write_file': {
      const p = safe(c.path);
      if (typeof c.content !== 'string') throw new Error('content لازم است');
      if (c.content.length > 2e6) throw new Error('content خیلی بزرگ است');
      assertAllowed('write');
      let prev = null;
      try { const st = fs.statSync(p); if (st.isFile() && st.size < 2e6) prev = fs.readFileSync(p, 'utf8'); else if (st.isFile()) prev = false; } catch {}
      const body = prev === null ? `فایل جدید\n\n${c.content.slice(0, 1200)}`
        : prev === false ? `جایگزین فایل موجود (بزرگ‌تر از ۲ مگابایت؛ مقایسه نمایش داده نمی‌شود)\n\n${c.content.slice(0, 1200)}`
        : (d => `جایگزین فایل موجود — ${diff.summary(d)}\n\n${d.text}`)(diff.unified(prev, c.content, { context: 3, max: 1600 }));
      if (!(await approve('write', 'نوشتن فایل', `${p}\n(${c.content.length} کاراکتر)\n${body}`))) throw new Error('کاربر رد کرد');
      return await tracked('write', p, () => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, c.content, 'utf8');
        return { written: p };
      });
    }
    case 'edit_file': {
      const p = safe(c.path);
      const t = fs.readFileSync(p, 'utf8');
      const n = t.split(c.old).length - 1;
      if (!c.old || n !== 1) throw new Error(`متن old باید دقیقاً یک بار در فایل باشد (الان ${n} بار)`);
      const next = t.replace(c.old, () => String(c.new));
      const d = diff.unified(t, next, { context: 3, max: 1600 });
      if (!(await approve('write', 'ویرایش فایل', `${p}\n${diff.summary(d)}\n\n${d.text}`))) throw new Error('کاربر رد کرد');
      return await tracked('edit', p, () => { fs.writeFileSync(p, next, 'utf8'); return { edited: p }; });
    }
    case 'delete': {
      const p = safe(c.path);
      if (cfg.roots.some(r => norm(realish(r)) === norm(p))) throw new Error('حذف پوشه‌ی ریشه مجاز نیست');
      assertAllowed('write');
      const big = fs.statSync(p).isDirectory() ? dirOver(p) : { over: false };
      const note = big.over ? '\n\n⚠ این پوشه بیش از ۲۰٬۰۰۰ فایل یا ۵۰۰ مگابایت دارد؛ پشتیبان گرفته نمی‌شود و حذف برگشت‌ناپذیر است.' : '\n\n(پشتیبان گرفته می‌شود و از «تاریخچهٔ تغییرات» قابل بازگردانی است)';
      if (!(await approve('write', big.over ? '⚠ حذف برگشت‌ناپذیر' : 'حذف', p + note, big.over))) throw new Error('کاربر رد کرد');
      return await tracked('delete', p, () => { fs.rmSync(p, { recursive: true }); return { deleted: p, undo: !big.over }; }, { required: true, skip: big.over });
    }
    case 'run': {
      const cwd = safe(c.cwd || '.');
      const cmd = String(c.command || ''); if (!cmd) throw new Error('command لازم است');
      const danger = DANGER.test(cmd);
      if (!(await approve('run', danger ? '⚠ دستور خطرناک' : 'اجرای دستور', `پوشه: ${cwd}\n\n${cmd}`, danger))) throw new Error('کاربر رد کرد');
      const tmo = Math.min(Math.max(Number(c.timeout_sec) || 120, 1), 600) * 1000;
      return await new Promise(res => { const ch = exec(cmd, { cwd, timeout: tmo, maxBuffer: 5e6, windowsHide: true }, (err, stdout, stderr) => {
        children.delete(ch);
        res({ exit_code: err ? (err.code ?? 1) : 0, killed: err?.killed || undefined, stdout: cut(String(stdout), 20000), stderr: cut(String(stderr), 8000) }); });
        children.add(ch); });
    }
    default: throw new Error('ابزار ناشناخته: ' + c.fs);
  }
}

// ---------- websocket ----------
function startServer() {
  const wss = new WebSocketServer({
    host: '127.0.0.1', port: PORT,
    verifyClient: ({ origin }) => typeof origin === 'string' && origin.startsWith('chrome-extension://'),
  });
  wssRef = wss;
  wss.on('error', e => log('خطای سرور: ' + e.message, 'error'));
  wss.on('connection', ws => {
    let authed = false; connected++; status();
    ws.on('close', () => { connected--; status(); });
    ws.on('message', async raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'auth') {
        authed = m.token === cfg.token; ws.__authed = authed;
        ws.send(JSON.stringify({ type: 'auth', ok: authed }));
        if (!authed) { log('توکن نامعتبر از افزونه', 'warn', 'ext'); ws.close(); }
        else { lastSeen = Date.now(); log('افزونه وصل شد ✓'); status(); }
        return;
      }
      if (m.type === 'ping') { if (authed) ws.send(JSON.stringify({ type: 'pong' })); return; }
      // خطاهای خود افزونه: فقط از اتصال احرازشده، حداکثر ۲۰ در دقیقه برای هر اتصال
      if (m.type === 'client_error') {
        if (!authed) return;
        ws.__lim = ws.__lim || logbuf.limiter({ n: 20, ms: 60000 });
        const ok = ws.__lim.ok(), dropped = ws.__lim.dropped();
        if (dropped) log(`${dropped} خطای دیگر افزونه به‌خاطر محدودیت ثبت نشد`, 'warn', 'ext');
        if (!ok) return;
        const where = String(m.where || '').replace(/[^\w.:#-]/g, '').slice(0, 60);
        log(`افزونه${where ? ' [' + where + ']' : ''}: ${String(m.message ?? '')}`, m.level === 'warn' ? 'warn' : 'error', 'ext', { stack: typeof m.stack === 'string' ? m.stack : '' });
        return;
      }
      if (!authed || m.type !== 'call' || !m.call || typeof m.call !== 'object') return;
      log(`${m.call.fs} ${m.call.path || m.call.command || ''}`, 'info', 'tool');
      try {
        const data = await handle(m.call);
        ws.send(JSON.stringify({ type: 'result', id: m.call.id, ok: true, data }));
      } catch (e) {
        log(`خطا (${m.call.fs}): ` + e.message, e.denied || e.message === 'کاربر رد کرد' ? 'info' : 'error', 'tool');
        ws.send(JSON.stringify({ type: 'result', id: m.call.id, ok: false, error: e.message }));
      }
    });
  });
}

// ---------- instructions for the chat ----------
function instructions() {
  return `از این لحظه به یک پل محلی روی سیستم ویندوز من دسترسی داری. برای کار با فایل‌ها یا اجرای دستور، در پاسخت یک بلوک کد (\`\`\`) شامل یک JSON معتبر بنویس. این برنامه آن را اجرا می‌کند و نتیجه را به‌صورت پیام بعدی من برایت می‌فرستد.

قالب (کلید fs نام ابزار است، id باید در هر درخواست یکتا باشد، مثل a1 و a2 و ...):
{"id":"a1","fs":"list_dir","path":"."}

ابزارها:
- list_roots: فهرست پوشه‌های مجاز
- tree: {"path"?, "depth"?} (درخت پوشه‌ها، پیش‌فرض عمق ۳)
- search: {"query","path"?,"glob"?,"regex"?} (جست‌وجوی متن در فایل‌ها، مثلاً glob: "*.js")
- list_dir: {"path"}
- read_file: {"path", "start_line"?, "end_line"?}
- write_file: {"path","content"} (نیازمند تأیید من)
- edit_file: {"path","old","new"} (old باید دقیقاً یک بار در فایل باشد؛ نیازمند تأیید)
- delete: {"path"} (نیازمند تأیید)
- run: {"command","cwd"?} (دستور cmd ویندوز؛ نیازمند تأیید)
- browser_open: {"url"?} (ساخت تب؛ اگر مرورگر باز نباشد، Gap Bridge با تأیید کاربر آن را اجرا می‌کند)
- browser_navigate: {"url"} (رفتن به نشانی در تب فعال)
- browser_click: {"selector"} (کلیک روی CSS selector)
- browser_type: {"selector","text"} (قرار دادن متن در عنصر انتخاب‌شده)
- browser_eval: {"expression"} (اجرای JavaScript در صفحه؛ خروجی محدود می‌شود)
- browser_get_text: {"selector"?} (متن عنصر/صفحه)
- browser_screenshot: ذخیره تصویر PNG در پوشهٔ دادهٔ برنامه و بازگرداندن مسیر
- browser_dom: فهرست ساده‌شدهٔ فقط عناصر قابل‌کلیک/ورودی (دکمه، لینک، فیلد) با selector و مختصات؛ بسیار سبک‌تر از HTML کامل
- browser_snapshot: مثل browser_dom + عکس JPEG کوچک از صفحه ({"region":{"x","y","width","height"}}? برای یک ناحیه)
- attach_file: {"path"} (فایل را به کادر چت gapgpt ضمیمه می‌کند، تا ۱۵MB)
- download_file: {"url","path"} (دانلود http/https و ذخیره در مسیر مجاز)
- count_tokens: {"path"} (تخمین توکن فایل یا پوشه، برای تصمیم دربارهٔ حجم خواندن)
- index_files: {"path"} (ساخت نمایهٔ معنایی محلی) و semantic_search: {"path","query","k"?}
- run_background: {"command","cwd"?,"timeout_sec"?} (کار طولانی؛ job_id برمی‌گرداند و پایانش اعلان می‌دهد)، job_status: {"job_id","tail"?}، job_list، job_kill: {"job_id"}
- terminal_run: {"command","cwd"?,"wait_sec"?} (یک خط فرمان را در ترمینال تعاملیِ مشترک با کاربر اجرا می‌کند و خروجی تازه را برمی‌گرداند؛ تنها یک نشست؛ اگر نشستی باز نباشد، با cwd داخل roots (پیش‌فرض اولین root) شروع می‌شود؛ cd در نشست می‌ماند؛ wait_sec پیش‌فرض 3 و حداکثر 30)، terminal_read: {"chars"?} (آخرین خروجی ترمینال، پیش‌فرض 4000 کاراکتر)، terminal_interrupt (فرستادن Ctrl+C). برای کارهای بی‌تعامل run یا run_background بهتر است؛ ترمینال برای برنامه‌های تعاملی و دستورهای پشت‌سرهم است.

نتیجهٔ طولانی ممکن است در چند پیام با سربرگ TOOL_RESULT_PART i/n بیاید: تا بخش آخر نرسیده، فقط با کلمهٔ «ادامه» پاسخ بده و هیچ بلوک ابزاری نفرست؛ بعد از بخش n/n همه را کنار هم بگذار و ادامه بده.
قوانین: اگر مسیر را نمی‌دانی حدس نزن؛ اول tree یا list_dir بزن. مسیرهای نسبی نسبت به اولین پوشه‌ی مجاز هستند. بعد از فرستادن درخواست، متوقف شو و منتظر نتیجه بمان؛ نتیجه را حدس نزن. تأیید نوشتن/حذف/اجرا در خود برنامه‌ی من (یک پنجره‌ی تأیید روی کامپیوتر) انجام می‌شود؛ پس در چت از من تأیید نپرس و مستقیم همان بلوک را بنویس. بلوک کد را همیشه در متن اصلی پاسخ بنویس (نه در بخش «پردازش»/تفکر) و اگر قبلاً نوشته‌ای ولی نتیجه نیامده، دوباره همان بلوک را با id جدید بفرست. اول فایل‌ها را بخوان، بعد تغییر بده. هر بلوک فقط یک درخواست باشد. در توضیح‌ها از بلوک‌های دارای کلید fs به‌عنوان مثال استفاده نکن. از هر write_file/edit_file/delete/download_file پیش از تغییر، پشتیبان خودکار گرفته می‌شود (undo_id در نتیجه) و کاربر می‌تواند از «تاریخچهٔ تغییرات» برنامه آن را برگرداند؛ پس لازم نیست خودت نسخهٔ پشتیبان بسازی. اگر نتیجه‌ای خطای «دسترسی … بسته است» داد، آن دسته ابزار را دوباره امتحان نکن و به کاربر بگو.

پوشه‌های مجاز فعلی: ${cfg.roots.join(' ، ') || '(هنوز تعریف نشده)'}
حالا با list_roots شروع کن.`;
}


// ---------- tray / notifications / hotkeys / shell menu ----------
function dotIcon(rgb) {
  const N = 16, b = Buffer.alloc(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5), o = (y * N + x) * 4, a = d <= 7 ? 255 : d <= 8 ? 120 : 0;
    b[o] = rgb[2]; b[o + 1] = rgb[1]; b[o + 2] = rgb[0]; b[o + 3] = a; // BGRA
  }
  return nativeImage.createFromBitmap(b, { width: N, height: N });
}
const ICONS = {};
function updateTray() {
  if (!tray) return;
  const ok = connected > 0, recent = Date.now() - lastSeen < 60000;
  const k = ok ? 'ok' : recent ? 'idle' : 'off';
  ICONS.ok = ICONS.ok || dotIcon([34, 197, 94]); ICONS.idle = ICONS.idle || dotIcon([245, 158, 11]); ICONS.off = ICONS.off || dotIcon([138, 143, 152]);
  tray.setImage(ICONS[k]);
  tray.setToolTip('Gap Bridge — ' + (ok ? 'وصل است' : recent ? 'اخیراً فعال بود' : 'افزونه وصل نیست'));
}
function resetConnection() { let n = 0; wssRef?.clients.forEach(c => { try { c.close(); n++; } catch {} }); log(`اتصال بازنشانی شد (${n} اتصال بسته شد؛ افزونه خودکار وصل می‌شود)`); notify('Gap Bridge', 'اتصال بازنشانی شد'); }
function copyInstr() { clipboard.writeText(instructions()); log('دستورالعمل کپی شد'); notify('Gap Bridge', 'دستورالعمل در کلیپ‌بورد کپی شد'); }
function notify(title, body) { try { if (Notification.isSupported()) new Notification({ title, body }).show(); } catch {} }
function push(m) { wssRef?.clients.forEach(c => { try { if (c.readyState === 1 && c.__authed) c.send(JSON.stringify(m)); } catch {} }); }
function showWin() { if (!win) createWindow(); win.show(); win.focus(); }
function setupTray() {
  tray = new Tray(dotIcon([138, 143, 152]));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'نمایش پنجره', click: showWin },
    { label: 'کپی دستورالعمل (Ctrl+Shift+G)', click: copyInstr },
    { label: 'بازنشانی اتصال (Ctrl+Shift+R)', click: resetConnection },
    { label: 'توقف فوری دستورها', click: killAllNow },
    { type: 'separator' },
    { label: 'خروج', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showWin); updateTray();
  setInterval(updateTray, 15000);
}
function killAllNow() {
  let n = 0; for (const ch of children) { try { if (process.platform === 'win32') exec(`taskkill /pid ${ch.pid} /T /F`, { windowsHide: true }); else ch.kill('SIGKILL'); n++; } catch {} }
  children.clear(); log(`توقف فوری: ${n} فرایند بسته شد`); return n;
}
function setupHotkeys() {
  const hk = cfg.hotkeys || {};
  for (const [k, f] of [[hk.copy || 'CommandOrControl+Shift+G', copyInstr], [hk.reset || 'CommandOrControl+Shift+R', resetConnection]])
    if (!globalShortcut.register(k, f)) log('ثبت میان‌بر ناموفق (در اختیار برنامهٔ دیگر): ' + k, 'warn');
}
// «Send to Gap Bridge» در منوی راست‌کلیک ویندوز (HKCU، بدون نیاز به ادمین)
function shellMenu(install) {
  if (process.platform !== 'win32') throw new Error('فقط ویندوز');
  const exe = app.getPath('exe');
  const keys = ['*', 'Directory'].map(k => `HKCU\\Software\\Classes\\${k}\\shell\\GapBridge`);
  return Promise.all(keys.map(k => new Promise((res, rej) => {
    const cmd = install
      ? `reg add "${k}" /ve /d "Send to Gap Bridge" /f && reg add "${k}" /v Icon /d "${exe}" /f && reg add "${k}\\command" /ve /d "\\"${exe}\\" \\"%1\\"" /f`
      : `reg delete "${k}" /f`;
    exec(cmd, { windowsHide: true }, e => (e && install ? rej(e) : res()));
  })));
}
async function handleSendTo(argv) {
  const p = argv.slice(app.isPackaged ? 1 : 2).find(a => a && !a.startsWith('--') && fs.existsSync(a));
  if (!p) return;
  const abs = fs.realpathSync(p), isDir = fs.statSync(abs).isDirectory(), base = isDir ? abs : path.dirname(abs);
  showWin();
  if (!cfg.roots.some(r => inside(realish(r), abs))) {
    const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['اجازه بده', 'رد'], defaultId: 1, cancelId: 1, noLink: true,
      title: 'Send to Gap Bridge', message: 'این مسیر به پوشه‌های مجاز اضافه شود؟', detail: base });
    if (r.response !== 0) return;
    cfg.roots.push(base); saveCfg(); win.webContents.send('roots', cfg.roots);
  }
  clipboard.writeText(`این ${isDir ? 'پوشه' : 'فایل'} را بررسی کن: ${abs}`);
  log('Send to: ' + abs + ' (متن در کلیپ‌بورد؛ در چت paste کن)'); notify('Gap Bridge', 'مسیر کپی شد؛ در چت paste کن');
}

// ---------- window / ipc ----------
function createWindow() {
  win = new BrowserWindow({ icon: path.join(__dirname, 'build', 'icon.png'),
    width: 980, height: 760, minWidth: 360, minHeight: 480, backgroundColor: '#070a14', title: 'Gap Bridge',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  hookWindow(win.webContents);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}
// خطاهای رابط: فقط warn/error از کنسول (info نه، تا با خود گزارش حلقه نسازد)
function hookWindow(wc) {
  const NUM = { 2: 'warn', 3: 'error' }, STR = { warning: 'warn', error: 'error' };
  // Electron 33: (event, level عددی, message, line, sourceId)؛ نسخه‌های جدیدتر: event.level رشته‌ای با message/lineNumber/sourceId
  wc.on('console-message', (ev, level, message, line, sourceId) => {
    const lv = typeof level === 'number' ? NUM[level] : STR[ev?.level];
    if (!lv) return;
    const msg = typeof message === 'string' ? message : ev?.message;
    const src = typeof sourceId === 'string' ? sourceId : ev?.sourceId, ln = typeof line === 'number' ? line : ev?.lineNumber;
    log(`کنسول رابط: ${msg}`, lv, 'ui', { stack: src ? `${path.basename(String(src))}:${ln}` : '' });
  });
  wc.on('render-process-gone', (_, d) => log(`پروسهٔ رابط بسته شد: ${d.reason} (کد ${d.exitCode})`, 'error', 'ui'));
  wc.on('preload-error', (_, p, err) => log(`خطای preload: ${err?.message || err}`, 'error', 'ui', { stack: err?.stack }));
  wc.on('did-fail-load', (_, code, desc, url, isMain) => { if (code !== -3) log(`بارگذاری ناموفق${isMain ? '' : ' (زیرقاب)'}: ${desc} (${code}) ${url}`, 'error', 'ui'); });
  wc.on('unresponsive', () => log('رابط پاسخ نمی‌دهد', 'warn', 'ui'));
}

ipcMain.handle('state', () => ({ roots: cfg.roots, token: cfg.token, port: PORT, connected, lastSeen, autoApprove: cfg.autoApprove, hotkeys: cfg.hotkeys || {}, win: process.platform === 'win32', termAgent: cfg.terminal.agent, perms: cfg.perms, onboarded: cfg.onboarded, platform: process.platform }));
// ---------- راهنمای شروع و به‌روزرسانی ----------
ipcMain.handle('onboardDone', (_, done) => { cfg.onboarded = done !== false; saveCfg(); return cfg.onboarded; });
// افزونه به userData/extension کپی می‌شود تا مسیرش ثابت بماند (AppImage هر بار جای دیگری mount می‌شود، Program Files هم با نصب نسخهٔ جدید عوض می‌شود)
function extensionDir() {
  const src = app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(__dirname, 'extension');
  const dst = path.join(app.getPath('userData'), 'extension');
  const ver = d => { try { return JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8')).version; } catch { return null; } };
  const sv = ver(src);
  if (!sv) throw new Error('پوشهٔ افزونه پیدا نشد: ' + src);
  const dv = ver(dst);
  if (dv !== sv) { fs.cpSync(src, dst, { recursive: true, force: true }); log(`افزونه ${sv} در ${dst} کپی شد${dv ? ` (قبلی ${dv}؛ در chrome://extensions دکمهٔ بارگذاری دوباره را بزنید)` : ''}`); }
  return { dir: dst, version: sv, updated: !!dv && dv !== sv };
}
ipcMain.handle('openExtensionDir', async () => {
  try { const r = extensionDir(); clipboard.writeText(r.dir); const err = await require('electron').shell.openPath(r.dir); return Object.assign(r, { error: err || '' }); }
  catch (e) { log('خطای افزونه: ' + e.message, 'error'); return { error: e.message }; }
});
ipcMain.handle('updateInfo', () => updater.info());
// ---------- کنسول خطاها ----------
const logFilter = o => (o && typeof o === 'object' ? { level: String(o.level || 'all'), source: String(o.source || 'all'), q: String(o.q || '').slice(0, 200) } : {});
ipcMain.handle('logList', (_, o) => ({ items: logs.list(logFilter(o)), stats: logs.stats() }));
ipcMain.handle('logClear', () => { const st = logs.clear(); return { items: [], stats: st }; });
// کپی برای گزارش باگ: توکن و مسیر خانه پنهان می‌شوند
ipcMain.handle('logCopy', (_, o) => {
  const home = require('os').homedir();
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const redact = s => {
    if (cfg.token) s = s.split(cfg.token).join('[TOKEN]');
    if (home && home.length > 3) s = s.replace(new RegExp(esc(home), process.platform === 'win32' ? 'gi' : 'g'), '~');
    return s;
  };
  const f = logFilter(o);
  const header = `Gap Bridge ${app.getVersion()} — ${process.platform} ${process.arch} ${require('os').release()} — Electron ${process.versions.electron} — ${new Date().toISOString()}\nفیلتر: سطح=${f.level || 'all'} منبع=${f.source || 'all'}${f.q ? ' جستجو=' + f.q : ''}`;
  const r = logs.text(f, { header, redact });
  clipboard.writeText(r.text);
  return { count: r.count };
});
ipcMain.handle('updateSet', (_, o) => { try { return updater.set(o && typeof o === 'object' ? o : {}); } catch (e) { return Object.assign(updater.info(), { error: e.message }); } });
ipcMain.handle('updateCheck', () => updater.check(false));
ipcMain.handle('setAuto', async (_, on) => {
  on = on === true;
  if (on) {
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['فعال کن', 'انصراف'], defaultId: 1, cancelId: 1, noLink: true,
      title: 'اجرای خودکار', message: 'همه‌ی دستورات بدون پرسش اجرا شوند؟',
      detail: 'نوشتن، ویرایش و حذف فایل و اجرای دستورات cmd (در هر مسیری، نه فقط پوشه‌های مجاز) بدون تأیید تو انجام می‌شود. فقط وقتی فعال کن که به خروجی مدل اعتماد داری.',
    });
    if (r.response !== 0) return cfg.autoApprove;
  }
  cfg.autoApprove = on; saveCfg(); log(on ? 'حالت اجرای خودکار روشن شد' : 'حالت پرسش قبل از اجرا روشن شد');
  return cfg.autoApprove;
});
// ---------- دسترسی‌های جدا، تاریخچهٔ تغییرات (Undo)، گزارش ممیزی ----------
ipcMain.handle('perms', () => ({ perms: cfg.perms, groups: perms.GROUPS, modes: perms.MODES }));
ipcMain.handle('setPerm', async (_, group, mode) => {
  group = String(group); mode = String(mode);
  if (!perms.GROUPS[group] || !perms.MODES.includes(mode)) return cfg.perms;
  if (mode === 'auto' && cfg.perms[group] !== 'auto') {
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['فعال کن', 'انصراف'], defaultId: 1, cancelId: 1, noLink: true,
      title: 'اجرای خودکار', message: `«${perms.GROUPS[group]}» بدون پرسش انجام شود؟`,
      detail: 'درخواست‌های این دسته بدون پنجرهٔ تأیید اجرا می‌شوند (دستورهای خطرناک همچنان پرسیده می‌شوند). فقط وقتی فعال کن که به خروجی مدل اعتماد داری.',
    });
    if (r.response !== 0) return cfg.perms;
  }
  cfg.perms[group] = mode; saveCfg();
  auditLog.append(auditFile(), { ev: 'perm', group, mode, ok: true });
  log(`دسترسی «${perms.GROUPS[group]}» → ${mode}`);
  return cfg.perms;
});
ipcMain.handle('historyList', (_, n) => (history ? history.list(Math.min(Math.max(Number(n) || 50, 1), 300)) : []));
ipcMain.handle('historyRestore', async (_, id) => {
  if (!history) return { ok: false, error: 'تاریخچه آماده نیست' };
  const e = history.get(String(id));
  if (!e) return { ok: false, error: 'رکورد پیدا نشد' };
  // مسیر دوباره با roots سنجیده می‌شود؛ هرگز روی خود ریشه بازگردانی نمی‌شود
  const check = t => {
    const p = realish(path.resolve(t));
    if (!cfg.roots.some(r => inside(realish(r), p))) throw new Error('مسیر دیگر داخل پوشه‌های مجاز نیست');
    if (cfg.roots.some(r => norm(realish(r)) === norm(p))) throw new Error('بازگردانی روی پوشهٔ ریشه مجاز نیست');
  };
  try { check(e.target); } catch (x) { return { ok: false, error: x.message }; }
  const what = !e.backup ? 'این فایل/پوشه توسط این عملیات ساخته شده بود؛ بازگردانی آن را حذف می‌کند.' : 'نسخهٔ پیش از عملیات جایگزین وضعیت فعلی می‌شود.';
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['بازگردانی', 'انصراف'], defaultId: 1, cancelId: 1, noLink: true,
    title: 'بازگردانی تغییر', message: `بازگردانی «${e.op}»؟`, detail: `${e.target}\n${new Date(e.t).toLocaleString('fa-IR')}\n\n${what}\n(از وضعیت فعلی هم پشتیبان گرفته می‌شود.)`,
  });
  if (r.response !== 0) return { ok: false, cancelled: true };
  const run = force => { const out = history.restore(e.id, { check, force }); auditLog.append(auditFile(), { ev: 'restore', path: e.target, op: e.op, ok: true, force: force || undefined }); win?.webContents.send('history-changed'); return { ok: true, ...out }; };
  try { return run(false); }
  catch (x) {
    if (!x.conflict) { auditLog.append(auditFile(), { ev: 'restore', path: e.target, op: e.op, ok: false, info: x.message }); return { ok: false, error: x.message }; }
    const r2 = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['با این حال بازگردانی کن', 'انصراف'], defaultId: 1, cancelId: 1, noLink: true,
      title: 'تغییر بعدی', message: 'این مسیر پس از آن عملیات دوباره تغییر کرده است', detail: `${e.target}\n\nبا بازگردانی، تغییرات بعدی هم از بین می‌روند (البته از وضعیت فعلی پشتیبان گرفته می‌شود).`,
    });
    if (r2.response !== 0) return { ok: false, cancelled: true };
    try { return run(true); } catch (y) { auditLog.append(auditFile(), { ev: 'restore', path: e.target, op: e.op, ok: false, info: y.message }); return { ok: false, error: y.message }; }
  }
});
ipcMain.handle('auditTail', (_, o = {}) => auditLog.tail(auditFile(), { n: Math.min(Math.max(Number(o.n) || 200, 1), 500), q: String(o.q || '').slice(0, 200), ok: ['all', 'ok', 'fail'].includes(o.ok) ? o.ok : 'all', kind: ['all', 'tool', 'approve', 'restore', 'perm'].includes(o.kind) ? o.kind : 'all' }));
ipcMain.handle('addRoot', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (!r.canceled) { const p = fs.realpathSync(r.filePaths[0]); if (!cfg.roots.includes(p)) cfg.roots.push(p); saveCfg(); }
  return cfg.roots;
});
ipcMain.handle('removeRoot', (_, p) => { cfg.roots = cfg.roots.filter(x => x !== p); saveCfg(); return cfg.roots; });
ipcMain.handle('copyInstructions', () => { clipboard.writeText(instructions()); });
ipcMain.handle('killAll', () => {
  let n = 0;
  for (const ch of children) { try { if (process.platform === 'win32') exec(`taskkill /pid ${ch.pid} /T /F`, { windowsHide: true }); else ch.kill('SIGKILL'); n++; } catch {} }
  children.clear(); terminal.stop(); log(`توقف فوری: ${n} فرایند بسته شد + ترمینال`); return n;
});
ipcMain.handle('rotateToken', async () => {
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['بساز', 'انصراف'], defaultId: 1, cancelId: 1, message: 'توکن جدید ساخته شود؟', detail: 'باید توکن جدید را در پاپ‌آپ افزونه وارد کنی.' });
  if (r.response !== 0) return false;
  cfg.token = crypto.randomBytes(24).toString('hex'); saveCfg(); clipboard.writeText(cfg.token); log('توکن جدید ساخته و کپی شد'); return true;
});
ipcMain.handle('shellMenu', async (_, on) => { try { await shellMenu(on === true); log(on ? 'منوی Send to Gap Bridge نصب شد' : 'منوی Send to Gap Bridge حذف شد'); return true; } catch (e) { log('خطای منوی Send to: ' + e.message, 'error'); return false; } });
ipcMain.handle('jobs', () => jobs.list());
ipcMain.handle('jobKill', (_, id) => jobs.kill(String(id)));
ipcMain.handle('setHotkeys', (_, h) => { cfg.hotkeys = { copy: String(h.copy || '').trim() || 'CommandOrControl+Shift+G', reset: String(h.reset || '').trim() || 'CommandOrControl+Shift+R' }; saveCfg(); globalShortcut.unregisterAll(); setupHotkeys(); return cfg.hotkeys; });
ipcMain.handle('openData', () => require('electron').shell.openPath(app.getPath('userData')));
ipcMain.handle('copyToken', () => { clipboard.writeText(cfg.token); });
// خروجی ترمینال همیشه به پنجره هم می‌رود؛ چه نشست را کاربر شروع کرده باشد چه دستیار.
const termSink = {
  onData: t => win?.webContents.send('term-data', t),
  onExit: c => win?.webContents.send('term-exit', c),
};
ipcMain.handle('terminalStart', (_, opts) => {
  const o = opts || {};
  const cwd = typeof o.cwd === 'string' && o.cwd ? o.cwd : (cfg.roots[0] || require('os').homedir());
  return terminal.start({ cwd, cols: o.cols || cfg.terminal.cols, rows: o.rows || cfg.terminal.rows, ...termSink });
});
ipcMain.handle('terminalSetAgent', (_, on) => { cfg.terminal.agent = !!on; saveCfg(); return cfg.terminal.agent; });
ipcMain.handle('terminalWrite', (_, data) => terminal.write(data));
ipcMain.handle('terminalResize', (_, cols, rows) => terminal.resize(cols, rows));
ipcMain.handle('terminalStop', () => terminal.stop());
ipcMain.handle('terminalView', () => terminal.view());

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_, argv) => handleSendTo(argv));
  app.whenReady().then(() => { loadCfg(); history = historyLib.create({ dir: path.join(app.getPath('userData'), 'backups'), log, max: 300 }); updater = updaterLib.create({ app, dialog, getWin: () => win, getCfg: () => cfg, saveCfg, log, send: s => win?.webContents.send('update-status', s) }); updater.startup(); startServer(); createWindow(); setupTray(); setupHotkeys(); handleSendTo(process.argv); if (cfg.browser.autoStart && browserExe()) chromium.probe(9222).then(v => v || startBrowser()).catch(e => log('خطای اجرای مرورگر: ' + e.message, 'error')); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  win_close_hook();
}
function win_close_hook() {
  // بستن پنجره فقط به سینی می‌رود تا کارهای پس‌زمینه و اتصال ادامه یابد
  app.on('before-quit', () => { app.isQuitting = true; chromium.stop(); try { terminal.stop(); } catch {} });
  app.on('browser-window-created', (_, w) => w.on('close', e => { if (!app.isQuitting) { e.preventDefault(); w.hide(); } }));
  app.on('window-all-closed', () => {});
}
