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
   * Authenticate / derive keypair from username and password.
   */
  async login(username, password) {
    if (!username || !password) {
      throw new Error('Username and password are required');
    }
    this.username = username.trim();
    this.pair = await ZEN.pair(null, { seed: this.username + password.trim() });
    return this.pair;
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
