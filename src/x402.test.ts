import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { NextFunction, Request, Response } from 'express';
import { HTTPFacilitatorClient } from '@x402/core/server';

import { settlementReference } from './asset-delivery';
import {
  EntitlementService,
  InMemoryEntitlementStore,
  type EntitlementKeyring,
} from './entitlements';
import { InMemorySettlementJournal } from './settlement-journal';
import type { DesignSystemEntry } from './types';
import {
  createSettlementFirstMiddleware,
  X402_SETTLEMENT_LOCAL,
} from './x402';

const paymentHeader = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    accepted: {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000',
      payTo: '0x1111111111111111111111111111111111111111',
      maxTimeoutSeconds: 300,
      asset: '0x3333333333333333333333333333333333333333',
      extra: {},
    },
    payload: {
      signature: `0x${'a'.repeat(130)}`,
      authorization: {
        from: '0x2222222222222222222222222222222222222222',
        to: '0x1111111111111111111111111111111111111111',
        value: '10000',
        validAfter: '1',
        validBefore: '2',
        nonce: `0x${'4'.repeat(64)}`,
      },
    },
  }),
).toString('base64url');

const origin = 'https://curatoria.dev';
const keyring: EntitlementKeyring = {
  current: { id: 'current', secret: 's'.repeat(64) },
  previous: [],
};

