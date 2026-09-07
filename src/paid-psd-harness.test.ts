import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { importPrivateBlob } from './blob-storage';
import { preflightDownloadDestination } from './destination-preflight';
import { createDownloadReceipt } from './download-receipt';
import { commitDownloadWithReceipt } from './local-delivery';
import { LocalBlobStore } from './local-blob-storage';
import { streamResumableDownload } from './resumable-download';
import { checkUnpaidBinaryAsset402 } from '../scripts/smoke-checks';

import {
  FAKE_SETTLEMENT_LABEL,
  PREVIEW_PRODUCT_ID,
  PREVIEW_WALLET,
  PRODUCTION_WALLET,
  assertPreviewAllowed,
  collectProductionWalletMarkers,
  createPreviewHarness,
  generatedPreviewFixture,
  listenPreview,
  runInjectedFailure,
  runPreviewCatalogToReceipt,
  runPreviewPurchaseRedeem,
} from './paid-psd-harness';

test('generated preview fixture matches the committed tiny RGB PSD', () => {
  const fixture = generatedPreviewFixture();
  const committed = fs.readFileSync(
    path.join(__dirname, '..', 'test/fixtures/psd/tiny-rgb-1x1.psd'),
  );
  assert.equal(fixture.bytesCount, 43);
  assert.equal(fixture.sha256, '13816c1d70cf697784904f76549cfdee4ebf4a7309878923933cd65fd2318025');
  assert.deepEqual(fixture.bytes, committed);
  assert.equal(fixture.bytes.subarray(0, 4).toString('ascii'), '8BPS');
});

test('preview harness refuses production origins and production wallet configuration', () => {
  assert.throws(
    () =>
      assertPreviewAllowed({
        production: true,
        publicOrigin: 'http://127.0.0.1',
        walletAddress: PREVIEW_WALLET,
        env: {},
      }),
    /refuses production/,
  );
  assert.throws(
    () =>
      assertPreviewAllowed({
        publicOrigin: 'https://curatoria.dev',
        walletAddress: PREVIEW_WALLET,
        env: {},
      }),
    /production origins/,
  );
  assert.throws(
    () =>
      assertPreviewAllowed({
        publicOrigin: 'http://127.0.0.1',
        allowedOrigins: ['https://curatoria.dev'],
        env: {},
      }),
    /production origins/,
  );
  assert.throws(
    () =>
      assertPreviewAllowed({
        publicOrigin: 'http://127.0.0.1',
        walletAddress: `0x${PRODUCTION_WALLET.slice(2).toUpperCase()}`,
        env: {},
      }),
    /production wallet/,
  );
  assert.throws(
    () =>
      assertPreviewAllowed({
        bindHost: '0.0.0.0',
        publicOrigin: 'http://127.0.0.1',
        env: {},
      }),
    /loopback only/,
  );
  assert.throws(
    () =>
      assertPreviewAllowed({
        publicOrigin: 'http://127.0.0.1',
        walletAddress: PREVIEW_WALLET,
        env: { WALLET_ENS: 'example.eth', NETWORK: 'base' },
      }),
    /WALLET_ENS/,
  );
  assert.doesNotThrow(() =>
    assertPreviewAllowed({
      bindHost: '127.0.0.1',
      publicOrigin: 'http://127.0.0.1',
      walletAddress: PREVIEW_WALLET,
      allowedOrigins: ['http://127.0.0.1'],
      env: {},
    }),
  );
});

test('collectProductionWalletMarkers reports env names only', () => {
  const names = collectProductionWalletMarkers({
    NODE_ENV: 'production',
    WALLET_ADDRESS: PRODUCTION_WALLET,
    WALLET_ENS: 'secret-name.eth',
    BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_secret',
    CDP_API_KEY_SECRET: 'cdp-secret',
  });
  assert.deepEqual(names.sort(), [
    'BLOB_READ_WRITE_TOKEN',
    'CDP_API_KEY_SECRET',
    'NODE_ENV',
    'WALLET_ADDRESS',
    'WALLET_ENS',
  ]);
  const serialized = JSON.stringify(names);
  assert.equal(serialized.includes('secret-name.eth'), false);
  assert.equal(serialized.includes('vercel_blob_rw_secret'), false);
  assert.equal(serialized.includes('cdp-secret'), false);
});

