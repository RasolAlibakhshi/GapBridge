// جست‌وجوی معنایی محلی (RAG) بدون وابستگی و بدون ارسال داده به بیرون.
// بردارِ هش‌شدهٔ کلمات + n-gram های کاراکتری (تحمل غلط املایی و ریشهٔ مشترک) با شباهت کسینوسی.
// توجه: این embedding عصبی نیست؛ شباهت واژگانی/ریخت‌شناختی را می‌گیرد، نه مترادف‌های کاملاً متفاوت.
const fs = require('fs'), path = require('path');
const { isText, BIN } = require('./tokens');
const DIM = 2048;
const norm = s => s.replace(/[\u064A]/g, '\u06CC').replace(/[\u0643]/g, '\u06A9').replace(/[\u064B-\u065F\u200C]/g, '').toLowerCase();
function h(s) { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0) % DIM; }
function split(t) { // camelCase و snake_case را هم بشکن
  return norm(t.replace(/([a-z])([A-Z])/g, '$1 $2')).match(/[a-z0-9\u0600-\u06FF]{2,}/g) || [];
}
function embed(text) {
  const v = new Float32Array(DIM);
  for (const w of split(text)) {
    v[h('w:' + w)] += 1;
    if (w.length > 3) { const p = '^' + w + '$'; for (let i = 0; i + 3 <= p.length; i++) v[h('g:' + p.slice(i, i + 3))] += 0.35; }
  }
  let n = 0; for (let i = 0; i < DIM; i++) { v[i] = Math.sign(v[i]) * Math.sqrt(Math.abs(v[i])); n += v[i] * v[i]; }
  n = Math.sqrt(n) || 1; for (let i = 0; i < DIM; i++) v[i] /= n; return v;
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < DIM; i++) s += a[i] * b[i]; return s; };
function chunks(text) {
  const lines = text.split('\n'), out = []; const SZ = 40, OV = 8;
  for (let i = 0; i < lines.length; i += SZ - OV) {
    const body = lines.slice(i, i + SZ).join('\n'); if (body.trim()) out.push({ start: i + 1, end: Math.min(i + SZ, lines.length), body });
    if (i + SZ >= lines.length) break;
  }
  return out;
}
const indexes = new Map(); // root -> {chunks:[{file,start,end,body,vec}], files:Map(file->mtime)}
function build(root, skip, maxFiles = 4000) {
  const idx = indexes.get(root) || { chunks: [], files: new Map() };
  const seen = new Set(); let n = 0;
  (function walk(d) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(f); continue; }
      if (!e.isFile() || BIN.test(f) || n >= maxFiles) continue;
      let st; try { st = fs.statSync(f); } catch { continue; }
      if (st.size > 1e6) continue; n++; seen.add(f);
      if (idx.files.get(f) === st.mtimeMs) continue;           // نمایه‌سازی افزایشی
      idx.chunks = idx.chunks.filter(c => c.file !== f);
      let b; try { b = fs.readFileSync(f); } catch { continue; }
      if (!isText(b)) continue;
      for (const c of chunks(b.toString('utf8'))) idx.chunks.push({ file: f, start: c.start, end: c.end, body: c.body, vec: embed(f + '\n' + c.body) });
      idx.files.set(f, st.mtimeMs);
    }
  })(root);
  for (const f of [...idx.files.keys()]) if (!seen.has(f)) { idx.files.delete(f); idx.chunks = idx.chunks.filter(c => c.file !== f); }
  indexes.set(root, idx); return { files: idx.files.size, chunks: idx.chunks.length };
}
function query(root, q, k = 8) {
  const idx = indexes.get(root); if (!idx) throw new Error('ابتدا index_files را اجرا کن');
  const qv = embed(q);
  return idx.chunks.map(c => ({ c, s: dot(qv, c.vec) })).sort((a, b) => b.s - a.s).slice(0, k).filter(x => x.s > 0.05)
    .map(x => ({ file: x.c.file, lines: `${x.c.start}-${x.c.end}`, score: +x.s.toFixed(3), snippet: x.c.body.slice(0, 700) }));
}
module.exports = { build, query };
