---
name: zenos
description: "Use when interacting with ZenOS — the sovereign decentralized operating system powered by ZEN P2P graph. Enables autonomous agents to read, write, search, and synchronize encrypted private notes in ZenVault, publish and read public blog posts in smollog, and manage sovereign cryptographic identities."
---

# ZenOS Agent Skill

ZenOS is a decentralized, zero-backend, multi-app operating system powered by **ZEN** P2P graph database & cryptographic identity (`secp256k1`).

This skill provides autonomous AI agents with tools, schemas, and workflows to orchestrate across a user's sovereign decentralized data nodes:
1. **ZenVault** (`~{pub}/vault`): End-to-end encrypted private knowledge base (AES-GCM-256).
2. **smollog** (`~{pub}/posts`): Public verifiable Markdown blog posts and journals.
3. **Future Nodes**: Calendar (`~{pub}/calendar`), Tasks (`~{pub}/tasks`), and direct P2P messaging.

---

## 🚀 Quick Execution (CLI & Scripts)

The repository provides a universal CLI tool [`cli.js`](file:///d:/shogun-2/zenOS/cli.js) to perform operations without writing boilerplate code.

### 1. Derive Sovereign Identity
Derive public key (`pair.pub`) and EVM address deterministically from user credentials:
```bash
node cli.js identity --user "<username>" --pass "<password>"
```

### 2. ZenVault — Read & Decrypt Notes
Fetch and decrypt all notes from the user's private vault:
```bash
node cli.js vault-read --user "<username>" --pass "<password>"
```

Filter by category or search query:
```bash
node cli.js vault-read --user "<username>" --pass "<password>" --cat "research" --query "AI agent"
```

### 3. ZenVault — Write / Update an Encrypted Note
Encrypt and save a note directly into the P2P graph:
```bash
node cli.js vault-write \
  --user "<username>" \
  --pass "<password>" \
  --title "🐻 Project Summary" \
  --body "### Summary\n- [x] Gather data\n- [ ] Deploy model" \
  --cat "research"
```

### 4. smollog — Publish Public Blog Post
Publish a public, cryptographically signed Markdown article to smollog:
```bash
node cli.js blog-publish \
  --user "<username>" \
  --pass "<password>" \
  --title "Dispatches from ZenOS" \
  --content "### Decentralized Autonomous Publishing\n\nThis article was signed and propagated via P2P graph." \
  --tags "zenos,agents,p2p"
```

### 5. smollog — Read Author Blog Posts
Read public articles from an author's public key or alias:
```bash
node cli.js blog-read --alias "scobru"
```
Or by public key:
```bash
node cli.js blog-read --pub "0oQit1EicIMgYeM9rVRMjmgP9MoQjfK0XJLq6imoJ1CR0"
```

### 6. Custom Relays
If the user provides their own relay, pass it on **every** command (or set `ZENOS_RELAYS` once):
```bash
# add to the default relays
node cli.js vault-read --user "<username>" --pass "<password>" --relay "wss://relay.example.com/zen"

# use ONLY the user's relay(s)
node cli.js vault-read --user "<username>" --pass "<password>" --relay "wss://relay.example.com/zen" --no-default-relays

# check the effective list
node cli.js relays --relay "wss://relay.example.com/zen"
```
Env alternative: `ZENOS_RELAYS="wss://a/zen,wss://b/zen"` and `ZENOS_ONLY_CUSTOM_RELAYS=true`.
URLs without a path get `/zen` appended. See [RELAYS.md](file:///d:/shogun-2/zenOS/RELAYS.md) for self-hosting.

---

## 💻 Programmatic Usage via JavaScript SDK

Any agent script can import [`zenos.js`](file:///d:/shogun-2/zenOS/zenos.js):

```javascript
import ZenOS from './zenos.js';

const os = new ZenOS();
await os.login(username, password);

// 1. Read private vault notes
const notes = await os.readVaultNotes();

// 2. Write an encrypted note
await os.writeVaultNote({
  title: "🤖 Agent Sync",
  body: "Automated report generated at " + new Date().toISOString(),
  cat: "logs"
});

// 3. Publish public blog post to smollog
await os.publishBlogPost({
  title: "Autonomous Post",
  content: "Content goes here...",
  tags: ["ai", "p2p"]
});

// Custom relays
const custom = new ZenOS({ extraPeers: ["wss://relay.example.com/zen"] });              // defaults + custom
const onlyOwn = new ZenOS({ extraPeers: ["wss://relay.example.com/zen"], useDefaultRelays: false });
```

---

## 🔒 Rules & Protocol Conventions

1. **Always use `{ authenticator: pair }` on `.put()`**: The P2P relays reject any write under a user namespace (`~{pub}/...`) if not cryptographically signed by the owner pair.
2. **Zero-Knowledge Vault (`/vault`)**: Payloads in the vault MUST be encrypted client-side with `ZEN.encrypt(text, pair)`. Relays only store blind ciphertexts.
3. **Public Signed Journal (`/posts`)**: Blog posts are stored in plaintext Markdown but signed with ECDSA so readers can verify author authenticity.
4. **Relay Connectivity**: Default relays are `wss://delay.scobrudot.dev/zen` (**the author's personal Delay relay**, best-effort, no SLA) and `wss://zen.akao.io:8420/zen` (public ZEN network). If the user specifies a custom relay, ALWAYS use it (`--relay` / `ZENOS_RELAYS`); use `--no-default-relays` only if the user asks for their relay exclusively — and warn that the ZenVault/smollog web apps only see that data if the custom relay peers with the default network.
5. **Deterministic Seed**: The seed is `username + password`. Never alter credential casing without user confirmation.
