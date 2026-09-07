import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

import {
  assertLocalBlobPathname,
  createLocalBlobDownloadHandler,
  LocalBlobStore,
} from './local-blob-storage';
import { importPrivateBlob, createSignedBlobDownload } from './blob-storage';
import { BlobEntitlementStore } from './blob-entitlement-store';

const SECRET = crypto.randomBytes(32);

async function makeStore(clock?: () => number): Promise<{ store: LocalBlobStore; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-local-blob-'));
  const store = new LocalBlobStore({
    rootDirectory: root,
    baseUrl: 'http://localhost:3000',
    signingSecret: SECRET,
    clock,
  });
  return { store, root };
}

function psdBytes(): Buffer {
  return Buffer.concat([Buffer.from('8BPS'), crypto.randomBytes(64)]);
}

test('local store put/head/read roundtrip preserves bytes and metadata', async () => {
  const { store } = await makeStore();
  const bytes = psdBytes();
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const pathname = `assets/sha256/${sha256}/demo.psd`;

  const stored = await store.put(pathname, bytes, {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: 'image/vnd.adobe.photoshop',
    multipart: false,
  });
  assert.equal(stored.pathname, pathname);
  assert.equal(stored.etag, sha256);

  const details = await store.head(pathname);
  assert.equal(details.size, bytes.byteLength);
  assert.equal(details.contentType, 'image/vnd.adobe.photoshop');
  assert.equal(details.etag, sha256);

  const read = await store.read(pathname);
  const chunks: Buffer[] = [];
  for await (const chunk of read.body) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), bytes);
});

test('local store rejects overwrite with a recognizable conflict', async () => {
  const { store } = await makeStore();
  const bytes = psdBytes();
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const pathname = `assets/sha256/${sha256}/demo.psd`;
  const options = {
    access: 'private' as const,
    addRandomSuffix: false as const,
    allowOverwrite: false as const,
    contentType: 'image/vnd.adobe.photoshop',
    multipart: false,
  };
  await store.put(pathname, bytes, options);
  await assert.rejects(store.put(pathname, bytes, options), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'BLOB_ALREADY_EXISTS');
    return true;
  });
});

test('importPrivateBlob deduplicates identical content through the local store', async () => {
  const { store } = await makeStore();
  const bytes = psdBytes();
  const input = {
    bytes,
    filename: 'demo.psd',
    mimeType: 'image/vnd.adobe.photoshop',
  };
  const first = await importPrivateBlob(input, store);
  assert.equal(first.created, true);
  const second = await importPrivateBlob(input, store);
  assert.equal(second.created, false);
  assert.equal(second.pathname, first.pathname);
  assert.equal(second.etag, first.etag);
});

test('local store rejects traversal and malformed pathnames', async () => {
  const { store } = await makeStore();
  for (const bad of [
    '../escape.psd',
    'assets/../secret.json',
    '/absolute/path.psd',
    'assets//double.psd',
    'assets/.hidden/file.psd',
    'assets\\windows.psd',
    '',
  ]) {
    assert.throws(() => assertLocalBlobPathname(bad), /invalid/, bad);
    await assert.rejects(store.head(bad), /invalid|escapes/, bad);
  }
});

test('entitlement store persists and recovers records through the local store', async () => {
  const { store } = await makeStore();
  const entitlements = new BlobEntitlementStore('k'.repeat(32), store);
  const settlementReference = 'a'.repeat(64);
  const record = {
    version: 1 as const,
    productId: 'demo-psd',
    token: 'entitlement-token',
    expiresAtMs: Date.now() + 3_600_000,
    asset: {
      productId: 'demo-psd',
      blobPath: `assets/sha256/${'b'.repeat(64)}/demo.psd`,
      contentSha256: 'b'.repeat(64),
      contentBytes: 68,
      filename: 'demo.psd',
      mimeType: 'image/vnd.adobe.photoshop',
      priceUsd: '0.01',
      sourceProvider: 'dropbox',
    },
    payment: {
      network: 'eip155:8453',
      payer: `0x${'c'.repeat(40)}`,
      transaction: `0x${'d'.repeat(64)}`,
      paymentReceiptId: `rcpt_${'e'.repeat(32)}`,
    },
  };
  const saved = await entitlements.saveIfAbsent(settlementReference, record);
  assert.equal(saved.created, true);
  const replay = await entitlements.saveIfAbsent(settlementReference, record);
  assert.equal(replay.created, false);
  const found = await entitlements.find(settlementReference, 'demo-psd');
  assert.equal(found?.token, 'entitlement-token');
});

async function withServer(
  store: LocalBlobStore,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const app = express();
  const handler = createLocalBlobDownloadHandler(store);
  app.get('/local-blob/*', handler);
  app.head('/local-blob/*', handler);
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  }
}

async function putFixture(store: LocalBlobStore): Promise<{ pathname: string; bytes: Buffer }> {
  const bytes = psdBytes();
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const pathname = `assets/sha256/${sha256}/demo.psd`;
  await store.put(pathname, bytes, {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: 'image/vnd.adobe.photoshop',
    multipart: false,
  });
  return { pathname, bytes };
}

