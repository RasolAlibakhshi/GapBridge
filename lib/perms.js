// ---------- perms: دسترسی جدا برای هر دسته از ابزارها ----------
'use strict';
// default = پیروی از کلید سراسری «اجرای خودکار»؛ ask = همیشه بپرس؛ auto = بی‌پرسش؛ deny = همیشه رد
const GROUPS = {
  write: 'فایل‌ها: نوشتن، ویرایش، حذف، دانلود، بازگردانی',
  run: 'اجرای دستور: run، پس‌زمینه، ترمینال',
  browser: 'مرورگر: اجرا، رفتن، کلیک، تایپ، JavaScript',
  attach: 'ارسال فایل به چت',
};
const MODES = ['default', 'ask', 'auto', 'deny'];

function normalize(p) {
  const o = {};
  for (const g of Object.keys(GROUPS)) o[g] = MODES.includes(p?.[g]) ? p[g] : 'default';
  return o;
}
// خروجی: 'ask' | 'auto' | 'deny'. دستور خطرناک (force) هرگز بی‌پرسش اجرا نمی‌شود، ولی deny بر آن هم مقدم است.
function decide(perms, group, globalAuto, force) {
  const m = (group && perms?.[group]) || 'default';
  if (m === 'deny') return 'deny';
  if (force) return 'ask';
  if (m === 'auto') return 'auto';
  if (m === 'ask') return 'ask';
  return globalAuto ? 'auto' : 'ask';
}

module.exports = { GROUPS, MODES, normalize, decide };
