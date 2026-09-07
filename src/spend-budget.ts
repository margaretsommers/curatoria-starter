import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_PER_CALL_CAP_ATOMIC = 10_000;
export const DEFAULT_SESSION_CAP_ATOMIC = 40_000;

export type SpendAttemptStatus =
  | 'pending'
  | 'committed'
  | 'released'
  | 'inconclusive';

export type SpendSettlementReceipt = {
  receipt_id?: string;
  transaction?: string;
  payer?: string;
  network?: string;
  source_provider?: string;
};

export type SpendAttemptRecord = {
  attempt_id: string;
  amount_atomic: number;
  challenge_fingerprint: string;
  status: SpendAttemptStatus;
  reserved_at: string;
  updated_at: string;
  receipt?: SpendSettlementReceipt;
};

export type SpendBudgetLedger = {
  version: 1;
  session_cap_atomic: number;
  per_call_cap_atomic: number;
  attempts: Record<string, SpendAttemptRecord>;
};

export class SpendBudgetError extends Error {
  constructor(
    public readonly code:
      | 'invalid_path'
      | 'invalid_amount'
      | 'per_call_cap_exceeded'
      | 'session_budget_exhausted'
      | 'attempt_conflict'
      | 'attempt_not_found'
      | 'not_pre_settlement'
      | 'already_settled'
      | 'invalid_ledger'
      | 'lock_timeout',
    message: string,
  ) {
    super(message);
    this.name = 'SpendBudgetError';
  }
}

export class SpendBudget {
  private constructor(
    readonly filePath: string,
    readonly sessionCapAtomic: number,
    readonly perCallCapAtomic: number,
  ) {}

