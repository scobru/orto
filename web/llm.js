// Optional on-device assistant model (scripts/install-llm.mjs): a small chat model that runs in a sandboxed iframe with WebGPU.
// The admin installs it into <data>/models/llm, which the server serves at /models/llm/. This file only talks to the iframe with
// postMessage; the iframe has an opaque origin (no storage), so the downloaded weights are cached here, in the app's Cache API.
const CACHE = 'orto-llm-v1';

/** Is the add-on installed on the server the app talks to? `base` is that server's URL ('' = same origin). Returns the manifest or null. */
export async function llmInstalled(base = '') {
  try { const r = await fetch(base + '/models/llm/manifest.json', { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch (_) { return null; }
}

/** Drop the cached weights (the add-on keeps working, it just downloads them again). */
export async function llmForget() { try { return await caches.delete(CACHE); } catch (_) { return false; } }

let loading = null;
/** Start the model page once. Returns { chat(messages, { tools, maxTokens, onToken }) -> string }. First chat downloads the weights. */
export function loadLlm({ base = '', onProgress } = {}) {
  return loading ||= (async () => {
    if (!(await llmInstalled(base))) throw new Error('The assistant model is not installed on this server (run scripts/install-llm.mjs).');
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts'); // no allow-same-origin: opaque origin, cannot read the app's storage
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    frame.src = base + '/models/llm/host.html';
    const pending = new Map(), tokens = new Map(); let seq = 0, ready;
    const isReady = new Promise((res) => { ready = res; });
    addEventListener('message', async (e) => {
      if (e.source !== frame.contentWindow) return;
      const m = e.data || {};
      if (m.event === 'ready') ready();
      else if (m.event === 'progress') onProgress?.(m.p);
      else if (m.event === 'token') tokens.get(m.id)?.(m.t);
      else if (m.event === 'error') { for (const p of pending.values()) p.rej(new Error(m.error)); pending.clear(); }
      else if (m.event === 'cache') { // weights cache for the iframe
        const reply = { event: 'cache', id: m.id }; let buf;
        try {
          const c = await caches.open(CACHE), req = new Request(m.key);
          if (m.op === 'put') await c.put(req, new Response(m.buf, { headers: m.headers }));
          else { const r = await c.match(req); if (r) { buf = await r.arrayBuffer(); reply.buf = buf; reply.headers = Object.fromEntries(r.headers); } }
        } catch (_) { /* no cache: the iframe downloads again */ }
        frame.contentWindow.postMessage(reply, '*', buf ? [buf] : []);
      } else if (pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.res(m) : p.rej(new Error(m.error || 'failed')); }
    });
    document.body.appendChild(frame);
    try { await Promise.race([isReady, new Promise((_, rej) => setTimeout(() => rej(new Error('The assistant page did not start')), 15000))]); }
    catch (err) { frame.remove(); throw err; }
    const call = (op, extra, onToken) => new Promise((res, rej) => {
      const id = ++seq; pending.set(id, { res, rej }); if (onToken) tokens.set(id, onToken);
      frame.contentWindow.postMessage({ id, op, ...extra }, '*');
    });
    return {
      load: () => call('load'),
      chat: async (messages, { tools, maxTokens, onToken } = {}) => {
        try { return (await call('chat', { messages, tools, maxTokens }, onToken)).text; }
        catch (err) { throw new Error((/download|fetch|Could not locate|Unauthorized/i.test(err.message) ? 'Could not load the model from huggingface.co (check the connection and that the model repo exists): ' : '') + String(err.message).split('\n')[0].slice(0, 200)); }
      },
    };
  })().catch((err) => { loading = null; throw err; });
}

/** Remove the <think>…</think> block of a thinking model (also an unfinished one). */
export const stripThink = (t) => String(t || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();

/**
 * Tool calls in LFM2's output: <|tool_call_start|>[name(a="x", n=2), other(b=true)]<|tool_call_end|>  ->  [{ name, arguments }].
 * Only JSON-like argument values (strings, numbers, true/false/None, lists, objects); anything else is skipped, so a malformed call is
 * dropped instead of guessed. Callers must still validate names and arguments against their tool list.
 */
export function parseToolCalls(text) {
  const calls = [];
  for (const [, body] of String(text || '').matchAll(/<\|tool_call_start\|>([\s\S]*?)<\|tool_call_end\|>/g)) {
    const list = body.trim().replace(/^\[/, '').replace(/\]$/, '');
    for (const [, name, args] of list.matchAll(/(\w+)\(([\s\S]*?)\)(?=\s*(?:,\s*\w+\(|$))/g)) {
      try {
        const json = args.trim() ? '{' + args.replace(/(^|,)\s*(\w+)\s*=/g, '$1"$2":').replace(/\bNone\b/g, 'null').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false') + '}' : '{}';
        calls.push({ name, arguments: JSON.parse(json) });
      } catch (_) { /* malformed: skipped */ }
    }
  }
  return calls;
}
