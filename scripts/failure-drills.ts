/**
 * Injected paid-PSD failure drills. Local harness only. Never spends, never
 * deploys, and never executes rollback.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { refuseExecutedRollback } from './prepare-rollback-packet';
import { runInjectedFailure, type PreviewFault } from '../src/paid-psd-harness';

const DRILLS: Array<Exclude<PreviewFault, 'none'>> = [
  'blob_failure',
  'signing_failure',
  'url_expiry',
  'disconnect',
  'disk_full',
  'receipt_write_failure',
];

export async function runFailureDrills(argv: string[] = process.argv): Promise<{
  ok: boolean;
  results: Array<{ fault: string; observed: string; status?: number }>;
}> {
  refuseExecutedRollback(argv);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-failure-drills-'));
  const results: Array<{ fault: string; observed: string; status?: number }> = [];
  try {
    for (const fault of DRILLS) {
      const result = await runInjectedFailure(fault, workspace);
      results.push({
        fault: result.fault,
        observed: result.observed,
        ...(result.status !== undefined ? { status: result.status } : {}),
      });
    }
    return { ok: results.every(result => result.observed === result.fault), results };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

if (require.main === module) {
  refuseExecutedRollback(process.argv);
  runFailureDrills(process.argv)
    .then(report => {
      console.log(JSON.stringify({ kind: 'failure_drills', rollback_executed: false, ...report }, null, 2));
      if (!report.ok) process.exitCode = 1;
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : 'Failure drills failed.');
      process.exitCode = 1;
    });
}
