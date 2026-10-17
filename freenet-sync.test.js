// node --test freenet-sync.test.js   (offline: no Freenet node needed)
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createIdentity, loadIdentity, buildDelta, applyState, paramsHex } from './freenet-sync.js';

const mkdb = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE records (user_id INTEGER NOT NULL, coll TEXT NOT NULL, soul TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, coll, soul))');
  return db;
};
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orto-fs-'));

test('identity: same secret gives the same vault address on another device', () => {
  const a = createIdentity(dir()), b = createIdentity(dir(), a.secret);
  assert.equal(paramsHex(a), paramsHex(b));
  assert.equal(loadIdentity(dir()), null);
});

test('each record is signed over orto1|params|key|ts|deleted|data and verifies with the owner key', () => {
  const id = createIdentity(dir()), db = mkdb();
  db.prepare("INSERT INTO records VALUES (1,'vault','n1','e1.AAAA',1000),(1,'posts','p1','public',1100)").run();
  const d = buildDelta(db, id, 1, 0);
  assert.equal(d.count, 1); // public posts are not replicated
  const r = JSON.parse(d.signed).records['vault:n1'];
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(id.pub, 'hex')]);
  const pub = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  assert.ok(crypto.verify(null, Buffer.from(`orto1|${paramsHex(id)}|vault:n1|1000|false|e1.AAAA`), pub, Buffer.from(r.sig, 'hex')));
  assert.equal(r.cert, null);
  assert.equal(r.data, 'e1.AAAA');
});

test('nothing newer than lastPush: no delta', () => {
  const id = createIdentity(dir()), db = mkdb();
  db.prepare("INSERT INTO records VALUES (1,'tasks','t1','e1.x',500)").run();
  assert.equal(buildDelta(db, id, 1, 500), null);
});

test('applyState is last-write-wins and handles tombstones', () => {
  const db = mkdb();
  db.prepare("INSERT INTO records VALUES (1,'vault','n1','local-new',2000),(1,'vault','n2','keep',1000)").run();
  const n = applyState(db, 1, { records: {
    'vault:n1': { data: 'remote-old', updated_at: 1500, deleted: false }, // older: ignored
    'vault:n2': { data: '', updated_at: 3000, deleted: true },            // newer tombstone: deletes
    'tasks:t9': { data: 'e1.new', updated_at: 10, deleted: false },       // unknown: inserted
    'posts:p1': { data: 'x', updated_at: 99, deleted: false }             // public: refused
  } });
  assert.equal(n, 2);
  const get = (c, s) => db.prepare('SELECT data FROM records WHERE coll=? AND soul=?').get(c, s)?.data;
  assert.equal(get('vault', 'n1'), 'local-new');
  assert.equal(get('vault', 'n2'), undefined);
  assert.equal(get('tasks', 't9'), 'e1.new');
  assert.equal(get('posts', 'p1'), undefined);
});
