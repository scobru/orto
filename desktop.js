// Desktop launcher: starts a local Orto server (data in the OS user folder) and opens the browser.
// Used by the portable zips from .github/workflows/desktop.yml; also: node desktop.js
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from './server.js';

const home = os.homedir(), p = process.platform;
const dataDir = process.env.ORTO_DATA || (p === 'win32' ? path.join(process.env.APPDATA || home, 'Orto')
  : p === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Orto')
  : path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'orto'));
const port = Number(process.env.PORT || 8787), url = `http://127.0.0.1:${port}`;
const open = () => spawn(p === 'win32' ? 'cmd' : p === 'darwin' ? 'open' : 'xdg-open',
  p === 'win32' ? ['/c', 'start', '', url] : [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();

const server = createServer({ dataDir });
server.on('error', (e) => { // port taken: most likely Orto is already running, just open it
  if (e.code !== 'EADDRINUSE') throw e;
  console.log(`Port ${port} in use, opening ${url}`); open(); setTimeout(() => process.exit(0), 500);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Orto on ${url}\nData: ${dataDir}\nClose this window to stop it.`);
  open();
});
