import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, uriEncode, EMPTY_PAYLOAD_SHA256 } from '../src/providers/sigv4.js';

// "Example: GET Object" from the AWS S3 Signature Version 4 documentation.
test('SigV4 matches the AWS documented GET Object example', () => {
  const r = sign({
    method: 'GET',
    canonicalUri: '/test.txt',
    headers: {
      host: 'examplebucket.s3.amazonaws.com',
      range: 'bytes=0-9',
      'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256,
      'x-amz-date': '20130524T000000Z',
    },
    payloadSha256: EMPTY_PAYLOAD_SHA256,
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    date: new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
  });
  assert.equal(r.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.equal(r.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
    + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
    + 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('uriEncode follows the AWS rules', () => {
  assert.equal(uriEncode('a b~c/d', true), 'a%20b~c%2Fd');
  assert.equal(uriEncode('a/b', false), 'a/b');
  assert.equal(uriEncode('日', true), '%E6%97%A5');
});
