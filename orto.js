/**
 * Orto (formerly ZenOS) client SDK — talks to a self-hosted Orto server (server.js, SQLite + file uploads).
 * Works in Node >= 18 and in browsers: fetch + WebCrypto only, no dependencies.
 *
 * Everything private is AES-GCM encrypted on the client with a key derived from username + password
 * (PBKDF2). The server only stores ciphertext; it authenticates you with a second, independent key
 * derived from the same login, so it can never decrypt your data. Only blog posts are public.
 */

const env = (globalThis.process && globalThis.process.env) || {};
export const DEFAULT_SERVER = 'https://orto.scobrudot.dev';

/** Normalize a server URL: trims it and drops the trailing slash. '' means same origin (browser). */
export function normalizeServer(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error('Invalid server URL: ' + raw); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Server URL must be http(s): ' + raw);
  return u.origin + u.pathname.replace(/\/$/, '');
}

// base64 without Buffer so it works in browsers too
const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

/** Compatibility no-op (the old build kept a graph cache on disk). */
export function flushStorage() {}

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

/** vCard 3.0 parsing/export for contacts (Google/Apple/Outlook "export contacts"). Returns [{ name, emails, phones, org, notes, tags }]. */
export function parseVcf(text) {
  const unfold = text.replace(/\r?\n[ \t]/g, '');
  const un = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();
  const out = [];
  for (const m of unfold.matchAll(/BEGIN:VCARD([\s\S]*?)END:VCARD/gi)) {
    const c = { name: '', emails: [], phones: [], org: '', notes: '', tags: [] };
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':'); if (i < 0) continue;
      const key = line.slice(0, i).split(';')[0].toUpperCase(), val = un(line.slice(i + 1));
      if (key === 'FN') c.name = val;
      else if (key === 'EMAIL' && val) c.emails.push(val);
      else if (key === 'TEL' && val) c.phones.push(val);
      else if (key === 'ORG') c.org = val.replace(/;+/g, ' ').trim();
      else if (key === 'NOTE') c.notes = val;
      else if (key === 'CATEGORIES') c.tags = val.split(',').map(t => t.trim()).filter(Boolean);
    }
    if (c.name || c.emails.length) out.push({ ...c, name: c.name || c.emails[0] });
  }
  return out;
}

export function contactsToVcf(list) {
  const esc = (v) => String(v || '').replace(/[\\,;]/g, '\\$&').replace(/\n/g, '\\n');
  return list.map(c => ['BEGIN:VCARD', 'VERSION:3.0', 'FN:' + esc(c.name),
    ...(c.emails || []).map(e => 'EMAIL:' + esc(e)), ...(c.phones || []).map(t => 'TEL:' + esc(t)),
    ...(c.org ? ['ORG:' + esc(c.org)] : []), ...(c.notes ? ['NOTE:' + esc(c.notes)] : []),
    ...((c.tags || []).length ? ['CATEGORIES:' + c.tags.map(esc).join(',')] : []), 'END:VCARD'].join('\r\n')).join('\r\n') + '\r\n';
}

/** Random password from the platform CSPRNG. `symbols:false` for sites that reject them. */
export function generatePassword(length = 20, { symbols = true } = {}) {
  const set = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789' + (symbols ? '!@#$%^&*-_=+?' : '');
  const max = 256 - (256 % set.length); // rejection sampling: no modulo bias
  let out = '';
  while (out.length < length) for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) if (b < max && out.length < length) out += set[b % set.length];
  return out;
}

// what an event or task can point at; the link lives inside the encrypted record, so there is one source of truth
const LINK_KINDS = ['note', 'bookmark', 'event', 'task'];

// ─── Feeds (RSS 2.0, RSS 1.0 and Atom) ─────────────────────────────────────────────────────────
// A small tolerant reader, no XML library: fine for the regular shape of feeds. Text fields can hold HTML: sanitize before showing.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const unEnt = (t) => t.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (m, d, h, n) => d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : (ENT[n.toLowerCase()] ?? m));
const xmlText = (t) => /<!\[CDATA\[/.test(t) ? t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, x) => x) : unEnt(t);
const tagText = (b, tag) => { const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i').exec(b); return m ? xmlText(m[1]).trim() : ''; };
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1].toLowerCase(), unEnt(m[2] ?? m[3])]));
const atomLink = (b) => { const l = [...b.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0])).find((a) => a.href && (!a.rel || a.rel === 'alternate')); return l ? l.href : ''; };
const httpUrl = (u) => (/^https?:\/\//i.test(u) ? u : '');

/** feed XML -> { title, link, items: [{ id, title, link, date (ms or null), summary, content }] }, newest first, at most 100 items. */
export function parseFeed(xml) {
  xml = String(xml || '');
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) throw new Error('Not an RSS or Atom feed');
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
  const head = xml.replace(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, '');
  const items = blocks.map((b) => {
    const link = httpUrl(atomLink(b) || tagText(b, 'link') || tagText(b, 'guid'));
    const t = Date.parse(tagText(b, 'pubDate') || tagText(b, 'published') || tagText(b, 'updated') || tagText(b, 'dc:date'));
    return { id: tagText(b, 'guid') || tagText(b, 'id') || link, title: tagText(b, 'title') || link || '(untitled)', link, date: Number.isNaN(t) ? null : t,
      summary: tagText(b, 'description') || tagText(b, 'summary'), content: tagText(b, 'content:encoded') || tagText(b, 'content') };
  }).filter((i) => i.id);
  return { title: tagText(head, 'title'), link: httpUrl(atomLink(head) || tagText(head, 'link')), items: items.sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, 100) };
}

