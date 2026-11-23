import { copyToClipboard } from '../engine/clipboard.js';
import { openInEditor } from '../engine/editor.js';
import { openUrl } from '../engine/open.js';
import { truncate } from '../engine/screen.js';
import { drawModal, drawStyledLine, drawTextInput, formatRelativeTime, renderMarkdownLines } from '../engine/widgets.js';

export class BlogView {
  constructor({ store, config, suspend, resume, toast }) {
    this.store = store;
    this.config = config;
    this.suspend = suspend;
    this.resume = resume;
    this.toast = toast;

    this.pane = 'list'; // 'list' | 'preview'
    this.idx = 0;
    this.selectedId = null;
    this.scroll = 0;
    this.previewScroll = 0;
    this.query = '';
    this.searchMode = false;
    this.modal = null;
  }

  _getList() {
    return this.store.getPosts({ query: this.query });
  }

  _current(list) {
    if (!list.length) {
      this.idx = 0;
      this.selectedId = null;
      return null;
    }
    if (this.selectedId) {
      const i = list.findIndex((p) => p.id === this.selectedId);
      if (i >= 0) { this.idx = i; return list[i]; }
    }
    this.idx = Math.max(0, Math.min(list.length - 1, this.idx));
    this.selectedId = list[this.idx].id;
    return list[this.idx];
  }

  _blogUrl() {
    return `${this.store.baseClient.server}/blog/${this.store.baseClient.pub}`;
  }

  async _editInEditor(post = null, initialTitle = '', initialTags = []) {
    const initial = post
      ? `# ${post.title}\n\n${post.content || ''}`
      : `# ${initialTitle || 'New Post'}\n\nWrite your public post here...\n`;
    try {
      const res = openInEditor(initial, {
        ext: '.md',
        editorCmd: this.config?.editor,
        suspend: this.suspend,
        resume: this.resume
      });
      if (!post && !res.text.trim()) { this.toast('Empty post cancelled'); return; }
      if (post && !res.changed) { this.toast('No changes'); return; }
      const lines = res.text.split('\n');
      const title = lines[0]?.startsWith('# ') ? (lines[0].slice(2).trim() || initialTitle || post?.title || 'Untitled') : (initialTitle || post?.title || 'Untitled');
      const start = lines[0]?.startsWith('# ') ? (lines[1] === '' ? 2 : 1) : 0;
      const content = lines.slice(start).join('\n').trim();
      if (!content) { this.toast('Post content cannot be empty', 'error'); return; }
      const pub = await this.store.publishPost({
        id: post?.id || null,
        title,
        content,
        tags: post?.tags || initialTags,
        createdAt: post?.createdAt || Date.now()
      });
      this.selectedId = pub.id;
      this.toast(`Published "${title}"`, 'success');
    } catch (e) {
      this.toast(e.message || 'Publish failed', 'error');
    }
  }

