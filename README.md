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
- **Files**: upload and download, encrypted in the browser before they leave it; the link button makes a public link
- **Photos**: the image files as a thumbnail grid (thumbnails are made in the browser and stored encrypted). Upload is manual; a browser cannot back up a phone's camera roll by itself
- **Settings**: export / import everything (backup and moving between servers), your public links with revoke, change password
- **Blog**: public Markdown posts at `/blog/<username>`  (e.g. https://zenos.scobrudot.dev/blog/scobru)

**Public links** (note menu > *Share public link*, or the link button on a file): the item is encrypted with a fresh key that is only in the link's `#fragment`, so the server cannot read it. They open at `<your server>/s/<id>#<key>` (`app/share.html`), so they need the app to be served by a ZenOS server, not a static host.

**Install**: the app is a PWA (`manifest.webmanifest`, `sw.js`): use *Install* / *Add to Home Screen*. Your data still needs the server; the service worker only keeps the app itself available.

Contacts, Secrets, Bookmarks, Tasks and Calendar have an *Examples* button that adds a few fake entries to try things out.

## Layout

- `app/index.html`: the app
- `app/zenos.js`: SDK (a copy of `zenos/zenos.js`; keep them in sync)
- `app/blog.html`: public blog page served at `/blog/<username>`
- `app/share.html`, `app/share.js`: public share page served at `/s/<id>`
- `app/manifest.webmanifest`, `app/sw.js`, `app/icon*.{svg,png}`: PWA
- `index.html`: project landing page

## License

MIT
