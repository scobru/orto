#!/usr/bin/env node

/**
 * ZenOS CLI Runner for Agents and Scripts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ZenOS, { DEFAULT_RELAYS, resolvePeers } from './zenos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
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
  } catch (_) {}
}

const [,, cmd, ...rest] = process.argv;
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

async function main() {
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`
ZenOS CLI — Sovereign Agent Tools
Usage:
  node cli.js identity [--user <user> --pass <pass>]
  node cli.js migrate [--user <user> --pass <pass>]   # copy vault/calendar/bookmarks from the earlier identities
  node cli.js vault-write [--user <user> --pass <pass>] --title <title> --body <body> [--cat <cat>] [--pinned]
  node cli.js vault-read [--user <user> --pass <pass>] [--cat <cat>] [--query <q>] [--timeout <ms>]
  node cli.js calendar-read [--user <user> --pass <pass>] [--from <date>] [--to <date>]
  node cli.js event-link   [--user <user> --pass <pass>] --event <soul> --note <soul>     # link a note to an event
  node cli.js event-unlink [--user <user> --pass <pass>] --event <soul> --note <soul>
  node cli.js bookmarks-import [--user <user> --pass <pass>] --file <export.html>   # Brave/Chrome/Firefox export
  node cli.js bookmarks-read [--user <user> --pass <pass>] [--folder <path>] [--query <q>] [--timeout <ms>]
  node cli.js bookmarks-export [--user <user> --pass <pass>] [--folder <path>] [--file <out.html>]
  node cli.js bookmarks-update [--user <user> --pass <pass>] --file <changes.json>  # [{soul, title?, folder?, tags?}]
  node cli.js blog-publish [--user <user> --pass <pass>] --title <title> --content <content> [--tags <tags>]
  node cli.js blog-read [--pub <pub>] [--alias <alias>] [--user <user> --pass <pass>]
  node cli.js relays                      # print the effective relay list

Credentials:
  Flags:     --user <user> --pass <pass>
  Env vars:  ZENOS_USER and ZENOS_PASS (or ZENOS_USERNAME / ZENOS_PASSWORD)
  Files:     .env in skill directory or current working directory (or --env <path>)

Relay options (all commands):
  --relay <url[,url]>     add custom relay(s) on top of the defaults
  --no-default-relays     use only custom relays (--relay / ZENOS_RELAYS)
  --peers <url[,url]>     replace the relay list entirely

Env vars:
  ZENOS_RELAYS=<url[,url]>        custom relays, always added
  ZENOS_ONLY_CUSTOM_RELAYS=true   same as --no-default-relays

Default relays: ${DEFAULT_RELAYS.join(', ')}
(delay.scobrudot.dev is the author's personal relay — run your own, see RELAYS.md)
`);
    process.exit(0);
  }

  const peers = resolvePeers({
    peers: typeof flags.peers === 'string' ? flags.peers : undefined,
    extraPeers: typeof flags.relay === 'string' ? flags.relay : undefined,
    useDefaultRelays: flags['no-default-relays'] ? false : undefined
  });

  if (cmd === 'relays') {
    console.log(JSON.stringify({ peers }, null, 2));
    process.exit(0);
  }

  const os = new ZenOS({ peers });

  switch (cmd) {
    case 'identity': {
      const { user, pass } = requireCredentials();
      const pair = await os.login(user, pass);
      console.log(JSON.stringify({
        pub: pair.pub,
        priv: pair.priv,
        address: pair.address,
        curve: pair.curve
      }, null, 2));
      process.exit(0);
      break;
    }

    case 'migrate': {
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      console.log(JSON.stringify({ pub: os.pub, legacyPubs: os.legacyPairs.map(p => p.pub), ...await os.migrateLegacy() }, null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case 'calendar-read': {
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      console.log(JSON.stringify(await os.readCalendarEvents({ from: flags.from, to: flags.to, timeoutMs: 15000 }), null, 2));
      process.exit(0);
      break;
    }

    case 'event-link':
    case 'event-unlink': {
      if (!flags.event || !flags.note) throw new Error('--event and --note are required.');
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const fn = cmd === 'event-link' ? 'linkToEvent' : 'unlinkFromEvent';
      console.log(JSON.stringify(await os[fn](flags.event, { kind: 'note', soul: flags.note }), null, 2));
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

    case 'bookmarks-read': {
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const marks = await os.readBookmarks({ folder: flags.folder, query: flags.query, timeoutMs: flags.timeout ? Number(flags.timeout) : 15000 });
      console.log(JSON.stringify(marks, null, 2));
      process.exit(0);
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

    case 'vault-write': {
      if (!flags.title || !flags.body) {
        throw new Error('--title, and --body are required.');
      }
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const res = await os.writeVaultNote({
        title: flags.title,
        body: flags.body,
        cat: flags.cat || 'agent',
        pinned: !!flags.pinned,
        soul: flags.soul
      });
      console.log(JSON.stringify(res, null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case 'vault-read': {
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const timeoutMs = parseInt(flags.timeout || '4500', 10);
      let notes = await os.readVaultNotes(timeoutMs);

      if (flags.cat) {
        notes = notes.filter(n => n.cat === flags.cat);
      }
      if (flags.query) {
        const q = flags.query.toLowerCase();
        notes = notes.filter(n => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q));
      }

      console.log(JSON.stringify(notes, null, 2));
      process.exit(0);
      break;
    }

    case 'blog-publish': {
      if (!flags.title || !flags.content) {
        throw new Error('--title and --content are required.');
      }
      const { user, pass } = requireCredentials();
      await os.login(user, pass);
      const res = await os.publishBlogPost({
        title: flags.title,
        content: flags.content,
        tags: flags.tags ? String(flags.tags).split(',').map(t => t.trim()) : [],
        id: flags.id
      });

      // Register alias
      await os.registerAlias(user);

      console.log(JSON.stringify({
        ...res,
        url: `https://smollog.vercel.app/${os.pub}?post=${res.id}`
      }, null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case 'blog-read': {
      let targetPub = flags.pub;
      if (!targetPub && flags.alias) {
        targetPub = await new Promise((resolve) => {
          os.zen.get('smollog_aliases').get(flags.alias.toLowerCase()).once((found) => {
            resolve(found || null);
          });
          setTimeout(() => resolve(null), 3000);
        });
      }
      const envUser = flags.user || process.env.ZENOS_USER || process.env.ZENOS_USERNAME;
      const envPass = flags.pass || process.env.ZENOS_PASS || process.env.ZENOS_PASSWORD;
      if (!targetPub && envUser && envPass) {
        const pair = await os.login(envUser, envPass);
        targetPub = pair.pub;
      }
      if (!targetPub) throw new Error('Must provide --pub, --alias, or credentials (--user and --pass, or ZENOS_USER and ZENOS_PASS in .env).');

      const timeoutMs = parseInt(flags.timeout || '4500', 10);
      const posts = await os.readBlogPosts(targetPub, timeoutMs);
      console.log(JSON.stringify(posts, null, 2));
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
