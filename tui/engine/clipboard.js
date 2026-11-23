import { spawnSync } from 'node:child_process';

let clearTimer = null;

function runClip(bin, args, input) {
  try {
    const res = spawnSync(bin, args, { input, encoding: 'utf8', timeout: 2000, windowsHide: true });
    return res.status === 0 && !res.error;
  } catch (_) {
    return false;
  }
}

function writePlatformClipboard(text) {
  const p = process.platform;
  if (p === 'win32') {
    if (runClip('clip', [], text)) return 'clip';
    if (runClip('powershell', ['-NoProfile', '-Command', 'Set-Clipboard -Value ([Console]::In.ReadToEnd())'], text)) {
      return 'powershell';
    }
    return null;
  }
  if (p === 'darwin') {
    return runClip('pbcopy', [], text) ? 'pbcopy' : null;
  }
  if (runClip('wl-copy', [], text)) return 'wl-copy';
  if (runClip('xclip', ['-selection', 'clipboard'], text)) return 'xclip';
  if (runClip('xsel', ['--clipboard', '--input'], text)) return 'xsel';
  return null;
}

export function copyToClipboard(text, { clearAfterMs = 0, stdout = process.stdout } = {}) {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }

  const value = String(text ?? '');
  const native = writePlatformClipboard(value);
  let method = native;

  // Use OSC 52 over SSH/tmux or as fallback
  if (!native || process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.TMUX) {
    if (stdout && typeof stdout.write === 'function' && stdout.isTTY) {
      const b64 = Buffer.from(value, 'utf8').toString('base64');
      stdout.write(`\x1b]52;c;${b64}\x07`);
      method = native ? `${native}+osc52` : 'osc52';
    }
  }

  if (clearAfterMs > 0 && value !== '') {
    clearTimer = setTimeout(() => {
      clearTimer = null;
      writePlatformClipboard('');
      if (stdout && typeof stdout.write === 'function' && stdout.isTTY && (process.env.SSH_CONNECTION || process.env.SSH_TTY || !native)) {
        stdout.write('\x1b]52;c;\x07');
      }
    }, clearAfterMs);
    clearTimer.unref?.();
  }

  return { ok: !!method, method: method || 'none' };
}
