import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { encodePaymentRequiredHeader } from '@x402/core/http';

import { spawn } from 'node:child_process';

import {
  continueCuratoriaEntitlement,
  downloadCuratoriaAsset,
  makeFailure,
  MAX_ENTITLEMENT_STDIN_BYTES,
  parseContentDispositionFilename,
  parseEntitlementContinuation,
  priceUsdToAtomic,
  resolveOutputPath,
  resumeCuratoriaDownload,
  sourceProvider,
  validateDownloadedBytes,
  validateSpend,
} from './agent-downloader';
import type { PaymentSignerAdapter } from './agent-downloader';
import { SpendBudget } from './spend-budget';
import { writePrivateResumeState } from './local-delivery';
import {
  createAwalEntitlementPurchaser,
  WalletPurchasePreflightError,
  type EntitlementPurchaserAdapter,
} from './wallet-purchasers';
import type { CatalogEntry, CatalogResponse, PaymentRequired } from './types';

const OWNER = '0x8aa327403ED786cA56EB8F59C6c8831A8BD73485';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function catalog(entry: CatalogEntry): CatalogResponse {
  return {
    owner: { wallet: OWNER, name: 'Curatoria' },
    total: 1,
    base_url: 'https://curatoria.dev',
    design_systems: [entry],
  };
}

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'curatoria-demo-md',
    resource_type: 'design_md',
    mime_type: 'text/markdown',
    name: 'Demo Markdown',
    description: 'Paid markdown.',
    price_usd: '0.01',
    tags: ['demo'],
    published_at: '2026-01-01T00:00:00.000Z',
    active: true,
    access_url: 'https://curatoria.dev/design-systems/curatoria-demo-md',
    payment_required: true,
    ...overrides,
  };
}

function paymentRequired(overrides: Partial<PaymentRequired> = {}): PaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url: 'https://curatoria.dev/design-systems/curatoria-demo-md',
      mimeType: 'text/markdown',
    },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '10000',
        payTo: OWNER,
        maxTimeoutSeconds: 300,
        asset: BASE_USDC,
        extra: {
          assetTransferMethod: 'eip3009',
          name: 'USD Coin',
          version: '2',
        },
      },
    ],
    error: 'payment required',
    ...overrides,
  };
}

test('sourceProvider labels generic executables as an external wallet bridge', () => {
  assert.equal(
    sourceProvider({ productId: 'layout', walletMode: 'external' }),
    'external-wallet-bridge',
  );
  assert.notEqual(
    sourceProvider({ productId: 'layout', walletMode: 'external' }),
    'coinbase-payments-mcp',
  );
  assert.equal(sourceProvider({ productId: 'layout', walletMode: 'awal' }), 'awal');
  assert.equal(
    sourceProvider({ productId: 'layout', walletMode: 'private-key' }),
    'x402-private-key',
  );
});

test('priceUsdToAtomic parses demo-cent prices exactly', () => {
  assert.equal(priceUsdToAtomic('0.01'), 10000);
  assert.equal(priceUsdToAtomic('1'), 1000000);
  assert.equal(priceUsdToAtomic('0.000001'), 1);
  assert.throws(() => priceUsdToAtomic('0.0000001'), /Invalid USD price/);
});

test('parseEntitlementContinuation accepts bounded JSON without exposing invalid input', () => {
  const valid = {
    receipt_id: `rcpt_${'r'.repeat(43)}`,
    product_id: 'layout',
    source_provider: 'gdrive',
    network: 'eip155:8453',
    payer: '0x1111111111111111111111111111111111111111',
    transaction: `0x${'a'.repeat(64)}`,
    entitlement: 'sensitive-entitlement',
    redeem_url: 'https://curatoria.dev/assets/layout/redeem',
    expires_at: '2099-01-01T00:00:00.000Z',
    filename: 'layout.psd',
    mime_type: 'image/vnd.adobe.photoshop',
    content_sha256: 'a'.repeat(64),
    content_bytes: 8,
  };
  assert.equal(
    parseEntitlementContinuation(JSON.stringify(valid)).receipt_id,
    `rcpt_${'r'.repeat(43)}`,
  );
  assert.throws(
    () =>
      parseEntitlementContinuation(
        Buffer.alloc(MAX_ENTITLEMENT_STDIN_BYTES + 1),
      ),
    /exceeds/,
  );
  assert.throws(
    () => parseEntitlementContinuation('secret-entitlement-not-json'),
    (error: unknown) =>
      error instanceof Error &&
      !error.message.includes('secret-entitlement-not-json') &&
      /valid JSON object/.test(error.message),
  );
});

test('validateSpend enforces amount, payTo, resource, network, asset, and max spend boundaries', () => {
  const product = entry();
  const ok = validateSpend({
    catalog: catalog(product),
    entry: product,
    resourceUrl: product.access_url,
    paymentRequired: paymentRequired(),
  });
  assert.equal(ok.ok, true);

  const bad = validateSpend({
    catalog: catalog(product),
    entry: product,
    resourceUrl: product.access_url,
    maxAmountAtomic: 9999,
    allowedNetworks: ['eip155:84532'],
    allowedAssets: ['0x0000000000000000000000000000000000000000'],
    paymentRequired: paymentRequired({
      resource: { url: 'https://evil.example/design-systems/curatoria-demo-md' },
      accepts: [
        {
          ...paymentRequired().accepts[0],
          amount: '30000',
          payTo: '0x000000000000000000000000000000000000dEaD',
          network: 'eip155:1',
          asset: '0x0000000000000000000000000000000000000001',
        },
      ],
    }),
  });

  assert.equal(bad.ok, false);
  assert.equal(bad.failures.some((failure) => failure.includes('payTo mismatch')), true);
  assert.equal(bad.failures.some((failure) => failure.includes('resource mismatch')), true);
  assert.equal(bad.failures.some((failure) => failure.includes('amount mismatch')), true);
  assert.equal(bad.failures.some((failure) => failure.includes('exceeds max')), true);
  assert.equal(bad.failures.some((failure) => failure.includes('network')), true);
  assert.equal(bad.failures.some((failure) => failure.includes('asset')), true);
});

