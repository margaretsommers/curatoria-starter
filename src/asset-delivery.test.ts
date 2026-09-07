import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { AssetDeliveryService } from './asset-delivery';
import { createBrowserProofReceipt } from './browser-proof';
import { BlobEntitlementStore } from './blob-entitlement-store';
import {
  createSignedBlobDownload,
  type BlobSdkAdapter,
} from './blob-storage';
import {
  EntitlementService,
  InMemoryEntitlementStore,
  type EntitlementKeyring,
  type EntitlementStore,
} from './entitlements';
import type { DesignSystemEntry } from './types';

const keyring: EntitlementKeyring = {
  current: { id: 'current', secret: 's'.repeat(64) },
  previous: [],
};
const origin = 'https://curatoria.dev';
const settlement = {
  network: 'eip155:8453',
  payer: '0x2222222222222222222222222222222222222222',
  transaction: `0x${'c'.repeat(64)}`,
};

function asset(overrides: Partial<DesignSystemEntry> = {}): DesignSystemEntry {
  return {
    id: 'curatoria-psd-drive',
    file: 'curatoria.psd',
    resource_type: 'binary_asset',
    mime_type: 'image/vnd.adobe.photoshop',
    name: 'Curatoria PSD',
    description: '',
    price_usd: '0.01',
    tags: [],
    content_sha256: 'a'.repeat(64),
    content_bytes: 100,
    integrity_status: 'verified',
    delivery_mode: 'entitlement',
    blob_path: `assets/sha256/${'a'.repeat(64)}/curatoria.psd`,
    source_provider: 'gdrive',
    published_at: '2026-08-29T00:00:00.000Z',
    active: true,
    ...overrides,
  };
}

function paymentSignature(overrides: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: {
        scheme: 'exact',
        network: settlement.network,
        amount: '10000',
        payTo: '0x1111111111111111111111111111111111111111',
        maxTimeoutSeconds: 300,
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        extra: {},
      },
      payload: {
        signature: `0x${'ab'.repeat(65)}`,
        authorization: {
          from: settlement.payer,
          to: '0x1111111111111111111111111111111111111111',
          value: '10000',
          validAfter: '1',
          validBefore: '9999999999',
          nonce: `0x${'01'.repeat(32)}`,
        },
      },
      ...overrides,
    }),
  ).toString('base64url');
}

function service(
  entry: () => DesignSystemEntry | null,
  store: EntitlementStore = new InMemoryEntitlementStore(),
  now = Date.parse('2026-08-29T12:00:00.000Z'),
  downloads: string[] = [],
): AssetDeliveryService {
  return new AssetDeliveryService({
    findEntry: entry,
    entitlements: new EntitlementService(keyring, store, () => now),
    async createSignedDownload(pathname) {
      downloads.push(pathname);
      return {
        url: 'https://private.blob.example/object?signature=secret',
        expiresAt: new Date(now + 60_000).toISOString(),
      };
    },
  });
}

test('purchase binds browser receipt and transaction to finalized settlement', async () => {
  const entry = asset();
  const signature = paymentSignature();
  const result = await service(() => entry).purchase(entry.id, signature, settlement, origin);

  assert.match(result.receipt_id, /^rcpt_/);
  assert.equal(result.transaction, settlement.transaction);
  assert.equal(result.network, settlement.network);
  assert.equal(result.payer, settlement.payer);
  assert.equal(result.expires_at, '2026-08-29T13:00:00.000Z');
  assert.equal(result.recovered, false);
  assert.equal(JSON.stringify(result).includes(entry.blob_path as string), false);
  assert.equal(JSON.stringify(result).includes(signature), false);
});

test('purchase rejects absent, tampered, or mismatched finalized evidence', async () => {
  const entry = asset();
  const delivery = service(() => entry);
  await assert.rejects(
    () => delivery.purchase(entry.id, paymentSignature(), undefined as never, origin),
    /finalized transaction/i,
  );
  await assert.rejects(
    () =>
      delivery.purchase(
        entry.id,
        paymentSignature(),
        { ...settlement, transaction: '' },
        origin,
      ),
    /finalized transaction/i,
  );
  await assert.rejects(
    () =>
      delivery.purchase(
        entry.id,
        paymentSignature(),
        { ...settlement, payer: '0x3333333333333333333333333333333333333333' },
        origin,
      ),
    /must match/i,
  );
});

test('fresh service instance recovers exact immutable entitlement without repayment', async () => {
  const entry = asset();
  const signature = paymentSignature();
  const durableStore = new InMemoryEntitlementStore();
  const first = await service(() => entry, durableStore).purchase(
    entry.id,
    signature,
    settlement,
    origin,
  );
  const fresh = service(() => null, durableStore);
  const recovered = await fresh.recover(entry.id, signature, origin);
  const redeemed = await fresh.redeem(entry.id, recovered!.entitlement, origin);

  assert.equal(recovered?.recovered, true);
  assert.equal(recovered?.entitlement, first.entitlement);
  assert.equal(recovered?.receipt_id, first.receipt_id);
  assert.equal(recovered?.transaction, first.transaction);
  assert.equal(redeemed.content_sha256, first.content_sha256);
  assert.equal(redeemed.filename, first.filename);
});

