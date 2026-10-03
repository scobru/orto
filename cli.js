#!/usr/bin/env node

/**
 * ZenOS CLI Runner for Agents and Scripts
 */

import fs from 'fs';
import ZenOS, { DEFAULT_RELAYS, resolvePeers } from './zenos.js';

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

const [,, cmd, ...rest] = process.argv;
const flags = parseArgs(rest);

async function main() {
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`
ZenOS CLI — Sovereign Agent Tools
Usage:
  node cli.js identity --user <user> --pass <pass>
  node cli.js migrate --user <user> --pass <pass>   # copy vault/calendar/bookmarks from the earlier identities
  node cli.js vault-write --user <user> --pass <pass> --title <title> --body <body> [--cat <cat>] [--pinned]
  node cli.js vault-read --user <user> --pass <pass> [--cat <cat>] [--query <q>] [--timeout <ms>]
  node cli.js bookmarks-import --user <user> --pass <pass> --file <export.html>   # Brave/Chrome/Firefox export
  node cli.js bookmarks-read --user <user> --pass <pass> [--folder <path>] [--query <q>] [--timeout <ms>]
  node cli.js bookmarks-export --user <user> --pass <pass> [--folder <path>] [--file <out.html>]   # importable by Brave/Chrome/Firefox
  node cli.js bookmarks-update --user <user> --pass <pass> --file <changes.json>  # [{soul, title?, folder?, tags?}]
  node cli.js blog-publish --user <user> --pass <pass> --title <title> --content <content> [--tags <tags>]
  node cli.js blog-read [--pub <pub>] [--alias <alias>] [--user <user> --pass <pass>]
  node cli.js relays                      # print the effective relay list

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
      if (!flags.user || !flags.pass) throw new Error('--user and --pass are required.');
      const pair = await os.login(flags.user, flags.pass);
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
      if (!flags.user || !flags.pass) throw new Error('--user and --pass are required.');
      await os.login(flags.user, flags.pass);
      console.log(JSON.stringify({ pub: os.pub, legacyPubs: os.legacyPairs.map(p => p.pub), ...await os.migrateLegacy() }, null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case 'bookmarks-import': {
      if (!flags.user || !flags.pass || !flags.file) throw new Error('--user, --pass and --file are required.');
      await os.login(flags.user, flags.pass);
      console.log(JSON.stringify(await os.importBookmarksHtml(fs.readFileSync(flags.file, 'utf8')), null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case 'bookmarks-read': {
      if (!flags.user || !flags.pass) throw new Error('--user and --pass are required.');
      await os.login(flags.user, flags.pass);
      const marks = await os.readBookmarks({ folder: flags.folder, query: flags.query, timeoutMs: flags.timeout ? Number(flags.timeout) : 15000 });
      console.log(JSON.stringify(marks, null, 2));
      process.exit(0);
      break;
    }

    case 'bookmarks-export': {
      if (!flags.user || !flags.pass) throw new Error('--user and --pass are required.');
      await os.login(flags.user, flags.pass);
      const html = await os.exportBookmarksHtml({ folder: flags.folder });
      if (flags.file) fs.writeFileSync(flags.file, html); else process.stdout.write(html);
      process.exit(0);
      break;
    }

    case 'bookmarks-update': {
      if (!flags.user || !flags.pass || !flags.file) throw new Error('--user, --pass and --file are required.');
      await os.login(flags.user, flags.pass);
      console.log(JSON.stringify(await os.updateBookmarks(JSON.parse(fs.readFileSync(flags.file, 'utf8'))), null, 2));
      setTimeout(() => process.exit(0), 500);
      break;
    }

    case 'vault-write': {
      if (!flags.user || !flags.pass || !flags.title || !flags.body) {
        throw new Error('--user, --pass, --title, and --body are required.');
      }
      await os.login(flags.user, flags.pass);
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
      if (!flags.user || !flags.pass) throw new Error('--user and --pass are required.');
      await os.login(flags.user, flags.pass);
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
      if (!flags.user || !flags.pass || !flags.title || !flags.content) {
        throw new Error('--user, --pass, --title, and --content are required.');
      }
      await os.login(flags.user, flags.pass);
      const res = await os.publishBlogPost({
        title: flags.title,
        content: flags.content,
        tags: flags.tags ? String(flags.tags).split(',').map(t => t.trim()) : [],
        id: flags.id
      });

      // Register alias
      await os.registerAlias(flags.user);

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
      if (!targetPub && flags.user && flags.pass) {
        const pair = await os.login(flags.user, flags.pass);
        targetPub = pair.pub;
      }
      if (!targetPub) throw new Error('Must provide --pub, --alias, or --user and --pass.');

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
