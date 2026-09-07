import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import type { BlobSdkAdapter } from './blob-storage';
import { BlobSettlementJournal, InMemorySettlementJournal, type SettlementReceipt } from './settlement-journal';

const reference = 'f'.repeat(64);
const indexKey = 'i'.repeat(64);

function receipt(overrides: Partial<SettlementReceipt> = {}): SettlementReceipt {
  return {
    version: 1,
    productId: 'paid-psd',
    network: 'eip155:8453',
    payer: '0x2222222222222222222222222222222222222222',
    transaction: `0x${'c'.repeat(64)}`,
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
      objects.set(pathname, { bytes: Buffer.from(body as Uint8Array), contentType: options.contentType });
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

test('in-memory journal finds the receipt saved before a simulated crash', async () => {
  const journal = new InMemorySettlementJournal();
  const saved = await journal.saveIfAbsent(reference, receipt());
  assert.equal(saved.created, true);
  assert.deepEqual(await journal.find(reference), saved.receipt);
});

test('duplicate journal save is idempotent and rejects a different transaction', async () => {
  const journal = new InMemorySettlementJournal();
  const first = await journal.saveIfAbsent(reference, receipt());
  const second = await journal.saveIfAbsent(reference, receipt());
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.deepEqual(second.receipt, first.receipt);
  await assert.rejects(
    () => journal.saveIfAbsent(reference, receipt({ transaction: `0x${'d'.repeat(64)}` })),
    /does not match/i,
  );
});

test('BlobSettlementJournal uses a private HMAC index and immutable write options', async () => {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const puts: unknown[] = [];
  const journal = new BlobSettlementJournal(indexKey, durableSdk(objects, puts));
  const saved = await journal.saveIfAbsent(reference, receipt());
  const [pathname] = [...objects.keys()];

  assert.equal(saved.created, true);
  assert.match(pathname, /^settlements\/v1\/[a-f0-9]{64}\.json$/);
  assert.equal(pathname.includes(reference), false);
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

test('fresh BlobSettlementJournal instance recovers the same frozen receipt', async () => {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  await new BlobSettlementJournal(indexKey, durableSdk(objects)).saveIfAbsent(reference, receipt());
  const recovered = await new BlobSettlementJournal(indexKey, durableSdk(objects)).find(reference);
  assert.deepEqual(recovered, receipt());
  assert.equal(Object.isFrozen(recovered), true);
});
