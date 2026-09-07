import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { Readable } from 'node:stream';

import { BlobEntitlementStore } from './blob-entitlement-store';
import type { BlobSdkAdapter } from './blob-storage';
import {
  ENTITLEMENT_TTL_MS,
  EntitlementService,
  InMemoryEntitlementStore,
  signEntitlement,
  storeIndexKeyFromEnv,
  verifyEntitlement,
  type EntitlementClaims,
  type EntitlementKeyring,
  type EntitlementStore,
} from './entitlements';
import type { DesignSystemEntry } from './types';

const keyring: EntitlementKeyring = {
  current: { id: '2026-08', secret: 'a'.repeat(64) },
  previous: [],
};
const reference = 'f'.repeat(64);
const payment = {
  network: 'eip155:8453',
  payer: '0x2222222222222222222222222222222222222222',
  transaction: `0x${'c'.repeat(64)}`,
};
const origin = 'https://curatoria.dev';

function entry(overrides: Partial<DesignSystemEntry> = {}): DesignSystemEntry {
  return {
    id: 'curatoria-psd-drive',
    file: 'curatoria.psd',
    resource_type: 'binary_asset',
    mime_type: 'image/vnd.adobe.photoshop',
    name: 'Curatoria PSD',
    description: '',
    price_usd: '0.01',
    tags: ['psd'],
    content_sha256: 'b'.repeat(64),
    content_bytes: 123,
    integrity_status: 'verified',
    delivery_mode: 'entitlement',
    source_provider: 'gdrive',
    blob_path: `assets/sha256/${'b'.repeat(64)}/curatoria.psd`,
    published_at: '2026-08-29T00:00:00.000Z',
    active: true,
    ...overrides,
  };
}

test('issues strict expanded version 1 claims only through settled issuance', async () => {
  const now = Date.parse('2026-08-29T12:00:00.000Z');
  const service = new EntitlementService(keyring, new InMemoryEntitlementStore(), () => now);
  const issued = await service.issueAfterSettlement(entry(), reference, payment, origin);
  const claims = verifyEntitlement(issued.record.token, keyring, now, {
    productId: entry().id,
    origin,
  });

  assert.deepEqual(claims, {
    version: 1,
    jti: claims.jti,
    issuer: origin,
    audience: `${origin}/assets/curatoria-psd-drive/redeem`,
    origin,
    productId: 'curatoria-psd-drive',
    contentSha256: 'b'.repeat(64),
    contentBytes: 123,
    filename: 'curatoria.psd',
    mimeType: 'image/vnd.adobe.photoshop',
    priceUsd: '0.01',
    network: payment.network,
    payer: payment.payer,
    paymentReceiptId: claims.paymentReceiptId,
    transaction: payment.transaction,
    issuedAt: '2026-08-29T12:00:00.000Z',
    expiresAt: '2026-08-29T13:00:00.000Z',
  });
  assert.match(claims.paymentReceiptId, /^rcpt_/);
  assert.equal(JSON.stringify(issued.record).includes('signature'), false);
});

test('duplicate issuance returns the immutable existing entitlement', async () => {
  const now = Date.parse('2026-08-29T12:00:00.000Z');
  const service = new EntitlementService(keyring, new InMemoryEntitlementStore(), () => now);
  const first = await service.issueAfterSettlement(entry(), reference, payment, origin);
  const second = await service.issueAfterSettlement(entry(), reference, payment, origin);
  assert.equal(second.recovered, true);
  assert.equal(second.record.token, first.record.token);
});

test('store failure prevents entitlement issuance result', async () => {
  const failingStore: EntitlementStore = {
    async find() {
      return undefined;
    },
    async saveIfAbsent() {
      throw new Error('Blob unavailable');
    },
  };
  const service = new EntitlementService(keyring, failingStore);
  await assert.rejects(
    () => service.issueAfterSettlement(entry(), reference, payment, origin),
    /Blob unavailable/,
  );
});

test('rejects incomplete settlement evidence and changed recovered identity', async () => {
  const now = Date.parse('2026-08-29T12:00:00.000Z');
  const service = new EntitlementService(keyring, new InMemoryEntitlementStore(), () => now);
  await assert.rejects(
    () => service.issueAfterSettlement(entry(), reference, { ...payment, transaction: '' }, origin),
    /settlement evidence/i,
  );
  await service.issueAfterSettlement(entry(), reference, payment, origin);
  await assert.rejects(
    () =>
      service.issueAfterSettlement(
        entry(),
        reference,
        { ...payment, payer: '0x3333333333333333333333333333333333333333' },
        origin,
      ),
    /conflicts/i,
  );
});

