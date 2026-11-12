// اجرای مرورگر Chromium-محور (Chrome/Edge/Brave/Chromium) با پورت دیباگ و پروفایل جدا
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

let proc = null;

function candidates() {
  const e = process.env, list = [];
  if (process.platform === 'win32') {
    const bases = [e['PROGRAMFILES'], e['PROGRAMFILES(X86)'], e['LOCALAPPDATA']].filter(Boolean);
    const rel = [
      ['Chrome', 'Google\\Chrome\\Application\\chrome.exe'],
      ['Edge', 'Microsoft\\Edge\\Application\\msedge.exe'],
      ['Brave', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
      ['Chromium', 'Chromium\\Application\\chrome.exe'],
    ];
    for (const [name, r] of rel) for (const b of bases) list.push({ name, path: path.join(b, r) });
  } else if (process.platform === 'darwin') {
    list.push(
      { name: 'Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { name: 'Brave', path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
      { name: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' });
  } else {
    for (const [name, bin] of [['Chrome', 'google-chrome'], ['Chrome', 'google-chrome-stable'], ['Chromium', 'chromium'], ['Chromium', 'chromium-browser'], ['Edge', 'microsoft-edge'], ['Brave', 'brave-browser']]) {
      try { const p = execFileSync('which', [bin], { encoding: 'utf8' }).trim(); if (p) list.push({ name, path: p }); } catch {}
    }
  }
  return list;
}

// مرورگرهای نصب‌شده (بدون تکرار)
function detect() {
  const seen = new Set(), out = [];
  for (const c of candidates()) {
    const k = c.path.toLowerCase();
    if (seen.has(k) || !fs.existsSync(c.path)) continue;
    seen.add(k); out.push(c);
  }
  return out;
}

async function probe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function status(port) {
  const v = await probe(port);
  return { running: !!v, ours: !!(proc && proc.exitCode === null), browser: v?.Browser || null, pid: proc?.pid || null };
}

async function launch({ exe, port, profileDir, headless, url }) {
  if (!exe || !fs.existsSync(exe)) throw new Error('فایل اجرایی مرورگر پیدا نشد: ' + (exe || '—'));
  if (await probe(port)) throw new Error(`پورت ${port} از قبل فعال است (یک مرورگر دیباگ باز است)`);
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check',
  ];
  if (headless) args.push('--headless=new');
  args.push(url || 'about:blank');
  proc = spawn(exe, args, { detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: false });
  let spawnErr = null;
  proc.on('error', e => { spawnErr = e; proc = null; });
  proc.on('exit', () => { proc = null; });
  // صبر تا پورت دیباگ بالا بیاید
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    const v = await probe(port);
    if (v) return { browser: v.Browser, pid: proc?.pid };
    if (spawnErr) throw new Error('اجرای مرورگر ناموفق بود: ' + spawnErr.message);
    if (!proc) throw new Error('مرورگر بلافاصله بسته شد (شاید همین پروفایل در جای دیگری باز است)');
  }
  throw new Error('مرورگر اجرا شد ولی پورت دیباگ در ۱۰ ثانیه پاسخ نداد');
}

function stop() {
  if (!proc) return false;
  const pid = proc.pid;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    else { try { process.kill(-pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); } }
  } catch {}
  proc = null;
  return true;
}

module.exports = { detect, status, launch, stop, probe };
