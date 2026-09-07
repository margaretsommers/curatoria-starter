import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';

import {
  normalizeSha256,
  hashAndCopyStream,
  sha256Hex,
  verifyCatalogContentHash,
} from './content-integrity';

test('hashAndCopyStream hashes incrementally and caps prefix inspection', async () => {
  const chunks = [
    Buffer.alloc(400, 1),
    Buffer.alloc(400, 2),
    Buffer.alloc(400, 3),
  ];
  let written = 0;
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      written += chunk.byteLength;
      callback();
    },
  });
  const result = await hashAndCopyStream(Readable.from(chunks), destination);
  assert.equal(result.bytes, 1200);
  assert.equal(result.sha256, sha256Hex(Buffer.concat(chunks)));
  assert.equal(result.prefix.byteLength, 512);
  assert.equal(written, 1200);
});

test('normalizeSha256 accepts only complete hexadecimal digests', () => {
  const digest = 'A'.repeat(64);
  assert.equal(normalizeSha256(` ${digest} `), digest.toLowerCase());
  assert.equal(normalizeSha256('a'.repeat(63)), undefined);
  assert.equal(normalizeSha256('g'.repeat(64)), undefined);
  assert.equal(normalizeSha256(undefined), undefined);
});

test('verifyCatalogContentHash binds downloaded bytes and response metadata to catalog', () => {
  const bytes = Buffer.from('exact paid bytes');
  const digest = sha256Hex(bytes);

  assert.deepEqual(verifyCatalogContentHash(bytes, digest, digest.toUpperCase()), {
    ok: true,
    actualSha256: digest,
    detail: 'saved bytes and X-Content-Sha256 match catalog content_sha256',
  });
});

test('verifyCatalogContentHash reports byte and header mismatches without file data', () => {
  const bytes = Buffer.from('wrong bytes');
  const expected = sha256Hex('expected bytes');
  const result = verifyCatalogContentHash(bytes, expected, 'not-a-digest');

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'content_hash_mismatch');
  assert.equal(result.actualSha256, sha256Hex(bytes));
  assert.equal(JSON.stringify(result).includes('wrong bytes'), false);
  assert.deepEqual(result.details.failed_checks, [
    `saved bytes SHA-256 ${sha256Hex(bytes)} does not match catalog content_sha256 ${expected}`,
    'response X-Content-Sha256 "not-a-digest" does not match catalog content_sha256 ' + expected,
  ]);
});
