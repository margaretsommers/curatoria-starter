import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const PAY_TO = '0x1111111111111111111111111111111111111111';
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const POLYGON_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

type AdapterInternals = {
  decodePaymentRequired(challenge: { header?: string; body?: unknown }): PaymentRequired;
  encodePaymentPayload(payload: unknown): string;
  usdToAtomicUsdc(value: string): string;
  validatePaymentRequirement(input: {
    url: string;
    paymentRequired: PaymentRequired;
    entry: CatalogEntry;
    config?: { allowedNetworks?: string[]; maxAmountAtomic?: string | number };
  }): PaymentAccept;
};

type PaymentAccept = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, string>;
};

type PaymentRequired = {
  x402Version: number;
  resource: { url: string; mimeType?: string };
  accepts: PaymentAccept[];
  extensions?: Record<string, unknown>;
};

type CatalogEntry = {
  id: string;
  access_url: string;
  resource_type?: string;
  mime_type?: string;
  price_usd: string;
  owner_wallet: string;
};

function loadAdapterInternals(): AdapterInternals {
  const source = fs.readFileSync(
    path.join(__dirname, '../public/x402-payment-adapter.js'),
    'utf8',
  );
  const context = {
    Buffer,
    TextDecoder,
    TextEncoder,
    URL,
    Uint8Array,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    crypto: {
      getRandomValues(bytes: Uint8Array) {
        bytes.fill(7);
        return bytes;
      },
    },
    location: { origin: 'https://curatoria.dev' },
  } as vm.Context & {
    curatoriaX402PaymentAdapter?: { __testing: AdapterInternals };
    globalThis?: unknown;
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.curatoriaX402PaymentAdapter?.__testing as AdapterInternals;
}

function paymentRequired(overrides: Partial<PaymentAccept> = {}): PaymentRequired {
  const accept: PaymentAccept = {
    scheme: 'exact',
    network: 'eip155:84532',
    amount: '10000',
    asset: BASE_SEPOLIA_USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: 'eip3009', name: 'USDC', version: '2' },
    ...overrides,
  };

  return {
    x402Version: 2,
    resource: {
      url: 'https://curatoria.dev/design-systems/demo',
      mimeType: 'text/markdown',
    },
    accepts: [accept],
  };
}

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'demo',
    access_url: 'https://curatoria.dev/design-systems/demo',
    resource_type: 'design_md',
    mime_type: 'text/markdown',
    price_usd: '0.01',
    owner_wallet: PAY_TO,
    ...overrides,
  };
}

test('x402 browser adapter decodes PAYMENT-REQUIRED header JSON', () => {
  const adapter = loadAdapterInternals();
  const required = paymentRequired();
  const header = Buffer.from(JSON.stringify(required), 'utf8').toString('base64');

  assert.equal(JSON.stringify(adapter.decodePaymentRequired({ header })), JSON.stringify(required));
});

test('x402 browser adapter validates exact catalog payment requirements', () => {
  const adapter = loadAdapterInternals();
  const accepted = adapter.validatePaymentRequirement({
    url: 'https://curatoria.dev/design-systems/demo',
    paymentRequired: paymentRequired(),
    entry: catalogEntry(),
  });

  assert.equal(accepted.amount, '10000');
  assert.equal(adapter.usdToAtomicUsdc('12.345678'), '12345678');
});

test('x402 browser adapter rejects cross-origin asset URLs', () => {
  const adapter = loadAdapterInternals();

  assert.throws(
    () =>
      adapter.validatePaymentRequirement({
        url: 'https://attacker.example/design-systems/demo',
        paymentRequired: paymentRequired(),
        entry: catalogEntry({ access_url: 'https://attacker.example/design-systems/demo' }),
      }),
    /same-origin/,
  );
});

test('x402 browser adapter rejects tampered amount, asset, and payTo', () => {
  const adapter = loadAdapterInternals();
  const base = {
    url: 'https://curatoria.dev/design-systems/demo',
    entry: catalogEntry(),
  };

  assert.throws(
    () => adapter.validatePaymentRequirement({ ...base, paymentRequired: paymentRequired({ amount: '9999' }) }),
    /amount/,
  );
  assert.throws(
    () =>
      adapter.validatePaymentRequirement({
        ...base,
        paymentRequired: paymentRequired({ asset: '0x2222222222222222222222222222222222222222' }),
      }),
    /asset/,
  );
  assert.throws(
    () =>
      adapter.validatePaymentRequirement({
        ...base,
        paymentRequired: paymentRequired({ payTo: '0x3333333333333333333333333333333333333333' }),
      }),
    /payTo/,
  );
});

test('x402 browser adapter rejects over-limit spends before wallet signing', () => {
  const adapter = loadAdapterInternals();

  assert.throws(
    () =>
      adapter.validatePaymentRequirement({
        url: 'https://curatoria.dev/design-systems/demo',
        paymentRequired: paymentRequired({ amount: '20000' }),
        entry: catalogEntry({ price_usd: '0.02' }),
      }),
    /exceeds max spend 10000 atomic USDC/,
  );
});

test('x402 browser adapter rejects non-Base networks by default', () => {
  const adapter = loadAdapterInternals();

  assert.throws(
    () =>
      adapter.validatePaymentRequirement({
        url: 'https://curatoria.dev/design-systems/demo',
        paymentRequired: paymentRequired({
          network: 'eip155:137',
          asset: POLYGON_USDC,
        }),
        entry: catalogEntry(),
      }),
    /Base or Base Sepolia/,
  );
});

test('x402 browser adapter only accepts Polygon with explicit config', () => {
  const adapter = loadAdapterInternals();
  const accepted = adapter.validatePaymentRequirement({
    url: 'https://curatoria.dev/design-systems/demo',
    paymentRequired: paymentRequired({
      network: 'eip155:137',
      asset: POLYGON_USDC,
    }),
    entry: catalogEntry(),
    config: { allowedNetworks: ['eip155:137'] },
  });

  assert.equal(accepted.network, 'eip155:137');
});

test('x402 browser adapter encodes retry payload for PAYMENT-SIGNATURE', () => {
  const adapter = loadAdapterInternals();
  const encoded = adapter.encodePaymentPayload({
    x402Version: 2,
    accepted: paymentRequired().accepts[0],
    payload: {
      signature: `0x${'ab'.repeat(65)}`,
      authorization: {
        from: '0x4444444444444444444444444444444444444444',
        to: PAY_TO,
        value: '10000',
        validAfter: '1',
        validBefore: '2',
        nonce: `0x${'07'.repeat(32)}`,
      },
    },
  });
  const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));

  assert.equal(decoded.x402Version, 2);
  assert.equal(decoded.accepted.payTo, PAY_TO);
  assert.equal(decoded.payload.authorization.value, '10000');
});
