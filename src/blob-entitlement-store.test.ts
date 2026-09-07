import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { BlobEntitlementStore } from './blob-entitlement-store';
import type { BlobSdkAdapter } from './blob-storage';
import type { StoredEntitlement } from './entitlements';

const reference = 'f'.repeat(64);
const indexKey = 'i'.repeat(64);

function record(overrides: Partial<StoredEntitlement> = {}): StoredEntitlement {
  return {
    version: 1,
    productId: 'paid-psd',
    token: 'v1.key.payload.mac',
    expiresAtMs: 1_800_000_000_000,
    asset: {
      productId: 'paid-psd',
      sourceProvider: 'gdrive',
      blobPath: `assets/sha256/${'a'.repeat(64)}/asset.psd`,
      contentSha256: 'a'.repeat(64),
      contentBytes: 123,
      filename: 'asset.psd',
      mimeType: 'image/vnd.adobe.photoshop',
      priceUsd: '0.01',
    },
    payment: {
      network: 'eip155:8453',
      payer: '0x2222222222222222222222222222222222222222',
      transaction: `0x${'c'.repeat(64)}`,
      paymentReceiptId: `rcpt_${'r'.repeat(43)}`,
    },
    ...overrides,
  };
}

function durableSdk(
  objects = new Map<string, { bytes: Buffer; contentType: string }>(),
  puts: unknown[] = [],
): BlobSdkAdapter {
  return {
    async put(pathname, body, options) {
      puts.push({ pathname, options });
      if (objects.has(pathname)) {
        throw Object.assign(new Error('already exists'), { status: 409 });
      }
      assert.ok(body instanceof Uint8Array);
      objects.set(pathname, { bytes: Buffer.from(body), contentType: options.contentType });
      return { pathname, url: `https://blob.example/${pathname}` };
    },
    async head() {
      throw new Error('not used');
    },
    async read(pathname) {
      const found = objects.get(pathname);
      if (!found) throw Object.assign(new Error('not found'), { status: 404 });
      return {
        body: Readable.from([found.bytes]),
        pathname,
        size: found.bytes.byteLength,
        contentType: found.contentType,
        etag: 'immutable',
      };
    },
    async issueSignedToken() {
      throw new Error('not used');
    },
    async presignUrl() {
      throw new Error('not used');
    },
  };
}

test('BlobEntitlementStore uses a private HMAC index and immutable write options', async () => {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const puts: unknown[] = [];
  const sdk = durableSdk(objects, puts);
  const store = new BlobEntitlementStore(indexKey, sdk);
  const saved = await store.saveIfAbsent(reference, record());
  const [pathname, object] = [...objects.entries()][0];

  assert.equal(saved.created, true);
  assert.match(pathname, /^entitlements\/v1\/[a-f0-9]{64}\.json$/);
  assert.equal(pathname.includes(reference), false);
  assert.equal(object.bytes.byteLength <= 16 * 1024, true);
  assert.equal(object.bytes.toString().includes('PAYMENT-SIGNATURE'), false);
  assert.deepEqual(puts, [
    {
      pathname,
      options: {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: 'application/json',
        multipart: false,
      },
    },
  ]);
});

test('fresh BlobEntitlementStore instance recovers the same frozen record', async () => {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  await new BlobEntitlementStore(indexKey, durableSdk(objects)).saveIfAbsent(reference, record());
  const recovered = await new BlobEntitlementStore(indexKey, durableSdk(objects)).find(
    reference,
    'paid-psd',
  );
  assert.deepEqual(recovered, record());
  assert.equal(Object.isFrozen(recovered), true);
});

test('duplicate save returns compatible existing record and rejects conflict', async () => {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const store = new BlobEntitlementStore(indexKey, durableSdk(objects));
  await store.saveIfAbsent(reference, record());
  const duplicate = await store.saveIfAbsent(reference, record({ token: 'later-race-token' }));
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.record.token, record().token);

  await assert.rejects(
    () =>
      store.saveIfAbsent(
        reference,
        record({
          payment: { ...record().payment, transaction: `0x${'d'.repeat(64)}` },
        }),
      ),
    /does not match/i,
  );
});

test('rejects oversized or malformed durable records', async () => {
  const store = new BlobEntitlementStore(indexKey, durableSdk());
  await assert.rejects(
    () => store.saveIfAbsent(reference, record({ token: 'x'.repeat(9 * 1024) })),
    /record is invalid/i,
  );
  await assert.rejects(
    () =>
      store.saveIfAbsent(
        reference,
        record({
          asset: { ...record().asset, filename: 'n'.repeat(16 * 1024) },
        }),
      ),
    /16 KiB storage limit/i,
  );
});
