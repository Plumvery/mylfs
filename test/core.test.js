import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as core from '../src/core.js';
import { Manifest } from '../src/manifest.js';
import { StagedPaths } from '../src/staged.js';
import { readBlock, EXCLUDE_BEGIN, EXCLUDE_END, GITIGNORE_BEGIN, GITIGNORE_END } from '../src/ignore.js';
import { openProject } from '../src/project.js';
import { makeProject, writeRandom, shareManifest, git, tempDir } from './helpers.js';

const stateOf = async (p, rel) => (await core.status(p)).files.find((f) => f.path === rel)?.state;

test('classify is the three-way merge-base rule', () => {
  assert.equal(core.classify('a', 'a', null), 'UpToDate');
  assert.equal(core.classify('a', 'b', null), 'Modified');
  assert.equal(core.classify('a', 'b', 'a'), 'Outdated');
  assert.equal(core.classify('a', 'b', 'b'), 'Modified');
  assert.equal(core.classify('a', 'b', 'c'), 'Conflicted');
});

test('track stages without touching the manifest; push promotes', async () => {
  const { project, root, store } = makeProject();
  const hash = writeRandom(path.join(root, 'art/big.bin'), 5000);

  const t = await core.track(project, ['art/big.bin']);
  assert.equal(t.trackedNew, 1);
  assert.equal(fs.existsSync(project.manifestPath), false, 'Track must not write the manifest');
  assert.deepEqual(StagedPaths.load(project.stagedPath).paths, ['art/big.bin']);
  assert.deepEqual(readBlock(path.join(root, '.git/info/exclude'), EXCLUDE_BEGIN, EXCLUDE_END), ['/art/big.bin']);
  assert.equal(await stateOf(project, 'art/big.bin'), 'Staged');

  const p = await core.push(project);
  assert.equal(p.uploaded, 1);
  assert.equal(p.promoted, 1);
  assert.equal(Manifest.load(project.manifestPath).find('art/big.bin').hash, hash);
  assert.ok(fs.existsSync(path.join(store, 'objects', hash.slice(0, 2), hash)));
  assert.equal(fs.existsSync(project.stagedPath), false);
  assert.deepEqual(readBlock(path.join(root, '.git/info/exclude'), EXCLUDE_BEGIN, EXCLUDE_END), []);
  assert.deepEqual(readBlock(project.gitignorePath, GITIGNORE_BEGIN, GITIGNORE_END),
    ['/.unilfs/', '/unilfs.staged.json', '/art/big.bin']);
  const s = (await core.status(project)).files[0];
  assert.equal(s.state, 'UpToDate');
  assert.equal(s.remoteKnown, true);
  // git sees nothing but the small files
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all').includes('big.bin'), false);
});

test('a teammate update reads as Outdated and Pull takes it; a local edit reads as Modified', async () => {
  const a = makeProject();
  const b = makeProject({ store: a.store });
  writeRandom(path.join(a.root, 'x.bin'));
  await core.track(a.project, ['x.bin']);
  await core.push(a.project);

  shareManifest(a, b);
  assert.equal(await stateOf(b.project, 'x.bin'), 'MissingLocal');
  assert.equal((await core.pull(b.project)).downloaded, 1);

  // a edits and pushes; b has not changed its copy -> Outdated
  const newHash = writeRandom(path.join(a.root, 'x.bin'), 2000);
  assert.equal(await stateOf(a.project, 'x.bin'), 'Modified');
  await core.push(a.project);
  shareManifest(a, b);
  assert.equal(await stateOf(b.project, 'x.bin'), 'Outdated');
  const pushB = await core.push(b.project);
  assert.deepEqual(pushB.outdated, ['x.bin'], 'Push must never roll the manifest back');
  assert.equal(Manifest.load(b.project.manifestPath).find('x.bin').hash, newHash);
  assert.equal((await core.pull(b.project)).downloaded, 1);
  assert.equal(await stateOf(b.project, 'x.bin'), 'UpToDate');
});

