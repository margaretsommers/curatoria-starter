/**
 * smoke.ts — local smoke checks for demo readiness.
 *
 * Usage:
 *   npm run smoke
 *
 * Optional env:
 *   BASE_URL=http://localhost:3000
 */

import { runSmokeChecks } from './smoke-checks';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

async function run(): Promise<void> {
  const checks = await runSmokeChecks(BASE_URL);

  const failures = checks.filter((check) => !check.ok);
  for (const check of checks) {
    const prefix = check.ok ? 'PASS' : 'FAIL';
    console.log(`${prefix}  ${check.name} — ${check.detail}`);
  }

  if (failures.length > 0) {
    process.exitCode = 1;
    return;
  }

  console.log('\nSmoke checks passed.');
}

run().catch((err) => {
  console.error(`Smoke checks failed with unexpected error: ${String(err)}`);
  process.exit(1);
});
