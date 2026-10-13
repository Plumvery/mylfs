import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { Manifest } from '../src/manifest.js';
import { StagedPaths } from '../src/staged.js';
import { TrackPatterns } from '../src/patterns.js';
import { StateCache } from '../src/state-cache.js';
import { escapeIgnorePath, writeBlock, readBlock } from '../src/ignore.js';
import { openProject } from '../src/project.js';
import { tempDir } from './helpers.js';

test('manifest is written exactly like the Unity package writes it', () => {
  const m = new Manifest();
  m.upsert('b/z.psd', 'bb', 2);
  m.upsert('a/y.fbx', 'aa', 1).guid = '0123456789abcdef0123456789abcdef';
  assert.equal(m.toJsonString(),
    '{\n'
    + '  "version": 1,\n'
    + '  "files": [\n'
    + '    {"path": "a/y.fbx", "hash": "aa", "size": 1, "guid": "0123456789abcdef0123456789abcdef"},\n'
    + '    {"path": "b/z.psd", "hash": "bb", "size": 2}\n'
    + '  ]\n'
    + '}\n');
  assert.equal(new Manifest().toJsonString(), '{\n  "version": 1,\n  "files": []\n}\n');
});

test('manifest round-trips, sorting by ordinal path', () => {
  const dir = tempDir();
  const file = path.join(dir, 'm.json');
  const m = new Manifest();
  m.upsert('Z.bin', 'h1', 10);
  m.upsert('a.bin', 'h2', 20);
  m.upsert('日本語/テクスチャ.png', 'h3', 30);
  m.save(file);
  const back = Manifest.load(file);
  assert.deepEqual(back.files.map((f) => f.path), ['Z.bin', 'a.bin', '日本語/テクスチャ.png']);
  assert.equal(fs.readFileSync(file, 'utf8'), back.toJsonString());
});

test('staged file matches the Unity format and disappears when empty', () => {
  const dir = tempDir();
  const file = path.join(dir, 'unilfs.staged.json');
  const s = new StagedPaths();
  s.add('b.psd');
  s.add('a.psd');
  s.keepLocal('c.psd');
  s.save(file);
  assert.equal(fs.readFileSync(file, 'utf8'),
    '{\n  "version": 1,\n  "paths": [\n    "a.psd",\n    "b.psd"\n  ],\n  "resolveLocal": [\n    "c.psd"\n  ]\n}\n');
  const back = StagedPaths.load(file);
  back.remove('a.psd');
  back.remove('b.psd');
  back.remove('c.psd');
  back.save(file);
  assert.equal(fs.existsSync(file), false);
});

test('corrupt staging reads as empty instead of failing', () => {
  const dir = tempDir();
  const file = path.join(dir, 'unilfs.staged.json');
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(StagedPaths.load(file).paths, []);
});

test('track patterns: name-only, folders, **, negation, case', () => {
  const p = TrackPatterns.parse([
    '# comment',
    '*.psd',
    'Assets/Movies/',
    'Assets/**/*.wav',
    '!Assets/UI/*.psd',
    '',
  ].join('\n'));
  const gate = () => null;
  assert.equal(p.matches('Art/deep/hero.PSD', gate), true);
  assert.equal(p.matches('Assets/UI/button.psd', gate), false);
  assert.equal(p.matches('Assets/Movies/intro/a.mp4', gate), true);
  assert.equal(p.matches('Assets/x.wav', gate), true);
  assert.equal(p.matches('Assets/a/b/x.wav', gate), true);
  assert.equal(p.matches('Other/x.wav', gate), false);
  assert.equal(p.matches('x.psd.bak', gate), false);
});

test('track patterns: later lines win, ".." is rejected, the gate is respected', () => {
  const p = TrackPatterns.parse('*.png\n!icons/*.png\nicons/big.png\n../*.png\n');
  assert.equal(p.matches('icons/small.png'), false);
  assert.equal(p.matches('icons/big.png'), true);
  assert.equal(p.errors.length, 1);
  assert.equal(p.matches('node_modules/a.png', (rel) => (rel.startsWith('node_modules/') ? 'no' : null)), false);
});

test('gitignore escaping anchors and escapes special characters', () => {
  assert.equal(escapeIgnorePath('a/b c.psd'), '/a/b c.psd');
  assert.equal(escapeIgnorePath('a/[x]*?#!.bin'), '/a/\\[x\\]\\*\\?\\#\\!.bin');
});

test('managed block is replaced in place and keeps CRLF files CRLF', () => {
  const dir = tempDir();
  const file = path.join(dir, '.gitignore');
  fs.writeFileSync(file, 'node_modules/\r\n*.log\r\n');
  writeBlock(file, '# >>> B', '# <<< B', ['# >>> B', '/one', '# <<< B']);
  writeBlock(file, '# >>> B', '# <<< B', ['# >>> B', '/two', '# <<< B']);
  writeBlock(file, '# >>> B', '# <<< B', ['# >>> B', '/two', '/three', '# <<< B']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'node_modules/\r\n*.log\r\n\r\n# >>> B\r\n/two\r\n/three\r\n# <<< B\r\n');
  assert.deepEqual(readBlock(file, '# >>> B', '# <<< B'), ['/two', '/three']);
});

test('state cache keeps .NET tick precision beyond 2^53', () => {
  const dir = tempDir();
  const file = path.join(dir, 'statecache.json');
  const unityWritten = '{"version":1,"entries":[{"path":"a.psd","mtimeTicks":638650000000000123,"size":5,"hash":"h","baseHash":"b"}]}';
  fs.writeFileSync(file, unityWritten);
  const cache = new StateCache(file);
  assert.equal(cache.entries.get('a.psd').mtimeTicks, 638650000000000123n);
  assert.equal(cache.getBaseline('a.psd'), 'b');
  cache.dirty = true;
  cache.save();
  assert.equal(fs.readFileSync(file, 'utf8'), unityWritten);
});

test('a Unity project keeps the package\'s file locations and ignore lines', () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'ProjectSettings'));
  fs.writeFileSync(path.join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.0f1\n');
  const p = openProject(root);
  assert.equal(p.mode, 'unity');
  assert.ok(p.settingsPath.endsWith('/ProjectSettings/UniLFSSettings.json'));
  assert.ok(p.credentialsPath.endsWith('/UserSettings/UniLFS.json'));
  assert.ok(p.cacheDir.endsWith('/Library/UniLFS'));
  assert.equal(p.credentialsIgnoreLine, '/UserSettings/UniLFS.json');
  assert.equal(p.untrackableReason('Assets/a.psd.meta'), '.meta files must stay in git');
  assert.equal(p.untrackableReason('Library/x.bin'), 'files under Library/ cannot be tracked');
});

test('the remote-cache fingerprint matches the Unity package formula', () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'unilfs.config.json'), JSON.stringify({
    provider: 's3', s3Endpoint: 'https://x.r2.cloudflarestorage.com', s3Bucket: 'b', s3Prefix: 'unilfs',
  }));
  const expected = crypto.createHash('sha256').update('s3|https://x.r2.cloudflarestorage.com|b|unilfs', 'utf8').digest('hex').slice(0, 12);
  assert.equal(openProject(root).storageFingerprint(), expected);
});
