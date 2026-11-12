// به‌روزرسانی اختیاری — پیش‌فرض خاموش، فقط با دکمه یا اگر کاربر «بررسی خودکار» را روشن کند.
// electron-updater فقط در نسخهٔ بسته‌بندی‌شده و به‌صورت تنبل بارگذاری می‌شود؛ نبودنش برنامه را از کار نمی‌اندازد.
// آدرس واقعی خوراک تنظیم کاربر است (setFeedURL)؛ publish در package.json فقط برای ساخت latest.yml است.

// کدام نسخه‌ها خودشان را به‌روز می‌کنند؟ (تابع خالص، برای تست)
function classify({ isPackaged, platform, env = {} }) {
  if (!isPackaged) return { ok: false, kind: 'dev', reason: 'در حالت توسعه (npm start) به‌روزرسانی غیرفعال است.' };
  if (platform === 'win32') {
    if (env.PORTABLE_EXECUTABLE_DIR) return { ok: false, kind: 'portable', reason: 'نسخهٔ portable خودش به‌روز نمی‌شود؛ نسخهٔ جدید را دستی دانلود و جایگزین کنید.' };
    return { ok: true, kind: 'nsis' };
  }
  if (platform === 'linux') {
    if (env.APPIMAGE) return { ok: true, kind: 'appimage' };
    return { ok: false, kind: 'deb', reason: 'نسخهٔ deb از راه مدیر بسته به‌روز می‌شود (فایل .deb جدید را نصب کنید).' };
  }
  if (platform === 'darwin') return { ok: true, kind: 'mac' };
  return { ok: false, kind: 'other', reason: 'این سیستم‌عامل پشتیبانی نمی‌شود.' };
}

// فقط https؛ بدون نام کاربری/رمز در آدرس. خروجی: آدرس تمیز یا '' (خالی = خاموش) یا null (نامعتبر)
function cleanUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  let x; try { x = new URL(u); } catch { return null; }
  if (x.protocol !== 'https:' || x.username || x.password || x.search || x.hash) return null;
  return x.href.replace(/\/+$/, '');
}

// مقایسهٔ نسخهٔ x.y.z (پیش‌انتشار «-beta» کوچک‌تر از نسخهٔ نهایی هم‌شماره)
function newer(a, b) {
  const p = v => { const [m, pre] = String(v || '').replace(/^v/, '').split('-'); return { n: m.split('.').map(x => parseInt(x, 10) || 0), pre: pre || '' }; };
  const A = p(a), B = p(b);
  for (let i = 0; i < 3; i++) if ((A.n[i] || 0) !== (B.n[i] || 0)) return (A.n[i] || 0) > (B.n[i] || 0);
  if (A.pre === B.pre) return false;
  if (!A.pre) return true; if (!B.pre) return false;
  return A.pre > B.pre;
}

function create({ app, dialog, getWin, getCfg, saveCfg, log, send }) {
  let au = null, busy = false, stage = 'idle', last = '';
  const cfg = () => { const c = getCfg(); c.update = Object.assign({ url: '', auto: false }, c.update || {}); return c.update; };
  const kind = () => classify({ isPackaged: app.isPackaged, platform: process.platform, env: process.env });
  const say = (s, msg) => { stage = s; last = msg || ''; if (msg) log('به‌روزرسانی: ' + msg, s === 'error' ? 'error' : 'info'); send?.({ stage, msg: last }); };
  function load() {
    if (au) return au;
    try { au = require('electron-updater').autoUpdater; } catch (e) { throw new Error('ماژول electron-updater در این نسخه نیست (' + e.message + ')'); }
    au.autoDownload = false; au.autoInstallOnAppQuit = false; au.allowDowngrade = false; au.allowPrerelease = false;
    au.logger = { info: () => {}, warn: m => log('updater: ' + m, 'warn'), error: m => log('updater خطا: ' + m, 'error'), debug: () => {} };
    au.on('download-progress', p => send?.({ stage: 'downloading', msg: `دانلود ${Math.round(p.percent || 0)}٪`, percent: p.percent }));
    return au;
  }
  function info() {
    const k = kind(), u = cfg();
    return { version: app.getVersion(), supported: k.ok, kind: k.kind, reason: k.reason || '', url: u.url, auto: u.auto, stage, msg: last };
  }
  function set(o = {}) {
    const u = cfg();
    if ('url' in o) { const c = cleanUrl(o.url); if (c === null) throw new Error('آدرس نامعتبر است؛ فقط https:// بدون رمز یا ?query'); u.url = c; }
    if ('auto' in o) u.auto = o.auto === true;
    saveCfg(); return info();
  }
  // silent: بررسی خودکار شروع برنامه — اگر نسخهٔ جدید نبود یا خطا شد، پنجره‌ای باز نمی‌شود
  async function check(silent = false) {
    const k = kind(), u = cfg();
    if (!k.ok) { say('idle', k.reason); return info(); }
    if (!u.url) { say('idle', 'آدرس سرور به‌روزرسانی تنظیم نشده.'); return info(); }
    if (busy) return info();
    busy = true;
    try {
      const a = load();
      a.setFeedURL({ provider: 'generic', url: u.url });
      say('checking', 'در حال بررسی ' + u.url);
      const r = await a.checkForUpdates();
      const v = r?.updateInfo?.version;
      if (!v || !newer(v, app.getVersion())) { say('idle', `نسخهٔ ${app.getVersion()} به‌روز است.`); return info(); }
      say('available', `نسخهٔ ${v} موجود است.`);
      const win = getWin();
      const q = await dialog.showMessageBox(win, { type: 'question', buttons: ['دانلود', 'بعداً'], defaultId: 0, cancelId: 1, noLink: true,
        title: 'به‌روزرسانی', message: `نسخهٔ ${v} موجود است (نسخهٔ فعلی ${app.getVersion()}). دانلود شود؟`,
        detail: 'فایل از ' + u.url + ' دانلود و با هش sha512 فایل latest.yml بررسی می‌شود. نصب فقط بعد از تأیید دوباره انجام می‌شود.' });
      if (q.response !== 0) { say('available', `نسخهٔ ${v} موجود است (دانلود نشد).`); return info(); }
      say('downloading', 'دانلود شروع شد…');
      await a.downloadUpdate();
      say('ready', `نسخهٔ ${v} دانلود شد.`);
      const q2 = await dialog.showMessageBox(getWin(), { type: 'question', buttons: ['الان نصب و اجرای دوباره', 'هنگام خروج'], defaultId: 0, cancelId: 1, noLink: true,
        title: 'به‌روزرسانی', message: 'نصب انجام شود؟', detail: 'دستورهای در حال اجرا و ترمینال بسته می‌شوند.' });
      if (q2.response === 0) { setImmediate(() => a.quitAndInstall(false, true)); }
      else { a.autoInstallOnAppQuit = true; say('ready', `نسخهٔ ${v} هنگام خروج نصب می‌شود.`); }
    } catch (e) {
      say('error', 'خطا: ' + e.message);
      if (!silent) dialog.showMessageBox(getWin(), { type: 'error', title: 'به‌روزرسانی', message: 'بررسی به‌روزرسانی ناموفق بود', detail: e.message, noLink: true }).catch(() => {});
    } finally { busy = false; }
    return info();
  }
  function startup() { const u = cfg(); if (u.auto && u.url && kind().ok) setTimeout(() => check(true).catch(() => {}), 15000); }
  return { info, set, check, startup };
}

module.exports = { create, classify, cleanUrl, newer };
