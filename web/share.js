// /s/<id>#<key>: the key never leaves this page. The server only returns ciphertext; it is decrypted here.
import { readShare } from '/orto.js';
const out = document.getElementById('out');
const el = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
try {
  const r = await readShare(location.href);
  document.title = (r.title || r.name || 'Shared') + ' · Orto';
  out.textContent = '';
  if (r.kind === 'note') {
    if (!window.DOMPurify || !window.marked) throw new Error('markdown libraries unavailable');
    DOMPurify.addHook('afterSanitizeAttributes', (n) => { if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); } });
    const body = document.createElement('div');
    body.innerHTML = DOMPurify.sanitize(marked.parse(r.body || ''));
    out.append(el('h1', r.title || ''), body);
  } else {
    const img = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(r.type);
    const url = URL.createObjectURL(new Blob([r.data], { type: img ? r.type : 'application/octet-stream' }));
    out.append(el('h1', r.name));
    if (img) { const i = document.createElement('img'); i.src = url; i.alt = r.name; out.append(i, document.createElement('br')); }
    const a = el('a', 'Download'); a.href = url; a.download = r.name; a.className = 'btn';
    out.append(a, ' ', el('small', Math.round(r.data.length / 1024) + ' KB'));
  }
} catch (e) {
  out.textContent = e.status === 404 ? 'This link was revoked or never existed.' : 'Cannot open this link (is it complete, including the part after #?).';
}
