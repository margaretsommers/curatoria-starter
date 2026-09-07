import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sanitizeDownloadFilename } from './delivery';

const MINIMUM_RESERVE_BYTES = 64 * 1024 * 1024;
const PRIVATE_STATE_OVERHEAD_BYTES = 1024 * 1024;

export type CollisionPolicy = 'ask' | 'number' | 'replace' | 'cancel';

export type DownloadDestinationReservation = {
  finalPath: string;
  tempPath: string;
  statePath: string;
  reservationPath: string;
  replaceExisting: boolean;
};

type StatFsResult = {
  bavail: bigint | number;
  bsize: bigint | number;
  blocks: bigint | number;
};

export type DestinationPreflightOptions = {
  out?: string;
  filename: string;
  contentBytes: number;
  yes?: boolean;
  collisionPolicy?: CollisionPolicy;
  homeDirectory?: string;
  stateDirectory?: string;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  prompt?: (question: string) => Promise<string>;
  statfs?: (target: string) => Promise<StatFsResult>;
};

export class DestinationPreflightError extends Error {
  constructor(
    public readonly code:
      | 'output_required'
      | 'destination_unwritable'
      | 'capacity_unknown'
      | 'insufficient_space'
      | 'collision_cancelled'
      | 'collision_policy_required'
      | 'collision_prompt_unavailable'
      | 'reservation_failed',
    message: string,
  ) {
    super(message);
    this.name = 'DestinationPreflightError';
  }
}

export async function preflightDownloadDestination(
  options: DestinationPreflightOptions,
): Promise<DownloadDestinationReservation> {
  if (!Number.isSafeInteger(options.contentBytes) || options.contentBytes <= 0) {
    throw new DestinationPreflightError(
      'capacity_unknown',
      'Expected download size must be a positive safe integer.',
    );
  }

  const homeDirectory = options.homeDirectory ?? os.homedir();
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let out = options.out;
  if (!out) {
    if (!isTTY || !options.prompt) {
      throw new DestinationPreflightError(
        'output_required',
        'A destination is required in noninteractive mode. Pass --out.',
      );
    }
    out = (await options.prompt('Save destination: ')).trim();
    if (!out) {
      throw new DestinationPreflightError(
        'output_required',
        'No download destination was selected.',
      );
    }
  }

  const safeFilename = sanitizeDownloadFilename(
    options.filename,
    'curatoria-download.bin',
  );
  const requestedPath = resolveRequestedPath(out, safeFilename, homeDirectory);
  const directory = path.dirname(requestedPath);
  await ensurePrivateDirectory(directory, false);
  try {
    await fs.access(directory, fsConstants.W_OK);
  } catch (error) {
    throw new DestinationPreflightError(
      'destination_unwritable',
      `Destination directory is not writable: ${messageFor(error)}`,
    );
  }
  const stateDirectory =
    options.stateDirectory ??
    resolveStateDirectory(options.env ?? process.env, homeDirectory);
  await ensurePrivateDirectory(stateDirectory, true);
  try {
    await fs.access(stateDirectory, fsConstants.W_OK);
  } catch (error) {
    throw new DestinationPreflightError(
      'destination_unwritable',
      `Private state directory is not writable: ${messageFor(error)}`,
    );
  }

  await assertCapacity(
    directory,
    options.contentBytes,
    options.statfs,
    'Destination',
  );
  await assertCapacity(
    stateDirectory,
    BigInt(options.contentBytes) + BigInt(PRIVATE_STATE_OVERHEAD_BYTES),
    options.statfs,
    'Private state/cache',
  );
  const [destinationStat, stateStat] = await Promise.all([
    fs.stat(directory),
    fs.stat(stateDirectory),
  ]);
  if (destinationStat.dev === stateStat.dev) {
    await assertCapacity(
      directory,
      BigInt(options.contentBytes) * 2n + BigInt(PRIVATE_STATE_OVERHEAD_BYTES),
      options.statfs,
      'Combined destination and private state/cache',
    );
  }

  let policy = options.collisionPolicy ?? 'ask';
  const explicitCollisionPolicy = options.collisionPolicy !== undefined;
  const requestedExists = await exists(requestedPath);
  if (requestedExists && policy === 'ask') {
    if (!isTTY) {
      throw new DestinationPreflightError(
        'collision_policy_required',
        'Destination exists. Noninteractive downloads require explicit --on-collision number, replace, or cancel.',
      );
    }
    if (!options.prompt) {
      throw new DestinationPreflightError(
        'collision_prompt_unavailable',
        'Destination exists and interactive collision selection is unavailable.',
      );
    } else {
      const answer = (await options.prompt(
        `Destination exists: ${requestedPath}. Choose number, replace, or cancel: `,
      )).trim().toLowerCase();
      policy =
        answer === 'replace' || answer === 'r'
          ? 'replace'
          : answer === 'number' || answer === 'n'
            ? 'number'
            : 'cancel';
    }
  }
  if (
    requestedExists &&
    options.yes &&
    explicitCollisionPolicy &&
    policy === 'replace'
  ) {
    throw new DestinationPreflightError(
      'collision_policy_required',
      '--yes never permits overwrite. Remove --yes to use explicit replace.',
    );
  }
  if (requestedExists && policy === 'cancel') {
    throw new DestinationPreflightError(
      'collision_cancelled',
      `Destination already exists: ${requestedPath}`,
    );
  }
  const extension = path.extname(requestedPath);
  const stem = path.basename(requestedPath, extension);
  const firstSuffix = requestedExists && policy === 'number' ? 1 : 0;
  for (let suffix = firstSuffix; suffix <= 999; suffix += 1) {
    const candidateName =
      suffix === 0 ? `${stem}${extension}` : `${stem} (${suffix})${extension}`;
    const finalPath = path.join(directory, candidateName);
    const replaceExisting =
      suffix === 0 && requestedExists && policy === 'replace';
    if (!replaceExisting && (await exists(finalPath))) continue;
    if (
      replaceExisting &&
      (await exists(replacementBackupPath(finalPath)))
    ) {
      throw new DestinationPreflightError(
        'reservation_failed',
        `Unresolved replacement backup exists: ${replacementBackupPath(finalPath)}`,
      );
    }
    const reservationPath = path.join(
      directory,
      `.${candidateName}.curatoria.reserve`,
    );
    let reservationHandle: fs.FileHandle;
    try {
      reservationHandle = await fs.open(reservationPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw new DestinationPreflightError(
        'reservation_failed',
        messageFor(error),
      );
    }
    await reservationHandle.close();

    const id = crypto.randomUUID();
    const tempPath = path.join(stateDirectory, `${id}.part`);
    const statePath = path.join(stateDirectory, `${id}.json`);
    try {
      const partial = await fs.open(tempPath, 'wx', 0o600);
      await partial.close();
      await fsyncParentDirectory(tempPath);
    } catch (error) {
      await fs.rm(reservationPath, { force: true });
      await fsyncParentDirectory(reservationPath);
      throw error;
    }
    return {
      finalPath,
      tempPath,
      statePath,
      reservationPath,
      replaceExisting,
    };
  }
  throw new DestinationPreflightError(
    'reservation_failed',
    'Could not reserve a collision-safe download filename.',
  );
}

export function resolveStateDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  if (env.CURATORIA_STATE_DIR) return path.resolve(env.CURATORIA_STATE_DIR);
  if (env.XDG_CACHE_HOME) {
    return path.resolve(env.XDG_CACHE_HOME, 'curatoria', 'downloads');
  }
  return path.join(homeDirectory, '.cache', 'curatoria', 'downloads');
}

