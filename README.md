# 🌌 ZenOS Web — Sovereign Decentralized Personal Workspace

The official web desktop and graphical interface for **ZenOS** — a zero-backend, multi-app decentralized operating system powered by the **ZEN** P2P graph database and cryptographic sovereign identity.

ZenOS Web runs 100% serverless inside the browser with zero build steps and zero dependencies.

---

## 🏛️ Integrated Apps & Modules

All applications within ZenOS are anchored under the user's sovereign cryptographic master keypair (`~{pub}`):

- 🔒 **Vault (`~{pub}/vault`)**: Zero-knowledge, Bear-style Markdown notes with client-side AES-GCM-256 encryption. Relays only see blind ciphertexts.
- 📅 **Calendar (`~{pub}/calendar`)**: Sovereign decentralized calendar with event scheduling, agenda views, and bidirectional linking to Vault notes.
- 🔖 **Bookmarks (`~{pub}/bookmarks`)**: Private encrypted bookmark manager with browser Netscape HTML import and export.
- 🪶 **Blog / smollog (`~{pub}/posts`)**: Public, cryptographically signed microblog and article publisher.
- 🤖 **Agent Ready**: Fully interoperable with autonomous AI agents orchestrating via the [ZenOS Core SDK & CLI](https://github.com/scobru/zenos).

---

## 🚀 Key Features

- 🌐 **100% Serverless**: No backend, no SQL database, no configuration. Served strictly as static HTML, CSS, and JS.
- ⚡ **Real-Time P2P Sync**: Automatically updates and syncs encrypted records across peers in real-time via ZEN relays.
- 🔐 **End-to-End Encryption**: All private data (notes, events, bookmarks) is encrypted locally in-browser using standard Web Crypto API before touching the network.
- 🎨 **Crafted Bear Aesthetics**: Curated light/dark themes, Outfit & IBM Plex Mono typography, responsive three-column grid, and fluid micro-animations.
- 📦 **Zero Dependencies**: Zero build tools, zero npm packages. Loads everything instantly via CDN (Unpkg & Tabler Icons).

---

## 🛠️ Setup & Deployment

1. Clone or copy files to your static hosting directory:
   ```bash
   git clone https://github.com/scobru/zenvault.git
   ```
2. Open `index.html` directly in any modern browser, or deploy the folder to GitHub Pages, Netlify, Vercel, or any static host.

---

## 📄 License

MIT License.
