import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import type { BlobSdkAdapter } from './blob-storage';
import { vercelBlobSdk } from './blob-storage';
import type { SettledPaymentEvidence } from './entitlements';

const MAX_RECEIPT_BYTES = 4 * 1024;
const CONTENT_TYPE = 'application/json';

export type SettlementReceipt = SettledPaymentEvidence & {
  version: 1;
  /**
   * The product the settlement paid for. Recovery must never honor a receipt
   * for a different product: the journal is keyed by the payment header digest
   * alone, so an unbound receipt would let one settled header mint
   * entitlements for every product in the catalog.
   */
  productId: string;
};

export interface SettlementJournal {
  find(settlementReference: string): Promise<SettlementReceipt | undefined>;
  saveIfAbsent(
    settlementReference: string,
    receipt: SettlementReceipt,
  ): Promise<{ receipt: SettlementReceipt; created: boolean }>;
}

export class InMemorySettlementJournal implements SettlementJournal {
  private readonly receipts = new Map<string, SettlementReceipt>();

  async find(settlementReference: string): Promise<SettlementReceipt | undefined> {
    return this.receipts.get(journalKey(settlementReference));
  }

  async saveIfAbsent(
    settlementReference: string,
    receipt: SettlementReceipt,
  ): Promise<{ receipt: SettlementReceipt; created: boolean }> {
    validateReceipt(receipt);
    const key = journalKey(settlementReference);
    const existing = this.receipts.get(key);
    if (existing) {
      assertCompatible(existing, receipt);
      return { receipt: existing, created: false };
    }
    const frozen = deepFreeze(structuredClone(receipt));
    this.receipts.set(key, frozen);
    return { receipt: frozen, created: true };
  }
}

export class BlobSettlementJournal implements SettlementJournal {
  constructor(
    private readonly indexKey: string,
    private readonly sdk: BlobSdkAdapter = vercelBlobSdk,
  ) {
    if (Buffer.byteLength(indexKey) < 32) {
      throw new Error('Settlement journal index key must contain at least 32 bytes.');
    }
  }

  async find(settlementReference: string): Promise<SettlementReceipt | undefined> {
    const pathname = this.pathname(settlementReference);
    try {
      const stored = await this.sdk.read(pathname);
      return await readReceipt(stored.body, stored, pathname);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async saveIfAbsent(
    settlementReference: string,
    receipt: SettlementReceipt,
  ): Promise<{ receipt: SettlementReceipt; created: boolean }> {
    validateReceipt(receipt);
    const pathname = this.pathname(settlementReference);
    const bytes = Buffer.from(stableJson(receipt));
    if (bytes.byteLength > MAX_RECEIPT_BYTES) {
      throw new Error('Settlement receipt exceeds the 4 KiB storage limit.');
    }
    try {
      const result = await this.sdk.put(pathname, bytes, {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: CONTENT_TYPE,
        multipart: false,
      });
      if (result.pathname !== pathname) {
        throw new Error('Settlement journal returned an unexpected immutable pathname.');
      }
      return { receipt: deepFreeze(structuredClone(receipt)), created: true };
    } catch (error) {
      if (!isConflict(error)) throw error;
      const existing = await this.find(settlementReference);
      if (!existing) {
        throw new Error('Settlement receipt conflict could not be authenticated.');
      }
      assertCompatible(existing, receipt);
      return { receipt: existing, created: false };
    }
  }

  pathname(settlementReference: string): string {
    if (!/^[a-f0-9]{64}$/.test(settlementReference)) {
      throw new Error('Settlement journal requires a settlement digest.');
    }
    const index = crypto
      .createHmac('sha256', this.indexKey)
      .update(`settlement-journal\0${settlementReference}`)
      .digest('hex');
    return `settlements/v1/${index}.json`;
  }
}

async function readReceipt(
  body: Readable,
  metadata: { pathname: string; size: number; contentType: string },
  expectedPathname: string,
): Promise<SettlementReceipt> {
  if (
    metadata.pathname !== expectedPathname ||
    metadata.contentType !== CONTENT_TYPE ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size <= 0 ||
    metadata.size > MAX_RECEIPT_BYTES
  ) {
    body.destroy();
    throw new Error('Stored settlement receipt metadata is invalid.');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += value.byteLength;
      if (total > MAX_RECEIPT_BYTES || total > metadata.size) {
        throw new Error('Stored settlement receipt exceeds its authenticated size.');
      }
      chunks.push(value);
    }
  } finally {
    body.destroy();
  }
  if (total !== metadata.size) {
    throw new Error('Stored settlement receipt size does not match Blob metadata.');
  }
  const encoded = Buffer.concat(chunks).toString('utf8');
  let receipt: SettlementReceipt;
  try {
    receipt = JSON.parse(encoded) as SettlementReceipt;
  } catch {
    throw new Error('Stored settlement receipt is not valid JSON.');
  }
  validateReceipt(receipt);
  if (stableJson(receipt) !== encoded) {
    throw new Error('Stored settlement receipt is not canonically encoded.');
  }
  return deepFreeze(receipt);
}

function journalKey(settlementReference: string): string {
  if (!/^[a-f0-9]{64}$/.test(settlementReference)) {
    throw new Error('Settlement reference must be a SHA-256 digest.');
  }
  return settlementReference;
}

function validateReceipt(receipt: SettlementReceipt): void {
  if (
    !receipt ||
    receipt.version !== 1 ||
    typeof receipt.productId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(receipt.productId) ||
    !/^eip155:\d+$/.test(receipt.network) ||
    !/^0x[0-9a-f]{40}$/.test(receipt.payer) ||
    !/^0x[0-9a-f]{64}$/.test(receipt.transaction)
  ) {
    throw new Error('Settlement receipt is invalid.');
  }
}

function assertCompatible(existing: SettlementReceipt, candidate: SettlementReceipt): void {
  if (stableJson(existing) !== stableJson(candidate)) {
    throw new Error('Immutable settlement receipt does not match the settled payment.');
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortObject(nested)]),
    );
  }
  return value;
}

function isConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const value = error as Error & { status?: number; statusCode?: number; code?: string };
  return (
    value.status === 409 ||
    value.statusCode === 409 ||
    value.code === 'BLOB_ALREADY_EXISTS' ||
    /\b(?:409|already exists|conflict)\b/i.test(value.message)
  );
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const value = error as Error & { status?: number; statusCode?: number; code?: string };
  return (
    value.status === 404 ||
    value.statusCode === 404 ||
    value.code === 'BLOB_NOT_FOUND' ||
    /\b(?:404|not found)\b/i.test(value.message)
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
