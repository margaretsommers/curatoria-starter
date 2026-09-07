import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DOCUMENTED_BASELINE_COMMIT,
  environmentVariableNamesFromExample,
  prepareRollbackPacket,
  refuseExecutedRollback,
  sanitizeRegistryForHash,
} from '../scripts/prepare-rollback-packet';

const projectRoot = path.join(__dirname, '..');

test('rollback prepare refuses execute flags and does not run rollback', () => {
  assert.throws(() => refuseExecutedRollback(['--execute']), /unexecuted instructions only/);
  assert.throws(() => refuseExecutedRollback(['--rollback']), /unexecuted instructions only/);
  assert.throws(
    () => prepareRollbackPacket({ projectRoot, argv: ['node', 'script', '--apply'] }),
    /unexecuted instructions only/,
  );
  const before = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).stdout.trim();
  const generated = prepareRollbackPacket({
    projectRoot,
    argv: ['node', 'scripts/prepare-rollback-packet.ts'],
    now: () => new Date('2026-08-29T21:00:00.000Z'),
  });
  const after = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).stdout.trim();
  assert.equal(before.toLowerCase(), after.toLowerCase());
  assert.equal(generated.packet.kind, 'unexecuted_rollback_packet');
  assert.ok(generated.packet.rollback_commands.every(command => command.executed === false));
});

test('rollback packet records commits, sanitized registry hashes, and env names only', () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-rollback-packet-'));
  try {
    const generated = prepareRollbackPacket({
      projectRoot,
      outputDirectory,
      argv: [],
      now: () => new Date('2026-08-29T21:00:00.000Z'),
    });
    assert.equal(generated.packet.schema_version, 1);
    assert.match(generated.packet.repository.current_commit, /^[a-f0-9]{40}$/);
    assert.match(generated.packet.repository.base_commit, /^[a-f0-9]{7,40}$/);
    assert.equal(generated.packet.repository.documented_baseline, DOCUMENTED_BASELINE_COMMIT);
    assert.equal(generated.packet.registry.path, 'design-systems/.registry.json');
    assert.match(generated.packet.registry.sanitized_sha256, /^[a-f0-9]{64}$/);
    assert.ok(generated.packet.registry.entry_count > 0);
    assert.ok(generated.packet.environment_variable_names.includes('WALLET_ADDRESS'));
    assert.ok(generated.packet.environment_variable_names.includes('ENTITLEMENT_STORE_INDEX_KEY'));
    assert.equal(
      generated.packet.environment_variable_names.some(name => name.includes('=')),
      false,
    );
    assert.ok(generated.packet.schema_compatibility.some(note => /401/.test(note) && /503/.test(note)));
    assert.ok(
      generated.packet.schema_compatibility.some(note =>
        /ENTITLEMENT_STORE_INDEX_KEY/.test(note),
      ),
    );
    assert.ok(generated.packet.go_no_go.every(item => item.status === 'pending'));
    const serialized = JSON.stringify(generated.packet);
    assert.equal(serialized.includes('https://'), false);
    assert.equal(serialized.includes('file_id'), false);
    assert.equal(serialized.includes('share_url'), false);
    assert.equal(serialized.includes('blob_path'), false);
    assert.equal(serialized.includes('1FsdNCYgZj_8UyXLEThqkLmC1elr27TSC'), false);
    const written = fs.readFileSync(generated.outputPath ?? '', 'utf8');
    assert.equal(written.includes('https://'), false);
    assert.equal(JSON.parse(written).kind, 'unexecuted_rollback_packet');
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('sanitized registry hashes drop source identifiers and keep entry ids', () => {
  const sanitized = sanitizeRegistryForHash({
    owner: { name: 'Curatoria', url: 'https://curatoria.dev', wallet: '0xabc' },
    design_systems: [
      {
        id: 'example-minimal',
        source: { type: 'gdrive', file_id: 'SECRETFILEID' },
        blob_path: 'assets/sha256/aaa/secret.psd',
        price_usd: '0.01',
        active: true,
      },
    ],
  });
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes('https://curatoria.dev'), false);
  assert.equal(serialized.includes('SECRETFILEID'), false);
  assert.equal(serialized.includes('blob_path'), false);
  assert.equal(sanitized.entry_hashes[0]?.id, 'example-minimal');
  assert.match(sanitized.entry_hashes[0]?.sha256 ?? '', /^[a-f0-9]{64}$/);
});

test('environment example parser returns names and never values', () => {
  const names = environmentVariableNamesFromExample(
    ['# comment', 'WALLET_ADDRESS=0xsecret', 'ADMIN_API_KEY=super-secret', '', 'NETWORK=base-sepolia'].join(
      '\n',
    ),
  );
  assert.deepEqual(names, ['ADMIN_API_KEY', 'NETWORK', 'WALLET_ADDRESS']);
  assert.equal(names.join(',').includes('0xsecret'), false);
  assert.equal(names.join(',').includes('super-secret'), false);
});
