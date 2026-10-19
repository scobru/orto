/**
 * Orto <-> Freenet sync. SQLite stays the primary store; Freenet is only a replication channel for the
 * (already end-to-end encrypted) rows of `records`. Zero npm dependencies: node:crypto + node:sqlite + the `fdev` CLI
 * (the node's own tool) as transport.
 *
 * Identity (like FreeTunes): a local Ed25519 key made here, exportable/importable as 64 hex chars.
 * The contract (contracts/vault) is addressed by owner pubkey || salt, so the same key on another device finds the same vault.
 *
 * Wire format (must match contracts/vault/src/lib.rs): state and delta are the same plain JSON,
 *   { records: { "<coll>:<soul>": { data, updated_at, deleted, sig, cert: null } }, updated_at }
 * and every record is signed on its own: ed25519 over `orto1|<params hex>|<key>|<updated_at>|<deleted>|<data>`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SYNC_COLLS = ['vault', 'calendar', 'tasks', 'bookmarks', 'contacts', 'secrets', 'feeds', 'files', 'shares']; // encrypted ones; public `posts` are not replicated
const WASM = () => {
  if (process.env.ORTO_VAULT_WASM && fs.existsSync(process.env.ORTO_VAULT_WASM)) return process.env.ORTO_VAULT_WASM;
  const p1 = path.join(here, 'contracts', 'orto_vault.wasm');
  if (fs.existsSync(p1)) return p1;
  const p2 = path.join(here, 'contracts', 'vault', 'build', 'freenet', 'orto_vault');
  if (fs.existsSync(p2)) return p2;
  return p1;
};

const keyFromSecret = (hex) => {
  if (!/^[0-9a-f]{64}$/i.test(hex || '')) throw new Error('The key must be 64 hexadecimal characters.');
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(hex, 'hex')]), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).subarray(12);
  return { priv, pub };
};

/** Identity file lives next to the database: <data>/freenet-identity.json (keep it private, back it up). */
export function identityFile(dataDir) { return path.join(dataDir, 'freenet-identity.json'); }

export function loadIdentity(dataDir) {
  try { return JSON.parse(fs.readFileSync(identityFile(dataDir), 'utf8')); } catch (_) { return null; }
}
const saveIdentity = (dataDir, id) => fs.writeFileSync(identityFile(dataDir), JSON.stringify(id, null, 2), { mode: 0o600 });

/** Create a new identity, or import one from its 64-hex secret (the same secret on another device = the same vault). */
export function createIdentity(dataDir, secretHex, salt) {
  const secret = (secretHex || crypto.randomBytes(32).toString('hex')).replace(/\s/g, '').toLowerCase();
  const { pub } = keyFromSecret(secret);
  const id = { secret, pub: pub.toString('hex'), salt: salt || crypto.createHash('sha256').update('orto-vault-v1|' + secret).digest().subarray(0, 16).toString('hex'), lastPush: 0, lastPull: 0 };
  saveIdentity(dataDir, id); // salt derived from the secret: importing the key on a new device finds the same contract with no extra data
  return id;
}

export const paramsHex = (id) => id.pub + id.salt;

/** One record, signed for the contract of this identity. */
export function signRecord(id, key, data, updated_at, deleted = false) {
  const { priv } = keyFromSecret(id.secret);
  const sig = crypto.sign(null, Buffer.from(`orto1|${paramsHex(id)}|${key}|${updated_at}|${deleted}|${data}`), priv).toString('hex');
  return { data, updated_at, deleted, sig, cert: null };
}

const rowKey = (r) => `${r.coll}:${r.soul}`;

/** Rows changed after `since`, as a delta of signed records (null when there is nothing to send). */
export function buildDelta(db, id, userId, since = id.lastPush) {
  const rows = db.prepare(`SELECT coll, soul, data, updated_at FROM records WHERE user_id = ? AND updated_at > ? AND coll IN (${SYNC_COLLS.map(() => '?').join(',')})`).all(userId, since, ...SYNC_COLLS);
  if (!rows.length) return null;
  const records = Object.fromEntries(rows.map(r => [rowKey(r), signRecord(id, rowKey(r), r.data, r.updated_at)]));
  const ts = Math.max(...rows.map(r => r.updated_at));
  return { signed: JSON.stringify({ records, updated_at: ts }), ts, count: rows.length };
}

/** Last-write-wins merge of a vault state into SQLite. Returns how many rows were written. */
export function applyState(db, userId, vault) {
  const get = db.prepare('SELECT updated_at FROM records WHERE user_id = ? AND coll = ? AND soul = ?');
  const put = db.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, coll, soul) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at');
  const del = db.prepare('DELETE FROM records WHERE user_id = ? AND coll = ? AND soul = ?');
  let n = 0;
  for (const [k, r] of Object.entries(vault.records || {})) {
    const i = k.indexOf(':'); const coll = k.slice(0, i), soul = k.slice(i + 1);
    if (!SYNC_COLLS.includes(coll)) continue;
    const cur = get.get(userId, coll, soul);
    if (cur && cur.updated_at >= r.updated_at) continue;
    if (r.deleted) del.run(userId, coll, soul); else put.run(userId, coll, soul, r.data, r.updated_at);
    n++;
  }
  return n;
}

// ── transport: the node's own CLI ───────────────────────────────────────────────────────────────────────────
const fdev = (args, opts = {}) => execFileSync('fdev', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const tmp = (name, content) => { const f = path.join(os.tmpdir(), `orto-${process.pid}-${name}`); fs.writeFileSync(f, content); return f; };
const paramsFile = (id) => tmp('params.bin', Buffer.from(paramsHex(id), 'hex'));

/** Instance id (base58) of this identity's vault contract. */
export function contractId(id) {
  const out = fdev(['execute', 'get-contract-id', '--code', WASM(), '--parameters', paramsFile(id)]);
  const m = out.match(/[1-9A-HJ-NP-Za-km-z]{43,44}/);
  if (!m) throw new Error('Could not read the contract id from fdev: ' + out.trim());
  return m[0];
}

const emptyState = () => JSON.stringify({ records: {}, updated_at: 0 });

export function publish(id) {
  fdev(['execute', 'put', '--code', WASM(), '--parameters', paramsFile(id), 'contract', '--state', tmp('state.json', emptyState())]);
  return contractId(id);
}

export function fetchVault(id) {
  const cid = contractId(id), out = path.join(os.tmpdir(), `orto-${process.pid}-get.json`);
  fdev(['execute', 'get', cid, '-o', out]);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

/** One round: pull what others wrote, then push what changed here. SQLite is touched only through applyState. */
export function sync(db, dataDir, userId) {
  const id = loadIdentity(dataDir);
  if (!id) throw new Error('No Freenet identity yet: run `freenet-identity --new` (or `--import <key>`).');
  const res = { pulled: 0, pushed: 0 };
  let exists = true;
  try { res.pulled = applyState(db, userId, fetchVault(id)); } catch (e) { exists = false; if (!/not found|NotFound|timeout/i.test(String(e.stderr || e.message))) throw e; }
  if (!exists) { publish(id); id.lastPush = 0; } // a new (or re-keyed) vault is empty: send every row
  const d = buildDelta(db, id, userId);
  if (d) { fdev(['execute', 'update', contractId(id), tmp('delta.json', d.signed)]); res.pushed = d.count; id.lastPush = d.ts; }
  id.lastPull = Date.now();
  saveIdentity(dataDir, id);
  return res;
}
