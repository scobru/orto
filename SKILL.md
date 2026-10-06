---
name: zenos
description: "Use when interacting with a self-hosted ZenOS server: read, write, search and sync encrypted notes (Vault), calendar events, tasks, bookmarks, contacts, secrets and files, and publish public blog posts. Works through the zenos CLI/SDK against a ZenOS server (SQLite)."
---

# ZenOS Agent Skill (self-hosted)

ZenOS is a self-hosted personal workspace: one Node server (`server.js`, SQLite + upload folder) and a CLI/SDK. All private data is AES-GCM encrypted on the client with a key derived from the user's login, so the server stores only ciphertext.

Apps (collections): `vault` notes, `calendar`, `tasks`, `bookmarks`, `contacts`, `secrets`, `files`, and the public `posts` blog.

## Setup

```bash
node cli.js register --user <u> --pass <p> --server http://host:8787   # first time only
```
Server URL: `--server` or `ZENOS_SERVER` (default `http://127.0.0.1:8787`). Credentials: `--user/--pass`, or `ZENOS_USER`/`ZENOS_PASS` in `.env` (see `.env.example`). Run the server with `npm start` (Node >= 22.5).

Rules for agents:
1. Username is case-insensitive, the password is case-sensitive; never alter the user's credentials. There is no password recovery.
2. Never print or store the password in notes, logs or commits.
3. Registration may be closed (`ZENOS_REGISTRATION=closed`): ask the user for an existing account.
4. Read commands accept `--count`, `--limit/-n`, `--page/-p`, `--offset`, `--table/-t` so large collections do not flood the context.
5. Bulk rewrites (e.g. reorganising bookmarks) have no undo: run `bookmarks-export --file backup.html` first, show the user the plan, then apply.

## Commands

```
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

  # Blog (public posts)
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
```

## SDK

```js
import ZenOS from './zenos.js';
const os = new ZenOS({ server });
await os.login(user, pass);                       // { create: true } registers
await os.writeVaultNote({ title, body, cat });
await os.readTasks({ status: 'todo' });
await os.uploadFile(bytes, 'name.ext');           // encrypted client-side
await os.publishBlogPost({ title, content, tags });
```
Full method list: `llm.txt`. Live updates: `os.onVaultNote/onTask/...(cb)` (server-sent events); call `os.close()` to end the stream before exiting.

## Public blog

Posts are plaintext. Anyone can read `GET <server>/api/u/<username>/posts` or open `<server>/blog/<username>`. Do not publish secrets there.
