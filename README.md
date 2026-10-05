# 🌌 ZenOS — The Sovereign Decentralized Agentic OS

> A zero-backend, multi-app decentralized operating system powered by **ZEN** P2P graph database & cryptographic identity.

ZenOS reimagines personal computing in the decentralized AI era. Instead of siloed databases and centralized accounts, your entire digital life lives on a sovereign cryptographic overlay under your personal master keypair:

- 🖥️ **Web Desktop / Workspace**: Zero-backend graphical user interface ([ZenOS Web](https://github.com/scobru/zenvault))
- 🔒 **Private Knowledge Base**: End-to-end AES-GCM encrypted notes (Vault: `~{pub}/vault`)
- 📅 **Calendar**: E2EE event scheduling, agenda, and bidirectional note linking (`~{pub}/calendar`)
- 🔖 **Bookmarks**: Private encrypted web library with browser Netscape HTML import/export (`~{pub}/bookmarks`)
- 🪶 **Public Publishing**: Verifiable, signed decentralized blog ([smollog](https://github.com/scobru/smollog): `~{pub}/posts`)
- 🤖 **Autonomous AI Agent Ready**: Autonomous LLMs and agents can read, write, and orchestrate across your apps with zero configuration
- 🌐 **100% Serverless & P2P**: No SQL, no servers, no vendor lock-in. Powered by GunDB/ZEN relays

---

## 🏛️ System Architecture

```
                                 ┌───────────────────────────────┐
                                 │     Master Credentials        │
                                 │    (username + password)      │
                                 └──────────────┬────────────────┘
                                                │
                                                ▼
                                 ┌───────────────────────────────┐
                                 │      Sovereign Identity       │
                                 │    0oQit1EicIMg... (secp256k1)│
                                 └──────────────┬────────────────┘
                                                │
                 ┌──────────────────────────────┼──────────────────────────────┐
                 │                              │                              │
                 ▼                              ▼                              ▼
         ┌──────────────┐               ┌──────────────┐               ┌──────────────┐
         │    Vault     │               │   Calendar   │               │   smollog    │
         │ ~{pub}/vault │               │~{pub}/calenda│               │ ~{pub}/posts │
         │  [AES-GCM]   │               │  [AES-GCM]   │               │   [Signed]   │
         └──────────────┘               └──────────────┘               └──────────────┘
                 ▲                              ▲                              ▲
                 │                              │                              │
                 └──────────────────────────────┼──────────────────────────────┘
                                                │
                                                ▼
                               ┌─────────────────────────────────┐
                               │  ZenOS Web / Autonomous Agents  │
                               │    (GUI Workspace & Scripts)    │
                               └─────────────────────────────────┘
```

---

## 📂 Active Application Nodes

### 1. Vault (`~{pub}/vault`)
- **Status**: Live (Web GUI: [ZenOS Web](https://github.com/scobru/zenvault))
- **Security**: Client-side AES-GCM-256 encryption. Relays only see blind ciphertexts.
- **Data Model**: Bear-style Markdown notes, tags (`#tag`), tasks (`- [ ]`), images, and bidirectional calendar event links.

### 2. Calendar (`~{pub}/calendar`)
- **Status**: Live
- **Security**: Client-side AES-GCM-256 encryption.
- **Data Model**: Events, dates, reminders, and links to Vault notes.

### 3. Bookmarks (`~{pub}/bookmarks`)
- **Status**: Live
- **Security**: Client-side AES-GCM-256 encryption.
- **Data Model**: URLs, titles, tags, folder hierarchy, Netscape HTML bookmark format import/export.

### 4. smollog (`~{pub}/posts`)
- **Status**: Live
- **Security**: Signed public posts authenticated with `{ authenticator: pair }`.
- **Data Model**: Clean Markdown journal entries, reading time estimation, tags, and custom author aliases.

### 5. Tasks & Kanban (`~{pub}/tasks`)
- **Status**: Live
- **Security**: Client-side AES-GCM-256 encryption.
- **Data Model**: Task title, status (`todo`, `in_progress`, `done`, `blocked`), priority (`low`, `medium`, `high`, `urgent`), markdown descriptions, due dates, tags, assignees, custom kanban columns, and bidirectional links to Vault notes, calendar events, bookmarks or other tasks.

### 6. Future Nodes
- 📬 **P2P Inbox (`~{pub}/inbox`)**: Direct asymmetric encrypted agent-to-agent messaging.
- 🔑 **Secrets & Keyring (`~{pub}/secrets`)**: E2EE API keys, passwords and credentials vault.
- 🤖 **Agents Registry (`~{pub}/agents`)**: Delegation of scoped PEN certificates and permissions.

---

## 🤖 For AI Agents & Automation Scripts

Read the complete AI integration guide in [llm.txt](file:///d:/shogun-2/zenos/llm.txt).

### Quickstart Example (JavaScript SDK)
```javascript
import ZenOS from './zenos.js';

const os = new ZenOS();
await os.login('scobru', 'your_password');

// 1. Vault Notes CRUD
const note = await os.writeVaultNote({ title: 'Research', body: 'Agent notes', cat: 'ai' });
const myNote = await os.getVaultNote(note.soul);

// 2. Calendar Events CRUD & Linking
const ev = await os.writeCalendarEvent({ title: 'Team Sync', start: Date.now() + 3600000 });
await os.linkToEvent(ev.soul, { soul: note.soul });

// 3. Bookmarks CRUD
await os.writeBookmark({ url: 'https://github.com/scobru/zenos', title: 'ZenOS', folder: 'Dev' });

// 4. Tasks & Kanban CRUD
const task = await os.writeTask({ title: 'Deploy Relays', priority: 'high', status: 'todo' });
await os.linkToTask(task.soul, { kind: 'note', soul: note.soul });

// 5. smollog Blog CRUD
await os.publishBlogPost({
  title: '🚀 Dispatches from ZenOS',
  content: 'Automated dispatch synchronized directly to the decentralized P2P graph.',
  tags: ['zenos', 'agents', 'p2p']
});
```

### CLI Quickstart (Full CRUD)
```bash
# Vault (Notes) CRUD
node cli.js vault-write --title "Sprint Plan" --body "Tasks..." --cat "work"
node cli.js vault-get   --soul <soul>
node cli.js vault-read  --table
node cli.js vault-delete --soul <soul>

# Calendar Events CRUD & Graph Links
node cli.js calendar-write --title "Demo" --start "2026-10-10T15:00:00Z"
node cli.js calendar-get   --soul <soul>
node cli.js calendar-read  --table
node cli.js event-link     --event <ev-soul> --note <note-soul>
node cli.js calendar-delete --soul <soul>

# Tasks & Kanban CRUD & Graph Links
node cli.js task-write  --title "Sprint Task" --priority "high" --status "todo"
node cli.js task-get    --soul <soul>
node cli.js task-read   --table
node cli.js task-update --soul <soul> --status "done"
node cli.js task-link   --task <task-soul> --note <note-soul>
node cli.js task-delete --soul <soul>

# Bookmarks CRUD & Netscape HTML
node cli.js bookmarks-write --url "https://github.com/scobru/zenos" --title "ZenOS"
node cli.js bookmarks-get   --url "https://github.com/scobru/zenos"
node cli.js bookmarks-read  --table
node cli.js bookmarks-delete --url "https://github.com/scobru/zenos"

# smollog Blog CRUD
node cli.js blog-publish --title "Hello World" --content "My post..."
node cli.js blog-get     --id <id>
node cli.js blog-read    --table
node cli.js blog-delete  --id <id>
```

---

## 🛰️ Relays

ZenOS is serverless, but data syncs through **ZEN relays**. By default it connects to:

- `wss://delay.scobrudot.dev/zen` — **the author's personal [Delay](file:///d:/shogun-2/shogun-relay) relay** (best-effort, no SLA)
- `wss://zen.akao.io:8420/zen` — public upstream [ZEN](file:///d:/shogun-2/zen) network relay

> ⚠️ The system works out of the box **because it uses the author's relay**. For production or full sovereignty, run your own and point ZenOS to it.

```bash
# add a custom relay to the defaults
node cli.js vault-read --user u --pass p --relay "wss://relay.example.com/zen"
# use only your relay
ZENOS_RELAYS="wss://relay.example.com/zen" ZENOS_ONLY_CUSTOM_RELAYS=true node cli.js vault-read --user u --pass p
```

```javascript
const os = new ZenOS({ extraPeers: ['wss://relay.example.com/zen'] });            // defaults + custom
const own = new ZenOS({ extraPeers: ['ws://localhost:8420/zen'], useDefaultRelays: false }); // custom only
```

Full guide (custom relays + self-hosting with `zen` or `shogun-relay`): **[RELAYS.md](file:///d:/shogun-2/zenOS/RELAYS.md)**.

---

## 📜 License
MIT License.

## File storage (Delay relay + IPFS)

Files go to IPFS through a [Delay](https://github.com/scobru/delay) relay. Plain ZEN relays have no IPFS, so ZenOS probes each relay (`GET /api/v1/system/health`) and uses the first Delay one; it errors if none is configured. Upload needs the relay's admin token or `delay-api-*` key, passed as `--token` / `storageToken` or `ZENOS_STORAGE_TOKEN`.

```bash
export ZENOS_STORAGE_TOKEN=...
node cli.js file-upload   --file ./photo.png          # encrypted by default (--plain to skip)
node cli.js file-list
node cli.js file-download --cid <cid> --out ./photo.png
```

SDK: `os.uploadFile(bytes, name, { encrypt })`, `os.listFiles()`, `os.downloadFile(cid)`. Encrypted files are base64'd before AES-GCM, so they are ~1.4x bigger on IPFS; an encrypted index lives at `~pub/files/<cid>`.
