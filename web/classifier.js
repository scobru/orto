// Optional on-device tag suggestions with Gist by Desert Ant Labs (https://desertant.com/models/gist/).
// The model code is not part of Orto: the admin installs it (scripts/install-gist.mjs) into <data>/models/gist, which the server
// serves at /models/gist/. It runs inside a sandboxed iframe with no access to the app's storage or keys; this file only talks to
// it with postMessage. The text never leaves the browser; the model files (about 75 MB) come from huggingface.co on first use.
const FLAG = 'orto_ai_tags';

export function aiEnabled() { try { return localStorage.getItem(FLAG) === '1'; } catch (_) { return false; } }
export function setAiEnabled(on) { try { if (on) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG); } catch (_) { } }

/** Is the add-on installed on the server the app talks to? `base` is that server's URL ('' = same origin). */
export async function aiInstalled(base = '') {
  try { return (await fetch(base + '/models/gist/manifest.json', { cache: 'no-store' })).ok; } catch (_) { return false; }
}

// A classifier is { classify(text, topK) -> [{ slug, name, score }] }. loadClassifier() makes the iframe one; tests plug their own.
let current = null, loading = null;
export function setClassifier(c) { current = c; loading = null; }

export function loadClassifier({ base = '', onProgress } = {}) {
  if (current) return Promise.resolve(current);
  return loading ||= (async () => {
    if (!(await aiInstalled(base))) throw new Error('Tag suggestions are not installed on this server (run scripts/install-gist.mjs).');
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts'); // no allow-same-origin: opaque origin, cannot read the app's storage
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    frame.src = base + '/models/gist/host.html';
    const pending = new Map(); let seq = 0, ready;
    const isReady = new Promise((res) => { ready = res; });
    addEventListener('message', (e) => {
      if (e.source !== frame.contentWindow) return;
      const m = e.data || {};
      if (m.event === 'ready') ready();
      else if (m.event === 'progress') onProgress?.(m.p);
      else if (pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.res(m) : p.rej(new Error(m.error || 'failed')); }
    });
    document.body.appendChild(frame);
    const call = async (op, extra) => {
      await isReady;
      return new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); frame.contentWindow.postMessage({ id, op, ...extra }, '*'); });
    };
    try { await Promise.race([isReady, new Promise((_, rej) => setTimeout(() => rej(new Error('The tagging page did not start')), 15000))]); await call('load'); }
    catch (err) {
      frame.remove();
      throw new Error(/download|fetch/i.test(err.message) ? 'Could not download the model from huggingface.co. Check the connection and try again.' : String(err.message).split('\n')[0].slice(0, 160));
    }
    return (current = { classify: async (text, topK = 4) => (await call('classify', { text, topK })).topics });
  })().catch((err) => { loading = null; throw err; });
}

// Gist's topic names are only known at run time, so the emoji are matched on the name, with a neutral fallback.
const EMOJI = [
  [/tech|software|comput|programm|\bai\b|internet|gadget/i, '💻'], [/science|research|physic|chemi|biolog|space|astronom/i, '🔬'],
  [/art|culture|design|museum|paint|photograph|literat|book|writing/i, '🎨'], [/music|audio|podcast|radio/i, '🎵'],
  [/movie|film|tv|television|entertain|celebrit|comedy|anime|streaming/i, '🎬'], [/game|gaming|esport/i, '🎮'],
  [/sport|football|soccer|basketball|athlet|running|cycling/i, '⚽'], [/fitness|workout|exercise|gym|yoga/i, '🏋️'],
  [/health|medic|wellness|mental|nutrition|disease/i, '❤️'], [/food|cook|recipe|cuisine|restaurant|drink|baking/i, '🍳'],
  [/travel|tourism|vacation|destination|adventure/i, '✈️'], [/car|auto|vehicle|motor|transport|aviation/i, '🚗'],
  [/finance|money|invest|econom|bank|crypto|stock|market/i, '💰'], [/business|startup|entrepreneur|marketing|commerce|retail/i, '💼'],
  [/career|productiv|job|work|management|leadership/i, '✅'], [/educat|learn|school|university|study|tutorial|language/i, '📚'],
  [/news|politic|government|election|world|current events|law|legal|crime/i, '🗞️'], [/histor|archaeolog|ancient/i, '🏛️'],
  [/fashion|beauty|style|cosmetic|clothing/i, '👗'], [/home|garden|diy|interior|real estate|architect|furniture/i, '🏡'],
  [/pet|animal|wildlife|dog|cat/i, '🐾'], [/environment|climate|nature|outdoor|sustainab|energy|weather|farm|agricultur/i, '🌿'],
  [/relationship|family|parent|baby|wedding|dating|kids/i, '👪'], [/religion|spiritual|faith|philosoph|belief/i, '🕊️'],
  [/social|communit|lifestyle|personal|opinion|humor|meme/i, '💬'],
];
export const emojiFor = (t) => EMOJI.find(([re]) => re.test((t.slug || '') + ' ' + (t.name || '')))?.[1] || '🏷️';

/** A topic as an Orto tag: lower case, letters/digits/_/- only (what #tags in notes accept). */
export const tagFor = (t) => String(t.slug || t.name || '').toLowerCase().replace(/[^a-z0-9_À-ſ-]+/g, '-').replace(/^-+|-+$/g, '');

/** Suggested tags for a text: [{ tag, label, emoji, score }], best first. */
export async function suggestTags(text, opts = {}) {
  const clean = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' ').trim();
  if (clean.length < 3) return [];
  const c = await loadClassifier(opts);
  return (await c.classify(clean, opts.topK || 4)).map((t) => ({ tag: tagFor(t), label: t.name || t.slug, emoji: emojiFor(t), score: t.score })).filter((s) => s.tag);
}
