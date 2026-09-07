import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import type { BlobSdkAdapter } from './blob-storage';
import { vercelBlobSdk } from './blob-storage';
import type { EntitlementStore, StoredEntitlement } from './entitlements';

const MAX_RECORD_BYTES = 16 * 1024;
const CONTENT_TYPE = 'application/json';

export class BlobEntitlementStore implements EntitlementStore {
  constructor(
    private readonly indexKey: string,
    private readonly sdk: BlobSdkAdapter = vercelBlobSdk,
  ) {
    if (Buffer.byteLength(indexKey) < 32) {
      throw new Error('Entitlement store index key must contain at least 32 bytes.');
    }
  }

  async find(
    settlementReference: string,
    productId: string,
  ): Promise<StoredEntitlement | undefined> {
    const pathname = this.pathname(settlementReference, productId);
    try {
      const stored = await this.sdk.read(pathname);
      return await readRecord(stored.body, stored, pathname);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async saveIfAbsent(
    settlementReference: string,
    record: StoredEntitlement,
  ): Promise<{ record: StoredEntitlement; created: boolean }> {
    validateRecord(record);
    const pathname = this.pathname(settlementReference, record.productId);
    const bytes = Buffer.from(stableJson(record));
    if (bytes.byteLength > MAX_RECORD_BYTES) {
      throw new Error('Entitlement record exceeds the 16 KiB storage limit.');
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
        throw new Error('Entitlement store returned an unexpected immutable pathname.');
      }
      return { record: deepFreeze(structuredClone(record)), created: true };
    } catch (error) {
      if (!isConflict(error)) throw error;
      const existing = await this.find(settlementReference, record.productId);
      if (!existing) {
        throw new Error('Entitlement conflict could not be authenticated.');
      }
      assertCompatible(existing, record);
      return { record: existing, created: false };
    }
  }

  pathname(settlementReference: string, productId: string): string {
    if (!/^[a-f0-9]{64}$/.test(settlementReference) || !productId) {
      throw new Error('Entitlement index requires a settlement digest and product id.');
    }
    const index = crypto
      .createHmac('sha256', this.indexKey)
      .update(`entitlement-store\0${settlementReference}\0${productId}`)
      .digest('hex');
    return `entitlements/v1/${index}.json`;
  }
}

async function readRecord(
  body: Readable,
  metadata: { pathname: string; size: number; contentType: string },
  expectedPathname: string,
): Promise<StoredEntitlement> {
  if (
    metadata.pathname !== expectedPathname ||
    metadata.contentType !== CONTENT_TYPE ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size <= 0 ||
    metadata.size > MAX_RECORD_BYTES
  ) {
    body.destroy();
    throw new Error('Stored entitlement metadata is invalid.');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += value.byteLength;
      if (total > MAX_RECORD_BYTES || total > metadata.size) {
        throw new Error('Stored entitlement exceeds its authenticated size.');
      }
      chunks.push(value);
    }
  } finally {
    body.destroy();
  }
  if (total !== metadata.size) {
    throw new Error('Stored entitlement size does not match Blob metadata.');
  }
  let record: StoredEntitlement;
  try {
    record = JSON.parse(Buffer.concat(chunks).toString('utf8')) as StoredEntitlement;
  } catch {
    throw new Error('Stored entitlement is not valid JSON.');
  }
  validateRecord(record);
  if (stableJson(record) !== Buffer.concat(chunks).toString('utf8')) {
    throw new Error('Stored entitlement is not canonically encoded.');
  }
  return deepFreeze(record);
}

function validateRecord(record: StoredEntitlement): void {
  if (
    !record ||
    record.version !== 1 ||
    !record.productId ||
    typeof record.token !== 'string' ||
    Buffer.byteLength(record.token) > 8 * 1024 ||
    !Number.isSafeInteger(record.expiresAtMs) ||
    record.asset?.productId !== record.productId ||
    !record.asset.blobPath?.startsWith('assets/sha256/') ||
    !/^[a-f0-9]{64}$/.test(record.asset.contentSha256) ||
    !Number.isSafeInteger(record.asset.contentBytes) ||
    record.asset.contentBytes <= 0 ||
    !record.asset.filename ||
    !record.asset.mimeType ||
    !record.asset.priceUsd ||
    !record.asset.sourceProvider ||
    !/^eip155:\d+$/.test(record.payment?.network) ||
    !/^0x[0-9a-f]{40}$/.test(record.payment?.payer) ||
    !/^0x[0-9a-f]{64}$/.test(record.payment?.transaction) ||
    !/^rcpt_[A-Za-z0-9_-]{32,}$/.test(record.payment?.paymentReceiptId)
  ) {
    throw new Error('Stored entitlement record is invalid.');
  }
}

function assertCompatible(existing: StoredEntitlement, candidate: StoredEntitlement): void {
  if (
    existing.productId !== candidate.productId ||
    stableJson(existing.asset) !== stableJson(candidate.asset) ||
    stableJson(existing.payment) !== stableJson(candidate.payment)
  ) {
    throw new Error('Immutable entitlement conflict does not match the settled purchase.');
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