  static async open(
    filePath: string,
    sessionCapAtomic = DEFAULT_SESSION_CAP_ATOMIC,
    perCallCapAtomic = DEFAULT_PER_CALL_CAP_ATOMIC,
  ): Promise<SpendBudget> {
    assertAbsoluteOwnerPath(filePath, 'Session budget file');
    if (
      !Number.isSafeInteger(sessionCapAtomic) ||
      sessionCapAtomic <= 0 ||
      !Number.isSafeInteger(perCallCapAtomic) ||
      perCallCapAtomic <= 0
    ) {
      throw new SpendBudgetError(
        'invalid_amount',
        'Session and per-call caps must be positive safe integers.',
      );
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const budget = new SpendBudget(filePath, sessionCapAtomic, perCallCapAtomic);
    await budget.withLock(async ledger => {
      if (!ledger) {
        return { ledger: emptyLedger(sessionCapAtomic, perCallCapAtomic), write: true };
      }
      if (
        ledger.session_cap_atomic !== sessionCapAtomic ||
        ledger.per_call_cap_atomic !== perCallCapAtomic
      ) {
        throw new SpendBudgetError(
          'invalid_ledger',
          'Session budget file caps do not match this session.',
        );
      }
      return { ledger, write: false };
    });
    return budget;
  }

  async reserve(
    attemptId: string,
    amountAtomic: number,
    challengeFingerprint: string,
  ): Promise<SpendAttemptRecord> {
    const id = assertAttemptId(attemptId);
    const fingerprint = assertFingerprint(challengeFingerprint);
    assertReserveAmount(amountAtomic, this.perCallCapAtomic);
    return this.withLock(async ledger => {
      const current = requireLedger(ledger);
      const existing = current.attempts[id];
      if (existing) {
        if (
          existing.amount_atomic !== amountAtomic ||
          existing.challenge_fingerprint !== fingerprint
        ) {
          throw new SpendBudgetError(
            'attempt_conflict',
            'Duplicate attempt id does not match the reserved amount or challenge.',
          );
        }
        return { ledger: current, write: false, result: existing };
      }
      const consumed = consumedAtomic(current);
      if (consumed + amountAtomic > current.session_cap_atomic) {
        throw new SpendBudgetError(
          'session_budget_exhausted',
          `Session spend budget remaining is ${current.session_cap_atomic - consumed} atomic USDC; ${amountAtomic} would exceed the ${current.session_cap_atomic} cap.`,
        );
      }
      const now = new Date().toISOString();
      const created: SpendAttemptRecord = {
        attempt_id: id,
        amount_atomic: amountAtomic,
        challenge_fingerprint: fingerprint,
        status: 'pending',
        reserved_at: now,
        updated_at: now,
      };
      current.attempts[id] = created;
      return { ledger: current, write: true, result: created };
    });
  }

  async commit(
    attemptId: string,
    receipt: SpendSettlementReceipt,
  ): Promise<SpendAttemptRecord> {
    const id = assertAttemptId(attemptId);
    return this.withLock(async ledger => {
      const current = requireLedger(ledger);
      const existing = current.attempts[id];
      if (!existing) {
        throw new SpendBudgetError(
          'attempt_not_found',
          'Cannot commit a spend attempt that was never reserved.',
        );
      }
      if (existing.status === 'released') {
        throw new SpendBudgetError(
          'not_pre_settlement',
          'Cannot commit a spend attempt that was released before settlement.',
        );
      }
      if (existing.status === 'committed') {
        return { ledger: current, write: false, result: existing };
      }
      existing.status = 'committed';
      existing.updated_at = new Date().toISOString();
      existing.receipt = sanitizeReceipt(receipt);
      return { ledger: current, write: true, result: existing };
    });
  }

  async releaseBeforeSettlement(attemptId: string): Promise<SpendAttemptRecord> {
    const id = assertAttemptId(attemptId);
    return this.withLock(async ledger => {
      const current = requireLedger(ledger);
      const existing = current.attempts[id];
      if (!existing) {
        throw new SpendBudgetError(
          'attempt_not_found',
          'Cannot release a spend attempt that was never reserved.',
        );
      }
      if (existing.status === 'released') {
        return { ledger: current, write: false, result: existing };
      }
      if (existing.status !== 'pending') {
        throw new SpendBudgetError(
          'not_pre_settlement',
          'Spend can be released only when failure is proven before settlement.',
        );
      }
      existing.status = 'released';
      existing.updated_at = new Date().toISOString();
      return { ledger: current, write: true, result: existing };
    });
  }

  async markInconclusive(attemptId: string): Promise<SpendAttemptRecord> {
    const id = assertAttemptId(attemptId);
    return this.withLock(async ledger => {
      const current = requireLedger(ledger);
      const existing = current.attempts[id];
      if (!existing) {
        throw new SpendBudgetError(
          'attempt_not_found',
          'Cannot mark a spend attempt that was never reserved.',
        );
      }
      if (existing.status === 'inconclusive' || existing.status === 'committed') {
        return { ledger: current, write: false, result: existing };
      }
      if (existing.status === 'released') {
        throw new SpendBudgetError(
          'not_pre_settlement',
          'A released pre-settlement attempt cannot become inconclusive.',
        );
      }
      existing.status = 'inconclusive';
      existing.updated_at = new Date().toISOString();
      return { ledger: current, write: true, result: existing };
    });
  }

  async remaining(): Promise<number> {
    const ledger = await this.withLock(async current => ({
      ledger: requireLedger(current),
      write: false,
      result: requireLedger(current),
    }));
    return ledger.session_cap_atomic - consumedAtomic(ledger);
  }

  private async withLock<T>(
    mutate: (ledger: SpendBudgetLedger | undefined) => Promise<{
      ledger: SpendBudgetLedger;
      write: boolean;
      result?: T;
    }>,
  ): Promise<T extends undefined ? SpendBudgetLedger : T> {
    const lockPath = `${this.filePath}.lock`;
    const handle = await acquireExclusiveLock(lockPath);
    try {
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
        'utf8',
      );
      await handle.sync();
      const existing = await readLedgerFile(this.filePath);
      const next = await mutate(existing);
      if (next.write) {
        await writeLedgerAtomically(this.filePath, next.ledger);
      }
      return (next.result ?? next.ledger) as T extends undefined
        ? SpendBudgetLedger
        : T;
    } finally {
      await handle.close();
      await removeLockFile(lockPath);
    }
  }
}

export function fingerprintPaymentChallenge(input: {
  resourceUrl: string;
  amount: string | number;
  network: string;
  asset: string;
  payTo: string;
}): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        resource_url: input.resourceUrl,
        amount: String(input.amount),
        network: input.network,
        asset: input.asset.trim().toLowerCase(),
        pay_to: input.payTo.trim().toLowerCase(),
      }),
    )
    .digest('hex');
}

export async function writeOwnerOnlyJson(
  filePath: string,
  value: unknown,
  label = 'Owner-only JSON file',
): Promise<void> {
  assertAbsoluteOwnerPath(filePath, label);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeJsonAtomically(filePath, value);
}

