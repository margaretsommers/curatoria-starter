import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT } from '../src/paths';

export type ProofCommand = {
  name: string;
  command: string;
  exit_code: number;
  duration_ms?: number;
};

export type ProofResult = {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
};

export type ProofArtifact = {
  path: string;
  sha256: string;
  bytes: number;
};

export type ProofInput = {
  schema_version: 1;
  proof_id: string;
  generated_at: string;
  commands: ProofCommand[];
  results: ProofResult[];
  artifacts: ProofArtifact[];
};

export type ProofReport = ProofInput & {
  repository: {
    commit: string;
    dirty: boolean;
    warning: string | null;
  };
};

export type ProofGenerationOptions = {
  projectRoot?: string;
};

const FORBIDDEN_KEY_PARTS = [
  'apikey',
  'authorization',
  'credential',
  'downloadurl',
  'entitlement',
  'mnemonic',
  'password',
  'paymentproof',
  'paymentsignature',
  'privatekey',
  'providerurl',
  'seedphrase',
  'signedurl',
  'sourceurl',
  'token',
  'walletsecret',
];

const FORBIDDEN_CONTENT = [
  /(?:https?|s3):\/\//i,
  /\bauthorization\s*:\s*(?:bearer|basic)\b/i,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:api[_ -]?key|private[_ -]?key|seed[_ -]?phrase|mnemonic|password|token)\s*[:=]/i,
  /\b[A-Z][A-Z0-9_]*(?:API_KEY|PRIVATE_KEY|SECRET|TOKEN)\s*=/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
];

const MAX_SAFE_STRING_BYTES = 8 * 1024;
const MAX_CANONICAL_VARIANTS = 16;
const MAX_CANONICAL_DEPTH = 3;
const MAX_STRUCTURE_DEPTH = 16;
const MAX_STRUCTURE_NODES = 10_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const BASE64_CANDIDATE = /[A-Za-z0-9+/_-]{16,}={0,2}/g;

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function decodeBase64Candidate(candidate: string): string | undefined {
  if (candidate.length > MAX_SAFE_STRING_BYTES || candidate.length % 4 === 1) return undefined;
  const normalized = candidate.replaceAll('-', '+').replaceAll('_', '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return undefined;
  try {
    const bytes = Buffer.from(
      normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='),
      'base64',
    );
    if (bytes.length === 0 || bytes.length > MAX_SAFE_STRING_BYTES) return undefined;
    const decoded = bytes.toString('utf8');
    if (decoded.includes('\ufffd')) return undefined;
    const printable = [...decoded].filter(
      (character) => !CONTROL_CHARACTERS.test(character),
    ).length;
    return printable / decoded.length >= 0.8 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function canonicalStringVariants(value: string): string[] {
  if (Buffer.byteLength(value, 'utf8') > MAX_SAFE_STRING_BYTES) {
    throw new Error('Proof string exceeds the bounded inspection limit.');
  }
  const variants = new Set<string>([value]);
  let frontier = [value];
  for (let depth = 0; depth < MAX_CANONICAL_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      const decodedValues: string[] = [];
      try {
        const percentDecoded = decodeURIComponent(current);
        if (percentDecoded !== current) decodedValues.push(percentDecoded);
      } catch {
        // Invalid percent encoding stays in its raw form for pattern checks.
      }
      const wholeBase64 = decodeBase64Candidate(current);
      if (wholeBase64) decodedValues.push(wholeBase64);
      for (const match of current.matchAll(BASE64_CANDIDATE)) {
        const decoded = decodeBase64Candidate(match[0]);
        if (decoded) decodedValues.push(decoded);
      }
      for (const decoded of decodedValues) {
        if (
          Buffer.byteLength(decoded, 'utf8') <= MAX_SAFE_STRING_BYTES &&
          !variants.has(decoded) &&
          variants.size < MAX_CANONICAL_VARIANTS
        ) {
          variants.add(decoded);
          next.push(decoded);
        }
      }
    }
    frontier = next;
  }
  return [...variants];
}

export function assertSafeString(value: string, location: string): void {
  for (const variant of canonicalStringVariants(value)) {
    if (CONTROL_CHARACTERS.test(variant)) {
      throw new Error(`Control character detected at ${location}; value was redacted.`);
    }
    if (FORBIDDEN_CONTENT.some((pattern) => pattern.test(variant))) {
      throw new Error(`Forbidden content detected at ${location}; value was redacted.`);
    }
  }
}

export function assertSafeStructuredData(value: unknown, location = '$'): void {
  let nodes = 0;
  const inspect = (entry: unknown, current: string, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_STRUCTURE_NODES || depth > MAX_STRUCTURE_DEPTH) {
      throw new Error('Proof input exceeds bounded inspection limits.');
    }
    if (typeof entry === 'string') {
      assertSafeString(entry, current);
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => inspect(item, `${current}[${index}]`, depth + 1));
      return;
    }
    if (entry !== null && typeof entry === 'object') {
      for (const [key, item] of Object.entries(entry)) {
        const keyVariants = canonicalStringVariants(key);
        if (
          keyVariants.some((variant) =>
            FORBIDDEN_KEY_PARTS.some((part) => normalizedKey(variant).includes(part)),
          )
        ) {
          throw new Error(`Forbidden key detected at ${current}; value was redacted.`);
        }
        keyVariants.forEach((variant) => assertSafeString(variant, `${current}.key`));
        inspect(item, `${current}.field`, depth + 1);
      }
    }
  };
  inspect(value, location, 0);
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains an unexpected key.`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertIsoTimestamp(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label);
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp.`);
  }
}