test('validateSpend rejects a non-exact scheme even when amount, payee, network, and asset match', () => {
  const product = entry();
  const result = validateSpend({
    catalog: catalog(product),
    entry: product,
    resourceUrl: product.access_url,
    paymentRequired: paymentRequired({
      accepts: [{ ...paymentRequired().accepts[0], scheme: 'upto' }],
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures.some(failure => failure.includes('scheme mismatch')), true);
});

test('validateSpend rejects long-lived payment challenges', () => {
  const product = entry();
  const result = validateSpend({
    catalog: catalog(product),
    entry: product,
    resourceUrl: product.access_url,
    paymentRequired: paymentRequired({
      accepts: [
        {
          ...paymentRequired().accepts[0],
          maxTimeoutSeconds: 900,
        },
      ],
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures.some((failure) => failure.includes('timeout')), true);
});

test('validateSpend binds binary purchase challenges to JSON response MIME', () => {
  const product = entry({
    id: 'layout',
    resource_type: 'binary_asset',
    mime_type: 'image/vnd.adobe.photoshop',
    access_url: 'https://curatoria.dev/assets/layout/purchase',
  });
  const result = validateSpend({
    catalog: catalog(product),
    entry: product,
    resourceUrl: product.access_url,
    paymentRequired: paymentRequired({
      resource: {
        url: product.access_url,
        mimeType: 'image/vnd.adobe.photoshop',
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures.some(failure => failure.includes('application/json')), true);
});

test('validateSpend returns structured failure when challenge has no accepts', () => {
  const product = entry();
  const result = validateSpend({
    catalog: catalog(product),
    entry: product,
    resourceUrl: product.access_url,
    paymentRequired: paymentRequired({ accepts: [] }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.priceAtomic, 10000);
  assert.equal(result.failures.some((failure) => failure.includes('accepted payment requirement')), true);
});

test('resolveOutputPath defaults to Downloads and treats explicit files as overrides', () => {
  assert.equal(
    resolveOutputPath(undefined, '../unsafe.psd', '/tmp/curatoria-home'),
    '/tmp/curatoria-home/Downloads/unsafe.psd',
  );
  assert.equal(
    resolveOutputPath('/tmp/asset-dir/', 'demo.md', '/tmp/curatoria-home'),
    '/tmp/asset-dir/demo.md',
  );
  assert.equal(
    resolveOutputPath('/tmp/exact-name.bin', 'demo.md', '/tmp/curatoria-home'),
    '/tmp/exact-name.bin',
  );
  assert.equal(
    resolveOutputPath('~/Downloads', 'demo.md', '/tmp/curatoria-home'),
    '/tmp/curatoria-home/Downloads/demo.md',
  );
});

test('parseContentDispositionFilename prefers RFC 5987 filenames', () => {
  const header = 'attachment; filename="fallback.bin"; filename*=UTF-8\'\'Design%20System.psd';
  assert.equal(parseContentDispositionFilename(header), 'Design System.psd');
});

test('validateDownloadedBytes treats PSD as opaque bytes with optional 8BPS signature check', () => {
  const psd = Buffer.from('8BPS opaque photoshop bytes', 'latin1');
  const valid = validateDownloadedBytes(psd, {
    filename: 'layout.psd',
    mimeType: 'application/octet-stream',
  });
  assert.deepEqual(valid, { ok: true, kind: 'psd', detail: 'PSD 8BPS signature ok' });

  const invalid = validateDownloadedBytes(Buffer.from('nope'), {
    filename: 'layout.psd',
    mimeType: 'application/octet-stream',
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.detail, 'missing PSD 8BPS signature');
});

test('downloadCuratoriaAsset signs after validation, retries once, and saves paid bytes directly', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-download-'));
  const product = entry({
    id: 'binary-psd',
    price_usd: '0.01',
    mime_type: 'image/vnd.adobe.photoshop',
    access_url: 'https://curatoria.dev/design-systems/binary-psd',
  });
  const challenge = paymentRequired({
    resource: { url: product.access_url, mimeType: 'image/vnd.adobe.photoshop' },
  });
  challenge.accepts[0].amount = '10000';
  const binary = Buffer.from([0x38, 0x42, 0x50, 0x53, 0x00, 0xff, 0x10, 0x80]);
  const paidHeaders: string[] = [];
  let signerCalls = 0;
  const paymentSigner: PaymentSignerAdapter = {
    async createFreshPayment(paymentRequiredChallenge) {
      signerCalls += 1;
      assert.equal(paymentRequiredChallenge.resource?.url, product.access_url);
      assert.equal(paymentRequiredChallenge.accepts[0].amount, '10000');
      return {
        headers: { 'PAYMENT-SIGNATURE': `fresh-payment-${signerCalls}` },
        payer: '0x1111111111111111111111111111111111111111',
      };
    },
  };

  const fetchImpl: typeof fetch = async (url, init) => {
    const target = String(url);
    if (target.endsWith('/.well-known/design-catalog.json')) {
      return Response.json(catalog(product));
    }
    if (!init?.headers || !(init.headers as Record<string, string>)['PAYMENT-SIGNATURE']) {
      return new Response('', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge as never) },
      });
    }
    paidHeaders.push((init.headers as Record<string, string>)['PAYMENT-SIGNATURE']);
    return new Response(binary, {
      status: 200,
      headers: {
        'Content-Type': 'image/vnd.adobe.photoshop',
        'Content-Length': String(binary.byteLength),
        'Content-Disposition': 'attachment; filename="layout.psd"',
      },
    });
  };

  const result = await downloadCuratoriaAsset({
    catalogUrl: 'https://curatoria.dev/.well-known/design-catalog.json',
    productId: 'binary-psd',
    out: tmp,
    stateDirectory: path.join(tmp, 'state'),
    yes: true,
    paymentSigner,
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(signerCalls, 1);
  assert.deepEqual(paidHeaders, ['fresh-payment-1']);
  if (!result.ok) return;
  assert.equal(result.filename, 'layout.psd');
  assert.equal(result.bytes, binary.byteLength);
  assert.equal(result.validation.kind, 'psd');
  assert.deepEqual(await fs.readFile(result.saved_path), binary);
  assert.equal(JSON.stringify(result).includes('fresh-payment-1'), false);
  assert.ok(result.receipt_path);
  const receiptText = await fs.readFile(result.receipt_path, 'utf8');
  const receipt = JSON.parse(receiptText);
  assert.equal(receipt.source_provider, 'x402-signer-adapter');
  assert.match(receipt.receipt_id, /^[0-9a-f-]{36}$/);
  assert.equal(receipt.payer, '0x1111111111111111111111111111111111111111');
  assert.equal(receipt.durability.receipt_file, 'synced');
  assert.equal(receiptText.includes('fresh-payment-1'), false);
  assert.equal(receiptText.includes('PAYMENT-SIGNATURE'), false);
});

test('downloadCuratoriaAsset creates a fresh payment header per approved request', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-download-fresh-'));
  const product = entry();
  const challenge = paymentRequired();
  const paidHeaders: string[] = [];
  let signerCalls = 0;
  const paymentSigner: PaymentSignerAdapter = {
    async createFreshPayment() {
      signerCalls += 1;
      return {
        headers: { 'PAYMENT-SIGNATURE': `fresh-${signerCalls}` },
      };
    },
  };
  const fetchImpl: typeof fetch = async (url, init) => {
    const target = String(url);
    if (target.endsWith('/.well-known/design-catalog.json')) {
      return Response.json(catalog(product));
    }
    const signature = init?.headers ? (init.headers as Record<string, string>)['PAYMENT-SIGNATURE'] : undefined;
    if (!signature) {
      return new Response('', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge as never) },
      });
    }
    paidHeaders.push(signature);
    return new Response('# paid markdown\n', {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown',
        'Content-Length': '16',
        'Content-Disposition': 'attachment; filename="demo.md"',
      },
    });
  };

  for (let index = 0; index < 2; index += 1) {
    const result = await downloadCuratoriaAsset({
      catalogUrl: 'https://curatoria.dev/.well-known/design-catalog.json',
      productId: product.id,
      out: tmp,
      stateDirectory: path.join(tmp, 'state'),
      collisionPolicy: 'number',
      yes: true,
      paymentSigner,
      fetchImpl,
    });
    assert.equal(result.ok, true);
  }

  assert.deepEqual(paidHeaders, ['fresh-1', 'fresh-2']);
});

test('downloadCuratoriaAsset rejects prebuilt payment headers instead of reusing them', async () => {
  const product = entry();
  const challenge = paymentRequired();
  const result = await downloadCuratoriaAsset({
    catalogUrl: 'https://curatoria.dev/.well-known/design-catalog.json',
    productId: product.id,
    yes: true,
    paymentHeader: 'durable-header',
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.endsWith('/.well-known/design-catalog.json')) {
        return Response.json(catalog(product));
      }
      return new Response('', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge as never) },
      });
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.stage, 'payment');
  assert.equal(result.code, 'prebuilt_payment_header_unsupported');
});

test('downloadCuratoriaAsset does not sign before exact spend and resource validation pass', async () => {
  const product = entry();
  const challenge = paymentRequired({
    resource: { url: 'https://curatoria.dev/design-systems/other-resource' },
  });
  let signerCalls = 0;
  const paymentSigner: PaymentSignerAdapter = {
    async createFreshPayment() {
      signerCalls += 1;
      return { headers: { 'PAYMENT-SIGNATURE': 'should-not-be-created' } };
    },
  };
  const result = await downloadCuratoriaAsset({
    catalogUrl: 'https://curatoria.dev/.well-known/design-catalog.json',
    productId: product.id,
    yes: true,
    paymentSigner,
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.endsWith('/.well-known/design-catalog.json')) {
        return Response.json(catalog(product));
      }
      return new Response('', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge as never) },
      });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(signerCalls, 0);
  if (result.ok) return;
  assert.equal(result.stage, 'spend_validation');
  assert.match(result.message, /resource mismatch/);
});

test('downloadCuratoriaAsset rejects http catalog URLs for allowlisted non-local domains', async () => {
  const result = await downloadCuratoriaAsset({
    catalogUrl: 'http://curatoria.dev/.well-known/design-catalog.json',
    productId: 'curatoria-demo-md',
    fetchImpl: async () => {
      throw new Error('catalog fetch should not be attempted');
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.stage, 'catalog');
  assert.equal(result.code, 'catalog_domain_not_allowed');
  assert.match(result.message, /https/);
});

test('downloadCuratoriaAsset rejects http resource URLs for allowlisted non-local domains', async () => {
  const product = entry({ access_url: 'http://curatoria.dev/design-systems/curatoria-demo-md' });
  const result = await downloadCuratoriaAsset({
    catalogUrl: 'https://curatoria.dev/.well-known/design-catalog.json',
    productId: product.id,
    fetchImpl: async () => Response.json(catalog(product)),
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.stage, 'spend_validation');
  assert.equal(result.code, 'resource_domain_not_allowed');
  assert.match(result.message, /https/);
});

test('downloadCuratoriaAsset reports missing accepts as structured spend validation failure', async () => {
  const product = entry();
  const challenge = paymentRequired({ accepts: [] });
  const result = await downloadCuratoriaAsset({
    catalogUrl: 'https://curatoria.dev/.well-known/design-catalog.json',
    productId: product.id,
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.endsWith('/.well-known/design-catalog.json')) {
        return Response.json(catalog(product));
      }
      return new Response('', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge as never) },
      });
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.stage, 'spend_validation');
  assert.equal(result.code, 'spend_validation_failed');
  assert.deepEqual(result.details?.failures, ['payment challenge did not include an accepted payment requirement']);
});

test('makeFailure returns machine-readable recovery objects', () => {
  const result = makeFailure(
    'paid_fetch',
    'paid_but_delivery_failed',
    'Payment settled but the file was not delivered.',
    'Keep the receipt and contact support; do not retry payment silently.',
    { transaction: '0xabc' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'paid_fetch');
  assert.equal(result.details?.transaction, '0xabc');
  assert.match(result.next_step, /do not retry payment silently/i);
});

test('downloadCuratoriaAsset lets a wallet buy JSON while Curatoria saves exact PSD bytes', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-entitled-'));
  const binary = Buffer.from([0x38, 0x42, 0x50, 0x53, 0x00, 0xff, 0x10, 0x80]);
  const digest = crypto.createHash('sha256').update(binary).digest('hex');
  const product = entry({
    id: 'binary-psd',
    resource_type: 'binary_asset',
    price_usd: '0.01',
    mime_type: 'image/vnd.adobe.photoshop',
    access_url: 'https://curatoria.dev/assets/binary-psd/purchase',
    download_filename: 'layout.psd',
    content_sha256: digest,
    content_bytes: binary.byteLength,
    integrity_status: 'verified',
    delivery_mode: 'entitlement',
  });
  const challenge = paymentRequired({
    resource: { url: product.access_url, mimeType: 'application/json' },
  });
  const purchaserCalls: string[] = [];
  const entitlementPurchaser: EntitlementPurchaserAdapter = {
    async purchase(input) {
      purchaserCalls.push(input.url);
      return {
        receipt_id: `rcpt_${'r'.repeat(43)}`,
        source_provider: 'local',
        network: 'eip155:8453',
        payer: '0x1111111111111111111111111111111111111111',
        transaction: `0x${'a'.repeat(64)}`,
        product_id: product.id,
        entitlement: 'sensitive-entitlement',
        redeem_url: `/assets/${product.id}/redeem`,
        expires_at: '2026-08-29T13:00:00.000Z',
        filename: 'layout.psd',
        mime_type: 'image/vnd.adobe.photoshop',
        content_sha256: digest,
        content_bytes: binary.byteLength,
      };
    },
  };
  const requests: Array<{ url: string; authorization?: string }> = [];
  const collidingReceipt = path.join(tmp, 'layout.psd.receipt.json');
  await fs.writeFile(collidingReceipt, 'existing receipt');
  const fetchImpl: typeof fetch = async (url, init) => {
    const target = String(url);
    requests.push({
      url: target,
      authorization: init?.headers
        ? new Headers(init.headers).get('authorization') ?? undefined
        : undefined,
    });
    if (target.endsWith('/.well-known/design-catalog.json')) {
      return Response.json(catalog(product));
    }
    if (target === product.access_url) {
      return new Response('', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge as never) },
      });
    }
    if (target.endsWith(`/assets/${product.id}/redeem`)) {
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        'Bearer sensitive-entitlement',
      );
      return Response.json({
        product_id: product.id,
        download_url:
          'https://store.private.blob.vercel-storage.com/layout.psd?signature=sensitive',
        expires_at: '2026-08-29T13:00:00.000Z',
        filename: 'layout.psd',
        mime_type: 'image/vnd.adobe.photoshop',
        content_sha256: digest,
        content_bytes: binary.byteLength,
      });
    }
    if (target.includes('blob.vercel-storage.com')) {
      return new Response(binary, {
        status: 200,
        headers: {
          'Content-Type': 'image/vnd.adobe.photoshop',
          'Content-Length': String(binary.byteLength),
        },
      });
    }
    throw new Error(`Unexpected URL: ${target}`);
  };

  const result = await downloadCuratoriaAsset({
    catalogUrl: 'https://curatoria.dev/.well-known/design-catalog.json',
    productId: product.id,
    out: tmp,
    stateDirectory: path.join(tmp, 'state'),
    yes: true,
    entitlementPurchaser,
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(purchaserCalls, [product.access_url]);
  if (!result.ok) return;
  assert.equal(result.delivered_via, 'entitlement');
  assert.equal(result.filename, 'layout.psd');
  assert.equal(result.sha256, digest);
  assert.deepEqual(await fs.readFile(result.saved_path), binary);
  assert.equal(result.receipt_path, undefined);
  assert.match(result.receipt_error ?? '', /saved and verified.*receipt creation failed/i);
  assert.equal(await fs.readFile(collidingReceipt, 'utf8'), 'existing receipt');
  assert.equal(JSON.stringify(result).includes('sensitive-entitlement'), false);
  assert.equal(JSON.stringify(result).includes('signature=sensitive'), false);
  assert.equal(
    requests.some(request => request.authorization === 'Bearer sensitive-entitlement'),
    true,
  );
});

