import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function serializeNoteDoc(note = {}) {
  const lines = [
    '---',
    `title: ${String(note.title || '').replace(/\r?\n/g, ' ')}`,
    `cat: ${String(note.cat || 'general').replace(/\r?\n/g, ' ')}`,
    `pinned: ${note.pinned ? 'true' : 'false'}`,
    `projectId: ${String(note.projectId || '').replace(/\r?\n/g, ' ')}`,
    '---',
    '',
    String(note.body ?? '')
  ];
  return lines.join('\n');
}

export function parseNoteDoc(raw, fallback = {}) {
  const text = String(raw ?? '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---(?:\n\n?|\n|$)([\s\S]*)$/.exec(text);
  if (!m) {
    return {
      title: fallback.title || 'Untitled',
      cat: fallback.cat || 'general',
      pinned: !!fallback.pinned,
      projectId: fallback.projectId || '',
      body: text
    };
  }
  const meta = {
    title: fallback.title || '',
    cat: fallback.cat || 'general',
    pinned: !!fallback.pinned,
    projectId: fallback.projectId || ''
  };
  for (const line of m[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const k = line.slice(0, colon).trim();
    const v = line.slice(colon + 1).trim();
    if (k === 'title') meta.title = v;
    else if (k === 'cat') meta.cat = v || 'general';
    else if (k === 'pinned') meta.pinned = v === 'true' || v === 'yes' || v === '1';
    else if (k === 'projectId') meta.projectId = v;
  }
  if (!meta.title) meta.title = fallback.title || 'Untitled';
  return { ...meta, body: m[2] };
}

export function splitCommand(cmdStr) {
  const tokens = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmdStr.length; i++) {
    const c = cmdStr[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += c;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

export function resolveEditor(preferred = '') {
  const raw = String(preferred || process.env.ORTO_EDITOR || process.env.VISUAL || process.env.EDITOR || '').trim();
  if (raw) return raw;
  return process.platform === 'win32' ? 'notepad' : 'vi';
}

export function openInEditor(initialText, { ext = '.md', editorCmd = '', suspend, resume } = {}) {
  const cmd = resolveEditor(editorCmd);
  const parts = splitCommand(cmd);
  if (!parts.length) throw new Error('No editor configured.');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orto-edit-'));
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dir, 0o700); } catch (_) {}
  }
  const safeExt = ext.startsWith('.') ? ext : `.${ext}`;
  const filePath = path.join(dir, `doc${safeExt}`);
  const initial = String(initialText ?? '');

  suspend?.();
  try {
    fs.writeFileSync(filePath, initial, { encoding: 'utf8', mode: 0o600 });
    const [bin, ...args] = parts;
    const res = spawnSync(bin, [...args, filePath], {
      stdio: 'inherit',
      shell: false
    });
    if (res.error) throw res.error;
    const nextText = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
    const normInitial = initial.replace(/\r\n/g, '\n');
    return {
      text: nextText,
      changed: nextText !== normInitial,
      status: res.status ?? 0
    };
  } finally {
    try {
      if (fs.existsSync(filePath)) {
        const size = fs.statSync(filePath).size;
        if (size > 0) fs.writeFileSync(filePath, Buffer.alloc(size, 0));
        fs.unlinkSync(filePath);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
    resume?.();
  }
}
