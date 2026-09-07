import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

import {
  fsyncParentDirectory,
  preflightDownloadDestination,
  replacementBackupPath,
  type DownloadDestinationReservation,
} from './destination-preflight';
import { normalizeSha256 } from './content-integrity';

export type DownloadReservation = DownloadDestinationReservation;

export type ReplacementCommitResult = {
  committed: true;
  cleanupStatus: 'clean' | 'backup_retained' | 'cleanup_sync_uncertain';
  cleanupWarning?: string;
  backupPath?: string;
};

export type CommitDownloadResult = {
  receiptPath?: string;
  receiptError?: string;
  cleanupWarning?: string;
  backupPath?: string;
  backupState?: ReplacementCommitResult['cleanupStatus'];
};

export type DownloadResumeState = {
  version: 1;
  product_id: string;
  temp_path: string;
  final_path: string;
  bytes_written: number;
  content_sha256: string;
  content_bytes: number;
  download_url: string;
  download_expires_at: string;
  entitlement: string;
  redeem_url?: string;
  reservation_path?: string;
  replace_existing?: boolean;
  resource_url?: string;
  price_usd?: string;
  network?: string;
  asset?: string;
  pay_to?: string;
  payer?: string;
  transaction?: string;
  source_provider?: string;
  receipt_id?: string;
  etag?: string;
};

export async function reserveDownloadDestination(
  out: string | undefined,
  filename: string,
  homeDirectory?: string,
  stateDirectory?: string,
): Promise<DownloadReservation> {
  return preflightDownloadDestination({
    out,
    filename,
    contentBytes: 1,
    collisionPolicy: 'number',
    homeDirectory,
    stateDirectory,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });
}

export async function releaseDownloadReservation(
  reservation: DownloadReservation,
  syncParent = fsyncParentDirectory,
): Promise<void> {
  await removeFileDurably(reservation.reservationPath, syncParent);
}

export async function cleanupAbandonedReservation(
  reservation: DownloadReservation,
): Promise<void> {
  await Promise.allSettled([
    removeFileDurably(reservation.tempPath),
    removeFileDurably(reservation.statePath),
  ]);
  await releaseDownloadReservation(reservation);
}

export async function commitTempFileNoReplace(
  tempPath: string,
  finalPath: string,
  syncParent = fsyncParentDirectory,
): Promise<void> {
  await assertOwnerOnlyRegularFile(tempPath, 'Download partial');
  try {
    await fs.link(tempPath, finalPath);
    await fs.unlink(tempPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP') throw error;
    await fs.copyFile(tempPath, finalPath, fsConstants.COPYFILE_EXCL);
    await syncFile(finalPath);
    await fs.unlink(tempPath);
  }
  await syncParent(finalPath);
  if (path.dirname(tempPath) !== path.dirname(finalPath)) {
    await syncParent(tempPath);
  }
}

export async function commitTempFileReplacing(
  tempPath: string,
  finalPath: string,
  syncParent = fsyncParentDirectory,
  unlinkFile: (filePath: string) => Promise<void> = fs.unlink,
): Promise<ReplacementCommitResult> {
  await assertOwnerOnlyRegularFile(tempPath, 'Download partial');
  const stagingPath = path.join(
    path.dirname(finalPath),
    `.${path.basename(finalPath)}.${crypto.randomUUID()}.replacement`,
  );
  const backupPath = replacementBackupPath(finalPath);
  let replacementInstalled = false;
  let backupCreated = false;
  try {
    const original = await fs.lstat(finalPath);
    if (original.isSymbolicLink() || !original.isFile()) {
      throw new Error('Replacement target must be a regular non-symlink file.');
    }
    await fs.copyFile(tempPath, stagingPath, fsConstants.COPYFILE_EXCL);
    await fs.chmod(stagingPath, 0o600);
    await syncFile(stagingPath);
    await fs.link(finalPath, backupPath);
    backupCreated = true;
    await syncParent(backupPath);
    await fs.rename(stagingPath, finalPath);
    replacementInstalled = true;
    await syncParent(finalPath);
  } catch (error) {
    if (replacementInstalled && backupCreated) {
      try {
        await fs.rename(backupPath, finalPath);
        backupCreated = false;
        await syncParent(finalPath);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          'Replacement failed and the original could not be durably restored.',
        );
      }
    }
    try {
      await fs.rm(stagingPath, { force: true });
      await syncParent(stagingPath);
    } catch {
      // Preserve the primary replacement failure.
    }
    if (backupCreated) {
      try {
        await fs.rm(backupPath, { force: true });
        await syncParent(backupPath);
      } catch {
        // Preserve the primary replacement failure.
      }
    }
    throw error;
  }

  // The replacement and its directory entry are durable. From this point on,
  // cleanup faults cannot truthfully turn delivery into a failed replacement.
  try {
    await unlinkFile(tempPath);
    await syncParent(tempPath);
  } catch {
    return {
      committed: true,
      cleanupStatus: 'backup_retained',
      cleanupWarning:
        'Replacement committed, but private partial cleanup failed; the original backup was retained.',
      backupPath,
    };
  }
  try {
    await unlinkFile(backupPath);
    backupCreated = false;
  } catch {
    return {
      committed: true,
      cleanupStatus: 'backup_retained',
      cleanupWarning:
        'Replacement committed, but original backup cleanup failed; the backup was retained.',
      backupPath,
    };
  }
  try {
    await syncParent(backupPath);
  } catch {
    return {
      committed: true,
      cleanupStatus: 'cleanup_sync_uncertain',
      cleanupWarning:
        'Replacement committed, but backup deletion directory sync was inconclusive; the backup path may reappear after a crash.',
      backupPath,
    };
  }
  return { committed: true, cleanupStatus: 'clean' };
}