test('purchase result is sufficient for transaction-bound browser proof', async () => {
  const entry = asset();
  const result = await service(() => entry).purchase(
    entry.id,
    paymentSignature(),
    settlement,
    origin,
  );
  const proof = createBrowserProofReceipt({
    purchase: {
      receipt_id: result.receipt_id,
      product_id: result.product_id,
      source_provider: result.source_provider,
      network: result.network,
      payer: result.payer,
      transaction: result.transaction,
      entitlement: result.entitlement,
      content_sha256: result.content_sha256,
      content_bytes: result.content_bytes,
      filename: result.filename,
      mime_type: result.mime_type,
    },
    paymentResponse: {
      success: true,
      transaction: result.transaction,
      network: result.network,
      payer: result.payer,
    },
    actualSha256: result.content_sha256,
    actualBytes: result.content_bytes,
    psd8bps: true,
    verifiedAt: '2026-08-29T12:00:00.000Z',
  });

  assert.equal(proof.transaction, settlement.transaction);
  assert.equal(proof.receipt_id, result.receipt_id);
  assert.doesNotMatch(JSON.stringify(proof), /v1\.|secret|signature/i);
});

test('unsettled or tampered payment payload cannot recover', async () => {
  const entry = asset();
  const signature = paymentSignature();
  const store = new InMemoryEntitlementStore();
  const delivery = service(() => entry, store);
  assert.equal(await delivery.recover(entry.id, signature, origin), undefined);
  await delivery.purchase(entry.id, signature, settlement, origin);
  assert.equal(await delivery.recover(entry.id, `${signature}x`, origin), undefined);
  assert.equal(await delivery.recover('other-product', signature, origin), undefined);
});

test('frozen entitlement redeems after catalog deactivation or replacement', async () => {
  let entry = asset();
  const downloads: string[] = [];
  const delivery = service(() => entry, new InMemoryEntitlementStore(), undefined, downloads);
  const purchased = await delivery.purchase(entry.id, paymentSignature(), settlement, origin);
  entry = asset({
    active: false,
    content_sha256: 'b'.repeat(64),
    blob_path: `assets/sha256/${'b'.repeat(64)}/replacement.psd`,
    file: 'replacement.psd',
  });
  const redeemed = await delivery.redeem(entry.id, purchased.entitlement, origin);

  assert.equal(redeemed.content_sha256, 'a'.repeat(64));
  assert.equal(redeemed.filename, 'curatoria.psd');
  assert.deepEqual(downloads, [`assets/sha256/${'a'.repeat(64)}/curatoria.psd`]);
});

test('redeem rejects wrong product and origin bindings', async () => {
  const entry = asset();
  const delivery = service(() => entry);
  const purchased = await delivery.purchase(entry.id, paymentSignature(), settlement, origin);
  await assert.rejects(
    () => delivery.redeem('other-product', purchased.entitlement, origin),
    /different product/i,
  );
  await assert.rejects(
    () => delivery.redeem(entry.id, purchased.entitlement, 'https://evil.example'),
    /different origin/i,
  );
});

test('refresh redemption issues a new 60s signed URL without payment', async () => {
  const entry = asset();
  const signature = paymentSignature();
  const ttls: number[] = [];
  const now = Date.parse('2026-08-29T12:00:00.000Z');
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
      ttls.push(options.validUntil - now);
      return {
        delegationToken: 'delegation',
        clientSigningToken: 'signing',
        validUntil: options.validUntil,
      };
    },
    async presignUrl(_token, options) {
      return { presignedUrl: `https://private.blob.example/object?until=${options.validUntil}` };
    },
  };
  const delivery = new AssetDeliveryService({
    findEntry: () => entry,
    entitlements: new EntitlementService(keyring, new InMemoryEntitlementStore(), () => now),
    createSignedDownload: pathname => createSignedBlobDownload(pathname, sdk, now),
  });
  const purchased = await delivery.purchase(entry.id, signature, settlement, origin);
  const first = await delivery.redeem(entry.id, purchased.entitlement, origin);
  const second = await delivery.redeem(entry.id, purchased.entitlement, origin);

  assert.equal(first.expires_at, '2026-08-29T12:01:00.000Z');
  assert.equal(second.expires_at, first.expires_at);
  assert.deepEqual(ttls, [60_000, 60_000]);
  assert.equal(first.content_sha256, purchased.content_sha256);
});

test('store failure after settlement cannot be recovered', async () => {
  const failingStore: EntitlementStore = {
    async find() {
      return undefined;
    },
    async saveIfAbsent() {
      throw new Error('Blob unavailable');
    },
  };
  const delivery = service(() => asset(), failingStore);
  await assert.rejects(
    () => delivery.purchase(asset().id, paymentSignature(), settlement, origin),
    /Blob unavailable/,
  );
  assert.equal(await delivery.recover(asset().id, paymentSignature(), origin), undefined);
});

test('fresh Blob-backed app instance recovers and redeems the frozen entitlement', async () => {
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
  const indexKey = 'k'.repeat(64);
  const entry = asset();
  const signature = paymentSignature();
  const first = await service(
    () => entry,
    new BlobEntitlementStore(indexKey, sdk),
  ).purchase(entry.id, signature, settlement, origin);
  const fresh = service(() => null, new BlobEntitlementStore(indexKey, sdk));
  const recovered = await fresh.recover(entry.id, signature, origin);
  const redeemed = await fresh.redeem(entry.id, recovered!.entitlement, origin);

  assert.equal(recovered?.entitlement, first.entitlement);
  assert.equal(recovered?.transaction, first.transaction);
  assert.equal(redeemed.content_sha256, first.content_sha256);
});
