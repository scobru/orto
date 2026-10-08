#!/usr/bin/env node
/**
 * Optional add-on: a small chat model (default LiquidAI LFM2.5 1.2B Thinking, 4-bit ONNX) that runs in the browser with WebGPU
 * (WASM fallback), so an Orto assistant can use your data without it leaving the device.
 *
 *   node scripts/install-llm.mjs [--model <hf repo>] [--dtype q4] [--data <folder>] [--models <folder>]
 *
 * Needs npm and a network, once. It puts the runtime (transformers.js + onnxruntime-web, Apache-2.0) in <data>/models/llm, which the
 * Orto server serves at /models/llm/. The app runs it inside a sandboxed iframe (no access to your keys or storage; the CSP only allows
 * model downloads from huggingface.co). The weights (~0.7 GB) are fetched by the browser on first use and cached by the app.
 * The model must be an ONNX export that transformers.js can load: check the repo name on huggingface.co before installing.
 * Remove it by deleting <data>/models/llm.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const PIN = { '@huggingface/transformers': '4.3.1' }; // pinned: this runs inside your pages
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const model = arg('--model', 'LiquidAI/LFM2.5-1.2B-Thinking-ONNX'), dtype = arg('--dtype', 'q4');
if (!/^[\w.-]+\/[\w.-]+$/.test(model) || !/^[\w]+$/.test(dtype)) { console.error('bad --model or --dtype'); process.exit(1); }
const data = path.resolve(arg('--data') || process.env.ORTO_DATA || process.env.ZENOS_DATA || path.join(process.cwd(), 'data'));
const out = path.join(path.resolve(arg('--models') || process.env.ORTO_MODELS || path.join(data, 'models')), 'llm');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orto-llm-'));
fs.writeFileSync(path.join(tmp, 'package.json'), '{"private":true}');
console.log('Installing', Object.entries(PIN).map(([n, v]) => n + '@' + v).join(', '), '...');
const npm = spawnSync('npm', ['install', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', ...Object.entries(PIN).map(([n, v]) => n + '@' + v)],
  { cwd: tmp, stdio: 'inherit', shell: process.platform === 'win32' });
if (npm.status !== 0) { console.error('npm install failed'); process.exit(1); }

const nm = path.join(tmp, 'node_modules');
const ort = path.join(nm, 'onnxruntime-web/dist');
const files = {
  'transformers.js': path.join(nm, '@huggingface/transformers/dist/transformers.web.min.js'),
  'ort.js': path.join(ort, 'ort.webgpu.bundle.min.mjs'),
  'ort-wasm-simd-threaded.jsep.mjs': path.join(ort, 'ort-wasm-simd-threaded.jsep.mjs'), // WebGPU build
  'ort-wasm-simd-threaded.jsep.wasm': path.join(ort, 'ort-wasm-simd-threaded.jsep.wasm'),
  'ort-wasm-simd-threaded.mjs': path.join(ort, 'ort-wasm-simd-threaded.mjs'), // CPU fallback
  'ort-wasm-simd-threaded.wasm': path.join(ort, 'ort-wasm-simd-threaded.wasm'),
};
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'lib'), { recursive: true });
for (const [name, src] of Object.entries(files)) {
  if (!fs.existsSync(src)) { console.error('missing after install:', src); process.exit(1); }
  fs.copyFileSync(src, path.join(out, 'lib', name));
}

// transformers.js imports onnxruntime-web/webgpu and onnxruntime-common; one bundle serves both so they share the same classes
const importMap = JSON.stringify({ imports: { '@huggingface/transformers': './lib/transformers.js', 'onnxruntime-web/webgpu': './lib/ort.js', 'onnxruntime-common': './lib/ort.js' } }, null, 2);
const hash = crypto.createHash('sha256').update('\n' + importMap + '\n').digest('base64');
// CSP is the second lock: whatever the runtime tries, it can only talk to this server and to Hugging Face for the weights
fs.writeFileSync(path.join(out, 'host.html'), `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' 'sha256-${hash}'; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co; worker-src 'self' blob:">
<title>Orto on-device assistant</title>
<script type="importmap">
${importMap}
</script>
<script type="module" src="host.js"></script>
`);
fs.writeFileSync(path.join(out, 'host.js'), `// Runs inside a sandboxed iframe (opaque origin): no storage, no keys. It only gets chat messages and returns text.
// An opaque origin has no Cache API, so the weights are cached by the app (the parent) through env.customCache.
import { env, AutoTokenizer, AutoModelForCausalLM, TextStreamer } from '@huggingface/transformers';
const post = (m, t) => parent.postMessage(m, '*', t || []);
const waiting = new Map(); let seq = 0;
const ask = (m) => new Promise((res) => { const id = ++seq; waiting.set(id, res); post({ event: 'cache', id, ...m }); });
env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = { mjs: new URL('./lib/ort-wasm-simd-threaded.jsep.mjs', location.href).href, wasm: new URL('./lib/ort-wasm-simd-threaded.jsep.wasm', location.href).href };
env.useCustomCache = true;
env.customCache = {
  async match(key) { const r = await ask({ op: 'match', key }); return r.buf ? new Response(r.buf, { headers: r.headers }) : undefined; },
  async put(key, res) { const buf = await res.arrayBuffer(); await ask({ op: 'put', key, buf, headers: Object.fromEntries(res.headers) }); },
};
let tok, model, loading;
const load = () => loading ||= (async () => {
  const cfg = await (await fetch('manifest.json')).json();
  const progress_callback = (p) => post({ event: 'progress', p });
  tok = await AutoTokenizer.from_pretrained(cfg.model, { progress_callback });
  const opts = { dtype: cfg.dtype, progress_callback };
  try { model = await AutoModelForCausalLM.from_pretrained(cfg.model, { ...opts, device: 'webgpu' }); }
  catch (_) { env.backends.onnx.wasm.wasmPaths = { mjs: new URL('./lib/ort-wasm-simd-threaded.mjs', location.href).href, wasm: new URL('./lib/ort-wasm-simd-threaded.wasm', location.href).href }; model = await AutoModelForCausalLM.from_pretrained(cfg.model, { ...opts, device: 'wasm' }); }
})().catch((err) => { loading = null; throw err; });
addEventListener('error', (e) => post({ event: 'error', error: e.message || 'model page error' }));
addEventListener('unhandledrejection', (e) => post({ event: 'error', error: String((e.reason && e.reason.message) || e.reason) }));
addEventListener('message', async (e) => {
  if (e.source !== parent) return;
  const m = e.data || {};
  if (m.event === 'cache') { waiting.get(m.id)?.(m); waiting.delete(m.id); return; }
  const { id, op, messages, tools, maxTokens } = m;
  try {
    if (op === 'load') { await load(); post({ id, ok: true }); }
    else if (op === 'chat') {
      await load();
      const inputs = tok.apply_chat_template(messages, { tools, add_generation_prompt: true, return_dict: true });
      const streamer = new TextStreamer(tok, { skip_prompt: true, skip_special_tokens: false, callback_function: (t) => post({ event: 'token', id, t }) });
      const out = await model.generate({ ...inputs, max_new_tokens: Math.min(maxTokens || 1024, 4096), do_sample: false, streamer });
      const text = tok.batch_decode(out.slice(null, [inputs.input_ids.dims.at(-1), null]), { skip_special_tokens: false })[0];
      post({ id, ok: true, text });
    }
  } catch (err) { post({ id, ok: false, error: String((err && err.message) || err) }); }
});
post({ event: 'ready' });
`);
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ name: 'llm', model, dtype, packages: PIN, installedAt: new Date().toISOString() }, null, 2) + '\n');
fs.rmSync(tmp, { recursive: true, force: true });
const mb = (d) => { let n = 0; for (const f of fs.readdirSync(d, { recursive: true })) { const s = fs.statSync(path.join(d, f)); if (s.isFile()) n += s.size; } return Math.round(n / 1048576); };
console.log(`\nInstalled in ${out} (${mb(out)} MB). Restart is not needed.\nModel: ${model} (${dtype}); the browser downloads it from huggingface.co on first use.`);
