import test from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';

import {
  createRateLimitMiddleware,
  entitlementFingerprint,
  InMemoryFixedWindowRateLimiter,
  RATE_LIMIT,
  redeemEntitlementLimitKey,
} from './rate-limit';

test('fixed-window limiter admits up to the threshold then returns Retry-After', () => {
  const limiter = new InMemoryFixedWindowRateLimiter();
  const now = 1_800_000_000_000;
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.consume('recover:ip:product', 5, RATE_LIMIT.windowMs, now).allowed, true);
  }
  const denied = limiter.consume('recover:ip:product', 5, RATE_LIMIT.windowMs, now);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterSeconds, 60);
  assert.equal(
    limiter.consume('recover:ip:product', 5, RATE_LIMIT.windowMs, now + RATE_LIMIT.windowMs).allowed,
    true,
  );
});

test('prunes expired keys and stays within the 10,000-key bound', () => {
  const limiter = new InMemoryFixedWindowRateLimiter();
  const now = 1_000;
  for (let i = 0; i < RATE_LIMIT.maxKeys; i += 1) {
    limiter.consume(`key-${i}`, 1, RATE_LIMIT.windowMs, now);
  }
  assert.equal(limiter.size, RATE_LIMIT.maxKeys);
  limiter.consume('another', 1, RATE_LIMIT.windowMs, now);
  assert.equal(limiter.size <= RATE_LIMIT.maxKeys, true);
  limiter.consume('fresh-window', 1, RATE_LIMIT.windowMs, now + RATE_LIMIT.windowMs);
  assert.equal(limiter.size < RATE_LIMIT.maxKeys, true);
});

test('hashes entitlement tokens and never retains the raw capability', () => {
  const limiter = new InMemoryFixedWindowRateLimiter();
  const token = 'raw-capability-token-must-not-be-stored';
  const fingerprint = entitlementFingerprint(token);
  assert.equal(fingerprint.includes(token), false);
  limiter.consume(redeemEntitlementLimitKey(fingerprint), 20, RATE_LIMIT.windowMs, 0);
  assert.equal(JSON.stringify(limiter).includes(token), false);
  assert.equal(JSON.stringify([...Object.values(limiter)]).includes(token), false);
});

test('middleware returns 429 with Retry-After and private no-store', () => {
  const limiter = new InMemoryFixedWindowRateLimiter();
  const middleware = createRateLimitMiddleware(
    limiter,
    () => [{ key: 'purchase:1.1.1.1:paid-psd', limit: 1 }],
    () => 0,
  );
  const headers = new Map<string, string>();
  const req = {} as Request;
  const res = {
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
    statusCode: 200,
    body: undefined as unknown,
  };
  let nextCalls = 0;
  const next: NextFunction = () => {
    nextCalls += 1;
  };
  middleware(req, res as unknown as Response, next);
  middleware(req, res as unknown as Response, next);
  assert.equal(nextCalls, 1);
  assert.equal(res.statusCode, 429);
  assert.equal(headers.get('retry-after'), '60');
  assert.equal(headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(res.body, { error: 'Too many requests' });
});