  async _handleModalKey(ev, current) {
    const m = this.modal;
    if (!m) return false;
    if (ev.name === 'escape') { this.modal = null; return true; }

    if (m.kind === 'new') {
      if (ev.name === 'tab' || ev.name === 'down' || ev.name === 'up') {
        m.focus = m.focus === 0 ? 1 : 0;
        return true;
      }
      if (ev.name === 'enter') {
        const title = m.title.trim();
        if (!title) { this.toast('Title is required', 'error'); return true; }
        const tags = m.tags.split(',').map((t) => t.trim()).filter(Boolean);
        this.modal = null;
        await this._editInEditor(null, title, tags);
        return true;
      }
      const key = m.focus === 0 ? 'title' : 'tags';
      if (ev.name === 'backspace') { m[key] = m[key].slice(0, -1); return true; }
      if (ev.name === 'paste') { m[key] += ev.paste.replace(/\r?\n/g, ' '); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { m[key] += ev.ch; return true; }
      return true;
    }

    if (m.kind === 'delete' && current) {
      if (ev.name === 'y' || ev.name === 'enter') {
        this.modal = null;
        try {
          await this.store.deletePost(current.id);
          this.selectedId = null;
          this.toast('Deleted blog post', 'success');
        } catch (e) { this.toast(e.message, 'error'); }
        return true;
      }
      if (ev.name === 'n') { this.modal = null; return true; }
      return true;
    }

    return true;
  }

  async handleKey(ev) {
    if (this.store.activeSpace) return false;

    const list = this._getList();
    const current = this._current(list);

    if (this.modal) return this._handleModalKey(ev, current);

    if (this.searchMode) {
      if (ev.name === 'escape') { this.query = ''; this.searchMode = false; this.idx = 0; this.selectedId = null; return true; }
      if (ev.name === 'enter') { this.searchMode = false; return true; }
      if (ev.name === 'backspace') { this.query = this.query.slice(0, -1); this.idx = 0; this.selectedId = null; return true; }
      if (ev.name === 'paste') { this.query += ev.paste.replace(/\r?\n/g, ' '); return true; }
      if (ev.ch && !ev.ctrl && !ev.alt) { this.query += ev.ch; this.idx = 0; this.selectedId = null; return true; }
      return false;
    }

    if (ev.name === '/' && !ev.ctrl) { this.searchMode = true; return true; }
    if (ev.name === 'escape' && this.query) { this.query = ''; this.idx = 0; this.selectedId = null; return true; }

    if (ev.name === 'tab' || ev.name === 'h' || ev.name === 'l' || ev.name === 'left' || ev.name === 'right') {
      this.pane = this.pane === 'list' ? 'preview' : 'list';
      return true;
    }

    if (ev.name === 'n' && !ev.ctrl) {
      this.modal = { kind: 'new', title: '', tags: '', focus: 0 };
      return true;
    }
    if (ev.name === 'o') {
      const r = openUrl(this._blogUrl());
      this.toast(r.ok ? `Opened ${this._blogUrl()}` : r.error, r.ok ? 'success' : 'error');
      return true;
    }
    if (ev.name === 'y') {
      copyToClipboard(this._blogUrl(), { stdout: process.stdout });
      this.toast(`Copied blog URL: ${this._blogUrl()}`, 'success');
      return true;
    }
    if (ev.shift && ev.name === 'R') {
      const rss = `${this._blogUrl()}/feed.xml`;
      copyToClipboard(rss, { stdout: process.stdout });
      this.toast(`Copied RSS URL: ${rss}`, 'success');
      return true;
    }

    if (this.pane === 'list') {
      if (ev.name === 'j' || ev.name === 'down') {
        if (list.length) { this.idx = Math.min(list.length - 1, this.idx + 1); this.selectedId = list[this.idx].id; this.previewScroll = 0; }
        return true;
      }
      if (ev.name === 'k' || ev.name === 'up') {
        if (list.length) { this.idx = Math.max(0, this.idx - 1); this.selectedId = list[this.idx].id; this.previewScroll = 0; }
        return true;
      }
      if (ev.name === 'enter' && current) { this.pane = 'preview'; return true; }
    } else {
      if (ev.name === 'j' || ev.name === 'down') { this.previewScroll++; return true; }
      if (ev.name === 'k' || ev.name === 'up') { this.previewScroll = Math.max(0, this.previewScroll - 1); return true; }
    }

    if (!current) return false;

    if (ev.name === 'e') {
      await this._editInEditor(current);
      return true;
    }
    if (ev.name === 'd') {
      this.modal = { kind: 'delete' };
      return true;
    }

    return false;
  }

  getHints() {
    if (this.store.activeSpace) return 'Blog is Personal-only  ·  s: switch to Personal workspace';
    if (this.searchMode) return 'Type to filter posts  ·  Enter: apply  ·  Esc: clear';
    return 'n:new post ($EDITOR)  e:edit  o:open blog  y:copy URL  R:copy RSS  d:delete  /:search';
  }

  render(screen, theme, area) {
    if (this.store.activeSpace) {
      screen.box(area.x, area.y, area.w, area.h, {
        title: 'Blog (Personal Only)',
        borderColor: theme.borderFocus,
        bg: theme.panelBg
      });
      screen.text(area.x + 2, area.y + 2, 'Public blog posts belong to your Personal workspace.', { fg: theme.fgDim, bg: theme.panelBg });
      screen.text(area.x + 2, area.y + 4, 'Press s to switch back to Personal.', { fg: theme.accentSoft, bg: theme.panelBg });
      return;
    }

    const list = this._getList();
    const current = this._current(list);
    const wide = area.w >= 62;
    const listW = wide ? Math.max(24, Math.min(36, Math.floor(area.w * 0.34))) : area.w;

    if (wide || this.pane === 'list') {
      screen.box(area.x, area.y, listW, area.h, {
        title: `Blog Posts (${list.length})`,
        rightTitle: this.searchMode ? `/${this.query}_` : (this.query ? `/${this.query}` : '[/]'),
        borderColor: this.pane === 'list' ? theme.borderFocus : theme.border,
        bg: theme.listBg
      });
      const iw = listW - 2;
      const ih = area.h - 2;
      const maxVis = Math.max(1, Math.floor(ih / 2));
      if (this.idx < this.scroll) this.scroll = this.idx;
      if (this.idx >= this.scroll + maxVis) this.scroll = this.idx - maxVis + 1;

      if (!list.length) {
        screen.text(area.x + 2, area.y + 2, 'No public posts yet. Press n to write.', { fg: theme.fgMuted, bg: theme.listBg });
      } else {
        for (let i = 0; i < maxVis && this.scroll + i < list.length; i++) {
          const p = list[this.scroll + i];
          const sel = this.scroll + i === this.idx;
          const bg = sel ? theme.selectedBg : theme.listBg;
          const ry = area.y + 1 + i * 2;
          screen.fill(area.x + 1, ry, iw, 2, ' ', { fg: theme.fg, bg });
          screen.text(area.x + 2, ry, (sel ? '▸ ' : '  ') + truncate(p.title || 'Untitled', iw - 4), { fg: theme.fg, bg, bold: sel });
          const meta = [formatRelativeTime(p.createdAt), (p.tags || []).map((t) => '#' + t).join(' ')].filter(Boolean).join(' · ');
          screen.text(area.x + 4, ry + 1, truncate(meta, iw - 4), { fg: theme.fgMuted, bg });
        }
      }
    }

    if (wide || this.pane === 'preview') {
      const px = wide ? area.x + listW : area.x;
      const pw = wide ? area.w - listW : area.w;
      screen.box(px, area.y, pw, area.h, {
        title: current ? current.title : 'Public Blog',
        rightTitle: truncate(this._blogUrl(), Math.floor(pw / 2)),
        borderColor: this.pane === 'preview' ? theme.borderFocus : theme.border,
        bg: theme.panelBg,
        titleColor: theme.accent
      });
      const iw = pw - 4;
      const ih = area.h - 2;
      if (!current) {
        screen.text(px + 2, area.y + 2, `Public URL: ${this._blogUrl()}`, { fg: theme.cyan, bg: theme.panelBg });
      } else {
        const mdLines = renderMarkdownLines(current.content || '', iw, theme);
        const maxS = Math.max(0, mdLines.length - ih);
        this.previewScroll = Math.max(0, Math.min(maxS, this.previewScroll));
        for (let r = 0; r < ih && this.previewScroll + r < mdLines.length; r++) {
          drawStyledLine(screen, px + 2, area.y + 1 + r, iw, mdLines[this.previewScroll + r], theme.panelBg);
        }
      }
    }

    if (this.modal) this._renderModal(screen, theme);
  }

  _renderModal(screen, theme) {
    const m = this.modal;
    if (m.kind === 'new') {
      const box = drawModal(screen, theme, {
        title: 'New Public Blog Post',
        width: 58,
        height: 11,
        footer: 'Tab: field  ·  Enter: open $EDITOR  ·  Esc: cancel'
      });
      screen.text(box.x, box.y + 1, 'Post Title (public)', { fg: m.focus === 0 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 2, box.w, m.title, m.title.length, { focused: m.focus === 0, theme });
      screen.text(box.x, box.y + 4, 'Tags (comma separated)', { fg: m.focus === 1 ? theme.accentSoft : theme.fgDim, bg: theme.panelBg });
      drawTextInput(screen, box.x, box.y + 5, box.w, m.tags, m.tags.length, { focused: m.focus === 1, theme });
    } else if (m.kind === 'delete') {
      const box = drawModal(screen, theme, {
        title: 'Delete Public Post?',
        width: 48,
        height: 8,
        footer: 'y/Enter: delete  ·  n/Esc: cancel'
      });
      screen.text(box.x, box.y + 1, 'Delete selected public blog post?', { fg: theme.danger, bg: theme.panelBg, bold: true });
    }
  }
}