export async function readOwnerOnlyJson<T>(
  filePath: string,
  label = 'Owner-only JSON file',
): Promise<T> {
  assertAbsoluteOwnerPath(filePath, label);
  await assertOwnerOnlyRegularFile(filePath, label);
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

function emptyLedger(
  sessionCapAtomic: number,
  perCallCapAtomic: number,
): SpendBudgetLedger {
  return {
    version: 1,
    session_cap_atomic: sessionCapAtomic,
    per_call_cap_atomic: perCallCapAtomic,
    attempts: {},
  };
}

function requireLedger(ledger: SpendBudgetLedger | undefined): SpendBudgetLedger {
  if (!ledger) {
    throw new SpendBudgetError('invalid_ledger', 'Spend budget ledger is missing.');
  }
  return ledger;
}

function consumedAtomic(ledger: SpendBudgetLedger): number {
  return Object.values(ledger.attempts).reduce((total, attempt) => {
    if (
      attempt.status === 'pending' ||
      attempt.status === 'committed' ||
      attempt.status === 'inconclusive'
    ) {
      return total + attempt.amount_atomic;
    }
    return total;
  }, 0);
}

function assertReserveAmount(amountAtomic: number, perCallCapAtomic: number): void {
  if (!Number.isSafeInteger(amountAtomic) || amountAtomic <= 0) {
    throw new SpendBudgetError(
      'invalid_amount',
      'Reservation amount must be a positive safe integer.',
    );
  }
  if (amountAtomic > perCallCapAtomic) {
    throw new SpendBudgetError(
      'per_call_cap_exceeded',
      `Reservation ${amountAtomic} exceeds the per-call cap of ${perCallCapAtomic} atomic USDC.`,
    );
  }
}

function assertAttemptId(attemptId: string): string {
  if (
    typeof attemptId !== 'string' ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(attemptId)
  ) {
    throw new SpendBudgetError(
      'attempt_conflict',
      'Spend attempt id must be an 8-128 character token.',
    );
  }
  return attemptId;
}

function assertFingerprint(value: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new SpendBudgetError(
      'attempt_conflict',
      'Challenge fingerprint must be a SHA-256 hex digest.',
    );
  }
  return value;
}

function sanitizeReceipt(receipt: SpendSettlementReceipt): SpendSettlementReceipt {
  const clean: SpendSettlementReceipt = {};
  if (typeof receipt.receipt_id === 'string') clean.receipt_id = receipt.receipt_id;
  if (typeof receipt.transaction === 'string') clean.transaction = receipt.transaction;
  if (typeof receipt.payer === 'string') clean.payer = receipt.payer;
  if (typeof receipt.network === 'string') clean.network = receipt.network;
  if (typeof receipt.source_provider === 'string') {
    clean.source_provider = receipt.source_provider;
  }
  return clean;
}

function parseLedger(value: unknown): SpendBudgetLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SpendBudgetError('invalid_ledger', 'Spend budget ledger must be a JSON object.');
  }
  const candidate = value as Partial<SpendBudgetLedger>;
  if (
    candidate.version !== 1 ||
    !Number.isSafeInteger(candidate.session_cap_atomic) ||
    !Number.isSafeInteger(candidate.per_call_cap_atomic) ||
    !candidate.attempts ||
    typeof candidate.attempts !== 'object' ||
    Array.isArray(candidate.attempts)
  ) {
    throw new SpendBudgetError('invalid_ledger', 'Spend budget ledger is invalid.');
  }
  return candidate as SpendBudgetLedger;
}

async function readLedgerFile(
  filePath: string,
): Promise<SpendBudgetLedger | undefined> {
  try {
    await assertOwnerOnlyRegularFile(filePath, 'Session budget file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return parseLedger(JSON.parse(await fs.readFile(filePath, 'utf8')));
  } catch (error) {
    if (error instanceof SpendBudgetError) throw error;
    throw new SpendBudgetError('invalid_ledger', 'Spend budget ledger is not valid JSON.');
  }
}

async function writeLedgerAtomically(
  filePath: string,
  ledger: SpendBudgetLedger,
): Promise<void> {
  await writeJsonAtomically(filePath, ledger);
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
    await fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function acquireExclusiveLock(lockPath: string): Promise<fs.FileHandle> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    try {
      return await fs.open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = await fs.lstat(lockPath);
        if (Date.now() - stat.mtimeMs >= 15_000) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== 'ENOENT') throw lockError;
      }
      await delay(20 + Math.floor(Math.random() * 30));
    }
  }
  throw new SpendBudgetError(
    'lock_timeout',
    'Timed out waiting for the session spend budget lock.',
  );
}

async function removeLockFile(lockPath: string): Promise<void> {
  try {
    await fs.unlink(lockPath);
    await fsyncDirectory(path.dirname(lockPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function assertOwnerOnlyRegularFile(
  filePath: string,
  label: string,
): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SpendBudgetError(
      'invalid_ledger',
      `${label} must be a regular non-symlink file.`,
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new SpendBudgetError(
      'invalid_ledger',
      `${label} permissions must be owner-only (0600).`,
    );
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new SpendBudgetError(
      'invalid_ledger',
      `${label} must be owned by the current user.`,
    );
  }
}

function assertAbsoluteOwnerPath(filePath: string, label: string): void {
  if (!path.isAbsolute(filePath) || filePath.includes('\0')) {
    throw new SpendBudgetError(
      'invalid_path',
      `${label} must be an absolute path.`,
    );
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
