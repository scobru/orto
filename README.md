# ZenOS Web

The browser front end of [ZenOS](https://github.com/scobru/zenos) (self-hosted): encrypted notes, tasks (Kanban), calendar, bookmarks, contacts, secrets, files and a public blog.

It is a static page, `app/index.html`, plus the SDK `app/zenos.js`. It talks to a ZenOS server over HTTP; all encryption (AES-GCM-256, key derived from username + password with PBKDF2) happens in the browser, so the server only stores ciphertext.

## Run

The server hosts this app itself. Clone both repos side by side and start it:

```bash
git clone https://github.com/scobru/zenos.git
git clone https://github.com/scobru/zenos-web.git
cd zenos && npm start          # http://127.0.0.1:8787
```

Open the URL, enter a username and password. If the account does not exist yet the app offers to create it. There is no password recovery.

The app picks its server like this: the one set with the **Server** link on the login screen; otherwise the site it is served from, if that runs a ZenOS server; otherwise `https://zenos.scobrudot.dev`.

To host the app somewhere else (any static host), open it and use the **Server** link on the login screen to point it at your ZenOS server (the server allows cross-origin requests; tokens are sent as `Authorization` headers, not cookies).

## Apps

- **Vault**: Markdown notes with tags and checklists
- **Tasks**: Kanban board (To Do / In Progress / Blocked / Done), priorities, due dates, links to notes
- **Calendar**: events and agenda, linked to notes
- **Bookmarks**: folders, tags, Brave/Chrome/Firefox HTML import and export
- **Contacts**: address book with vCard import and export
- **Secrets**: passwords, API keys, secure notes, password generator
- **Files**: upload and download, encrypted in the browser before they leave it
- **Blog**: public Markdown posts at `/blog/<username>`

Contacts, Secrets, Bookmarks, Tasks and Calendar have an *Examples* button that adds a few fake entries to try things out.

## Layout

- `app/index.html`: the app
- `app/zenos.js`: SDK (a copy of `zenos/zenos.js`; keep them in sync)
- `app/blog.html`: public blog page served at `/blog/<username>`
- `index.html`: project landing page

## License

MIT
