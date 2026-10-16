import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from './server.js';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aula-'));
const server = createServer({ data, maxUpload: 1000 });
let base;
before(() => new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
after(() => { server.close(); fs.rmSync(data, { recursive: true, force: true }); });

const call = async (token, method, url, body, raw) => {
  const r = await fetch(base + url, {
    method,
    headers: { ...(token && { Authorization: 'Bearer ' + token }), ...(body && !raw && { 'Content-Type': 'application/json' }) },
    body: raw ? body : body && JSON.stringify(body),
  });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};
const signup = async name => (await call(null, 'POST', '/api/register', { name, email: `${name}@x.org`, password: 'password1' })).body.token;

test('full classroom flow', async () => {
  const [teacher, ann, bob] = [await signup('teacher'), await signup('ann'), await signup('bob')];
  assert.equal((await call(null, 'GET', '/api/classes')).status, 401);
  assert.equal((await call(null, 'POST', '/api/login', { email: 'ann@x.org', password: 'nope' })).status, 401);

  const { id: cid, code } = (await call(teacher, 'POST', '/api/classes', { name: 'Math' })).body;
  assert.equal((await call(ann, 'GET', `/api/classes/${cid}`)).status, 404, 'non-member');
  assert.equal((await call(ann, 'POST', '/api/join', { code: code.toLowerCase() })).status, 200);
  assert.equal((await call(bob, 'POST', '/api/join', { code })).status, 200);
  assert.equal((await call(ann, 'GET', `/api/classes/${cid}`)).body.class.code, undefined, 'students never see the code');

  assert.equal((await call(ann, 'POST', `/api/classes/${cid}/posts`, { kind: 'announcement', body: 'hi' })).status, 403);
  const { id: pid } = (await call(teacher, 'POST', `/api/classes/${cid}/posts`, { kind: 'assignment', title: 'HW1', body: 'solve', points: 10 })).body;
  assert.equal((await call(teacher, 'POST', `/api/files?post=${pid}&name=sheet.txt`, 'sheet', true)).status, 200);

  // student: draft + attachment + turn in
  const up = await call(ann, 'POST', `/api/files?post=${pid}&name=my%20work.txt`, 'answer', true);
  assert.equal(up.status, 200);
  assert.equal((await call(ann, 'POST', `/api/files?post=${pid}&name=big`, 'x'.repeat(1001), true)).status, 413);
  assert.equal((await call(ann, 'PUT', `/api/posts/${pid}/submission`, { text: 'my answer', submit: true })).status, 200);

  const t = (await call(teacher, 'GET', `/api/posts/${pid}`)).body;
  assert.equal(t.submissions.length, 1);
  assert.equal((await call(teacher, 'GET', `/api/files/${up.body.id}`)).body.toString(), 'answer');
  assert.equal((await call(bob, 'GET', `/api/files/${up.body.id}`)).status, 404, 'other student cannot read');
  assert.equal((await call(bob, 'GET', `/api/posts/${pid}`)).body.submission, null);

  // grading
  const sid = t.submissions[0].id;
  assert.equal((await call(teacher, 'PUT', `/api/submissions/${sid}/grade`, { grade: 11 })).status, 400, 'above points');
  assert.equal((await call(ann, 'PUT', `/api/submissions/${sid}/grade`, { grade: 10 })).status, 403);
  assert.equal((await call(teacher, 'PUT', `/api/submissions/${sid}/grade`, { grade: 9, feedback: 'good' })).status, 200);
  const mine = (await call(ann, 'GET', `/api/posts/${pid}`)).body.submission;
  assert.deepEqual([mine.grade, mine.feedback], [9, 'good']);
  assert.equal((await call(ann, 'PUT', `/api/posts/${pid}/submission`, { text: 'edit', submit: true })).status, 409, 'locked once graded');

  // deleting the post removes files from disk
  assert.equal((await call(teacher, 'DELETE', `/api/posts/${pid}`)).status, 200);
  assert.deepEqual(fs.readdirSync(path.join(data, 'files')), []);
});

test('static files and path traversal', async () => {
  assert.equal((await call(null, 'GET', '/')).status, 200);
  assert.equal((await call(null, 'GET', '/../server.js')).status, 404);
});
