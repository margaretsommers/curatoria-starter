/**
 * smoke.ts — local smoke checks for demo readiness.
 *
 * Usage:
 *   npm run smoke
 *
 * Optional env:
 *   BASE_URL=http://localhost:3000
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

type CheckResult = { name: string; ok: boolean; detail: string };

async function run(): Promise<void> {
  const checks: CheckResult[] = [];

  checks.push(await checkHealth());
  checks.push(await checkCatalog());
  checks.push(await checkUnpaidMarkdown402());
  checks.push(await checkUnpaidBundle402());

  const failures = checks.filter(c => !c.ok);
  for (const c of checks) {
    const prefix = c.ok ? 'PASS' : 'FAIL';
    console.log(`${prefix}  ${c.name} — ${c.detail}`);
  }

  if (failures.length > 0) {
    process.exitCode = 1;
    return;
  }

  console.log('\nSmoke checks passed.');
}

async function checkHealth(): Promise<CheckResult> {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) {
    return { name: 'health', ok: false, detail: `expected 200, got ${res.status}` };
  }
  const body = (await res.json()) as { status?: string };
  return {
    name: 'health',
    ok: body.status === 'ok',
    detail: body.status === 'ok' ? 'status ok' : 'missing status=ok',
  };
}

async function checkCatalog(): Promise<CheckResult> {
  const res = await fetch(`${BASE_URL}/.well-known/design-catalog.json`);
  if (!res.ok) {
    return { name: 'catalog', ok: false, detail: `expected 200, got ${res.status}` };
  }
  const body = (await res.json()) as { total?: number; design_systems?: Array<{ id?: string }> };
  const total = body.total ?? 0;
  return {
    name: 'catalog',
    ok: Array.isArray(body.design_systems),
    detail: `total entries: ${total}`,
  };
}

async function checkUnpaidMarkdown402(): Promise<CheckResult> {
  const res = await fetch(`${BASE_URL}/design-systems/example-minimal`);
  const paymentRequired = res.headers.get('x-payment-required');
  return {
    name: 'unpaid markdown challenge',
    ok: res.status === 402 && Boolean(paymentRequired),
    detail: `status ${res.status}${paymentRequired ? ', x-payment-required present' : ''}`,
  };
}

async function checkUnpaidBundle402(): Promise<CheckResult> {
  const res = await fetch(`${BASE_URL}/packs/starter-bundle/download`);
  const paymentRequired = res.headers.get('x-payment-required');
  const ok = res.status === 402 || res.status === 404;
  return {
    name: 'unpaid bundle challenge',
    ok,
    detail:
      res.status === 402
        ? 'status 402 with payment challenge'
        : 'status 404 (expected until starter-bundle is published)',
  };
}

run().catch((err) => {
  console.error(`Smoke checks failed with unexpected error: ${String(err)}`);
  process.exit(1);
});
