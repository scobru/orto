---
name: zenos
description: "Use when interacting with ZenOS — the sovereign decentralized operating system powered by ZEN P2P graph. Enables autonomous agents to read, write, search, and synchronize encrypted private notes in the Vault, manage calendar events, curate bookmarks, publish public signed blog posts on smollog, and resolve sovereign cryptographic identities."
---

# ZenOS Agent Skill

ZenOS is a decentralized, zero-backend, multi-app operating system powered by **ZEN** P2P graph database & cryptographic identity (`secp256k1`).

This skill provides autonomous AI agents with tools, schemas, and workflows to orchestrate across a user's sovereign decentralized data nodes:
1. **Vault (`~{pub}/vault`)**: End-to-end encrypted private notes & knowledge base (AES-GCM-256).
2. **Calendar (`~{pub}/calendar`)**: E2EE event scheduling, reminders, and bidirectional note linking.
3. **Tasks & Kanban (`~{pub}/tasks`)**: E2EE interactive cross-agent task tracking, priorities, due dates, and graph links.
4. **Bookmarks (`~{pub}/bookmarks`)**: Private encrypted web library with browser Netscape HTML import/export.
5. **smollog (`~{pub}/posts`)**: Public verifiable Markdown blog posts and journals signed with ECDSA.

---

## 🚀 Quick Execution (CLI & Scripts)

The skill provides a universal CLI tool [`cli.js`](cli.js) to perform operations without writing boilerplate code.
Run it from the skill directory (`node cli.js ...`), or from any project with the full path to the installed skill: `node "<skill-dir>/cli.js" ...`.

### 🔑 Credentials & .env Configuration
You can place a `.env` file directly inside the skill directory (see [`.env.example`](.env.example)) or your working directory:
```env
ZENOS_USER=your_username
ZENOS_PASS=your_password
```
When configured, **`--user` and `--pass` can be completely omitted** from all CLI commands! If specified, command flags will override the `.env` variables.

### 📄 Pagination & Limiting Output (All Read Commands)
When querying nodes with hundreds or thousands of records (e.g. bookmarks or vault notes), use pagination flags to avoid dumping massive payloads:
- `--count` (`-c`): Returns only the total number of records (e.g. `{"total": 1704}`) without returning the list.
- `--limit <n>` (`-n <n>`): Limit number of records (default: 20 when paginating).
- `--page <n>` (`-p <n>`): 1-based page number (e.g. `-n 20 -p 1`).
- `--offset <n>`: Skip first *n* records.
- `--table` (`-t`): Render records as a compact console table with truncated fields.

Example:
```bash
node cli.js bookmarks-read -c                        # {"total": 1704}
node cli.js bookmarks-read -n 10 -p 1                # Page 1 with 10 records
node cli.js bookmarks-read -n 10 -t                  # Nice terminal table
node cli.js vault-read -n 5                          # Top 5 vault notes
```

### 1. Derive Sovereign Identity
Derive public key (`pair.pub`) and EVM address deterministically from user credentials:
```bash
node cli.js identity
# Or with explicit credentials:
# node cli.js identity --user "<username>" --pass "<password>"
```

### 2. Vault — Full Notes CRUD
```bash
# Create or update note
node cli.js vault-write --title "🐻 Project Summary" --body "### Summary\n- [x] Done" --cat "research" [--pinned] [--soul <soul>]

# Read single note by soul
node cli.js vault-get --soul "vault-1791155816426-8nv858"

# List notes (supports --cat, --query, --pinned, --table, --count, -n, -p)
node cli.js vault-read --cat "research" --query "summary" --table

# Delete note by soul
node cli.js vault-delete --soul "vault-1791155816426-8nv858"
```

