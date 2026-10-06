#!/usr/bin/env node
/**
 * ZenOS server: SQLite + file uploads behind a small HTTP API.
 * One SQLite file (records, users, sessions) + a folder of uploaded blobs, zero npm dependencies.
 * Requires Node >= 22.5 (built-in node:sqlite).
 *
 * The server never sees plaintext of private collections: clients encrypt (AES-GCM) before PUT.
 * Only the `posts` collection (public blog) is stored and served in clear.
 *
 * Env: PORT (8787), HOST (127.0.0.1), ZENOS_DATA (./data), ZENOS_WEB (../zenos-web/app or ./web),
 *      ZENOS_REGISTRATION=open|closed (open), ZENOS_MAX_UPLOAD bytes (200MB), ZENOS_QUOTA bytes per user (5GB)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const NAME = /^[a-z0-9][a-z0-9_.-]{1,31}$/;
const SEG = /^[\w.:-]{1,128}$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

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

export function createServer(opts = {}) {
  const env = process.env;
  const dataDir = path.resolve(opts.dataDir || env.ZENOS_DATA || path.join(process.cwd(), 'data'));
  const webDir = path.resolve(opts.webDir || env.ZENOS_WEB || (fs.existsSync(path.join(here, '../zenos-web/app')) ? path.join(here, '../zenos-web/app') : path.join(here, 'web')));
  const registration = opts.registration || env.ZENOS_REGISTRATION || 'open';
  const maxUpload = Number(opts.maxUpload || env.ZENOS_MAX_UPLOAD || 200 * 1024 * 1024);
  const quota = Number(opts.quota || env.ZENOS_QUOTA || 5 * 1024 ** 3);
  const filesDir = path.join(dataDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  const db = new DatabaseSync(path.join(dataDir, 'zenos.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, auth_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS records (user_id INTEGER NOT NULL REFERENCES users(id), coll TEXT NOT NULL, soul TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, coll, soul));
    CREATE TABLE IF NOT EXISTS files (user_id INTEGER NOT NULL REFERENCES users(id), id TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (user_id, id));
  `);
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
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

  async function api(req, res, url) {
    const parts = url.pathname.split('/').slice(2).map(decodeURIComponent); // after /api
    const [a, b, c] = parts;
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    for (const p of parts) if (!SEG.test(p)) throw new HttpError(400, 'Bad path');

    if (a === 'health') return json(200, { ok: true, name: 'zenos' });

    if (a === 'config') return json(200, { registration, maxUpload });

    if ((a === 'register' || a === 'login') && req.method === 'POST') {
      const { name: raw, auth } = await readJson(req, 1e4);
      const name = String(raw || '').trim().toLowerCase();
      if (!NAME.test(name)) throw new HttpError(400, 'Username: 2-32 chars, a-z 0-9 _ . -');
      if (typeof auth !== 'string' || auth.length < 32 || auth.length > 128) throw new HttpError(400, 'Bad auth key');
      const key = req.socket.remoteAddress + '|' + name;
      if (throttled(key)) throw new HttpError(429, 'Too many attempts, try again later');
      const hash = sha(auth);
      if (a === 'register') {
        if (registration !== 'open') throw new HttpError(403, 'Registration is closed');
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

    const u = authed(req);

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

    if (a === 'files') {
      if (req.method === 'POST' && !b) {
        const used = q.used.get(u.user_id).n;
        if (used + Number(req.headers['content-length'] || 0) > quota) throw new HttpError(413, 'Storage quota exceeded');
        const id = crypto.randomBytes(12).toString('hex');
        const dir = path.join(filesDir, String(u.user_id));
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, id), out = fs.createWriteStream(file);
        let size = 0;
        try {
          for await (const chunk of req) {
            size += chunk.length;
            if (size > maxUpload || used + size > quota) throw new HttpError(413, 'File too large');
            if (!out.write(chunk)) await once(out, 'drain');
          }
          out.end(); await once(out, 'finish');
        } catch (e) { out.destroy(); fs.rmSync(file, { force: true }); throw e; }
        q.addFile.run(u.user_id, id, size);
        return json(200, { id, size });
      }
      const f = b && q.file.get(u.user_id, b);
      if (!f) throw new HttpError(404, 'Not found');
      const file = path.join(filesDir, String(u.user_id), b);
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.size });
        return void fs.createReadStream(file).pipe(res);
      }
      if (req.method === 'DELETE') {
        q.delFile.run(u.user_id, b); fs.rmSync(file, { force: true });
        return json(200, { id: b, deleted: true });
      }
    }
    throw new HttpError(404, 'Not found');
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel.startsWith('/blog/')) rel = '/blog.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(webDir, rel));
    if (!file.startsWith(webDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); // bearer tokens, no cookies: safe to open
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      if (res.headersSent) return res.end();
      res.writeHead(e.status || 500, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: e.status ? e.message : 'Internal error' }));
    }
  });
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787), host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => console.log(`ZenOS server on http://${host}:${port}`));
}