/** OPML (the standard list of subscriptions) -> [{ url, title, folder }]; outline groups become folders. */
export function parseOpml(xml) {
  const out = [], stack = [];
  for (const m of String(xml || '').matchAll(/<outline\b[^>]*?(\/?)>|<\/outline>/gi)) {
    if (m[0][1] === '/') { stack.pop(); continue; }
    const a = attrs(m[0]), url = httpUrl(a.xmlurl || '');
    if (url) out.push({ url, title: a.title || a.text || '', folder: stack.filter(Boolean).join('/') });
    if (!m[1]) stack.push(url ? '' : (a.title || a.text || '').replace(/\//g, '-'));
  }
  return out;
}

const escXml = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function feedsToOpml(feeds) {
  const line = (f) => `<outline type="rss" text="${escXml(f.title || f.url)}" title="${escXml(f.title || f.url)}" xmlUrl="${escXml(f.url)}"/>`;
  const folders = [...new Set(feeds.map((f) => f.folder || ''))].sort();
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>Orto feeds</title></head><body>\n`
    + folders.map((d) => { const l = feeds.filter((f) => (f.folder || '') === d).map(line).join('\n'); return d ? `<outline text="${escXml(d)}">\n${l}\n</outline>` : l; }).join('\n') + `\n</body></opml>\n`;
}

export async function bookmarkSoul(url) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return 'bm-' + [...new Uint8Array(h)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}


/**
 * username + password -> { key (AES-GCM, never leaves the client), auth (sent to the server as the login secret) }.
 * 512 PBKDF2 bits split in two so the server's login secret says nothing about the encryption key.
 */
export async function deriveKeys(username, password) {
  const name = String(username ?? '').trim().toLowerCase();
  if (!name || !password) throw new Error('Username and password are required');
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 210000, salt: enc.encode('zenos:v1:' + name) /* the pre-rename name: part of the key derivation, never change it or every login stops opening its data */ }, base, 512));
  return { name, key: await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']), auth: toB64(bits.slice(32)) };
}

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map(x => String(x).trim()).filter(Boolean);
const matches = (words, ...fields) => { const hay = fields.flat().join(' ').toLowerCase(); return words.every(w => hay.includes(w)); };
const words = (query) => (query ? query.toLowerCase().split(/\s+/).filter(Boolean) : []);
const checkLinks = (links) => {
  if (links !== undefined && !(Array.isArray(links) && links.every(l => LINK_KINDS.includes(l?.kind) && typeof l.soul === 'string'))) {
    throw new Error(`links must be [{ kind: "${LINK_KINDS.join('|')}", soul }]`);
  }
};

const COLLECTIONS = ['vault', 'calendar', 'tasks', 'bookmarks', 'contacts', 'secrets', 'feeds', 'files', 'shares']; // encrypted ones; `posts` is public
const toB64u = (u8) => toB64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (b) => fromB64(b.replace(/-/g, '+').replace(/_/g, '/'));
const aesKey = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
const seal = async (key, value) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return 'e1.' + toB64(out);
};
const unseal = async (key, cipher) => {
  if (typeof cipher !== 'string' || !cipher.startsWith('e1.')) throw new Error('Not an Orto ciphertext');
  const raw = fromB64(cipher.slice(3));
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, key, raw.subarray(12))));
};
// folder: "a/b" nests; album and playlist: flat. Trimmed, no empty parts, at most 100 chars.
const groupName = (kind, s) => { const parts = String(s ?? '').split('/').map((x) => x.trim()).filter(Boolean); return (kind === 'folder' ? parts.join('/') : parts.join('-')).slice(0, 100); };

// Chunked files (big files, media you can play while it downloads): the blob is chunk 0, chunk 1, ... back to back, each
// `iv(12) | AES-GCM(chunk) | tag(16)`, so chunk i sits at byte i * (size + 28) and can be fetched on its own with a Range request.
// The authenticated data binds a chunk to its place: file nonce, index and chunk count, so chunks cannot be swapped, dropped
// or taken from another file. {size, n, nonce} live in the encrypted index entry. web/sw.js has the same decryption: keep in sync.
export const CHUNK = 1 << 20;
const GCM = 28;
const chunkAad = (nonce, i, n) => { const a = new Uint8Array(nonce.length + 8); a.set(nonce); const v = new DataView(a.buffer); v.setUint32(nonce.length, i); v.setUint32(nonce.length + 4, n); return a; };
async function sealChunk(key, plain, nonce, i, n) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: chunkAad(nonce, i, n) }, key, plain));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return out;
}
const openChunk = async (key, bytes, nonce, i, n) => new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: chunkAad(nonce, i, n) }, key, bytes.subarray(12)));
const chunkLen = (m, i) => (i < m.chunked.n - 1 ? m.chunked.size : m.size - (m.chunked.n - 1) * m.chunked.size) + GCM; // stored length of chunk i
const chunked = async (items, fn, n = 20) => { for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map(fn)); };

/**
 * Open a public share link (`<server>/s/<id>#<key>`), no login needed. The key is the part after `#`: it never reaches the server.
 * @returns {Promise<{kind:'note', title, body, cat} | {kind:'file', name, type, data:Uint8Array}>}
 */
export async function readShare(link) {
  const u = new URL(link);
  const id = u.pathname.split('/').pop();
  if (!/^[a-f0-9]{32}$/.test(id) || !u.hash.slice(1)) throw new Error('Not an Orto share link');
  const r = await fetch(`${u.origin}/api/s/${id}`);
  if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status), { status: r.status });
  const cipher = String((r.headers.get('content-type') || '').startsWith('application/json') ? (await r.json()).data : await r.text());
  const p = await unseal(await aesKey(fromB64u(u.hash.slice(1))), cipher);
  return p.kind === 'file' ? { ...p, data: fromB64(p.data) } : p;
}

export class Orto {
  /**
   * @param {{server?:string, token?:string}} options  server: Orto server URL (env ORTO_SERVER; '' = same origin in a browser)
   */
  constructor(options = {}) {
    const fallback = globalThis.window ? '' : DEFAULT_SERVER;
    this.server = normalizeServer(options.server ?? env.ORTO_SERVER ?? env.ZENOS_SERVER ?? fallback);
    this.token = options.token || null;
    this.key = null;
    this.username = null;
    this.pair = null; // { pub }: kept so older callers can read pair.pub
  }

  /** Public handle of the user: the lowercase username (used in blog URLs). */
  get pub() { return this.username; }

  /**
   * Derive keys and sign in. `create: true` registers the account first (if the server allows it).
   * Throws an Error with `.status` 404 when the user does not exist yet.
   */
  async login(username, password, { create = false } = {}) {
    const { name, key, auth } = await deriveKeys(username, password);
    const { token } = await this._json('POST', create ? '/register' : '/login', { name, auth });
    Object.assign(this, { key, token, username: name, pair: { pub: name }, _auth: auth });
    return this.pair;
  }

  /** Stop the live-update stream (call before exiting a long-lived script). */
  close() { this._closed = true; this._abort?.abort(); }

  // ─── transport ──────────────────────────────────────────────────────

  async _fetch(method, path, body, signal, headers) {
    const isBytes = body instanceof Uint8Array;
    const r = await fetch(this.server + '/api' + path, {
      method, signal,
      headers: { ...(this.token && { Authorization: 'Bearer ' + this.token }), ...(body !== undefined && !isBytes && { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : isBytes ? body : JSON.stringify(body)
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw Object.assign(new Error(j.error || 'HTTP ' + r.status), { status: r.status });
    }
    return r;
  }

  async _json(method, path, body) { return (await this._fetch(method, path, body)).json(); }

  // ─── encryption ─────────────────────────────────────────────────────

  _needKey() { if (!this.key) throw new Error('Not authenticated. Call login() first.'); }

  /** Any JSON value -> "e1.<base64 iv+ciphertext>" (AES-GCM-256). */
  async encrypt(value) { this._needKey(); return seal(this.key, value); }

  async decrypt(cipher) { this._needKey(); return unseal(this.key, cipher); }

  // ─── generic encrypted collection ──────────────────────────────────

  _newSoul(prefix) { return prefix + Date.now().toString(36) + crypto.getRandomValues(new Uint32Array(1))[0].toString(36); }

  /** Encrypt `obj` whole and store it as record `coll/soul`. */
  async put(coll, soul, obj) {
    await this._json('PUT', `/c/${coll}/${encodeURIComponent(soul)}`, { data: await this.encrypt(obj), encrypted: true });
    return { soul, status: 'saved' };
  }

  async _dec(rec) {
    if (!rec || typeof rec.data !== 'string') return null;
    try { return { soul: rec.soul, ...(await this.decrypt(rec.data)), updatedAt: rec.updatedAt }; } catch (_) { return null; }
  }

  async _get(coll, soul) {
    if (!soul) throw new Error('soul is required.');
    try { return await this._dec(await this._json('GET', `/c/${coll}/${encodeURIComponent(soul)}`)); }
    catch (e) { if (e.status === 404) return null; throw e; }
  }

  /** Every decryptable record of a collection. */
  async _readAll(coll) {
    this._needKey();
    return (await Promise.all((await this._json('GET', '/c/' + coll)).map(r => this._dec(r)))).filter(Boolean);
  }

  async _del(coll, soul) {
    this._needKey();
    await this._json('DELETE', `/c/${coll}/${encodeURIComponent(soul)}`);
    return { soul, status: 'deleted' };
  }

  _stream() {
    if (this._subs) return;
    this._subs = new Set();
    this._abort = new AbortController();
    (async () => {
      for (let first = true; !this._closed; first = false) {
        try {
          const r = await this._fetch('GET', '/events', undefined, this._abort.signal);
          if (!first) for (const s of this._subs) s.sync().catch(() => {}); // missed events while offline
          const dec = new TextDecoder(); let buf = '';
          for await (const chunk of r.body) {
            buf += dec.decode(chunk, { stream: true });
            for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
              const m = /^data: (.*)$/m.exec(buf.slice(0, i)); buf = buf.slice(i + 2);
              if (m) { const e = JSON.parse(m[1]); for (const s of this._subs) if (s.coll === e.coll) s.handle(e); }
            }
          }
        } catch (_) {}
        if (!this._closed) await new Promise(r => setTimeout(r, 2000));
      }
    })();
  }

  /**
   * Live decrypted updates of a collection: callback(entry, soul, isDeleted).
   * Replays every existing record first, then follows changes (from this or any other client).
   * @returns {() => void} unsubscribe
   */
  _on(coll, callback, keep = () => true, plain = false) {
    if (!plain) this._needKey();
    const emit = async (rec) => { const v = plain ? rec : await this._dec(rec); if (v && keep(v)) callback(v, rec.soul, false); };
    const sync = async () => { await Promise.all((await this._json('GET', '/c/' + coll)).map(emit)); };
    const sub = { coll, sync, handle: (e) => (e.deleted ? callback(null, e.soul, true) : emit(e.record)) };
    this._stream();
    this._subs.add(sub);
    sync().catch(() => {});
    return () => this._subs.delete(sub);
  }

  // ─── Vault (encrypted notes) ─────────────────────────────────────

  async writeVaultNote({ title, body, cat = 'general', pinned = false, soul = null }) {
    this._needKey();
    const noteSoul = soul || this._newSoul('vault-');
    const timestamp = Date.now();
    await this.put('vault', noteSoul, { title, body, cat, pinned: !!pinned, trash: false, timestamp });
    return { soul: noteSoul, status: 'saved', timestamp };
  }

  /** Decrypted notes (trashed ones skipped), pinned first then newest. `timeoutMs` kept for API compatibility. */
  async readVaultNotes() {
    const notes = (await this._readAll('vault')).filter(n => !n.trash && n.title);
    return notes.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.timestamp - a.timestamp);
  }

  async getVaultNote(soul) {
    const n = await this._get('vault', soul);
    return n && !n.trash && n.title ? n : null;
  }

  deleteVaultNote(soul) { return this._del('vault', soul); }

  onVaultNote(callback) {
    return this._on('vault', (n, soul, deleted) => (n && n.trash ? callback(null, soul, true) : callback(n && { ...n, id: soul }, soul, deleted)), (n) => n.title !== undefined || n.trash);
  }

  // ─── Calendar ───────────────────────────────────────────────────────

  /** @param {{title:string, start:number|string, end?:number|string, allDay?:boolean, notes?:string, location?:string, links?:{kind:string, soul:string}[], soul?:string}} event */
  async writeCalendarEvent({ soul = null, ...event }) {
    this._needKey();
    if (!event.title || event.start == null) throw new Error('title and start are required');
    const start = new Date(event.start).getTime();
    if (Number.isNaN(start)) throw new Error('Invalid start date');
    const end = event.end != null ? new Date(event.end).getTime() : start;
    checkLinks(event.links);
    const eventSoul = soul || this._newSoul('cal-');
    delete event.updatedAt;
    const r = await this.put('calendar', eventSoul, { ...event, start, end });
    return { ...r, updatedAt: Date.now() };
  }

  getCalendarEvent(soul) { return this._get('calendar', soul); }

  async linkToEvent(eventSoul, { kind = 'note', soul }) {
    const ev = await this.getCalendarEvent(eventSoul);
    if (!ev) throw new Error('Event not found: ' + eventSoul);
    const links = ev.links || [];
    if (!links.some(l => l.kind === kind && l.soul === soul)) links.push({ kind, soul });
    return this.writeCalendarEvent({ ...ev, soul: eventSoul, links });
  }

  async unlinkFromEvent(eventSoul, { kind = 'note', soul }) {
    const ev = await this.getCalendarEvent(eventSoul);
    if (!ev) throw new Error('Event not found: ' + eventSoul);
    return this.writeCalendarEvent({ ...ev, soul: eventSoul, links: (ev.links || []).filter(l => !(l.kind === kind && l.soul === soul)) });
  }

  async eventsFor({ kind = 'note', soul }) {
    return (await this.readCalendarEvents()).filter(e => (e.links || []).some(l => l.kind === kind && l.soul === soul));
  }

  async notesForEvent(eventSoul) {
    const ev = await this.getCalendarEvent(eventSoul);
    if (!ev) throw new Error('Event not found: ' + eventSoul);
    const wanted = new Set((ev.links || []).filter(l => l.kind === 'note').map(l => l.soul));
    return (await this.readVaultNotes()).filter(n => wanted.has(n.soul));
  }

  /** Events overlapping [from, to] (ms or date string), by start time. Filtering is client-side: times are encrypted. */
  async readCalendarEvents({ from = null, to = null } = {}) {
    const lo = from != null ? new Date(from).getTime() : -Infinity;
    const hi = to != null ? new Date(to).getTime() : Infinity;
    return (await this._readAll('calendar')).filter(ev => ev.end >= lo && ev.start <= hi).sort((a, b) => a.start - b.start);
  }

  deleteCalendarEvent(soul) { return this._del('calendar', soul); }
  onCalendarEvent(callback) { return this._on('calendar', callback); }

  // ─── Files (stored on the server's disk, encrypted client-side by default) ──

  /**
   * Upload bytes. Encrypted by default (AES-GCM with your key); the server only sees a blob.
   * The whole file is held in memory while encrypting, so keep uploads to what a browser tab can handle.
   * An encrypted index entry (name, size) is kept in the `files` collection for listFiles().
   * `type` (MIME) and `thumb` (small data: URL) are stored in the encrypted index entry; the web app's Photos view uses them.
   * @returns {Promise<{id:string, name:string, size:number, encrypted:boolean, addedAt:number}>}
   */
  async uploadFile(data, name, { encrypt = true, type, thumb, addedAt, folder, album, playlist } = {}) {
    this._needKey();
    const body = encrypt ? new TextEncoder().encode(await this.encrypt(toB64(data))) : data;
    const { id } = await (await this._fetch('POST', '/files', body)).json();
    const meta = { id, name, size: data.length, encrypted: encrypt, addedAt: addedAt ?? Date.now(), ...(type && { type }), ...(thumb && { thumb }),
      ...(groupName('folder', folder) && { folder: groupName('folder', folder) }), ...(groupName('album', album) && { album: groupName('album', album) }), ...(groupName('playlist', playlist) && { playlist: groupName('playlist', playlist) }) };
    await this.put('files', id, meta);
    return meta;
  }

  async listFiles() {
    return (await this._readAll('files')).filter(f => f.id).sort((a, b) => b.addedAt - a.addedAt);
  }

  // Folders (Files view, "a/b" nests) and albums (Photos view, flat) are names kept in the encrypted index entry of each file
  // (`folder`, `album`). Empty ones are remembered in one extra record of the `files` collection (soul `_groups`, no `id`, so
  // listFiles() skips it).

  async fileGroups() {
    const r = await this._get('files', '_groups');
    return { folders: r?.folders || [], albums: r?.albums || [], playlists: r?.playlists || [] };
  }

  /** @param {'folder'|'album'|'playlist'} kind @returns {Promise<string>} the normalized name */
  async addFileGroup(kind, name) {
    this._needKey();
    name = groupName(kind, name);
    if (!name) throw new Error('name is required');
    const g = await this.fileGroups(), key = kind + 's';
    if (!g[key].includes(name)) await this.put('files', '_groups', { ...g, [key]: [...g[key], name].sort() });
    return name;
  }

  /** Rename a folder (and everything below it) or an album. An empty `to` removes it: its files just lose the folder/album. */
  async renameFileGroup(kind, from, to) {
    this._needKey();
    const key = kind + 's';
    to = groupName(kind, to);
    from = groupName(kind, from);
    if (!from) throw new Error('name is required');
    const under = (n) => n === from || (kind === 'folder' && n.startsWith(from + '/'));
    const swap = (n) => (to ? to + n.slice(from.length) : '');
    const g = await this.fileGroups();
    const names = [...new Set([...g[key].filter((n) => !under(n)), ...g[key].filter(under).map(swap).filter(Boolean)])].sort();
    await this.put('files', '_groups', { ...g, [key]: names });
    let moved = 0;
    for (const f of await this.listFiles()) if (f[kind] && under(f[kind])) { await this.moveFile(f.id, { [kind]: swap(f[kind]) }); moved++; }
    return { name: to, moved };
  }

  /** Set (or, with '', clear) a file's folder and/or album. Leave a field undefined to keep it. */
  async moveFile(id, { folder, album, playlist } = {}) {
    this._needKey();
    const m = await this._get('files', id);
    if (!m?.id) throw new Error('No such file');
    const { soul, updatedAt, ...meta } = m;
    for (const [k, v] of [['folder', folder], ['album', album], ['playlist', playlist]]) {
      if (v === undefined) continue;
      const name = groupName(k, v);
      if (name) meta[k] = name; else delete meta[k];
    }
    await this.put('files', id, meta);
    return meta;
  }

  /**
   * Upload a Blob/File/Uint8Array in encrypted chunks (see CHUNK above): memory stays at a couple of chunks whatever the size,
   * and the file can be played or read piece by piece with readFileRange(). `onProgress(0..1)`.
   * @returns {Promise<object>} the index entry: {id, name, size, encrypted, chunked: {size, n, nonce}, addedAt, ...}
   */
  async uploadFileChunked(data, name, { type, thumb, addedAt, folder, album, playlist, chunkSize = CHUNK, onProgress } = {}) {
    this._needKey();
    const blob = data instanceof Blob ? data : new Blob([data]);
    const size = blob.size, n = Math.max(1, Math.ceil(size / chunkSize)), nonce = crypto.getRandomValues(new Uint8Array(16));
    const { id: tmp } = await this._json('POST', '/files/begin');
    let sent = 0;
    for (let i = 0; i < n; i++) {
      const plain = new Uint8Array(await blob.slice(i * chunkSize, (i + 1) * chunkSize).arrayBuffer());
      const body = await sealChunk(this.key, plain, nonce, i, n);
      await this._fetch('PUT', `/files/${tmp}/append`, body, undefined, { 'X-Offset': String(sent) });
      sent += body.length;
      onProgress?.((i + 1) / n);
    }
    const { id } = await this._json('POST', `/files/${tmp}/finish`);
    const g = { folder: groupName('folder', folder), album: groupName('album', album), playlist: groupName('playlist', playlist) };
    const meta = { id, name, size, encrypted: true, chunked: { size: chunkSize, n, nonce: toB64(nonce) }, addedAt: addedAt ?? Date.now(), ...(type && { type }), ...(thumb && { thumb }),
      ...Object.fromEntries(Object.entries(g).filter(([, v]) => v)) };
    await this.put('files', id, meta);
    return meta;
  }

  /** Plaintext bytes [start, end) of a chunked file, fetching only the chunks that cover them (what playback and seeking use). */
  async readFileRange(id, start, end, meta) {
    this._needKey();
    meta ??= await this._get('files', id);
    if (!meta?.chunked) return (await this.downloadFile(id, { meta })).subarray(start, end);
    const { size: P, n, nonce } = meta.chunked, nonceBytes = fromB64(nonce);
    end = Math.min(end, meta.size);
    if (start >= end) return new Uint8Array(0);
    const first = Math.floor(start / P), last = Math.floor((end - 1) / P);
    const from = first * (P + GCM), to = last * (P + GCM) + chunkLen(meta, last);
    const whole = first === 0 && last === n - 1;
    const bytes = new Uint8Array(await (await this._fetch('GET', '/files/' + encodeURIComponent(id), undefined, undefined, whole ? undefined : { Range: `bytes=${from}-${to - 1}` })).arrayBuffer());
    const out = new Uint8Array(end - start);
    let at = 0;
    for (let i = first; i <= last; i++) {
      const plain = await openChunk(this.key, bytes.subarray(at, at + chunkLen(meta, i)), nonceBytes, i, n);
      at += chunkLen(meta, i);
      const a = Math.max(start, i * P), b = Math.min(end, i * P + plain.length);
      out.set(plain.subarray(a - i * P, b - i * P), a - start);
    }
    return out;
  }

  // Re-encrypt a chunked file with `newKey`, chunk by chunk, and swap it in place. Safe to run twice: a file already on the new key is left alone.
  async _rekeyChunked(id, meta, newKey) {
    const { n, nonce } = meta.chunked, nonceBytes = fromB64(nonce), P = meta.chunked.size;
    const get = async (i) => new Uint8Array(await (await this._fetch('GET', '/files/' + encodeURIComponent(id), undefined, undefined, { Range: `bytes=${i * (P + GCM)}-${i * (P + GCM) + chunkLen(meta, i) - 1}` })).arrayBuffer());
    try { await openChunk(newKey, await get(0), nonceBytes, 0, n); return false; } catch (_) { } // already done
    const { id: tmp } = await this._json('POST', '/files/begin');
    let sent = 0;
    for (let i = 0; i < n; i++) {
      const body = await sealChunk(newKey, await openChunk(this.key, await get(i), nonceBytes, i, n), nonceBytes, i, n);
      await this._fetch('PUT', `/files/${tmp}/append`, body, undefined, { 'X-Offset': String(sent) });
      sent += body.length;
    }
    await this._json('POST', `/files/${tmp}/finish?replace=${encodeURIComponent(id)}`);
    return true;
  }

  /** @returns {Promise<Uint8Array>} the file, decrypted if it was uploaded encrypted. Pass the index entry as `meta` to save a lookup. */
  async downloadFile(id, { encrypted, meta } = {}) {
    this._needKey();
    if (meta === undefined && encrypted === undefined) meta = await this._get('files', id);
    if (meta?.chunked) return this.readFileRange(id, 0, meta.size, meta);
    encrypted ??= meta?.encrypted ?? false;
    const buf = new Uint8Array(await (await this._fetch('GET', '/files/' + encodeURIComponent(id))).arrayBuffer());
    return encrypted ? fromB64(await this.decrypt(new TextDecoder().decode(buf))) : buf;
  }

  async deleteFile(id) {
    this._needKey();
    await this._json('DELETE', '/files/' + encodeURIComponent(id));
    return this._del('files', id);
  }

  // ─── Public share links ─────────────────────────────────────────────
  // A random key per share encrypts the item; the link is <server>/s/<id>#<key>. The server stores ciphertext only and the
  // #fragment is never sent to it. Revoke with unshare(). Your own list of links is an encrypted `shares` record.

  async _share(kind, ref, title, payload, bytes) {
    this._needKey();
    const raw = crypto.getRandomValues(new Uint8Array(32)), key = toB64u(raw);
    const cipher = await seal(await aesKey(raw), payload);
    const { id } = await (await this._fetch('POST', '/s', bytes ? new TextEncoder().encode(cipher) : { data: cipher })).json();
    await this.put('shares', id, { id, kind, ref, title, key, createdAt: Date.now() });
    return { id, kind, title, url: this._shareUrl(id, key) };
  }

  _shareUrl(id, key) { return `${this.server || globalThis.location?.origin || ''}/s/${id}#${key}`; }

  /** Public read-only link to one note. */
  async shareNote(soul) {
    const n = await this._get('vault', soul);
    if (!n) throw new Error('Note not found: ' + soul);
    return this._share('note', soul, n.title, { kind: 'note', title: n.title, body: n.body, cat: n.cat });
  }

  /** Public link to one file (re-encrypted with the share key; the original stays private). */
  async shareFile(id) {
    const f = await this._get('files', id);
    if (!f) throw new Error('File not found: ' + id);
    const data = await this.downloadFile(id);
    return this._share('file', id, f.name, { kind: 'file', name: f.name, type: f.type || 'application/octet-stream', data: toB64(data) }, true);
  }

  async listShares() {
    return (await this._readAll('shares')).filter(x => x.id && x.key)
      .map(({ key, ...x }) => ({ ...x, url: this._shareUrl(x.id, key) })).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Revoke a link: the ciphertext is deleted from the server. */
  async unshare(id) {
    this._needKey();
    await this._json('DELETE', '/s/' + encodeURIComponent(id)).catch((e) => { if (e.status !== 404) throw e; });
    return this._del('shares', id);
  }

  // ─── Account: password, export, import ──────────────────────────────

  /**
   * Change the password. Your key comes from it, so every encrypted record and file is re-encrypted first, then the login secret
   * is swapped and all other sessions are signed out. Safe to re-run with the same passwords if it was interrupted (already
   * converted items are skipped, and the old password keeps working until the last step). Export first anyway.
   */
  async changePassword(newPassword) {
    this._needKey();
    const next = await deriveKeys(this.username, newPassword);
    await this._json('POST', '/password', { auth: this._auth, newAuth: next.auth, check: true }); // fail now (wrong session, demo account...) rather than after re-encrypting
    const open = async (cipher) => {
      for (const [key, fresh] of [[this.key, false], [next.key, true]]) { try { return { v: await unseal(key, cipher), fresh }; } catch (_) {} }
      return null;
    };
    const recs = async (coll) => (await this._json('GET', '/c/' + coll)).filter(r => typeof r.data === 'string');
    await chunked(await recs('files'), async (r) => { // file contents first
      const meta = await open(r.data);
      if (!meta?.v.encrypted) return;
      if (meta.v.chunked) { await this._rekeyChunked(r.soul, meta.v, next.key); return; }
      const blob = await open(new TextDecoder().decode(new Uint8Array(await (await this._fetch('GET', '/files/' + encodeURIComponent(r.soul))).arrayBuffer())));
      if (blob && !blob.fresh) await this._fetch('PUT', '/files/' + encodeURIComponent(r.soul), new TextEncoder().encode(await seal(next.key, blob.v)));
    }, 5);
    for (const coll of COLLECTIONS) {
      await chunked(await recs(coll), async (r) => {
        const o = await open(r.data);
        if (o && !o.fresh) await this._json('PUT', `/c/${coll}/${encodeURIComponent(r.soul)}`, { data: await seal(next.key, o.v), encrypted: true });
      });
    }
    await this._json('POST', '/password', { auth: this._auth, newAuth: next.auth });
    Object.assign(this, { key: next.key, _auth: next.auth });
    return { status: 'changed' };
  }

  /**
   * Everything decrypted as one JSON-able object (notes, events, tasks, bookmarks, contacts, secrets, file index, blog posts and,
   * unless `files: false`, file contents as base64). Plain text: keep it somewhere safe. Share links are not included.
   */
  async exportAll({ files = true } = {}) {
    this._needKey();
    const out = { format: 'orto-export', version: 1, user: this.username, exportedAt: Date.now(), collections: {}, files: {}, posts: await this._json('GET', '/c/posts') };
    for (const coll of COLLECTIONS.filter(c => c !== 'shares')) out.collections[coll] = await this._readAll(coll);
    if (files) await chunked(out.collections.files.filter(f => f.id), async (f) => { try { out.files[f.id] = toB64(await this.downloadFile(f.id, { meta: f })); } catch (_) {} }, 5);
    return out; // ponytail: files go in memory as base64, stream to a ZIP if exports get huge
  }

  /** Load an exportAll() result into this account (same souls overwrite; files with the same name, size and date are skipped). */
  async importAll(data) {
    this._needKey();
    if (!['orto-export', 'zenos-export'].includes(data?.format)) throw new Error('Not an Orto export');
    const done = { records: 0, posts: 0, files: 0 };
    for (const coll of COLLECTIONS.filter(c => c !== 'files' && c !== 'shares')) {
      await chunked(data.collections?.[coll] || [], async ({ soul, updatedAt, ...rest }) => { await this.put(coll, soul, rest); done.records++; });
    }
    await chunked(data.posts || [], async ({ soul, updatedAt, ...rest }) => { await this._json('PUT', `/c/posts/${encodeURIComponent(soul)}`, rest); done.posts++; });
    const sig = (f) => `${f.name}|${f.size}|${f.addedAt}`; // new ids are assigned on upload, so match files by content metadata
    const have = new Set((await this.listFiles()).map(sig));
    for (const f of data.collections?.files || []) {
      if (!f.id || have.has(sig(f)) || !data.files?.[f.id]) continue;
      await this.uploadFile(fromB64(data.files[f.id]), f.name, { encrypt: f.encrypted !== false, type: f.type, thumb: f.thumb, addedAt: f.addedAt, folder: f.folder, album: f.album, playlist: f.playlist });
      done.files++;
    }
    const groups = (data.collections?.files || []).find((r) => r.soul === '_groups'); // empty folders and albums
    if (groups) {
      const cur = await this.fileGroups();
      await this.put('files', '_groups', Object.fromEntries(['folders', 'albums', 'playlists'].map((k) => [k, [...new Set([...cur[k], ...(groups[k] || [])])].sort()])));
    }
    return done;
  }

  // ─── Bookmarks ──────────────────────────────────────────────────────

  /** Soul is derived from the URL, so saving or importing the same URL twice updates one record. */
  async writeBookmark({ url, title = '', folder = '', tags = [], addedAt = Date.now() }) {
    this._needKey();
    if (!/^https?:\/\//i.test(url || '')) throw new Error('url must be http(s)');
    return this.put('bookmarks', await bookmarkSoul(url), { url, title: title || url, folder, tags, addedAt });
  }

  async importBookmarksHtml(html) {
    const results = [];
    const items = parseBookmarksHtml(html);
    for (let i = 0; i < items.length; i += 100) results.push(...await Promise.allSettled(items.slice(i, i + 100).map(b => this.writeBookmark(b))));
    return { imported: results.filter(r => r.status === 'fulfilled').length, failed: results.filter(r => r.status === 'rejected').length };
  }

  /** Bookmarks, newest first; `folder` = path prefix, `query` = space-separated keywords that must all match. */
  async readBookmarks({ folder = null, query = null } = {}) {
    const w = words(query);
    return (await this._readAll('bookmarks'))
      .filter(bm => bm.url && (!folder || bm.folder === folder || bm.folder.startsWith(folder + '/')) && matches(w, bm.title, bm.url, bm.folder, bm.tags || []))
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  /** Apply many edits at once: each `{ soul, title?, folder?, tags? }`; omitted fields, `url` and `addedAt` are kept. */
  async updateBookmarks(changes) {
    const bySoul = new Map((await this.readBookmarks()).map(b => [b.soul, b]));
    const missing = [], jobs = [];
    for (const { soul, ...patch } of changes) {
      const cur = bySoul.get(soul);
      if (!cur) { missing.push(soul); continue; }
      const { title = cur.title, folder = cur.folder, tags = cur.tags } = patch;
      jobs.push({ ...cur, title, folder, tags });
    }
    let updated = 0, failed = 0;
    for (let i = 0; i < jobs.length; i += 50) {
      const res = await Promise.allSettled(jobs.slice(i, i + 50).map(({ soul, updatedAt, ...bm }) => this.writeBookmark(bm)));
      updated += res.filter(r => r.status === 'fulfilled').length;
      failed += res.filter(r => r.status === 'rejected').length;
    }
    return { updated, missing, failed };
  }

  async updateBookmark(soul, patch) {
    const r = await this.updateBookmarks([{ soul, ...patch }]);
    if (r.missing.length) throw new Error('Bookmark not found: ' + soul);
    if (r.failed) throw new Error('Update failed');
    return { soul, status: 'updated' };
  }

  async exportBookmarksHtml({ folder = null } = {}) { return bookmarksToHtml(await this.readBookmarks({ folder })); }
  async getBookmark(soul) { const b = await this._get('bookmarks', soul); return b && b.url ? b : null; }
  deleteBookmark(soul) { return this._del('bookmarks', soul); }
  onBookmark(callback) { return this._on('bookmarks', callback, (b) => /^https?:\/\//i.test(b.url)); }

  // ─── Contacts ───────────────────────────────────────────────────────

  /** `pub` is an optional Orto username, so a contact can be an Orto user too. */
  async writeContact({ soul = null, name, emails = [], phones = [], org = '', notes = '', tags = [], pub = '', addedAt = Date.now() }) {
    if (!name || !String(name).trim()) throw new Error('name is required.');
    return this.put('contacts', soul || this._newSoul('ct-'), { name: String(name).trim(), emails: asList(emails), phones: asList(phones), org, notes, tags: asList(tags).map(t => t.replace(/^#/, '')), pub, addedAt });
  }

  getContact(soul) { return this._get('contacts', soul); }

  async readContacts({ query = null, tag = null } = {}) {
    const w = words(query);
    return (await this._readAll('contacts'))
      .filter(c => !tag || (c.tags || []).includes(tag.replace(/^#/, '')))
      .filter(c => matches(w, c.name, c.org, c.notes, c.pub, c.emails || [], c.phones || [], c.tags || []))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  deleteContact(soul) { return this._del('contacts', soul); }
  onContact(callback) { return this._on('contacts', callback); }

  async importContactsVcf(text) {
    const r = await Promise.allSettled(parseVcf(text).map(c => this.writeContact(c)));
    return { imported: r.filter(x => x.status === 'fulfilled').length, failed: r.filter(x => x.status === 'rejected').length };
  }

  async exportContactsVcf(opts) { return contactsToVcf(await this.readContacts(opts)); }

  // ─── Secrets: passwords, API keys, notes ────────────────────────────

  async writeSecret({ soul = null, name, kind = 'password', username = '', secret, url = '', notes = '', tags = [], createdAt = Date.now() }) {
    if (!name || !String(name).trim()) throw new Error('name is required.');
    if (secret === undefined || secret === null || secret === '') throw new Error('secret is required.');
    return this.put('secrets', soul || this._newSoul('sc-'), { name: String(name).trim(), kind, username, secret: String(secret), url, notes, tags: asList(tags).map(t => t.replace(/^#/, '')), createdAt });
  }

  getSecret(soul) { return this._get('secrets', soul); }

  /** `query` matches name/username/url/notes/tags, never the secret value itself. */
  async readSecrets({ query = null, kind = null, tag = null } = {}) {
    const w = words(query);
    return (await this._readAll('secrets'))
      .filter(x => !kind || x.kind === kind)
      .filter(x => !tag || (x.tags || []).includes(tag.replace(/^#/, '')))
      .filter(x => matches(w, x.name, x.username, x.url, x.notes, x.tags || []))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  deleteSecret(soul) { return this._del('secrets', soul); }

  // ─── Feeds: RSS/Atom subscriptions (the list is encrypted; articles are fetched live) ─────────────

  /** Subscribe to a feed URL. The same URL twice is one subscription. Does not fetch: use fetchFeed() for the title. */
  async addFeed(url, { title = '', folder = '' } = {}) {
    if (!httpUrl(url)) throw new Error('A feed needs an http(s) URL.');
    const soul = (await bookmarkSoul(url)).replace('bm-', 'fd-'), old = await this._get('feeds', soul);
    return this.put('feeds', soul, { url, title: title || old?.title || '', folder: folder || old?.folder || '', addedAt: old?.addedAt || Date.now(), readAt: old?.readAt || 0 });
  }
  async readFeeds() { return (await this._readAll('feeds')).filter((f) => f.url).sort((a, b) => (a.folder || '').localeCompare(b.folder || '') || (a.title || a.url).localeCompare(b.title || b.url)); }
  /** Everything up to `readAt` (default now) counts as read in the unread badge. */
  async markFeedRead(soul, readAt = Date.now()) { const f = await this._get('feeds', soul); if (!f) throw new Error('Unknown feed.'); return this.put('feeds', soul, { ...f, readAt }); }
  /** Rename a feed or move it to another folder ('' = no folder). */
  async updateFeed(soul, { title, folder } = {}) {
    const f = await this._get('feeds', soul);
    if (!f) throw new Error('Unknown feed.');
    const { soul: _s, updatedAt, ...rec } = f;
    return this.put('feeds', soul, { ...rec, ...(title !== undefined && { title }), ...(folder !== undefined && { folder }) });
  }
  deleteFeed(soul) { return this._del('feeds', soul); }
  onFeed(callback) { return this._on('feeds', callback, (f) => f.url); }
  /** Fetch and parse any feed through the server (browsers cannot, CORS). See parseFeed for the shape. */
  async fetchFeed(url) { return parseFeed(await (await this._fetch('GET', '/feed?url=' + encodeURIComponent(url))).text()); }
  /** Like fetchFeed, but also accepts a web page that advertises its feed (<link rel="alternate" type="application/rss+xml">). -> { url, feed } */
  async findFeed(url) {
    const text = await (await this._fetch('GET', '/feed?url=' + encodeURIComponent(url))).text();
    try { return { url, feed: parseFeed(text) }; } catch (_) { /* not a feed: look for the one the page points at */ }
    const link = [...text.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0])).find((a) => /alternate/i.test(a.rel || '') && /rss|atom/i.test(a.type || '') && a.href);
    if (!link) throw new Error('No RSS or Atom feed found at that address');
    const found = new URL(link.href, url).href;
    return { url: found, feed: await this.fetchFeed(found) };
  }
  async importFeedsOpml(xml) {
    const r = await Promise.allSettled(parseOpml(xml).map((f) => this.addFeed(f.url, f)));
    return { imported: r.filter((x) => x.status === 'fulfilled').length, failed: r.filter((x) => x.status === 'rejected').length };
  }
  async exportFeedsOpml() { return feedsToOpml(await this.readFeeds()); }
  onSecret(callback) { return this._on('secrets', callback); }

  // ─── Tasks & Kanban ─────────────────────────────────────────────────

  /**
   * @param {{soul?:string, title:string, status?:string, priority?:string, desc?:string, dueDate?:number|string|null,
   *          tags?:string[]|string, assignee?:string, column?:string, links?:{kind:string, soul:string}[], createdAt?:number, completedAt?:number|null}} task
   */
  async writeTask({ soul = null, ...task }) {
    this._needKey();
    if (!task.title) throw new Error('title is required');
    const status = task.status || 'todo';
    let dueDate = null;
    if (task.dueDate != null && task.dueDate !== '') {
      dueDate = new Date(task.dueDate).getTime();
      if (Number.isNaN(dueDate)) throw new Error('Invalid dueDate');
    }
    checkLinks(task.links);
    const now = Date.now();
    let completedAt = task.completedAt !== undefined ? task.completedAt : null;
    if (status === 'done' && !completedAt) completedAt = now;
    const taskSoul = soul || this._newSoul('task-');
    await this.put('tasks', taskSoul, {
      title: task.title.trim(), status, priority: task.priority || 'medium', desc: task.desc || task.description || '', dueDate,
      tags: asList(task.tags), assignee: task.assignee || '', column: task.column || status, links: task.links || [],
      createdAt: task.createdAt != null ? Number(task.createdAt) : now, completedAt
    });
    return { soul: taskSoul, status: 'saved', updatedAt: now };
  }

  async getTask(soul) { const t = await this._get('tasks', soul); return t && t.title ? t : null; }

  async updateTask(soul, patch) {
    const cur = await this.getTask(soul);
    if (!cur) throw new Error('Task not found: ' + soul);
    return this.writeTask({ ...cur, ...patch, soul });
  }

  /** Open tasks first, then by priority, due date, last update. */
  async readTasks({ status = null, priority = null, tag = null, query = null } = {}) {
    const q = query ? query.toLowerCase() : null, same = (a, b) => (a || '').toLowerCase() === b.toLowerCase();
    const ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };
    return (await this._readAll('tasks'))
      .filter(t => t.title && (!status || same(t.status, status)) && (!priority || same(t.priority, priority)) && (!tag || (t.tags || []).some(x => same(x, tag)))
        && (!q || (t.title + ' ' + (t.desc || '') + ' ' + (t.assignee || '')).toLowerCase().includes(q)))
      .sort((a, b) =>
        (a.status === 'done') - (b.status === 'done')
        || (ORDER[a.priority?.toLowerCase()] ?? 2) - (ORDER[b.priority?.toLowerCase()] ?? 2)
        || (a.dueDate && b.dueDate ? a.dueDate - b.dueDate : !!b.dueDate - !!a.dueDate)
        || (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  deleteTask(soul) { return this._del('tasks', soul); }
  onTask(callback) { return this._on('tasks', callback); }

  async linkToTask(taskSoul, { kind = 'note', soul }) {
    const t = await this.getTask(taskSoul);
    if (!t) throw new Error('Task not found: ' + taskSoul);
    const links = t.links || [];
    if (!links.some(l => l.kind === kind && l.soul === soul)) links.push({ kind, soul });
    return this.writeTask({ ...t, soul: taskSoul, links });
  }

  async unlinkFromTask(taskSoul, { kind = 'note', soul }) {
    const t = await this.getTask(taskSoul);
    if (!t) throw new Error('Task not found: ' + taskSoul);
    return this.writeTask({ ...t, soul: taskSoul, links: (t.links || []).filter(l => !(l.kind === kind && l.soul === soul)) });
  }

  async tasksFor({ kind = 'note', soul }) {
    return (await this.readTasks()).filter(t => (t.links || []).some(l => l.kind === kind && l.soul === soul));
  }

  // ─── Blog (public, plaintext) ───────────────────────────────

  /** Publish (or edit, with the same `id`) a public markdown post. Readable by anyone at /api/u/<username>/posts. */
  async publishBlogPost({ title, content, tags = [], id = null, createdAt = Date.now() }) {
    if (!this.token) throw new Error('Not authenticated.');
    const postId = id || ('post-' + Date.now());
    await this._json('PUT', `/c/posts/${encodeURIComponent(postId)}`, {
      id: postId, title: title.trim(), content: content.trim(), tags: asList(tags).join(', '),
      authorAlias: this.username, authorPub: this.pub, createdAt, deleted: false
    });
    return { id: postId, status: 'published', authorPub: this.pub };
  }

  _post(rec, author) {
    return { id: rec.id || rec.soul, title: rec.title || '', content: rec.content || '', tags: asList(rec.tags), authorAlias: rec.authorAlias || author,
      authorPub: author, createdAt: Number(rec.createdAt) || rec.updatedAt, updatedAt: rec.updatedAt };
  }

  /** Posts of `author` (default: you), newest first. No login needed to read other authors. */
  async readBlogPosts(author = null) {
    const name = String(author || this.pub || '').toLowerCase();
    if (!name) throw new Error('Author username required.');
    const list = await this._json('GET', `/u/${encodeURIComponent(name)}/posts`);
    return list.filter(p => !p.deleted).map(p => this._post(p, name)).sort((a, b) => b.createdAt - a.createdAt);
  }

  async getBlogPost(id, author = null) {
    if (!id) throw new Error('Post id is required.');
    return (await this.readBlogPosts(author)).find(p => p.id === id) || null;
  }

  async deleteBlogPost(id) {
    if (!this.token) throw new Error('Not authenticated.');
    if (!id) throw new Error('Post id required.');
    await this._json('DELETE', `/c/posts/${encodeURIComponent(id)}`);
    return { id, status: 'deleted', authorPub: this.pub };
  }

  /** callback(post, id, isDeleted). Your own posts stream live; another author's are polled every 5s. */
  onPost(author, callback) {
    const name = String(author || this.pub || '').toLowerCase();
    if (!name) throw new Error('Author username required.');
    if (name === this.pub && this.token) {
      return this._on('posts', (r, id, deleted) => callback(deleted ? null : this._post(r, name), id, deleted), (r) => !r.deleted, true);
    }
    const seen = new Map();
    const poll = async () => {
      let list; try { list = await this.readBlogPosts(name); } catch (_) { return; }
      const ids = new Set(list.map(p => p.id));
      for (const p of list) if (seen.get(p.id) !== p.updatedAt) { seen.set(p.id, p.updatedAt); callback(p, p.id, false); }
      for (const id of seen.keys()) if (!ids.has(id)) { seen.delete(id); callback(null, id, true); }
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }

  writeBlogPost(post) { return this.publishBlogPost(post); }

  /** The username is the blog alias; nothing to register. Kept so older callers keep working. */
  async registerAlias() { return { alias: this.username, pub: this.pub }; }

  /** @returns {Promise<string|null>} the username if that user exists */
  async resolveAlias(alias) {
    if (!alias) throw new Error('Alias is required.');
    try { return (await this._json('GET', '/u/' + encodeURIComponent(alias.trim().toLowerCase()))).name; }
    catch (e) { if (e.status === 404) return null; throw e; }
  }
}

export { Orto as ZenOS }; // old name, for existing callers
export default Orto;