export async function commitDownloadWithReceipt(
  tempPath: string,
  finalPath: string,
  receipt: unknown,
  replaceExisting = false,
  syncParent = fsyncParentDirectory,
): Promise<CommitDownloadResult> {
  let replacement: ReplacementCommitResult | undefined;
  if (replaceExisting) {
    replacement = await commitTempFileReplacing(tempPath, finalPath, syncParent);
  } else {
    await commitTempFileNoReplace(tempPath, finalPath, syncParent);
  }
  const receiptPath = `${finalPath}.receipt.json`;
  try {
    const durableReceipt = markReceiptSynced(receipt, replacement);
    const handle = await fs.open(receiptPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(durableReceipt, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncParent(receiptPath);
    return {
      receiptPath,
      ...(replacement?.cleanupWarning
        ? {
            cleanupWarning: replacement.cleanupWarning,
            backupPath: replacement.backupPath,
            backupState: replacement.cleanupStatus,
          }
        : {}),
    };
  } catch (error) {
    return {
      receiptError: `File saved and verified, but receipt creation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      ...(replacement?.cleanupWarning
        ? {
            cleanupWarning: replacement.cleanupWarning,
            backupPath: replacement.backupPath,
            backupState: replacement.cleanupStatus,
          }
        : {}),
    };
  }
}

export async function writePrivateResumeState(
  statePath: string,
  state: DownloadResumeState,
  syncParent = fsyncParentDirectory,
): Promise<void> {
  await assertPrivateStateDirectory(path.dirname(statePath));
  const temporaryPath = `${statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporaryPath, statePath);
    await fs.chmod(statePath, 0o600);
    await syncParent(statePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function readPrivateResumeState(
  statePath: string,
): Promise<DownloadResumeState> {
  await assertOwnerOnlyRegularFile(statePath, 'Resume state');
  const value = JSON.parse(
    await fs.readFile(statePath, 'utf8'),
  ) as Partial<DownloadResumeState>;
  if (
    value.version !== 1 ||
    typeof value.product_id !== 'string' ||
    typeof value.temp_path !== 'string' ||
    !path.isAbsolute(value.temp_path) ||
    typeof value.final_path !== 'string' ||
    !path.isAbsolute(value.final_path) ||
    !Number.isSafeInteger(value.bytes_written) ||
    Number(value.bytes_written) < 0 ||
    !normalizeSha256(value.content_sha256) ||
    !Number.isSafeInteger(value.content_bytes) ||
    Number(value.content_bytes) <= 0 ||
    typeof value.download_url !== 'string' ||
    typeof value.download_expires_at !== 'string' ||
    typeof value.entitlement !== 'string' ||
    (value.etag !== undefined &&
      (typeof value.etag !== 'string' ||
        value.etag.length > 512 ||
        /[\x00-\x1F\x7F]/.test(value.etag)))
  ) {
    throw new Error('Resume state is invalid or incomplete.');
  }
  if (path.dirname(value.temp_path) !== path.dirname(statePath)) {
    throw new Error('Resume partial must live beside its private state file.');
  }
  await assertOwnerOnlyRegularFile(value.temp_path, 'Resume partial');
  if (value.reservation_path) {
    await assertOwnerOnlyRegularFile(
      value.reservation_path,
      'Resume reservation',
    );
  }
  return value as DownloadResumeState;
}

export async function removeFileDurably(
  filePath: string,
  syncParent = fsyncParentDirectory,
): Promise<void> {
  try {
    await fs.unlink(filePath);
    await syncParent(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function assertOwnerOnlyRegularFile(
  filePath: string,
  label: string,
): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file.`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions must be owner-only (0600).`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user.`);
  }
}

async function assertPrivateStateDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  ) {
    throw new Error('Resume state directory must be owner-only (0700).');
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function markReceiptSynced(
  receipt: unknown,
  replacement?: ReplacementCommitResult,
): unknown {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return receipt;
  const candidate = receipt as Record<string, unknown>;
  const durability =
    candidate.durability &&
    typeof candidate.durability === 'object' &&
    !Array.isArray(candidate.durability)
      ? candidate.durability as Record<string, unknown>
      : {};
  return {
    ...candidate,
    durability: {
      ...durability,
      receipt_file: 'synced',
      ...(replacement
        ? { replacement_cleanup: replacement.cleanupStatus }
        : {}),
    },
    ...(replacement?.backupPath
      ? { replacement_backup_path: replacement.backupPath }
      : {}),
  };
}
