import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkDisposableLinkAccess,
  createDisposableLinkState,
  normalizeDisposableAccessPolicy,
  recordDisposableLinkResponse,
} from './paid-access';

test('normalizeDisposableAccessPolicy applies conservative defaults', () => {
  const disabled = normalizeDisposableAccessPolicy(undefined);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.maxDownloads, 0);

  const enabled = normalizeDisposableAccessPolicy({ enabled: true });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.maxDownloads, 1);
  assert.equal(enabled.maxViews, 1);
  assert.equal(enabled.hoursValid, 24);
  assert.equal(enabled.allowRegenerationAfterPayment, false);
  assert.equal(enabled.delivery, 'fallback_when_direct_too_large');
});

test('normalizeDisposableAccessPolicy rejects non-positive limits', () => {
  assert.throws(
    () => normalizeDisposableAccessPolicy({ enabled: true, max_downloads: 0 }),
    /max_downloads must be a positive number/,
  );
  assert.throws(
    () => normalizeDisposableAccessPolicy({ enabled: true, hours_valid: -1 }),
    /hours_valid must be a positive number/,
  );
  assert.throws(
    () => normalizeDisposableAccessPolicy({ enabled: true, max_total_bytes: 1.5 }),
    /max_total_bytes must be a whole number/,
  );
});

test('createDisposableLinkState binds expiry and remaining counters to policy', () => {
  const state = createDisposableLinkState({
    linkId: 'link_123',
    resourceId: 'curatoria-demo-pack',
    receiptId: 'receipt_123',
    issuedAt: new Date('2026-01-01T00:00:00.000Z'),
    contentSha256: 'd'.repeat(64),
    policy: {
      enabled: true,
      max_downloads: 2,
      max_views: 3,
      hours_valid: 6,
      max_total_bytes: 1000,
    },
  });

  assert.equal(state.expiresAt, '2026-01-01T06:00:00.000Z');
  assert.equal(state.remainingDownloads, 2);
  assert.equal(state.remainingViews, 3);
  assert.equal(state.maxTotalBytes, 1000);
  assert.equal(state.contentSha256, 'd'.repeat(64));
});

test('recordDisposableLinkResponse decrements only on successful file responses', () => {
  const state = createDisposableLinkState({
    linkId: 'link_123',
    resourceId: 'curatoria-demo-pack',
    receiptId: 'receipt_123',
    issuedAt: new Date('2026-01-01T00:00:00.000Z'),
    policy: { enabled: true, max_downloads: 1, max_views: 2, hours_valid: 1 },
  });

  const failedPreflight = recordDisposableLinkResponse(state, {
    successfulResponse: false,
    now: new Date('2026-01-01T00:10:00.000Z'),
  });
  assert.equal(failedPreflight.access.ok, true);
  assert.equal(failedPreflight.state.remainingDownloads, 1);
  assert.equal(failedPreflight.state.remainingViews, 2);

  const success = recordDisposableLinkResponse(failedPreflight.state, {
    successfulResponse: true,
    bytesServed: 500,
    now: new Date('2026-01-01T00:15:00.000Z'),
  });
  assert.equal(success.access.ok, true);
  assert.equal(success.state.remainingDownloads, 0);
  assert.equal(success.state.remainingViews, 1);
  assert.equal(success.state.bytesServed, 500);

  assert.deepEqual(
    checkDisposableLinkAccess(success.state, { now: new Date('2026-01-01T00:20:00.000Z') }),
    { ok: false, reason: 'downloads_exhausted' },
  );
});

test('checkDisposableLinkAccess rejects expired and byte-exceeding links', () => {
  const state = createDisposableLinkState({
    linkId: 'link_123',
    resourceId: 'curatoria-demo-pack',
    receiptId: 'receipt_123',
    issuedAt: new Date('2026-01-01T00:00:00.000Z'),
    policy: {
      enabled: true,
      max_downloads: 2,
      max_views: 2,
      hours_valid: 1,
      max_total_bytes: 100,
    },
  });

  assert.deepEqual(
    checkDisposableLinkAccess(state, {
      now: new Date('2026-01-01T00:30:00.000Z'),
      bytesToServe: 101,
    }),
    { ok: false, reason: 'bytes_exceeded' },
  );
  assert.deepEqual(
    checkDisposableLinkAccess(state, { now: new Date('2026-01-01T01:00:00.000Z') }),
    { ok: false, reason: 'expired' },
  );
});
