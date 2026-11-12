// ---------- logbuf: حافظهٔ حلقه‌ای محدود برای کنسول خطاها ----------
// فقط در حافظه (روی دیسک نوشته نمی‌شود). سطح همیشه صریح از محل فراخوانی می‌آید، از روی متن حدس زده نمی‌شود.
'use strict';

const LEVELS = ['info', 'warn', 'error'];
const SOURCES = ['main', 'ui', 'ext', 'tool'];

// نویسه‌های کنترلی (جز \n و \t) حذف و متن کوتاه می‌شود
function clean(s, n) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  return s.length > n ? s.slice(0, n) + ` …[+${s.length - n}]` : s;
}

// فیلتر مشترک بین رابط و کپی. level: all | issues (هشدار+خطا) | info | warn | error
function match(e, { level = 'all', source = 'all', q = '' } = {}) {
  if (level === 'issues' ? e.level === 'info' : level !== 'all' && e.level !== level) return false;
  if (source !== 'all' && e.source !== source) return false;
  const needle = String(q || '').trim().toLowerCase();
  if (needle && !(e.msg + '\n' + e.stack).toLowerCase().includes(needle)) return false;
  return true;
}

function create({ max = 1000, msgMax = 2000, stackMax = 4000, now = Date.now } = {}) {
  let items = [], seq = 0;

  // پیام تکراری پشت‌سرهم یک ردیف با شمارنده می‌شود (همان id، تا رابط آن را به‌روز کند)
  function add(level, source, msg, extra = {}) {
    level = LEVELS.includes(level) ? level : 'info';
    source = SOURCES.includes(source) ? source : 'main';
    msg = clean(msg, msgMax);
    const stack = extra && extra.stack ? clean(extra.stack, stackMax) : '';
    const last = items[items.length - 1];
    if (last && last.level === level && last.source === source && last.msg === msg && last.stack === stack) {
      last.n++; last.t = now(); return { ...last };
    }
    const e = { id: ++seq, t: now(), level, source, msg, stack, n: 1 };
    items.push(e);
    if (items.length > max) items = items.slice(items.length - max);
    return { ...e };
  }

  function stats() {
    const s = { total: 0, info: 0, warn: 0, error: 0 };
    for (const e of items) { s.total += e.n; s[e.level] += e.n; }
    return s;
  }

  function list(filter = {}) { return items.filter(e => match(e, filter)).map(e => ({ ...e })); }

  function clear() { items = []; return stats(); }

  // متن ساده برای گزارش باگ؛ redact: تابعی برای پنهان کردن مسیر خانه/توکن
  function text(filter = {}, { header = '', redact = s => s } = {}) {
    const rows = list(filter);
    const lines = rows.map(e => {
      const head = `${new Date(e.t).toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.msg}${e.n > 1 ? ` (×${e.n})` : ''}`;
      return e.stack ? head + '\n' + e.stack.split('\n').map(l => '    ' + l).join('\n') : head;
    });
    return { count: rows.length, text: redact((header ? header + '\n' + '-'.repeat(40) + '\n' : '') + lines.join('\n')) };
  }

  return { add, list, clear, stats, text };
}

// محدودکنندهٔ ساده: حداکثر n پیام در هر پنجرهٔ ms. پیام‌های دورریخته شمرده می‌شوند.
// ok() → true/false ؛ dropped() شمار دورریخته‌های پنجرهٔ قبلی را یک بار برمی‌گرداند و صفر می‌کند.
function limiter({ n = 20, ms = 60000, now = Date.now } = {}) {
  let start = now(), used = 0, drop = 0, pending = 0;
  return {
    ok() {
      const t = now();
      if (t - start >= ms) { pending += drop; start = t; used = 0; drop = 0; }
      if (used < n) { used++; return true; }
      drop++; return false;
    },
    dropped() { const d = pending; pending = 0; return d; },
  };
}

module.exports = { create, limiter, match, clean, LEVELS, SOURCES };
