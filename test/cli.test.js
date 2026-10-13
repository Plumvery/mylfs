import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeProject, writeRandom } from './helpers.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mylfs.js');

function run(root, ...args) {
  const r = spawnSync(process.execPath, [CLI, '--root', root, '--json', ...args], { encoding: 'utf8' });
  return { code: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
}

test('--json prints exactly one result object on stdout', () => {
  const { root } = makeProject();
  fs.writeFileSync(path.join(root, 'unilfs.track'), '*.bin\n');
  writeRandom(path.join(root, 'a.bin'));
  writeRandom(path.join(root, 'b.txt'));
  fs.writeFileSync(path.join(root, 'list.txt'), 'a.bin\nb.txt\n');

  const t = run(root, 'track', '--matching', '--paths-file', path.join(root, 'list.txt'));
  assert.equal(t.code, 0);
  assert.deepEqual(t.out.newlyTracked, ['a.bin']);

  const p = run(root, 'push');
  assert.equal(p.out.promoted, 1);

  const s = run(root, 'status');
  assert.equal(s.out.files[0].state, 'UpToDate');
  assert.equal(typeof s.out.files[0].guid, 'string', 'no nulls for strict deserializers');

  assert.deepEqual(run(root, 'patterns').out, { exists: true, count: 1, errors: [] });
});

test('--progress-json streams phase slices and item events on stderr', () => {
  const { root } = makeProject();
  writeRandom(path.join(root, 'a.bin'), 3 * 1024 * 1024);
  run(root, 'track', 'a.bin');
  const r = run(root, '--progress-json', 'push');
  const events = r.stderr.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const phases = events.filter((e) => e.type === 'phase').map((e) => [e.phase, e.start, e.span]);
  assert.deepEqual(phases, [['Hashing', 0, 0.25], ['Checking remote', 0.25, 0.10], ['Uploading', 0.35, 0.65]]);
  const upload = events.filter((e) => e.phase === 'Uploading' && e.type !== 'phase');
  assert.equal(upload[0].type, 'start');
  assert.equal(upload.at(-1).type, 'done');
  assert.ok(upload.some((e) => e.type === 'bytes' && e.bytes === 3 * 1024 * 1024));
});

test('failures come back as { error: { kind } }', () => {
  const { root } = makeProject();
  fs.writeFileSync(path.join(root, 'unilfs.config.json'), JSON.stringify({ provider: 's3' }));
  const r = run(root, 'test');
  assert.equal(r.code, 1);
  assert.equal(r.out.error.kind, 'config');
  assert.equal(run(path.join(root, 'nope'), 'status').out.error.kind, 'config');
});

test('"cancel" on stdin stops gracefully and releases the lock', async () => {
  const { root, project } = makeProject();
  writeRandom(path.join(root, 'a.bin'), 1000);
  run(root, 'track', 'a.bin');
  run(root, 'push');
  fs.rmSync(path.join(root, 'a.bin'));
  const child = spawn(process.execPath, [CLI, '--root', root, '--json', '--cancel-on-stdin', 'pull']);
  child.stdin.write('cancel\n');
  let stdout = '';
  child.stdout.on('data', (c) => { stdout += c; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  const out = JSON.parse(stdout);
  // Small enough that it may finish first; either way it must end cleanly.
  if (out.error) assert.equal(out.error.kind, 'cancelled');
  else assert.equal(code, 0);
  assert.equal(fs.existsSync(project.lockPath), false);
});