test('destination capacity failure occurs before wallet invocation', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-before-wallet-'));
  const binary = Buffer.from('8BPSdata', 'latin1');
  const product = entry({
    id: 'binary-psd',
    resource_type: 'binary_asset',
    mime_type: 'image/vnd.adobe.photoshop',
    access_url: 'https://curatoria.dev/assets/binary-psd/purchase',
    download_filename: 'layout.psd',
    content_sha256: crypto.createHash('sha256').update(binary).digest('hex'),
    content_bytes: binary.byteLength,
  });
  const challenge = paymentRequired({
    resource: { url: product.access_url, mimeType: 'application/json' },
  });
  let walletCalls = 0;
  const result = await downloadCuratoriaAsset({
    catalogUrl: 'https://curatoria.dev/.well-known/design-catalog.json',
    productId: product.id,
    out: tmp,
    stateDirectory: path.join(tmp, 'state'),
    yes: true,
    entitlementPurchaser: {
      async purchase() {
        walletCalls += 1;
        throw new Error('wallet must not run');
      },
    },
    statfs: async () => ({
      bavail: 1n,
      bsize: 1n,
      blocks: BigInt(1024 ** 3),
    }),
    fetchImpl: async (url) => {
      if (String(url).endsWith('/.well-known/design-catalog.json')) {
        return Response.json(catalog(product));
      }
      return new Response('', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge as never) },
      });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(walletCalls, 0);
  if (result.ok) return;
  assert.equal(result.code, 'destination_preflight_failed');
  assert.match(result.message, /requires \d+ bytes/);

  const stateDirectory = path.join(tmp, 'state-capacity-failure');
  const stateResult = await downloadCuratoriaAsset({
    catalogUrl: 'https://curatoria.dev/.well-known/design-catalog.json',
    productId: product.id,
    out: path.join(tmp, 'second-output'),
    stateDirectory,
    yes: true,
    entitlementPurchaser: {
      async purchase() {
        walletCalls += 1;
        throw new Error('wallet must not run');
      },
    },
    statfs: async target => {
      if (target === stateDirectory) throw new Error('state capacity unavailable');
      return {
        bavail: 2n * 1024n ** 3n,
        bsize: 1n,
        blocks: 10n * 1024n ** 3n,
      };
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith('/.well-known/design-catalog.json')) {
        return Response.json(catalog(product));
      }
      return new Response('', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge as never) },
      });
    },
  });
  assert.equal(stateResult.ok, false);
  assert.equal(walletCalls, 0);
  if (!stateResult.ok) {
    assert.equal(stateResult.code, 'destination_preflight_failed');
    assert.match(stateResult.message, /state\/cache capacity/);
  }
});

