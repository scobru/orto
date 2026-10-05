/**
 * ZenOS Client SDK — Autonomous Agent & Application Interface
 * Connects sovereign cryptographic identities with ZenVault and smollog.
 */

// Universal ZEN loader:
// 1. Self-contained bundle in same directory (./zen.min.js)
// 2. Sibling repo (../zen/zen.min.js)
// 3. Browser / CDN fallback
import { deriveMasterPair } from './identity.js';

/**
 * Node has no localStorage, so ZEN keeps its graph cache in memory: every run re-downloads and
 * re-verifies (signature check, ~12ms each) the whole graph, which blocks the event loop for minutes
 * on a few thousand bookmarks (the browser reads them from its persistent localStorage instead).
 * ZEN picks its cache up from `window.localStorage` at load time, so expose a file-backed one only
 * while the bundle is imported. Cache file: ZENOS_CACHE_FILE, default ~/.zenos/cache.json;
 * ZENOS_CACHE=off disables it. It holds the same (encrypted) records the relays hold.
 */
let nodeStorageData = {};
let nodeStorageFlush = null;

export function flushStorage() {
  if (nodeStorageFlush) nodeStorageFlush();
}

async function withNodeStorage(load) {
  const proc = globalThis.process;
  if (!proc?.versions?.node || globalThis.window || /^(0|off|false|no)$/i.test(proc.env.ZENOS_CACHE || '')) return load();
  const [{ default: fs }, { default: path }, { default: osmod }] = await Promise.all([import('node:fs'), import('node:path'), import('node:os')]);
  const file = proc.env.ZENOS_CACHE_FILE || path.join(osmod.homedir(), '.zenos', 'cache.json');
  try { nodeStorageData = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  let timer = null;
  nodeStorageFlush = () => {
    clearTimeout(timer); timer = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(nodeStorageData));
      fs.renameSync(file + '.tmp', file);
    } catch (_) {}
  };
  proc.on('exit', () => { if (timer) nodeStorageFlush(); });
  globalThis.window = {
    localStorage: {
      getItem: (k) => (k in nodeStorageData ? nodeStorageData[k] : null),
      removeItem: (k) => { delete nodeStorageData[k]; },
      setItem: (k, v) => { nodeStorageData[k] = String(v); timer = timer || setTimeout(nodeStorageFlush, 1000); }
    }
  };
  globalThis.localStorage = globalThis.window.localStorage;
  return await load();
}

let ZEN;
async function initZenModule() {
  // 1. Same directory bundle (self-contained)
  try {
    const localUrl = new URL('./zen.min.js', import.meta.url).href;
    const m = await withNodeStorage(() => import(localUrl));
    return m.default || m;
  } catch (_) {}

  // 2. Sibling repository (../zen/zen.min.js)
  try {
    const siblingUrl = new URL('../zen/zen.min.js', import.meta.url).href;
    const m = await withNodeStorage(() => import(siblingUrl));
    return m.default || m;
  } catch (_) {}

  // 3. CDN import (Browser / Deno)
  try {
    const m = await import('https://cdn.jsdelivr.net/gh/scobru/zen@main/zen.min.js');
    return m.default || m;
  } catch (err) {
    throw new Error('Failed to load ZEN library: ' + err.message);
  }
}

ZEN = await initZenModule();

/**
 * Default relays shipped with ZenOS.
 * - delay.scobrudot.dev → personal Delay (shogun-relay) instance run by the author (scobru).
 *   Community / best-effort: no SLA, no uptime or data-retention guarantees.
 * - zen.akao.io         → public relay of the upstream ZEN network.
 * For production or full sovereignty, run your own relay (see RELAYS.md).
 */
export const DEFAULT_RELAYS = [
  'wss://delay.scobrudot.dev/zen',
  'wss://zen.akao.io:8420/zen'
];

const env = (globalThis.process && globalThis.process.env) || {};

function toList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(',');
}

/**
 * Normalize a relay URL: trims it, adds `/zen` if no path is given.
 * Accepts ws://, wss://, http://, https://.
 */
export function normalizeRelay(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error('Invalid relay URL: ' + raw);
  }
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Unsupported relay protocol (use ws/wss/http/https): ' + raw);
  }
  if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = '/zen';
  return parsed.toString().replace(/\/$/, '');
}

/**
 * Build the final relay list.
 *
 * @param {object}   opts
 * @param {string[]|string} [opts.peers]       Replace the default list entirely.
 * @param {string[]|string} [opts.extraPeers]  Custom relays added on top of the base list.
 * @param {boolean}  [opts.useDefaultRelays]   Set false to drop DEFAULT_RELAYS (only custom ones).
 *
 * Env vars (Node only):
 *   ZENOS_RELAYS               comma-separated custom relays, always added
 *   ZENOS_ONLY_CUSTOM_RELAYS   "true" → do not use DEFAULT_RELAYS
 */
export function resolvePeers(opts = {}) {
  const onlyCustomEnv = ['1', 'true', 'yes'].includes(String(env.ZENOS_ONLY_CUSTOM_RELAYS || '').toLowerCase());
  const useDefaults = opts.useDefaultRelays !== undefined ? !!opts.useDefaultRelays : !onlyCustomEnv;

  const base = opts.peers ? toList(opts.peers) : (useDefaults ? DEFAULT_RELAYS : []);
  const all = [...base, ...toList(opts.extraPeers), ...toList(env.ZENOS_RELAYS)]
    .map(normalizeRelay)
    .filter(Boolean);

  const peers = [...new Set(all)];
  if (!peers.length) {
    throw new Error('No relays configured. Pass peers/extraPeers or set ZENOS_RELAYS.');
  }
  return peers;
}

/**
 * Parse a Netscape bookmarks export (Brave / Chrome / Firefox "Export bookmarks" HTML).
 * Returns [{ url, title, folder, addedAt, tags }]; folder is a "A/B" path, addedAt is ms.
 * Only http(s) URLs are kept (drops javascript:, chrome:, file: ...).
 */
export function parseBookmarksHtml(html) {
  const decode = (t) => t.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]).trim();
  const out = [];
  const stack = [];
  let pending = null;
  const re = /<A\b([^>]*)>([\s\S]*?)<\/A>|<H3\b[^>]*>([\s\S]*?)<\/H3>|<(\/?)DL\b[^>]*>/gi;
  for (let m; (m = re.exec(html));) {
    if (m[3] !== undefined) pending = decode(m[3]);
    else if (m[4] !== undefined) {
      if (m[4]) stack.pop();
      else { stack.push(pending); pending = null; }
    } else {
      const href = /\bHREF="([^"]*)"/i.exec(m[1]);
      const url = href && decode(href[1]);
      if (!url || !/^https?:\/\//i.test(url)) continue;
      const added = /\bADD_DATE="(\d+)"/i.exec(m[1]);
      const tags = /\bTAGS="([^"]*)"/i.exec(m[1]);
      out.push({ url, title: decode(m[2]) || url, folder: stack.filter(Boolean).join('/'), addedAt: added ? Number(added[1]) * 1000 : Date.now(), tags: tags ? decode(tags[1]).split(',').map(t => t.trim()).filter(Boolean) : [] });
    }
  }
  return out;
}

