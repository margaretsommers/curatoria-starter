import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { Express, NextFunction, Request, Response } from 'express';

import { AssetDeliveryService } from './asset-delivery';
import { createApp, type AppConfig, type AppDependencies, type AppLogger } from './app';
import { createObservabilitySink, type ObservabilityEvent } from './observability';
import { BlobEntitlementStore } from './blob-entitlement-store';
import { createSignedBlobDownload, type BlobSdkAdapter } from './blob-storage';
import {
  ENTITLEMENT_TTL_MS,
  EntitlementService,
  storeIndexKeyFromEnv,
  type EntitlementKeyring,
  type EntitlementStore,
} from './entitlements';
import { InMemoryFixedWindowRateLimiter, RATE_LIMIT } from './rate-limit';
import { X402_SETTLEMENT_LOCAL } from './x402';
import type { DesignSystemEntry } from './types';

const origin = 'https://curatoria.dev';
const productId = 'paid-psd';
const settlement = {
  network: 'eip155:8453',
  payer: '0x2222222222222222222222222222222222222222',
  transaction: `0x${'c'.repeat(64)}`,
};
const keyring: EntitlementKeyring = {
  current: { id: '2026-08', secret: 's'.repeat(64) },
  previous: [],
};
const indexKey = 'i'.repeat(64);

function asset(): DesignSystemEntry {
  return {
    id: productId,
    file: 'asset.psd',
    resource_type: 'binary_asset',
    mime_type: 'image/vnd.adobe.photoshop',
    name: 'Paid PSD',
    description: '',
    price_usd: '0.01',
    tags: [],
    content_sha256: 'a'.repeat(64),
    content_bytes: 100,
    integrity_status: 'verified',
    delivery_mode: 'entitlement',
    blob_path: `assets/sha256/${'a'.repeat(64)}/asset.psd`,
    source_provider: 'gdrive',
    published_at: '2026-08-29T00:00:00.000Z',
    active: true,
  };
}

function paymentSignature(): string {
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
    }),
  ).toString('base64url');
}

function durableSdk(
  objects = new Map<string, { bytes: Buffer; contentType: string }>(),
): BlobSdkAdapter {
  return {
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
      return {
        delegationToken: 'deleg',
        clientSigningToken: 'client',
        validUntil: Date.now() + 60_000,
      };
    },
    async presignUrl() {
      return { presignedUrl: 'https://blob.example/signed-60s' };
    },
  };
}

function capturingLogger(lines: string[]): AppLogger {
  const push = (message: string) => {
    lines.push(message);
  };
  return { info: push, warn: push, error: push };
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    walletAddress: '0x1111111111111111111111111111111111111111',
    network: 'base-sepolia',
    facilitatorUrl: 'https://facilitator.test',
    adminApiKey: 'admin-test-key',
    allowedOrigins: [origin],
    catalogPaywallEnabled: false,
    production: false,
    publicDir: fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-app-')),
    publicOrigin: origin,
    entitlementStoreIndexKey: indexKey,
    ...overrides,
  };
}

function passthrough(): (req: Request, res: Response, next: NextFunction) => void {
  return (_req, _res, next) => next();
}

function settleThenPass(calls?: { x402: number }): (req: Request, res: Response, next: NextFunction) => void {
  return (_req, res, next) => {
    if (calls) calls.x402 += 1;
    res.locals[X402_SETTLEMENT_LOCAL] = settlement;
    next();
  };
}