test('missing noninteractive output fails structurally before wallet invocation', async () => {
  const product = entry({
    id: 'binary-psd',
    resource_type: 'binary_asset',
    mime_type: 'image/vnd.adobe.photoshop',
    access_url: 'https://curatoria.dev/assets/binary-psd/purchase',
    download_filename: 'layout.psd',
    content_sha256: 'a'.repeat(64),
    content_bytes: 8,
  });
  const challenge = paymentRequired({
    resource: { url: product.access_url, mimeType: 'application/json' },
  });
  let walletCalls = 0;
  const result = await downloadCuratoriaAsset({
    catalogUrl: 'https://curatoria.dev/.well-known/design-catalog.json',
    productId: product.id,
    yes: true,
    isTTY: false,
    entitlementPurchaser: {
      async purchase() {
        walletCalls += 1;
        throw new Error('wallet must not run');
      },
    },
    statfs: async () => ({
      bavail: 2n * 1024n ** 3n,
      bsize: 1n,
      blocks: 10n * 1024n ** 3n,
    }),
    fetchImpl: async (url) => {
      if (String(url).endsWith('/.well-known/design-catalog.json')) {
        return Response.json(catalog(product));
      }
      return new Response('', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge as never) },
      });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(walletCalls, 0);
  if (result.ok) return;
  assert.equal(result.stage, 'save');
  assert.equal(result.code, 'destination_preflight_failed');
  assert.match(result.message, /Pass --out/);
});

