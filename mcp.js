#!/usr/bin/env node
// MCP server (stdio) for Orto: lets Claude Desktop, Claude Code or any MCP client read and write your Orto data.
// It runs on YOUR machine and uses the SDK, so encryption and decryption happen here, never on the server and never in a hosted service.
// Config (env): ORTO_SERVER, ORTO_USER, ORTO_PASS; ORTO_MCP_READONLY=1 hides every tool that changes data;
// ORTO_MCP_SECRETS=1 adds secret_list / secret_get (off by default: a secret you read is sent to the model).
import readline from 'node:readline';
import Orto, { DEFAULT_SERVER } from './orto.js';

const env = (n) => process.env['ORTO_' + n] || process.env['ZENOS_' + n];
const on = (n) => ['1', 'true'].includes(env(n));
const READONLY = on('MCP_READONLY'), SECRETS = on('MCP_SECRETS');

let session = null;
const orto = () => session ||= (async () => {
  const [user, pass] = [env('USER'), env('PASS')];
  if (!user || !pass) throw new Error('Set ORTO_USER and ORTO_PASS (and ORTO_SERVER) in the environment of this MCP server.');
  const os = new Orto({ server: env('SERVER') || DEFAULT_SERVER });
  await os.login(user, pass);
  return os;
})().catch((e) => { session = null; throw e; });

const cut = (s, n) => (String(s || '').length > n ? String(s).slice(0, n) + '…' : String(s || ''));
const text = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const lim = (a, n = 50) => (a.limit > 0 ? Math.min(a.limit, 500) : n);
const str = (d) => ({ type: 'string', description: d });
const arr = (d) => ({ type: 'array', items: { type: 'string' }, description: d });
const num = (d) => ({ type: 'number', description: d });
const when = (d) => ({ type: 'string', description: d + ' (ISO 8601, e.g. 2026-10-05T10:00:00Z)' });

