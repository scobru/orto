# 🛰️ ZenOS Relays — Defaults, Custom Relays & Self-Hosting

ZenOS has no backend, but it **does need at least one ZEN relay** (WebSocket peer) to sync the graph between devices, agents and apps (ZenVault, smollog).

---

## ⚠️ Default relays — read this first

Out of the box ZenOS connects to:

| Relay | Operator | Software |
|---|---|---|
| `wss://delay.scobrudot.dev/zen` | **scobru (the author) — personal instance** | [Delay / shogun-relay](https://github.com/scobru/delay) |
| `wss://zen.akao.io:8420/zen` | Public upstream ZEN network | [ZEN](https://github.com/akaoio/zen) relay |

> [!IMPORTANT]
> The system works today **because it uses the author's personal relay** (`delay.scobrudot.dev`).
> It is offered best-effort: **no SLA, no uptime guarantee, no data-retention guarantee**, and it may be reset or rate-limited at any time.
>
> What the relay operator can see:
> - **ZenVault** (`~{pub}/vault`): only AES-GCM ciphertext — not readable.
> - **smollog** (`~{pub}/posts`): plaintext Markdown (they are public by design).
> - Metadata: public keys, timestamps, graph paths, IP addresses of connecting clients.
>
> - **Files**: only **Delay** relays offer IPFS file storage (`file-upload`, Files pane); plain ZEN relays such as `zen.akao.io` do not. Upload also needs that relay's admin token or API key (`ZENOS_STORAGE_TOKEN`), so on someone else's relay you need a key from its operator.
>
> For production use, sensitive workloads or full sovereignty, **run your own relay** (below) and point ZenOS to it.

---

## 1. Using a custom relay

You can **add** custom relays to the defaults, or **use only** your own.

### CLI

```bash
# Add a custom relay on top of the defaults
node cli.js vault-read --user "<u>" --pass "<p>" --relay "wss://relay.example.com/zen"

# Multiple custom relays (comma-separated)
node cli.js blog-read --alias scobru --relay "wss://a.example.com/zen,ws://localhost:8420/zen"

# Use ONLY your relays (no default relays at all)
node cli.js vault-write --user "<u>" --pass "<p>" --title "t" --body "b" \
  --relay "wss://relay.example.com/zen" --no-default-relays

# Replace the whole list explicitly (legacy flag)
node cli.js identity --user "<u>" --pass "<p>" --peers "wss://relay.example.com/zen"

# Print the effective relay list
node cli.js relays --relay "wss://relay.example.com/zen"
```

### Environment variables (ideal for agents)

Set once in the agent's environment — every CLI call / SDK instance picks them up:

```bash
# Linux / macOS
export ZENOS_RELAYS="wss://relay.example.com/zen"
export ZENOS_ONLY_CUSTOM_RELAYS=true   # optional: drop the default relays

# Windows PowerShell
$env:ZENOS_RELAYS = "wss://relay.example.com/zen"
$env:ZENOS_ONLY_CUSTOM_RELAYS = "true"
```

### JavaScript SDK

```javascript
import ZenOS, { DEFAULT_RELAYS, resolvePeers } from './zenos.js';

// Defaults + custom relay
const os = new ZenOS({ extraPeers: ['wss://relay.example.com/zen'] });

// Only custom relays
const os2 = new ZenOS({
  extraPeers: ['wss://relay.example.com/zen'],
  useDefaultRelays: false
});

// Full replacement (same as before)
const os3 = new ZenOS({ peers: ['wss://relay.example.com/zen'] });

console.log(os.peers); // effective list
```

### Rules

- Accepted schemes: `ws://`, `wss://`, `http://`, `https://`.
- If the URL has no path, `/zen` is appended automatically (`wss://relay.example.com` → `wss://relay.example.com/zen`).
- Duplicates are removed. Order: base list (defaults or `--peers`) → `--relay` / `extraPeers` → `ZENOS_RELAYS`.
- Use `wss://` (TLS) for anything reachable from the internet; `ws://` only for `localhost` / LAN.

> [!TIP]
> **Interoperability with the web apps.** The ZenVault and smollog web UIs connect to the default relays.
> If you use `--no-default-relays`, make sure your relay **peers with the default network** (see `PEERS` / `RELAY_PEERS` below), otherwise data written by the agent will not be visible in the web apps (and vice-versa).

---

## 2. Running your own relay

Two options, both expose a ZEN WebSocket endpoint at `/zen`.

| | **Option A — ZEN relay** | **Option B — Delay (shogun-relay)** |
|---|---|---|
| Repo | [`zen`](file:///d:/shogun-2/zen) | [`shogun-relay`](file:///d:/shogun-2/shogun-relay) |
| Footprint | Minimal, single Node process, no deps | Full hub: ZEN + GunDB + IPFS + React dashboard |
| Best for | Lightweight personal / agent relay | Production node, monitoring, IPFS storage |
| Default port | `8420` | `8420` |
| Endpoint | `ws(s)://<host>:8420/zen` | `ws(s)://<host>:8420/zen` |

### Option A — ZEN relay (`zen`)

Requirements: Node.js ≥ 14 (18+ recommended).

```bash
git clone https://github.com/scobru/zen   # or use the local copy: d:\shogun-2\zen
cd zen
npm start                                 # = node script/server.js
```

The relay listens on `http://0.0.0.0:8420` with WebSocket at `/zen`:

```bash
node cli.js relays --relay "ws://localhost:8420/zen" --no-default-relays
```

Main environment variables (from `script/server.js`):

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Listening port (or first CLI arg: `node script/server.js 9000`) | `8420` |
| `PEERS` | Comma-separated relays to sync with, e.g. `wss://delay.scobrudot.dev/zen,wss://zen.akao.io:8420/zen` | — |
| `NO_BOOTSTRAP` | `1` = don't auto-discover peers via DNS (`peers.akao.io`). Use for isolated/private relays | off |
| `DOMAIN` | Public domain of the relay (avoids self-connections) | auto |
| `HTTPS_KEY` / `HTTPS_CERT` | **Absolute** paths to TLS key/cert → enables `wss://` | — |
| `HTTPS_PORT`, `HTTP_REDIRECT` | HTTPS port and HTTP→HTTPS redirect | — |
| `UDP_PORT` | Inter-relay UDP fast path | `8421` |

Examples:

```bash
# Relay federated with the default ZenOS network (recommended)
PEERS="wss://delay.scobrudot.dev/zen,wss://zen.akao.io:8420/zen" npm start

# Fully private, isolated relay
NO_BOOTSTRAP=1 npm start
```

```powershell
# Windows PowerShell
$env:PEERS = "wss://delay.scobrudot.dev/zen,wss://zen.akao.io:8420/zen"; npm start
```

> [!NOTE]
> Without `PEERS` and without `NO_BOOTSTRAP`, the ZEN relay discovers peers automatically via DNS TXT on `peers.akao.io`.

### Option B — Delay / shogun-relay

This is the same software that powers `delay.scobrudot.dev`.

**Docker (recommended):**

```bash
git clone https://github.com/scobru/delay   # or use the local copy: d:\shogun-2\shogun-relay
cd delay
# Edit docker-compose.yml first: change ADMIN_PASSWORD / IPFS_API_TOKEN!
docker compose up -d
curl http://localhost:8420/health
```

**Manual (Node.js):**

```bash
cd shogun-relay/relay
npm install
cp ../docker/relay.env .env   # then edit it
npm start                     # or: npm run start:dev (auto-reload)
```

Relevant environment variables (from `relay/src/config/env-config.ts`):

| Variable | Purpose | Default |
|---|---|---|
| `RELAY_PORT` / `PORT` | HTTP + WebSocket port | `8420` |
| `ZEN_ENABLED` | Enable the ZEN sync engine | `true` |
| `ZEN_PATH` | WebSocket path used by ZenOS | `/zen` |
| `ZEN_DATA_DIR` | ZEN storage directory | `data/zendata` |
| `RELAY_PEERS` | Comma-separated peers to sync with | — |
| `ADMIN_PASSWORD` | Admin token for dashboard & protected APIs | *(set it!)* |
| `RELAY_SEA_KEYPAIR` / `RELAY_SEA_KEYPAIR_PATH` | Relay identity keypair | — |
| `IPFS_ENABLED` | Enable IPFS module | `false` (manual) / `true` (docker) |

Dashboard: `http://localhost:8420/dashboard`.

To federate with the default ZenOS network:

```bash
RELAY_PEERS="wss://zen.akao.io:8420/zen,wss://delay.scobrudot.dev/zen"
```

---

## 3. Exposing the relay publicly (wss://)

Browsers on HTTPS pages (ZenVault, smollog) can only connect to `wss://`. Options:

- **Reverse proxy** (Caddy / Nginx / CapRover / Traefik) terminating TLS and forwarding WebSocket upgrades to `localhost:8420`.
  - CapRover: set **Container HTTP Port = `8420`** and enable WebSocket support.
- **Native TLS** with the ZEN relay: `HTTPS_KEY=/abs/key.pem HTTPS_CERT=/abs/cert.pem npm start`.
- **Tunnel** for quick tests: `cloudflared tunnel --url http://localhost:8420` → use `wss://<tunnel-host>/zen`.

Minimal Caddyfile:

```
relay.example.com {
  reverse_proxy localhost:8420
}
```

Then use: `wss://relay.example.com/zen`.

---

## 4. Verify

```bash
# Health (Delay)
curl https://relay.example.com/health
# Signed status (ZEN relay)
curl https://relay.example.com/status

# Write + read through ONLY your relay
node cli.js vault-write --user "<u>" --pass "<p>" --title "relay test" --body "ok" \
  --relay "wss://relay.example.com/zen" --no-default-relays
node cli.js vault-read --user "<u>" --pass "<p>" --query "relay test" \
  --relay "wss://relay.example.com/zen" --no-default-relays
```
