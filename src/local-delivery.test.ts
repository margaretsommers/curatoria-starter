import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  commitDownloadWithReceipt,
  commitTempFileNoReplace,
  commitTempFileReplacing,
  readPrivateResumeState,
  removeFileDurably,
  reserveDownloadDestination,
  releaseDownloadReservation,
  writePrivateResumeState,
} from './local-delivery';
import { preflightDownloadDestination } from './destination-preflight';

test('reserveDownloadDestination chooses collision-safe names atomically', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-reserve-'));
  await fs.writeFile(path.join(directory, 'layout.psd'), 'existing');

  const stateDirectory = path.join(directory, 'state');
  const first = await reserveDownloadDestination(
    directory,
    'layout.psd',
    undefined,
    stateDirectory,
  );
  const second = await reserveDownloadDestination(
    directory,
    'layout.psd',
    undefined,
    stateDirectory,
  );

  assert.equal(path.basename(first.finalPath), 'layout (1).psd');
  assert.equal(path.basename(second.finalPath), 'layout (2).psd');
  assert.notEqual(first.reservationPath, second.reservationPath);
  await releaseDownloadReservation(first);
  await releaseDownloadReservation(second);
});

test('commitTempFileNoReplace never overwrites an existing final file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-commit-'));
  const finalPath = path.join(directory, 'layout.psd');
  const tempPath = path.join(directory, '.layout.psd.part');
  await fs.writeFile(finalPath, 'original');
  await fs.writeFile(tempPath, 'new bytes', { mode: 0o600 });

  await assert.rejects(
    () => commitTempFileNoReplace(tempPath, finalPath),
    (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
  );
  assert.equal(await fs.readFile(finalPath, 'utf8'), 'original');
  assert.equal(await fs.readFile(tempPath, 'utf8'), 'new bytes');
});

test('writePrivateResumeState stores capability state with owner-only permissions', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-state-'));
  const statePath = path.join(directory, '.layout.psd.curatoria.json');

  await writePrivateResumeState(statePath, {
    version: 1,
    product_id: 'layout',
    temp_path: path.join(directory, '.layout.psd.part'),
    final_path: path.join(directory, 'layout.psd'),
    bytes_written: 12,
    content_sha256: 'a'.repeat(64),
    content_bytes: 100,
    download_url: 'https://private.example/file?secret=token',
    download_expires_at: '2026-08-29T13:00:00.000Z',
    entitlement: 'sensitive-entitlement',
  });

  const stat = await fs.stat(statePath);
  assert.equal(stat.mode & 0o777, 0o600);
  const parsed = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(parsed.entitlement, 'sensitive-entitlement');
});

test('commitDownloadWithReceipt reports saved bytes when receipt path collides', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-receipt-'));
  const finalPath = path.join(directory, 'layout.psd');
  const tempPath = path.join(directory, '.layout.psd.part');
  const receiptPath = `${finalPath}.receipt.json`;
  await fs.writeFile(tempPath, 'verified PSD bytes', { mode: 0o600 });
  await fs.writeFile(receiptPath, 'existing receipt');

  const result = await commitDownloadWithReceipt(tempPath, finalPath, { ok: true });

  assert.equal(await fs.readFile(finalPath, 'utf8'), 'verified PSD bytes');
  assert.equal(await fs.readFile(receiptPath, 'utf8'), 'existing receipt');
  assert.equal(result.receiptPath, undefined);
  assert.match(result.receiptError ?? '', /saved and verified.*receipt creation failed/i);
});

test('explicit replacement preserves the original until commit and then replaces atomically', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-replace-'));
  const finalPath = path.join(directory, 'layout.psd');
  const tempPath = path.join(directory, '.layout.psd.part');
  await fs.writeFile(finalPath, 'original');
  await fs.writeFile(tempPath, 'verified replacement', { mode: 0o600 });
  assert.equal(await fs.readFile(finalPath, 'utf8'), 'original');

  await commitTempFileReplacing(tempPath, finalPath);

  assert.equal(await fs.readFile(finalPath, 'utf8'), 'verified replacement');
});

test('replacement restores the original durably when destination fsync fails', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-rollback-'));
  const finalPath = path.join(directory, 'layout.psd');
  const tempPath = path.join(directory, 'replacement.part');
  await fs.writeFile(finalPath, 'original');
  await fs.writeFile(tempPath, 'verified replacement', { mode: 0o600 });
  let finalSyncs = 0;

  await assert.rejects(
    () =>
      commitTempFileReplacing(tempPath, finalPath, async filePath => {
        if (filePath === finalPath) {
          finalSyncs += 1;
          if (finalSyncs === 1) throw new Error('injected destination fsync failure');
        }
      }),
    /injected destination fsync failure/,
  );

  assert.equal(finalSyncs, 2, 'replacement failure and durable restore both sync');
  assert.equal(await fs.readFile(finalPath, 'utf8'), 'original');
  assert.equal(await fs.readFile(tempPath, 'utf8'), 'verified replacement');
  assert.deepEqual(
    (await fs.readdir(directory)).sort(),
    ['layout.psd', 'replacement.part'],
  );
});

test('backup delete failure reports successful replacement with recoverable backup', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-backup-delete-'));
  const finalPath = path.join(directory, 'layout.psd');
  const tempPath = path.join(directory, 'replacement.part');
  await fs.writeFile(finalPath, 'original');
  await fs.writeFile(tempPath, 'verified replacement', { mode: 0o600 });

  const result = await commitTempFileReplacing(
    tempPath,
    finalPath,
    async () => {},
    async filePath => {
      if (filePath.endsWith('.curatoria.backup')) {
        throw new Error('injected backup delete failure');
      }
      await fs.unlink(filePath);
    },
  );

  assert.equal(result.committed, true);
  assert.equal(result.cleanupStatus, 'backup_retained');
  assert.match(result.cleanupWarning ?? '', /backup cleanup failed/);
  assert.equal(await fs.readFile(finalPath, 'utf8'), 'verified replacement');
  assert.equal(await fs.readFile(result.backupPath!, 'utf8'), 'original');
  await assert.rejects(() => fs.stat(tempPath), /ENOENT/);
});

