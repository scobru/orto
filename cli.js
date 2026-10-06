#!/usr/bin/env node

/**
 * ZenOS CLI Runner for Agents and Scripts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ZenOS, { DEFAULT_SERVER, normalizeServer, bookmarkSoul, generatePassword } from './zenos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SHORT_ALIASES = {
  n: 'limit',
  p: 'page',
  q: 'query',
  c: 'count',
  t: 'table',
  u: 'user',
  h: 'help',
  f: 'file',
  s: 'soul'
};

function parseArgs(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const raw = arg.slice(1);
      const key = SHORT_ALIASES[raw] || raw;
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        flags[raw] = next;
        i++;
      } else {
        flags[key] = true;
        flags[raw] = true;
      }
    }
  }
  return flags;
}

function loadEnvFile(filePath) {
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq !== -1) {
          const key = trimmed.slice(0, eq).trim();
          let val = trimmed.slice(eq + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch (_) { }
}

const [, , cmd, ...rest] = process.argv;
const flags = parseArgs(rest);

// Load .env files in priority order:
// 1. Explicit --env flag
if (flags.env) {
  loadEnvFile(path.resolve(flags.env));
}
// 2. Skill folder (.env, .env.local)
loadEnvFile(path.join(__dirname, '.env'));
loadEnvFile(path.join(__dirname, '.env.local'));
// 3. Current working directory (.env, .env.local) if different
if (process.cwd() !== __dirname) {
  loadEnvFile(path.join(process.cwd(), '.env'));
  loadEnvFile(path.join(process.cwd(), '.env.local'));
}

function requireCredentials() {
  const user = flags.user || process.env.ZENOS_USER || process.env.ZENOS_USERNAME;
  const pass = flags.pass || process.env.ZENOS_PASS || process.env.ZENOS_PASSWORD;
  if (!user || !pass) {
    throw new Error('User and password required: provide --user and --pass flags, or set ZENOS_USER and ZENOS_PASS in .env file.');
  }
  return { user, pass };
}

function safeExit(code = 0) {
  process.exit(code);
}

function outputResults(items, flags) {
  if (flags.count) {
    console.log(JSON.stringify({ total: items.length }, null, 2));
    return;
  }
  const hasLimit = flags.limit !== undefined;
  const hasPage = flags.page !== undefined;
  const hasOffset = flags.offset !== undefined;

  if (hasLimit || hasPage || hasOffset || flags.table) {
    const limit = hasLimit ? Math.max(1, parseInt(flags.limit, 10) || 20) : (flags.table ? 20 : items.length);
    let offset = 0;
    let page = 1;
    if (hasPage) {
      page = Math.max(1, parseInt(flags.page, 10) || 1);
      offset = (page - 1) * limit;
    } else if (hasOffset) {
      offset = Math.max(0, parseInt(flags.offset, 10) || 0);
      page = Math.floor(offset / limit) + 1;
    }
    const totalPages = Math.ceil(items.length / limit) || 1;
    const displayItems = items.slice(offset, offset + limit);

    if (flags.table) {
      console.log(`\nShowing ${displayItems.length} of ${items.length} items (Page ${page}/${totalPages}):\n`);
      console.table(displayItems.map(item => {
        const row = {};
        if (item.name !== undefined) row.Name = item.name ? item.name.slice(0, 40) : '';
        if (item.kind !== undefined) row.Kind = item.kind || '';
        if (item.username) row.User = item.username.slice(0, 30);
        if (item.emails !== undefined) row.Email = (item.emails || []).join(', ').slice(0, 40);
        if (item.phones !== undefined) row.Phone = (item.phones || []).join(', ').slice(0, 30);
        if (item.title !== undefined) row.Title = item.title ? item.title.slice(0, 40) : '';
        if (item.status !== undefined) row.Status = item.status || '';
        if (item.priority !== undefined) row.Priority = item.priority || '';
        if (item.dueDate !== undefined) row.Due = item.dueDate ? new Date(item.dueDate).toISOString().slice(0, 10) : '';
        if (item.assignee !== undefined && item.assignee) row.Assignee = item.assignee;
        if (item.folder !== undefined) row.Folder = item.folder || '';
        if (item.url !== undefined) row.URL = item.url ? item.url.slice(0, 50) : '';
        if (item.start !== undefined) row.Start = new Date(item.start).toISOString();
        if (item.cat !== undefined) row.Cat = item.cat;
        if (item.soul !== undefined) row.Soul = item.soul;
        return row;
      }));
      return;
    }

    console.log(JSON.stringify({
      total: items.length,
      page,
      limit,
      totalPages,
      items: displayItems
    }, null, 2));
    return;
  }

  console.log(JSON.stringify(items, null, 2));
}

async function main() {
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`
ZenOS CLI — Sovereign Agent Tools
Usage:
  # Account
  node cli.js register [--user <user> --pass <pass>]   # create the account on the server (if registration is open)
  node cli.js identity [--user <user> --pass <pass>]   # check login, print username + server

  # File storage (encrypted client-side unless --plain)
  node cli.js file-upload   [--user <user> --pass <pass>] --file <path> [--plain]
  node cli.js file-list     [--user <user> --pass <pass>]
  node cli.js file-download [--user <user> --pass <pass>] --id <id> --out <path>
  node cli.js file-delete   [--user <user> --pass <pass>] --id <id>

  # Contacts (Encrypted)
  node cli.js contact-add    [--user <user> --pass <pass>] --name <name> [--email <a,b>] [--phone <a,b>] [--org <org>] [--notes <text>] [--tags <a,b>] [--pub <zenos username>] [--soul <soul>]
  node cli.js contact-get    [--user <user> --pass <pass>] --soul <soul>
  node cli.js contact-read   [--user <user> --pass <pass>] [--query <q>] [--tag <tag>] [--table] [--count] [-n <limit> -p <page>]
  node cli.js contact-delete [--user <user> --pass <pass>] --soul <soul>
  node cli.js contacts-import [--user <user> --pass <pass>] --file <contacts.vcf>
  node cli.js contacts-export [--user <user> --pass <pass>] [--file <out.vcf>] [--query <q>] [--tag <tag>]

  # Secrets: passwords, API keys, notes (Encrypted; values hidden unless --reveal / secret-get)
  node cli.js secret-add      [--user <user> --pass <pass>] --name <name> (--secret <value> | --secret-stdin | --generate [--length 24] [--no-symbols]) [--kind password|api|note] [--username <u>] [--url <url>] [--notes <text>] [--tags <a,b>] [--soul <soul>]
  node cli.js secret-get      [--user <user> --pass <pass>] --soul <soul>        # prints the secret value
  node cli.js secret-read     [--user <user> --pass <pass>] [--query <q>] [--kind <kind>] [--tag <tag>] [--reveal] [--table] [--count]
  node cli.js secret-delete   [--user <user> --pass <pass>] --soul <soul>
  node cli.js secret-generate [--length 24] [--no-symbols]                        # no login needed

  # Vault (Encrypted Notes)
  node cli.js vault-write  [--user <user> --pass <pass>] --title <title> --body <body> [--cat <cat>] [--pinned] [--soul <soul>]
  node cli.js vault-get    [--user <user> --pass <pass>] --soul <soul>
  node cli.js vault-read   [--user <user> --pass <pass>] [--cat <cat>] [--query <q>] [--pinned]
  node cli.js vault-delete [--user <user> --pass <pass>] --soul <soul>

  # Calendar (Encrypted Events & Graph Links)
  node cli.js calendar-write      [--user <user> --pass <pass>] --title <title> --start <date> [--end <date>] [--allDay] [--notes <text>] [--location <loc>] [--soul <soul>]
  node cli.js calendar-get        [--user <user> --pass <pass>] --soul <soul>
  node cli.js calendar-read       [--user <user> --pass <pass>] [--from <date>] [--to <date>]
  node cli.js calendar-delete     [--user <user> --pass <pass>] --soul <soul>
  node cli.js calendar-events-for [--user <user> --pass <pass>] (--note <soul> | --bookmark <soul>)
  node cli.js calendar-notes-for  [--user <user> --pass <pass>] --event <soul>
  node cli.js event-link          [--user <user> --pass <pass>] --event <soul> (--note <soul> | --bookmark <soul> | --task <soul>)
  node cli.js event-unlink        [--user <user> --pass <pass>] --event <soul> (--note <soul> | --bookmark <soul> | --task <soul>)

  # Tasks & Kanban (Encrypted Projects & Tasks)
  node cli.js task-write   [--user <user> --pass <pass>] --title <title> [--status <todo|in_progress|done|blocked>] [--priority <low|medium|high|urgent>] [--desc <desc>] [--due <date>] [--tags <t1,t2>] [--assignee <who>] [--column <col>] [--soul <soul>]
  node cli.js task-get     [--user <user> --pass <pass>] --soul <soul>
  node cli.js task-read    [--user <user> --pass <pass>] [--status <s>] [--priority <p>] [--tag <t>] [--query <q>]
  node cli.js task-update  [--user <user> --pass <pass>] --soul <soul> [--title <title>] [--status <s>] [--priority <p>] [--desc <desc>] [--due <date>] [--tags <tags>] [--assignee <who>]
  node cli.js task-delete  [--user <user> --pass <pass>] --soul <soul>
  node cli.js task-link    [--user <user> --pass <pass>] --task <soul> (--note <soul> | --event <soul> | --bookmark <soul> | --linked-task <soul>)
  node cli.js task-unlink  [--user <user> --pass <pass>] --task <soul> (--note <soul> | --event <soul> | --bookmark <soul> | --linked-task <soul>)
  node cli.js tasks-for    [--user <user> --pass <pass>] (--note <soul> | --event <soul> | --bookmark <soul> | --task <soul>)

  # Bookmarks (Encrypted & Deduplicated)
  node cli.js bookmarks-write  [--user <user> --pass <pass>] --url <url> [--title <title>] [--folder <path>] [--tags <t1,t2>]
  node cli.js bookmarks-get    [--user <user> --pass <pass>] (--soul <soul> | --url <url>)
  node cli.js bookmarks-read   [--user <user> --pass <pass>] [--folder <path>] [--query <q>]
  node cli.js bookmarks-delete [--user <user> --pass <pass>] (--soul <soul> | --url <url>)
  node cli.js bookmarks-import [--user <user> --pass <pass>] --file <export.html>   # Brave/Chrome/Firefox export
  node cli.js bookmarks-export [--user <user> --pass <pass>] [--folder <path>] [--file <out.html>]
  node cli.js bookmarks-update [--user <user> --pass <pass>] --file <changes.json>  # [{soul, title?, folder?, tags?}]

  # smollog (Public Verifiable Blog)
  node cli.js blog-publish [--user <user> --pass <pass>] --title <title> --content <content> [--tags <tags>] [--id <id>]
  node cli.js blog-get     --id <id> (--alias <username> | --user <user> --pass <pass>)
  node cli.js blog-read    (--alias <username> | --user <user> --pass <pass>)     # public posts need no login
  node cli.js blog-delete  [--user <user> --pass <pass>] --id <id>

Pagination & formatting options (read commands):
  --limit <n>, -n <n>     limit number of returned records (default 20 when paginating)
  --page <n>, -p <n>      page number (1-based, e.g. --page 2 --limit 20)
  --offset <n>            record offset (alternative to --page)
  --count, -c             return total count only (e.g. {"total": 1704})
  --table, -t             format results as an easy-to-read console table

Credentials:
  Flags:     --user <user> --pass <pass> (or -u <user>)
  Env vars:  ZENOS_USER and ZENOS_PASS (or ZENOS_USERNAME / ZENOS_PASSWORD)
  Files:     .env in skill directory or current working directory (or --env <path>)

Server (all commands):
  --server <url>          ZenOS server URL (or ZENOS_SERVER); default ${DEFAULT_SERVER}
  Run your own: node server.js   (see README.md)
`);
    process.exit(0);
  }

  const server = normalizeServer(typeof flags.server === 'string' ? flags.server : process.env.ZENOS_SERVER || DEFAULT_SERVER);
  const os = new ZenOS({ server });

  switch (cmd) {
    case 'register': {
      const { user, pass } = requireCredentials();
      await os.login(user, pass, { create: true });
      console.log(JSON.stringify({ username: os.username, server }, null, 2));
      process.exit(0);
      break;
    }

    case 'identity': {
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      console.log(JSON.stringify({ username: os.username, blog: `${server}/blog/${os.pub}`, server }, null, 2));
      process.exit(0);
      break;
    }

    // ─── Vault (Notes) CRUD ───────────────────────────────────────────

    case 'file-upload': {
      if (typeof flags.file !== 'string') throw new Error('--file is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const res = await os.uploadFile(fs.readFileSync(flags.file), path.basename(flags.file), { encrypt: !flags.plain });
      console.log(JSON.stringify(res, null, 2));
      safeExit(0);
      break;
    }

    case 'file-list': {
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      console.log(JSON.stringify(await os.listFiles(), null, 2));
      safeExit(0);
      break;
    }

    case 'file-download': {
      if (typeof flags.id !== 'string' || typeof flags.out !== 'string') throw new Error('--id and --out are required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      fs.writeFileSync(flags.out, await os.downloadFile(flags.id));
      console.log(JSON.stringify({ id: flags.id, out: flags.out }, null, 2));
      safeExit(0);
      break;
    }

    case 'file-delete': {
      if (typeof flags.id !== 'string') throw new Error('--id is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      console.log(JSON.stringify(await os.deleteFile(flags.id), null, 2));
      safeExit(0);
      break;
    }

    case 'vault-write': {
      const title = flags.title;
      const body = flags.body || flags.content;
      if (!title || !body) {
        throw new Error('--title and --body (or --content) are required.');
      }
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const res = await os.writeVaultNote({
        title,
        body,
        cat: flags.cat || 'agent',
        pinned: !!flags.pinned,
        soul: flags.soul
      });
      console.log(JSON.stringify(res, null, 2));
      safeExit(0);
      break;
    }

    case 'vault-get': {
      if (!flags.soul) throw new Error('--soul is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const note = await os.getVaultNote(flags.soul);
      if (!note) {
        console.error(JSON.stringify({ error: 'Note not found: ' + flags.soul }));
        process.exit(1);
      }
      console.log(JSON.stringify(note, null, 2));
      process.exit(0);
      break;
    }

    case 'vault-read': {
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      let notes = await os.readVaultNotes();

      if (flags.cat) {
        notes = notes.filter(n => n.cat === flags.cat);
      }
      if (flags.pinned) {
        notes = notes.filter(n => n.pinned);
      }
      if (flags.query) {
        const q = flags.query.toLowerCase();
        notes = notes.filter(n => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q));
      }

      outputResults(notes, flags);
      process.exit(0);
      break;
    }

    case 'vault-delete': {
      if (!flags.soul) throw new Error('--soul is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const res = await os.deleteVaultNote(flags.soul);
      console.log(JSON.stringify(res, null, 2));
      safeExit(0);
      break;
    }

    // ─── Calendar CRUD & Links ────────────────────────────────────────

    case 'calendar-write':
    case 'calendar-add': {
      const title = flags.title;
      const start = flags.start || flags.from;
      if (!title || !start) throw new Error('--title and --start (or --from) are required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const res = await os.writeCalendarEvent({
        title,
        start,
        end: flags.end || flags.to,
        allDay: !!(flags.allDay || flags['all-day']),
        notes: flags.notes || flags.note || flags.description || '',
        location: flags.location || '',
        color: flags.color || undefined,
        soul: flags.soul
      });
      console.log(JSON.stringify(res, null, 2));
      safeExit(0);
      break;
    }

    case 'calendar-get': {
      if (!flags.soul) throw new Error('--soul is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const ev = await os.getCalendarEvent(flags.soul);
      if (!ev) {
        console.error(JSON.stringify({ error: 'Event not found: ' + flags.soul }));
        process.exit(1);
      }
      console.log(JSON.stringify(ev, null, 2));
      process.exit(0);
      break;
    }

    case 'calendar-read': {
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const evs = await os.readCalendarEvents({ from: flags.from, to: flags.to });
      outputResults(evs, flags);
      process.exit(0);
      break;
    }

    case 'calendar-delete': {
      if (!flags.soul) throw new Error('--soul is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const res = await os.deleteCalendarEvent(flags.soul);
      console.log(JSON.stringify(res, null, 2));
      safeExit(0);
      break;
    }

    case 'calendar-events-for': {
      const noteSoul = flags.note;
      const bmSoul = flags.bookmark;
      const taskSoul = flags.task;
      if (!noteSoul && !bmSoul && !taskSoul) throw new Error('--note, --bookmark, or --task soul is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const target = noteSoul ? { kind: 'note', soul: noteSoul } : (bmSoul ? { kind: 'bookmark', soul: bmSoul } : { kind: 'task', soul: taskSoul });
      const evs = await os.eventsFor(target);
      outputResults(evs, flags);
      process.exit(0);
      break;
    }

    case 'calendar-notes-for': {
      if (!flags.event) throw new Error('--event soul is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const notes = await os.notesForEvent(flags.event);
      outputResults(notes, flags);
      process.exit(0);
      break;
    }

    case 'event-link':
    case 'event-unlink': {
      if (!flags.event || (!flags.note && !flags.bookmark && !flags.task)) {
        throw new Error('--event and one of --note, --bookmark, or --task are required.');
      }
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const fn = cmd === 'event-link' ? 'linkToEvent' : 'unlinkFromEvent';
      const target = flags.note ? { kind: 'note', soul: flags.note } : (flags.bookmark ? { kind: 'bookmark', soul: flags.bookmark } : { kind: 'task', soul: flags.task });
      console.log(JSON.stringify(await os[fn](flags.event, target), null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    // ─── Contacts ─────────────────────────────────────────────────────
    case 'contact-write':
    case 'contact-add': {
      if (!flags.name) throw new Error('--name is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const res = await os.writeContact({ soul: flags.soul || null, name: flags.name, emails: flags.email || '', phones: flags.phone || '', org: flags.org || '', notes: flags.notes || '', tags: flags.tags || '', pub: flags.pub || '' });
      console.log(JSON.stringify(res, null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case 'contact-get': {
      if (!flags.soul) throw new Error('--soul is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const c = await os.getContact(flags.soul);
      if (!c) {
        console.error(JSON.stringify({ error: 'Contact not found: ' + flags.soul }));
        process.exit(1);
      }
      console.log(JSON.stringify(c, null, 2));
      process.exit(0);
      break;
    }

    case 'contact-read': {
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      outputResults(await os.readContacts({ query: flags.query, tag: flags.tag }), flags);
      process.exit(0);
      break;
    }

    case 'contact-delete': {
      if (!flags.soul) throw new Error('--soul is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      console.log(JSON.stringify(await os.deleteContact(flags.soul), null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case 'contacts-import': {
      if (!flags.file) throw new Error('--file is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      console.log(JSON.stringify(await os.importContactsVcf(fs.readFileSync(flags.file, 'utf8')), null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case 'contacts-export': {
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const vcf = await os.exportContactsVcf({ query: flags.query, tag: flags.tag });
      if (flags.file) fs.writeFileSync(flags.file, vcf); else process.stdout.write(vcf);
      process.exit(0);
      break;
    }

    // ─── Secrets ──────────────────────────────────────────────────────
    case 'secret-generate': {
      console.log(generatePassword(Number(flags.length) || 24, { symbols: !flags['no-symbols'] }));
      process.exit(0);
      break;
    }

    case 'secret-write':
    case 'secret-add': {
      if (!flags.name) throw new Error('--name is required.');
      // prefer --secret-stdin or --generate: a --secret argument stays in shell history and `ps`
      const secret = flags.generate ? generatePassword(Number(flags.length) || 24, { symbols: !flags['no-symbols'] })
        : flags['secret-stdin'] ? fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '')
        : flags.secret;
      if (!secret || secret === true) throw new Error('--secret, --secret-stdin or --generate is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const res = await os.writeSecret({ soul: flags.soul || null, name: flags.name, kind: flags.kind || 'password', username: flags.username || '', secret, url: flags.url || '', notes: flags.notes || '', tags: flags.tags || '' });
      console.log(JSON.stringify(flags.generate ? { ...res, generated: secret } : res, null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case 'secret-get': {
      if (!flags.soul) throw new Error('--soul is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const sc = await os.getSecret(flags.soul);
      if (!sc) {
        console.error(JSON.stringify({ error: 'Secret not found: ' + flags.soul }));
        process.exit(1);
      }
      console.log(JSON.stringify(sc, null, 2));
      process.exit(0);
      break;
    }

    case 'secret-read': {
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const list = await os.readSecrets({ query: flags.query, kind: flags.kind, tag: flags.tag });
      outputResults(flags.reveal ? list : list.map(({ secret, ...rest }) => ({ ...rest, secret: '••••••' })), flags);
      process.exit(0);
      break;
    }

    case 'secret-delete': {
      if (!flags.soul) throw new Error('--soul is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      console.log(JSON.stringify(await os.deleteSecret(flags.soul), null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    // ─── Bookmarks CRUD & Tools ───────────────────────────────────────

    case 'bookmarks-write':
    case 'bookmarks-add': {
      if (!flags.url) throw new Error('--url is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const tags = flags.tags ? String(flags.tags).split(',').map(t => t.trim()).filter(Boolean) : [];
      const res = await os.writeBookmark({
        url: flags.url,
        title: flags.title || '',
        folder: flags.folder || '',
        tags
      });
      console.log(JSON.stringify(res, null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case 'bookmarks-get': {
      let soul = flags.soul;
      if (!soul && flags.url) soul = await bookmarkSoul(flags.url);
      if (!soul) throw new Error('--soul or --url is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const bm = await os.getBookmark(soul);
      if (!bm) {
        console.error(JSON.stringify({ error: 'Bookmark not found: ' + soul }));
        process.exit(1);
      }
      console.log(JSON.stringify(bm, null, 2));
      process.exit(0);
      break;
    }

    case 'bookmarks-read': {
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const marks = await os.readBookmarks({ folder: flags.folder, query: flags.query });
      outputResults(marks, flags);
      process.exit(0);
      break;
    }

    case 'bookmarks-delete': {
      let soul = flags.soul;
      if (!soul && flags.url) soul = await bookmarkSoul(flags.url);
      if (!soul) throw new Error('--soul or --url is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const res = await os.deleteBookmark(soul);
      console.log(JSON.stringify(res, null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case 'bookmarks-import': {
      if (!flags.file) throw new Error('--file is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      console.log(JSON.stringify(await os.importBookmarksHtml(fs.readFileSync(flags.file, 'utf8')), null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case 'bookmarks-export': {
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const html = await os.exportBookmarksHtml({ folder: flags.folder });
      if (flags.file) fs.writeFileSync(flags.file, html); else process.stdout.write(html);
      process.exit(0);
      break;
    }

    case 'bookmarks-update': {
      if (!flags.file) throw new Error('--file is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      console.log(JSON.stringify(await os.updateBookmarks(JSON.parse(fs.readFileSync(flags.file, 'utf8'))), null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    // ─── Tasks & Kanban CRUD ──────────────────────────────────────────

    case 'task-write':
    case 'task-add': {
      const title = flags.title;
      if (!title) throw new Error('--title is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const tags = flags.tags ? String(flags.tags).split(',').map(t => t.trim()).filter(Boolean) : [];
      const res = await os.writeTask({
        title,
        status: flags.status || 'todo',
        priority: flags.priority || 'medium',
        desc: flags.desc || flags.description || flags.notes || flags.body || '',
        dueDate: flags.due || flags.dueDate || null,
        tags,
        assignee: flags.assignee || '',
        column: flags.column || '',
        soul: flags.soul
      });
      console.log(JSON.stringify(res, null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case 'task-get': {
      if (!flags.soul) throw new Error('--soul is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const tsk = await os.getTask(flags.soul);
      if (!tsk) {
        console.error(JSON.stringify({ error: 'Task not found: ' + flags.soul }));
        process.exit(1);
      }
      console.log(JSON.stringify(tsk, null, 2));
      process.exit(0);
      break;
    }

    case 'task-update': {
      if (!flags.soul) throw new Error('--soul is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const patch = {};
      if (flags.title !== undefined) patch.title = flags.title;
      if (flags.status !== undefined) patch.status = flags.status;
      if (flags.priority !== undefined) patch.priority = flags.priority;
      if (flags.desc !== undefined) patch.desc = flags.desc;
      if (flags.description !== undefined) patch.desc = flags.description;
      if (flags.due !== undefined) patch.dueDate = flags.due;
      if (flags.dueDate !== undefined) patch.dueDate = flags.dueDate;
      if (flags.tags !== undefined) patch.tags = String(flags.tags).split(',').map(t => t.trim()).filter(Boolean);
      if (flags.assignee !== undefined) patch.assignee = flags.assignee;
      if (flags.column !== undefined) patch.column = flags.column;
      const res = await os.updateTask(flags.soul, patch);
      console.log(JSON.stringify(res, null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case 'task-read': {
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const tasks = await os.readTasks({
        status: flags.status,
        priority: flags.priority,
        tag: flags.tag,
        query: flags.query
      });
      outputResults(tasks, flags);
      process.exit(0);
      break;
    }

    case 'task-delete': {
      if (!flags.soul) throw new Error('--soul is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const res = await os.deleteTask(flags.soul);
      console.log(JSON.stringify(res, null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case 'task-link':
    case 'task-unlink': {
      if (!flags.task || (!flags.note && !flags.event && !flags.bookmark && !flags['linked-task'])) {
        throw new Error('--task and one of --note, --event, --bookmark, or --linked-task are required.');
      }
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const fn = cmd === 'task-link' ? 'linkToTask' : 'unlinkFromTask';
      const target = flags.note
        ? { kind: 'note', soul: flags.note }
        : (flags.event
          ? { kind: 'event', soul: flags.event }
          : (flags.bookmark
            ? { kind: 'bookmark', soul: flags.bookmark }
            : { kind: 'task', soul: flags['linked-task'] }));
      console.log(JSON.stringify(await os[fn](flags.task, target), null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case 'tasks-for':
    case 'task-links-for': {
      if (!flags.note && !flags.event && !flags.bookmark && !flags.task) {
        throw new Error('--note, --event, --bookmark, or --task soul is required.');
      }
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const target = flags.note
        ? { kind: 'note', soul: flags.note }
        : (flags.event
          ? { kind: 'event', soul: flags.event }
          : (flags.bookmark
            ? { kind: 'bookmark', soul: flags.bookmark }
            : { kind: 'task', soul: flags.task }));
      const tsks = await os.tasksFor(target);
      outputResults(tsks, flags);
      process.exit(0);
      break;
    }

    // ─── smollog (Blog) CRUD & Alias ──────────────────────────────────

    case 'blog-publish':
    case 'blog-write': {
      const title = flags.title;
      const content = flags.content || flags.body;
      if (!title || !content) {
        throw new Error('--title and --content (or --body) are required.');
      }
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const res = await os.publishBlogPost({
        title,
        content,
        tags: flags.tags ? String(flags.tags).split(',').map(t => t.trim()) : [],
        id: flags.id
      });

      console.log(JSON.stringify({
        ...res,
        url: `${server}/blog/${os.pub}?post=${res.id}`
      }, null, 2));
      process.exit(0);
      break;
    }

    // public posts need no login: pass --alias <username>, or credentials for your own
    case 'blog-get':
    case 'blog-read': {
      if (cmd === 'blog-get' && !flags.id) throw new Error('--id is required.');
      let author = typeof flags.alias === 'string' ? flags.alias : null;
      const envUser = flags.user || process.env.ZENOS_USER || process.env.ZENOS_USERNAME;
      const envPass = flags.pass || process.env.ZENOS_PASS || process.env.ZENOS_PASSWORD;
      if (!author && envUser && envPass) {
        await os.login(envUser, envPass);
        author = os.pub;
      }
      if (!author) throw new Error('Must provide --alias <username>, or credentials (--user and --pass, or ZENOS_USER and ZENOS_PASS in .env).');

      if (cmd === 'blog-read') {
        outputResults(await os.readBlogPosts(author), flags);
        process.exit(0);
      }
      const post = await os.getBlogPost(flags.id, author);
      if (!post) {
        console.error(JSON.stringify({ error: 'Blog post not found: ' + flags.id }));
        process.exit(1);
      }
      console.log(JSON.stringify(post, null, 2));
      process.exit(0);
      break;
    }

    case 'blog-delete': {
      if (!flags.id) throw new Error('--id is required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const res = await os.deleteBlogPost(flags.id);
      console.log(JSON.stringify(res, null, 2));
      process.exit(0);
      break;
    }

    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