/**
 * Serialise bookmarks to a Netscape bookmarks HTML file that Brave, Chrome and Firefox can import
 * (the inverse of parseBookmarksHtml). Folders become nested <DL> blocks; tags go in a TAGS attribute.
 */
export function bookmarksToHtml(bookmarks) {
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const root = { dirs: new Map(), items: [] };
  for (const b of bookmarks) {
    let node = root;
    for (const part of (b.folder || '').split('/').filter(Boolean)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), items: [] });
      node = node.dirs.get(part);
    }
    node.items.push(b);
  }
  const block = (node, pad) => [
    ...[...node.dirs].sort(([a], [b]) => a.localeCompare(b)).flatMap(([name, d]) =>
      [`${pad}<DT><H3>${esc(name)}</H3>`, `${pad}<DL><p>`, ...block(d, pad + '    '), `${pad}</DL><p>`]),
    ...node.items.sort((a, b) => a.addedAt - b.addedAt).map(b =>
      `${pad}<DT><A HREF="${esc(b.url)}" ADD_DATE="${Math.floor((b.addedAt || Date.now()) / 1000)}"${(b.tags || []).length ? ` TAGS="${esc(b.tags.join(','))}"` : ''}>${esc(b.title || b.url)}</A>`)
  ];
  return ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', '<TITLE>Bookmarks</TITLE>', '<H1>Bookmarks</H1>', '<DL><p>', ...block(root, '    '), '</DL><p>', ''].join('\n');
}

// what an event or task can point at; the link lives inside the encrypted record, so there is one source of truth
const LINK_KINDS = ['note', 'bookmark', 'event', 'task'];

export async function bookmarkSoul(url) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return 'bm-' + [...new Uint8Array(h)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Identity used between the first unification and FID: smollog's PBKDF2 scheme. Kept only so
 * migrateLegacy() can find data written under it.
 */
export async function legacySmollogPair(username, password) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('scobru:zen:blog:' + username.trim().toLowerCase()), iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  const seed = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return ZEN.pair(null, { seed });
}

export function extractCipher(data) {
  if (data === undefined || data === null) return null;
  if (typeof data === 'object' && data[':'] !== undefined) return data[':'];
  if (typeof data === 'string') {
    if (data.startsWith('{')) {
      try {
        const p = JSON.parse(data);
        if (p && p[':'] !== undefined) return p[':'];
      } catch (_) {}
    }
    return data;
  }
  return data;
}

export function getGraphSnapshot(zen) {
  let cacheGraph = {};
  if (nodeStorageData && nodeStorageData['zen/']) {
    try { cacheGraph = JSON.parse(nodeStorageData['zen/']); } catch (_) {}
  } else if (globalThis.window?.localStorage) {
    try {
      const raw = globalThis.window.localStorage.getItem('zen/');
      if (raw) cacheGraph = JSON.parse(raw);
    } catch (_) {}
  }
  const memGraph = (zen && (zen._graphInstance?._?.graph || zen._?.graph)) || {};
  return { ...cacheGraph, ...memGraph };
}

export function isSoulDeleted(allGraph, parentSoul, soul) {
  const parentNode = allGraph[parentSoul];
  if (!parentNode) return false;
  const val = parentNode[soul];
  if (val === null) return true;
  if (typeof val === 'object' && val && val[':'] === null) return true;
  if (typeof val === 'string' && (val === 'null' || val.includes('":null'))) return true;
  return false;
}

export class ZenOS {
  constructor(options = {}) {
    this.peers = resolvePeers(options);
    this.zen = new ZEN({
      peers: this.peers,
      // ponytail: `localStorage:false` makes signed puts never ack in zen; only pass when set
      ...(options.localStorage !== undefined && { localStorage: options.localStorage }),
      ...(options.radisk !== undefined && { radisk: options.radisk }),
      axe: options.axe !== undefined ? options.axe : true
    });
    this.pair = null;
    this.username = null;
  }

  /**
   * Authenticate / derive keypair from username and password with the FID derivation
   * (identity.js: `alias:passphrase`), shared with FID, smollog and ZenVault.
   * Also keeps `legacyPairs`, the earlier identities (smollog PBKDF2, then plain `user + pass`),
   * for migrateLegacy().
   */
  async login(username, password) {
    if (!username || !password) {
      throw new Error('Username and password are required');
    }
    this.username = username.trim();
    this.pair = await deriveMasterPair(ZEN, this.username, password);
    this.legacyPairs = [
      await legacySmollogPair(this.username, password),
      await ZEN.pair(null, { seed: this.username + password.trim() })
    ];
    return this.pair;
  }

  /**
   * Copy encrypted data (vault, calendar, bookmarks) from each legacy identity to the current one,
   * re-encrypting with the new key. Idempotent: souls already present under the new pub are skipped.
   * @returns {Promise<{migrated:number, skipped:number, failed:number}>}
   */
  async migrateLegacy(timeoutMs = 5000) {
    if (!this.pair) throw new Error('Not authenticated.');
    const total = { migrated: 0, skipped: 0, failed: 0 };
    for (const legacyPair of this.legacyPairs) {
      const r = await this._migrateFrom(legacyPair, timeoutMs);
      for (const k of Object.keys(total)) total[k] += r[k];
    }
    return total;
  }

  async _migrateFrom(legacyPair, timeoutMs) {
    const { pair } = this;
    const readAll = (pub, path) => new Promise((resolve) => {
      const nodes = new Map();
      setTimeout(() => resolve(nodes), timeoutMs);
      const root = this.zen.get('~' + pub).get(path);
      root.map().once((node, soul) => {
        if (!soul) return;
        if (node && typeof node === 'object') nodes.set(soul, node);
        else root.get(soul).once((full) => full && nodes.set(soul, full));
      });
    });
    const enc = (v) => ZEN.encrypt(v, pair);
    const dec = (v) => ZEN.decrypt(v, legacyPair);
    const convert = {
      vault: async (n) => ({ title: await enc(await dec(n.title)), body: await enc(await dec(n.body)), cat: await enc(await dec(n.cat)), pinned: !!n.pinned, trash: !!n.trash, timestamp: n.timestamp, encrypted: true }),
      calendar: async (n) => ({ data: await enc(await dec(n.data)), updatedAt: n.updatedAt, encrypted: true }),
      bookmarks: async (n) => ({ data: await enc(await dec(n.data)), updatedAt: n.updatedAt, encrypted: true }),
      tasks: async (n) => ({ data: await enc(await dec(n.data)), updatedAt: n.updatedAt, encrypted: true })
    };
    const field = { vault: 'title', calendar: 'data', bookmarks: 'data', tasks: 'data' };

    const stats = { migrated: 0, skipped: 0, failed: 0 };
    for (const path of Object.keys(convert)) {
      const [old, cur] = await Promise.all([readAll(legacyPair.pub, path), readAll(pair.pub, path)]);
      for (const [soul, node] of old) {
        if (!node[field[path]]) continue;
        if (cur.has(soul)) { stats.skipped++; continue; }
        try {
          const payload = await convert[path](node);
          await new Promise((resolve, reject) => {
            this.zen.get('~' + pair.pub).get(path).get(soul).put(payload, (ack) => {
              if (nodeStorageFlush) nodeStorageFlush();
              if (ack && ack.err) reject(new Error(ack.err));
              else resolve();
            }, { authenticator: pair });
          });
          stats.migrated++;
        } catch (_) { stats.failed++; }
      }
    }
    return stats;
  }

