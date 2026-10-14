import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as core from '../src/core.js';
import { openProject } from '../src/project.js';
import { makeProject, writeRandom, git, tempDir } from './helpers.js';

/** A main checkout with x.bin pushed and committed, plus a fresh `git worktree add` of it. */
async function mainAndWorktree() {
  const main = makeProject();
  git(main.root, 'config', 'user.email', 't@example.com');
  git(main.root, 'config', 'user.name', 't');
  const hash = writeRandom(path.join(main.root, 'art/x.bin'), 4000);
  await core.track(main.project, ['art/x.bin']);
  await core.push(main.project);
  git(main.root, 'add', '-A');
  git(main.root, 'commit', '-q', '-m', 'init');
  const wtRoot = path.join(tempDir(), 'wt');
  git(main.root, 'worktree', 'add', '-q', '--detach', wtRoot);
  return { main, wt: openProject(wtRoot), wtRoot, hash };
}

/** Storage that must not be touched. */
const noStorage = {
  calls: 0,
  async downloadBlob() {
    this.calls++;
    throw new Error('storage was used');
  },
};

test('pull in a new worktree copies blobs from the main checkout instead of storage', async () => {
  const { wt, wtRoot, hash } = await mainAndWorktree();
  assert.equal(fs.existsSync(path.join(wtRoot, 'art/x.bin')), false);
  const provider = { ...noStorage, calls: 0 };

  const r = await core.pull(wt, { provider });
  assert.deepEqual(r.errors, []);
  assert.equal(r.copiedLocal, 1);
  assert.equal(r.downloaded, 0);
  assert.equal(provider.calls, 0);
  const s = (await core.status(wt)).files[0];
  assert.equal(s.state, 'UpToDate');
  assert.equal(s.currentHash, hash);
});

test('a changed copy in the other worktree is not trusted: storage is used instead', async () => {
  const { main, wt } = await mainAndWorktree();
  // Edited in main without a push; same size, so only the hash can tell.
  writeRandom(path.join(main.root, 'art/x.bin'), 4000);

  const r = await core.pull(wt);
  assert.deepEqual(r.errors, []);
  assert.equal(r.copiedLocal, 0);
  assert.equal(r.downloaded, 1);
  assert.equal((await core.status(wt)).files[0].state, 'UpToDate');
});

test('fromWorktrees: false always goes to storage', async () => {
  const { wt } = await mainAndWorktree();
  const r = await core.pull(wt, { fromWorktrees: false });
  assert.equal(r.copiedLocal, 0);
  assert.equal(r.downloaded, 1);
});

test('the main checkout can pull from a worktree too, found by hash under another path', async () => {
  const { main, wt, wtRoot } = await mainAndWorktree();
  await core.pull(wt);
  // The worktree renames the file; main lost its copy.
  fs.renameSync(path.join(wtRoot, 'art/x.bin'), path.join(wtRoot, 'art/y.bin'));
  // Pushing y.bin is what records its hash in the worktree's state cache.
  await core.track(wt, ['art/y.bin']);
  await core.push(wt);
  fs.rmSync(path.join(main.root, 'art/x.bin'));
  const provider = { ...noStorage, calls: 0 };

  const r = await core.pull(main.project, { provider });
  assert.deepEqual(r.errors, []);
  assert.equal(r.copiedLocal, 1);
  assert.equal(provider.calls, 0);
});
