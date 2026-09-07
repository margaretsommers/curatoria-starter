import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAgentCashEntitlementPurchaser,
  createAwalEntitlementPurchaser,
  createExternalEntitlementPurchaser,
  executeIsolatedProcess,
  type ProcessExecutor,
} from './wallet-purchasers';
import type { PaymentRequired } from './types';

const challenge: PaymentRequired = {
  x402Version: 2,
  resource: {
    url: 'https://curatoria.dev/assets/layout/purchase',
    mimeType: 'application/json',
  },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000',
      payTo: '0x8aa327403ED786cA56EB8F59C6c8831A8BD73485',
      maxTimeoutSeconds: 300,
      asset: '0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913',
      extra: {},
    },
  ],
  error: 'payment required',
};

test('awal purchaser accepts entitlement JSON and never returns file bytes', async () => {
  const calls: unknown[] = [];
  const executor: ProcessExecutor = async request => {
    calls.push(request);
    const relayUrl = request.args[2];
    const frozen = await fetch(relayUrl);
    assert.equal(frozen.status, 402);
    assert.deepEqual(await frozen.json(), challenge);
    const encoded = frozen.headers.get('payment-required');
    assert.ok(encoded);
    assert.deepEqual(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
      challenge,
    );
    const paid = await fetch(relayUrl, {
      headers: { 'PAYMENT-SIGNATURE': 'fresh-signature' },
    });
    return {
      stdout: JSON.stringify({ status: paid.status, data: await paid.json() }),
      stderr: '',
      exitCode: 0,
    };
  };
  const originalCalls: Array<{ url: string; headers: Headers }> = [];
  const originalFetch = (async (input, init) => {
    originalCalls.push({ url: String(input), headers: new Headers(init?.headers) });
    return Response.json({
      receipt_id: `rcpt_${'r'.repeat(43)}`,
      product_id: 'layout',
      source_provider: 'gdrive',
      network: 'eip155:8453',
      payer: '0x2222222222222222222222222222222222222222',
      transaction: `0x${'c'.repeat(64)}`,
      entitlement: 'signed-entitlement',
      redeem_url: '/assets/layout/redeem',
      expires_at: '2026-08-29T13:00:00.000Z',
      filename: 'layout.psd',
      mime_type: 'image/vnd.adobe.photoshop',
      content_sha256: 'a'.repeat(64),
      content_bytes: 100,
    });
  }) as typeof fetch;

  const result = await createAwalEntitlementPurchaser(
    '/opt/awal/bin/awal',
    executor,
    originalFetch,
  ).purchase({
      url: 'https://curatoria.dev/assets/layout/purchase',
      challenge,
      maxAmountAtomic: 10000,
    });

  assert.equal(result.entitlement, 'signed-entitlement');
  assert.equal('data' in result, false);
  assert.equal(calls.length, 1);
  const processCall = calls[0] as { executable: string; args: string[]; input?: string };
  assert.equal(processCall.executable, '/opt/awal/bin/awal');
  assert.deepEqual(processCall.args.slice(0, 2), ['x402', 'pay']);
  assert.match(processCall.args[2], /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.deepEqual(processCall.args.slice(3), ['--max-amount', '10000', '--json']);
  assert.equal(processCall.input, undefined);
  assert.equal(originalCalls.length, 1, 'the original challenge must never be refetched');
  assert.equal(originalCalls[0].url, 'https://curatoria.dev/assets/layout/purchase');
  assert.deepEqual(Array.from(originalCalls[0].headers), [
    ['payment-signature', 'fresh-signature'],
  ]);
});

test('awal purchaser rejects non-JSON or binary-like wallet output', async () => {
  const executor: ProcessExecutor = async () => ({
    stdout: JSON.stringify({ status: 200, data: '8BPS raw file bytes' }),
    stderr: '',
    exitCode: 0,
  });
  await assert.rejects(
    () =>
      createAwalEntitlementPurchaser('/opt/awal/bin/awal', executor).purchase({
        url: 'https://curatoria.dev/assets/layout/purchase',
        challenge,
        maxAmountAtomic: 10000,
      }),
    /entitlement JSON/i,
  );
});

test('awal purchaser requires an absolute preinstalled executable', () => {
  assert.throws(
    () => createAwalEntitlementPurchaser('npx'),
    /absolute path/,
  );
});

test('awal purchaser rejects challenge drift before invoking the executable', async () => {
  let invoked = false;
  const executor: ProcessExecutor = async () => {
    invoked = true;
    throw new Error('must not execute');
  };
  await assert.rejects(
    () =>
      createAwalEntitlementPurchaser('/opt/awal/bin/awal', executor).purchase({
        url: 'https://curatoria.dev/assets/layout/purchase',
        challenge: {
          ...challenge,
          resource: {
            url: 'https://curatoria.dev/assets/layout/purchase',
            mimeType: 'image/vnd.adobe.photoshop',
          },
        },
        maxAmountAtomic: 10000,
      }),
    /application\/json/,
  );
  assert.equal(invoked, false);
});

test('agentcash purchaser converts atomic USDC to a decimal USD max-amount and never returns file bytes', async () => {
  const calls: unknown[] = [];
  const executor: ProcessExecutor = async request => {
    calls.push(request);
    const relayUrl = request.args[1];
    const frozen = await fetch(relayUrl);
    assert.equal(frozen.status, 402);
    const paid = await fetch(relayUrl, {
      headers: { 'PAYMENT-SIGNATURE': 'fresh-signature' },
    });
    return {
      stdout: JSON.stringify({ amount: '0.01', transaction: `0x${'c'.repeat(64)}`, data: await paid.json() }),
      stderr: '',
      exitCode: 0,
    };
  };
  const originalFetch = (async () =>
    Response.json({
      receipt_id: `rcpt_${'r'.repeat(43)}`,
      product_id: 'layout',
      source_provider: 'gdrive',
      network: 'eip155:8453',
      payer: '0x2222222222222222222222222222222222222222',
      transaction: `0x${'c'.repeat(64)}`,
      entitlement: 'signed-entitlement',
      redeem_url: '/assets/layout/redeem',
      expires_at: '2026-08-29T13:00:00.000Z',
      filename: 'layout.psd',
      mime_type: 'image/vnd.adobe.photoshop',
      content_sha256: 'a'.repeat(64),
      content_bytes: 100,
    })) as typeof fetch;

  const result = await createAgentCashEntitlementPurchaser(
    '/opt/agentcash/bin/agentcash',
    executor,
    originalFetch,
  ).purchase({
    url: 'https://curatoria.dev/assets/layout/purchase',
    challenge,
    maxAmountAtomic: 10000,
  });

  assert.equal(result.entitlement, 'signed-entitlement');
  assert.equal('data' in result, false);
  assert.equal(calls.length, 1);
  const processCall = calls[0] as { executable: string; args: string[]; input?: string };
  assert.equal(processCall.executable, '/opt/agentcash/bin/agentcash');
  assert.equal(processCall.args[0], 'fetch');
  assert.match(processCall.args[1], /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.deepEqual(processCall.args.slice(2), [
    '--max-amount',
    '0.01',
    '--payment-protocol',
    'x402',
  ]);
  assert.equal(processCall.input, undefined);
});

test('agentcash purchaser converts a whole-dollar amount without a trailing decimal', async () => {
  const calls: unknown[] = [];
  const executor: ProcessExecutor = async request => {
    calls.push(request);
    return { stdout: JSON.stringify({ error: 'stub, unused' }), stderr: '', exitCode: 1 };
  };
  await assert.rejects(() =>
    createAgentCashEntitlementPurchaser('/opt/agentcash/bin/agentcash', executor).purchase({
      url: 'https://curatoria.dev/assets/layout/purchase',
      challenge,
      maxAmountAtomic: 2_000_000,
    }),
  );
  const processCall = calls[0] as { args: string[] };
  assert.deepEqual(processCall.args.slice(2), [
    '--max-amount',
    '2',
    '--payment-protocol',
    'x402',
  ]);
});

test('agentcash purchaser requires an absolute preinstalled executable, never npx', () => {
  assert.throws(
    () => createAgentCashEntitlementPurchaser('npx'),
    /absolute path/,
  );
});

test('agentcash purchaser rejects challenge drift before invoking the executable', async () => {
  let invoked = false;
  const executor: ProcessExecutor = async () => {
    invoked = true;
    throw new Error('must not execute');
  };
  await assert.rejects(
    () =>
      createAgentCashEntitlementPurchaser('/opt/agentcash/bin/agentcash', executor).purchase({
        url: 'https://curatoria.dev/assets/layout/purchase',
        challenge: {
          ...challenge,
          resource: {
            url: 'https://curatoria.dev/assets/layout/purchase',
            mimeType: 'image/vnd.adobe.photoshop',
          },
        },
        maxAmountAtomic: 10000,
      }),
    /application\/json/,
  );
  assert.equal(invoked, false);
});

test('external purchaser sends challenge on stdin and accepts metadata-only JSON', async () => {
  const calls: unknown[] = [];
  const executor: ProcessExecutor = async request => {
    calls.push(request);
    return {
      stdout: JSON.stringify({
        receipt_id: `rcpt_${'r'.repeat(43)}`,
        product_id: 'layout',
        source_provider: 'gdrive',
        network: 'eip155:8453',
        payer: '0x2222222222222222222222222222222222222222',
        transaction: `0x${'c'.repeat(64)}`,
        entitlement: 'mcp-entitlement',
        redeem_url: '/assets/layout/redeem',
        expires_at: '2026-08-29T13:00:00.000Z',
        filename: 'layout.psd',
        mime_type: 'image/vnd.adobe.photoshop',
        content_sha256: 'a'.repeat(64),
        content_bytes: 100,
      }),
      stderr: '',
      exitCode: 0,
    };
  };
  const purchaser = createExternalEntitlementPurchaser(
    '/usr/local/bin/coinbase-payments-bridge',
    ['--profile', 'curatoria'],
    executor,
  );

  const result = await purchaser.purchase({
    url: 'https://curatoria.dev/assets/layout/purchase',
    challenge,
    maxAmountAtomic: 10000,
  });

  assert.equal(result.entitlement, 'mcp-entitlement');
  const call = calls[0] as { input: string };
  const input = JSON.parse(call.input);
  assert.equal(input.operation, 'purchase_entitlement');
  assert.equal(input.url, 'https://curatoria.dev/assets/layout/purchase');
  assert.equal(input.max_amount_atomic, 10000);
  assert.deepEqual(input.payment_required, challenge);
});

test('isolated wallet process enforces the 1 MiB stdout and stderr limits', async () => {
  await assert.rejects(
    () =>
      executeIsolatedProcess({
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("x".repeat(1024 * 1024 + 1))'],
      }),
    /stdout exceeded the 1 MiB wallet bridge limit/,
  );
  await assert.rejects(
    () =>
      executeIsolatedProcess({
        executable: process.execPath,
        args: ['-e', 'process.stderr.write("y".repeat(1024 * 1024 + 1))'],
      }),
    /stderr exceeded the 1 MiB wallet bridge limit/,
  );
});
