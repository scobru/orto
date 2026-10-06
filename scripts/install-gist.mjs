#!/usr/bin/env node
/**
 * Optional add-on: on-device tag suggestions with Gist by Desert Ant Labs (36 topics, 101 languages, runs in the browser).
 *
 *   node scripts/install-gist.mjs [--data <folder>]     # default: $ORTO_DATA or ./data
 *
 * Needs npm and a network, once. It puts the model *code* in <data>/models/gist, which the Orto server serves at /models/gist/
 * and the web app runs inside a sandboxed iframe (no access to your keys or storage, and a CSP that only allows the model
 * download from huggingface.co). The model files themselves (about 75 MB) are downloaded by the browser the first time a user
 * turns the feature on in Settings. Nothing from Desert Ant Labs is bundled in Orto: it is source-available, not MIT
 * (free below 100,000 monthly active devices per model, credit required): https://license.desertant.com/1.0
 * Remove it by deleting <data>/models/gist.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const PIN = { '@desert-ant-labs/gist': '3.6.0', '@litertjs/core': '2.5.3' }; // pinned: this runs inside your pages
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const data = path.resolve(arg('--data') || process.env.ORTO_DATA || process.env.ZENOS_DATA || path.join(process.cwd(), 'data'));
const out = path.join(data, 'models', 'gist');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orto-gist-'));
fs.writeFileSync(path.join(tmp, 'package.json'), '{"private":true}');
console.log('Installing', Object.entries(PIN).map(([n, v]) => n + '@' + v).join(', '), '...');
const npm = spawnSync('npm', ['install', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', ...Object.entries(PIN).map(([n, v]) => n + '@' + v)],
  { cwd: tmp, stdio: 'inherit', shell: process.platform === 'win32' });
if (npm.status !== 0) { console.error('npm install failed'); process.exit(1); }

const nm = path.join(tmp, 'node_modules');
const pkgs = ['@desert-ant-labs/gist', '@desert-ant-labs/core', '@bjorn3/browser_wasi_shim', '@litertjs/core', '@litertjs/wasm-utils'];
const skip = (src) => { const b = path.basename(src); return b === 'native' || b === 'typings' || b === 'node_modules' || /\.(d\.ts|d\.mts|map|md)$/.test(b) && b !== 'LICENSE.md'; };
fs.rmSync(out, { recursive: true, force: true });
for (const p of pkgs) {
  if (!fs.existsSync(path.join(nm, p))) { console.error('missing package after install:', p); process.exit(1); }
  fs.cpSync(path.join(nm, p), path.join(out, 'node_modules', p), { recursive: true, filter: (src) => !skip(src) });
}

// bare specifiers the SDK uses -> files, from each package's own browser entry
const entry = (p) => {
  const j = JSON.parse(fs.readFileSync(path.join(nm, p, 'package.json'), 'utf8'));
  const dot = j.exports?.['.'];
  const e = (typeof dot === 'string' ? dot : dot?.browser || dot?.import || dot?.default) || j.module || j.main;
  return './node_modules/' + p + '/' + String(e).replace(/^\.\//, '');
};
const imports = {
  '#platform': './node_modules/@desert-ant-labs/gist/platform-browser.js',
  '@desert-ant-labs/gist': entry('@desert-ant-labs/gist'),
  '@desert-ant-labs/core': entry('@desert-ant-labs/core'),
  '@bjorn3/browser_wasi_shim': entry('@bjorn3/browser_wasi_shim'),
  '@litertjs/core': entry('@litertjs/core'),
  '@litertjs/wasm-utils': entry('@litertjs/wasm-utils'),
};
for (const [k, v] of Object.entries(imports)) if (!fs.existsSync(path.join(out, v))) { console.error('entry not found for', k, v); process.exit(1); }
const importMap = JSON.stringify({ imports }, null, 2);
const hash = crypto.createHash('sha256').update('\n' + importMap + '\n').digest('base64');

// The page the app embeds in a sandboxed iframe. The CSP is the second lock: whatever the SDK tries (it reports usage to
// events.desertant.com unless told not to), it can only talk to this server and to Hugging Face for the model files.
fs.writeFileSync(path.join(out, 'host.html'), `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'sha256-${hash}'; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co; worker-src 'self' blob:">
<title>Orto on-device tags</title>
<script type="importmap">
${importMap}
</script>
<script type="module" src="host.js"></script>
`);
fs.writeFileSync(path.join(out, 'host.js'), `// Runs inside a sandboxed iframe (opaque origin): it cannot read the app's storage, cookies or keys. It only gets the text to tag.
// The SDK reports usage to its vendor unless these are set before it loads; the CSP in host.html blocks it anyway.
Object.assign(globalThis, { __dalUsageDisabled: true, __dalUsageContextDisabled: true, __dalIngestEndpoint: 'about:blank' });
let gist, loading;
const post = (m) => parent.postMessage(m, '*');
addEventListener('message', async (e) => {
  if (e.source !== parent) return;
  const { id, op, text, topK } = e.data || {};
  try {
    if (op === 'load') {
      loading ||= (async () => {
        const { Gist } = await import('@desert-ant-labs/gist');
        gist = await Gist.load({ litertWasmDir: new URL('./node_modules/@litertjs/core/wasm/', location.href).href, onProgress: (p) => post({ event: 'progress', p }) });
      })();
      await loading;
      post({ id, ok: true });
    } else if (op === 'classify') {
      if (!gist) throw new Error('model not loaded');
      post({ id, ok: true, topics: await gist.classify(String(text || '').slice(0, 4000), { topK: topK || 4 }) });
    }
  } catch (err) { loading = null; post({ id, ok: false, error: String((err && err.message) || err) }); }
});
post({ event: 'ready' });
`);
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ name: 'gist', packages: PIN, installedAt: new Date().toISOString(), license: 'https://license.desertant.com/1.0' }, null, 2) + '\n');
fs.rmSync(tmp, { recursive: true, force: true });
const mb = (d) => { let n = 0; for (const f of fs.readdirSync(d, { recursive: true })) { const s = fs.statSync(path.join(d, f)); if (s.isFile()) n += s.size; } return Math.round(n / 1048576); };
console.log(`\nInstalled in ${out} (${mb(out)} MB). Restart is not needed.\nTurn it on per browser in Settings > Tag suggestions. Credit: Gist by Desert Ant Labs (https://license.desertant.com/attribution).`);