### 3. Calendar — Full Events CRUD & Note Links
```bash
# Create or update event
node cli.js calendar-write --title "Dentist" --start "2026-10-10T15:00:00Z" --end "2026-10-10T16:00:00Z" --location "Clinic" --notes "Bring card" [--allDay] [--soul <soul>]

# Read single event by soul
node cli.js calendar-get --soul "cal-1791155890855-rmxf33"

# List events within date range
node cli.js calendar-read --from 2026-10-01 --to 2026-10-31 --table

# Delete event by soul
node cli.js calendar-delete --soul "cal-1791155890855-rmxf33"

# Link / unlink note or bookmark to an event
node cli.js event-link   --event <event-soul> --note <note-soul>
node cli.js event-unlink --event <event-soul> --note <note-soul>

# Query links
node cli.js calendar-events-for --note <note-soul>       # list events linking to note
node cli.js calendar-notes-for  --event <event-soul>     # list notes linked to event
```

### 4. Tasks & Kanban — Full CRUD, Priorities & Graph Links
```bash
# Create or update task
node cli.js task-write --title "Build Agent Bridge" --priority "high" --status "todo" --desc "Design specs" --due "2026-12-01" --tags "ai,core" --assignee "agent-01"

# Read single task by soul
node cli.js task-get --soul "task-1791155890855-rmxf33"

# List tasks (supports --status, --priority, --tag, --query, --table, --count, -n, -p)
node cli.js task-read --status "todo" --priority "high" --table

# Update task status or fields
node cli.js task-update --soul <soul> --status "done"

# Delete task by soul
node cli.js task-delete --soul <soul>

# Link / unlink note, event, bookmark, or another task to a task
node cli.js task-link   --task <task-soul> --note <note-soul>
node cli.js task-unlink --task <task-soul> --note <note-soul>

# Query tasks linking to a note, event, bookmark or task
node cli.js tasks-for --note <note-soul>
```

### 5. Bookmarks — Full CRUD, Import/Export & Agent Tools
```bash
# Create or update bookmark
node cli.js bookmarks-write --url "https://github.com/scobru/zenos" --title "ZenOS Repo" --folder "Dev/Zen" --tags "github,sovereign"

# Read single bookmark by URL or soul
node cli.js bookmarks-get --url "https://github.com/scobru/zenos"
node cli.js bookmarks-get --soul "bm-8677fe53e4fd80ae"

# List bookmarks (supports --folder, --query, --table, --count, -n, -p)
node cli.js bookmarks-read --folder "Dev" --query "zen" --table

# Delete bookmark by URL or soul
node cli.js bookmarks-delete --url "https://github.com/scobru/zenos"

# Netscape HTML browser import / export
node cli.js bookmarks-import --file bookmarks.html
node cli.js bookmarks-export [--folder Dev] [--file out.html]

# Batch update
node cli.js bookmarks-update --file changes.json
```

### 6. smollog — Full Blog CRUD & Aliases
```bash
# Publish or update post
node cli.js blog-publish --title "Dispatches from ZenOS" --content "### Sovereign Publishing\n..." --tags "zenos,agents" [--id <id>]

# Read single post by id
node cli.js blog-get --id "post-cli-demo" [--alias "scobru"]

# List author posts
node cli.js blog-read --alias "scobru" --table

# Delete blog post
node cli.js blog-delete --id "post-cli-demo"

# Register blog alias (e.g. smollog.vercel.app/scobru)
node cli.js blog-alias --alias "scobru"
```

### 7. Migrate Legacy Data
Copy vault/calendar/bookmarks/tasks written under earlier identity schemes into the current identity:
```bash
node cli.js migrate
```

### 8. Custom Relays
If the user provides their own relay, pass it on **every** command (or set `ZENOS_RELAYS` once):
```bash
# add to the default relays
node cli.js vault-read --user "<username>" --pass "<password>" --relay "wss://relay.example.com/zen"

# use ONLY the user's relay(s)
node cli.js vault-read --user "<username>" --pass "<password>" --relay "wss://relay.example.com/zen" --no-default-relays

# replace the whole relay list (--peers)
node cli.js vault-read --user "<username>" --pass "<password>" --peers "wss://a/zen,wss://b/zen"

# check the effective list
node cli.js relays --relay "wss://relay.example.com/zen"
```
Env alternative: `ZENOS_RELAYS="wss://a/zen,wss://b/zen"` and `ZENOS_ONLY_CUSTOM_RELAYS=true`.
URLs without a path get `/zen` appended. See [RELAYS.md](RELAYS.md) for self-hosting.

