import { spawn } from 'node:child_process';

export function openUrl(url) {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) {
    return { ok: false, error: 'Only http(s) URLs can be opened' };
  }
  const p = process.platform;
  try {
    const child = p === 'win32'
      ? spawn('cmd', ['/c', 'start', '', clean], { stdio: 'ignore', detached: true, windowsHide: true })
      : spawn(p === 'darwin' ? 'open' : 'xdg-open', [clean], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'Could not open URL' };
  }
}
