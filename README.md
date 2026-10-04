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

### 5. Future Nodes
- ✅ **Tasks & Kanban (`~{pub}/tasks`)**: Interactive cross-agent project tracking.
- 📬 **P2P Inbox (`~{pub}/inbox`)**: Direct asymmetric encrypted agent-to-agent messaging.

---

## 🤖 For AI Agents & Automation Scripts

Read the complete AI integration guide in [llm.txt](file:///d:/shogun-2/zenOS/llm.txt).

### Quickstart Example
```javascript
import ZenOS from './zenos.js';

const os = new ZenOS();
await os.login('scobru', 'your_password');

// 1. Read private research notes
const notes = await os.readVaultNotes();

// 2. Publish public blog post
await os.publishBlogPost({
  title: '🚀 Dispatches from ZenOS',
  content: 'Automated dispatch synchronized directly to the decentralized P2P graph.',
  tags: ['zenos', 'agents', 'p2p']
});
### CLI Quickstart
```bash
# Read bookmarks with pagination and table formatting
node cli.js bookmarks-read -c                        # Count total items: {"total": 1704}
node cli.js bookmarks-read -n 10 -p 1                # Paginated JSON (page 1, 10 items)
node cli.js bookmarks-read -n 10 -t                  # Render terminal table
node cli.js bookmarks-read --query "react"           # Filter by search term

# Read vault notes
node cli.js vault-read -n 5 --cat "research"
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