function binaryProduct(bytes: Buffer, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return entry({
    id: 'binary-psd',
    resource_type: 'binary_asset',
    mime_type: 'image/vnd.adobe.photoshop',
    access_url: 'https://curatoria.dev/assets/binary-psd/purchase',
    download_filename: 'layout.psd',
    content_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    content_bytes: bytes.byteLength,
    ...overrides,
  });
}

function binaryChallenge(product: CatalogEntry): PaymentRequired {
  return paymentRequired({
    resource: { url: product.access_url, mimeType: 'application/json' },
  });
}

function catalogFetch(
  product: CatalogEntry,
  challenge: PaymentRequired,
  extras: Record<string, (url: string, init?: RequestInit) => Promise<Response> | Response> = {},
): typeof fetch {
  return async (url, init) => {
    const target = String(url);
    if (target.endsWith('/.well-known/design-catalog.json')) {
      return Response.json(catalog(product));
    }
    if (target === product.access_url) {
      return new Response('', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge as never) },
      });
    }
    for (const [suffix, handler] of Object.entries(extras)) {
      if (target.includes(suffix) || target.endsWith(suffix)) {
        return handler(target, init);
      }
    }
    throw new Error(`Unexpected URL: ${target}`);
  };
}

function purchaseFor(product: CatalogEntry, bytes: Buffer) {
  return {
    receipt_id: `rcpt_${'r'.repeat(43)}`,
    product_id: product.id,
    source_provider: 'gdrive' as const,
    network: 'eip155:8453',
    payer: '0x1111111111111111111111111111111111111111',
    transaction: `0x${'a'.repeat(64)}`,
    entitlement: 'sensitive-entitlement',
    redeem_url: `/assets/${product.id}/redeem`,
    expires_at: '2099-01-01T00:00:00.000Z',
    filename: product.download_filename ?? 'layout.psd',
    mime_type: 'image/vnd.adobe.photoshop',
    content_sha256: product.content_sha256 ?? crypto.createHash('sha256').update(bytes).digest('hex'),
    content_bytes: bytes.byteLength,
  };
}

