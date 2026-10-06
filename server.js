#!/usr/bin/env node
/**
 * Orto server (formerly ZenOS): your personal workspace on a server you run.
 * One SQLite file (records, users, sessions) + a folder of uploaded blobs, zero npm dependencies.
 * Requires Node >= 22.5 (built-in node:sqlite).
 *
 * The server never sees plaintext of private collections: clients encrypt (AES-GCM) before PUT.
 * Only the `posts` collection (public blog) is stored and served in clear.
 *
 * Backup: node server.js backup <folder>  (database + uploads; restore by stopping the server and using the folder as ORTO_DATA).
 * Env: PORT (8787), HOST (127.0.0.1), ORTO_DATA (./data), ORTO_WEB (./web),
 *      ORTO_REGISTRATION=open|closed (open), ORTO_MAX_UPLOAD bytes (200MB), ORTO_QUOTA bytes per user (5GB)
 *      ORTO_DEMO=1 turns on a public demo account (demo / demo) that is wiped and refilled with random fake data every
 *      ORTO_DEMO_HOURS (3) hours; sharing, the public blog and password change are off for it.
 *      ORTO_ADMIN_PASS (min 8 chars) turns on the admin panel at /admin: settings (registration, upload size, quota) edited
 *      from the browser and saved in the database (they override the env values), user list/removal, backups. Off when unset.
 *      ORTO_MODELS (<data>/models) is the folder served at /models/* (optional on-device add-ons, see scripts/install-gist.mjs).
 *      Pages: / the web app, /about the project landing page, /app the web app (same URLs as the hosted site), /admin the admin panel.
 *      (the old ZENOS_* names still work)
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Orto, deriveKeys } from './orto.js';
import { seedDemo } from './demo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const NAME = /^[a-z0-9][a-z0-9_.-]{1,31}$/;
const SEG = /^[\w.:-]{1,128}$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.mjs': 'text/javascript; charset=utf-8' };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function readBody(req, limit) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new HttpError(413, 'Payload too large'); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function readJson(req, limit = 8e6) {
  const raw = (await readBody(req, limit)).toString() || '{}';
  try { const v = JSON.parse(raw); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch (_) {}
  throw new HttpError(400, 'Body must be a JSON object');
}

// settings come from ORTO_*; the old ZENOS_* names still work
const settings = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ZENOS_')).map(([k, v]) => ['ORTO_' + k.slice(6), v])), ...process.env };

// ── Feeds ──────────────────────────────────────────────────────────────────────────────────────────────────
// Reader: browsers cannot fetch other sites' feeds (CORS), so a logged-in user asks the server to fetch one (GET /api/feed?url=).
// The server only relays the XML; it is parsed in the browser. Private/loopback addresses are refused (SSRF), checked at connect time.
const isPrivateIp = (ip) => {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip); if (m) ip = m[1];
  if (net.isIPv6(ip)) return /^(::1?$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(ip);
  return /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|2(2[4-9]|[3-5]\d)\.)/.test(ip);
};
function fetchFeed(target, { allowPrivate = false, hops = 3, maxBytes = 2e6, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch (_) { return reject(new HttpError(400, 'Bad feed URL')); }
    if (!/^https?:$/.test(u.protocol)) return reject(new HttpError(400, 'Only http(s) feeds'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(host) && isPrivateIp(host)) return reject(new HttpError(400, 'Private addresses are not allowed'));
    const lookup = (h, o, cb) => dns.lookup(h, o, (err, addr, fam) => {
      if (err) return cb(err);
      const list = Array.isArray(addr) ? addr : [{ address: addr, family: fam }];
      if (!allowPrivate && list.some((x) => isPrivateIp(x.address))) return cb(new Error('Private addresses are not allowed'));
      cb(null, addr, fam);
    });
    const req = (u.protocol === 'https:' ? https : http).get(u, { lookup, timeout, headers: { 'User-Agent': 'Orto feed reader', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        if (!hops) return reject(new HttpError(502, 'Too many redirects'));
        return fetchFeed(new URL(r.headers.location, u).href, { allowPrivate, hops: hops - 1, maxBytes, timeout }).then(resolve, reject);
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new HttpError(502, 'Feed answered ' + r.statusCode)); }
      const chunks = []; let n = 0;
      r.on('data', (d) => { n += d.length; if (n > maxBytes) { req.destroy(); reject(new HttpError(502, 'Feed is too big')); } else chunks.push(d); });
      r.on('end', () => resolve(Buffer.concat(chunks)));
      r.on('error', () => reject(new HttpError(502, 'Could not read the feed')));
    });
    req.on('timeout', () => { req.destroy(); reject(new HttpError(504, 'The feed took too long')); });
    req.on('error', (e) => reject(e instanceof HttpError ? e : new HttpError(502, /private/i.test(e.message) ? 'Private addresses are not allowed' : 'Could not reach the feed')));
  });
}
const xmlEsc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const cdata = (t) => '<![CDATA[' + String(t).replace(/\]\]>/g, ']]]]><![CDATA[>') + ']]>';

export function createServer(opts = {}) {
  const env = settings;
  const dataDir = path.resolve(opts.dataDir || env.ORTO_DATA || path.join(process.cwd(), 'data'));
  const webDir = path.resolve(opts.webDir || env.ORTO_WEB || path.join(here, 'web'));
  const defaults = {
    registration: opts.registration || env.ORTO_REGISTRATION || 'open',
    maxUpload: Number(opts.maxUpload || env.ORTO_MAX_UPLOAD || 200 * 1024 * 1024),
    quota: Number(opts.quota || env.ORTO_QUOTA || 5 * 1024 ** 3)
  };
  const adminPass = String(opts.adminPass || env.ORTO_ADMIN_PASS || '');
  const adminOn = adminPass.length >= 8;
  const demoOn = opts.demo ?? !['', '0', 'false', undefined].includes(env.ORTO_DEMO);
  const demoHours = Number(opts.demoHours || env.ORTO_DEMO_HOURS || 3);
  const DEMO = { user: 'demo', pass: 'demo', quota: 10 * 1024 ** 2, maxRecords: 1000, maxFiles: 40 };
  const modelsDir = path.resolve(opts.modelsDir || env.ORTO_MODELS || path.join(dataDir, 'models')); // optional add-ons, served at /models/*
  const feedsPrivate = opts.feedsPrivate ?? ['1', 'true'].includes(env.ORTO_FEEDS_PRIVATE); // let the feed reader reach private addresses (LAN feeds)
  const publicUrl = opts.publicUrl || env.ORTO_PUBLIC_URL || ''; // base of the links in the blog's RSS feed; default: the Host of the request
  const filesDir = path.join(dataDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  // unfinished chunked uploads (see /files/begin) older than a day
  for (const d of fs.readdirSync(filesDir)) {
    try { for (const f of fs.readdirSync(path.join(filesDir, d))) { const p = path.join(filesDir, d, f); if (f.endsWith('.part') && Date.now() - fs.statSync(p).mtimeMs > 864e5) fs.rmSync(p); } } catch (_) { }
  }

  // zenos.db is the file name from before the rename: keep using it if that is what is on disk
  const dbFile = ['orto.db', 'zenos.db'].map(f => path.join(dataDir, f)).find(f => fs.existsSync(f)) || path.join(dataDir, 'orto.db');
  const db = new DatabaseSync(dbFile);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, auth_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS records (user_id INTEGER NOT NULL REFERENCES users(id), coll TEXT NOT NULL, soul TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, coll, soul));
    CREATE TABLE IF NOT EXISTS files (user_id INTEGER NOT NULL REFERENCES users(id), id TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (user_id, id));
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), file_id TEXT, data TEXT, created_at INTEGER NOT NULL);
  `);
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  // settings saved from the admin panel win over the env defaults
  const cfg = { ...defaults };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) if (r.key in cfg) cfg[r.key] = r.key === 'registration' ? r.value : Number(r.value);
  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE name = ?'),
    addUser: db.prepare('INSERT INTO users (name, auth_hash, created_at) VALUES (?, ?, ?)'),
    addSession: db.prepare('INSERT INTO sessions VALUES (?, ?, ?)'),
    session: db.prepare('SELECT s.user_id, s.expires, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'),
    list: db.prepare('SELECT soul, data, updated_at FROM records WHERE user_id = ? AND coll = ?'),
    get: db.prepare('SELECT soul, data, updated_at FROM records WHERE user_id = ? AND coll = ? AND soul = ?'),
    put: db.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, coll, soul) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'),
    del: db.prepare('DELETE FROM records WHERE user_id = ? AND coll = ? AND soul = ?'),
    addFile: db.prepare('INSERT INTO files VALUES (?, ?, ?)'),
    file: db.prepare('SELECT size FROM files WHERE user_id = ? AND id = ?'),
    delFile: db.prepare('DELETE FROM files WHERE user_id = ? AND id = ?'),
    setFileSize: db.prepare('UPDATE files SET size = ? WHERE user_id = ? AND id = ?'),
    addShare: db.prepare('INSERT INTO shares VALUES (?, ?, ?, ?, ?)'),
    share: db.prepare('SELECT user_id, file_id, data FROM shares WHERE id = ?'),
    delShare: db.prepare('DELETE FROM shares WHERE id = ? AND user_id = ?'),
    setAuth: db.prepare('UPDATE users SET auth_hash = ? WHERE id = ?'),
    dropSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    used: db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE user_id = ?')
  };

  const toRecord = (r) => ({ soul: r.soul, ...JSON.parse(r.data), updatedAt: r.updated_at });
  const listeners = new Map(); // user_id -> Set<ServerResponse>
  const emit = (uid, evt) => { for (const res of listeners.get(uid) || []) res.write('data: ' + JSON.stringify(evt) + '\n\n'); };

  // ponytail: in-memory login throttle, resets on restart; put a reverse proxy rate limit in front for more
  const fails = new Map();
  const throttled = (key) => { const f = fails.get(key); return f && f.n >= 10 && f.until > Date.now(); };
  const failed = (key) => { const f = fails.get(key) || { n: 0 }; f.n++; f.until = Date.now() + 15 * 60e3; fails.set(key, f); };

  function authed(req) {
    const t = (req.headers.authorization || '').replace(/^Bearer /, '');
    const s = t && q.session.get(sha(t));
    if (!s || s.expires < Date.now()) throw new HttpError(401, 'Unauthorized');
    return s;
  }
  const newSession = (uid) => {
    const token = crypto.randomBytes(32).toString('hex');
    q.addSession.run(sha(token), uid, Date.now() + 30 * 864e5);
    return token;
  };

  // Stream the request body to disk (new file, or replace `id` in place). Written to a temp file first so a failed upload never damages the old blob.
  async function saveUpload(u, req, id = null) {
    const old = id && q.file.get(u.user_id, id);
    const limit = demoOn && u.name === DEMO.user ? DEMO.quota : cfg.quota;
    const used = q.used.get(u.user_id).n - (old ? old.size : 0);
    if (used + Number(req.headers['content-length'] || 0) > limit) throw new HttpError(413, 'Storage quota exceeded');
    id = id || crypto.randomBytes(12).toString('hex');
    const dir = path.join(filesDir, String(u.user_id));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, id), tmp = file + '.part', out = fs.createWriteStream(tmp);
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > cfg.maxUpload || used + size > limit) throw new HttpError(413, 'File too large');
        if (!out.write(chunk)) await once(out, 'drain');
      }
      out.end(); await once(out, 'finish');
      fs.renameSync(tmp, file);
    } catch (e) { out.destroy(); fs.rmSync(tmp, { force: true }); throw e; }
    if (old) q.setFileSize.run(size, u.user_id, id); else q.addFile.run(u.user_id, id, size);
    return { id, size };
  }
  const dropFile = (uid, id) => { q.delFile.run(uid, id); fs.rmSync(path.join(filesDir, String(uid), id), { force: true }); };

  // Admin panel API: separate in-memory bearer tokens (12 h), never a user session
  const adminTokens = new Map();
  async function admin(req, json, b, c, d) {
    if (!adminOn) throw new HttpError(404, 'Admin panel is off: set ORTO_ADMIN_PASS (min 8 chars)');
    if (b === 'login' && req.method === 'POST') {
      const { pass } = await readJson(req, 1e4);
      const key = req.socket.remoteAddress + '|admin';
      if (throttled(key)) throw new HttpError(429, 'Too many attempts, try again later');
      if (typeof pass !== 'string' || !crypto.timingSafeEqual(Buffer.from(sha(pass)), Buffer.from(sha(adminPass)))) { failed(key); throw new HttpError(401, 'Wrong admin password'); }
      fails.delete(key);
      const token = crypto.randomBytes(32).toString('hex');
      adminTokens.set(sha(token), Date.now() + 12 * 36e5);
      return json(200, { token });
    }
    const exp = adminTokens.get(sha((req.headers.authorization || '').replace(/^Bearer /, '')));
    if (!exp || exp < Date.now()) throw new HttpError(401, 'Unauthorized');

    if (b === 'settings') {
      if (req.method === 'PUT') { // {key: value} sets, {key: null} goes back to the env default
        const body = await readJson(req, 1e4);
        for (const [k, v] of Object.entries(body)) {
          if (!(k in defaults)) throw new HttpError(400, 'Unknown setting: ' + k);
          if (v !== null && (k === 'registration' ? !['open', 'closed'].includes(v) : !(Number.isFinite(v) && v >= 1))) throw new HttpError(400, 'Bad value for ' + k);
        }
        for (const [k, v] of Object.entries(body)) {
          if (v === null) { db.prepare('DELETE FROM settings WHERE key = ?').run(k); cfg[k] = defaults[k]; }
          else { db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(k, String(v)); cfg[k] = v; }
        }
      }
      return json(200, { settings: cfg, defaults, demo: demoOn, dataDir });
    }
    if (b === 'users' && !c && req.method === 'GET') {
      return json(200, db.prepare(`SELECT u.name, u.created_at AS createdAt,
        (SELECT COUNT(*) FROM records WHERE user_id = u.id) AS records,
        (SELECT COUNT(*) FROM files WHERE user_id = u.id) AS files,
        (SELECT COALESCE(SUM(size), 0) FROM files WHERE user_id = u.id) AS bytes,
        (SELECT COUNT(*) FROM sessions WHERE user_id = u.id AND expires > ?) AS sessions
        FROM users u ORDER BY u.id`).all(Date.now()));
    }
    if (b === 'users' && c) {
      const user = q.userByName.get(c);
      if (!user) throw new HttpError(404, 'Unknown user');
      if (d === 'logout' && req.method === 'POST') { q.dropSessions.run(user.id, ''); return json(200, { name: c, loggedOut: true }); }
      if (!d && req.method === 'DELETE') { // data is end-to-end encrypted: there is no password reset, only removal
        for (const t of ['records', 'shares', 'files', 'sessions']) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(user.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
        fs.rmSync(path.join(filesDir, String(user.id)), { recursive: true, force: true });
        for (const r of listeners.get(user.id) || []) r.end();
        return json(200, { name: c, deleted: true });
      }
    }
    if (b === 'backup' && req.method === 'POST') {
      const out = path.join(dataDir, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
      return json(200, { path: server.backup(out) });
    }
    throw new HttpError(404, 'Not found');
  }

  async function api(req, res, url) {
    const parts = url.pathname.split('/').slice(2).map(decodeURIComponent); // after /api
    const [a, b, c] = parts;
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    for (const p of parts) if (!SEG.test(p)) throw new HttpError(400, 'Bad path');

    if (a === 'health') return json(200, { ok: true, name: 'orto' });

    if (a === 'config') return json(200, { registration: cfg.registration, maxUpload: cfg.maxUpload, ...(demoOn && { demo: { user: DEMO.user, pass: DEMO.pass, hours: demoHours } }) });

    if ((a === 'register' || a === 'login') && req.method === 'POST') {
      const { name: raw, auth } = await readJson(req, 1e4);
      const name = String(raw || '').trim().toLowerCase();
      if (!NAME.test(name)) throw new HttpError(400, 'Username: 2-32 chars, a-z 0-9 _ . -');
      if (typeof auth !== 'string' || auth.length < 32 || auth.length > 128) throw new HttpError(400, 'Bad auth key');
      const key = req.socket.remoteAddress + '|' + name;
      if (throttled(key)) throw new HttpError(429, 'Too many attempts, try again later');
      const hash = sha(auth);
      if (a === 'register') {
        if (cfg.registration !== 'open') throw new HttpError(403, 'Registration is closed');
        try { q.addUser.run(name, hash, Date.now()); } catch (_) { throw new HttpError(409, 'Username taken'); }
      }
      const user = q.userByName.get(name);
      if (!user) throw new HttpError(404, 'Unknown user');
      const ok = crypto.timingSafeEqual(Buffer.from(sha(hash)), Buffer.from(sha(user.auth_hash)));
      if (!ok) { failed(key); throw new HttpError(401, 'Wrong username or password'); }
      fails.delete(key);
      return json(200, { token: newSession(user.id), name });
    }

    // public: author handle + published posts
    if (a === 'u') {
      const user = q.userByName.get(String(b || '').toLowerCase());
      if (!user) throw new HttpError(404, 'Unknown user');
      if (!c) return json(200, { name: user.name });
      if (c === 'posts') return json(200, q.list.all(user.id, 'posts').map(toRecord));
      throw new HttpError(404, 'Not found');
    }

    // public share: the server only holds ciphertext, the key lives in the link's #fragment
    if (a === 's' && b && req.method === 'GET') {
      const sh = /^[a-f0-9]{32}$/.test(b) && q.share.get(b);
      if (!sh) throw new HttpError(404, 'Not found');
      if (!sh.file_id) return json(200, { data: sh.data });
      const file = path.join(filesDir, String(sh.user_id), sh.file_id);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(file).size });
      return void fs.createReadStream(file).pipe(res);
    }

    if (a === 'admin') return admin(req, json, b, c, parts[3]);

    const u = authed(req);

    if (demoOn && u.name === DEMO.user) { // the demo account is public: no sharing, no public posts, no password change, bounded size
      const off = (a === 'password') || (a === 'feed') || (a === 's' && req.method !== 'GET') || (a === 'c' && b === 'posts' && req.method !== 'GET');
      const full = (a === 'c' && req.method === 'PUT' && db.prepare('SELECT COUNT(*) AS n FROM records WHERE user_id = ?').get(u.user_id).n >= DEMO.maxRecords)
        || (a === 'files' && req.method === 'POST' && db.prepare('SELECT COUNT(*) AS n FROM files WHERE user_id = ?').get(u.user_id).n >= DEMO.maxFiles);
      if (off || full) throw new HttpError(403, 'Not available in the demo');
    }

    if (a === 'feed' && req.method === 'GET') { // relay one feed's XML for the reader
      const body = await fetchFeed(url.searchParams.get('url') || '', { allowPrivate: feedsPrivate });
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      return void res.end(body);
    }

    if (a === 'events') { // live updates of the user's own collections (SSE)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': ok\n\n');
      if (!listeners.has(u.user_id)) listeners.set(u.user_id, new Set());
      listeners.get(u.user_id).add(res);
      const beat = setInterval(() => res.write(': hb\n\n'), 25000);
      req.on('close', () => { clearInterval(beat); listeners.get(u.user_id)?.delete(res); });
      return;
    }

    if (a === 'c' && b) {
      if (!c) {
        if (req.method === 'GET') return json(200, q.list.all(u.user_id, b).map(toRecord));
        throw new HttpError(405, 'Method not allowed');
      }
      if (req.method === 'GET') {
        const r = q.get.get(u.user_id, b, c);
        if (!r) throw new HttpError(404, 'Not found');
        return json(200, toRecord(r));
      }
      if (req.method === 'PUT') {
        const body = await readJson(req);
        delete body.soul; delete body.updatedAt;
        const now = Date.now();
        q.put.run(u.user_id, b, c, JSON.stringify(body), now);
        emit(u.user_id, { coll: b, soul: c, deleted: false, record: { soul: c, ...body, updatedAt: now } });
        return json(200, { soul: c, updatedAt: now });
      }
      if (req.method === 'DELETE') {
        q.del.run(u.user_id, b, c);
        emit(u.user_id, { coll: b, soul: c, deleted: true });
        return json(200, { soul: c, deleted: true });
      }
    }

    if (a === 'password' && req.method === 'POST') { // the client re-encrypted everything first; this swaps the login secret and signs out every other session
      const { auth, newAuth, check } = await readJson(req, 1e4);
      for (const v of [auth, newAuth]) if (typeof v !== 'string' || v.length < 32 || v.length > 128) throw new HttpError(400, 'Bad auth key');
      const key = req.socket.remoteAddress + '|' + u.name;
      if (throttled(key)) throw new HttpError(429, 'Too many attempts, try again later');
      const user = q.userByName.get(u.name);
      if (!crypto.timingSafeEqual(Buffer.from(sha(sha(auth))), Buffer.from(sha(user.auth_hash)))) { failed(key); throw new HttpError(401, 'Wrong password'); }
      if (check) return json(200, { ok: true, check: true }); // dry run: lets the client fail before it re-encrypts anything
      q.setAuth.run(sha(newAuth), user.id);
      q.dropSessions.run(user.id, sha((req.headers.authorization || '').replace(/^Bearer /, '')));
      return json(200, { ok: true });
    }

    if (a === 's') {
      if (req.method === 'POST' && !b) { // JSON {data:"e1..."} = text share, raw bytes = file share
        const id = crypto.randomBytes(16).toString('hex');
        if (String(req.headers['content-type'] || '').startsWith('application/json')) {
          const { data } = await readJson(req);
          if (typeof data !== 'string' || !data.startsWith('e1.')) throw new HttpError(400, 'data must be ciphertext');
          q.addShare.run(id, u.user_id, null, data, Date.now());
        } else {
          const f = await saveUpload(u, req);
          q.addShare.run(id, u.user_id, f.id, null, Date.now());
        }
        return json(200, { id });
      }
      if (req.method === 'DELETE' && b) {
        const sh = q.share.get(b);
        if (!sh || sh.user_id !== u.user_id) throw new HttpError(404, 'Not found');
        q.delShare.run(b, u.user_id);
        if (sh.file_id) dropFile(u.user_id, sh.file_id);
        return json(200, { id: b, deleted: true });
      }
    }

    // Chunked upload, for big files and playback: begin -> append (X-Offset must equal the bytes stored so far) ... -> finish.
    // The client cuts the file in encrypted chunks (see orto.js uploadFileChunked), so memory stays small on both sides.
    // finish?replace=<id> swaps the new content into an existing file (used to re-encrypt after a password change).
    if (a === 'files' && b === 'begin' && req.method === 'POST') {
      const id = crypto.randomBytes(12).toString('hex');
      fs.mkdirSync(path.join(filesDir, String(u.user_id)), { recursive: true });
      fs.writeFileSync(path.join(filesDir, String(u.user_id), id + '.part'), '');
      return json(200, { id });
    }
    if (a === 'files' && /^[a-f0-9]{24}$/.test(b || '') && (c === 'append' || c === 'finish') && ((c === 'append' && req.method === 'PUT') || (c === 'finish' && req.method === 'POST'))) {
      const part = path.join(filesDir, String(u.user_id), b + '.part');
      if (!fs.existsSync(part)) throw new HttpError(404, 'Not found');
      const have = fs.statSync(part).size;
      if (c === 'append') {
        if (Number(req.headers['x-offset']) !== have) throw new HttpError(409, 'Offset mismatch: ' + have);
        const limit = demoOn && u.name === DEMO.user ? DEMO.quota : cfg.quota;
        const used = q.used.get(u.user_id).n;
        const out = fs.createWriteStream(part, { flags: 'a' });
        let size = have;
        try {
          for await (const chunk of req) {
            size += chunk.length;
            if (size > cfg.maxUpload || used + size > limit) throw new HttpError(413, size > cfg.maxUpload ? 'File too large' : 'Storage quota exceeded');
            if (!out.write(chunk)) await once(out, 'drain');
          }
          out.end(); await once(out, 'finish');
        } catch (e) { out.destroy(); fs.truncateSync(part, have); throw e; } // back to the last good size: the client can retry the chunk
        return json(200, { size });
      }
      const size = fs.statSync(part).size, replace = url.searchParams.get('replace');
      if (replace) {
        if (!/^[a-f0-9]{24}$/.test(replace) || !q.file.get(u.user_id, replace)) throw new HttpError(404, 'Not found');
        fs.renameSync(part, path.join(filesDir, String(u.user_id), replace)); q.setFileSize.run(size, u.user_id, replace);
        return json(200, { id: replace, size });
      }
      fs.renameSync(part, path.join(filesDir, String(u.user_id), b)); q.addFile.run(u.user_id, b, size);
      return json(200, { id: b, size });
    }

    if (a === 'files') {
      if (req.method === 'POST' && !b) return json(200, await saveUpload(u, req));
      const f = b && q.file.get(u.user_id, b);
      if (!f) throw new HttpError(404, 'Not found');
      if (req.method === 'GET') { // supports one Range: the browser asks for pieces of media, and encrypted chunks are fetched one by one
        const file = path.join(filesDir, String(u.user_id), b), rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (rg && (rg[1] || rg[2])) {
          const start = rg[1] === '' ? Math.max(0, f.size - Number(rg[2])) : Number(rg[1]);
          const end = rg[1] === '' || rg[2] === '' ? f.size - 1 : Math.min(Number(rg[2]), f.size - 1);
          if (!(start <= end && start < f.size)) { res.writeHead(416, { 'Content-Range': 'bytes */' + f.size }); return res.end(); }
          res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${f.size}`, 'Accept-Ranges': 'bytes' });
          return void fs.createReadStream(file, { start, end }).pipe(res);
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.size, 'Accept-Ranges': 'bytes' });
        return void fs.createReadStream(file).pipe(res);
      }
      if (req.method === 'PUT') return json(200, await saveUpload(u, req, b));
      if (req.method === 'DELETE') {
        dropFile(u.user_id, b);
        return json(200, { id: b, deleted: true });
      }
    }
    throw new HttpError(404, 'Not found');
  }

  // /blog/<name>/feed.xml: RSS 2.0 of the public posts (newest 50). Links point at this server (ORTO_PUBLIC_URL, or the Host the request came with).
  function blogFeed(req, res, name) {
    const user = q.userByName.get(name.toLowerCase());
    if (!user) throw new HttpError(404, 'Unknown user');
    const base = (publicUrl || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host || 'localhost'}`).replace(/\/+$/, '');
    const posts = q.list.all(user.id, 'posts').map(toRecord).filter((p) => !p.deleted && p.title).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
    const home = `${base}/blog/${encodeURIComponent(user.name)}`;
    const para = (t) => String(t || '').split(/\n{2,}/).map((x) => '<p>' + xmlEsc(x.trim()).replace(/\n/g, '<br>') + '</p>').join('');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