function assertRelativePath(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label);
  for (const variant of canonicalStringVariants(value)) {
    const normalized = path.posix.normalize(variant.replaceAll('\\', '/'));
    if (path.isAbsolute(variant) || normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`${label} must be a repository-relative path.`);
    }
  }
}

export function parseProofInput(value: unknown): ProofInput {
  assertSafeStructuredData(value);
  assertPlainObject(value, 'Proof input');
  assertExactKeys(
    value,
    ['schema_version', 'proof_id', 'generated_at', 'commands', 'results', 'artifacts'],
    'Proof input',
  );
  if (value.schema_version !== 1) {
    throw new Error('Proof input schema_version must be 1.');
  }
  assertNonEmptyString(value.proof_id, 'proof_id');
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value.proof_id)) {
    throw new Error('proof_id contains unsupported characters.');
  }
  assertIsoTimestamp(value.generated_at, 'generated_at');

  if (!Array.isArray(value.commands)) throw new Error('commands must be an array.');
  const commands = value.commands.map((entry, index): ProofCommand => {
    assertPlainObject(entry, `commands[${index}]`);
    assertExactKeys(entry, ['name', 'command', 'exit_code', 'duration_ms'], `commands[${index}]`);
    assertNonEmptyString(entry.name, `commands[${index}].name`);
    assertNonEmptyString(entry.command, `commands[${index}].command`);
    if (!Number.isInteger(entry.exit_code)) {
      throw new Error(`commands[${index}].exit_code must be an integer.`);
    }
    if (
      entry.duration_ms !== undefined &&
      (!Number.isInteger(entry.duration_ms) || (entry.duration_ms as number) < 0)
    ) {
      throw new Error(`commands[${index}].duration_ms must be a non-negative integer.`);
    }
    return {
      name: entry.name,
      command: entry.command,
      exit_code: entry.exit_code as number,
      ...(entry.duration_ms === undefined ? {} : { duration_ms: entry.duration_ms as number }),
    };
  });

  if (!Array.isArray(value.results)) throw new Error('results must be an array.');
  const results = value.results.map((entry, index): ProofResult => {
    assertPlainObject(entry, `results[${index}]`);
    assertExactKeys(entry, ['name', 'status', 'detail'], `results[${index}]`);
    assertNonEmptyString(entry.name, `results[${index}].name`);
    if (entry.status !== 'pass' && entry.status !== 'fail' && entry.status !== 'skip') {
      throw new Error(`results[${index}].status must be pass, fail, or skip.`);
    }
    if (entry.detail !== undefined) assertNonEmptyString(entry.detail, `results[${index}].detail`);
    return {
      name: entry.name,
      status: entry.status,
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    };
  });

  if (!Array.isArray(value.artifacts)) throw new Error('artifacts must be an array.');
  const artifacts = value.artifacts.map((entry, index): ProofArtifact => {
    assertPlainObject(entry, `artifacts[${index}]`);
    assertExactKeys(entry, ['path', 'sha256', 'bytes'], `artifacts[${index}]`);
    assertRelativePath(entry.path, `artifacts[${index}].path`);
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      throw new Error(`artifacts[${index}].sha256 must be a complete SHA-256 digest.`);
    }
    if (!Number.isInteger(entry.bytes) || (entry.bytes as number) < 0) {
      throw new Error(`artifacts[${index}].bytes must be a non-negative integer.`);
    }
    return {
      path: entry.path,
      sha256: entry.sha256.toLowerCase(),
      bytes: entry.bytes as number,
    };
  });

  return {
    schema_version: 1,
    proof_id: value.proof_id,
    generated_at: value.generated_at,
    commands,
    results,
    artifacts,
  };
}