test('fifth one-cent reservation fails before wallet after four pending attempts', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-budget-fifth-'));
  const budget = await SpendBudget.open(path.join(tmp, 'budget.json'));
  const bytes = Buffer.from('8BPSdata', 'latin1');
  const product = binaryProduct(bytes);
  const challenge = binaryChallenge(product);
  for (let index = 1; index <= 4; index += 1) {
    await budget.reserve(
      `attempt-000${index}`,
      10000,
      crypto.createHash('sha256').update(`other-${index}`).digest('hex'),
    );
  }
  let walletCalls = 0;
  const result = await downloadCuratoriaAsset({
    catalogUrl: 'https://curatoria.dev/.well-known/design-catalog.json',
    productId: product.id,
    out: tmp,
    stateDirectory: path.join(tmp, 'state'),
    yes: true,
    spendBudget: budget,
    spendAttemptId: 'attempt-0005',
    entitlementPurchaser: {
      async purchase() {
        walletCalls += 1;
        throw new Error('wallet must not run');
      },
    },
    fetchImpl: catalogFetch(product, challenge),
  });
  assert.equal(walletCalls, 0);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'session_budget_exhausted');
  assert.equal(await budget.remaining(), 0);
});

test('wallet timeout marks inconclusive spend and proven pre-settlement failure releases', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-budget-release-'));
  const budget = await SpendBudget.open(path.join(tmp, 'budget.json'));
  const bytes = Buffer.from('8BPSdata', 'latin1');
  const product = binaryProduct(bytes);
  const challenge = binaryChallenge(product);
  const inconclusive = await downloadCuratoriaAsset({
    catalogUrl: 'https://curatoria.dev/.well-known/design-catalog.json',
    productId: product.id,
    out: tmp,
    stateDirectory: path.join(tmp, 'state-inconcl'),
    yes: true,
    collisionPolicy: 'number',
    spendBudget: budget,
    spendAttemptId: 'attempt-inconcl',
    entitlementPurchaser: {
      async purchase() {
        throw new Error('Wallet approval timed out after 5 minutes.');
      },
    },
    fetchImpl: catalogFetch(product, challenge),
  });
  assert.equal(inconclusive.ok, false);
  assert.equal(await budget.remaining(), 30000);

  const proven = await downloadCuratoriaAsset({
    catalogUrl: 'https://curatoria.dev/.well-known/design-catalog.json',
    productId: product.id,
    out: path.join(tmp, 'third'),
    stateDirectory: path.join(tmp, 'state-proven'),
    yes: true,
    spendBudget: budget,
    spendAttemptId: 'attempt-proven',
    entitlementPurchaser: {
      async purchase() {
        throw new WalletPurchasePreflightError('Payment challenge exceeds the approved wallet maximum.');
      },
    },
    fetchImpl: catalogFetch(product, challenge),
  });
  assert.equal(proven.ok, false);
  assert.equal(await budget.remaining(), 30000);
});

