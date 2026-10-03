/**
 * ZenOS Client SDK — Autonomous Agent & Application Interface
 * Connects sovereign cryptographic identities with ZenVault and smollog.
 */

// Universal ZEN loader:
// 1. Self-contained bundle in same directory (./zen.min.js)
// 2. Sibling repo (../zen/zen.min.js)
// 3. Browser / CDN fallback
let ZEN;
async function initZenModule() {
  // 1. Same directory bundle (self-contained)
  try {
    const localUrl = new URL('./zen.min.js', import.meta.url).href;
    const m = await import(localUrl);
    return m.default || m;
  } catch (_) {}

  // 2. Sibling repository (../zen/zen.min.js)
  try {
    const siblingUrl = new URL('../zen/zen.min.js', import.meta.url).href;
    const m = await import(siblingUrl);
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
 * Returns [{ url, title, folder, addedAt }]; folder is a "A/B" path, addedAt is ms.
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
      out.push({ url, title: decode(m[2]) || url, folder: stack.filter(Boolean).join('/'), addedAt: added ? Number(added[1]) * 1000 : Date.now() });
    }
  }
  return out;
}

async function bookmarkSoul(url) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return 'bm-' + [...new Uint8Array(h)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive the ZenOS identity. Same scheme as smollog, so one login = one pub everywhere:
 * seed = hex(PBKDF2-SHA256(password, "scobru:zen:blog:" + lowercase(username), 100000, 256 bits)).
 */
export async function derivePair(username, password) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('scobru:zen:blog:' + username.trim().toLowerCase()), iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  const seed = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return ZEN.pair(null, { seed });
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
   * Authenticate / derive keypair from username and password (smollog-compatible, see derivePair).
   * Also keeps `legacyPair`, the pre-unification identity (seed = user + pass), for migrateLegacy().
   */
  async login(username, password) {
    if (!username || !password) {
      throw new Error('Username and password are required');
    }
    this.username = username.trim();
    this.pair = await derivePair(this.username, password);
    this.legacyPair = await ZEN.pair(null, { seed: this.username + password.trim() });
    return this.pair;
  }

  /**
   * Copy encrypted data (vault, calendar, bookmarks) from the legacy identity to the current one,
   * re-encrypting with the new key. Idempotent: souls already present under the new pub are skipped.
   * @returns {Promise<{migrated:number, skipped:number, failed:number}>}
   */
  async migrateLegacy(timeoutMs = 5000) {
    if (!this.pair) throw new Error('Not authenticated.');
    const { pair, legacyPair } = this;
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
      bookmarks: async (n) => ({ data: await enc(await dec(n.data)), updatedAt: n.updatedAt, encrypted: true })
    };
    const field = { vault: 'title', calendar: 'data', bookmarks: 'data' };

    const stats = { migrated: 0, skipped: 0, failed: 0 };
    for (const path of Object.keys(convert)) {
      const [old, cur] = await Promise.all([readAll(legacyPair.pub, path), readAll(pair.pub, path)]);
      for (const [soul, node] of old) {
        if (!node[field[path]]) continue;
        if (cur.has(soul)) { stats.skipped++; continue; }
        try {
          const payload = await convert[path](node);
          await new Promise((resolve, reject) => {
            this.zen.get('~' + pair.pub).get(path).get(soul).put(payload, (ack) => ack && ack.err ? reject(new Error(ack.err)) : resolve(), { authenticator: pair });
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

    const notes = [];
    const seen = new Set();

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(notes), timeoutMs);

      const processNode = async (node, soul) => {
        if (!node || node.trash || seen.has(soul)) return;
        if (!node.title) return;
        seen.add(soul);
        try {
          const title = await ZEN.decrypt(node.title, this.pair);
          const body = await ZEN.decrypt(node.body, this.pair);
          const cat = await ZEN.decrypt(node.cat, this.pair);
          notes.push({
            soul,
            title: title || '',
            body: body || '',
            cat: cat || '',
            pinned: !!node.pinned,
            timestamp: node.timestamp || Date.now()
          });
        } catch (_) {
          // ignore corrupted or un-decryptable records
        }
      };

      this.userRoot.get('vault').map().once(async (node, soul) => {
        if (!soul) return;
        if (node && node.title) {
          await processNode(node, soul);
        } else {
          this.userRoot.get('vault').get(soul).once(async (fullNode) => {
            if (fullNode && fullNode.title) {
              await processNode(fullNode, soul);
            }
          });
        }
      });
    });
  }

  /**
   * Delete a note from the vault.
   */
  async deleteVaultNote(soul) {
    if (!this.pair) throw new Error('Not authenticated.');
    return new Promise((resolve, reject) => {
      this.userRoot.get('vault').get(soul).put(null, (ack) => {
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
   *          notes?:string, location?:string, soul?:string}} event
   */
  async writeCalendarEvent({ soul = null, ...event }) {
    if (!this.pair) throw new Error('Not authenticated.');
    if (!event.title || event.start == null) throw new Error('title and start are required');

    const eventSoul = soul || ('cal-' + Date.now() + '-' + Math.random().toString(36).substring(7));
    const start = new Date(event.start).getTime();
    if (Number.isNaN(start)) throw new Error('Invalid start date');
    const end = event.end != null ? new Date(event.end).getTime() : start;
    const data = await ZEN.encrypt({ ...event, start, end }, this.pair);
    const payload = { data, updatedAt: Date.now(), encrypted: true };

    return new Promise((resolve, reject) => {
      this.userRoot.get('calendar').get(eventSoul).put(payload, (ack) => {
        if (ack && ack.err) reject(new Error(ack.err));
        else resolve({ soul: eventSoul, status: 'saved', updatedAt: payload.updatedAt });
      }, { authenticator: this.pair });
    });
  }

  /**
   * Read and decrypt calendar events, optionally within [from, to] (ms or date string).
   * Filtering happens after decryption, since times are encrypted.
   */
  async readCalendarEvents({ from = null, to = null, timeoutMs = 5000 } = {}) {
    if (!this.pair) throw new Error('Not authenticated.');
    const lo = from != null ? new Date(from).getTime() : -Infinity;
    const hi = to != null ? new Date(to).getTime() : Infinity;

    const events = [];
    const seen = new Set();
    return new Promise((resolve) => {
      setTimeout(() => resolve(events.sort((a, b) => a.start - b.start)), timeoutMs);

      const add = async (node, soul) => {
        if (!node || !node.data || seen.has(soul)) return;
        seen.add(soul);
        try {
          const ev = await ZEN.decrypt(node.data, this.pair); // ZEN returns the parsed object
          if (ev.end >= lo && ev.start <= hi) events.push({ soul, ...ev, updatedAt: node.updatedAt });
        } catch (_) {
          // ignore corrupted or un-decryptable records
        }
      };

      this.userRoot.get('calendar').map().once((node, soul) => {
        if (!soul) return;
        if (node && node.data) add(node, soul);
        else this.userRoot.get('calendar').get(soul).once((full) => add(full, soul));
      });
    });
  }

  /**
   * Delete a calendar event.
   */
  async deleteCalendarEvent(soul) {
    if (!this.pair) throw new Error('Not authenticated.');
    return new Promise((resolve, reject) => {
      this.userRoot.get('calendar').get(soul).put(null, (ack) => {
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
    const marks = [];
    const seen = new Set();
    return new Promise((resolve) => {
      setTimeout(() => resolve(marks.sort((a, b) => b.addedAt - a.addedAt)), timeoutMs);

      const add = async (node, soul) => {
        if (!node || !node.data || seen.has(soul)) return;
        seen.add(soul);
        try {
          const bm = await ZEN.decrypt(node.data, this.pair); // ZEN returns the parsed object
          if (folder && !(bm.folder === folder || bm.folder.startsWith(folder + '/'))) return;
          if (q && !(bm.title + ' ' + bm.url).toLowerCase().includes(q)) return;
          marks.push({ soul, ...bm });
        } catch (_) {
          // ignore corrupted or un-decryptable records
        }
      };

      this.userRoot.get('bookmarks').map().once((node, soul) => {
        if (!soul) return;
        if (node && node.data) add(node, soul);
        else this.userRoot.get('bookmarks').get(soul).once((full) => add(full, soul));
      });
    });
  }

  /**
   * Apply many edits at once, e.g. after an agent decided how to reorganise.
   * Each change is `{ soul, title?, folder?, tags? }`; omitted fields and `url`/`addedAt` are kept.
   * Reads the bookmarks once, then rewrites only the changed ones (50 at a time).
   * @returns {Promise<{updated:number, missing:string[], failed:number}>}
   */
  async updateBookmarks(changes, timeoutMs = 15000) {
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
   * Delete a bookmark by soul.
   */
  async deleteBookmark(soul) {
    if (!this.pair) throw new Error('Not authenticated.');
    return new Promise((resolve, reject) => {
      this.userRoot.get('bookmarks').get(soul).put(null, (ack) => {
        if (ack && ack.err) reject(new Error(ack.err));
        else resolve({ soul, status: 'deleted' });
      }, { authenticator: this.pair });
    });
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

    const posts = [];
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(posts), timeoutMs);

      this.zen.get('~' + targetPub).get('posts').map().on((post, id) => {
        if (!post || post.deleted) return;
        posts.push({
          id: post.id || id,
          title: post.title,
          content: post.content,
          tags: typeof post.tags === 'string' ? post.tags.split(', ') : (post.tags || []),
          authorAlias: post.authorAlias || null,
          authorPub: targetPub,
          createdAt: post.createdAt,
          updatedAt: post.updatedAt
        });
      });
    });
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
        resolve({ alias: targetAlias, pub: this.pair.pub });
      });
    });
  }
}

export default ZenOS;