export function parseProofReport(value: unknown): ProofReport {
  assertSafeStructuredData(value);
  assertPlainObject(value, 'Proof report');
  assertPlainObject(value.repository, 'repository');
  assertExactKeys(value.repository, ['commit', 'dirty', 'warning'], 'repository');
  if (
    value.repository.warning !== null &&
    typeof value.repository.warning !== 'string'
  ) {
    throw new Error('repository.warning must be a string or null.');
  }
  const { repository: _repository, ...proofFields } = value;
  const input = parseProofInput(proofFields);
  if (typeof value.repository.commit !== 'string' || !/^[a-f0-9]{40}$/i.test(value.repository.commit)) {
    throw new Error('repository.commit must be a full 40-character Git commit.');
  }
  if (typeof value.repository.dirty !== 'boolean') {
    throw new Error('repository.dirty must be boolean.');
  }
  const expectedWarning = value.repository.dirty
    ? 'WARNING: generated from a dirty working tree; review the diff with this report.'
    : null;
  if (value.repository.warning !== expectedWarning) {
    throw new Error('repository.warning does not match repository.dirty.');
  }
  return {
    ...input,
    repository: {
      commit: value.repository.commit.toLowerCase(),
      dirty: value.repository.dirty,
      warning: expectedWarning,
    },
  };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function checkedProjectRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Project root must be a non-symlink directory.');
  }
  return fs.realpathSync(resolved);
}

function assertNoSymlinkComponents(root: string, candidate: string, label: string): void {
  if (!isWithin(root, candidate)) throw new Error(`${label} escapes its approved root.`);
  const relative = path.relative(root, candidate);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`${label} contains a symlink component.`);
    }
  }
}

function ensurePrivateDirectory(root: string, directory: string): void {
  assertNoSymlinkComponents(root, directory, 'Proof directory');
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Proof directory must be a non-symlink directory.');
  }
  fs.chmodSync(directory, 0o700);
}

export function prepareProofDirectories(projectRoot: string): {
  projectRoot: string;
  proofRoot: string;
  reportsDirectory: string;
} {
  const root = checkedProjectRoot(projectRoot);
  const proofRoot = path.join(root, '.proof');
  const reportsDirectory = path.join(proofRoot, 'reports');
  ensurePrivateDirectory(root, proofRoot);
  ensurePrivateDirectory(root, reportsDirectory);
  return { projectRoot: root, proofRoot, reportsDirectory };
}

export function deriveRepositoryState(projectRoot: string): {
  commit: string;
  dirty: boolean;
} {
  const root = checkedProjectRoot(projectRoot);
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (
    commit.status !== 0 ||
    status.status !== 0 ||
    !/^[a-f0-9]{40}$/i.test(commit.stdout.trim())
  ) {
    throw new Error('Unable to derive repository state from Git.');
  }
  return {
    commit: commit.stdout.trim().toLowerCase(),
    dirty: status.stdout.length > 0,
  };
}