test('both sides edit: Conflicted, left alone by push and pull until someone decides', async () => {
  const a = makeProject();
  const b = makeProject({ store: a.store });
  writeRandom(path.join(a.root, 'x.bin'));
  await core.track(a.project, ['x.bin']);
  await core.push(a.project);
  shareManifest(a, b);
  await core.pull(b.project);

  writeRandom(path.join(a.root, 'x.bin'), 300);
  await core.push(a.project);
  const mine = writeRandom(path.join(b.root, 'x.bin'), 400);
  shareManifest(a, b);

  assert.equal(await stateOf(b.project, 'x.bin'), 'Conflicted');
  assert.deepEqual((await core.pull(b.project)).conflicted, ['x.bin']);
  assert.deepEqual((await core.push(b.project)).conflicted, ['x.bin']);

  await core.keepLocal(b.project, ['x.bin']);
  const r = await core.push(b.project);
  assert.equal(r.uploaded, 1);
  assert.equal(Manifest.load(b.project.manifestPath).find('x.bin').hash, mine);
  assert.equal(await stateOf(b.project, 'x.bin'), 'UpToDate');
});

// The regression case UniLFS's staged-tracking design exists for: two
// clones track the same path independently. The incoming manifest must not
// overwrite content that was never pushed anywhere.
test('independently tracked path is Conflicted and kept, not overwritten', async () => {
  const a = makeProject();
  const b = makeProject({ store: a.store });
  writeRandom(path.join(a.root, 'same.bin'), 100);
  await core.track(a.project, ['same.bin']);
  await core.push(a.project);

  const local = writeRandom(path.join(b.root, 'same.bin'), 200);
  await core.track(b.project, ['same.bin']);
  shareManifest(a, b);

  assert.equal(await stateOf(b.project, 'same.bin'), 'Conflicted');
  await core.pull(b.project);
  const after = (await core.status(b.project)).files[0];
  assert.equal(after.currentHash, local, 'unpushed content must survive Pull');
});

test('restoreModified takes the manifest version', async () => {
  const { project, root } = makeProject();
  const original = writeRandom(path.join(root, 'x.bin'));
  await core.track(project, ['x.bin']);
  await core.push(project);
  writeRandom(path.join(root, 'x.bin'), 50);
  assert.deepEqual((await core.pull(project)).keptModified, ['x.bin']);
  assert.equal((await core.pull(project, { restoreModified: true })).downloaded, 1);
  assert.equal((await core.status(project)).files[0].currentHash, original);
});

test('requireBaseline skips files nobody can attribute', async () => {
  const { project, root } = makeProject();
  writeRandom(path.join(root, 'x.bin'));
  await core.track(project, ['x.bin']);
  await core.push(project);
  fs.rmSync(project.stateCachePath); // lose the sync record
  writeRandom(path.join(root, 'x.bin'), 99);
  const r = await core.push(project, { requireBaseline: true });
  assert.deepEqual(r.unattributed, ['x.bin']);
  assert.equal(r.uploaded, 0);
});

test('verify reports blobs missing from storage', async () => {
  const { project, root, store } = makeProject();
  const hash = writeRandom(path.join(root, 'x.bin'));
  await core.track(project, ['x.bin']);
  await core.push(project);
  assert.equal((await core.verify(project)).errors.length, 0);
  fs.rmSync(path.join(store, 'objects', hash.slice(0, 2), hash));
  const r = await core.verify(project);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /missing on remote: x\.bin/);
  const s = await core.status(project, { verifyRemote: true });
  assert.deepEqual(s.missingRemote, ['x.bin']);
  assert.equal(s.files[0].remoteKnown, false);
});

test('trackMatching sweeps the project, skipping excluded and hidden dirs', async () => {
  const { project, root } = makeProject();
  fs.writeFileSync(project.trackPath, '*.psd\n!ui/*.psd\n');
  writeRandom(path.join(root, 'art/a.psd'));
  writeRandom(path.join(root, 'art/deep/b.PSD'));
  writeRandom(path.join(root, 'ui/c.psd'));
  writeRandom(path.join(root, 'node_modules/pkg/d.psd'));
  writeRandom(path.join(root, '.hidden/e.psd'));
  const r = await core.trackMatching(project);
  assert.deepEqual(r.newlyTracked.sort(), ['art/a.psd', 'art/deep/b.PSD']);
  const again = await core.trackMatching(project);
  assert.equal(again.trackedNew, 0);
  assert.equal(again.skipped, 2);
});

