// ---------- audit: ثبت و خواندن گزارش ممیزی (JSON Lines) ----------
'use strict';
const fs = require('fs');

function append(file, rec) {
  try { fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n'); } catch {}
}

// فقط انتهای فایل خوانده می‌شود تا فایل بزرگ برنامه را کند نکند
function tail(file, { n = 200, q = '', ok = 'all', kind = 'all', bytes = 512 * 1024 } = {}) {
  let buf;
  try {
    const st = fs.statSync(file), len = Math.min(st.size, bytes);
    const fd = fs.openSync(file, 'r');
    try { buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
  } catch { return { items: [], total: 0, partial: false }; }
  const partial = buf.length >= bytes;
  let lines = buf.toString('utf8').split('\n');
  if (partial) lines.shift(); // خط اول احتمالاً نیمه است
  const needle = String(q || '').toLowerCase();
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const l = lines[i].trim(); if (!l) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    const k = r.ev === 'approve' ? 'approve' : r.ev === 'restore' ? 'restore' : 'tool';
    if (kind !== 'all' && k !== kind) continue;
    if (ok === 'ok' && r.ok !== true) continue;
    if (ok === 'fail' && r.ok !== false) continue;
    if (needle && !l.toLowerCase().includes(needle)) continue;
    out.push({ ...r, kind: k });
  }
  return { items: out, total: lines.length, partial };
}

module.exports = { append, tail };