test('strict verification rejects wrong, extra, overlong, and tampered claims', async () => {
  const now = Date.parse('2026-08-29T12:00:00.000Z');
  const service = new EntitlementService(keyring, new InMemoryEntitlementStore(), () => now);
  const issued = await service.issueAfterSettlement(entry(), reference, payment, origin);
  const valid = service.verify(issued.record.token);

  assert.throws(() => signEntitlement({ ...valid, version: 2 as 1 }, keyring.current), /claims/i);
  assert.throws(
    () => signEntitlement({ ...valid, unexpected: true } as EntitlementClaims, keyring.current),
    /claims/i,
  );
  assert.throws(
    () =>
      signEntitlement(
        {
          ...valid,
          expiresAt: new Date(Date.parse(valid.issuedAt) + ENTITLEMENT_TTL_MS + 1).toISOString(),
        },
        keyring.current,
      ),
    /claims/i,
  );
  assert.throws(() => verifyEntitlement(`${issued.record.token}x`, keyring, now), /signature/i);
  assert.throws(
    () => verifyEntitlement(issued.record.token, keyring, now, { origin: 'https://evil.example' }),
    /different origin/i,
  );
});

test('verification rejects a correctly MACed payload with omitted required claim', async () => {
  const now = Date.parse('2026-08-29T12:00:00.000Z');
  const service = new EntitlementService(keyring, new InMemoryEntitlementStore(), () => now);
  const issued = await service.issueAfterSettlement(entry(), reference, payment, origin);
  const [, keyId, encoded] = issued.record.token.split('.');
  const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
  delete claims.transaction;
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = `v1.${keyId}.${payload}`;
  const signature = crypto.createHmac('sha256', keyring.current.secret).update(input).digest('base64url');
  assert.throws(() => verifyEntitlement(`${input}.${signature}`, keyring, now), /claims/i);
});

test('entitlement lifetime is exactly one hour and expires at the boundary', async () => {
  const now = Date.parse('2026-08-29T12:00:00.000Z');
  const store = new InMemoryEntitlementStore();
  const service = new EntitlementService(keyring, store, () => now);
  const issued = await service.issueAfterSettlement(entry(), reference, payment, origin);
  const claims = verifyEntitlement(issued.record.token, keyring, now);

  assert.equal(Date.parse(claims.expiresAt) - Date.parse(claims.issuedAt), ENTITLEMENT_TTL_MS);
  assert.equal(issued.record.expiresAtMs - now, ENTITLEMENT_TTL_MS);
  assert.doesNotThrow(() =>
    verifyEntitlement(issued.record.token, keyring, now + ENTITLEMENT_TTL_MS - 1),
  );
  assert.throws(
    () => verifyEntitlement(issued.record.token, keyring, now + ENTITLEMENT_TTL_MS),
    /expired/i,
  );
  const expiredService = new EntitlementService(keyring, store, () => now + ENTITLEMENT_TTL_MS);
  await assert.rejects(() => expiredService.recover(entry().id, reference, origin), /expired/i);
});

test('store index key is dedicated and never derived from the signing key', () => {
  const signingOnly = { ENTITLEMENT_SIGNING_KEY: 's'.repeat(64) };
  assert.throws(() => storeIndexKeyFromEnv(signingOnly), /ENTITLEMENT_STORE_INDEX_KEY/);
  assert.throws(() => storeIndexKeyFromEnv({}), /ENTITLEMENT_STORE_INDEX_KEY/);
  assert.throws(
    () => storeIndexKeyFromEnv({ ENTITLEMENT_STORE_INDEX_KEY: 'short' }),
    /at least 32 bytes/,
  );
  assert.throws(
    () => storeIndexKeyFromEnv({ NODE_ENV: 'production', ENTITLEMENT_SIGNING_KEY: 's'.repeat(64) }),
    /ENTITLEMENT_STORE_INDEX_KEY/,
  );
  const dedicated = 'i'.repeat(64);
  assert.equal(
    storeIndexKeyFromEnv({
      ENTITLEMENT_SIGNING_KEY: 's'.repeat(64),
      ENTITLEMENT_STORE_INDEX_KEY: dedicated,
    }),
    dedicated,
  );
});

test('rotating only the signing key still recovers the existing Blob entitlement', async () => {
  const now = Date.parse('2026-08-29T12:00:00.000Z');
  const indexKey = 'i'.repeat(64);
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const sdk: BlobSdkAdapter = {
    async put(pathname, body, options) {
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
  const store = new BlobEntitlementStore(indexKey, sdk);
  const issued = await new EntitlementService(keyring, store, () => now).issueAfterSettlement(
    entry(),
    reference,
    payment,
    origin,
  );
  const rotated: EntitlementKeyring = {
    current: { id: '2026-09', secret: 'b'.repeat(64) },
    previous: [keyring.current],
  };
  const recovered = await new EntitlementService(rotated, store, () => now).recover(
    entry().id,
    reference,
    origin,
  );
  assert.equal(recovered?.token, issued.record.token);
  assert.notEqual(
    new BlobEntitlementStore(indexKey, sdk).pathname(reference, entry().id),
    new BlobEntitlementStore(keyring.current.secret, sdk).pathname(reference, entry().id),
  );
});
