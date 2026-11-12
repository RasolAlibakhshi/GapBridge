// شمارندهٔ تخمینی توکن (بدون وابستگی). برای فارسی محافظه‌کارانه می‌شمارد.
const fs = require('fs'), path = require('path');
const RE = /[A-Za-z]+|\d+|[\u0600-\u06FF\u200C]+|\s+|[^\sA-Za-z\d\u0600-\u06FF\u200C]+/g;
function estTokens(s) {
  s = String(s || ''); let n = 0, m; RE.lastIndex = 0;
  while ((m = RE.exec(s))) {
    const t = m[0], L = t.length, c = t.charCodeAt(0);
    if ((c | 32) >= 97 && (c | 32) <= 122) n += L <= 7 ? 1 : Math.ceil(L / 6);
    else if (c >= 48 && c <= 57) n += Math.ceil(L / 3);
    else if (c >= 0x600) n += Math.ceil(L / 2.5);
    else if (/\s/.test(t)) n += (L > 1 || t === '\n') ? 1 : 0;
    else n += Math.max(1, Math.round([...t].reduce((a, ch) => a + (ch.charCodeAt(0) > 127 ? 1.5 : 0.5), 0)));
  }
  return Math.max(s ? 1 : 0, n);
}
const BIN = /\.(png|jpe?g|gif|webp|bmp|ico|mp[34]|mkv|avi|mov|wav|zip|7z|rar|gz|tar|exe|dll|so|bin|class|jar|pyc|wasm|pdf|docx?|xlsx?|pptx?|woff2?|ttf|otf|sqlite|db|iso|msi)$/i;
const isText = b => { for (let i = 0, n = Math.min(b.length, 8000); i < n; i++) if (b[i] === 0) return false; return true; };
function fileTokens(p) {
  const st = fs.statSync(p); if (!st.isFile()) return null;
  if (BIN.test(p)) return { path: p, bytes: st.size, binary: true };
  if (st.size > 2e6) return { path: p, bytes: st.size, tokens: Math.round(st.size / 3.5), approx: true };
  const b = fs.readFileSync(p); if (!isText(b)) return { path: p, bytes: st.size, binary: true };
  const t = b.toString('utf8'); return { path: p, bytes: st.size, lines: t.split('\n').length, tokens: estTokens(t) };
}
function dirTokens(dir, skip, max = 3000) {
  const files = []; let total = 0;
  (function walk(d) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (files.length >= max) return;
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(f); continue; }
      if (!e.isFile()) continue;
      try { const r = fileTokens(f); if (r && !r.binary) { files.push(r); total += r.tokens; } } catch {}
    }
  })(dir);
  files.sort((a, b) => b.tokens - a.tokens);
  return { total, count: files.length, top: files.slice(0, 30) };
}
module.exports = { estTokens, fileTokens, dirTokens, isText, BIN };
