import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  buildImmutableBlobPath,
  BlobUploadReconciliationError,
  createSignedBlobDownload,
  importPrivateBlob,
  type BlobSdkAdapter,
} from './blob-storage';

test('buildImmutableBlobPath is content-addressed and strips unsafe filename paths', () => {
  assert.equal(
    buildImmutableBlobPath('a'.repeat(64), '../unsafe/Layout Final.psd'),
    `assets/sha256/${'a'.repeat(64)}/Layout Final.psd`,
  );
});

test('importPrivateBlob uploads immutable private bytes without overwrite', async () => {
  const calls: unknown[] = [];
  const sdk: BlobSdkAdapter = {
    async put(pathname, body, options) {
      assert.ok(body instanceof Uint8Array);
      calls.push({ pathname, body: Buffer.from(body).toString('hex'), options });
      return { pathname, url: 'https://private.blob.example/object' };
    },
    async head(pathname) {
      return {
        pathname,
        size: 4,
        contentType: 'image/vnd.adobe.photoshop',
        etag: 'created-etag',
      };
    },
    async read() {
      throw new Error('not used');
    },
    async issueSignedToken() {
      throw new Error('not used');
    },
    async presignUrl() {
      throw new Error('not used');
    },
  };

  const result = await importPrivateBlob(
    {
      bytes: Buffer.from([0x38, 0x42, 0x50, 0x53]),
      filename: 'layout.psd',
      mimeType: 'image/vnd.adobe.photoshop',
    },
    sdk,
  );

  assert.equal(result.pathname, `assets/sha256/${result.sha256}/layout.psd`);
  assert.equal(result.bytes, 4);
  assert.equal(result.created, true);
  assert.equal(result.etag, 'created-etag');
  assert.deepEqual(calls, [
    {
      pathname: result.pathname,
      body: '38425053',
      options: {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: 'image/vnd.adobe.photoshop',
        multipart: false,
      },
    },
  ]);
});

test('createSignedBlobDownload scopes exactly 60 seconds of GET access to one private object', async () => {
  const calls: unknown[] = [];
  const sdk: BlobSdkAdapter = {
    async put() {
      throw new Error('not used');
    },
    async head() {
      throw new Error('not used');
    },
    async read() {
      throw new Error('not used');
    },
    async issueSignedToken(options) {
      calls.push({ issue: options });
      return {
        delegationToken: 'delegation',
        clientSigningToken: 'signing',
        validUntil: options.validUntil,
      };
    },
    async presignUrl(token, options) {
      calls.push({ presign: { token, options } });
      return { presignedUrl: 'https://private.blob.example/object?signature=secret' };
    },
  };
  const now = Date.parse('2026-08-29T12:00:00.000Z');

  const result = await createSignedBlobDownload('assets/sha256/hash/layout.psd', sdk, now);

  assert.equal(result.expiresAt, '2026-08-29T12:01:00.000Z');
  assert.equal(result.url.includes('signature=secret'), true);
  assert.deepEqual(calls, [
    {
      issue: {
        pathname: 'assets/sha256/hash/layout.psd',
        operations: ['get'],
        validUntil: now + 60 * 1000,
      },
    },
    {
      presign: {
        token: {
          delegationToken: 'delegation',
          clientSigningToken: 'signing',
        },
        options: {
          operation: 'get',
          pathname: 'assets/sha256/hash/layout.psd',
          access: 'private',
          validUntil: now + 60 * 1000,
        },
      },
    },
  ]);
});

