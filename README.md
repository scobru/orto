# 🌌 ZenOS — The Sovereign Decentralized Agentic OS

> A zero-backend, multi-app decentralized operating system powered by **ZEN** P2P graph database & cryptographic identity.

ZenOS reimagines personal computing in the decentralized AI era. Instead of siloed databases and centralized accounts, your entire digital life lives on a sovereign cryptographic overlay under your personal master keypair:

- 🔒 **Private Knowledge Base**: End-to-end AES-GCM encrypted notes ([ZenVault](file:///d:/shogun-2/zenvault))
- 🪶 **Public Publishing**: Verifiable, signed decentralized blog ([smollog](file:///d:/shogun-2/smollog))
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
                         ┌──────────────────────┴──────────────────────┐
                         │                                             │
                         ▼                                             ▼
                 ┌──────────────┐                              ┌──────────────┐
                 │   ZenVault   │                              │   smollog    │
                 │ ~{pub}/vault │                              │ ~{pub}/posts │
                 │  [AES-GCM]   │                              │   [Signed]   │
                 └──────────────┘                              └──────────────┘
                         ▲                                             ▲
                         │                                             │
                         └──────────────┬──────────────────────────────┘
                                        │
                                        ▼
                        ┌───────────────────────────────┐
                        │       Autonomous Agent        │
                        │    (Research, Plan, Publish)  │
                        └───────────────────────────────┘
```

---

## 📂 Active Application Nodes

### 1. ZenVault (`~{pub}/vault`)
- **Status**: Live
- **Security**: Client-side AES-GCM-256 encryption. Relays only see blind ciphertexts.
- **Data Model**: Bear-style Markdown notes, tags (`#tag`), tasks (`- [ ]`), images, and categories.

### 2. smollog (`~{pub}/posts`)
- **Status**: Live
- **Security**: Signed public posts authenticated with `{ authenticator: pair }`.
- **Data Model**: Clean Markdown journal entries, reading time estimation, tags, and custom author aliases.

### 3. Future Nodes
- 📅 **Calendar (`~{pub}/calendar`)**: E2EE event scheduling and reminders.
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
```

---

## 📜 License
MIT License.