test('signed local URL serves the exact private bytes with download headers', async () => {
  let nowMs = 1_700_000_000_000;
  const { store } = await makeStore(() => nowMs);
  const { pathname, bytes } = await putFixture(store);
  const signed = await createSignedBlobDownload(pathname, store, nowMs);
  const url = new URL(signed.url);
  await withServer(store, async origin => {
    const response = await fetch(`${origin}${url.pathname}${url.search}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/vnd.adobe.photoshop');
    assert.equal(response.headers.get('content-length'), String(bytes.byteLength));
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match(response.headers.get('content-disposition') ?? '', /attachment/);
    const body = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(body, bytes);

    const headResponse = await fetch(`${origin}${url.pathname}${url.search}`, { method: 'HEAD' });
    assert.equal(headResponse.status, 200);
    assert.equal(headResponse.headers.get('content-length'), String(bytes.byteLength));
  });
});

test('tampered signature, wrong pathname, and expiry are rejected', async () => {
  let nowMs = 1_700_000_000_000;
  const { store } = await makeStore(() => nowMs);
  const { pathname } = await putFixture(store);
  const signed = await createSignedBlobDownload(pathname, store, nowMs);
  const url = new URL(signed.url);
  await withServer(store, async origin => {
    const tampered = new URL(`${origin}${url.pathname}${url.search}`);
    tampered.searchParams.set('sig', '0'.repeat(64));
    assert.equal((await fetch(tampered)).status, 404);

    const missingSig = new URL(`${origin}${url.pathname}`);
    assert.equal((await fetch(missingSig)).status, 404);

    const wrongPath = new URL(`${origin}${url.pathname}${url.search}`);
    wrongPath.pathname = wrongPath.pathname.replace('demo.psd', 'other.psd');
    assert.equal((await fetch(wrongPath)).status, 404);

    nowMs += 10 * 60_000;
    assert.equal((await fetch(`${origin}${url.pathname}${url.search}`)).status, 403);
  });
});

test('range requests return 206, honor If-Range, and reject unsatisfiable ranges', async () => {
  let nowMs = 1_700_000_000_000;
  const { store } = await makeStore(() => nowMs);
  const { pathname, bytes } = await putFixture(store);
  const etag = crypto.createHash('sha256').update(bytes).digest('hex');
  const signed = await createSignedBlobDownload(pathname, store, nowMs);
  const url = new URL(signed.url);
  await withServer(store, async origin => {
    const target = `${origin}${url.pathname}${url.search}`;

    const partial = await fetch(target, { headers: { Range: 'bytes=4-11' } });
    assert.equal(partial.status, 206);
    assert.equal(
      partial.headers.get('content-range'),
      `bytes 4-11/${bytes.byteLength}`,
    );
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(4, 12));

    const resumed = await fetch(target, {
      headers: { Range: 'bytes=8-', 'If-Range': `"${etag}"` },
    });
    assert.equal(resumed.status, 206);
    assert.deepEqual(Buffer.from(await resumed.arrayBuffer()), bytes.subarray(8));

    const staleIfRange = await fetch(target, {
      headers: { Range: 'bytes=8-', 'If-Range': '"different-etag"' },
    });
    assert.equal(staleIfRange.status, 200);
    assert.equal(
      staleIfRange.headers.get('content-length'),
      String(bytes.byteLength),
    );
    await staleIfRange.arrayBuffer();

    const unsatisfiable = await fetch(target, {
      headers: { Range: `bytes=${bytes.byteLength}-` },
    });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(
      unsatisfiable.headers.get('content-range'),
      `bytes */${bytes.byteLength}`,
    );

    const suffix = await fetch(target, { headers: { Range: 'bytes=-8' } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(
      Buffer.from(await suffix.arrayBuffer()),
      bytes.subarray(bytes.byteLength - 8),
    );
  });
});

test('signed URLs are never valid for objects that were not stored', async () => {
  let nowMs = 1_700_000_000_000;
  const { store } = await makeStore(() => nowMs);
  const missingPath = `assets/sha256/${'f'.repeat(64)}/ghost.psd`;
  const signed = await createSignedBlobDownload(missingPath, store, nowMs);
  const url = new URL(signed.url);
  await withServer(store, async origin => {
    assert.equal((await fetch(`${origin}${url.pathname}${url.search}`)).status, 404);
  });
});

test('concurrent put for the same pathname never lets a losing writer clobber the winner\'s metadata', async () => {
  const { store } = await makeStore();
  const bytes = psdBytes();
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const pathname = `assets/sha256/${sha256}/demo.psd`;
  const baseOptions = {
    access: 'private' as const,
    addRandomSuffix: false as const,
    allowOverwrite: false as const,
    multipart: false,
  };

  const results = await Promise.allSettled([
    store.put(pathname, bytes, { ...baseOptions, contentType: 'image/vnd.adobe.photoshop' }),
    store.put(pathname, bytes, { ...baseOptions, contentType: 'application/octet-stream' }),
  ]);

  const succeeded = results.filter(result => result.status === 'fulfilled');
  const failed = results.filter(result => result.status === 'rejected');
  assert.equal(succeeded.length, 1, 'exactly one concurrent writer should win');
  assert.equal(failed.length, 1, 'the loser should be rejected, not silently accepted');
  assert.equal(
    (failed[0] as PromiseRejectedResult).reason.code,
    'BLOB_ALREADY_EXISTS',
  );

  // The stored metadata must reflect whichever contentType the WINNING put
  // declared -- never a value from the losing writer that never actually
  // committed bytes.
  const winnerIndex = results.findIndex(result => result.status === 'fulfilled');
  const winnerContentType =
    winnerIndex === 0 ? 'image/vnd.adobe.photoshop' : 'application/octet-stream';
  const details = await store.head(pathname);
  assert.equal(details.contentType, winnerContentType);
});