export function replacementBackupPath(finalPath: string): string {
  return path.join(
    path.dirname(finalPath),
    `.${path.basename(finalPath)}.curatoria.backup`,
  );
}

export async function fsyncParentDirectory(filePath: string): Promise<void> {
  const handle = await fs.open(path.dirname(filePath), 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertCapacity(
  directory: string,
  contentBytes: number | bigint,
  injected?: (target: string) => Promise<StatFsResult>,
  label = 'Destination',
): Promise<void> {
  let capacity: StatFsResult;
  try {
    capacity = injected
      ? await injected(directory)
      : await fs.statfs(directory, { bigint: true });
  } catch (error) {
    throw new DestinationPreflightError(
      'capacity_unknown',
      `Could not determine ${label.toLowerCase()} capacity: ${messageFor(error)}`,
    );
  }
  const blockSize = BigInt(capacity.bsize);
  const available = BigInt(capacity.bavail) * blockSize;
  const total = BigInt(capacity.blocks) * blockSize;
  const reserve = maxBigInt(
    BigInt(MINIMUM_RESERVE_BYTES),
    (total * 5n + 99n) / 100n,
  );
  const required = BigInt(contentBytes) + reserve;
  if (available < required) {
    throw new DestinationPreflightError(
      'insufficient_space',
      `${label} has ${available} bytes available; download requires ${required} bytes including reserve.`,
    );
  }
}

async function ensurePrivateDirectory(
  directory: string,
  enforceOwnerOnly: boolean,
): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new DestinationPreflightError(
      'destination_unwritable',
      `Path is not a regular directory: ${directory}`,
    );
  }
  if (enforceOwnerOnly) {
    await fs.chmod(directory, 0o700);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new DestinationPreflightError(
        'destination_unwritable',
        `Private state directory is not owned by the current user: ${directory}`,
      );
    }
  }
}

function resolveRequestedPath(
  out: string,
  filename: string,
  homeDirectory: string,
): string {
  const expanded = out.startsWith('~/')
    ? path.join(homeDirectory, out.slice(2))
    : out;
  if (expanded.endsWith('/') || expanded.endsWith(path.sep)) {
    return path.resolve(expanded, filename);
  }
  const basename = path.basename(expanded);
  return path.extname(basename)
    ? path.resolve(expanded)
    : path.resolve(expanded, filename);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
