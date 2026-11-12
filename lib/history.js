// ---------- history: نمایهٔ پشتیبان‌ها و بازگردانی (Undo) ----------
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// اثر انگشت وضعیت یک مسیر؛ برای پوشه فقط mtime خود پوشه (تغییر در زیرپوشه‌ها دیده نمی‌شود)
function fingerprint(p) {
  let st; try { st = fs.lstatSync(p); } catch { return { exists: false }; }
  if (st.isDirectory()) return { exists: true, dir: true, mtime: st.mtimeMs };
  const f = { exists: true, dir: false, size: st.size, mtime: st.mtimeMs };
  if (st.size <= 20e6) { try { f.sha1 = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch {} }
  return f;
}
function sameFp(a, b) {
  if (!a || !b || a.exists !== b.exists) return false;
  if (!a.exists) return true;
  if (a.dir !== b.dir) return false;
  if (a.dir) return a.mtime === b.mtime;
  if (a.sha1 && b.sha1) return a.sha1 === b.sha1;
  return a.size === b.size && a.mtime === b.mtime;
}

function create({ dir, log = () => {}, max = 300 }) {
  const idx = path.join(dir, 'index.json');
  let items = [];
  try { items = JSON.parse(fs.readFileSync(idx, 'utf8')); if (!Array.isArray(items)) items = []; } catch { items = []; }
  const save = () => {
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(idx + '.tmp', JSON.stringify(items, null, 1)); fs.renameSync(idx + '.tmp', idx); }
    catch (e) { log('ذخیرهٔ نمایهٔ پشتیبان ناموفق: ' + e.message, 'error'); }
  };
  const rmBackup = e => { if (e?.backup) { try { fs.rmSync(path.dirname(e.backup), { recursive: true, force: true }); } catch {} } };
  function prune() { while (items.length > max) rmBackup(items.shift()); }

  // پیش از تغییر: کپی وضعیت فعلی (اگر وجود دارد) و ساخت رکورد؛ backup=null یعنی فایل تازه ساخته می‌شود
  function before(target, op, meta = {}) {
    const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const e = { id, t: new Date().toISOString(), op, target, backup: null, isDir: false, restored: false, ...meta };
    if (fs.existsSync(target)) {
      const d = path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '-' + id);
      fs.mkdirSync(d, { recursive: true });
      const b = path.join(d, path.basename(target) || 'root');
      fs.cpSync(target, b, { recursive: true });
      e.backup = b; e.isDir = fs.statSync(target).isDirectory();
      log('پشتیبان: ' + d);
    }
    return e;
  }
  // پس از تغییر موفق: ثبت اثر انگشت وضعیت جدید تا تغییرات بعدی کشف شود
  function after(e) {
    e.post = fingerprint(e.target);
    items.push(e); prune(); save();
    return e.id;
  }
  // اگر عملیات شکست خورد، پشتیبان بلااستفاده پاک شود
  const discard = e => rmBackup(e);

  function list(n = 50) {
    return items.slice(-n).reverse().map(e => ({
      id: e.id, t: e.t, op: e.op, target: e.target, created: !e.backup, isDir: e.isDir, restored: e.restored,
      changed: !e.restored && !sameFp(e.post, fingerprint(e.target)),
    }));
  }

  // check(target) باید مسیر را دوباره با roots بسنجد و در صورت خروج خطا بدهد
  function restore(id, { check, force = false } = {}) {
    const e = items.find(x => x.id === id);
    if (!e) throw new Error('رکورد پیدا نشد');
    if (e.restored) throw new Error('قبلاً بازگردانی شده است');
    if (check) check(e.target);
    if (!force && !sameFp(e.post, fingerprint(e.target))) {
      const err = new Error('مسیر پس از این عملیات دوباره تغییر کرده است؛ بازگردانی انجام نشد');
      err.conflict = true; throw err;
    }
    if (e.backup && !fs.existsSync(e.backup)) throw new Error('فایل پشتیبان پیدا نشد');
    // از وضعیت فعلی هم پشتیبان گرفته می‌شود تا خود Undo هم برگشت‌پذیر باشد
    const cur = before(e.target, 'undo', { of: e.id });
    try {
      if (fs.existsSync(e.target)) fs.rmSync(e.target, { recursive: true, force: true });
      if (e.backup) { fs.mkdirSync(path.dirname(e.target), { recursive: true }); fs.cpSync(e.backup, e.target, { recursive: true }); }
    } catch (x) {
      if (cur.backup) { try { fs.rmSync(e.target, { recursive: true, force: true }); fs.cpSync(cur.backup, e.target, { recursive: true }); } catch {} }
      discard(cur); throw x;
    }
    e.restored = true; after(cur);
    log(`بازگردانی ${e.op}: ${e.target}`);
    return { restored: e.target, op: e.op, removed: !e.backup };
  }

  return { before, after, discard, list, restore, get: id => items.find(x => x.id === id) };
}

module.exports = { create, fingerprint, sameFp };