export function readRegularFileNoFollow(filePath: string, label: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`${label} must be a regular file.`);
    return fs.readFileSync(descriptor);
  } catch (error) {
    if (error instanceof Error && /regular file/i.test(error.message)) throw error;
    throw new Error(`${label} must be an existing non-symlink regular file.`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function verifyArtifactClaims(
  artifacts: ProofArtifact[],
  projectRoot: string,
): ProofArtifact[] {
  const root = checkedProjectRoot(projectRoot);
  const approvedRoots = [
    path.join(root, 'test/fixtures'),
    path.join(root, '.proof/evidence'),
  ];
  return artifacts.map((artifact, index) => {
    const candidate = path.resolve(root, artifact.path);
    if (!approvedRoots.some((approvedRoot) => isWithin(approvedRoot, candidate))) {
      throw new Error(`Artifact at index ${index} is outside approved evidence roots.`);
    }
    assertNoSymlinkComponents(root, candidate, `Artifact at index ${index}`);
    const bytes = readRegularFileNoFollow(candidate, `Artifact at index ${index}`);
    const actual = {
      path: artifact.path.replaceAll('\\', '/'),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
    };
    if (artifact.sha256 !== actual.sha256 || artifact.bytes !== actual.bytes) {
      throw new Error(`Artifact claim mismatch at index ${index}; observed values were redacted.`);
    }
    return actual;
  });
}

function optionalLstat(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function assertPrivateOutputTarget(
  reportsDirectory: string,
  fileName: string,
): string {
  const directory = fs.realpathSync(reportsDirectory);
  const target = path.join(directory, fileName);
  if (!isWithin(directory, target) || path.dirname(target) !== directory) {
    throw new Error('Output target escapes the approved proof reports directory.');
  }
  const targetStat = optionalLstat(target);
  if (targetStat?.isSymbolicLink()) throw new Error('Output target is a symlink.');
  if (targetStat && !targetStat.isFile()) {
    throw new Error('Output target must be a regular file.');
  }
  return target;
}

export function atomicWritePrivate(
  reportsDirectory: string,
  fileName: string,
  content: string | Buffer,
): string {
  const directory = fs.realpathSync(reportsDirectory);
  const target = assertPrivateOutputTarget(directory, fileName);
  const temporary = path.join(
    directory,
    `.${fileName}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.writeFileSync(descriptor, content);
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (optionalLstat(target)?.isSymbolicLink()) {
      throw new Error('Output target is a symlink.');
    }
    fs.renameSync(temporary, target);
    return target;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`|*_{}[\]<>]/g, '\\$&').replace(/\r?\n/g, ' ');
}

function renderMarkdown(report: ProofReport): string {
  const lines = [
    `# Proof report: ${escapeMarkdown(report.proof_id)}`,
    '',
    `- Generated: ${report.generated_at}`,
    `- Commit: \`${report.repository.commit}\``,
    `- Working tree: ${report.repository.dirty ? 'dirty' : 'clean'}`,
  ];
  if (report.repository.warning) lines.push(`- ${report.repository.warning}`);

  lines.push('', '## Commands', '', '| Name | Command | Exit |', '| --- | --- | ---: |');
  for (const command of report.commands) {
    lines.push(
      `| ${escapeMarkdown(command.name)} | \`${escapeMarkdown(command.command)}\` | ${command.exit_code} |`,
    );
  }

  lines.push('', '## Results', '', '| Check | Status | Detail |', '| --- | --- | --- |');
  for (const result of report.results) {
    lines.push(
      `| ${escapeMarkdown(result.name)} | ${result.status} | ${escapeMarkdown(result.detail ?? '')} |`,
    );
  }

  lines.push('', '## Artifacts', '', '| Path | SHA-256 | Bytes |', '| --- | --- | ---: |');
  for (const artifact of report.artifacts) {
    lines.push(
      `| \`${escapeMarkdown(artifact.path)}\` | \`${artifact.sha256}\` | ${artifact.bytes} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function generateProofReport(
  value: unknown,
  options: ProofGenerationOptions = {},
): { jsonPath: string; markdownPath: string; report: ProofReport } {
  const input = parseProofInput(value);
  const paths = prepareProofDirectories(options.projectRoot ?? PROJECT_ROOT);
  const repository = deriveRepositoryState(paths.projectRoot);
  const artifacts = verifyArtifactClaims(input.artifacts, paths.projectRoot);
  const report: ProofReport = {
    ...input,
    repository: {
      ...repository,
      warning: repository.dirty
        ? 'WARNING: generated from a dirty working tree; review the diff with this report.'
        : null,
    },
    artifacts,
  };
  assertPrivateOutputTarget(paths.reportsDirectory, `${input.proof_id}.json`);
  assertPrivateOutputTarget(paths.reportsDirectory, `${input.proof_id}.md`);
  const jsonPath = atomicWritePrivate(
    paths.reportsDirectory,
    `${input.proof_id}.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const markdownPath = atomicWritePrivate(
    paths.reportsDirectory,
    `${input.proof_id}.md`,
    renderMarkdown(report),
  );
  return { jsonPath, markdownPath, report };
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
    if (process.argv.includes('--output-dir')) {
      throw new Error('Custom output directories are not supported.');
    }
    const generated = generateProofReport(parsed);
    console.log(`Generated proof report ${path.basename(generated.jsonPath)}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Proof report generation failed.');
    process.exitCode = 1;
  }
}
