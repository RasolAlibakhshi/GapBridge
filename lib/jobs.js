// کارهای طولانی پس‌زمینه: اجرا، لاگ زنده، اعلان پایان.
const { spawn, exec } = require('child_process');
const jobs = new Map(); let seq = 0;
function start({ command, cwd, timeoutSec = 3600, onLog, onDone }) {
  const id = 'j' + (++seq);
  const ch = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32' });
  const j = { id, command, cwd, pid: ch.pid, started: Date.now(), status: 'running', out: '', code: null, ch };
  jobs.set(id, j);
  const feed = tag => d => { const s = String(d); j.out = (j.out + s).slice(-200000); s.split(/\r?\n/).filter(Boolean).forEach(l => onLog?.(id, tag + l)); };
  ch.stdout.on('data', feed('')); ch.stderr.on('data', feed('! '));
  const tm = setTimeout(() => kill(id), Math.min(timeoutSec, 86400) * 1000);
  ch.on('close', code => { clearTimeout(tm); if (j.status === 'running') j.status = code === 0 ? 'done' : 'failed'; j.code = code; j.ended = Date.now(); onDone?.(j); });
  ch.on('error', e => { j.status = 'failed'; j.out += String(e.message); });
  return j;
}
function kill(id) {
  const j = jobs.get(id); if (!j || j.status !== 'running') return false; j.status = 'killed';
  if (process.platform === 'win32') exec(`taskkill /pid ${j.pid} /T /F`, { windowsHide: true }); else { try { process.kill(-j.pid, 'SIGKILL'); } catch { try { j.ch.kill('SIGKILL'); } catch {} } }
  return true;
}
const view = (j, tail = 4000) => ({ id: j.id, command: j.command, status: j.status, exit_code: j.code, seconds: Math.round(((j.ended || Date.now()) - j.started) / 1000), output_tail: j.out.slice(-tail) });
const get = id => jobs.get(id), list = () => [...jobs.values()].map(j => view(j, 0)), killAll = () => [...jobs.keys()].filter(kill).length;
module.exports = { start, kill, get, list, view, killAll };
