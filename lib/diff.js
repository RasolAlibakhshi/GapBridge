// ---------- diff: نمایش خط‌به‌خط تغییرات برای پنجرهٔ تأیید ----------
'use strict';
const toLines = s => String(s ?? '').replace(/\r\n/g, '\n').split('\n');
const clip = (t, n = 300) => (t.length > n ? t.slice(0, n) + '…' : t);

// LCS پس از حذف پیشوند/پسوند مشترک؛ اگر بخش میانی خیلی بزرگ باشد، حذف/افزودن کامل نشان داده می‌شود
function ops(a, b) {
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const out = [];
  for (let i = 0; i < s; i++) out.push([' ', a[i]]);
  const A = a.slice(s, ea), B = b.slice(s, eb), n = A.length, m = B.length;
  if (n && m && (n + 1) * (m + 1) <= 4e6) {
    const w = m + 1, L = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push([' ', A[i]]); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) out.push(['-', A[i++]]);
      else out.push(['+', B[j++]]);
    }
    while (i < n) out.push(['-', A[i++]]);
    while (j < m) out.push(['+', B[j++]]);
  } else {
    for (const x of A) out.push(['-', x]);
    for (const x of B) out.push(['+', x]);
  }
  for (let i = ea; i < a.length; i++) out.push([' ', a[i]]);
  return out;
}

// خروجی شبیه unified diff با چند خط زمینه؛ طول کل محدود می‌شود
function unified(oldText, newText, opt = {}) {
  const ctx = opt.context ?? 3, max = opt.max ?? 1600;
  const o1 = String(oldText ?? ''), n1 = String(newText ?? '');
  if (o1.includes('\0') || n1.includes('\0')) return { text: '(فایل دودویی؛ مقایسه نمایش داده نمی‌شود)', added: 0, removed: 0, same: o1 === n1, binary: true };
  const rows = []; let la = 1, lb = 1;
  for (const [k, t] of ops(toLines(o1), toLines(n1))) {
    rows.push({ k, t, a: la, b: lb });
    if (k !== '+') la++;
    if (k !== '-') lb++;
  }
  let added = 0, removed = 0; const ch = [];
  rows.forEach((r, i) => { if (r.k === '+') added++; if (r.k === '-') removed++; if (r.k !== ' ') ch.push(i); });
  if (!ch.length) return { text: '(بدون تغییر)', added, removed, same: true };
  const hunks = []; let cur = null;
  for (const i of ch) {
    const s = Math.max(0, i - ctx), e = Math.min(rows.length - 1, i + ctx);
    if (cur && s <= cur.e + 1) cur.e = Math.max(cur.e, e); else hunks.push(cur = { s, e });
  }
  const out = [];
  for (const h of hunks) {
    const seg = rows.slice(h.s, h.e + 1);
    const na = seg.filter(r => r.k !== '+').length, nb = seg.filter(r => r.k !== '-').length;
    out.push(`@@ -${seg[0].a},${na} +${seg[0].b},${nb} @@`);
    for (const r of seg) out.push(r.k + ' ' + clip(r.t));
  }
  let text = out.join('\n');
  if (text.length > max) text = text.slice(0, max) + `\n...[بریده شد، ${text.length - max} کاراکتر دیگر]`;
  return { text, added, removed, same: false };
}
const summary = d => (d.binary ? 'دودویی' : d.same ? 'بدون تغییر' : `+${d.added} / −${d.removed} خط`);

module.exports = { unified, summary, ops };
