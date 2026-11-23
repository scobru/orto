import { Orto } from '../orto.js';
import { copyToClipboard } from './engine/clipboard.js';
import { openInEditor, parseNoteDoc, serializeNoteDoc } from './engine/editor.js';
import { extractTags, fuzzyScore } from './engine/widgets.js';
import { resolveFreenetIdentity } from './freenet.js';
import { installFreenetRuntime } from './freenet.js';

export const HUMAN_COMMANDS = new Set(['q', 'find', 'edit', 'copy', 'status']);

const VALUE_FLAGS = new Set([
  '--user', '-u', '--pass', '--server', '--space', '--env',
  '--mode', '--freenet-node', '--freenet-store', '--key', '--sk', '--pk',
  '--viso-seed', '--persona-index', '--delegation',
  '--due', '--priority', '--status', '--cat', '--project',
  '--title', '--text', '--soul', '-s', '--query', '-q',
  '--limit', '-n', '--kind'
]);

export function extractPositional(rest = []) {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') {
      out.push(...rest.slice(i + 1));
      break;
    }
    if (a.startsWith('-')) {
      if (VALUE_FLAGS.has(a) && i + 1 < rest.length && !rest[i + 1].startsWith('-')) {
        i++;
      }
      continue;
    }
    out.push(a);
  }
  return out;
}

async function connectClient({
  mode = 'server',
  server,
  freenetNode,
  freenetStore,
  freenetKey,
  visoSeed,
  personaIndex = 0,
  delegation = null,
  offline = false,
  user,
  pass,
  space
}) {
  let freenetRuntime = null;
  let base;
  let fnIdentity = null;
  if (mode === 'freenet') {
    let loginUser = user;
    let loginPass = pass;
    let resolvedDelegation = null;
    const rawFn = visoSeed || freenetKey;
    if (rawFn) {
      const id = await resolveFreenetIdentity(rawFn, {
        keyMode: visoSeed ? 'viso-seed' : 'auto',
        personaIndex,
        delegationRaw: delegation
      });
      loginUser = id.username;
      loginPass = id.password;
      resolvedDelegation = id.delegation || null;
      fnIdentity = {
        kind: id.kind,
        pubHex: id.pubHex,
        persona: id.persona,
        personaHex: id.personaHex || id.pubHex,
        hasDelegation: !!resolvedDelegation
      };
    } else if (!loginUser || !loginPass) {
      throw new Error('Freenet mode requires --key <64hex|file> or --viso-seed <64hex|file> (or ORTO_FREENET_KEY / ORTO_VISO_SEED).');
    }
    freenetRuntime = installFreenetRuntime({
      storePath: freenetStore,
      nodeUrl: freenetNode,
      connectNode: !offline
    });
    base = new Orto({ mode: 'freenet' });
    await base.login(loginUser, loginPass, { delegation: resolvedDelegation });
    if (!offline) {
      await freenetRuntime.waitForVaultSync(base, 15000);
    }
  } else {
    if (!user || !pass) {
      throw new Error('User and password required: provide --user/--pass or set ORTO_USER and ORTO_PASS.');
    }
    base = new Orto({ server });
    await base.login(user, pass);
  }
  const client = space ? await base.openSpace(space) : base;
  return { client, base, freenetRuntime, fnIdentity };
}

function parseQuickDue(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  const d = new Date();
  if (s === 'today') return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 18, 0, 0).getTime();
  if (s === 'tomorrow') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 18, 0, 0).getTime();
  return raw;
}

function printOut(data, { jsonOut, formatTty }) {
  if (jsonOut) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    formatTty(data);
  }
}