<title>${xmlEsc(user.name)}</title>
<link>${xmlEsc(home)}</link>
<description>${xmlEsc('Posts by ' + user.name)}</description>
<atom:link href="${xmlEsc(home + '/feed.xml')}" rel="self" type="application/rss+xml"/>
${posts.length ? `<lastBuildDate>${new Date(posts[0].createdAt).toUTCString()}</lastBuildDate>` : ''}
${posts.map((p) => {
      const link = `${home}?post=${encodeURIComponent(p.id || p.soul)}`;
      return `<item><title>${xmlEsc(p.title)}</title><link>${xmlEsc(link)}</link><guid isPermaLink="true">${xmlEsc(link)}</guid><pubDate>${new Date(p.createdAt).toUTCString()}</pubDate><description>${xmlEsc(String(p.content || '').replace(/\s+/g, ' ').slice(0, 300))}</description><content:encoded>${cdata(para(p.content))}</content:encoded></item>`;
    }).join('\n')}
</channel>
</rss>
`;
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(xml);
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel.startsWith('/blog/')) rel = '/blog.html';
    else if (rel.startsWith('/s/')) rel = '/share.html';
    else if (rel === '/admin') rel = '/admin.html';
    else if (rel === '/about' || rel === '/about/') rel = '/about.html'; // the project landing page
    else if (rel === '/app') rel = '/index.html'; // same URLs as the hosted site: /app is the web app
    else if (rel.startsWith('/app/')) rel = rel.slice(4);
    if (rel.endsWith('/')) rel += 'index.html';
    // /models/* is the models folder (default <data>/models, or ORTO_MODELS): optional add-ons installed by the admin (scripts/install-gist.mjs); nothing else of the data folder is reachable
    const root = rel.startsWith('/models/') ? modelsDir : webDir;
    if (root !== webDir) rel = rel.slice('/models'.length);
    // the SDK lives next to this file (not in web/) so the CLI and the browser share one copy
    const file = rel === '/orto.js' && root === webDir ? path.join(here, 'orto.js') : path.normalize(path.join(root, rel));
    if ((!(rel === '/orto.js' && root === webDir) && !file.startsWith(root + path.sep)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); // bearer tokens, no cookies: safe to open
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range, X-Offset');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
      const url = new URL(req.url, 'http://x');
      const feed = /^\/blog\/([^/]+)\/feed\.xml$/.exec(url.pathname);
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else if (feed && req.method === 'GET') blogFeed(req, res, decodeURIComponent(feed[1]));
      else serveStatic(req, res, url);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      if (res.headersSent) return res.end();
      res.writeHead(e.status || 500, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: e.status ? e.message : 'Internal error' }));
    }
  });
  server.on('close', () => db.close());
  // Public demo: wipe the demo account and refill it with random fake data through the normal API (so it is encrypted like real data).
  // Never touches a user named "demo" that has another password: that is a real account.
  if (demoOn) {
    let busy = null;
    const reset = () => busy ||= (async () => {
      const { name, auth } = await deriveKeys(DEMO.user, DEMO.pass);
      let user = q.userByName.get(name);
      if (user && user.auth_hash !== sha(auth)) throw new Error(`a user named "${name}" already exists with another password: not touching it, demo is off`);
      if (!user) { q.addUser.run(name, sha(auth), Date.now()); user = q.userByName.get(name); }
      for (const t of ['records', 'shares', 'files', 'sessions']) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(user.id);
      fs.rmSync(path.join(filesDir, String(user.id)), { recursive: true, force: true });
      const os = new Orto({ server: 'http://127.0.0.1:' + server.address().port });
      try { await os.login(DEMO.user, DEMO.pass); return await seedDemo(os, { hours: demoHours }); } finally { os.close(); }
    })().finally(() => { busy = null; });
    server.resetDemo = reset;
    server.once('listening', () => {
      server.demoReady = reset();
      server.demoReady.catch((e) => console.error('demo:', e.message));
      const t = setInterval(() => reset().catch((e) => console.error('demo:', e.message)), demoHours * 36e5);
      t.unref(); server.on('close', () => clearInterval(t));
    });
  }
  // Consistent copy of everything: the database (VACUUM INTO is safe while the server runs) plus the uploads folder.
  // Restore = stop the server and put the copy back as the data folder.
  server.backup = (out) => {
    out = path.resolve(out);
    fs.mkdirSync(out, { recursive: true });
    const copy = path.join(out, 'orto.db');
    if (fs.existsSync(copy)) throw new Error(copy + ' already exists');
    db.prepare('VACUUM INTO ?').run(copy);
    fs.cpSync(filesDir, path.join(out, 'files'), { recursive: true, filter: (f) => !f.endsWith('.part') });
    return out;
  };
  return server;
}

// realpath: npx / npm link start us through a symlink in node_modules/.bin
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === 'backup') { // node server.js backup <folder>
    if (!process.argv[3]) { console.error('Usage: node server.js backup <folder>'); process.exit(1); }
    console.log('Backup written to ' + createServer().backup(process.argv[3]));
    process.exit(0);
  }
  const port = Number(process.env.PORT || 8787), host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => console.log(`Orto server on http://${host}:${port}`));
  if (!(settings.ORTO_ADMIN_PASS || '').length) console.log('Admin panel off (set ORTO_ADMIN_PASS, min 8 chars, to use /admin)');
  if (!['', '0', 'false', undefined].includes(settings.ORTO_DEMO)) console.log('Demo account on: user demo, password demo (reset every ' + (settings.ORTO_DEMO_HOURS || 3) + ' h)');
}