test('successful entitlement purchase commits once and a duplicate attempt cannot double-commit', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-budget-commit-'));
  const budget = await SpendBudget.open(path.join(tmp, 'budget.json'));
  const bytes = Buffer.from('8BPSdata', 'latin1');
  const product = binaryProduct(bytes);
  const challenge = binaryChallenge(product);
  const purchase = purchaseFor(product, bytes);
  let walletCalls = 0;
  const fetchImpl = catalogFetch(product, challenge, {
    redeem: async () =>
      Response.json({
        product_id: product.id,
        download_url:
          'https://store.private.blob.vercel-storage.com/layout.psd?signature=secret',
        expires_at: '2099-01-01T00:00:00.000Z',
        filename: 'layout.psd',
        mime_type: 'image/vnd.adobe.photoshop',
        content_sha256: product.content_sha256,
        content_bytes: bytes.byteLength,
      }),
    'blob.vercel-storage.com': async () =>
      new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': 'image/vnd.adobe.photoshop',
          'Content-Length': String(bytes.byteLength),
        },
      }),
  });
  const result = await downloadCuratoriaAsset({
    catalogUrl: 'https://curatoria.dev/.well-known/design-catalog.json',
    productId: product.id,
    out: tmp,
    stateDirectory: path.join(tmp, 'state'),
    yes: true,
    spendBudget: budget,
    spendAttemptId: 'attempt-commit',
    walletMode: 'external',
    entitlementPurchaser: {
      async purchase() {
        walletCalls += 1;
        return purchase;
      },
    },
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(walletCalls, 1);
  assert.equal(await budget.remaining(), 30000);
  if (result.ok) {
    assert.ok(result.receipt_path);
    const receipt = JSON.parse(await fs.readFile(result.receipt_path, 'utf8'));
    assert.equal(receipt.source_provider, 'gdrive');
  }
  await budget.commit('attempt-commit', { receipt_id: purchase.receipt_id });
  assert.equal(await budget.remaining(), 30000);
});

test('awal purchaser is reserved before the isolated process spawns', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-awal-reserve-'));
  const budget = await SpendBudget.open(path.join(tmp, 'budget.json'));
  const bytes = Buffer.from('8BPSdata', 'latin1');
  const product = binaryProduct(bytes);
  const challenge = binaryChallenge(product);
  const purchase = purchaseFor(product, bytes);
  let remainingAtSpawn: number | undefined;
  const purchaser = createAwalEntitlementPurchaser(
    '/opt/awal/bin/awal',
    async () => {
      remainingAtSpawn = await budget.remaining();
      return {
        stdout: JSON.stringify(purchase),
        stderr: '',
        exitCode: 0,
      };
    },
    async () => {
      throw new Error('frozen relay must not refetch the original resource in this test');
    },
  );
  const result = await downloadCuratoriaAsset({
    catalogUrl: 'https://curatoria.dev/.well-known/design-catalog.json',
    productId: product.id,
    out: tmp,
    stateDirectory: path.join(tmp, 'state'),
    yes: true,
    spendBudget: budget,
    spendAttemptId: 'attempt-awal',
    entitlementPurchaser: purchaser,
    fetchImpl: catalogFetch(product, challenge, {
      redeem: async () =>
        Response.json({
          product_id: product.id,
          download_url:
            'https://store.private.blob.vercel-storage.com/layout.psd?signature=secret',
          expires_at: '2099-01-01T00:00:00.000Z',
          filename: 'layout.psd',
          mime_type: 'image/vnd.adobe.photoshop',
          content_sha256: product.content_sha256,
          content_bytes: bytes.byteLength,
        }),
      'blob.vercel-storage.com': async () =>
        new Response(bytes, {
          status: 200,
          headers: {
            'Content-Type': 'image/vnd.adobe.photoshop',
            'Content-Length': String(bytes.byteLength),
          },
        }),
    }),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(remainingAtSpawn, 30000);
  assert.equal(await budget.remaining(), 30000);
});

test('missing destination never reserves budget or invokes a wallet', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-no-dest-'));
  const budget = await SpendBudget.open(path.join(tmp, 'budget.json'));
  const bytes = Buffer.from('8BPSdata', 'latin1');
  const product = binaryProduct(bytes);
  const challenge = binaryChallenge(product);
  let walletCalls = 0;
  const result = await downloadCuratoriaAsset({
    catalogUrl: 'https://curatoria.dev/.well-known/design-catalog.json',
    productId: product.id,
    yes: true,
    isTTY: false,
    spendBudget: budget,
    spendAttemptId: 'attempt-nodest',
    entitlementPurchaser: {
      async purchase() {
        walletCalls += 1;
        throw new Error('wallet must not run');
      },
    },
    fetchImpl: catalogFetch(product, challenge),
  });
  assert.equal(result.ok, false);
  assert.equal(walletCalls, 0);
  if (!result.ok) assert.equal(result.code, 'destination_preflight_failed');
  assert.equal(await budget.remaining(), 40000);
});