function binaryDeps(
  objects = new Map<string, { bytes: Buffer; contentType: string }>(),
  options: {
    logger?: AppLogger;
    rateLimiter?: InMemoryFixedWindowRateLimiter;
    x402Calls?: { x402: number };
    storeFinds?: { count: number };
    events?: ObservabilityEvent[];
  } = {},
): AppDependencies {
  const sdk = durableSdk(objects);
  const store = new BlobEntitlementStore(indexKey, sdk);
  const wrappedStore = options.storeFinds
    ? {
        async find(reference: string, id: string) {
          options.storeFinds!.count += 1;
          return store.find(reference, id);
        },
        saveIfAbsent: store.saveIfAbsent.bind(store),
      }
    : store;
  const delivery = new AssetDeliveryService({
    findEntry: id => (id === productId ? asset() : null),
    entitlements: new EntitlementService(keyring, wrappedStore, () => Date.parse('2026-08-29T12:00:00.000Z')),
    createSignedDownload: async () => ({
      url: 'https://blob.example/signed-60s',
      expiresAt: '2026-08-29T12:01:00.000Z',
    }),
  });
  return {
    catalog: {
      findEntry: id => (id === productId ? asset() : null),
      readCatalog: () => ({
        owner: { name: 'Test', wallet: '0x1' },
        design_systems: [asset()],
      } as never),
      appendEntry: async () => undefined,
      resolveResource: async () => {
        throw new Error('not used');
      },
    },
    assetDelivery: delivery,
    x402: {
      paywall: () => passthrough(),
      purchasePaywall: () => settleThenPass(options.x402Calls),
      catalogPaywall: () => passthrough(),
    },
    facilitatorDiagnostic: async () => {
      throw new Error('live facilitator diagnostic');
    },
    blob: sdk,
    entitlementStore: wrappedStore,
    rateLimiter: options.rateLimiter ?? new InMemoryFixedWindowRateLimiter(),
    clock: () => Date.parse('2026-08-29T12:00:00.000Z'),
    logger: options.logger ?? capturingLogger([]),
    storageStatus: () => ({
      local: true,
      url: true,
      google_drive: { enabled: true, api_key: false },
      dropbox: { enabled: true, oauth: false },
    }),
    observe: options.events
      ? createObservabilitySink(line => {
          options.events!.push(JSON.parse(line) as ObservabilityEvent);
        })
      : undefined,
  };
}

async function withServer<T>(
  app: Express,
  run: (url: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  }
}