// [name, description, properties, required, kind ('read' | 'write' | 'delete'), run(os, args)]
const TOOLS = [
  ['note_list', 'List notes (newest first, pinned first) with a 200-character preview. Use note_get for the whole text.', { query: str('only notes whose title or text contains this'), limit: num('default 50') }, [], 'read',
    async (os, a) => (await os.readVaultNotes()).filter((n) => !a.query || (n.title + ' ' + n.body).toLowerCase().includes(a.query.toLowerCase())).slice(0, lim(a))
      .map((n) => ({ soul: n.soul, title: n.title, cat: n.cat, pinned: n.pinned, timestamp: n.timestamp, preview: cut(n.body, 200) }))],
  ['note_get', 'Read one note in full (Markdown).', { soul: str('note id from note_list') }, ['soul'], 'read', (os, a) => os.getVaultNote(a.soul)],
  ['note_write', 'Create a note, or replace one when `soul` is given (send the whole body: it overwrites).', { title: str('title'), body: str('Markdown text; #tags and - [ ] checklists work'), cat: str('category, default general'), pinned: { type: 'boolean' }, soul: str('existing note id to replace') }, ['title', 'body'], 'write',
    (os, a) => os.writeVaultNote(a)],
  ['calendar_list', 'List calendar events, optionally inside a date range.', { from: when('range start'), to: when('range end') }, [], 'read', (os, a) => os.readCalendarEvents(a)],
  ['event_write', 'Create a calendar event, or replace one when `soul` is given.', { title: str('title'), start: when('start'), end: when('end, defaults to start'), notes: str('free text'), soul: str('existing event id to replace') }, ['title', 'start'], 'write',
    (os, a) => os.writeCalendarEvent(a)],
  ['task_list', 'List Kanban tasks, open ones first.', { status: str('todo | doing | done (or a custom column)'), priority: str('low | medium | high | urgent'), tag: str('tag'), query: str('text in title, description or assignee') }, [], 'read', (os, a) => os.readTasks(a)],
  ['task_write', 'Create a task.', { title: str('title'), status: str('todo (default) | doing | done'), priority: str('low | medium (default) | high | urgent'), desc: str('description'), dueDate: when('due date'), tags: arr('tags'), assignee: str('who') }, ['title'], 'write', (os, a) => os.writeTask(a)],
  ['task_update', 'Change fields of an existing task (only the fields you send).', { soul: str('task id from task_list'), title: str('title'), status: str('todo | doing | done'), priority: str('priority'), desc: str('description'), dueDate: when('due date'), tags: arr('tags'), assignee: str('who') }, ['soul'], 'write',
    (os, { soul, ...patch }) => os.updateTask(soul, patch)],
  ['bookmark_list', 'List bookmarks (newest first).', { folder: str('folder path, includes subfolders'), query: str('text in title, url, folder or tags'), limit: num('default 50') }, [], 'read',
    async (os, a) => (await os.readBookmarks({ folder: a.folder, query: a.query })).slice(0, lim(a))],
  ['bookmark_add', 'Save a bookmark (the same URL is never stored twice).', { url: str('http(s) URL'), title: str('title'), folder: str('folder path like Dev/Tools'), tags: arr('tags') }, ['url'], 'write', (os, a) => os.writeBookmark(a)],
  ['contact_list', 'List contacts.', { query: str('text in name, email, phone, organisation, notes'), tag: str('tag'), limit: num('default 50') }, [], 'read',
    async (os, a) => (await os.readContacts({ query: a.query, tag: a.tag })).slice(0, lim(a))],
  ['contact_write', 'Create a contact, or replace one when `soul` is given.', { name: str('full name'), emails: arr('emails'), phones: arr('phone numbers'), org: str('organisation'), notes: str('notes'), tags: arr('tags'), soul: str('existing contact id to replace') }, ['name'], 'write',
    (os, a) => os.writeContact(a)],
  ['feed_list', 'List the RSS/Atom feeds you follow.', {}, [], 'read', (os) => os.readFeeds()],
  ['feed_add', 'Follow a feed. A web page address works too: its feed is found for you.', { url: str('feed or site URL'), title: str('name'), folder: str('folder') }, ['url'], 'write',
    async (os, a) => { const f = await os.findFeed(a.url); return os.addFeed(f.url, { title: a.title || f.feed.title, folder: a.folder }); }],
  ['feed_read', 'Read the latest articles of a followed feed (by soul) or of any feed URL, without following it.', { soul: str('followed feed id from feed_list'), url: str('feed URL'), limit: num('default 20') }, [], 'read',
    async (os, a) => {
      const url = a.url || (await os.readFeeds()).find((f) => f.soul === a.soul)?.url;
      if (!url) throw new Error('Give the url, or the soul of a followed feed.');
      const feed = (await os.findFeed(url)).feed;
      return { title: feed.title, items: feed.items.slice(0, lim(a, 20)).map((i) => ({ title: i.title, url: i.link, date: i.date && new Date(i.date).toISOString(), text: cut(text(i.content || i.summary), 600) })) };
    }],
  ['blog_list', 'List your own public blog posts.', {}, [], 'read', (os) => os.readBlogPosts()],
  ['blog_publish', 'Publish a PUBLIC blog post (anyone can read it, it is not encrypted), or edit one when `id` is given.', { title: str('title'), content: str('Markdown'), tags: arr('tags'), id: str('existing post id to edit') }, ['title', 'content'], 'write', (os, a) => os.publishBlogPost(a)],
  ['file_list', 'List uploaded files (names, sizes, folders; no content).', { limit: num('default 50') }, [], 'read',
    async (os, a) => (await os.listFiles()).slice(0, lim(a)).map(({ thumb, ...f }) => f)],
  ['delete', 'Permanently delete one item. There is no undo and no trash for most kinds: ask the user first.', { kind: { type: 'string', enum: ['note', 'event', 'task', 'bookmark', 'contact', 'feed', 'post', 'file'] }, id: str('soul (or id for post and file)') }, ['kind', 'id'], 'delete',
    (os, a) => {
      const f = { note: 'deleteVaultNote', event: 'deleteCalendarEvent', task: 'deleteTask', bookmark: 'deleteBookmark', contact: 'deleteContact', feed: 'deleteFeed', post: 'deleteBlogPost', file: 'deleteFile' }[a.kind];
      if (!f) throw new Error('Unknown kind: ' + a.kind);
      return os[f](a.id);
    }]
];
if (SECRETS) TOOLS.push(
  ['secret_list', 'List secrets (name, kind, username, url; no values).', { query: str('text in name, username, url, notes'), kind: str('password | api | note') }, [], 'read',
    async (os, a) => (await os.readSecrets(a)).map(({ secret, ...s }) => s)],
  ['secret_get', 'Read one secret INCLUDING its value. The value goes to the model: use only when the user asked for it.', { soul: str('secret id from secret_list') }, ['soul'], 'read', (os, a) => os.getSecret(a.soul)]);
const tools = TOOLS.filter((t) => !(READONLY && t[4] !== 'read'));

const list = tools.map(([name, description, properties, required, kind]) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: kind === 'read', destructiveHint: kind === 'delete', openWorldHint: name.startsWith('feed_') }
}));

async function call(name, args) {
  const t = tools.find((x) => x[0] === name);
  if (!t) throw new Error('Unknown tool: ' + name);
  const out = await t[5](await orto(), args || {});
  const s = JSON.stringify(out === undefined ? { ok: true } : out, null, 1);
  return s.length > 100000 ? s.slice(0, 100000) + '\n… (cut: ask for fewer items with limit or query)' : s;
}

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled): nothing to answer
  try {
    if (method === 'initialize') return send({ id, result: { protocolVersion: VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'orto', version: '0.3.0' } } });
    if (method === 'ping') return send({ id, result: {} });
    if (method === 'tools/list') return send({ id, result: { tools: list } });
    if (method === 'tools/call') {
      try { return send({ id, result: { content: [{ type: 'text', text: await call(params?.name, params?.arguments) }] } }); }
      catch (e) { return send({ id, result: { isError: true, content: [{ type: 'text', text: String(e.message || e) }] } }); }
    }
    send({ id, error: { code: -32601, message: 'Method not found: ' + method } });
  } catch (e) { send({ id, error: { code: -32603, message: String(e.message || e) } }); }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch (_) { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
  handle(msg);
}).on('close', () => { session?.then((os) => os.close(), () => { }); setTimeout(() => process.exit(0), 50); });
