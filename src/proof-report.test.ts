import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  atomicWritePrivate,
  generateProofReport,
  parseProofInput,
  type ProofInput,
} from '../scripts/generate-proof-report';

const projectRoot = path.join(__dirname, '..');
const fixturePath = path.join(projectRoot, 'test/fixtures/psd/tiny-rgb-1x1.psd');
const fixture = fs.readFileSync(fixturePath);
const testWorkspace = path.join(projectRoot, '.proof');
fs.mkdirSync(testWorkspace, { recursive: true, mode: 0o700 });
const evidenceWorkspace = path.join(testWorkspace, 'evidence');
fs.mkdirSync(evidenceWorkspace, { recursive: true, mode: 0o700 });
const processWorkspace = fs.mkdtempSync(
  path.join(evidenceWorkspace, 'proof-report-tests-'),
);
const runId = path.basename(processWorkspace);
process.once('exit', () => {
  fs.rmSync(processWorkspace, { recursive: true, force: true });
  for (const extension of ['json', 'md']) {
    fs.rmSync(path.join(testWorkspace, 'reports', `${runId}.${extension}`), { force: true });
  }
});

function validInput(
  artifact = fixture,
  artifactPath = 'test/fixtures/psd/tiny-rgb-1x1.psd',
): ProofInput {
  return {
    schema_version: 1,
    proof_id: runId,
    generated_at: '2026-08-29T20:00:00.000Z',
    commands: [
      {
        name: 'focused-tests',
        command: 'npm run test:proof',
        exit_code: 0,
      },
    ],
    results: [
      {
        name: 'proof-redaction',
        status: 'pass',
        detail: 'Structured reports rejected sensitive fields.',
      },
    ],
    artifacts: [
      {
        path: artifactPath,
        sha256: crypto.createHash('sha256').update(artifact).digest('hex'),
        bytes: artifact.byteLength,
      },
    ],
  };
}

