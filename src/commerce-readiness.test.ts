import test from 'node:test';
import assert from 'node:assert/strict';

import { createCommerceReadinessController } from './commerce-readiness';

test('read success with unavailable writes fails closed', async () => {
  let assetReads = 0;
  let writes = 0;
  const controller = createCommerceReadinessController({
    clock: () => 1_000,
    catalogAuthoritative: () => true,
    verifyAssetReadable: async pathname => {
      assetReads += 1;
      assert.equal(pathname, 'assets/example.bin');
    },
    verifyWriteCapability: async () => {
      writes += 1;
      throw Object.assign(new Error('Blob PUT suspended'), { statusCode: 403 });
    },
  });

  const result = await controller.check('assets/example.bin');
  assert.equal(result.ready, false);
  assert.equal(assetReads, 1);
  assert.equal(writes, 1);
  assert.deepEqual(controller.status(), {
    ready: false,
    storage: 'unavailable',
    detail: 'Authoritative storage read/write readiness verification failed.',
  });
});

test('read/write readiness is bounded and refreshed only by explicit checks', async () => {
  let now = 1_000;
  let assetReads = 0;
  let writes = 0;
  const controller = createCommerceReadinessController({
    clock: () => now,
    catalogAuthoritative: () => true,
    successTtlMs: 100,
    failureTtlMs: 200,
    verifyAssetReadable: async () => {
      assetReads += 1;
    },
    verifyWriteCapability: async () => {
      writes += 1;
    },
  });

  const concurrent = await Promise.all([
    controller.check('assets/example.bin'),
    controller.check('assets/example.bin'),
  ]);
  assert.deepEqual(concurrent.map(result => result.ready), [true, true]);
  assert.equal((await controller.check('assets/example.bin')).ready, true);
  assert.equal(assetReads, 1);
  assert.equal(writes, 1);

  now += 101;
  assert.equal((await controller.check('assets/example.bin')).ready, true);
  assert.equal(assetReads, 2);
  assert.equal(writes, 2);
});

test('non-authoritative catalog never probes storage', async () => {
  let calls = 0;
  const controller = createCommerceReadinessController({
    clock: () => 1_000,
    catalogAuthoritative: () => false,
    verifyAssetReadable: async () => {
      calls += 1;
    },
    verifyWriteCapability: async () => {
      calls += 1;
    },
  });

  assert.equal((await controller.check()).ready, false);
  assert.equal(calls, 0);
});
