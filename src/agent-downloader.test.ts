import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { encodePaymentRequiredHeader } from '@x402/core/http';

import {
  downloadCuratoriaAsset,
  makeFailure,
  parseContentDispositionFilename,
  priceUsdToAtomic,
  resolveOutputPath,
  validateDownloadedBytes,
  validateSpend,
} from './agent-downloader';
import type { PaymentSignerAdapter } from './agent-downloader';
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

test('priceUsdToAtomic parses demo-cent prices exactly', () => {
  assert.equal(priceUsdToAtomic('0.01'), 10000);
  assert.equal(priceUsdToAtomic('1'), 1000000);
  assert.equal(priceUsdToAtomic('0.000001'), 1);
  assert.throws(() => priceUsdToAtomic('0.0000001'), /Invalid USD price/);
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
