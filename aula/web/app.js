const app = document.getElementById('app');
let token = '';
try { token = localStorage.getItem('aula') || ''; } catch {}

// DOM builder: text always goes in as text nodes, never as HTML
const h = (tag, p = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(p)) k.startsWith('on') ? e.addEventListener(k.slice(2), v) : k === 'class' ? (e.className = v) : (e[k] = v);
  e.append(...kids.flat().filter(x => x != null && x !== false));
  return e;
};
const safe = fn => async (...a) => { try { await fn(...a); } catch (e) { alert(e.message); } };
const when = iso => new Date(iso).toLocaleString();
const auth = () => (token ? { Authorization: 'Bearer ' + token } : {});

async function api(url, method = 'GET', body) {
  const r = await fetch('/api' + url, {
    method,
    headers: { ...auth(), ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && token) logout();
    throw new Error(j.error || r.statusText);
  }
  return j;
}

function setToken(t) {
  token = t;
  try { t ? localStorage.setItem('aula', t) : localStorage.removeItem('aula'); } catch {}
}
function logout() { setToken(''); render(); }

async function upload(postId, file) {
  const r = await fetch(`/api/files?post=${postId}&name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: auth(), body: file });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
}

async function download(f) {
  const r = await fetch('/api/files/' + f.id, { headers: auth() });
  if (!r.ok) return alert('Download failed');
  const a = h('a', { href: URL.createObjectURL(await r.blob()), download: f.name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const fileLink = (f, onDelete) => h('div', { class: 'row' },
  h('a', { href: '#', onclick: e => { e.preventDefault(); download(f); } }, `${f.name} (${Math.ceil(f.size / 1024)} KB)`),
  onDelete && h('button', { class: 'ghost', onclick: safe(async () => { await api('/files/' + f.id, 'DELETE'); onDelete(); }) }, 'Remove'));

function authView() {
  let register = false;
  const draw = () => {
    const name = h('input', { placeholder: 'Name', hidden: !register });
    const email = h('input', { type: 'email', placeholder: 'Email', required: true });
    const pw = h('input', { type: 'password', placeholder: 'Password (min 8 characters)', required: true });
    app.replaceChildren(h('form', {
      class: 'auth',
      onsubmit: safe(async e => {
        e.preventDefault();
        const r = await api(register ? '/register' : '/login', 'POST', { name: name.value, email: email.value, password: pw.value });
        setToken(r.token);
        render();
      }),
    }, h('h1', {}, 'Aula'), name, email, pw,
    h('button', {}, register ? 'Create account' : 'Log in'),
    h('a', { href: '#', onclick: e => { e.preventDefault(); register = !register; draw(); } }, register ? 'Have an account? Log in' : 'New here? Register')));
  };
  draw();
}

async function homeView() {
  const classes = await api('/classes');
  const form = (placeholder, path, key) => {
    const input = h('input', { placeholder, required: true });
    return h('form', { class: 'row', onsubmit: safe(async e => { e.preventDefault(); location.hash = '#/c/' + (await api(path, 'POST', { [key]: input.value })).id; }) },
      input, h('button', {}, 'Go'));
  };
  return h('main', {},
    h('h2', {}, 'Your classes'),
    classes.length ? classes.map(c => h('div', { class: 'card' }, h('a', { href: '#/c/' + c.id }, c.name), ' ', h('small', {}, c.role))) : h('p', { class: 'muted' }, 'No classes yet.'),
    h('h3', {}, 'Create a class'), form('Class name', '/classes', 'name'),
    h('h3', {}, 'Join with a code'), form('Code', '/join', 'code'));
}

async function classView(cid) {
  const c = await api('/classes/' + cid), teacher = c.role === 'teacher';
  let composer = null;
  if (teacher) {
    const title = h('input', { placeholder: 'Title (assignments only)' });
    const body = h('textarea', { placeholder: 'Announce something, or describe an assignment', rows: 3 });
    const due = h('input', { type: 'datetime-local' });
    const pts = h('input', { type: 'number', min: 0, placeholder: 'Points' });
    const files = h('input', { type: 'file', multiple: true });
    const post = kind => safe(async () => {
      const { id } = await api(`/classes/${cid}/posts`, 'POST', {
        kind, title: title.value, body: body.value, due: due.value ? new Date(due.value).toISOString() : null, points: pts.value === '' ? null : +pts.value,
      });
      for (const f of files.files) await upload(id, f);
      render();
    });
    composer = h('div', { class: 'card' }, title, body,
      h('div', { class: 'row' }, h('label', {}, 'Due ', due), pts, files),
      h('div', { class: 'row' }, h('button', { onclick: post('announcement') }, 'Announce'), h('button', { onclick: post('assignment') }, 'Assign')));
  }
  const status = m => (!m ? 'assigned' : m.grade != null ? 'graded ' + m.grade : m.submitted_at ? 'turned in' : 'draft');
  const item = p => h('div', { class: 'card' },
    p.kind === 'assignment' && h('h3', {}, h('a', { href: '#/p/' + p.id }, p.title)),
    h('small', {}, [p.author, when(p.created_at), p.due && 'due ' + when(p.due), p.points != null && p.points + ' pts', p.kind === 'assignment' && !teacher && status(p.mine)].filter(Boolean).join(' · ')),
    h('p', { class: 'pre' }, p.body),
    p.files.map(f => fileLink(f)),
    teacher && h('button', { class: 'ghost', onclick: safe(async () => { if (confirm('Delete this post?')) { await api('/posts/' + p.id, 'DELETE'); render(); } }) }, 'Delete'));
  return h('main', {},
    h('h2', {}, c.class.name),
    teacher && h('p', {}, 'Class code: ', h('strong', {}, c.class.code)),
    composer, c.posts.map(item),
    h('h3', {}, 'People'), h('p', {}, c.people.map(u => `${u.name} (${u.role})`).join(', ')));
}

async function postView(pid) {
  const d = await api('/posts/' + pid), p = d.post, teacher = d.role === 'teacher';
  const head = [h('p', {}, h('a', { href: '#/c/' + p.class_id }, '< Back to class')), h('h2', {}, p.title || 'Announcement'),
    h('small', {}, [p.due && 'due ' + when(p.due), p.points != null && p.points + ' pts'].filter(Boolean).join(' · ')),
    h('p', { class: 'pre' }, p.body), d.files.map(f => fileLink(f))];
  if (p.kind !== 'assignment') return h('main', {}, head);

  if (teacher) {
    const rows = d.submissions.map(s => {
      const grade = h('input', { type: 'number', min: 0, max: p.points ?? '', value: s.grade ?? '', placeholder: 'Grade' });
      const fb = h('input', { placeholder: 'Feedback', value: s.feedback ?? '' });
      return h('div', { class: 'card' }, h('h3', {}, s.student), h('small', {}, 'turned in ' + when(s.submitted_at) + (p.due && s.submitted_at > p.due ? ' (late)' : '')),
        h('p', { class: 'pre' }, s.text), s.files.map(f => fileLink(f)),
        h('div', { class: 'row' }, grade, fb, h('button', { onclick: safe(async () => { await api(`/submissions/${s.id}/grade`, 'PUT', { grade: grade.value, feedback: fb.value }); alert('Saved'); }) }, 'Save')));
    });
    return h('main', {}, head, h('h3', {}, `Submissions (${rows.length})`), rows.length ? rows : h('p', { class: 'muted' }, 'Nothing turned in yet.'));
  }

  const s = d.submission, done = s?.grade != null;
  const text = h('textarea', { rows: 5, placeholder: 'Your answer', value: s?.text ?? '', disabled: done });
  const save = submit => safe(async () => { await api(`/posts/${pid}/submission`, 'PUT', { text: text.value, submit }); render(); });
  const pick = h('input', { type: 'file', multiple: true, onchange: safe(async () => { for (const f of pick.files) await upload(pid, f); render(); }) });
  return h('main', {}, head, h('h3', {}, 'Your work ', h('small', {}, s?.submitted_at ? 'turned in ' + when(s.submitted_at) : 'not turned in')),
    done && h('p', {}, h('strong', {}, `Grade: ${s.grade}${p.points != null ? '/' + p.points : ''}`), s.feedback && ' — ' + s.feedback),
    text, (s?.files ?? []).map(f => fileLink(f, done ? null : render)),
    !done && h('div', { class: 'row' }, pick, h('button', { onclick: save(true) }, s?.submitted_at ? 'Resubmit' : 'Turn in'),
      s?.submitted_at && h('button', { class: 'ghost', onclick: save(false) }, 'Unsubmit'), h('button', { class: 'ghost', onclick: save(false) }, 'Save draft')));
}

async function render() {
  const [, kind, id] = location.hash.split('/');
  if (!token) return authView();
  try {
    const me = await api('/me');
    const view = kind === 'c' ? await classView(id) : kind === 'p' ? await postView(id) : await homeView();
    app.replaceChildren(h('header', {}, h('a', { class: 'grow', href: '#/' }, 'Aula'), h('span', {}, me.name), h('button', { class: 'ghost', onclick: logout }, 'Log out')), view);
  } catch (e) {
    app.replaceChildren(h('main', {}, h('p', { class: 'err' }, e.message), h('a', { href: '#/' }, 'Home')));
  }
}
addEventListener('hashchange', render);
render();
