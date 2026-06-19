/**
 * bug-bash.ts — ordered obvious-error checks for operator + production.
 *
 * Usage:
 *   npm run bug-bash                 # prod + human (no local server needed)
 *   npm run bug-bash -- --local      # local service checks (dev server must be running)
 *   npm run bug-bash -- --paid       # opt-in paid x402 proof (requires AWAL_PAID_TEST=1)
 *   npm run bug-bash -- --all        # build + local + prod + human
 *   npm run bug-bash -- --starter    # also smoke the sibling curatoria-starter clone
 *
 * Optional env:
 *   BASE_URL=http://localhost:3000
 *   PROD_URL=https://yourdomain.com
 *   STARTER_DIR=../curatoria-starter
 *   AWAL_PAID_TEST=1
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  checkHumanPages,
  checkWellKnownSanity,
  runPaidChecks,
  runSmokeChecks,
  type CheckResult,
} from './smoke-checks';

const LOCAL_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const PROD_URL = process.env.PROD_URL ?? 'https://yourdomain.com';
const ROOT_DIR = path.resolve(__dirname, '..');
const STARTER_DIR = process.env.STARTER_DIR ?? path.resolve(ROOT_DIR, '../curatoria-starter');

type PhaseResult = { phase: string; checks: CheckResult[] };

const args = new Set(process.argv.slice(2));
const runPaid = args.has('--paid');
const runLocal = args.has('--local') || args.has('--all');
const runProd = args.has('--prod') || args.has('--all') || args.size === 0 || (runPaid && !runLocal);
const runHuman = args.has('--human') || args.has('--all') || args.size === 0;
const runStarter = args.has('--starter') || args.has('--all');
const runBuild = args.has('--all');
const skipBuild = args.has('--skip-build');

async function main(): Promise<void> {
  console.log('Curatoria bug bash — obvious errors first. Stop and fix on first FAIL.\n');

  const phases: PhaseResult[] = [];

  if (runBuild && !skipBuild) {
    phases.push(await runBuildPhase());
  }

  if (runLocal) {
    phases.push(await runServicePhase('local service', LOCAL_URL, { requireReachable: true }));
    phases.push(await runCatalogSanityPhase(LOCAL_URL));
  }

  if (runProd) {
    phases.push(await runServicePhase('production service', PROD_URL));
    phases.push(await runCatalogSanityPhase(PROD_URL));
  }

  if (runPaid) {
    if (runLocal) {
      phases.push(await runPaidPhase('local paid proof', LOCAL_URL));
    }
    if (runProd) {
      phases.push(await runPaidPhase('production paid proof', PROD_URL));
    }
  }

  if (runHuman) {
    phases.push(await runHumanPhase(PROD_URL));
  }

  if (runStarter) {
    phases.push(await runStarterPhase());
  }

  printSummary(phases);

  const failures = phases.flatMap((phase) => phase.checks).filter((check) => !check.ok);
  if (failures.length > 0) {
    console.log('\nNext: fix the first FAIL above, then rerun the same command.');
    process.exitCode = 1;
  } else {
    console.log('\nObvious checks passed. Edge cases (paid settlement, export drift) come next.');
  }
}

async function runBuildPhase(): Promise<PhaseResult> {
  console.log('=== Phase: build ===');
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: ROOT_DIR,
    stdio: 'pipe',
    encoding: 'utf8',
  });

  const check: CheckResult = {
    name: 'typescript build',
    ok: result.status === 0,
    detail: result.status === 0 ? 'npm run build succeeded' : trimOutput(result.stderr || result.stdout),
  };
  printCheck(check);
  return { phase: 'build', checks: [check] };
}

async function runServicePhase(
  label: string,
  baseUrl: string,
  options: { requireReachable?: boolean } = {},
): Promise<PhaseResult> {
  console.log(`\n=== Phase: ${label} (${baseUrl}) ===`);

  if (options.requireReachable) {
    const reachable = await isReachable(`${baseUrl}/health`);
    if (!reachable) {
      const check: CheckResult = {
        name: 'service reachable',
        ok: false,
        detail: `no response at ${baseUrl}. In another terminal run: npm run dev`,
      };
      printCheck(check);
      return { phase: label, checks: [check] };
    }
  }

  const checks = await runSmokeChecks(baseUrl);
  for (const check of checks) {
    printCheck(check);
  }
  return { phase: label, checks };
}

async function runCatalogSanityPhase(baseUrl: string): Promise<PhaseResult> {
  console.log(`\n=== Phase: catalog sanity (${baseUrl}) ===`);
  const checks = await checkWellKnownSanity(baseUrl);
  for (const check of checks) {
    printCheck(check);
  }
  return { phase: 'catalog sanity', checks };
}

async function runPaidPhase(label: string, baseUrl: string): Promise<PhaseResult> {
  console.log(`\n=== Phase: ${label} (${baseUrl}) ===`);
  try {
    const checks = await runPaidChecks(baseUrl);
    for (const check of checks) {
      printCheck(check);
    }
    return { phase: label, checks };
  } catch (err) {
    const check: CheckResult = {
      name: 'paid proof setup',
      ok: false,
      detail: String(err instanceof Error ? err.message : err),
    };
    printCheck(check);
    return { phase: label, checks: [check] };
  }
}

async function runHumanPhase(baseUrl: string): Promise<PhaseResult> {
  console.log(`\n=== Phase: human pages (${baseUrl}) ===`);
  const checks = await checkHumanPages(baseUrl);
  for (const check of checks) {
    printCheck(check);
  }

  console.log('\nHuman eyeball (30 seconds):');
  console.log('  1. Open the home page — hero and CTA look right.');
  console.log('  2. Open docs — starter GitHub link points to margaretsommers/curatoria-starter.');
  console.log('  3. Skim well-known catalog JSON — design_systems[] with names, prices, access_url.');

  return { phase: 'human pages', checks };
}

async function runStarterPhase(): Promise<PhaseResult> {
  console.log(`\n=== Phase: starter clone (${STARTER_DIR}) ===`);

  if (!existsSync(path.join(STARTER_DIR, 'package.json'))) {
    const check: CheckResult = {
      name: 'starter directory',
      ok: false,
      detail: `missing ${STARTER_DIR}. Run: scripts/export-starter.sh --force`,
    };
    printCheck(check);
    return { phase: 'starter clone', checks: [check] };
  }

  const result = spawnSync('npm', ['run', 'smoke'], {
    cwd: STARTER_DIR,
    env: { ...process.env, BASE_URL: LOCAL_URL },
    stdio: 'pipe',
    encoding: 'utf8',
  });

  const check: CheckResult = {
    name: 'starter smoke',
    ok: result.status === 0,
    detail:
      result.status === 0
        ? `smoke passed against ${LOCAL_URL}`
        : trimOutput(result.stdout || result.stderr),
  };
  printCheck(check);

  if (!check.ok) {
    console.log('  Hint: starter smoke needs the operator dev server on the same BASE_URL.');
  }

  return { phase: 'starter clone', checks: [check] };
}

function printSummary(phases: PhaseResult[]): void {
  console.log('\n=== Summary ===');
  for (const phase of phases) {
    const passed = phase.checks.filter((check) => check.ok).length;
    const total = phase.checks.length;
    const status = passed === total ? 'PASS' : 'FAIL';
    console.log(`${status}  ${phase.phase} — ${passed}/${total}`);
  }
}

function printCheck(check: CheckResult): void {
  const prefix = check.ok ? 'PASS' : 'FAIL';
  console.log(`${prefix}  ${check.name} — ${check.detail}`);
}

async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.status > 0;
  } catch {
    return false;
  }
}

function trimOutput(text: string): string {
  return text.trim().split('\n').slice(-3).join(' | ').slice(0, 240);
}

main().catch((err) => {
  console.error(`Bug bash failed with unexpected error: ${String(err)}`);
  process.exit(1);
});