test('loopback preview composes catalog, 402, Range stream, disk save, and receipt', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-psd-receipt-'));
  const harness = createPreviewHarness({ env: {} });
  const listener = await listenPreview(harness.app);
  try {
    const result = await runPreviewCatalogToReceipt(listener.url, harness, workspace);
    assert.equal(result.catalogStatus, 200);
    assert.equal(result.unpaidStatus, 402);
    assert.equal(result.purchaseStatus, 200);
    assert.equal(result.redeemStatus, 200);
    assert.equal(result.rangeStatus, 206);
    assert.equal(result.settlementKind, FAKE_SETTLEMENT_LABEL);
    assert.equal(result.bytes, 43);
    assert.equal(result.sha256, harness.fixture.sha256);
    assert.deepEqual(fs.readFileSync(result.savedPath), harness.fixture.bytes);
    assert.equal(result.savedPath.endsWith('.psd'), true);
    assert.ok(result.receiptPath);
    const receipt = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8')) as {
      sha256: string;
      bytes: number;
      entitlement?: string;
    };
    assert.equal(receipt.sha256, harness.fixture.sha256);
    assert.equal(receipt.bytes, 43);
    assert.equal('entitlement' in receipt, false);
    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes(harness.paymentSignature), false);
    assert.equal(serialized.includes('https://blob.example'), false);
  } finally {
    await listener.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('loopback preview purchase uses labeled fake settlement and the generated PSD only', async () => {
  const harness = createPreviewHarness({ env: {} });
  assert.equal(harness.settlement.label, FAKE_SETTLEMENT_LABEL);
  assert.equal(harness.product.id, PREVIEW_PRODUCT_ID);
  assert.equal(harness.product.source_provider, 'local');
  assert.equal(harness.config.production, false);
  assert.equal(harness.config.walletAddress, PREVIEW_WALLET);
  const listener = await listenPreview(harness.app);
  try {
    assert.equal(new URL(listener.url).hostname, '127.0.0.1');
    const result = await runPreviewPurchaseRedeem(listener.url, harness);
    assert.equal(result.purchaseStatus, 200);
    assert.equal(result.redeemStatus, 200);
    assert.equal(result.settlementKind, FAKE_SETTLEMENT_LABEL);
    assert.match(result.receiptId ?? '', /^rcpt_/);
    assert.ok(harness.events.some(event => event.stage === 'purchase' && event.outcome === 'ok'));
    assert.ok(harness.events.some(event => event.stage === 'redeem' && event.outcome === 'ok'));
    const serialized = JSON.stringify(harness.events);
    assert.equal(serialized.includes('https://blob.example'), false);
    assert.equal(serialized.includes('Bearer'), false);
    assert.equal(serialized.includes('entitlement'), false);
  } finally {
    await listener.close();
  }
});

test('failure drills inject each fault without executing rollback', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-psd-drill-'));
  try {
    const blob = await runInjectedFailure('blob_failure', workspace);
    const signing = await runInjectedFailure('signing_failure', workspace);
    const expiry = await runInjectedFailure('url_expiry', workspace);
    const disconnect = await runInjectedFailure('disconnect', workspace);
    const disk = await runInjectedFailure('disk_full', workspace);
    const receipt = await runInjectedFailure('receipt_write_failure', workspace);
    assert.equal(blob.observed, 'blob_failure');
    assert.equal(blob.status, 503);
    assert.equal(signing.observed, 'signing_failure');
    assert.equal(signing.status, 503);
    assert.equal(expiry.observed, 'url_expiry');
    assert.equal(disconnect.observed, 'disconnect');
    assert.equal(disk.observed, 'disk_full');
    assert.equal(receipt.observed, 'receipt_write_failure');
    assert.equal(blob.settlementKind, FAKE_SETTLEMENT_LABEL);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('loopback preview over the local blob store delivers its own signed URL end to end', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-local-e2e-'));
  const blobRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-local-e2e-blob-'));
  const now = () => Date.parse('2026-08-29T12:00:00.000Z');
  let listenerUrl = 'http://127.0.0.1';
  const store = new LocalBlobStore({
    rootDirectory: blobRoot,
    baseUrl: () => listenerUrl,
    signingSecret: crypto.randomBytes(32),
    clock: now,
  });
  const harness = createPreviewHarness({ env: {}, localBlob: store });
  await importPrivateBlob(
    {
      bytes: harness.fixture.bytes,
      filename: 'tiny-rgb-1x1.psd',
      mimeType: 'image/vnd.adobe.photoshop',
    },
    store,
  );
  const listener = await listenPreview(harness.app);
  listenerUrl = listener.url;
  try {
    const unpaid = await fetch(`${listener.url}/assets/${PREVIEW_PRODUCT_ID}/purchase`);
    assert.equal(unpaid.status, 402);
    await unpaid.arrayBuffer();

    const purchased = await fetch(`${listener.url}/assets/${PREVIEW_PRODUCT_ID}/purchase`, {
      headers: { 'payment-signature': harness.paymentSignature },
    });
    assert.equal(purchased.status, 200);
    const purchaseBody = (await purchased.json()) as {
      entitlement: string;
      receipt_id: string;
      filename: string;
      mime_type: string;
    };

    const redeemed = await fetch(`${listener.url}/assets/${PREVIEW_PRODUCT_ID}/redeem`, {
      headers: { authorization: `Bearer ${purchaseBody.entitlement}` },
    });
    assert.equal(redeemed.status, 200);
    const redeemBody = (await redeemed.json()) as { download_url: string; expires_at: string };
    assert.ok(
      redeemBody.download_url.startsWith(`${listener.url}/local-blob/`),
      `signed URL should be served by the app itself: ${redeemBody.download_url}`,
    );

    const reservation = await preflightDownloadDestination({
      out: workspace,
      filename: purchaseBody.filename,
      contentBytes: harness.fixture.bytesCount,
      collisionPolicy: 'number',
      homeDirectory: workspace,
      stateDirectory: workspace,
      isTTY: false,
    });
    await fs.promises.writeFile(reservation.tempPath, harness.fixture.bytes.subarray(0, 8), {
      mode: 0o600,
    });
    let rangeStatus = 0;
    const trackingFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await fetch(input, init);
      rangeStatus = response.status;
      return response;
    }) as typeof fetch;
    const streamed = await streamResumableDownload(
      {
        version: 1,
        product_id: PREVIEW_PRODUCT_ID,
        temp_path: reservation.tempPath,
        final_path: reservation.finalPath,
        bytes_written: 8,
        content_sha256: harness.fixture.sha256,
        content_bytes: harness.fixture.bytesCount,
        download_url: redeemBody.download_url,
        download_expires_at: redeemBody.expires_at,
        entitlement: purchaseBody.entitlement,
        etag: `"${harness.fixture.sha256}"`,
      },
      trackingFetch,
    );
    assert.equal(rangeStatus, 206);
    assert.equal(streamed.bytes, harness.fixture.bytesCount);
    assert.equal(streamed.sha256, harness.fixture.sha256);

    const committed = await commitDownloadWithReceipt(
      reservation.tempPath,
      reservation.finalPath,
      createDownloadReceipt({
        receipt_id: purchaseBody.receipt_id,
        product_id: PREVIEW_PRODUCT_ID,
        saved_path: reservation.finalPath,
        filename: purchaseBody.filename,
        mime_type: purchaseBody.mime_type,
        bytes: streamed.bytes,
        sha256: streamed.sha256,
        source_provider: 'local',
        delivered_via: 'entitlement',
      }),
    );
    assert.ok(committed.receiptPath);
    assert.deepEqual(fs.readFileSync(reservation.finalPath), harness.fixture.bytes);
    const receiptSerialized = fs.readFileSync(committed.receiptPath!, 'utf8');
    assert.equal(receiptSerialized.includes(redeemBody.download_url), false);
    assert.equal(receiptSerialized.includes(purchaseBody.entitlement), false);
  } finally {
    await listener.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(blobRoot, { recursive: true, force: true });
  }
});

test('checkUnpaidBinaryAsset402 discovers the published binary_asset product and validates its 402', async () => {
  const harness = createPreviewHarness({ env: {} });
  const listener = await listenPreview(harness.app);
  try {
    const discovered = await checkUnpaidBinaryAsset402(listener.url);
    assert.equal(discovered.ok, true, discovered.detail);
    assert.match(discovered.detail, new RegExp(PREVIEW_PRODUCT_ID));

    const explicit = await checkUnpaidBinaryAsset402(listener.url, PREVIEW_PRODUCT_ID);
    assert.equal(explicit.ok, true, explicit.detail);
  } finally {
    await listener.close();
  }
});

test('checkUnpaidBinaryAsset402 skips cleanly when no binary_asset product is published', async () => {
  const app = express();
  app.get('/.well-known/design-catalog.json', (_req, res) => {
    res.json({ design_systems: [{ id: 'markdown-only', resource_type: 'design_md' }] });
  });
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  try {
    const result = await checkUnpaidBinaryAsset402(`http://127.0.0.1:${port}`);
    assert.equal(result.ok, true);
    assert.match(result.detail, /SKIP/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  }
});