export async function runHumanCommand(cmd, rest, flags, creds) {
  const jsonOut = flags.json === true || !process.stdout.isTTY;
  const pos = extractPositional(rest);
  const { client, base, freenetRuntime, fnIdentity } = await connectClient(creds);

  try {
    if (cmd === 'q') {
      const isTask = !!(flags.task || flags.t);
      const extraText = typeof flags.task === 'string' ? flags.task : (typeof flags.t === 'string' ? flags.t : '');
      const text = [pos.join(' '), typeof flags.text === 'string' ? flags.text : '', extraText]
        .map((x) => x.trim())
        .filter(Boolean)
        .join(' ')
        .trim();

      if (!text && typeof flags.title !== 'string') {
        throw new Error('Provide text to capture, e.g. orto q "Buy milk #home"');
      }

      if (isTask) {
        const tags = extractTags(text);
        const cleanTitle = (typeof flags.title === 'string' ? flags.title : text)
          .replace(/(^|\s)#[a-zA-Z0-9_/-]{1,40}/g, '')
          .trim() || text;
        const res = await client.writeTask({
          title: cleanTitle,
          status: typeof flags.status === 'string' ? flags.status : 'todo',
          priority: typeof flags.priority === 'string' ? flags.priority : 'medium',
          dueDate: parseQuickDue(flags.due),
          tags,
          projectId: typeof flags.project === 'string' ? flags.project : ''
        });
        printOut({ kind: 'task', soul: res.soul, title: cleanTitle, tags }, {
          jsonOut,
          formatTty: (d) => console.log(`Task saved [${d.soul}]: ${d.title}${d.tags.length ? ' #' + d.tags.join(' #') : ''}`)
        });
        return;
      }

      const title = typeof flags.title === 'string'
        ? flags.title
        : (text.split(/\r?\n/)[0] || 'Quick note').slice(0, 60);
      const res = await client.writeVaultNote({
        title,
        body: text || title,
        cat: typeof flags.cat === 'string' ? flags.cat : 'general',
        pinned: !!flags.pinned,
        projectId: typeof flags.project === 'string' ? flags.project : ''
      });
      printOut({ kind: 'note', soul: res.soul, title }, {
        jsonOut,
        formatTty: (d) => console.log(`Note saved [${d.soul}]: ${d.title}`)
      });
      return;
    }

    if (cmd === 'find') {
      const q = (typeof flags.query === 'string' ? flags.query : '') || pos.join(' ').trim();
      if (!q) throw new Error('Provide a search query, e.g. orto find roadmap');
      const limit = Math.max(1, parseInt(flags.limit, 10) || 25);

      const [notes, tasks, projects, events, bookmarks, contacts, secrets] = await Promise.all([
        client.readVaultNotes(),
        client.readTasks(),
        client.readProjects(),
        client.readCalendarEvents(),
        client.readBookmarks(),
        client.readContacts(),
        client.readSecrets()
      ]);

      const hits = [];
      const add = (kind, items, getTitle, getSub) => {
        for (const it of items) {
          const title = String(getTitle(it) || '');
          const sub = String(getSub(it) || '');
          const score = Math.max(fuzzyScore(q, title) * 1.5, fuzzyScore(q, sub));
          if (score > 0) hits.push({ kind, soul: it.soul, title, subtitle: sub, score });
        }
      };

      add('note', notes, (n) => n.title || 'Untitled', (n) => extractTags(n.body).map((t) => '#' + t).join(' '));
      add('task', tasks, (t) => t.title, (t) => `${t.column || t.status || 'todo'} · ${t.priority || 'medium'}`);
      add('project', projects, (p) => p.name, (p) => p.status || 'active');
      add('event', events, (e) => e.title, (e) => e.location || '');
      add('bookmark', bookmarks, (b) => b.title || b.url, (b) => b.url);
      add('contact', contacts, (c) => c.name, (c) => (c.emails || [])[0] || c.org || '');
      add('secret', secrets, (s) => s.name, (s) => s.username || s.kind || ''); // never match secret value

      const top = hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
      printOut(top, {
        jsonOut,
        formatTty: (list) => {
          if (!list.length) { console.log(`No matches for "${q}".`); return; }
          for (const h of list) {
            console.log(`[${h.kind.padEnd(8)}] ${h.soul}  ${h.title}${h.subtitle ? `  (${h.subtitle})` : ''}`);
          }
        }
      });
      return;
    }

    if (cmd === 'edit') {
      const target = (typeof flags.soul === 'string' ? flags.soul : '') || pos.join(' ').trim();
      if (!target) throw new Error('Provide a soul or note title, e.g. orto edit <soul>');

      if (target.startsWith('task-')) {
        const task = await client.getTask(target);
        if (!task) throw new Error('Task not found: ' + target);
        const res = openInEditor(`# ${task.title}\n\n${task.desc || ''}`, { ext: '.md' });
        if (!res.changed) {
          printOut({ soul: target, changed: false }, { jsonOut, formatTty: () => console.log('No changes.') });
          return;
        }
        const lines = res.text.split('\n');
        const title = lines[0]?.startsWith('# ') ? (lines[0].slice(2).trim() || task.title) : task.title;
        const start = lines[0]?.startsWith('# ') ? (lines[1] === '' ? 2 : 1) : 0;
        const desc = lines.slice(start).join('\n').trimEnd();
        await client.updateTask(target, { title, desc });
        printOut({ soul: target, changed: true, title }, { jsonOut, formatTty: () => console.log(`Updated task: ${title}`) });
        return;
      }

      if (target.startsWith('post-')) {
        const post = await client.getBlogPost(target);
        if (!post) throw new Error('Blog post not found: ' + target);
        const res = openInEditor(`# ${post.title}\n\n${post.content || ''}`, { ext: '.md' });
        if (!res.changed) {
          printOut({ id: target, changed: false }, { jsonOut, formatTty: () => console.log('No changes.') });
          return;
        }
        const lines = res.text.split('\n');
        const title = lines[0]?.startsWith('# ') ? (lines[0].slice(2).trim() || post.title) : post.title;
        const start = lines[0]?.startsWith('# ') ? (lines[1] === '' ? 2 : 1) : 0;
        const content = lines.slice(start).join('\n').trimEnd();
        await client.publishBlogPost({ id: target, title, content, tags: post.tags, createdAt: post.createdAt });
        printOut({ id: target, changed: true, title }, { jsonOut, formatTty: () => console.log(`Updated post: ${title}`) });
        return;
      }

      let note = await client.getVaultNote(target).catch(() => null);
      if (!note) {
        const all = await client.readVaultNotes();
        note = all.find((n) => (n.title || '').trim().toLowerCase() === target.toLowerCase()) || null;
      }
      if (!note) throw new Error('Note not found: ' + target);

      const res = openInEditor(serializeNoteDoc(note), { ext: '.md' });
      if (!res.changed) {
        printOut({ soul: note.soul, changed: false }, { jsonOut, formatTty: () => console.log('No changes.') });
        return;
      }
      const parsed = parseNoteDoc(res.text, note);
      await client.writeVaultNote({ ...note, ...parsed, soul: note.soul });
      printOut({ soul: note.soul, changed: true, title: parsed.title }, {
        jsonOut,
        formatTty: () => console.log(`Saved note: ${parsed.title}`)
      });
      return;
    }

    if (cmd === 'copy') {
      const q = (typeof flags.soul === 'string' ? flags.soul : '')
        || (typeof flags.query === 'string' ? flags.query : '')
        || pos.join(' ').trim();
      if (!q) throw new Error('Provide a secret name or soul, e.g. orto copy github');

      let match = null;
      if (q.startsWith('sc-')) {
        match = await client.getSecret(q);
      }
      if (!match) {
        const list = await client.readSecrets({ query: q });
        match = list.find((s) => s.name.toLowerCase() === q.toLowerCase()) || list[0] || null;
      }
      if (!match) throw new Error('Secret not found: ' + q);

      const clip = copyToClipboard(match.secret, { stdout: process.stdout });
      // NEVER include match.secret in output
      printOut({ copied: clip.ok, method: clip.method, soul: match.soul, name: match.name }, {
        jsonOut,
        formatTty: (d) => console.log(d.copied ? `Copied secret "${d.name}" to clipboard (${d.method}).` : `Could not access clipboard for "${d.name}".`)
      });
      return;
    }

    if (cmd === 'status') {
      const now = Date.now();
      const dayMs = 86400000;
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const endOfToday = new Date(startOfToday.getTime() + dayMs - 1);

      const [notes, tasks, events, secrets, feeds, spaces] = await Promise.all([
        client.readVaultNotes(),
        client.readTasks(),
        client.readCalendarEvents(),
        client.readSecrets(),
        client.readFeeds(),
        client.spaces().catch(() => [])
      ]);

      const overdueTasks = tasks.filter((t) => (t.column || t.status) !== 'done' && t.dueDate && t.dueDate < now);
      const blockedTasks = tasks.filter((t) => (t.column || t.status) === 'blocked');
      const weeds = tasks.filter((t) => (t.column || t.status) !== 'done' && now - (t.updatedAt || t.createdAt || now) > 14 * dayMs);
      const harvest = tasks.filter((t) => (t.column || t.status) === 'done' && now - (t.updatedAt || 0) < 14 * dayMs);
      const lastNote = notes.reduce((m, n) => Math.max(m, Number(n.timestamp || 0)), 0);
      const dry = now - lastNote > 7 * dayMs;
      const oldSecrets = secrets.filter((s) => now - (s.updatedAt || s.createdAt || now) > 365 * dayMs);
      const gardenHealth = Math.round(Math.max(0, Math.min(100,
        100 - 12 * overdueTasks.length - 5 * weeds.length - (dry ? 15 : 0) - 4 * oldSecrets.length - 4 * blockedTasks.length + 3 * harvest.length
      )));

      const todayEvents = events.filter((e) => (e.end ?? e.start) >= startOfToday.getTime() && e.start <= endOfToday.getTime());
      const openTasks = tasks.filter((t) => (t.column || t.status) !== 'done');
      const pendingInvites = spaces.filter((s) => s.status === 'pending');

      const summary = {
        mode: creds.mode === 'freenet' ? 'freenet' : 'server',
        user: client.username,
        ...(fnIdentity ? { pubHex: fnIdentity.pubHex, persona: fnIdentity.persona } : {}),
        server: creds.mode === 'freenet' ? (freenetRuntime?.nodeUrl || 'freenet') : creds.server,
        space: client.spaceName || 'Personal',
        gardenHealth,
        notes: notes.length,
        openTasks: openTasks.length,
        overdueTasks: overdueTasks.length,
        todayEvents: todayEvents.length,
        feeds: feeds.length,
        secrets: secrets.length,
        pendingInvites: pendingInvites.length
      };

      printOut(summary, {
        jsonOut,
        formatTty: (s) => {
          console.log(`Orto [${s.mode === 'freenet' ? 'Freenet P2P' : 'Server'}] · ${s.space} (@${s.user}) · ${s.server}`);
          console.log(`Garden Health: ${s.gardenHealth}%`);
          console.log(`Notes: ${s.notes}  ·  Open Tasks: ${s.openTasks} (${s.overdueTasks} overdue)`);
          console.log(`Today Events: ${s.todayEvents}  ·  Feeds: ${s.feeds}  ·  Secrets: ${s.secrets}`);
          if (s.pendingInvites) console.log(`Pending Space Invites: ${s.pendingInvites}`);
        }
      });
    }
  } finally {
    await freenetRuntime?.flushVaults(base, 800);
    client.close();
    if (client !== base) base.close();
    freenetRuntime?.close();
  }
}