test('createSignedBlobDownload enforces the 75-second production ceiling', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(
      () => createSignedBlobDownload('assets/sha256/hash/layout.psd', undefined, Date.now(), 75_001),
      /production maximum/i,
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('importPrivateBlob validates an immutable conflict as safe dedup', async () => {
  const bytes = Buffer.from('same immutable bytes');
  const sdk: BlobSdkAdapter = {
    async put() {
      throw Object.assign(new Error('object already exists'), { status: 409 });
    },
    async head(pathname) {
      return {
        pathname,
        size: bytes.byteLength,
        contentType: 'application/octet-stream',
        etag: 'existing-etag',
      };
    },
    async read(pathname) {
      return {
        body: Readable.from([bytes]),
        pathname,
        size: bytes.byteLength,
        contentType: 'application/octet-stream',
        etag: 'existing-etag',
      };
    },
    async issueSignedToken() {
      throw new Error('not used');
    },
    async presignUrl() {
      throw new Error('not used');
    },
  };

  const result = await importPrivateBlob(
    { bytes, filename: 'asset.bin', mimeType: 'application/octet-stream' },
    sdk,
  );
  assert.equal(result.created, false);
  assert.equal(result.etag, 'existing-etag');
});

test('importPrivateBlob treats a weak-vs-strong etag on the same object as safe dedup, not a conflict', async () => {
  // Observed 2026-09-04 against real Vercel Blob on an 18 MB multipart-
  // uploaded object: head() returned a strong etag while read()/get()
  // returned the same tag prefixed W/ (weak). Same object, same bytes --
  // must not be treated as a metadata-changed conflict.
  const bytes = Buffer.from('same immutable bytes, multipart-uploaded');
  const sdk: BlobSdkAdapter = {
    async put() {
      throw Object.assign(new Error('object already exists'), { status: 409 });
    },
    async head(pathname) {
      return {
        pathname,
        size: bytes.byteLength,
        contentType: 'application/octet-stream',
        etag: '"7dfe67c6434ef78066593ca442af857b-3"',
      };
    },
    async read(pathname) {
      return {
        body: Readable.from([bytes]),
        pathname,
        size: bytes.byteLength,
        contentType: 'application/octet-stream',
        etag: 'W/"7dfe67c6434ef78066593ca442af857b-3"',
      };
    },
    async issueSignedToken() {
      throw new Error('not used');
    },
    async presignUrl() {
      throw new Error('not used');
    },
  };

  const result = await importPrivateBlob(
    {
      bytes,
      filename: 'asset.bin',
      mimeType: 'application/octet-stream',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    sdk,
  );
  assert.equal(result.created, false);
  assert.equal(result.etag, '"7dfe67c6434ef78066593ca442af857b-3"');
});

test('importPrivateBlob tolerates get() reporting size 0 for a real object HEAD already confirmed', async () => {
  // Observed 2026-09-04 against real Vercel Blob on the same 18 MB private
  // multipart-uploaded object: get()'s blob.size was 0 even though HEAD
  // correctly reported the true size and the stream itself carried every
  // byte. HEAD's size (checked by assertMatchingBlob) plus the definitive
  // post-stream byte count make this field redundant, and unreliable here.
  const bytes = Buffer.from('same immutable bytes, multipart-uploaded');
  const sdk: BlobSdkAdapter = {
    async put() {
      throw Object.assign(new Error('object already exists'), { status: 409 });
    },
    async head(pathname) {
      return {
        pathname,
        size: bytes.byteLength,
        contentType: 'application/octet-stream',
        etag: '"real-etag"',
      };
    },
    async read(pathname) {
      return {
        body: Readable.from([bytes]),
        pathname,
        size: 0,
        contentType: 'application/octet-stream',
        etag: 'W/"real-etag"',
      };
    },
    async issueSignedToken() {
      throw new Error('not used');
    },
    async presignUrl() {
      throw new Error('not used');
    },
  };

  const result = await importPrivateBlob(
    {
      bytes,
      filename: 'asset.bin',
      mimeType: 'application/octet-stream',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    sdk,
  );
  assert.equal(result.created, false);
  assert.equal(result.bytes, bytes.byteLength);
});

test('importPrivateBlob still rejects a genuinely different etag, not just a weak/strong prefix difference', async () => {
  const bytes = Buffer.from('same immutable bytes');
  const sdk: BlobSdkAdapter = {
    async put() {
      throw Object.assign(new Error('object already exists'), { status: 409 });
    },
    async head(pathname) {
      return {
        pathname,
        size: bytes.byteLength,
        contentType: 'application/octet-stream',
        etag: '"aaa"',
      };
    },
    async read(pathname) {
      return {
        body: Readable.from([bytes]),
        pathname,
        size: bytes.byteLength,
        contentType: 'application/octet-stream',
        etag: 'W/"bbb"',
      };
    },
    async issueSignedToken() {
      throw new Error('not used');
    },
    async presignUrl() {
      throw new Error('not used');
    },
  };

  await assert.rejects(
    () =>
      importPrivateBlob(
        {
          bytes,
          filename: 'asset.bin',
          mimeType: 'application/octet-stream',
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        sdk,
      ),
    /metadata changed/,
  );
});

test('importPrivateBlob rejects a conflicting object with mismatched metadata', async () => {
  const bytes = Buffer.from('expected');
  const sdk: BlobSdkAdapter = {
    async put() {
      throw Object.assign(new Error('conflict'), { status: 409 });
    },
    async head(pathname) {
      return {
        pathname,
        size: bytes.byteLength + 1,
        contentType: 'application/octet-stream',
        etag: 'wrong-etag',
      };
    },
    async read() {
      throw new Error('not used');
    },
    async issueSignedToken() {
      throw new Error('not used');
    },
    async presignUrl() {
      throw new Error('not used');
    },
  };
  await assert.rejects(
    () =>
      importPrivateBlob(
        { bytes, filename: 'asset.bin', mimeType: 'application/octet-stream' },
        sdk,
      ),
    /does not match the staged asset metadata/,
  );
});

test('importPrivateBlob rejects same-size conflict whose authenticated bytes differ', async () => {
  const bytes = Buffer.from('expected');
  const sdk: BlobSdkAdapter = {
    async put() {
      throw Object.assign(new Error('conflict'), { status: 409 });
    },
    async head(pathname) {
      return {
        pathname,
        size: bytes.byteLength,
        contentType: 'application/octet-stream',
        etag: 'stable',
      };
    },
    async read(pathname) {
      return {
        body: Readable.from([Buffer.from('tampered')]),
        pathname,
        size: bytes.byteLength,
        contentType: 'application/octet-stream',
        etag: 'stable',
      };
    },
    async issueSignedToken() {
      throw new Error('not used');
    },
    async presignUrl() {
      throw new Error('not used');
    },
  };
  await assert.rejects(
    () => importPrivateBlob({ bytes, filename: 'asset.bin', mimeType: 'application/octet-stream' }, sdk),
    /content does not match/,
  );
});

test('post-put head failure preserves successful upload identity without deletion', async () => {
  const bytes = Buffer.from('uploaded');
  const pathname = buildImmutableBlobPath(
    createHash('sha256').update(bytes).digest('hex'),
    'asset.bin',
  );
  const sdk: BlobSdkAdapter = {
    async put() {
      return { pathname, url: 'https://private.blob.example/uploaded' };
    },
    async head() {
      throw new Error('head temporarily unavailable');
    },
    async read() {
      throw new Error('not used');
    },
    async issueSignedToken() {
      throw new Error('not used');
    },
    async presignUrl() {
      throw new Error('not used');
    },
  };
  let caught: unknown;
  try {
    await importPrivateBlob({ bytes, filename: 'asset.bin', mimeType: 'application/octet-stream' }, sdk);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof BlobUploadReconciliationError);
  assert.deepEqual((caught as BlobUploadReconciliationError).uploadIdentity, {
    pathname,
    url: 'https://private.blob.example/uploaded',
    created: true,
  });
});
