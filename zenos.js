/**
 * ZenOS Client SDK — Autonomous Agent & Application Interface
 * Connects sovereign cryptographic identities with ZenVault and smollog.
 */

// Universal loader: prefers local bundle in Node.js, falls back to CDN in Browser/Deno
let ZEN;
try {
  const localZen = await import('../zen/zen.min.js');
  ZEN = localZen.default || localZen;
} catch (_) {
  const cdnZen = await import('https://cdn.jsdelivr.net/gh/scobru/zen@main/zen.min.js');
  ZEN = cdnZen.default || cdnZen;
}

export const DEFAULT_RELAYS = [
  'wss://delay.scobrudot.dev/zen',
  'wss://zen.akao.io:8420/zen'
];

export class ZenOS {
  constructor(options = {}) {
    this.peers = options.peers || DEFAULT_RELAYS;
    this.zen = new ZEN({
      peers: this.peers,
      localStorage: options.localStorage || false,
      radisk: options.radisk || false,
      axe: options.axe !== undefined ? options.axe : true
    });
    this.pair = null;
    this.username = null;
  }

  /**
   * Authenticate / derive keypair from username and password.
   */
  async login(username, password) {
    if (!username || !password) {
      throw new Error('Username and password are required');
    }
    this.username = username.trim();
    this.pair = await ZEN.pair(null, { seed: this.username + password.trim() });
    return this.pair;
  }

  get pub() {
    return this.pair ? this.pair.pub : null;
  }

  get userRoot() {
    if (!this.pair) throw new Error('Not authenticated. Call login() first.');
    return this.zen.get('~' + this.pair.pub);
  }

  // ─── ZenVault (Encrypted Private Notes) ────────────────────────────

  /**
   * Write an encrypted note to the user's private vault.
   */
  async writeVaultNote({ title, body, cat = 'general', pinned = false, soul = null }) {
    if (!this.pair) throw new Error('Not authenticated.');

    const noteSoul = soul || ('vault-' + Date.now() + '-' + Math.random().toString(36).substring(7));
    const encTitle = await ZEN.encrypt(title, this.pair);
    const encBody = await ZEN.encrypt(body, this.pair);
    const encCat = await ZEN.encrypt(cat, this.pair);

    const payload = {
      title: encTitle,
      body: encBody,
      cat: encCat,
      pinned: !!pinned,
      trash: false,
      timestamp: Date.now(),
      encrypted: true
    };

    return new Promise((resolve, reject) => {
      this.userRoot.get('vault').get(noteSoul).put(payload, (ack) => {
        if (ack && ack.err) reject(new Error(ack.err));
        else resolve({ soul: noteSoul, status: 'saved', timestamp: payload.timestamp });
      }, { authenticator: this.pair });
    });
  }

  /**
   * Read and decrypt all notes from the user's private vault.
   */
  async readVaultNotes(timeoutMs = 5000) {
    if (!this.pair) throw new Error('Not authenticated.');

    const notes = [];
    const seen = new Set();

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(notes), timeoutMs);

      const processNode = async (node, soul) => {
        if (!node || node.trash || seen.has(soul)) return;
        if (!node.title) return;
        seen.add(soul);
        try {
          const title = await ZEN.decrypt(node.title, this.pair);
          const body = await ZEN.decrypt(node.body, this.pair);
          const cat = await ZEN.decrypt(node.cat, this.pair);
          notes.push({
            soul,
            title: title || '',
            body: body || '',
            cat: cat || '',
            pinned: !!node.pinned,
            timestamp: node.timestamp || Date.now()
          });
        } catch (_) {
          // ignore corrupted or un-decryptable records
        }
      };

      this.userRoot.get('vault').map().once(async (node, soul) => {
        if (!soul) return;
        if (node && node.title) {
          await processNode(node, soul);
        } else {
          this.userRoot.get('vault').get(soul).once(async (fullNode) => {
            if (fullNode && fullNode.title) {
              await processNode(fullNode, soul);
            }
          });
        }
      });
    });
  }

  /**
   * Delete a note from the vault.
   */
  async deleteVaultNote(soul) {
    if (!this.pair) throw new Error('Not authenticated.');
    return new Promise((resolve, reject) => {
      this.userRoot.get('vault').get(soul).put(null, (ack) => {
        if (ack && ack.err) reject(new Error(ack.err));
        else resolve({ soul, status: 'deleted' });
      }, { authenticator: this.pair });
    });
  }

  // ─── smollog (Public Verifiable Blog) ─────────────────────────────

  /**
   * Publish a public markdown blog post to smollog.
   */
  async publishBlogPost({ title, content, tags = [], id = null }) {
    if (!this.pair) throw new Error('Not authenticated.');

    const postId = id || ('post-' + Date.now());
    const tagList = Array.isArray(tags) ? tags : String(tags || '').split(',').map(t => t.trim()).filter(Boolean);

    const postPayload = {
      id: postId,
      title: title.trim(),
      content: content.trim(),
      tags: tagList.join(', '),
      authorAlias: this.username || '',
      authorPub: this.pair.pub,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deleted: false
    };

    return new Promise((resolve, reject) => {
      this.userRoot.get('posts').get(postId).put(postPayload, (ack) => {
        if (ack && ack.err) reject(new Error(ack.err));
        else resolve({ id: postId, status: 'published', authorPub: this.pair.pub });
      }, { authenticator: this.pair });
    });
  }

  /**
   * Read all blog posts for a given author public key.
   */
  async readBlogPosts(authorPub = null, timeoutMs = 4000) {
    const targetPub = authorPub || this.pub;
    if (!targetPub) throw new Error('Target public key required.');

    const posts = [];
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(posts), timeoutMs);

      this.zen.get('~' + targetPub).get('posts').map().on((post, id) => {
        if (!post || post.deleted) return;
        posts.push({
          id: post.id || id,
          title: post.title,
          content: post.content,
          tags: typeof post.tags === 'string' ? post.tags.split(', ') : (post.tags || []),
          authorAlias: post.authorAlias || null,
          authorPub: targetPub,
          createdAt: post.createdAt,
          updatedAt: post.updatedAt
        });
      });
    });
  }

  /**
   * Register a human-friendly blog alias (e.g. smollog.vercel.app/scobru).
   */
  async registerAlias(alias = null) {
    if (!this.pair) throw new Error('Not authenticated.');
    const targetAlias = (alias || this.username).trim().toLowerCase();

    return new Promise((resolve) => {
      this.userRoot.get('alias').put(targetAlias, null, { authenticator: this.pair });
      this.zen.get('smollog_aliases').get(targetAlias).put(this.pair.pub, () => {
        resolve({ alias: targetAlias, pub: this.pair.pub });
      });
    });
  }
}

export default ZenOS;
