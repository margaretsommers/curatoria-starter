import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  generateProofReport,
  type ProofInput,
} from '../scripts/generate-proof-report';
import {
  generateReviewManifest,
  parseReviewManifestInput,
} from '../scripts/generate-review-manifest';

const testWorkspace = path.join(__dirname, '..', '.proof');
fs.mkdirSync(testWorkspace, { recursive: true, mode: 0o700 });
const projectRoot = path.join(__dirname, '..');
const evidenceWorkspace = path.join(testWorkspace, 'evidence');
fs.mkdirSync(evidenceWorkspace, { recursive: true, mode: 0o700 });
const processWorkspace = fs.mkdtempSync(
  path.join(evidenceWorkspace, 'review-manifest-tests-'),
);
const runId = path.basename(processWorkspace);
const reportsDirectory = path.join(testWorkspace, 'reports');
fs.mkdirSync(reportsDirectory, { recursive: true, mode: 0o700 });
const reviewManifestPath = path.join(reportsDirectory, 'review-manifest.json');
function removeEntry(filePath: string): void {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      fs.rmSync(filePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
let initialManifestStat: fs.Stats | undefined;
try {
  initialManifestStat = fs.lstatSync(reviewManifestPath);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
if (initialManifestStat?.isSymbolicLink()) {
  removeEntry(reviewManifestPath);
  initialManifestStat = undefined;
}
const previousManifest = initialManifestStat?.isFile()
  ? {
      bytes: fs.readFileSync(reviewManifestPath),
      mode: initialManifestStat.mode & 0o777,
    }
  : undefined;
process.once('exit', () => {
  try {
    removeEntry(processWorkspace);
    for (const entry of fs.readdirSync(reportsDirectory)) {
      if (entry.includes(runId)) removeEntry(path.join(reportsDirectory, entry));
    }
    removeEntry(reviewManifestPath);
    if (previousManifest) {
      fs.writeFileSync(reviewManifestPath, previousManifest.bytes, {
        mode: previousManifest.mode,
      });
    }
  } catch {
    // Cleanup must not mask test results.
  }
});

function makeEvidence(name: string): { artifactPath: string; relativePath: string; artifact: Buffer } {
  const artifactPath = path.join(processWorkspace, name);
  const artifact = Buffer.from('8BPS review fixture');
  fs.writeFileSync(artifactPath, artifact);
  return {
    artifactPath,
    relativePath: path.relative(projectRoot, artifactPath),
    artifact,
  };
}

function proofInput(proofId: string, artifact: Buffer, artifactPath: string): ProofInput {
  return {
    schema_version: 1,
    proof_id: proofId,
    generated_at: '2026-08-29T20:00:00.000Z',
    commands: [
      {
        name: 'build',
        command: 'npm run build',
        exit_code: 0,
      },
    ],
    results: [{ name: 'build', status: 'pass' }],
    artifacts: [
      {
        path: artifactPath,
        sha256: crypto.createHash('sha256').update(artifact).digest('hex'),
        bytes: artifact.byteLength,
      },
    ],
  };
}

test('review manifest inventories validated reports and their exact hashes', () => {
  const evidence = makeEvidence('inventory.psd');
  const proofId = `proof-inventory-${runId}`;
  const report = generateProofReport(
    proofInput(proofId, evidence.artifact, evidence.relativePath),
    {
      projectRoot,
    },
  );
  const input = {
    schema_version: 1 as const,
    review_id: 'paid-psd-local-review',
    generated_at: '2026-08-29T20:05:00.000Z',
    reports: [path.basename(report.jsonPath)],
  };

  const generated = generateReviewManifest(input, { projectRoot });
  const manifest = JSON.parse(fs.readFileSync(generated, 'utf8')) as {
    review_id: string;
    reports: Array<{
      path: string;
      sha256: string;
      proof_id: string;
      repository: { commit: string; dirty: boolean };
      commands: Array<{ name: string; exit_code: number }>;
      results: Array<{ name: string; status: string }>;
      artifacts: Array<{ path: string; sha256: string; bytes: number }>;
    }>;
  };

  assert.equal(manifest.review_id, input.review_id);
  assert.equal(manifest.reports[0].path, path.basename(report.jsonPath));
  assert.equal(
    manifest.reports[0].sha256,
    crypto.createHash('sha256').update(fs.readFileSync(report.jsonPath)).digest('hex'),
  );
  assert.equal(manifest.reports[0].proof_id, proofId);
  assert.equal(
    manifest.reports[0].repository.commit,
    spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).stdout.trim(),
  );
  assert.deepEqual(manifest.reports[0].commands, [{ name: 'build', exit_code: 0 }]);
  assert.deepEqual(manifest.reports[0].results, [{ name: 'build', status: 'pass' }]);
  assert.deepEqual(
    manifest.reports[0].artifacts,
    proofInput(proofId, evidence.artifact, evidence.relativePath).artifacts,
  );
  assert.equal(fs.statSync(generated).mode & 0o777, 0o600);
});

test('review manifest rejects encoded paths and unvalidated report data', () => {
  const evidence = makeEvidence('invalid.psd');
  const directory = reportsDirectory;
  const secret = 'do-not-print-review-secret';
  const invalidName = `invalid-${runId}.json`;
  const reportPath = path.join(directory, invalidName);
  fs.writeFileSync(
    reportPath,
    JSON.stringify({
      ...proofInput('proof-invalid', evidence.artifact, evidence.relativePath),
      entitlement: secret,
    }),
  );

  assert.throws(
    () =>
      generateReviewManifest(
        {
          schema_version: 1,
          review_id: 'review-invalid',
          generated_at: '2026-08-29T20:05:00.000Z',
          reports: [invalidName],
        },
        { projectRoot },
      ),
    (error: Error) => {
      assert.match(error.message, /forbidden key/i);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );

  assert.throws(
    () =>
      parseReviewManifestInput({
        schema_version: 1,
        review_id: 'review-invalid',
        generated_at: '2026-08-29T20:05:00.000Z',
        reports: ['../outside.json'],
      }),
    /report path/i,
  );

  const privateUrl = 'https://provider.example/private?token=secret';
  for (const encodedPath of [
    `${encodeURIComponent(privateUrl)}.json`,
    `${Buffer.from(privateUrl).toString('base64url')}.json`,
  ]) {
    assert.throws(
      () =>
        parseReviewManifestInput({
          schema_version: 1,
          review_id: 'review-invalid',
          generated_at: '2026-08-29T20:05:00.000Z',
          reports: [encodedPath],
        }),
      (error: Error) => {
        assert.equal(error.message.includes(encodedPath), false);
        return /forbidden content/i.test(error.message);
      },
    );
  }

  assert.throws(
    () =>
      parseReviewManifestInput({
        schema_version: 1,
        review_id: 'review-invalid',
        generated_at: '2026-08-29T20:05:00.000Z',
        reports: ['safe\rname.json'],
      }),
    /control character/i,
  );
});

test('review manifest independently rejects changed artifact bytes and symlink reports', () => {
  const evidence = makeEvidence('recheck.psd');
  const proofId = `proof-recheck-${runId}`;
  const report = generateProofReport(
    proofInput(proofId, evidence.artifact, evidence.relativePath),
    { projectRoot },
  );
  fs.writeFileSync(evidence.artifactPath, 'changed after report');
  const input = {
    schema_version: 1 as const,
    review_id: 'review-recheck',
    generated_at: '2026-08-29T20:05:00.000Z',
    reports: [path.basename(report.jsonPath)],
  };
  assert.throws(
    () => generateReviewManifest(input, { projectRoot }),
    /artifact claim/i,
  );

  fs.writeFileSync(evidence.artifactPath, evidence.artifact);
  const linkedName = `linked-${runId}.json`;
  const linked = path.join(path.dirname(report.jsonPath), linkedName);
  fs.symlinkSync(report.jsonPath, linked);
  assert.throws(
    () =>
      generateReviewManifest(
        { ...input, reports: [linkedName] },
        { projectRoot },
      ),
    /report.*symlink/i,
  );
});

test('review manifest output rejects an existing symlink without changing its target', () => {
  const evidence = makeEvidence('output.psd');
  const proofId = `proof-output-${runId}`;
  const report = generateProofReport(
    proofInput(proofId, evidence.artifact, evidence.relativePath),
    { projectRoot },
  );
  const outputPath = path.join(path.dirname(report.jsonPath), 'review-manifest.json');
  fs.rmSync(outputPath, { force: true });
  const outside = path.join(processWorkspace, 'outside-target');
  fs.mkdirSync(path.dirname(outside), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outside, 'preserve', { mode: 0o640 });
  fs.symlinkSync(outside, outputPath);
  assert.throws(
    () =>
      generateReviewManifest(
        {
          schema_version: 1,
          review_id: 'review-output',
          generated_at: '2026-08-29T20:05:00.000Z',
          reports: [path.basename(report.jsonPath)],
        },
        { projectRoot },
      ),
    /output target.*symlink/i,
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), 'preserve');
  assert.equal(fs.statSync(outside).mode & 0o777, 0o640);
  removeEntry(outputPath);
});
