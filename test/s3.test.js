import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { S3Provider } from '../src/providers/s3.js';
import { tempDir } from './helpers.js';

/** A tiny in-memory S3: records requests, stores PUT bodies, serves GET/HEAD. */
function fakeS3() {
  const objects = new Map();
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, bytes: Buffer.concat(chunks).length });
      if (!/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/.test(req.headers.authorization || '')) {
        res.writeHead(403).end('<Error>bad auth</Error>');
        return;
      }
      if (req.method === 'PUT') {
        if (req.headers['transfer-encoding']) {
          res.writeHead(411).end('chunked uploads are not supported by S3');
          return;
        }
        objects.set(req.url, Buffer.concat(chunks));
        res.writeHead(200).end();
      } else if (objects.has(req.url)) {
        res.writeHead(200, { 'content-length': objects.get(req.url).length });
        res.end(req.method === 'HEAD' ? undefined : objects.get(req.url));
      } else {
        res.writeHead(404).end();
      }
    });
  });
  return { server, objects, requests };
}

test('S3 provider: HEAD/PUT/GET with path-style keys, fixed length, verified download', async () => {
  const { server, objects, requests } = fakeS3();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    const s3 = new S3Provider({
      endpoint: `http://127.0.0.1:${port}`, bucket: 'my-bucket', region: '', prefix: '/team/unilfs/', accessKeyId: 'AK', secretAccessKey: 'SK',
    });
    const dir = tempDir();
    const src = path.join(dir, 'src.bin');
    const data = crypto.randomBytes(3 * 1024 * 1024 + 7);
    fs.writeFileSync(src, data);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const key = `/my-bucket/team/unilfs/objects/${hash.slice(0, 2)}/${hash}`;

    assert.equal(await s3.blobExists(hash), false);
    let progress = 0;
    await s3.uploadBlob(hash, src, (n) => { progress = n; });
    assert.equal(progress, data.length);
    assert.equal(await s3.blobExists(hash), true);
    const put = requests.find((r) => r.method === 'PUT');
    assert.equal(put.url, key);
    assert.equal(put.headers['content-length'], String(data.length));
    assert.equal(put.headers['x-amz-content-sha256'], hash);
    assert.equal(put.bytes, data.length);

    const dest = path.join(dir, 'out', 'dest.bin');
    await s3.downloadBlob(hash, dest);
    assert.ok(fs.readFileSync(dest).equals(data));

    // A corrupted object never lands on disk.
    objects.set(key, Buffer.from('tampered'));
    const dest2 = path.join(dir, 'dest2.bin');
    await assert.rejects(s3.downloadBlob(hash, dest2), /hash mismatch/);
    assert.equal(fs.existsSync(dest2), false);
    assert.equal(fs.existsSync(dest2 + '.unilfs-partial'), false);

    const bad = new S3Provider({ endpoint: `http://127.0.0.1:${port}`, bucket: 'b', accessKeyId: 'nope', secretAccessKey: 'x' });
    await assert.rejects(bad.blobExists(hash), /HTTP 403.*access key/s);
  } finally {
    server.close();
  }
});

test('S3 provider rejects incomplete configuration with a usable message', () => {
  assert.throws(() => new S3Provider({ endpoint: '', bucket: 'b', accessKeyId: 'a', secretAccessKey: 'b' }), /s3Endpoint/);
  assert.throws(() => new S3Provider({ endpoint: 'ftp://x', bucket: 'b', accessKeyId: 'a', secretAccessKey: 'b' }), /valid http/);
  assert.throws(() => new S3Provider({ endpoint: 'https://x', bucket: 'b' }), /mylfs login/);
});