test('untrack removes the path everywhere but leaves the file', async () => {
  const { project, root } = makeProject();
  writeRandom(path.join(root, 'x.bin'));
  writeRandom(path.join(root, 'y.bin'));
  await core.track(project, ['x.bin', 'y.bin']);
  await core.push(project);
  await core.track(project, ['x.bin']);
  const r = await core.untrack(project, ['x.bin']);
  assert.equal(r.untracked, 1);
  assert.deepEqual(Manifest.load(project.manifestPath).files.map((f) => f.path), ['y.bin']);
  assert.ok(fs.existsSync(path.join(root, 'x.bin')));
  assert.deepEqual(readBlock(project.gitignorePath, GITIGNORE_BEGIN, GITIGNORE_END).slice(2), ['/y.bin']);
});

test('refuses to track files that must stay in git', async () => {
  const { project, root } = makeProject();
  writeRandom(path.join(root, 'node_modules/x.bin'));
  const r = await core.track(project, ['unilfs.config.json', 'node_modules/x.bin', 'missing.bin', '../outside.bin']);
  assert.equal(r.trackedNew, 0);
  assert.equal(r.errors.length, 4);
});

test('a project in a subdirectory of the repository anchors exclude lines at the repo root', async () => {
  const repo = tempDir();
  git(repo, 'init', '-q');
  const { project, root } = makeProject({ root: path.join(repo, 'game'), initGit: false });
  writeRandom(path.join(root, 'x.bin'));
  await core.track(project, ['x.bin']);
  assert.deepEqual(readBlock(path.join(repo, '.git/info/exclude'), EXCLUDE_BEGIN, EXCLUDE_END), ['/game/x.bin']);
});

test('staged files outside any git checkout are reported as not ignored', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'unilfs.config.json'), JSON.stringify({ provider: 'local', localPath: tempDir() }));
  const project = openProject(root);
  writeRandom(path.join(root, 'x.bin'));
  const r = await core.track(project, ['x.bin']);
  // os.tmpdir() could itself sit inside a checkout; only assert when it does not.
  if (!fs.existsSync(path.join(path.dirname(root), '.git'))) assert.deepEqual(r.notIgnored, ['x.bin']);
});

test('Unity mode records the .meta GUID and restores a discarded .meta on pull', async () => {
  const store = tempDir();
  const root = tempDir();
  git(root, 'init', '-q');
  fs.mkdirSync(path.join(root, 'ProjectSettings'));
  fs.writeFileSync(path.join(root, 'ProjectSettings/UniLFSSettings.json'), JSON.stringify({ provider: 'local', localPath: store }));
  const project = openProject(root);
  assert.equal(project.mode, 'unity');
  const asset = path.join(root, 'Assets/hero.psd');
  writeRandom(asset);
  fs.writeFileSync(asset + '.meta', 'fileFormatVersion: 2\nguid: 0123456789abcdef0123456789abcdef\n');
  await core.track(project, ['Assets/hero.psd']);
  await core.push(project);
  assert.equal(Manifest.load(project.manifestPath).files[0].guid, '0123456789abcdef0123456789abcdef');

  fs.rmSync(asset);
  fs.rmSync(asset + '.meta');
  await core.pull(project);
  assert.equal(fs.readFileSync(asset + '.meta', 'utf8'), 'fileFormatVersion: 2\nguid: 0123456789abcdef0123456789abcdef\n');
});

test('a second operation while one holds the lock is refused', async () => {
  const { project, root } = makeProject();
  writeRandom(path.join(root, 'x.bin'));
  fs.mkdirSync(project.cacheDir, { recursive: true });
  // a live foreign holder: our own parent process stands in for one
  fs.writeFileSync(project.lockPath, JSON.stringify({ pid: process.ppid, op: 'Push' }));
  await assert.rejects(core.track(project, ['x.bin']), /already running/);
  // a dead holder is taken over
  fs.writeFileSync(project.lockPath, JSON.stringify({ pid: 999999, op: 'Push' }));
  assert.equal((await core.track(project, ['x.bin'])).trackedNew, 1);
  assert.equal(fs.existsSync(project.lockPath), false);
});