  get pub() {
    return this.pair ? this.pair.pub : null;
  }

  get userRoot() {
    if (!this.pair) throw new Error('Not authenticated. Call login() first.');
    return this.zen.get('~' + this.pair.pub);
  }

  // ─── ZenVault (Encrypted Private Notes) ────────────────────────────

  /**
   * Write an encrypted note to the user's private vault.
   */
  async writeVaultNote({ title, body, cat = 'general', pinned = false, soul = null }) {
    if (!this.pair) throw new Error('Not authenticated.');

    const noteSoul = soul || ('vault-' + Date.now() + '-' + Math.random().toString(36).substring(7));
    const encTitle = await ZEN.encrypt(title, this.pair);
    const encBody = await ZEN.encrypt(body, this.pair);
    const encCat = await ZEN.encrypt(cat, this.pair);

    const payload = {
      title: encTitle,
      body: encBody,
      cat: encCat,
      pinned: !!pinned,
      trash: false,
      timestamp: Date.now(),
      encrypted: true
    };

    return new Promise((resolve, reject) => {
      this.userRoot.get('vault').get(noteSoul).put(payload, (ack) => {
        if (nodeStorageFlush) nodeStorageFlush();
        if (ack && ack.err) reject(new Error(ack.err));
        else resolve({ soul: noteSoul, status: 'saved', timestamp: payload.timestamp });
      }, { authenticator: this.pair });
    });
  }

  /**
   * Read and decrypt all notes from the user's private vault.
   */
  async readVaultNotes(timeoutMs = 5000) {
    if (!this.pair) throw new Error('Not authenticated.');

    const notes = new Map();
    const prefix = '~' + this.pair.pub + '/vault/';
    const parentSoul = '~' + this.pair.pub + '/vault';

    const processNode = async (node, soul) => {
      if (!node || !soul) return;
      const isTrash = extractCipher(node.trash) === true || node.trash === true;
      if (isTrash) return;
      const titleRaw = extractCipher(node.title);
      if (!titleRaw) return;
      const bodyRaw = extractCipher(node.body);
      const catRaw = extractCipher(node.cat);
      const pinned = extractCipher(node.pinned) === true || node.pinned === true;
      try {
        const title = await ZEN.decrypt(titleRaw, this.pair);
        const body = bodyRaw ? await ZEN.decrypt(bodyRaw, this.pair) : '';
        const cat = catRaw ? await ZEN.decrypt(catRaw, this.pair) : '';
        notes.set(soul, {
          soul,
          title: title || '',
          body: body || '',
          cat: cat || '',
          pinned,
          timestamp: Number(extractCipher(node.timestamp) || node.timestamp) || Date.now()
        });
      } catch (_) {
        // ignore corrupted or un-decryptable records
      }
    };

    // 1. Gather nodes from snapshot (cache + memory)
    const allGraph = getGraphSnapshot(this.zen);
    const tasks = [];
    for (const k of Object.keys(allGraph)) {
      if (k.startsWith(prefix)) {
        const soul = k.slice(prefix.length);
        if (isSoulDeleted(allGraph, parentSoul, soul)) continue;
        tasks.push(processNode(allGraph[k], soul));
      }
    }
    await Promise.all(tasks);

    if (timeoutMs === 0) {
      return [...notes.values()].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.timestamp - a.timestamp);
    }

