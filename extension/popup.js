const $ = id => document.getElementById(id);
// همان پیش‌فرض‌های content.js
const DEF_SEL = { input: '.composer-textarea textarea, textarea.q-field__native', send: '.submit-btn-v2', attach: '' };
const DEF_CHUNK = 12000;
function drawPower(on) {
  $('power').textContent = on ? '⏻ روشن است (برای خاموش کردن کلیک کن)' : '⏻ خاموش است (برای روشن کردن کلیک کن)';
  $('power').style.background = on ? '#bbf7d0' : '#e5e7eb';
}
function drawSel(sel, chunk) {
  sel = { ...DEF_SEL, ...(sel || {}) };
  $('selInput').value = sel.input; $('selSend').value = sel.send; $('selAttach').value = sel.attach;
  $('selInput').placeholder = DEF_SEL.input; $('selSend').placeholder = DEF_SEL.send; $('selAttach').placeholder = '(خودکار)';
  $('chunk').value = chunk ?? DEF_CHUNK;
}
chrome.storage.local.get(['token', 'autosend', 'enabled', 'sel', 'chunk']).then(s => {
  $('token').value = s.token || '';
  $('auto').checked = s.autosend !== false;
  drawPower(s.enabled !== false);
  drawSel(s.sel, s.chunk);
});
$('power').onclick = async () => {
  const { enabled } = await chrome.storage.local.get('enabled');
  const on = enabled === false; // toggle
  await chrome.storage.local.set({ enabled: on });
  drawPower(on);
};
function validSel(s) { if (!s) return true; try { document.createDocumentFragment().querySelector(s); return true; } catch { return false; } }
function readSel() {
  const sel = { input: $('selInput').value.trim(), send: $('selSend').value.trim(), attach: $('selAttach').value.trim() };
  const names = { input: 'کادر ورودی', send: 'دکمهٔ ارسال', attach: 'دکمهٔ پیوست' };
  for (const k in sel) {
    if (sel[k].length > 500) throw new Error('انتخابگر ' + names[k] + ' خیلی بلند است');
    if (!validSel(sel[k])) throw new Error('انتخابگر ' + names[k] + ' نامعتبر است');
  }
  if (!sel.input) sel.input = DEF_SEL.input;
  if (!sel.send) sel.send = DEF_SEL.send;
  return sel;
}
function readChunk() {
  const n = Math.floor(Number($('chunk').value));
  if (!Number.isFinite(n) || n < 0) throw new Error('طول پیام نامعتبر است');
  return n === 0 ? 0 : Math.min(Math.max(n, 2000), 1000000);
}
$('save').onclick = async () => {
  let sel, chunk;
  try { sel = readSel(); chunk = readChunk(); } catch (e) { $('msg').textContent = '✗ ' + e.message; $('adv').open = true; return; }
  await chrome.storage.local.set({ token: $('token').value.trim(), autosend: $('auto').checked, sel, chunk });
  drawSel(sel, chunk);
  const r = await chrome.runtime.sendMessage({ type: 'call', call: { id: 'ping', fs: 'list_roots' } });
  $('msg').textContent = r && r.ok ? '✓ وصل شد' : '✗ ' + (r ? r.error : 'پاسخی نیامد');
};
$('reset').onclick = async () => {
  await chrome.storage.local.set({ sel: { ...DEF_SEL }, chunk: DEF_CHUNK });
  drawSel(DEF_SEL, DEF_CHUNK);
  $('tmsg').textContent = 'پیش‌فرض‌ها ذخیره شد.';
};
$('test').onclick = async () => {
  let sel;
  try { sel = readSel(); } catch (e) { $('tmsg').textContent = '✗ ' + e.message; return; }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let r;
  try { r = await chrome.tabs.sendMessage(tab.id, { type: 'gb-test-sel', sel }); } catch { r = null; }
  if (!r) { $('tmsg').textContent = '✗ تب فعلی صفحهٔ gapgpt نیست یا افزونه هنوز در آن بارگذاری نشده (صفحه را تازه کن).'; return; }
  const yes = (own, any) => own ? '✓ پیدا شد' : any ? '⚠ نه؛ از راه پشتیبان پیدا شد' : '✗ پیدا نشد';
  $('tmsg').textContent = (r.bad.length ? 'نامعتبر: ' + r.bad.join('، ') + ' — ' : '') +
    'کادر ورودی: ' + yes(r.input, r.inputAny) + ' | دکمهٔ ارسال: ' + yes(r.send, r.sendAny) +
    (sel.attach ? ' | پیوست: ' + (r.attach ? '✓' : '✗') : '') + ' (عنصر پیداشده قاب قرمز می‌گیرد)';
};
