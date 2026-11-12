// Watches the chat for tool blocks (JSON with "id" and "fs"), runs them via the local app,
// and posts the results back into the chat input.
(async () => {
  const store = await chrome.storage.local.get(['autosend', 'enabled', 'sel', 'chunk']);
  // انتخابگرها از پاپ‌آپ افزونه قابل تغییرند؛ مقادیر زیر پیش‌فرض و راه پشتیبان هستند
  const DEF_SEL = { input: '.composer-textarea textarea, textarea.q-field__native', send: '.submit-btn-v2', attach: '' };
  const DEF_CHUNK = 12000; // حداکثر نویسهٔ هر پیام؛ 0 یعنی تقسیم نشود
  let SEL = { ...DEF_SEL, ...(store.sel || {}) };
  const qsa = s => { if (!s) return []; try { return [...document.querySelectorAll(s)]; } catch { return []; } }; // selector نامعتبر صفحه را نمی‌شکند
  const isSend = b => [SEL.send, DEF_SEL.send].some(s => { try { return !!s && b.matches(s); } catch { return false; } });
  const chunkSize = () => { const n = Number(store.chunk ?? DEF_CHUNK); return Number.isFinite(n) && n > 0 ? Math.max(2000, n) : 0; };
  const done = new Set(); // در حافظه‌ی همین صفحه؛ id ها بین گفتگوها تکراری می‌شوند
  let busy = false, timer, busyNote = '';

  const mark = c => done.add(JSON.stringify(c));

  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;background:#166534;color:#fff;font:bold 13px sans-serif;padding:7px 12px;border-radius:8px;box-shadow:0 2px 10px #0006;pointer-events:none;direction:rtl';
  document.documentElement.appendChild(badge);
  const setBadge = (t, mode = 'ready') => {
    badge.textContent = 'Gap Bridge: ' + t;
    badge.style.background = mode === 'busy' ? '#b45309' : mode === 'wait' ? '#b91c1c' : mode === 'off' ? '#4b5563' : '#15803d';
  };
  const on = () => store.enabled !== false;
  const showOff = () => { badge.style.display = on() ? '' : 'none'; };
  showOff();
  setBadge('آماده برای پرامپت', 'ready');

  function parseBlock(text) {
    text = text.trim().replace(/^(tool|json)\s*\n/i, '');
    if (!text.startsWith('{')) return null;
    try {
      const o = JSON.parse(text);
      if (o && typeof o.id === 'string' && typeof o.fs === 'string') return o;
    } catch {}
    return null;
  }

  function findCalls() {
    const out = [];
    document.querySelectorAll('pre, code').forEach(pre => {
      const c = parseBlock(pre.innerText || '');
      if (c && !done.has(JSON.stringify(c)) && !/^example/i.test(c.id) && !out.some(x => x.id === c.id)) out.push(c);
    });
    return out;
  }

  function visible(el) { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function findInput(sel = SEL) {
    for (const s of [sel.input, DEF_SEL.input]) { const el = qsa(s).find(visible); if (el) return el; }
    const list = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter(visible);
    return list[list.length - 1];
  }
  function setText(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, text);
    }
  }
  function findSend(sel = SEL) {
    for (const s of [sel.send, DEF_SEL.send]) { const b = qsa(s).find(visible); if (b) return b; }
    return null;
  }
  function sendMessage(el) {
    const sb = findSend();
    if (sb && !sb.disabled && !sb.classList.contains('disabled') && !/stop|square/i.test(sb.innerText)) { sb.click(); return; }
    let box = el;
    for (let i = 0; i < 5 && box.parentElement; i++) {
      box = box.parentElement;
      const btns = [...box.querySelectorAll('button')].filter(b => !b.disabled && visible(b));
      const pick = btns.find(b => b.type === 'submit') ||
        btns.find(b => /send|ارسال/i.test((b.getAttribute('aria-label') || '') + (b.title || '') + b.innerText));
      if (pick) { pick.click(); return; }
    }
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    const form = el.closest('form'); if (form?.requestSubmit) { try { form.requestSubmit(); return; } catch {} }
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // ---- ضمیمه‌کردن فایل به چت ----
  function b64File(a) {
    const bin = atob(a.b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new File([u], a.name, { type: a.mime });
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // دکمه‌ی «+» سمت راست کادر پیام (دکمه‌ی ارسال در gapgpt سمت چپ است)
  function findPlusButton(ta) {
    const custom = qsa(SEL.attach).find(visible);
    if (custom) return custom;
    const btns = [...document.querySelectorAll('button,[role=button]')].filter(b => visible(b) && !b.disabled && !isSend(b));
    const byLabel = btns.find(b => /attach|upload|افزودن|پیوست|بارگذاری|آپلود/i.test((b.getAttribute('aria-label') || '') + (b.title || '') + (b.getAttribute('data-testid') || '')));
    if (byLabel) return byLabel;
    if (!ta) return null;
    const tr = ta.getBoundingClientRect(), cy = tr.top + tr.height / 2;
    const row = btns.filter(b => { const r = b.getBoundingClientRect(); return r.left >= tr.right - 20 && Math.abs(r.top + r.height / 2 - cy) < 60; });
    return row.sort((x, y) => y.getBoundingClientRect().left - x.getBoundingClientRect().left)[0] || null;
  }
  // گزینه‌ی «افزودن فایل و تصویر» در منوی باز شده
  function findFileMenuItem() {
    const re = /افزودن فایل|فایل و تصویر|افزودن عکس|upload|attach|add (file|photo|image)/i;
    const hits = [...document.querySelectorAll('button,[role=menuitem],[role=option],li,a,div,span')]
      .filter(x => visible(x) && (x.innerText || '').trim().length < 60 && re.test(x.innerText || ''));
    // کوچک‌ترین عنصر (عمیق‌ترین) را برمی‌گرداند تا روی خود گزینه کلیک شود
    return hits.sort((x, y) => (x.innerText || '').length - (y.innerText || '').length)[0] || null;
  }
  async function attachFiles(files) {
    const dt = new DataTransfer(); files.forEach(f => dt.items.add(f));
    const ta = findInput();
    const inputs = () => [...document.querySelectorAll('input[type=file]')];
    let inp = inputs().pop();
    if (!inp) {
      const plus = findPlusButton(ta);
      if (plus) { plus.click(); await sleep(500); }
      const item = findFileMenuItem();
      if (item) { item.click(); await sleep(500); }
      inp = inputs().pop();
    }
    if (inp) { inp.files = dt.files; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); return 'input'; }
    if (!ta) return null;
    // راه پشتیبان: paste/drop روی کادر پیام
    ta.focus();
    try { ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); } catch {}
    ta.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return 'drop';
  }

  // ---- تشخیص پایان پاسخ مدل ----
  let lastMut = Date.now();
  const STOP_RE = /\b(stop|cancel|abort|interrupt)\b|توقف|متوقف|لغو/i;
  function generating() {
    // دکمه‌ی «توقف» دیده می‌شود؟
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      if (!visible(b)) continue;
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' ' + (b.getAttribute('data-testid') || '') + ' ' + (b.innerText || '').slice(0, 30);
      if (STOP_RE.test(label)) return true;
    }
    // در gapgpt همان دکمه‌ی ارسال هنگام تولید به آیکون stop تبدیل می‌شود
    const sb = findSend();
    if (sb && /stop|square|pause/i.test(sb.innerText || '')) return true;
    // نشانه‌ی تایپ/انیمیشن در حال پخش
    if (document.querySelector('[aria-busy="true"], .typing, .streaming, .loading-dots, [class*="typing"], [class*="streaming"], [class*="generating"]')) return true;
    return false;
  }
  // منتظر می‌ماند تا دکمه‌ی توقف نباشد و صفحه ۴ ثانیه تغییر نکند
  async function waitIdle(maxMs = 300000) {
    const QUIET = 4000, t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (!on()) return false;
      const quiet = Date.now() - lastMut;
      if (!generating() && quiet >= QUIET) return true;
      setBadge('منتظر پایان پاسخ مدل…');
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  // نشانگر ثابت صفحه: فقط وقتی پاسخ متوقف و صفحه حداقل ۴ ثانیه آرام بوده، اعلام آمادگی می‌کند.
  function refreshPromptStatus() {
    if (!on()) { setBadge('افزونه خاموش است', 'off'); return; }
    if (busy) { setBadge(busyNote || 'درحال اجرای دستور', 'busy'); return; }
    if (generating() || Date.now() - lastMut < 4000) { setBadge('صبر کنید — مدل در حال پاسخ است', 'wait'); return; }
    setBadge('آماده برای پرامپت', 'ready');
  }
  setInterval(refreshPromptStatus, 750);

  // ---- تقسیم خروجی طولانی ----
  // نتیجه‌ها تا جای ممکن کامل در یک پیام می‌مانند؛ فقط نتیجهٔ بزرگ‌تر از حد، شکسته می‌شود.
  function splitText(s, max) {
    const out = [];
    while (s.length > max) {
      let cut = s.lastIndexOf('\n', max);
      if (cut < max * 0.5) cut = max;
      const c = s.charCodeAt(cut - 1);
      if (c >= 0xD800 && c <= 0xDBFF) cut--; // نیمهٔ یک کاراکتر دوبخشی (مثل ایموجی) جدا نشود
      out.push(s.slice(0, cut));
      s = s.slice(cut);
    }
    if (s) out.push(s);
    return out;
  }
  function packParts(parts, limit) {
    if (!limit) return [parts.join('\n\n')];
    const room = limit - 160; // جا برای سرتیتر هر بخش
    const msgs = []; let cur = '';
    for (let i = 0; i < parts.length; i++) {
      // جداکننده اول نتیجهٔ بعدی می‌آید تا اگر مرز پیام همین‌جا افتاد، گم نشود (بعد از سرتیتر هم trim نمی‌شود)
      const q = i ? '\n\n' + parts[i] : parts[i];
      if (cur.length + q.length <= room) { cur += q; continue; }
      if (cur) msgs.push(cur);
      if (q.length > room) { msgs.push(...splitText(q, room)); cur = ''; } else cur = q;
    }
    if (cur) msgs.push(cur);
    if (msgs.length < 2) return msgs;
    const n = msgs.length;
    return msgs.map((m, i) => (i < n - 1
      ? `TOOL_RESULT_PART ${i + 1}/${n} (ادامه دارد؛ تا رسیدن بخش ${n}/${n} فقط بنویس «ادامه» و هیچ ابزاری صدا نزن)\n`
      : `TOOL_RESULT_PART ${n}/${n} (بخش آخر؛ متن همهٔ بخش‌ها را بدون فاصله پشت هم بگذار و ادامه بده)\n`) + m);
  }
  const inputText = el => (el ? (el.value ?? el.innerText ?? '') : '');
  // منتظر می‌ماند تا متن از کادر ورودی برود (یعنی پیام ارسال شد)
  async function waitSent(head, maxMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (!on()) return false;
      const el = findInput();
      if (!el || !inputText(el).startsWith(head)) return true;
      await sleep(400);
    }
    return false;
  }
  const MAX_PARTS = 30;
  // هشدار به کاربر + ثبت در کنسول خطاهای برنامه (اگر وصل نباشد، در صف افزونه می‌ماند)
  function gbAlert(msg, level = 'warn', err) {
    try { chrome.runtime.sendMessage({ type: 'gb-error', level, message: msg, stack: err?.stack || '' }).catch(() => {}); } catch {}
    alert(msg);
  }

  async function run() {
    if (busy || !on()) return;
    const calls = findCalls();
    if (!calls.length) { setBadge('آماده — درخواست‌های دیده‌شده: ' + done.size); return; }
    busy = true;
    try {
      const parts = [], attach = [];
      for (const call of calls) {
        mark(call);
        setBadge('در حال اجرای ' + call.id + ' (' + call.fs + ') — اگر نیاز به تأیید است، پنجرهٔ برنامه را ببین');
        const r = await chrome.runtime.sendMessage({ type: 'call', call }) || { ok: false, error: 'پاسخی از افزونه نرسید' };
        if (r.ok && r.data && r.data._attach) { attach.push(b64File(r.data._attach)); r.data = { attached: r.data._attach.name, size: r.data._attach.size, note: 'فایل به کادر چت ضمیمه شد (اگر در پیش‌نمایش دیده نشد، دستی آپلود کنید)' }; }
        const body = r.ok ? { ok: true, result: r.data } : { ok: false, error: r.error };
        parts.push(`TOOL_RESULT id=${call.id}\n${JSON.stringify(body)}`);
      }
      const text = parts.join('\n\n');
      console.log('[Gap Bridge] result:', text);
      setBadge('نتیجهٔ ' + calls.map(c => c.id).join(',') + ' آمد');
      if (!findInput()) { navigator.clipboard?.writeText(text).catch(() => {}); gbAlert('Gap Bridge: کادر ورودی پیدا نشد؛ نتیجه کپی شد، دستی بفرست. (انتخابگر کادر ورودی را در پاپ‌آپ افزونه بررسی کن)'); return; }
      const msgs = packParts(parts, chunkSize());
      if (msgs.length > MAX_PARTS && !confirm(`Gap Bridge: خروجی ${text.length.toLocaleString('fa')} نویسه است و در ${msgs.length} پیام فرستاده می‌شود. ادامه بدهم؟\n(لغو = کپی کل نتیجه در کلیپ‌بورد)`)) {
        navigator.clipboard?.writeText(text).catch(() => {}); setBadge('ارسال لغو شد — نتیجه کپی شد', 'off'); return;
      }
      const auto = store.autosend !== false;
      for (let i = 0; i < msgs.length; i++) {
        const multi = msgs.length > 1, tag = multi ? ` (بخش ${i + 1} از ${msgs.length})` : '';
        const idle = await waitIdle();
        if (!on()) return;
        // مدل وسط ارسال چندبخشی نباید ابزار صدا بزند؛ تماس‌های این فاصله اجرا نمی‌شوند
        if (i > 0) findCalls().forEach(c => { mark(c); console.warn('[Gap Bridge] تماس وسط ارسال چندبخشی نادیده گرفته شد:', c); });
        const input = findInput();
        if (!input) throw new Error('کادر ورودی پیدا نشد' + tag);
        if (i === 0 && attach.length) {
          const how = await attachFiles(attach);
          if (!how) gbAlert('Gap Bridge: محل آپلود فایل پیدا نشد؛ فایل را دستی ضمیمه کنید.');
          await sleep(2500); // صبر برای پایان آپلود
        }
        setText(input, msgs[i]);
        const head = msgs[i].slice(0, 40);
        if (!idle || !auto) {
          setBadge((!idle ? 'مدل هنوز در حال کار است — ' : '') + 'نتیجه' + tag + ' در کادر قرار گرفت، دستی بفرست', 'wait');
          if (!multi) return;
          busyNote = 'بخش' + tag + ' در کادر است؛ دستی بفرست تا بخش بعدی بیاید';
          // بخش بعدی بعد از ارسال دستی همین بخش قرار می‌گیرد
          if (!await waitSent(head, 15 * 60000)) { navigator.clipboard?.writeText(msgs.slice(i).join('\n\n')).catch(() => {}); gbAlert('Gap Bridge: بخش' + tag + ' ارسال نشد؛ بخش‌های باقی‌مانده کپی شد.'); return; }
        } else {
          await sleep(500);
          if (!generating()) sendMessage(input);
          if (multi && !await waitSent(head, 20000)) { navigator.clipboard?.writeText(msgs.slice(i).join('\n\n')).catch(() => {}); gbAlert('Gap Bridge: ارسال خودکار' + tag + ' انجام نشد (انتخابگر دکمهٔ ارسال را بررسی کن)؛ بخش‌های باقی‌مانده کپی شد.'); return; }
        }
        busyNote = '';
        if (multi && i < msgs.length - 1) { setBadge('بخش ' + (i + 1) + ' از ' + msgs.length + ' فرستاده شد؛ منتظر پاسخ کوتاه مدل…', 'busy'); lastMut = Date.now(); await sleep(1500); }
      }
    } catch (e) {
      console.error('[Gap Bridge]', e);
      gbAlert('Gap Bridge خطا داد: ' + e.message, 'error', e);
    } finally {
      busy = false; busyNote = '';
      // تماس‌های تازه‌ای که هنگام ارسال چندبخشی رسیده‌اند بررسی شوند
      clearTimeout(timer); timer = setTimeout(run, 2500);
    }
  }

  new MutationObserver(ms => {
    if (ms.some(m => !badge.contains(m.target))) lastMut = Date.now();
    clearTimeout(timer); timer = setTimeout(run, 2500);
  })
    .observe(document.body, { childList: true, subtree: true, characterData: true });

  chrome.storage.onChanged.addListener(c => {
    if (c.autosend) store.autosend = c.autosend.newValue;
    if (c.sel) SEL = { ...DEF_SEL, ...(c.sel.newValue || {}) };
    if (c.chunk) store.chunk = c.chunk.newValue;
    if (c.enabled) { store.enabled = c.enabled.newValue; showOff(); if (on()) findCalls().forEach(mark); }
  });
  // آزمایش انتخابگرها از پاپ‌آپ: عنصر پیداشده چند لحظه قاب قرمز می‌گیرد
  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (!m || m.type !== 'gb-test-sel') return;
    const sel = { ...DEF_SEL, ...(m.sel || {}) }, bad = [];
    for (const k of ['input', 'send', 'attach']) { if (sel[k]) try { document.querySelector(sel[k]); } catch { bad.push(k); } }
    const own = k => !!sel[k] && !bad.includes(k) && qsa(sel[k]).some(visible);
    const inp = findInput(sel), snd = findSend(sel);
    [inp, snd].forEach(el => { if (!el) return; const o = el.style.outline; el.style.outline = '3px solid #dc2626'; setTimeout(() => { el.style.outline = o; }, 2500); });
    reply({ bad, input: own('input'), send: own('send'), attach: own('attach'), inputAny: !!inp, sendAny: !!snd });
  });
  // blocks already on the page when the extension loads are treated as old
  findCalls().forEach(mark);
})();
