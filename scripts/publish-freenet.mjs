#!/usr/bin/env node
/**
 * Builds and publishes Orto to Freenet, split across web containers under Freenet 0.2.161+'s limits
 * (48 MiB unpacked, 32 MiB per file, 4096 entries):
 *   - `node scripts/publish-freenet.mjs` (or `app`) -> publishes main Orto app to `--key orto`
 *     (9eBjDkH6ZXA6ehUyWBBjT6Xg4tQE4ALZjSsgXERds4yZ), excluding `web/models/`
 *   - `node scripts/publish-freenet.mjs models`     -> publishes `web/models/` (Gist + Emo gzipped) to `--key orto-models`
 *     (LCDG4tmrWVPWzHQe7HHC9mw5gLU4SXjjN3TK1CUbShj), while LiteRT WASM loads from `radica-litert`
 *     (Go7Qkt1KTFm58kx6MvCipX6qX9g9jTeJQu2zYnctK5mT)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(root, 'web');

const LIMIT_TOTAL = 46 * 1024 * 1024;
const LIMIT_FILE = 30 * 1024 * 1024;
const LIMIT_ENTRIES = 4000;

const mode = process.argv[2] === 'models' ? 'models' : 'app';
const isFirstPublish = process.argv.includes('--init');
const isDryRun = process.argv.includes('--dry-run');

function findFdev() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const winFdev = path.join(process.env.LOCALAPPDATA, 'freenet', 'bin', 'fdev.exe');
    if (fs.existsSync(winFdev)) return winFdev;
  }
  return 'fdev';
}

function stageAndCheck(label, copyFn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `orto-freenet-${label}-`));
  try {
    let totalBytes = 0;
    let entries = 0;
    const bigFiles = [];

    const copyTree = (srcDir, dstDir, filterFn, relBase = '') => {
      fs.mkdirSync(dstDir, { recursive: true });
      for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
        if (!filterFn(rel, ent)) continue;
        const srcPath = path.join(srcDir, ent.name);
        const dstPath = path.join(dstDir, ent.name);
        entries++;
        if (ent.isDirectory()) {
          copyTree(srcPath, dstPath, filterFn, rel);
        } else if (ent.isFile()) {
          const size = fs.statSync(srcPath).size;
          totalBytes += size;
          if (size > LIMIT_FILE) bigFiles.push(`${rel} (${(size / 1048576).toFixed(1)} MiB)`);
          fs.copyFileSync(srcPath, dstPath);
        }
      }
    };

    copyFn(tmpDir, copyTree, (size, rel) => {
      entries++;
      totalBytes += size;
      if (size > LIMIT_FILE) bigFiles.push(`${rel} (${(size / 1048576).toFixed(1)} MiB)`);
    });

    const mib = (n) => (n / 1048576).toFixed(2);
    if (totalBytes > LIMIT_TOTAL || bigFiles.length || entries > LIMIT_ENTRIES) {
      console.error(
        `${label} container would fail Freenet unpacking limits: ${mib(totalBytes)} MiB (max ${mib(LIMIT_TOTAL)} MiB), ` +
        `${entries} entries (max ${LIMIT_ENTRIES})` +
        (bigFiles.length ? `, oversized files: ${bigFiles.join(', ')}` : '')
      );
      process.exit(1);
    }
    console.log(`${label} container staged: ${entries} entries, ${mib(totalBytes)} MiB (limit ${mib(LIMIT_TOTAL)} MiB)`);

    if (!isDryRun) {
      const fdevBin = findFdev();
      const keyName = mode === 'models' ? 'orto-models' : 'orto';
      const subcmd = isFirstPublish ? 'publish' : 'update';
      execFileSync(fdevBin, ['website', subcmd, tmpDir, '--key', keyName], { stdio: 'inherit' });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (mode === 'models') {
  const modelsDir = path.join(webDir, 'models', 'gist');
  if (!fs.existsSync(modelsDir)) {
    const inst = spawnSync('node', ['scripts/install-gist.mjs', '--models', path.join(webDir, 'models')], { cwd: root, stdio: 'inherit' });
    if (inst.status !== 0) process.exit(inst.status ?? 1);
  }
  stageAndCheck('orto-models', (tmpDir, copyTree, recordFile) => {
    const indexHtml = '<!doctype html><meta charset="utf-8"><title>Orto models</title><p>On-device Gist &amp; Emo WASM models for Orto.</p>\n';
    fs.writeFileSync(path.join(tmpDir, 'index.html'), indexHtml);
    recordFile(Buffer.byteLength(indexHtml), 'index.html');
    // Exclude @litertjs/core/wasm/*.wasm (~18.7 MB) from the Freenet container: host.js loads LiteRT WASM from radica-litert
    copyTree(
      path.join(webDir, 'models'),
      path.join(tmpDir, 'models'),
      (rel) => !rel.includes('@litertjs/core/wasm/')
    );
  });
} else {
  fs.copyFileSync(path.join(root, 'orto.js'), path.join(webDir, 'orto.js'));
  const build = spawnSync('npm', ['run', 'freenet:build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (build.status !== 0) process.exit(build.status ?? 1);

  stageAndCheck('orto', (tmpDir, copyTree) => {
    copyTree(webDir, tmpDir, (rel) => rel !== 'models' && !rel.startsWith('models/'));
  });
}
