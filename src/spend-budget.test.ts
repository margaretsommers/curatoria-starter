import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_PER_CALL_CAP_ATOMIC,
  DEFAULT_SESSION_CAP_ATOMIC,
  SpendBudget,
  SpendBudgetError,
  fingerprintPaymentChallenge,
  writeOwnerOnlyJson,
} from './spend-budget';

const FINGERPRINT = fingerprintPaymentChallenge({
  resourceUrl: 'https://curatoria.dev/assets/layout/purchase',
  amount: '10000',
  network: 'eip155:8453',
  asset: '0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x8aa327403ED786cA56EB8F59C6c8831A8BD73485',
});

async function tempBudget(): Promise<{ budget: SpendBudget; filePath: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-spend-'));
  const filePath = path.join(directory, 'session-budget.json');
  const budget = await SpendBudget.open(filePath);
  return { budget, filePath };
}

test('first four one-cent reservations succeed and the fifth fails before more spend', async () => {
  const { budget, filePath } = await tempBudget();
  assert.equal(await budget.remaining(), DEFAULT_SESSION_CAP_ATOMIC);
  for (let index = 1; index <= 4; index += 1) {
    const reserved = await budget.reserve(
      `attempt-000${index}`,
      DEFAULT_PER_CALL_CAP_ATOMIC,
      fingerprintPaymentChallenge({
        resourceUrl: `https://curatoria.dev/assets/p${index}/purchase`,
        amount: '10000',
        network: 'eip155:8453',
        asset: '0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x8aa327403ED786cA56EB8F59C6c8831A8BD73485',
      }),
    );
    assert.equal(reserved.status, 'pending');
    assert.equal(await budget.remaining(), DEFAULT_SESSION_CAP_ATOMIC - index * DEFAULT_PER_CALL_CAP_ATOMIC);
  }
  await assert.rejects(
    () => budget.reserve('attempt-0005', DEFAULT_PER_CALL_CAP_ATOMIC, FINGERPRINT),
    (error: unknown) =>
      error instanceof SpendBudgetError &&
      error.code === 'session_budget_exhausted',
  );
  assert.equal(await budget.remaining(), 0);
  const stat = await fs.stat(filePath);
  assert.equal(stat.mode & 0o777, 0o600);
});

test('inconclusive consumes budget and proven pre-settlement failure releases it', async () => {
  const { budget } = await tempBudget();
  await budget.reserve('attempt-inconclusive', 10000, FINGERPRINT);
  await budget.markInconclusive('attempt-inconclusive');
  assert.equal(await budget.remaining(), 30000);

  const other = fingerprintPaymentChallenge({
    resourceUrl: 'https://curatoria.dev/assets/other/purchase',
    amount: '10000',
    network: 'eip155:8453',
    asset: '0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: '0x8aa327403ED786cA56EB8F59C6c8831A8BD73485',
  });
  await budget.reserve('attempt-release', 10000, other);
  assert.equal(await budget.remaining(), 20000);
  await budget.releaseBeforeSettlement('attempt-release');
  assert.equal(await budget.remaining(), 30000);
  await assert.rejects(
    () => budget.releaseBeforeSettlement('attempt-inconclusive'),
    (error: unknown) =>
      error instanceof SpendBudgetError && error.code === 'not_pre_settlement',
  );
});

test('duplicate invocation cannot double-commit or double-reserve', async () => {
  const { budget } = await tempBudget();
  const first = await budget.reserve('attempt-same', 10000, FINGERPRINT);
  const again = await budget.reserve('attempt-same', 10000, FINGERPRINT);
  assert.equal(again.reserved_at, first.reserved_at);
  assert.equal(await budget.remaining(), 30000);

  const receipt = {
    receipt_id: `rcpt_${'r'.repeat(43)}`,
    transaction: `0x${'a'.repeat(64)}`,
    payer: '0x1111111111111111111111111111111111111111',
    network: 'eip155:8453',
  };
  const committed = await budget.commit('attempt-same', receipt);
  await budget.commit('attempt-same', {
    ...receipt,
    transaction: `0x${'b'.repeat(64)}`,
  });
  assert.equal(await budget.remaining(), 30000);
  assert.equal(committed.status, 'committed');
  assert.equal(committed.receipt?.transaction, receipt.transaction);
});

test('per-call cap rejects amounts above one cent', async () => {
  const { budget } = await tempBudget();
  await assert.rejects(
    () => budget.reserve('attempt-over', 10001, FINGERPRINT),
    (error: unknown) =>
      error instanceof SpendBudgetError && error.code === 'per_call_cap_exceeded',
  );
  assert.equal(await budget.remaining(), 40000);
});

test('atomic owner-only JSON write uses temp flush rename and directory sync', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-json-'));
  const filePath = path.join(directory, 'purchase-context.json');
  await writeOwnerOnlyJson(filePath, { version: 1, attempt_id: 'attempt-context' });
  const stat = await fs.stat(filePath);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), {
    version: 1,
    attempt_id: 'attempt-context',
  });
});

test('relative budget paths are rejected', async () => {
  await assert.rejects(
    () => SpendBudget.open('session-budget.json'),
    /absolute path/,
  );
});
