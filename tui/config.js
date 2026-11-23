import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SERVER, normalizeServer } from '../orto.js';
import { DEFAULT_FREENET_NODE, normalizeFreenetNode } from './freenet.js';

const DEFAULT_CONFIG = Object.freeze({
  mode: 'server',
  server: DEFAULT_SERVER,
  recentServers: [DEFAULT_SERVER],
  freenetNode: DEFAULT_FREENET_NODE,
  lastUser: '',
  theme: 'dark',
  ascii: false,
  mouse: true,
  editor: '',
  lockMinutes: 15
});

export function getConfigPath() {
  if (process.env.ORTO_CONFIG) {
    return path.resolve(process.env.ORTO_CONFIG);
  }
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Orto', 'tui.json');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Orto', 'tui.json');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'orto', 'tui.json');
}

function sanitizeConfig(raw) {
  const out = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== 'object') return out;
  if (raw.mode === 'server' || raw.mode === 'freenet') out.mode = raw.mode;
  if (typeof raw.server === 'string' && raw.server.trim()) {
    try { out.server = normalizeServer(raw.server); } catch (_) {}
  }
  if (typeof raw.freenetNode === 'string' && raw.freenetNode.trim()) {
    try { out.freenetNode = normalizeFreenetNode(raw.freenetNode); } catch (_) {}
  }
  if (Array.isArray(raw.recentServers)) {
    const seen = new Set();
    const list = [];
    for (const s of raw.recentServers) {
      if (typeof s !== 'string' || !s.trim()) continue;
      try {
        const norm = normalizeServer(s);
        if (!seen.has(norm)) { seen.add(norm); list.push(norm); }
      } catch (_) {}
    }
    if (list.length) out.recentServers = list.slice(0, 8);
  }
  if (typeof raw.lastUser === 'string') out.lastUser = raw.lastUser.trim().slice(0, 64);
  if (raw.theme === 'light' || raw.theme === 'dark') out.theme = raw.theme;
  if (typeof raw.ascii === 'boolean') out.ascii = raw.ascii;
  if (typeof raw.mouse === 'boolean') out.mouse = raw.mouse;
  if (typeof raw.editor === 'string') out.editor = raw.editor.trim();
  if (typeof raw.lockMinutes === 'number' && Number.isFinite(raw.lockMinutes) && raw.lockMinutes >= 0) {
    out.lockMinutes = Math.min(240, Math.floor(raw.lockMinutes));
  }
  return out;
}

export function loadConfig() {
  const file = getConfigPath();
  try {
    if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG, recentServers: [...DEFAULT_CONFIG.recentServers] };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return sanitizeConfig(parsed);
  } catch (_) {
    return { ...DEFAULT_CONFIG, recentServers: [...DEFAULT_CONFIG.recentServers] };
  }
}

export function saveConfig(patch = {}) {
  const file = getConfigPath();
  const current = loadConfig();
  // Never store credentials even if accidentally passed in patch
  const cleanPatch = { ...patch };
  delete cleanPatch.pass;
  delete cleanPatch.password;
  delete cleanPatch.token;
  delete cleanPatch.key;
  const next = sanitizeConfig({ ...current, ...cleanPatch });
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dir, 0o700); } catch (_) {}
  }
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch (_) {}
  }
  return next;
}

export function recordRecentServer(url, username = '', extra = {}) {
  const current = loadConfig();
  let norm = current.server;
  if (url) {
    try { norm = normalizeServer(url); } catch (_) {}
  }
  const recentServers = [norm, ...current.recentServers.filter((s) => s !== norm)].slice(0, 8);
  return saveConfig({
    server: norm,
    recentServers,
    ...(username ? { lastUser: String(username).trim() } : {}),
    ...extra
  });
}
