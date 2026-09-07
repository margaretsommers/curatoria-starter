import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT } from '../src/paths';
import {
  assertSafeString,
  atomicWritePrivate,
  assertPrivateOutputTarget,
  deriveRepositoryState,
  parseProofReport,
  prepareProofDirectories,
  readRegularFileNoFollow,
  type ProofArtifact,
  type ProofReport,
  verifyArtifactClaims,
} from './generate-proof-report';

export type ReviewManifestInput = {
  schema_version: 1;
  review_id: string;
  generated_at: string;
  reports: string[];
};

type ReviewManifestReport = {
  path: string;
  sha256: string;
  proof_id: string;
  generated_at: string;
  repository: ProofReport['repository'];
  commands: Array<{ name: string; exit_code: number }>;
  results: ProofReport['results'];
  artifacts: ProofArtifact[];
};

export type ReviewManifest = {
  schema_version: 1;
  review_id: string;
  generated_at: string;
  reports: ReviewManifestReport[];
};

export type ReviewManifestOptions = {
  projectRoot?: string;
};

function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Review manifest input must be a JSON object.');
  }
}

function isSafeRelativeJsonPath(value: string): boolean {
  assertSafeString(value, 'reports entry');
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  return (
    value.endsWith('.json') &&
    !path.isAbsolute(value) &&
    path.posix.dirname(normalized) === '.' &&
    normalized !== '..' &&
    !normalized.startsWith('../')
  );
}

export function parseReviewManifestInput(value: unknown): ReviewManifestInput {
  assertPlainObject(value);
  const allowed = ['schema_version', 'review_id', 'generated_at', 'reports'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error('Review manifest input contains an unexpected key.');
  }
  if (value.schema_version !== 1) {
    throw new Error('Review manifest input schema_version must be 1.');
  }
  if (
    typeof value.review_id !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value.review_id)
  ) {
    throw new Error('review_id is invalid.');
  }
  if (
    typeof value.generated_at !== 'string' ||
    !Number.isFinite(Date.parse(value.generated_at)) ||
    new Date(value.generated_at).toISOString() !== value.generated_at
  ) {
    throw new Error('generated_at must be an ISO-8601 UTC timestamp.');
  }
  if (
    !Array.isArray(value.reports) ||
    value.reports.length === 0 ||
    value.reports.some((entry) => {
      if (typeof entry !== 'string') return true;
      return !isSafeRelativeJsonPath(entry);
    })
  ) {
    throw new Error('Each report path must be a relative JSON path.');
  }
  if (new Set(value.reports).size !== value.reports.length) {
    throw new Error('Report paths must be unique.');
  }
  return {
    schema_version: 1,
    review_id: value.review_id,
    generated_at: value.generated_at,
    reports: [...value.reports],
  };
}

export function generateReviewManifest(
  value: unknown,
  options: ReviewManifestOptions = {},
): string {
  const input = parseReviewManifestInput(value);
  const paths = prepareProofDirectories(options.projectRoot ?? PROJECT_ROOT);
  assertPrivateOutputTarget(paths.reportsDirectory, 'review-manifest.json');
  const repository = deriveRepositoryState(paths.projectRoot);
  const reports = input.reports.map((relativePath): ReviewManifestReport => {
    let bytes: Buffer;
    let parsed: unknown;
    try {
      bytes = readRegularFileNoFollow(
        path.join(paths.reportsDirectory, relativePath),
        `Report at index ${input.reports.indexOf(relativePath)}`,
      );
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (
        error instanceof Error &&
        /(?:Forbidden|repository\.warning|Report at index)/i.test(error.message)
      ) {
        throw error;
      }
      throw new Error(`Unable to read validated report at index ${input.reports.indexOf(relativePath)}.`);
    }
    const report = parseProofReport(parsed);
    const artifacts = verifyArtifactClaims(report.artifacts, paths.projectRoot);
    if (
      report.repository.commit !== repository.commit ||
      report.repository.dirty !== repository.dirty
    ) {
      throw new Error('Report repository claim does not match current Git state.');
    }
    return {
      path: relativePath.replaceAll('\\', '/'),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      proof_id: report.proof_id,
      generated_at: report.generated_at,
      repository: report.repository,
      commands: report.commands.map(({ name, exit_code }) => ({ name, exit_code })),
      results: report.results,
      artifacts,
    };
  });

  const manifest: ReviewManifest = {
    schema_version: 1,
    review_id: input.review_id,
    generated_at: input.generated_at,
    reports,
  };
  return atomicWritePrivate(
    paths.reportsDirectory,
    'review-manifest.json',
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (require.main === module) {
  try {
    const inputPath = argumentValue('--input');
    if (!inputPath) throw new Error('Usage requires --input <structured-json-file>.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
    } catch {
      throw new Error('Unable to read valid structured JSON input.');
    }
    if (process.argv.includes('--reports-dir') || process.argv.includes('--output')) {
      throw new Error('Custom report or output directories are not supported.');
    }
    const generated = generateReviewManifest(parsed);
    console.log(`Generated review manifest ${path.basename(generated)}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Review manifest generation failed.');
    process.exitCode = 1;
  }
}