test('challenge mismatch fails without budget reservation or redemption', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-mismatch-'));
  const budget = await SpendBudget.open(path.join(tmp, 'budget.json'));
  const bytes = Buffer.from('8BPSdata', 'latin1');
  const product = binaryProduct(bytes);
  const challenge = binaryChallenge(product);
  challenge.accepts[0].amount = '20000';
  let redeemCalls = 0;
  let walletCalls = 0;
  const result = await downloadCuratoriaAsset({
    catalogUrl: 'https://curatoria.dev/.well-known/design-catalog.json',
    productId: product.id,
    out: tmp,
    stateDirectory: path.join(tmp, 'state'),
    yes: true,
    spendBudget: budget,
    spendAttemptId: 'attempt-mismatch',
    entitlementPurchaser: {
      async purchase() {
        walletCalls += 1;
        throw new Error('wallet must not run');
      },
    },
    fetchImpl: catalogFetch(product, challenge, {
      redeem: async () => {
        redeemCalls += 1;
        throw new Error('must not redeem');
      },
    }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'spend_validation_failed');
  assert.equal(walletCalls, 0);
  assert.equal(redeemCalls, 0);
  assert.equal(await budget.remaining(), 40000);
});

test('entitlement continuation and resume never consume session budget', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-resume-budget-'));
  const budget = await SpendBudget.open(path.join(tmp, 'budget.json'));
  const bytes = Buffer.from('8BPScont', 'latin1');
  const product = binaryProduct(bytes);
  const challenge = binaryChallenge(product);
  const purchase = purchaseFor(product, bytes);
  let walletCalls = 0;
  const continued = await continueCuratoriaEntitlement(
    {
      catalogUrl: 'https://curatoria.dev/.well-known/design-catalog.json',
      productId: product.id,
      out: tmp,
      stateDirectory: path.join(tmp, 'state'),
      yes: true,
      collisionPolicy: 'number',
      spendBudget: budget,
      spendAttemptId: 'attempt-continue',
      entitlementPurchaser: {
        async purchase() {
          walletCalls += 1;
          throw new Error('wallet must not run');
        },
      },
      fetchImpl: catalogFetch(product, challenge, {
        redeem: async () =>
          Response.json({
            product_id: product.id,
            download_url:
              'https://store.private.blob.vercel-storage.com/layout.psd?signature=secret',
            expires_at: '2099-01-01T00:00:00.000Z',
            filename: 'layout.psd',
            mime_type: 'image/vnd.adobe.photoshop',
            content_sha256: product.content_sha256,
            content_bytes: bytes.byteLength,
          }),
        'blob.vercel-storage.com': async () =>
          new Response(bytes, {
            status: 200,
            headers: {
              'Content-Type': 'image/vnd.adobe.photoshop',
              'Content-Length': String(bytes.byteLength),
            },
          }),
      }),
    },
    purchase,
  );
  assert.equal(continued.ok, true, JSON.stringify(continued));
  assert.equal(walletCalls, 0);
  assert.equal(await budget.remaining(), 40000);

  const stateDirectory = path.join(tmp, 'resume-state');
  await fs.mkdir(stateDirectory, { mode: 0o700 });
  const statePath = path.join(stateDirectory, 'resume.json');
  const tempPath = path.join(stateDirectory, 'resume.part');
  const finalPath = path.join(tmp, 'resumed.psd');
  await fs.writeFile(tempPath, '', { mode: 0o600 });
  await writePrivateResumeState(statePath, {
    version: 1,
    product_id: product.id,
    temp_path: tempPath,
    final_path: finalPath,
    bytes_written: 0,
    content_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    content_bytes: bytes.byteLength,
    download_url:
      'https://store.private.blob.vercel-storage.com/resumed.psd?signature=secret',
    download_expires_at: '2099-01-01T00:00:00.000Z',
    entitlement: 'secret-entitlement',
    source_provider: 'local',
    receipt_id: `rcpt_${'s'.repeat(43)}`,
    network: 'eip155:8453',
    payer: `0x${'1'.repeat(40)}`,
    transaction: `0x${'b'.repeat(64)}`,
  });
  const resumed = await resumeCuratoriaDownload(statePath, async () => {
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'image/vnd.adobe.photoshop',
        'Content-Length': String(bytes.byteLength),
      },
    });
  });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(await budget.remaining(), 40000);
});

test('prepare-external-payment writes a 0600 context and reserves without a wallet', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-prepare-'));
  const budget = await SpendBudget.open(path.join(tmp, 'budget.json'));
  const contextPath = path.join(tmp, 'purchase-context.json');
  const bytes = Buffer.from('8BPSdata', 'latin1');
  const product = binaryProduct(bytes);
  const challenge = binaryChallenge(product);
  let walletCalls = 0;
  const result = await downloadCuratoriaAsset({
    catalogUrl: 'https://curatoria.dev/.well-known/design-catalog.json',
    productId: product.id,
    out: tmp,
    stateDirectory: path.join(tmp, 'state'),
    yes: true,
    spendBudget: budget,
    spendAttemptId: 'attempt-prepare',
    prepareExternalPayment: true,
    purchaseContextPath: contextPath,
    entitlementPurchaser: {
      async purchase() {
        walletCalls += 1;
        throw new Error('wallet must not run');
      },
    },
    fetchImpl: catalogFetch(product, challenge),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'prepared_external_payment');
    assert.equal(result.details?.purchase_context_path, contextPath);
  }
  assert.equal(walletCalls, 0);
  assert.equal(await budget.remaining(), 30000);
  const stat = await fs.stat(contextPath);
  assert.equal(stat.mode & 0o777, 0o600);
  const context = JSON.parse(await fs.readFile(contextPath, 'utf8'));
  assert.equal(context.attempt_id, 'attempt-prepare');
  assert.equal(context.amount_atomic, 10000);
  assert.equal(context.payment_required.resource.url, product.access_url);
});

test('CLI entitlement stdin rejects PSD file bytes without echoing them', async () => {
  const secretBytes = Buffer.from('8BPSsecret-file-bytes-not-json', 'latin1');
  const result = await new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--require',
          'ts-node/register',
          path.join(__dirname, '..', 'scripts/agent-download.ts'),
          '--entitlement-stdin',
          '--product-id',
          'mock-published-layout',
          '--out',
          os.tmpdir(),
        ],
        { cwd: path.join(__dirname, '..'), stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.on('data', chunk => {
        output += String(chunk);
      });
      child.stderr.on('data', chunk => {
        output += String(chunk);
      });
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
      child.stdin.end(secretBytes);
    },
  );
  assert.notEqual(result.code, 0);
  assert.match(result.output, /valid JSON object|UTF-8 JSON/);
  assert.equal(result.output.includes('8BPSsecret-file-bytes-not-json'), false);
  assert.equal(result.output.includes('secret-file-bytes'), false);
});