async function request(
  url: string,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<{ status: number; headers: Headers; text: string; json?: unknown }> {
  const res = await fetch(`${url}${options.path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

test('importing app modules performs no live calls or process exits', () => {
  let exited = false;
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    exited = true;
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
  try {
    // Static import already loaded this module. Re-require the CJS graph and
    // construct an app with deps that throw if any live work happens.
    const loaded = require('./app') as typeof import('./app');
    assert.equal(typeof loaded.createApp, 'function');
    const deps = binaryDeps();
    deps.catalog.findEntry = () => {
      throw new Error('catalog read during construction');
    };
    deps.catalog.readCatalog = () => {
      throw new Error('catalog read during construction');
    };
    deps.clock = () => {
      throw new Error('clock during construction');
    };
    deps.facilitatorDiagnostic = async () => {
      throw new Error('facilitator during construction');
    };
    assert.doesNotThrow(() =>
      loaded.createApp(baseConfig(), { ...deps, catalog: binaryDeps().catalog, clock: deps.clock }),
    );
    assert.equal(exited, false);
  } finally {
    process.exit = originalExit;
  }
});

test('createApp construction does not call facilitator, catalog, or clock', () => {
  const deps = binaryDeps();
  let catalogReads = 0;
  let clockReads = 0;
  let facilitatorCalls = 0;
  deps.catalog.findEntry = () => {
    catalogReads += 1;
    return null;
  };
  deps.clock = () => {
    clockReads += 1;
    return 0;
  };
  deps.facilitatorDiagnostic = async () => {
    facilitatorCalls += 1;
    throw new Error('live facilitator');
  };
  createApp(baseConfig(), deps);
  assert.equal(catalogReads, 0);
  assert.equal(clockReads, 0);
  assert.equal(facilitatorCalls, 0);
});

test('fake catalog, facilitator, clock, store, and Blob exercise purchase and redemption', async () => {
  const logs: string[] = [];
  const app = createApp(baseConfig(), binaryDeps(undefined, { logger: capturingLogger(logs) }));
  await withServer(app, async url => {
    const purchased = await request(url, {
      path: `/assets/${productId}/purchase`,
      headers: { 'payment-signature': paymentSignature() },
    });
    assert.equal(purchased.status, 200);
    const body = purchased.json as {
      entitlement: string;
      recovered: boolean;
      transaction: string;
    };
    assert.equal(body.recovered, false);
    assert.equal(body.transaction, settlement.transaction);
    const recovered = await request(url, {
      method: 'POST',
      path: `/assets/${productId}/recover`,
      headers: { 'payment-signature': paymentSignature() },
    });
    assert.equal(recovered.status, 200);
    assert.equal((recovered.json as { recovered: boolean }).recovered, true);
    const redeemed = await request(url, {
      path: `/assets/${productId}/redeem`,
      headers: { authorization: `Bearer ${body.entitlement}` },
    });
    assert.equal(redeemed.status, 200);
    assert.equal(
      (redeemed.json as { download_url: string }).download_url,
      'https://blob.example/signed-60s',
    );
    assert.equal(logs.some(line => line.includes(body.entitlement)), false);
  });
});

test('missing binary deps disable only binary routes in local mode', async () => {
  const deps = binaryDeps();
  deps.assetDelivery = undefined;
  const app = createApp(baseConfig({ production: false }), deps);
  await withServer(app, async url => {
    const purchase = await request(url, { path: `/assets/${productId}/purchase` });
    const recover = await request(url, { method: 'POST', path: `/assets/${productId}/recover` });
    const redeem = await request(url, { path: `/assets/${productId}/redeem` });
    const health = await request(url, { path: '/health' });
    assert.equal(purchase.status, 503);
    assert.equal(recover.status, 503);
    assert.equal(redeem.status, 503);
    assert.equal(health.status, 200);
    assert.equal((health.json as { status: string }).status, 'ok');
  });
});

test('production fails closed when issuer, index key, Blob, store, delivery, or payout is missing', () => {
  const deps = binaryDeps();
  assert.throws(
    () => createApp(baseConfig({ production: true, publicOrigin: undefined }), deps),
    /issuer\/origin/i,
  );
  assert.throws(
    () => createApp(baseConfig({ production: true, entitlementStoreIndexKey: undefined }), deps),
    /ENTITLEMENT_STORE_INDEX_KEY/,
  );
  assert.throws(
    () => createApp(baseConfig({ production: true, walletAddress: '' }), deps),
    /payout wallet/i,
  );
  assert.throws(
    () => createApp(baseConfig({ production: true }), { ...deps, assetDelivery: undefined }),
    /binary asset delivery/i,
  );
  assert.throws(
    () => createApp(baseConfig({ production: true }), { ...deps, entitlementStore: undefined }),
    /entitlement store/i,
  );
  assert.throws(
    () => createApp(baseConfig({ production: true }), { ...deps, blob: undefined }),
    /Blob store/i,
  );
  assert.throws(
    () => storeIndexKeyFromEnv({ NODE_ENV: 'production', ENTITLEMENT_SIGNING_KEY: 's'.repeat(64) }),
    /ENTITLEMENT_STORE_INDEX_KEY/,
  );
});

test('route-scoped CORS rejects null and unknown origins, permits originless CLI, and emits Vary: Origin', async () => {
  const app = createApp(baseConfig(), binaryDeps());
  await withServer(app, async url => {
    const allowed = await request(url, {
      path: `/assets/${productId}/purchase`,
      headers: { origin: origin, 'payment-signature': paymentSignature() },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), origin);
    assert.match(allowed.headers.get('vary') ?? '', /origin/i);

    const unknown = await request(url, {
      path: `/assets/${productId}/purchase`,
      headers: { origin: 'https://evil.example', 'payment-signature': paymentSignature() },
    });
    assert.notEqual(unknown.headers.get('access-control-allow-origin'), 'https://evil.example');
    assert.match(unknown.headers.get('vary') ?? '', /origin/i);

    const nulled = await request(url, {
      method: 'OPTIONS',
      path: `/assets/${productId}/purchase`,
      headers: {
        origin: 'null',
        'access-control-request-method': 'GET',
      },
    });
    assert.notEqual(nulled.headers.get('access-control-allow-origin'), 'null');
    assert.match(nulled.headers.get('vary') ?? '', /origin/i);

    const cli = await request(url, {
      path: `/assets/${productId}/purchase`,
      headers: { 'payment-signature': paymentSignature() },
    });
    assert.equal(cli.status, 200);
    assert.match(cli.headers.get('vary') ?? '', /origin/i);
  });
});

test('every purchase, recover, and redeem limit key returns 429 at its threshold', async () => {
  const limiter = new InMemoryFixedWindowRateLimiter();
  const x402Calls = { x402: 0 };
  const storeFinds = { count: 0 };
  const app = createApp(
    baseConfig(),
    binaryDeps(undefined, { rateLimiter: limiter, x402Calls, storeFinds }),
  );
  await withServer(app, async url => {
    const signature = paymentSignature();
    const purchased = await request(url, {
      path: `/assets/${productId}/purchase`,
      headers: { 'payment-signature': signature, 'x-forwarded-for': '203.0.113.10' },
    });
    const entitlement = (purchased.json as { entitlement: string }).entitlement;

    for (let i = 0; i < RATE_LIMIT.purchasePerIpProduct - 1; i += 1) {
      const res = await request(url, {
        path: `/assets/${productId}/purchase`,
        headers: { 'payment-signature': signature, 'x-forwarded-for': '203.0.113.10' },
      });
      assert.equal(res.status, 200);
    }
    const purchaseLimited = await request(url, {
      path: `/assets/${productId}/purchase`,
      headers: { 'payment-signature': signature, 'x-forwarded-for': '203.0.113.10' },
    });
    assert.equal(purchaseLimited.status, 429);
    assert.equal(purchaseLimited.headers.get('retry-after'), '60');
    assert.equal(purchaseLimited.headers.get('cache-control'), 'private, no-store');
    assert.equal(x402Calls.x402, RATE_LIMIT.purchasePerIpProduct);
    storeFinds.count = 0;

    for (let i = 0; i < RATE_LIMIT.recoverPerIpProduct; i += 1) {
      const res = await request(url, {
        method: 'POST',
        path: `/assets/${productId}/recover`,
        headers: { 'payment-signature': signature, 'x-forwarded-for': '203.0.113.11' },
      });
      assert.equal(res.status, 200);
    }
    const recoverLimited = await request(url, {
      method: 'POST',
      path: `/assets/${productId}/recover`,
      headers: { 'payment-signature': signature, 'x-forwarded-for': '203.0.113.11' },
    });
    assert.equal(recoverLimited.status, 429);
    assert.equal(storeFinds.count, RATE_LIMIT.recoverPerIpProduct);

    for (let i = 0; i < RATE_LIMIT.redeemPerEntitlement; i += 1) {
      const res = await request(url, {
        path: `/assets/${productId}/redeem`,
        headers: {
          authorization: `Bearer ${entitlement}`,
          'x-forwarded-for': '203.0.113.12',
        },
      });
      assert.equal(res.status, 200);
    }
    const redeemLimited = await request(url, {
      path: `/assets/${productId}/redeem`,
      headers: {
        authorization: `Bearer ${entitlement}`,
        'x-forwarded-for': '203.0.113.12',
      },
    });
    assert.equal(redeemLimited.status, 429);

    const otherTokenApp = createApp(
      baseConfig(),
      binaryDeps(undefined, { rateLimiter: limiter }),
    );
    await withServer(otherTokenApp, async otherUrl => {
      for (let i = 0; i < RATE_LIMIT.redeemPerIp; i += 1) {
        const res = await request(otherUrl, {
          path: `/assets/${productId}/redeem`,
          headers: {
            authorization: `Bearer missing-token-${i}`,
            'x-forwarded-for': '203.0.113.13',
          },
        });
        assert.ok(res.status === 401 || res.status === 200);
      }
      const ipLimited = await request(otherUrl, {
        path: `/assets/${productId}/redeem`,
        headers: {
          authorization: 'Bearer missing-token-last',
          'x-forwarded-for': '203.0.113.13',
        },
      });
      assert.equal(ipLimited.status, 429);
      assert.equal(ipLimited.headers.get('retry-after'), '60');
    });
  });
});

test('entitlement tokens never appear in logs', async () => {
  const logs: string[] = [];
  const app = createApp(baseConfig(), binaryDeps(undefined, { logger: capturingLogger(logs) }));
  await withServer(app, async url => {
    const purchased = await request(url, {
      path: `/assets/${productId}/purchase`,
      headers: { 'payment-signature': paymentSignature() },
    });
    const entitlement = (purchased.json as { entitlement: string }).entitlement;
    await request(url, {
      path: `/assets/${productId}/redeem`,
      headers: { authorization: `Bearer ${entitlement}tampered` },
    });
    const joined = logs.join('\n');
    assert.equal(joined.includes(entitlement), false);
    assert.equal(joined.includes(`${entitlement}tampered`), false);
  });
});

test('fresh app instance recovers a stored Blob entitlement after signing-key rotation', async () => {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const first = createApp(baseConfig(), binaryDeps(objects));
  let entitlement = '';
  await withServer(first, async url => {
    const purchased = await request(url, {
      path: `/assets/${productId}/purchase`,
      headers: { 'payment-signature': paymentSignature() },
    });
    entitlement = (purchased.json as { entitlement: string }).entitlement;
    assert.ok(entitlement);
  });

  const rotated: EntitlementKeyring = {
    current: { id: '2026-09', secret: 'r'.repeat(64) },
    previous: [keyring.current],
  };
  const sdk = durableSdk(objects);
  const store = new BlobEntitlementStore(indexKey, sdk);
  const freshDelivery = new AssetDeliveryService({
    findEntry: () => null,
    entitlements: new EntitlementService(rotated, store, () => Date.parse('2026-08-29T12:00:00.000Z')),
    createSignedDownload: async () => ({
      url: 'https://blob.example/signed-60s',
      expiresAt: '2026-08-29T12:01:00.000Z',
    }),
  });
  const freshDeps = binaryDeps(objects);
  freshDeps.assetDelivery = freshDelivery;
  freshDeps.entitlementStore = store;
  freshDeps.blob = sdk;
  const fresh = createApp(baseConfig(), freshDeps);
  await withServer(fresh, async url => {
    const recovered = await request(url, {
      method: 'POST',
      path: `/assets/${productId}/recover`,
      headers: { 'payment-signature': paymentSignature() },
    });
    assert.equal(recovered.status, 200);
    assert.equal((recovered.json as { entitlement: string }).entitlement, entitlement);
  });
});

test('recover returns 404 for a missing record and 401 only for expired proof', async () => {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const issuedAt = Date.parse('2026-08-29T12:00:00.000Z');
  const app = createApp(baseConfig(), binaryDeps(objects));
  await withServer(app, async url => {
    const missing = await request(url, {
      method: 'POST',
      path: `/assets/${productId}/recover`,
      headers: { 'payment-signature': paymentSignature() },
    });
    assert.equal(missing.status, 404);
    assert.equal(
      (missing.json as { error: string }).error,
      'No settled entitlement exists for this payment',
    );

    const purchased = await request(url, {
      path: `/assets/${productId}/purchase`,
      headers: { 'payment-signature': paymentSignature() },
    });
    assert.equal(purchased.status, 200);
  });

  const sdk = durableSdk(objects);
  const store = new BlobEntitlementStore(indexKey, sdk);
  const expiredDeps = binaryDeps(objects);
  expiredDeps.assetDelivery = new AssetDeliveryService({
    findEntry: id => (id === productId ? asset() : null),
    entitlements: new EntitlementService(keyring, store, () => issuedAt + ENTITLEMENT_TTL_MS),
    createSignedDownload: async () => ({
      url: 'https://blob.example/signed-60s',
      expiresAt: '2026-08-29T13:01:00.000Z',
    }),
  });
  expiredDeps.entitlementStore = store;
  expiredDeps.blob = sdk;
  const expired = createApp(baseConfig(), expiredDeps);
  await withServer(expired, async url => {
    const recovered = await request(url, {
      method: 'POST',
      path: `/assets/${productId}/recover`,
      headers: { 'payment-signature': paymentSignature() },
    });
    assert.equal(recovered.status, 401);
    assert.equal(
      (recovered.json as { error: string }).error,
      'Entitlement recovery proof is invalid or expired',
    );
  });
});

test('redeem returns 401 for missing bearer and invalid entitlement', async () => {
  const app = createApp(baseConfig(), binaryDeps());
  await withServer(app, async url => {
    const purchased = await request(url, {
      path: `/assets/${productId}/purchase`,
      headers: { 'payment-signature': paymentSignature() },
    });
    const entitlement = (purchased.json as { entitlement: string }).entitlement;

    const missing = await request(url, { path: `/assets/${productId}/redeem` });
    assert.equal(missing.status, 401);
    assert.equal(
      (missing.json as { error: string }).error,
      'Authorization: Bearer <entitlement> is required',
    );

    const invalid = await request(url, {
      path: `/assets/${productId}/redeem`,
      headers: { authorization: `Bearer ${entitlement}tampered` },
    });
    assert.equal(invalid.status, 401);
    assert.equal(
      (invalid.json as { error: string }).error,
      'Entitlement is invalid, expired, or no longer redeemable',
    );
  });
});

test('recover maps store find() outages to 503 no-store, not 401', async () => {
  const logs: string[] = [];
  const store: EntitlementStore = {
    async find() {
      throw new Error('Blob timeout contacting entitlements/v1 index');
    },
    async saveIfAbsent() {
      throw new Error('not used');
    },
  };
  const deps = binaryDeps(undefined, { logger: capturingLogger(logs) });
  deps.assetDelivery = new AssetDeliveryService({
    findEntry: id => (id === productId ? asset() : null),
    entitlements: new EntitlementService(keyring, store, () => Date.parse('2026-08-29T12:00:00.000Z')),
    createSignedDownload: async () => ({
      url: 'https://blob.example/signed-60s',
      expiresAt: '2026-08-29T12:01:00.000Z',
    }),
  });
  deps.entitlementStore = store;
  const app = createApp(baseConfig(), deps);
  await withServer(app, async url => {
    const recovered = await request(url, {
      method: 'POST',
      path: `/assets/${productId}/recover`,
      headers: { 'payment-signature': paymentSignature() },
    });
    assert.equal(recovered.status, 503);
    assert.notEqual(recovered.status, 401);
    assert.equal(recovered.headers.get('cache-control'), 'private, no-store');
    assert.equal(
      (recovered.json as { error: string }).error,
      'Entitlement recovery is temporarily unavailable',
    );
    const body = JSON.stringify(recovered.json);
    assert.equal(body.includes('Blob timeout'), false);
    assert.equal(body.includes('entitlements/v1'), false);
    assert.equal(body.includes('find'), false);
    assert.equal(logs.some(line => line.includes('Bearer ')), false);
  });
});

test('redeem maps presign/createSignedBlobDownload throws to 503 no-store, not 401', async () => {
  const logs: string[] = [];
  const now = Date.parse('2026-08-29T12:00:00.000Z');
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const sdk = durableSdk(objects);
  sdk.presignUrl = async () => {
    throw new Error('presign network failure for assets/sha256');
  };
  const store = new BlobEntitlementStore(indexKey, durableSdk(objects));
  const deps = binaryDeps(objects, { logger: capturingLogger(logs) });
  deps.assetDelivery = new AssetDeliveryService({
    findEntry: id => (id === productId ? asset() : null),
    entitlements: new EntitlementService(keyring, store, () => now),
    createSignedDownload: pathname => createSignedBlobDownload(pathname, sdk, now),
  });
  deps.entitlementStore = store;
  deps.blob = sdk;
  const app = createApp(baseConfig(), deps);
  await withServer(app, async url => {
    const purchased = await request(url, {
      path: `/assets/${productId}/purchase`,
      headers: { 'payment-signature': paymentSignature() },
    });
    assert.equal(purchased.status, 200);
    const entitlement = (purchased.json as { entitlement: string }).entitlement;
    const redeemed = await request(url, {
      path: `/assets/${productId}/redeem`,
      headers: { authorization: `Bearer ${entitlement}` },
    });
    assert.equal(redeemed.status, 503);
    assert.notEqual(redeemed.status, 401);
    assert.equal(redeemed.headers.get('cache-control'), 'private, no-store');
    assert.equal(
      (redeemed.json as { error: string }).error,
      'Entitlement redemption is temporarily unavailable',
    );
    const body = JSON.stringify(redeemed.json);
    assert.equal(body.includes('presign'), false);
    assert.equal(body.includes('assets/sha256'), false);
    assert.equal(body.includes('network failure'), false);
    assert.equal(logs.some(line => line.includes(entitlement)), false);
  });
});

test('composition root never derives the store index key from the signing key', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
  assert.equal(source.includes('keyring.current.secret'), false);
  assert.match(source, /storeIndexKeyFromEnv/);
  assert.match(source, /require\.main === module/);
  assert.match(source, /createObservabilitySink/);
});

test('purchase recover and redeem emit redacted observability events', async () => {
  const events: ObservabilityEvent[] = [];
  const logs: string[] = [];
  const app = createApp(
    baseConfig(),
    binaryDeps(undefined, { logger: capturingLogger(logs), events }),
  );
  await withServer(app, async url => {
    const purchased = await request(url, {
      path: `/assets/${productId}/purchase`,
      headers: {
        'payment-signature': paymentSignature(),
        'x-correlation-id': 'corr_cccccccccccccccccccccccccccccccc',
      },
    });
    assert.equal(purchased.status, 200);
    assert.equal(purchased.headers.get('x-correlation-id'), 'corr_cccccccccccccccccccccccccccccccc');
    const body = purchased.json as { entitlement: string; receipt_id: string };
    await request(url, {
      method: 'POST',
      path: `/assets/${productId}/recover`,
      headers: {
        'payment-signature': paymentSignature(),
        'x-correlation-id': 'corr_cccccccccccccccccccccccccccccccc',
      },
    });
    await request(url, {
      path: `/assets/${productId}/redeem`,
      headers: {
        authorization: `Bearer ${body.entitlement}`,
        'x-correlation-id': 'corr_cccccccccccccccccccccccccccccccc',
      },
    });
    assert.deepEqual(
      events.map(event => event.stage),
      ['purchase', 'recover', 'redeem'],
    );
    assert.ok(events.every(event => event.correlation_id === 'corr_cccccccccccccccccccccccccccccccc'));
    assert.ok(events.every(event => event.outcome === 'ok'));
    assert.equal(events[0]?.receipt_id, body.receipt_id);
    assert.equal(events[0]?.provider, 'gdrive');
    assert.equal(events[0]?.bytes, 100);
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes(body.entitlement), false);
    assert.equal(serialized.includes('https://blob.example'), false);
    assert.equal(serialized.includes('authorization'), false);
    assert.equal(logs.some(line => line.includes(body.entitlement)), false);
  });
});

test('recover and redeem observability keeps 401 rejected versus 503 unavailable', async () => {
  const rejected: ObservabilityEvent[] = [];
  const app = createApp(baseConfig(), binaryDeps(undefined, { events: rejected }));
  await withServer(app, async url => {
    const missing = await request(url, { path: `/assets/${productId}/redeem` });
    assert.equal(missing.status, 401);
  });
  assert.equal(rejected[0]?.stage, 'redeem');
  assert.equal(rejected[0]?.outcome, 'rejected');

  const unavailable: ObservabilityEvent[] = [];
  const store: EntitlementStore = {
    async find() {
      throw new Error('Blob timeout contacting entitlements/v1 index');
    },
    async saveIfAbsent() {
      throw new Error('not used');
    },
  };
  const deps = binaryDeps(undefined, { events: unavailable });
  deps.assetDelivery = new AssetDeliveryService({
    findEntry: id => (id === productId ? asset() : null),
    entitlements: new EntitlementService(keyring, store, () => Date.parse('2026-08-29T12:00:00.000Z')),
    createSignedDownload: async () => ({
      url: 'https://blob.example/signed-60s',
      expiresAt: '2026-08-29T12:01:00.000Z',
    }),
  });
  deps.entitlementStore = store;
  const unavailableApp = createApp(baseConfig(), deps);
  await withServer(unavailableApp, async url => {
    const recovered = await request(url, {
      method: 'POST',
      path: `/assets/${productId}/recover`,
      headers: { 'payment-signature': paymentSignature() },
    });
    assert.equal(recovered.status, 503);
  });
  assert.equal(unavailable[0]?.stage, 'recover');
  assert.equal(unavailable[0]?.outcome, 'unavailable');
});