    // 2. Also listen for live updates from Gun
    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(maxTimer);
        clearTimeout(settleTimer);
        resolve([...notes.values()].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.timestamp - a.timestamp));
      };

      const maxTimer = setTimeout(done, timeoutMs);
      let settleTimer = setTimeout(done, notes.size > 0 ? Math.min(350, timeoutMs) : timeoutMs);

      const kickSettle = () => {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(done, Math.min(300, timeoutMs));
      };

      try {
        this.userRoot.get('vault').map().on(async (node, soul) => {
          if (!soul) return;
          if (node === null) {
            notes.delete(soul);
            kickSettle();
            return;
          }
          if (node && node.title) {
            await processNode(node, soul);
            if (nodeStorageFlush) nodeStorageFlush();
            kickSettle();
          } else {
            this.userRoot.get('vault').get(soul).once(async (full) => {
              if (full && full.title) {
                await processNode(full, soul);
                if (nodeStorageFlush) nodeStorageFlush();
                kickSettle();
              }
            });
          }
        });
      } catch (_) {}
    });
  }

  /**
   * Read and decrypt one note by soul (null if missing, trash or not decryptable).
   */
  async getVaultNote(soul) {
    if (!this.pair) throw new Error('Not authenticated.');
    if (!soul) throw new Error('Note soul is required.');

    const allGraph = getGraphSnapshot(this.zen);
    const parentSoul = '~' + this.pair.pub + '/vault';
    if (isSoulDeleted(allGraph, parentSoul, soul)) return null;

    const cachedNode = allGraph['~' + this.pair.pub + '/vault/' + soul];
    if (cachedNode && cachedNode.title) {
      const isTrash = extractCipher(cachedNode.trash) === true || cachedNode.trash === true;
      if (!isTrash) {
        try {
          const titleRaw = extractCipher(cachedNode.title);
          const bodyRaw = extractCipher(cachedNode.body);
          const catRaw = extractCipher(cachedNode.cat);
          const title = await ZEN.decrypt(titleRaw, this.pair);
          const body = bodyRaw ? await ZEN.decrypt(bodyRaw, this.pair) : '';
          const cat = catRaw ? await ZEN.decrypt(catRaw, this.pair) : '';
          const pinned = extractCipher(cachedNode.pinned) === true || cachedNode.pinned === true;
          return {
            soul,
            title: title || '',
            body: body || '',
            cat: cat || '',
            pinned,
            timestamp: Number(extractCipher(cachedNode.timestamp) || cachedNode.timestamp) || Date.now()
          };
        } catch (_) {}
      }
    }

    const node = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 3000);
      this.userRoot.get('vault').get(soul).once((n) => { clearTimeout(t); resolve(n); });
    });
    if (!node || !node.title) return null;
    const isTrash = extractCipher(node.trash) === true || node.trash === true;
    if (isTrash) return null;
    try {
      const titleRaw = extractCipher(node.title);
      const bodyRaw = extractCipher(node.body);
      const catRaw = extractCipher(node.cat);
      const title = await ZEN.decrypt(titleRaw, this.pair);
      const body = bodyRaw ? await ZEN.decrypt(bodyRaw, this.pair) : '';
      const cat = catRaw ? await ZEN.decrypt(catRaw, this.pair) : '';
      const pinned = extractCipher(node.pinned) === true || node.pinned === true;
      return {
        soul,
        title: title || '',
        body: body || '',
        cat: cat || '',
        pinned,
        timestamp: Number(extractCipher(node.timestamp) || node.timestamp) || Date.now()
      };
    } catch (_) { return null; }
  }

  /**
   * Delete a note from the vault.
   */
  async deleteVaultNote(soul) {
    if (!this.pair) throw new Error('Not authenticated.');
    return new Promise((resolve, reject) => {
      this.userRoot.get('vault').get(soul).put(null, (ack) => {
        if (nodeStorageFlush) nodeStorageFlush();
        if (ack && ack.err) reject(new Error(ack.err));
        else resolve({ soul, status: 'deleted' });
      }, { authenticator: this.pair });
    });
  }

  // ─── Calendar (Encrypted Events) ───────────────────────────────────

  /**
   * Write an encrypted calendar event to `~pub/calendar/<soul>`.
   * The whole event (title, start, end, ...) is one encrypted object;
   * only `updatedAt` and `encrypted` stay in clear. Pass `soul` to update.
   * @param {{title:string, start:number|string, end?:number|string, allDay?:boolean,
   *          notes?:string, location?:string, links?:{kind:'note'|'bookmark', soul:string}[], soul?:string}} event
   */
  async writeCalendarEvent({ soul = null, ...event }) {
    if (!this.pair) throw new Error('Not authenticated.');
    if (!event.title || event.start == null) throw new Error('title and start are required');

    const eventSoul = soul || ('cal-' + Date.now() + '-' + Math.random().toString(36).substring(7));
    const start = new Date(event.start).getTime();
    if (Number.isNaN(start)) throw new Error('Invalid start date');
    const end = event.end != null ? new Date(event.end).getTime() : start;
    if (event.links !== undefined && !(Array.isArray(event.links) && event.links.every(l => LINK_KINDS.includes(l?.kind) && typeof l.soul === 'string'))) {
      throw new Error('links must be [{ kind: "note"|"bookmark", soul }]');
    }
    const data = await ZEN.encrypt({ ...event, start, end }, this.pair);
    const payload = { data, updatedAt: Date.now(), encrypted: true };

    return new Promise((resolve, reject) => {
      this.userRoot.get('calendar').get(eventSoul).put(payload, (ack) => {
        if (nodeStorageFlush) nodeStorageFlush();
        if (ack && ack.err) reject(new Error(ack.err));
        else resolve({ soul: eventSoul, status: 'saved', updatedAt: payload.updatedAt });
      }, { authenticator: this.pair });
    });
  }

  /**
   * Read and decrypt one calendar event by soul (null if missing or not decryptable).
   */
  async getCalendarEvent(soul) {
    if (!this.pair) throw new Error('Not authenticated.');
    const allGraph = getGraphSnapshot(this.zen);
    const cachedNode = allGraph['~' + this.pair.pub + '/calendar/' + soul];
    if (cachedNode && cachedNode.data) {
      try {
        const rawData = extractCipher(cachedNode.data) || cachedNode.data;
        return { soul, ...(await ZEN.decrypt(rawData, this.pair)) };
      } catch (_) {}
    }
    const node = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 3000);
      this.userRoot.get('calendar').get(soul).once((n) => { clearTimeout(t); resolve(n); });
    });
    if (!node || !node.data) return null;
    try {
      const rawData = extractCipher(node.data) || node.data;
      return { soul, ...(await ZEN.decrypt(rawData, this.pair)) };
    } catch (_) { return null; }
  }

  /**
   * Link a vault note (or bookmark) to a calendar event. The link is stored inside the encrypted event,
   * so nothing changes on the note and there is nothing to keep in sync. Idempotent.
   * @param {string} eventSoul
   * @param {{kind?:'note'|'bookmark', soul:string}} target
   */
  async linkToEvent(eventSoul, { kind = 'note', soul }) {
    const ev = await this.getCalendarEvent(eventSoul);
    if (!ev) throw new Error('Event not found: ' + eventSoul);
    const links = ev.links || [];
    if (!links.some(l => l.kind === kind && l.soul === soul)) links.push({ kind, soul });
    return this.writeCalendarEvent({ ...ev, soul: eventSoul, links });
  }

  /**
   * Remove a link created by linkToEvent.
   */
  async unlinkFromEvent(eventSoul, { kind = 'note', soul }) {
    const ev = await this.getCalendarEvent(eventSoul);
    if (!ev) throw new Error('Event not found: ' + eventSoul);
    return this.writeCalendarEvent({ ...ev, soul: eventSoul, links: (ev.links || []).filter(l => !(l.kind === kind && l.soul === soul)) });
  }

  /**
   * Events that link to a given note (or bookmark), soonest first.
   */
  async eventsFor({ kind = 'note', soul }, timeoutMs = 5000) {
    const events = await this.readCalendarEvents({ timeoutMs });
    return events.filter(e => (e.links || []).some(l => l.kind === kind && l.soul === soul));
  }

  /**
   * Notes linked to an event, decrypted. Links to notes that no longer exist are skipped.
   */
  async notesForEvent(eventSoul, timeoutMs = 5000) {
    const ev = await this.getCalendarEvent(eventSoul);
    if (!ev) throw new Error('Event not found: ' + eventSoul);
    const wanted = new Set((ev.links || []).filter(l => l.kind === 'note').map(l => l.soul));
    return (await this.readVaultNotes(timeoutMs)).filter(n => wanted.has(n.soul));
  }

  /**
   * Read and decrypt calendar events, optionally within [from, to] (ms or date string).
   * Filtering happens after decryption, since times are encrypted.
   */
  async readCalendarEvents({ from = null, to = null, timeoutMs = 5000 } = {}) {
    if (!this.pair) throw new Error('Not authenticated.');
    const lo = from != null ? new Date(from).getTime() : -Infinity;
    const hi = to != null ? new Date(to).getTime() : Infinity;

    const events = new Map();
    const prefix = '~' + this.pair.pub + '/calendar/';
    const parentSoul = '~' + this.pair.pub + '/calendar';

    const processNode = async (node, soul) => {
      if (!node || !soul) return;
      const rawData = extractCipher(node.data) || (typeof node.data === 'string' ? node.data : null);
      if (!rawData) return;
      try {
        const ev = await ZEN.decrypt(rawData, this.pair);
        if (ev && typeof ev === 'object' && (ev.end >= lo && ev.start <= hi)) {
          events.set(soul, { soul, ...ev, updatedAt: node.updatedAt || Date.now() });
        }
      } catch (_) {}
    };

    // 1. Snapshot
    const allGraph = getGraphSnapshot(this.zen);
    const tasks = [];
    for (const k of Object.keys(allGraph)) {
      if (k.startsWith(prefix)) {
        const soul = k.slice(prefix.length);
        if (isSoulDeleted(allGraph, parentSoul, soul)) continue;
        tasks.push(processNode(allGraph[k], soul));
      }
    }
    await Promise.all(tasks);

    if (timeoutMs === 0) {
      return [...events.values()].sort((a, b) => a.start - b.start);
    }

    // 2. Live updates
    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(maxTimer);
        clearTimeout(settleTimer);
        resolve([...events.values()].sort((a, b) => a.start - b.start));
      };

      const maxTimer = setTimeout(done, timeoutMs);
      let settleTimer = setTimeout(done, events.size > 0 ? Math.min(350, timeoutMs) : timeoutMs);

      const kickSettle = () => {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(done, Math.min(300, timeoutMs));
      };

      try {
        this.userRoot.get('calendar').map().on(async (node, soul) => {
          if (!soul) return;
          if (node === null) {
            events.delete(soul);
            kickSettle();
            return;
          }
          if (node && node.data) {
            await processNode(node, soul);
            if (nodeStorageFlush) nodeStorageFlush();
            kickSettle();
          } else {
            this.userRoot.get('calendar').get(soul).once(async (full) => {
              if (full && full.data) {
                await processNode(full, soul);
                if (nodeStorageFlush) nodeStorageFlush();
                kickSettle();
              }
            });
          }
        });
      } catch (_) {}
    });
  }

  /**
   * Delete a calendar event.
   */
  async deleteCalendarEvent(soul) {
    if (!this.pair) throw new Error('Not authenticated.');
    return new Promise((resolve, reject) => {
      this.userRoot.get('calendar').get(soul).put(null, (ack) => {
        if (nodeStorageFlush) nodeStorageFlush();
        if (ack && ack.err) reject(new Error(ack.err));
        else resolve({ soul, status: 'deleted' });
      }, { authenticator: this.pair });
    });
  }

  // ─── Bookmarks (Encrypted) ──────────────────────────────────────────

  /**
   * Save an encrypted bookmark at `~pub/bookmarks/<soul>`. The soul is derived from the URL,
   * so saving or importing the same URL twice updates one record instead of duplicating it.
   * @param {{url:string, title?:string, folder?:string, tags?:string[], addedAt?:number}} bm
   */
  async writeBookmark({ url, title = '', folder = '', tags = [], addedAt = Date.now() }) {
    if (!this.pair) throw new Error('Not authenticated.');
    if (!/^https?:\/\//i.test(url || '')) throw new Error('url must be http(s)');
    const soul = await bookmarkSoul(url);
    const data = await ZEN.encrypt({ url, title: title || url, folder, tags, addedAt }, this.pair);
    return new Promise((resolve, reject) => {
      this.userRoot.get('bookmarks').get(soul).put({ data, updatedAt: Date.now(), encrypted: true }, (ack) => {
        if (nodeStorageFlush) nodeStorageFlush();
        if (ack && ack.err) reject(new Error(ack.err));
        else resolve({ soul, status: 'saved' });
      }, { authenticator: this.pair });
    });
  }

  /**
   * Import a browser bookmarks export (Brave/Chrome/Firefox HTML). Returns { imported, failed }.
   */
  async importBookmarksHtml(html) {
    const items = parseBookmarksHtml(html);
    const results = await Promise.allSettled(items.map(b => this.writeBookmark(b)));
    return { imported: results.filter(r => r.status === 'fulfilled').length, failed: results.filter(r => r.status === 'rejected').length };
  }

  /**
   * Read and decrypt all bookmarks, optionally filtered by folder prefix or text query.
   */
  async readBookmarks({ folder = null, query = null, timeoutMs = 5000 } = {}) {
    if (!this.pair) throw new Error('Not authenticated.');
    const q = query ? query.toLowerCase() : null;
    const marks = new Map();
    const prefix = '~' + this.pair.pub + '/bookmarks/';
    const parentSoul = '~' + this.pair.pub + '/bookmarks';

    const processNode = async (node, soul) => {
      if (!node || !soul) return;
      const rawData = extractCipher(node.data) || (typeof node.data === 'string' ? node.data : null);
      if (!rawData) return;
      try {
        const bm = await ZEN.decrypt(rawData, this.pair);
        if (!bm || !bm.url) return;
        if (folder && !(bm.folder === folder || bm.folder.startsWith(folder + '/'))) return;
        if (q && !(bm.title + ' ' + bm.url).toLowerCase().includes(q)) return;
        marks.set(soul, { soul, ...bm });
      } catch (_) {}
    };

    // 1. Gather nodes from snapshot
    const allGraph = getGraphSnapshot(this.zen);
    const tasks = [];
    for (const k of Object.keys(allGraph)) {
      if (k.startsWith(prefix)) {
        const soul = k.slice(prefix.length);
        if (isSoulDeleted(allGraph, parentSoul, soul)) continue;
        tasks.push(processNode(allGraph[k], soul));
      }
    }
    await Promise.all(tasks);

    if (timeoutMs === 0) {
      return [...marks.values()].sort((a, b) => b.addedAt - a.addedAt);
    }

    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(maxTimer);
        clearTimeout(settleTimer);
        resolve([...marks.values()].sort((a, b) => b.addedAt - a.addedAt));
      };

      const maxTimer = setTimeout(done, timeoutMs);
      let settleTimer = setTimeout(done, marks.size > 0 ? Math.min(350, timeoutMs) : timeoutMs);

      const kickSettle = () => {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(done, Math.min(300, timeoutMs));
      };

      try {
        this.userRoot.get('bookmarks').map().on(async (node, soul) => {
          if (!soul) return;
          if (node === null) {
            marks.delete(soul);
            kickSettle();
            return;
          }
          if (node && node.data) {
            await processNode(node, soul);
            if (nodeStorageFlush) nodeStorageFlush();
            kickSettle();
          } else {
            this.userRoot.get('bookmarks').get(soul).once(async (full) => {
              if (full && full.data) {
                await processNode(full, soul);
                if (nodeStorageFlush) nodeStorageFlush();
                kickSettle();
              }
            });
          }
        });
      } catch (_) {}
    });
  }

  /**
   * Apply many edits at once, e.g. after an agent decided how to reorganise.
   * Each change is `{ soul, title?, folder?, tags? }`; omitted fields and `url`/`addedAt` are kept.
   * Reads the bookmarks once, then rewrites only the changed ones (50 at a time).
   * @returns {Promise<{updated:number, missing:string[], failed:number}>}
   */
  async updateBookmarks(changes, timeoutMs = 5000) {
    if (!this.pair) throw new Error('Not authenticated.');
    const bySoul = new Map((await this.readBookmarks({ timeoutMs })).map(b => [b.soul, b]));
    const missing = [], jobs = [];
    for (const { soul, ...patch } of changes) {
      const cur = bySoul.get(soul);
      if (!cur) { missing.push(soul); continue; }
      const { title = cur.title, folder = cur.folder, tags = cur.tags } = patch;
      jobs.push({ ...cur, title, folder, tags });
    }
    let updated = 0, failed = 0;
    for (let i = 0; i < jobs.length; i += 50) {
      const res = await Promise.allSettled(jobs.slice(i, i + 50).map(({ soul, ...bm }) => this.writeBookmark(bm)));
      updated += res.filter(r => r.status === 'fulfilled').length;
      failed += res.filter(r => r.status === 'rejected').length;
    }
    return { updated, missing, failed };
  }

  /**
   * Convenience: update one bookmark by soul.
   */
  async updateBookmark(soul, patch) {
    const r = await this.updateBookmarks([{ soul, ...patch }]);
    if (r.missing.length) throw new Error('Bookmark not found: ' + soul);
    if (r.failed) throw new Error('Update failed');
    return { soul, status: 'updated' };
  }

  /**
   * Export all bookmarks (optionally one folder) as a Netscape HTML string, importable by browsers.
   */
  async exportBookmarksHtml({ folder = null, timeoutMs = 5000 } = {}) {
    return bookmarksToHtml(await this.readBookmarks({ folder, timeoutMs }));
  }

  /**
   * Read and decrypt one bookmark by soul (null if missing or not decryptable).
   */
  async getBookmark(soul) {
    if (!this.pair) throw new Error('Not authenticated.');
    if (!soul) throw new Error('Bookmark soul is required.');

    const allGraph = getGraphSnapshot(this.zen);
    const parentSoul = '~' + this.pair.pub + '/bookmarks';
    if (isSoulDeleted(allGraph, parentSoul, soul)) return null;

    const cachedNode = allGraph['~' + this.pair.pub + '/bookmarks/' + soul];
    if (cachedNode && cachedNode.data) {
      try {
        const rawData = extractCipher(cachedNode.data) || cachedNode.data;
        const bm = await ZEN.decrypt(rawData, this.pair);
        if (bm && bm.url) return { soul, ...bm };
      } catch (_) {}
    }

    const node = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 3000);
      this.userRoot.get('bookmarks').get(soul).once((n) => { clearTimeout(t); resolve(n); });
    });
    if (!node || !node.data) return null;
    try {
      const rawData = extractCipher(node.data) || node.data;
      const bm = await ZEN.decrypt(rawData, this.pair);
      if (bm && bm.url) return { soul, ...bm };
    } catch (_) {}
    return null;
  }

  /**
   * Delete a bookmark by soul.
   */
  async deleteBookmark(soul) {
    if (!this.pair) throw new Error('Not authenticated.');
    return new Promise((resolve, reject) => {
      this.userRoot.get('bookmarks').get(soul).put(null, (ack) => {
        if (nodeStorageFlush) nodeStorageFlush();
        if (ack && ack.err) reject(new Error(ack.err));
        else resolve({ soul, status: 'deleted' });
      }, { authenticator: this.pair });
    });
  }

  // ─── Tasks & Kanban (Encrypted) ─────────────────────────────────────

  /**
   * Write an encrypted task to `~pub/tasks/<soul>`.
   * The whole task is encrypted with AES-GCM; only `updatedAt` and `encrypted` stay in clear.
   *
   * @param {object} task
   * @param {string} task.title
   * @param {'todo'|'in_progress'|'done'|'blocked'|string} [task.status='todo']
   * @param {'low'|'medium'|'high'|'urgent'|string} [task.priority='medium']
   * @param {string} [task.desc='']
   * @param {number|string|null} [task.dueDate=null]
   * @param {string[]|string} [task.tags=[]]
   * @param {string} [task.assignee='']
   * @param {string} [task.column='']
   * @param {Array<{kind:'note'|'bookmark'|'event'|'task', soul:string}>} [task.links=[]]
   * @param {number|null} [task.completedAt=null]
   * @param {number} [task.createdAt]
   * @param {string} [task.soul=null]
   */
  async writeTask({ soul = null, ...task }) {
    if (!this.pair) throw new Error('Not authenticated.');
    if (!task.title) throw new Error('title is required');

    const taskSoul = soul || ('task-' + Date.now() + '-' + Math.random().toString(36).substring(7));
    const status = task.status || 'todo';
    const priority = task.priority || 'medium';
    const desc = task.desc || task.description || '';
    const assignee = task.assignee || '';
    const column = task.column || status;

    let dueDate = null;
    if (task.dueDate != null && task.dueDate !== '') {
      dueDate = new Date(task.dueDate).getTime();
      if (Number.isNaN(dueDate)) throw new Error('Invalid dueDate');
    }

    const tagList = Array.isArray(task.tags)
      ? task.tags
      : String(task.tags || '').split(',').map(t => t.trim()).filter(Boolean);

    if (task.links !== undefined && !(Array.isArray(task.links) && task.links.every(l => LINK_KINDS.includes(l?.kind) && typeof l.soul === 'string'))) {
      throw new Error(`links must be [{ kind: "${LINK_KINDS.join('|')}", soul }]`);
    }

    const now = Date.now();
    const createdAt = task.createdAt != null ? Number(task.createdAt) : now;
    let completedAt = task.completedAt !== undefined ? task.completedAt : null;
    if (status === 'done' && !completedAt) {
      completedAt = now;
    } else if (status !== 'done' && task.completedAt === undefined) {
      completedAt = null;
    }

    const payloadObj = {
      title: task.title.trim(),
      status,
      priority,
      desc,
      dueDate,
      tags: tagList,
      assignee,
      column,
      links: task.links || [],
      createdAt,
      completedAt
    };

    const data = await ZEN.encrypt(payloadObj, this.pair);
    const payload = { data, updatedAt: now, encrypted: true };

    return new Promise((resolve, reject) => {
      this.userRoot.get('tasks').get(taskSoul).put(payload, (ack) => {
        if (nodeStorageFlush) nodeStorageFlush();
        if (ack && ack.err) reject(new Error(ack.err));
        else resolve({ soul: taskSoul, status: 'saved', updatedAt: payload.updatedAt });
      }, { authenticator: this.pair });
    });
  }

  /**
   * Read and decrypt one task by soul (null if missing or not decryptable).
   */
  async getTask(soul) {
    if (!this.pair) throw new Error('Not authenticated.');
    if (!soul) throw new Error('Task soul is required.');

    const allGraph = getGraphSnapshot(this.zen);
    const parentSoul = '~' + this.pair.pub + '/tasks';
    if (isSoulDeleted(allGraph, parentSoul, soul)) return null;

    const cachedNode = allGraph['~' + this.pair.pub + '/tasks/' + soul];
    if (cachedNode && cachedNode.data) {
      try {
        const rawData = extractCipher(cachedNode.data) || cachedNode.data;
        const decrypted = await ZEN.decrypt(rawData, this.pair);
        if (decrypted && decrypted.title) {
          return { soul, ...decrypted, updatedAt: cachedNode.updatedAt || Date.now() };
        }
      } catch (_) {}
    }

    const node = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 3000);
      this.userRoot.get('tasks').get(soul).once((n) => { clearTimeout(t); resolve(n); });
    });
    if (!node || !node.data) return null;
    try {
      const rawData = extractCipher(node.data) || node.data;
      const decrypted = await ZEN.decrypt(rawData, this.pair);
      if (decrypted && decrypted.title) {
        return { soul, ...decrypted, updatedAt: node.updatedAt || Date.now() };
      }
    } catch (_) {}
    return null;
  }

  /**
   * Update one task by soul (merges patch with current task data).
   */
  async updateTask(soul, patch) {
    if (!soul) throw new Error('Task soul is required.');
    const cur = await this.getTask(soul);
    if (!cur) throw new Error('Task not found: ' + soul);
    const updated = { ...cur, ...patch, soul };
    return this.writeTask(updated);
  }

  /**
   * Read and decrypt tasks, optionally filtered by status, priority, tag or query.
   */
  async readTasks({ status = null, priority = null, tag = null, query = null, timeoutMs = 5000 } = {}) {
    if (!this.pair) throw new Error('Not authenticated.');
    const q = query ? query.toLowerCase() : null;
    const s = status ? status.toLowerCase() : null;
    const p = priority ? priority.toLowerCase() : null;
    const t = tag ? tag.toLowerCase() : null;

    const tasks = new Map();
    const prefix = '~' + this.pair.pub + '/tasks/';
    const parentSoul = '~' + this.pair.pub + '/tasks';

    const processNode = async (node, soul) => {
      if (!node || !soul) return;
      const rawData = extractCipher(node.data) || (typeof node.data === 'string' ? node.data : null);
      if (!rawData) return;
      try {
        const tsk = await ZEN.decrypt(rawData, this.pair);
        if (!tsk || !tsk.title) return;
        if (s && (tsk.status || '').toLowerCase() !== s) return;
        if (p && (tsk.priority || '').toLowerCase() !== p) return;
        if (t && !(tsk.tags || []).some(x => x.toLowerCase() === t)) return;
        if (q && !(tsk.title + ' ' + (tsk.desc || '') + ' ' + (tsk.assignee || '')).toLowerCase().includes(q)) return;
        tasks.set(soul, { soul, ...tsk, updatedAt: node.updatedAt || Date.now() });
      } catch (_) {}
    };

    // 1. Gather nodes from snapshot
    const allGraph = getGraphSnapshot(this.zen);
    const snapTasks = [];
    for (const k of Object.keys(allGraph)) {
      if (k.startsWith(prefix)) {
        const soul = k.slice(prefix.length);
        if (isSoulDeleted(allGraph, parentSoul, soul)) continue;
        snapTasks.push(processNode(allGraph[k], soul));
      }
    }
    await Promise.all(snapTasks);

    const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };
    const sortTasks = (list) => list.sort((a, b) => {
      // Open tasks first, done tasks last
      const aDone = a.status === 'done' ? 1 : 0;
      const bDone = b.status === 'done' ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;

      // Priority sort
      const pa = PRIORITY_ORDER[a.priority?.toLowerCase()] ?? 2;
      const pb = PRIORITY_ORDER[b.priority?.toLowerCase()] ?? 2;
      if (pa !== pb) return pa - pb;

      // Due date sort (earlier due dates come first)
      if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate - b.dueDate;
      if (a.dueDate && !b.dueDate) return -1;
      if (!a.dueDate && b.dueDate) return 1;

      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    if (timeoutMs === 0) {
      return sortTasks([...tasks.values()]);
    }

    // 2. Live Gun listener
    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(maxTimer);
        clearTimeout(settleTimer);
        resolve(sortTasks([...tasks.values()]));
      };

      const maxTimer = setTimeout(done, timeoutMs);
      let settleTimer = setTimeout(done, tasks.size > 0 ? Math.min(350, timeoutMs) : timeoutMs);

      const kickSettle = () => {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(done, Math.min(300, timeoutMs));
      };

      try {
        this.userRoot.get('tasks').map().on(async (node, soul) => {
          if (!soul) return;
          if (node === null) {
            tasks.delete(soul);
            kickSettle();
            return;
          }
          if (node && node.data) {
            await processNode(node, soul);
            if (nodeStorageFlush) nodeStorageFlush();
            kickSettle();
          } else {
            this.userRoot.get('tasks').get(soul).once(async (full) => {
              if (full && full.data) {
                await processNode(full, soul);
                if (nodeStorageFlush) nodeStorageFlush();
                kickSettle();
              }
            });
          }
        });
      } catch (_) {}
    });
  }

  /**
   * Delete a task by soul.
   */
  async deleteTask(soul) {
    if (!this.pair) throw new Error('Not authenticated.');
    return new Promise((resolve, reject) => {
      this.userRoot.get('tasks').get(soul).put(null, (ack) => {
        if (nodeStorageFlush) nodeStorageFlush();
        if (ack && ack.err) reject(new Error(ack.err));
        else resolve({ soul, status: 'deleted' });
      }, { authenticator: this.pair });
    });
  }

  /**
   * Link a note, bookmark, event, or task to a task. Idempotent.
   * @param {string} taskSoul
   * @param {{kind?:'note'|'bookmark'|'event'|'task', soul:string}} target
   */
  async linkToTask(taskSoul, { kind = 'note', soul }) {
    const tsk = await this.getTask(taskSoul);
    if (!tsk) throw new Error('Task not found: ' + taskSoul);
    const links = tsk.links || [];
    if (!links.some(l => l.kind === kind && l.soul === soul)) links.push({ kind, soul });
    return this.writeTask({ ...tsk, soul: taskSoul, links });
  }

  /**
   * Remove a link from a task.
   */
  async unlinkFromTask(taskSoul, { kind = 'note', soul }) {
    const tsk = await this.getTask(taskSoul);
    if (!tsk) throw new Error('Task not found: ' + taskSoul);
    return this.writeTask({ ...tsk, soul: taskSoul, links: (tsk.links || []).filter(l => !(l.kind === kind && l.soul === soul)) });
  }

  /**
   * Tasks that link to a given note, bookmark, event, or task.
   */
  async tasksFor({ kind = 'note', soul }, timeoutMs = 5000) {
    const allTasks = await this.readTasks({ timeoutMs });
    return allTasks.filter(t => (t.links || []).some(l => l.kind === kind && l.soul === soul));
  }

  // ─── smollog (Public Verifiable Blog) ─────────────────────────────

  /**
   * Publish a public markdown blog post to smollog.
   */
  async publishBlogPost({ title, content, tags = [], id = null }) {
    if (!this.pair) throw new Error('Not authenticated.');

    const postId = id || ('post-' + Date.now());
    const tagList = Array.isArray(tags) ? tags : String(tags || '').split(',').map(t => t.trim()).filter(Boolean);

    const postPayload = {
      id: postId,
      title: title.trim(),
      content: content.trim(),
      tags: tagList.join(', '),
      authorAlias: this.username || '',
      authorPub: this.pair.pub,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deleted: false
    };

    return new Promise((resolve, reject) => {
      this.userRoot.get('posts').get(postId).put(postPayload, (ack) => {
        if (nodeStorageFlush) nodeStorageFlush();
        if (ack && ack.err) reject(new Error(ack.err));
        else resolve({ id: postId, status: 'published', authorPub: this.pair.pub });
      }, { authenticator: this.pair });
    });
  }

  /**
   * Read all blog posts for a given author public key.
   */
  async readBlogPosts(authorPub = null, timeoutMs = 4000) {
    const targetPub = authorPub || this.pub;
    if (!targetPub) throw new Error('Target public key required.');

    const posts = new Map();
    const prefix = '~' + targetPub + '/posts/';
    const parentSoul = '~' + targetPub + '/posts';

    const processPost = (post, id) => {
      if (!post) return;
      const isDeleted = extractCipher(post.deleted) === true || post.deleted === true;
      if (isDeleted) {
        if (id) posts.delete(id);
        return;
      }
      const postId = extractCipher(post.id) || post.id || id;
      if (!postId) return;
      const title = extractCipher(post.title) || '';
      const content = extractCipher(post.content) || '';
      const tagsRaw = extractCipher(post.tags);
      const tags = typeof tagsRaw === 'string' ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : (Array.isArray(tagsRaw) ? tagsRaw : []);
      const authorAlias = extractCipher(post.authorAlias) || null;

      posts.set(postId, {
        id: postId,
        title,
        content,
        tags,
        authorAlias,
        authorPub: targetPub,
        createdAt: Number(extractCipher(post.createdAt) || post.createdAt) || Date.now(),
        updatedAt: Number(extractCipher(post.updatedAt) || post.updatedAt) || Date.now()
      });
    };

    // 1. Snapshot
    const allGraph = getGraphSnapshot(this.zen);
    for (const k of Object.keys(allGraph)) {
      if (k.startsWith(prefix)) {
        const id = k.slice(prefix.length);
        if (isSoulDeleted(allGraph, parentSoul, id)) continue;
        processPost(allGraph[k], id);
      }
    }

    if (timeoutMs === 0) {
      return [...posts.values()].sort((a, b) => b.createdAt - a.createdAt);
    }

    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(maxTimer);
        clearTimeout(settleTimer);
        resolve([...posts.values()].sort((a, b) => b.createdAt - a.createdAt));
      };

      const maxTimer = setTimeout(done, timeoutMs);
      let settleTimer = setTimeout(done, posts.size > 0 ? Math.min(350, timeoutMs) : timeoutMs);

      const kickSettle = () => {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(done, Math.min(300, timeoutMs));
      };

      try {
        this.zen.get('~' + targetPub).get('posts').map().on((post, id) => {
          if (!id) return;
          if (post === null) {
            posts.delete(id);
            kickSettle();
            return;
          }
          if (post && (post.title || post.content)) {
            processPost(post, id);
            if (nodeStorageFlush) nodeStorageFlush();
            kickSettle();
          } else {
            this.zen.get('~' + targetPub).get('posts').get(id).once((full) => {
              if (full && (full.title || full.content)) {
                processPost(full, id);
                if (nodeStorageFlush) nodeStorageFlush();
                kickSettle();
              }
            });
          }
        });
      } catch (_) {}
    });
  }

  /**
   * Read one public blog post by id and author pub/pair.
   */
  async getBlogPost(id, authorPub = null) {
    if (!id) throw new Error('Post id is required.');
    const targetPub = authorPub || this.pub;
    if (!targetPub) throw new Error('Target public key required.');

    const allGraph = getGraphSnapshot(this.zen);
    const parentSoul = '~' + targetPub + '/posts';
    if (isSoulDeleted(allGraph, parentSoul, id)) return null;

    const cached = allGraph['~' + targetPub + '/posts/' + id];
    if (cached) {
      const isDeletedCached = extractCipher(cached.deleted) === true || cached.deleted === true;
      if (!isDeletedCached) {
        const title = extractCipher(cached.title) || '';
        const content = extractCipher(cached.content) || '';
        if (title || content) {
          const tagsRaw = extractCipher(cached.tags);
          const tags = typeof tagsRaw === 'string' ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : (Array.isArray(tagsRaw) ? tagsRaw : []);
          const authorAlias = extractCipher(cached.authorAlias) || null;
          return {
            id,
            title,
            content,
            tags,
            authorAlias,
            authorPub: targetPub,
            createdAt: Number(extractCipher(cached.createdAt) || cached.createdAt) || Date.now(),
            updatedAt: Number(extractCipher(cached.updatedAt) || cached.updatedAt) || Date.now()
          };
        }
      }
    }

    const post = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 3000);
      this.zen.get('~' + targetPub).get('posts').get(id).once((n) => { clearTimeout(t); resolve(n); });
    });
    if (!post) return null;
    const isDeleted = extractCipher(post.deleted) === true || post.deleted === true;
    if (isDeleted) return null;
    const title = extractCipher(post.title) || '';
    const content = extractCipher(post.content) || '';
    const tagsRaw = extractCipher(post.tags);
    const tags = typeof tagsRaw === 'string' ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : (Array.isArray(tagsRaw) ? tagsRaw : []);
    const authorAlias = extractCipher(post.authorAlias) || null;
    return {
      id,
      title,
      content,
      tags,
      authorAlias,
      authorPub: targetPub,
      createdAt: Number(extractCipher(post.createdAt) || post.createdAt) || Date.now(),
      updatedAt: Number(extractCipher(post.updatedAt) || post.updatedAt) || Date.now()
    };
  }

  /**
   * Delete a blog post (marks deleted: true and syncs).
   */
  async deleteBlogPost(id) {
    if (!this.pair) throw new Error('Not authenticated.');
    if (!id) throw new Error('Post id required.');

    return new Promise((resolve, reject) => {
      this.userRoot.get('posts').get(id).put({ deleted: true, updatedAt: Date.now() }, (ack) => {
        if (nodeStorageFlush) nodeStorageFlush();
        if (ack && ack.err) reject(new Error(ack.err));
        else resolve({ id, status: 'deleted', authorPub: this.pair.pub });
      }, { authenticator: this.pair });
    });
  }

  /**
   * Alias for publishBlogPost.
   */
  async writeBlogPost(post) {
    return this.publishBlogPost(post);
  }

  /**
   * Register a human-friendly blog alias (e.g. smollog.vercel.app/scobru).
   */
  async registerAlias(alias = null) {
    if (!this.pair) throw new Error('Not authenticated.');
    const targetAlias = (alias || this.username).trim().toLowerCase();

    return new Promise((resolve) => {
      this.userRoot.get('alias').put(targetAlias, null, { authenticator: this.pair });
      this.zen.get('smollog_aliases').get(targetAlias).put(this.pair.pub, () => {
        if (nodeStorageFlush) nodeStorageFlush();
        resolve({ alias: targetAlias, pub: this.pair.pub });
      });
    });
  }

  /**
   * Resolve a human-friendly blog alias to a public key.
   */
  async resolveAlias(alias) {
    if (!alias) throw new Error('Alias is required.');
    const aliasKey = alias.trim().toLowerCase();
    const allGraph = getGraphSnapshot(this.zen);
    const cachedAlias = allGraph['smollog_aliases']?.[aliasKey];
    if (cachedAlias) {
      const val = typeof cachedAlias === 'string' ? cachedAlias : (cachedAlias?.[':'] || null);
      if (val) return val;
    }
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 3000);
      this.zen.get('smollog_aliases').get(aliasKey).once((found) => {
        clearTimeout(t);
        resolve(found || null);
      });
    });
  }
}

export default ZenOS;