function asset(): DesignSystemEntry {
  return {
    id: 'paid-psd',
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

function settlingServer(calls: { verified: number; settled: number }) {
  return {
    async initialize() {},
    async processHTTPRequest() {
      calls.verified += 1;
      return {
        type: 'payment-verified' as const,
        cancellationDispatcher: { cancel: async () => {} },
        paymentPayload: {},
        paymentRequirements: {},
      };
    },
    async processSettlement() {
      calls.settled += 1;
      return {
        success: true as const,
        transaction: `0x${'c'.repeat(64)}`,
        network: 'eip155:8453',
        payer: '0x2222222222222222222222222222222222222222',
        headers: { 'PAYMENT-RESPONSE': 'finalized-response' },
        requirements: {},
      };
    },
  };
}

function request(): Request {
  const req: {
    path: string;
    method: string;
    headers: Record<string, string>;
    get(name: string): string | undefined;
    header(name: string): string | undefined;
  } = {
    path: '/assets/paid-psd/purchase',
    method: 'GET',
    headers: { 'payment-signature': paymentHeader },
    get(name: string) {
      const value = req.headers[name.toLowerCase()];
      return typeof value === 'string' ? value : undefined;
    },
    header(name: string) {
      return req.get(name);
    },
  };
  return req as unknown as Request;
}

function response(): Response & { body?: unknown } {
  const headers = new Map<string, string>();
  const res: {
    locals: Record<string, unknown>;
    statusCode: number;
    body?: unknown;
    setHeader(name: string, value: string): unknown;
    status(code: number): unknown;
    json(body: unknown): unknown;
    send(body: unknown): unknown;
  } = {
    locals: {},
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    send(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res as unknown as Response & { body?: unknown };
}

test('settlement-first boundary exposes only authenticated finalized facilitator evidence', async () => {
  const calls = { verified: 0, settled: 0 };
  const res = response();
  let nextCalls = 0;
  await createSettlementFirstMiddleware(settlingServer(calls) as never)(
    request(),
    res,
    (() => {
      nextCalls += 1;
    }) as NextFunction,
  );

  assert.equal(calls.settled, 1);
  assert.equal(nextCalls, 1);
  assert.deepEqual(res.locals[X402_SETTLEMENT_LOCAL], {
    transaction: `0x${'c'.repeat(64)}`,
    network: 'eip155:8453',
    payer: '0x2222222222222222222222222222222222222222',
  });
});

test('unsettled or mismatched facilitator result never reaches entitlement handler', async () => {
  for (const result of [
    {
      success: false as const,
      transaction: '',
      network: 'eip155:8453',
      headers: {},
      errorReason: 'not settled',
      response: { status: 402, headers: {}, body: { error: 'not settled' } },
    },
    {
      success: true as const,
      transaction: `0x${'c'.repeat(64)}`,
      network: 'eip155:8453',
      payer: '0x3333333333333333333333333333333333333333',
      headers: {},
      requirements: {},
    },
  ]) {
    const server = {
      async initialize() {},
      async processHTTPRequest() {
        return {
          type: 'payment-verified' as const,
          cancellationDispatcher: { cancel: async () => {} },
          paymentPayload: {},
          paymentRequirements: {},
        };
      },
      async processSettlement() {
        return result;
      },
    };
    const res = response();
    let nextError: unknown;
    await createSettlementFirstMiddleware(server as never)(
      request(),
      res,
      ((error?: unknown) => {
        nextError = error ?? 'called';
      }) as NextFunction,
    );
    if (result.success) {
      assert.ok(nextError instanceof Error);
      assert.equal(res.locals[X402_SETTLEMENT_LOCAL], undefined);
    } else {
      assert.equal(nextError, undefined);
      assert.equal(res.statusCode, 402);
    }
  }
});

test('installed facilitator still has no settlement-status lookup', () => {
  const methods = Object.getOwnPropertyNames(HTTPFacilitatorClient.prototype);
  assert.ok(methods.includes('verify'));
  assert.ok(methods.includes('settle'));
  assert.ok(methods.includes('getSupported'));
  assert.equal(methods.includes('getStatus'), false);
  assert.equal(methods.includes('lookup'), false);
  assert.equal(methods.includes('getSettlement'), false);

  const expressSource = fs.readFileSync(require.resolve('@x402/express'), 'utf8');
  assert.match(expressSource, /bufferedCalls/);
  assert.match(expressSource, /await Promise\.resolve\(next\(\)\)/);
  assert.match(expressSource, /processSettlement/);

  const resourceServerSource = fs.readFileSync(require.resolve('@x402/core/server'), 'utf8');
  assert.match(resourceServerSource, /warnResourceServerHookFailure\("afterSettle"/);
});

test('crash between settle and entitlement save retries without a second settlement', async () => {
  const calls = { verified: 0, settled: 0 };
  const journal = new InMemorySettlementJournal();
  const store = new InMemoryEntitlementStore();
  const middleware = createSettlementFirstMiddleware(settlingServer(calls) as never, {
    journal,
    entitlements: store,
  });
  const first = response();
  await middleware(request(), first, (() => {}) as NextFunction);

  assert.equal(calls.settled, 1);
  assert.ok(first.locals[X402_SETTLEMENT_LOCAL]);
  assert.equal(await store.find(settlementReference(paymentHeader), asset().id), undefined);

  const retry = response();
  await middleware(request(), retry, (() => {}) as NextFunction);
  const entitlements = new EntitlementService(keyring, store, () =>
    Date.parse('2026-08-29T12:00:00.000Z'),
  );
  const issued = await entitlements.issueAfterSettlement(
    asset(),
    settlementReference(paymentHeader),
    retry.locals[X402_SETTLEMENT_LOCAL] as {
      network: string;
      payer: string;
      transaction: string;
    },
    origin,
  );
  const recovered = await entitlements.recover(
    asset().id,
    settlementReference(paymentHeader),
    origin,
  );

  assert.equal(calls.verified, 1);
  assert.equal(calls.settled, 1);
  assert.deepEqual(retry.locals[X402_SETTLEMENT_LOCAL], first.locals[X402_SETTLEMENT_LOCAL]);
  assert.equal(issued.recovered, false);
  assert.equal(recovered?.token, issued.record.token);
  assert.equal(recovered?.payment.transaction, `0x${'c'.repeat(64)}`);
});

test('journal receipt for one product never recovers a different product purchase', async () => {
  const calls = { verified: 0, settled: 0 };
  const journal = new InMemorySettlementJournal();
  const store = new InMemoryEntitlementStore();
  const middleware = createSettlementFirstMiddleware(settlingServer(calls) as never, {
    journal,
    entitlements: store,
  });

  const paidForA = response();
  await middleware(request(), paidForA, (() => {}) as NextFunction);
  assert.equal(calls.settled, 1);
  assert.ok(paidForA.locals[X402_SETTLEMENT_LOCAL]);
  const receipt = await journal.find(settlementReference(paymentHeader));
  assert.equal(receipt?.productId, 'paid-psd');

  const replayForB = request();
  (replayForB as { path: string }).path = '/assets/other-psd/purchase';
  const res = response();
  let nextError: unknown;
  await middleware(replayForB, res, ((error?: unknown) => {
    nextError = error;
  }) as NextFunction);

  // Recovery must be refused, forcing a fresh verify; the mock settles again,
  // but the immutable journal then rejects the cross-product receipt, so the
  // replayed header can never produce settlement evidence for product B.
  assert.equal(calls.verified, 2);
  assert.ok(nextError instanceof Error);
  assert.match(String(nextError), /does not match the settled payment/);
  assert.equal(res.locals[X402_SETTLEMENT_LOCAL], undefined);
});

test('already-issued entitlement skips settle even without a journal hit', async () => {
  const calls = { verified: 0, settled: 0 };
  const store = new InMemoryEntitlementStore();
  const entitlements = new EntitlementService(keyring, store, () =>
    Date.parse('2026-08-29T12:00:00.000Z'),
  );
  await entitlements.issueAfterSettlement(
    asset(),
    settlementReference(paymentHeader),
    {
      network: 'eip155:8453',
      payer: '0x2222222222222222222222222222222222222222',
      transaction: `0x${'c'.repeat(64)}`,
    },
    origin,
  );
  const middleware = createSettlementFirstMiddleware(settlingServer(calls) as never, {
    entitlements: store,
  });
  const res = response();
  await middleware(request(), res, (() => {}) as NextFunction);

  assert.equal(calls.verified, 0);
  assert.equal(calls.settled, 0);
  assert.deepEqual(res.locals[X402_SETTLEMENT_LOCAL], {
    network: 'eip155:8453',
    payer: '0x2222222222222222222222222222222222222222',
    transaction: `0x${'c'.repeat(64)}`,
  });
});
