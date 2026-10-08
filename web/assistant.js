// Chat assistant for the on-device model (web/llm.js): a small, closed set of Orto tools, run in the browser with the app's own SDK
// instance, so decrypted data never leaves the device. A 1B-class model copes with a handful of tools, not forty, and it never gets
// a delete tool: it can only read, create and update. Every tool that changes data asks the user first.
import { loadLlm, parseToolCalls, stripThink } from './llm.js';

const cut = (s, n) => (String(s || '').length > n ? String(s).slice(0, n) + '…' : String(s || ''));
const str = (description) => ({ type: 'string', description });
const iso = (d) => str(d + ' (ISO 8601, e.g. 2026-10-05T10:00:00Z)');
const some = (list, n = 20) => list.slice(0, n);

// [name, description, properties, required, kind, run(os, args)]
export const TOOLS = [
  ['note_list', 'List notes with a short preview.', { query: str('only notes whose title or text contains this') }, [], 'read',
    async (os, a) => some((await os.readVaultNotes()).filter((n) => !a.query || (n.title + ' ' + n.body).toLowerCase().includes(String(a.query).toLowerCase()))
      .map((n) => ({ soul: n.soul, title: n.title, preview: cut(n.body, 120) })))],
  ['note_get', 'Read one note in full.', { soul: str('note id from note_list') }, ['soul'], 'read', (os, a) => os.getVaultNote(a.soul)],
  ['note_write', 'Create a note.', { title: str('title'), body: str('Markdown text') }, ['title', 'body'], 'write', (os, a) => os.writeVaultNote({ title: a.title, body: a.body })],
  ['task_list', 'List tasks, open ones first.', { status: str('todo | doing | done'), query: str('text in title or description') }, [], 'read',
    async (os, a) => some(await os.readTasks({ status: a.status, query: a.query }))],
  ['task_write', 'Create a task.', { title: str('title'), priority: str('low | medium | high | urgent'), dueDate: iso('due date'), desc: str('description') }, ['title'], 'write', (os, a) => os.writeTask(a)],
  ['task_update', 'Change a task (only the fields you send).', { soul: str('task id from task_list'), status: str('todo | doing | done'), title: str('title'), priority: str('priority'), dueDate: iso('due date') }, ['soul'], 'write',
    (os, { soul, ...patch }) => os.updateTask(soul, patch)],
  ['calendar_list', 'List calendar events, optionally inside a date range.', { from: iso('range start'), to: iso('range end') }, [], 'read', async (os, a) => some(await os.readCalendarEvents(a))],
  ['event_write', 'Create a calendar event.', { title: str('title'), start: iso('start'), end: iso('end, defaults to start'), notes: str('free text') }, ['title', 'start'], 'write', (os, a) => os.writeCalendarEvent(a)],
  ['bookmark_list', 'List bookmarks.', { query: str('text in title, url or tags') }, [], 'read', async (os, a) => some(await os.readBookmarks({ query: a.query }))],
  ['bookmark_add', 'Save a bookmark.', { url: str('http(s) URL'), title: str('title') }, ['url'], 'write', (os, a) => os.writeBookmark(a)],
  ['contact_list', 'List contacts.', { query: str('text in name, email, phone, organisation') }, [], 'read', async (os, a) => some(await os.readContacts({ query: a.query }))],
];

const schemas = TOOLS.map(([name, description, properties, required]) => ({ name, description, parameters: { type: 'object', properties, required } }));
const system = () => `You are the assistant of Orto, a private notes, tasks and calendar app. Answer briefly, in the user's language. Use the tools to read or change the user's data; never invent data. Today is ${new Date().toString().slice(0, 33)}.`;
const clean = (t) => stripThink(t).replace(/<\|[^|>]*\|>/g, '').trim();

/**
 * One user turn. `history` is the list of earlier { role, content } messages (user and final answers only; this function appends to it).
 * Runs at most `maxSteps` model calls: ask, run the requested tools, give the results back, repeat until the model answers in plain text.
 * `ask(tool, args)` must resolve true before any tool that changes data runs. `chat` is injectable for tests.
 */
export async function askAssistant(os, text, history, { chat, base = '', onProgress, onToken, ask = async () => false, onTool, maxSteps = 4 } = {}) {
  chat ||= (await loadLlm({ base, onProgress })).chat;
  const messages = [{ role: 'system', content: system() }, ...history, { role: 'user', content: text }];
  let answer = '';
  for (let step = 0; step < maxSteps; step++) {
    const raw = await chat(messages, { tools: schemas, onToken });
    const calls = parseToolCalls(raw);
    if (!calls.length) { answer = clean(raw) || '…'; break; }
    messages.push({ role: 'assistant', content: raw });
    for (const { name, arguments: args } of calls) {
      const t = TOOLS.find((x) => x[0] === name);
      let result;
      try {
        if (!t) throw new Error('Unknown tool: ' + name + '. Available: ' + TOOLS.map((x) => x[0]).join(', '));
        const missing = t[3].filter((k) => args[k] === undefined || args[k] === '');
        if (missing.length) throw new Error('Missing argument: ' + missing.join(', '));
        onTool?.(name, args);
        if (t[4] !== 'read' && !(await ask(name, args))) result = { error: 'The user declined this action.' };
        else { const out = await t[5](os, args); result = out === undefined ? { ok: true } : out; }
      } catch (e) { result = { error: String(e.message || e) }; }
      messages.push({ role: 'tool', content: cut(JSON.stringify(result), 3000) });
    }
  }
  answer ||= 'I could not finish this in a few steps. Try a simpler request.';
  history.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
  return answer;
}