---

## 💻 Programmatic Usage via JavaScript SDK

Any agent script can import [`zenos.js`](zenos.js):

```javascript
import ZenOS from './zenos.js';

const os = new ZenOS();
await os.login(username, password);

// 1. Vault Notes (CRUD)
const note = await os.writeVaultNote({ title: "🤖 Agent Sync", body: "Automated report", cat: "logs", pinned: true });
const singleNote = await os.getVaultNote(note.soul);
const allNotes = await os.readVaultNotes();
await os.deleteVaultNote(note.soul);

// 2. Calendar Events (CRUD & Linking)
const ev = await os.writeCalendarEvent({ title: "Standup", start: Date.now() + 3600000 });
const singleEv = await os.getCalendarEvent(ev.soul);
const weekEvs = await os.readCalendarEvents({ from: "2026-10-01", to: "2026-10-31" });
await os.linkToEvent(ev.soul, { soul: note.soul });
const linkedEvents = await os.eventsFor({ soul: note.soul });
const linkedNotes = await os.notesForEvent(ev.soul);
await os.deleteCalendarEvent(ev.soul);

// 3. Bookmarks (CRUD & Netscape HTML)
const bm = await os.writeBookmark({ url: "https://zen.akao.io", title: "ZEN", folder: "Crypto" });
const singleBm = await os.getBookmark(bm.soul);
const allBms = await os.readBookmarks({ folder: "Crypto" });
await os.deleteBookmark(bm.soul);

// 4. smollog Blog (CRUD & Alias)
const post = await os.publishBlogPost({ title: "Autonomous Post", content: "Markdown body...", tags: ["ai", "p2p"] });
const singlePost = await os.getBlogPost(post.id, os.pub);
const allPosts = await os.readBlogPosts(os.pub);
await os.deleteBlogPost(post.id);
await os.registerAlias("scobru");
const pub = await os.resolveAlias("scobru");

// 5. Custom relays
const custom = new ZenOS({ extraPeers: ["wss://relay.example.com/zen"] });              // defaults + custom
const onlyOwn = new ZenOS({ extraPeers: ["wss://relay.example.com/zen"], useDefaultRelays: false });
```

---

## 🔒 Rules & Protocol Conventions

1. **Always use `{ authenticator: pair }` on `.put()`**: The P2P relays reject any write under a user namespace (`~{pub}/...`) if not cryptographically signed by the owner pair.
2. **Zero-Knowledge Vault (`/vault`)**: Payloads in the vault MUST be encrypted client-side with `ZEN.encrypt(text, pair)`. Relays only store blind ciphertexts.
3. **Public Signed Journal (`/posts`)**: Blog posts are stored in plaintext Markdown but signed with ECDSA so readers can verify author authenticity.
4. **Relay Connectivity**: Default relays are `wss://delay.scobrudot.dev/zen` (**the author's personal Delay relay**, best-effort, no SLA) and `wss://zen.akao.io:8420/zen` (public ZEN network). If the user specifies a custom relay, ALWAYS use it (`--relay` / `ZENOS_RELAYS`); use `--no-default-relays` only if the user asks for their relay exclusively — and warn that the ZenOS Web/smollog web apps only see that data if the custom relay peers with the default network.
5. **Deterministic Seed**: The identity is the FID derivation (`identity.js`, from scobru/fid): `ZEN.pair(null, { seed: alias.trim() + ':' + passphrase.trim() })`. Both parts are case-sensitive, so never alter credential casing without user confirmation. The same login gives the same `pub` in FID, smollog, ZenOS Web and ZenOS. Data written under the earlier schemes (smollog PBKDF2, plain `username + password`) is copied with `os.migrateLegacy()` / `node cli.js migrate`.