test('backup cleanup fsync failure remains successful and crash-safe', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-backup-sync-'));
  const finalPath = path.join(directory, 'layout.psd');
  const tempPath = path.join(directory, 'replacement.part');
  await fs.writeFile(finalPath, 'original');
  await fs.writeFile(tempPath, 'verified replacement', { mode: 0o600 });
  let backupSyncs = 0;

  const result = await commitTempFileReplacing(
    tempPath,
    finalPath,
    async filePath => {
      if (filePath.endsWith('.curatoria.backup')) {
        backupSyncs += 1;
        if (backupSyncs === 2) throw new Error('injected cleanup fsync failure');
      }
    },
  );

  assert.equal(result.committed, true);
  assert.equal(result.cleanupStatus, 'cleanup_sync_uncertain');
  assert.match(result.cleanupWarning ?? '', /may reappear after a crash/);
  assert.equal(await fs.readFile(finalPath, 'utf8'), 'verified replacement');
  await assert.rejects(() => fs.stat(tempPath), /ENOENT/);
  await assert.rejects(() => fs.stat(result.backupPath!), /ENOENT/);

  // Simulate the durable-directory crash outcome where the deleted backup
  // reappears. Its deterministic path blocks another replace instead of
  // creating an ambiguous second backup.
  await fs.writeFile(result.backupPath!, 'original', { mode: 0o600 });
  await assert.rejects(
    () =>
      preflightDownloadDestination({
        out: finalPath,
        filename: 'layout.psd',
        contentBytes: 20,
        stateDirectory: path.join(directory, 'state'),
        collisionPolicy: 'replace',
      }),
    /Unresolved replacement backup/,
  );
});

test('committed cleanup warning is persisted in receipt durability metadata', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-cleanup-receipt-'));
  const finalPath = path.join(directory, 'layout.psd');
  const tempPath = path.join(directory, 'replacement.part');
  await fs.writeFile(finalPath, 'original');
  await fs.writeFile(tempPath, 'verified replacement', { mode: 0o600 });
  let backupSyncs = 0;

  const result = await commitDownloadWithReceipt(
    tempPath,
    finalPath,
    { durability: { receipt_file: 'pending' } },
    true,
    async filePath => {
      if (filePath.endsWith('.curatoria.backup')) {
        backupSyncs += 1;
        if (backupSyncs === 2) throw new Error('injected cleanup fsync failure');
      }
    },
  );

  assert.ok(result.receiptPath);
  assert.equal(result.backupState, 'cleanup_sync_uncertain');
  assert.match(result.cleanupWarning ?? '', /may reappear after a crash/);
  const receipt = JSON.parse(await fs.readFile(result.receiptPath, 'utf8'));
  assert.equal(receipt.durability.replacement_cleanup, 'cleanup_sync_uncertain');
  assert.equal(receipt.replacement_backup_path, result.backupPath);
  assert.equal(await fs.readFile(finalPath, 'utf8'), 'verified replacement');
});

test('resume rejects symlinked capability files and permissive partials', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-state-link-'));
  await fs.chmod(directory, 0o700);
  const target = path.join(directory, 'target.json');
  const statePath = path.join(directory, 'state.json');
  await fs.writeFile(target, '{}', { mode: 0o600 });
  await fs.symlink(target, statePath);
  await assert.rejects(() => readPrivateResumeState(statePath), /non-symlink/);

  const partial = path.join(directory, 'partial');
  await fs.writeFile(partial, 'x', { mode: 0o644 });
  await fs.rm(statePath);
  await fs.writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      product_id: 'layout',
      temp_path: partial,
      final_path: path.join(directory, 'layout.psd'),
      bytes_written: 1,
      content_sha256: 'a'.repeat(64),
      content_bytes: 10,
      download_url: 'https://private.example/file',
      download_expires_at: '2026-08-29T13:00:00.000Z',
      entitlement: 'secret',
    }),
    { mode: 0o600 },
  );
  await assert.rejects(() => readPrivateResumeState(statePath), /owner-only/);
});

test('durable operations fsync parents after state, final, receipt, and deletion', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-fsync-'));
  await fs.chmod(directory, 0o700);
  const calls: string[] = [];
  const sync = async (filePath: string) => {
    calls.push(filePath);
  };
  const statePath = path.join(directory, 'state.json');
  const tempPath = path.join(directory, 'partial');
  const finalPath = path.join(directory, 'layout.psd');
  await fs.writeFile(tempPath, 'verified', { mode: 0o600 });
  await writePrivateResumeState(
    statePath,
    {
      version: 1,
      product_id: 'layout',
      temp_path: tempPath,
      final_path: finalPath,
      bytes_written: 8,
      content_sha256: 'a'.repeat(64),
      content_bytes: 8,
      download_url: 'https://private.example/file',
      download_expires_at: '2026-08-29T13:00:00.000Z',
      entitlement: 'secret',
    },
    sync,
  );
  await commitDownloadWithReceipt(
    tempPath,
    finalPath,
    { durability: { receipt_file: 'pending' } },
    false,
    sync,
  );
  await removeFileDurably(statePath, sync);

  assert.deepEqual(calls, [
    statePath,
    finalPath,
    `${finalPath}.receipt.json`,
    statePath,
  ]);
});
