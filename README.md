# ZenOS (self-hosted)

Encrypted notes, calendar, tasks, bookmarks, contacts, secrets, files and a public blog, on **one small server you run yourself**: a Node script, one SQLite file and a folder of uploads. No ZEN/P2P network, no npm dependencies.

- **Server** (`server.js`): HTTP API + static hosting of the web app, SQLite via Node's built-in `node:sqlite` (Node ≥ 22.5).
- **SDK** (`zenos.js`): works in Node and browsers (`fetch` + WebCrypto).
- **CLI** (`cli.js`): every app from the terminal, for scripts and AI agents.
- **Web app**: [zenos-web](https://github.com/scobru/zenos-web) (served by the server itself).

## Run it

```bash
git clone https://github.com/scobru/zenos.git
git clone https://github.com/scobru/zenos-web.git     # next to zenos/: the server serves zenos-web/app
cd zenos && npm start                                 # http://127.0.0.1:8787
```

Open the URL, type a username and password; the first time, the app offers to create the account.

Docker (includes the web app, data in the `zenos-data` volume): `docker compose up -d`, then open http://localhost:8787. Or: `docker build -t zenos . && docker run -d -p 8787:8787 -v zenos-data:/data zenos`. Once zenos-web is merged: `--build-arg WEB_REF=main`.

Put it behind a reverse proxy with HTTPS (Caddy, nginx) before exposing it to the internet.

| Env var | Default | |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | listen address (`0.0.0.0` in Docker) |
| `ZENOS_DATA` | `./data` | holds `zenos.db` and `files/` — **back this folder up** |
| `ZENOS_WEB` | `../zenos-web/app` | static files to serve |
| `ZENOS_REGISTRATION` | `open` | `closed` once your accounts exist |
| `ZENOS_MAX_UPLOAD` | 200 MB | per file, bytes |
| `ZENOS_QUOTA` | 5 GB | per user, bytes |

## How it stays private

Your login derives two independent keys with PBKDF2 (210k rounds): an **AES-GCM key** that never leaves the client, and an **auth secret** the server stores only as a hash. Notes, events, tasks, bookmarks, contacts, secrets, file contents *and* file names are encrypted before upload; the server (and anyone with the SQLite file) sees ciphertext, usernames, record ids and timestamps. The blog is the one public part.

Forget the password and the data is gone: there is no recovery, by design. Usernames are case-insensitive; the password is case-sensitive.

## CLI

```bash
export ZENOS_SERVER=http://127.0.0.1:8787     # or --server; default https://zenos.scobrudot.dev
node cli.js register --user alice --pass 'long passphrase'
node cli.js vault-write --user alice --pass '…' --title "Hello" --body "First note"
node cli.js vault-read  --user alice --pass '…'
node cli.js file-upload --user alice --pass '…' --file photo.png
node cli.js blog-publish --user alice --pass '…' --title Hi --content "Public post"
node cli.js blog-read --alias alice            # public, no login
node cli.js --help                             # every command
```

The CLI and SDK talk to `https://zenos.scobrudot.dev` unless you set `ZENOS_SERVER` / `--server` / `{ server }`.

Put `ZENOS_USER` / `ZENOS_PASS` in `.env` (see `.env.example`) to drop the flags.

## SDK

```js
import ZenOS from './zenos.js';
const os = new ZenOS();   // default server: https://zenos.scobrudot.dev
await os.login('alice', 'long passphrase', { create: true }); // create only the first time
await os.writeVaultNote({ title: 'Hello', body: 'First note' });
await os.writeTask({ title: 'Ship it', priority: 'high' });
const up = await os.uploadFile(new Uint8Array([1, 2, 3]), 'tiny.bin');      // encrypted client-side
const bytes = await os.downloadFile(up.id);
os.onTask((task, soul, deleted) => console.log(task, deleted));             // live updates (SSE)
```

Collections: `Vault`, `CalendarEvent`, `Task`, `Bookmark`, `Contact`, `Secret` each have `write*`, `get*`, `read*`, `delete*`, `on*`; plus `uploadFile/listFiles/downloadFile/deleteFile` and `publishBlogPost/readBlogPosts/getBlogPost/deleteBlogPost/onPost`. See [llm.txt](llm.txt).

## HTTP API

All JSON. `Authorization: Bearer <token>` from `POST /api/login` or `/api/register` (`{name, auth}`).

| | |
|---|---|
| `GET /api/c/:collection` | list records |
| `GET/PUT/DELETE /api/c/:collection/:soul` | one record (PUT body is stored as-is; clients send `{data: <ciphertext>}`) |
| `GET /api/events` | server-sent events for your collections |
| `POST /api/files` (raw body), `GET/DELETE /api/files/:id` | blobs |
| `GET /api/u/:name`, `GET /api/u/:name/posts` | public profile and blog, no auth |
| `GET /blog/:name` | public blog page (e.g. https://zenos.scobrudot.dev/blog/scobru) |

## Tests

`npm test` starts a throwaway server on a temp SQLite file and runs the whole SDK against it (encryption at rest, isolation between users, files, live events).

## Coming from the ZEN version

The old build kept data in the ZEN graph under a secp256k1 identity; this one uses a different identity and storage, so the two do not share data. To move over: export bookmarks / contacts (HTML / vCard) from the old app and import them here; copy notes by hand or with a script using both SDKs. The `main` branch keeps the ZEN build.

## License

MIT
