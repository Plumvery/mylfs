import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openProject } from '../src/project.js';

export function tempDir(name = 'unilfs-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** A generic project in a fresh git checkout, storing blobs in `store`. */
export function makeProject({ store, root, initGit = true } = {}) {
  root = root || tempDir();
  store = store || tempDir('unilfs-store-');
  fs.mkdirSync(root, { recursive: true });
  if (initGit) git(root, 'init', '-q');
  fs.writeFileSync(path.join(root, 'unilfs.config.json'), JSON.stringify({ provider: 'local', localPath: store }, null, 2));
  return { project: openProject(root), root, store };
}

export function writeRandom(file, size = 1000) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = crypto.randomBytes(size);
  fs.writeFileSync(file, data);
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Copies the committed files (manifest only) from one checkout to another, like a git pull would. */
export function shareManifest(from, to) {
  fs.copyFileSync(from.project.manifestPath, to.project.manifestPath);
}