test('proof report derives Git state and writes verified private evidence', () => {
  const generated = generateProofReport(validInput(), {
    projectRoot,
  });

  const json = JSON.parse(fs.readFileSync(generated.jsonPath, 'utf8')) as {
    repository: { commit: string; dirty: boolean; warning: string };
    artifacts: Array<{ sha256: string; bytes: number }>;
  };
  const markdown = fs.readFileSync(generated.markdownPath, 'utf8');
  const expectedCommit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).stdout.trim();
  const expectedDirty =
    spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).stdout.length > 0;

  assert.equal(json.repository.commit, expectedCommit);
  assert.equal(json.repository.dirty, expectedDirty);
  assert.equal(Boolean(json.repository.warning), expectedDirty);
  assert.match(markdown, new RegExp(runId));
  assert.match(markdown, /npm run test:proof/);
  assert.equal(json.artifacts[0].bytes, fixture.byteLength);
  assert.equal(
    json.artifacts[0].sha256,
    crypto.createHash('sha256').update(fixture).digest('hex'),
  );
  assert.equal(fs.statSync(path.join(projectRoot, '.proof')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(generated.jsonPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(generated.jsonPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(generated.markdownPath).mode & 0o777, 0o600);
});

test('proof input rejects forbidden keys without echoing their values', () => {
  const secret = 'do-not-print-this-capability';
  const input = {
    ...validInput(),
    ['%74%6f%6b%65%6e']: secret,
  };

  assert.throws(
    () => parseProofInput(input),
    (error: Error) => {
      assert.match(error.message, /forbidden key/i);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test('proof input rejects encoded, nested, and control-character content', () => {
  const blobTokenAssignment =
    `${['BLOB', 'READ', 'WRITE', 'TOKEN'].join('_')}=extremely-sensitive-value`;
  const rawSecret = 'Authorization: Bearer extremely-sensitive-value';
  const encodedSecrets = [
    rawSecret,
    encodeURIComponent(rawSecret),
    Buffer.from(rawSecret).toString('base64'),
    Buffer.from(rawSecret).toString('base64url'),
    Buffer.from(encodeURIComponent(rawSecret)).toString('base64url'),
    'Authorization: Bearer extremely-sensitive-value',
    'https://provider.example/private?signature=secret',
    blobTokenAssignment,
    'safe-looking\rsecret',
  ];
  for (const detail of encodedSecrets) {
    const input = validInput();
    input.results[0].detail = detail;
    assert.throws(
      () => parseProofInput(input),
      (error: Error) => {
        assert.match(error.message, /forbidden content|control character/i);
        assert.equal(error.message.includes(detail), false);
        return true;
      },
    );
  }
});

test('proof report rejects missing, symlinked, and false artifact claims', () => {
  const evidenceDirectory = path.join(processWorkspace, 'evidence');
  fs.mkdirSync(evidenceDirectory);
  const artifact = Buffer.from('8BPS private evidence');
  const artifactPath = path.join(evidenceDirectory, 'artifact.psd');
  fs.writeFileSync(artifactPath, artifact);
  const relativeArtifact = path.relative(projectRoot, artifactPath);
  const missing = validInput(artifact, path.join(path.dirname(relativeArtifact), 'missing.psd'));
  assert.throws(
    () => generateProofReport(missing, { projectRoot }),
    /artifact/i,
  );

  const linkedPath = path.join(evidenceDirectory, 'linked.psd');
  fs.symlinkSync(artifactPath, linkedPath);
  const linked = validInput(artifact, path.relative(projectRoot, linkedPath));
  assert.throws(
    () => generateProofReport(linked, { projectRoot }),
    /artifact/i,
  );

  const falseSize = validInput(artifact, relativeArtifact);
  falseSize.artifacts[0].bytes += 1;
  assert.throws(
    () => generateProofReport(falseSize, { projectRoot }),
    /artifact claim/i,
  );

  const falseHash = validInput(artifact, relativeArtifact);
  falseHash.artifacts[0].sha256 = 'a'.repeat(64);
  assert.throws(
    () => generateProofReport(falseHash, { projectRoot }),
    /artifact claim/i,
  );
});

test('proof output rejects symlinks and preserves existing targets on failure', () => {
  const fakeProject = fs.mkdtempSync(path.join(processWorkspace, 'project-'));
  fs.mkdirSync(path.join(fakeProject, 'test/fixtures/psd'), { recursive: true });
  fs.writeFileSync(path.join(fakeProject, 'test/fixtures/psd/tiny-rgb-1x1.psd'), fixture);
  const outside = fs.mkdtempSync(path.join(processWorkspace, 'outside-'));
  fs.symlinkSync(outside, path.join(fakeProject, '.proof'));
  assert.throws(
    () => generateProofReport(validInput(), { projectRoot: fakeProject }),
    /proof.*symlink/i,
  );
  assert.deepEqual(fs.readdirSync(outside), []);

  const reports = path.join(processWorkspace, 'reports');
  fs.mkdirSync(reports, { mode: 0o700 });
  const protectedTarget = path.join(outside, 'protected.json');
  fs.writeFileSync(protectedTarget, 'preserve me', { mode: 0o640 });
  fs.symlinkSync(protectedTarget, path.join(reports, 'protected.json'));
  assert.throws(
    () => atomicWritePrivate(reports, 'protected.json', 'replacement'),
    /output target.*symlink/i,
  );
  assert.equal(fs.readFileSync(protectedTarget, 'utf8'), 'preserve me');
  assert.equal(fs.statSync(protectedTarget).mode & 0o777, 0o640);
});

test('proof input accepts JSON only and rejects malformed structures', () => {
  assert.throws(() => parseProofInput('not structured JSON'), /JSON object/i);
  assert.throws(
    () => parseProofInput({ ...validInput(), schema_version: 2 }),
    /schema_version/,
  );
  assert.throws(
    () =>
      parseProofInput({
        ...validInput(),
        commands: [{ name: 'missing fields' }],
      }),
    /commands/,
  );
});
