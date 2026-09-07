import crypto from 'node:crypto';

import { buildImmutableBlobPath } from './blob-storage';
import { normalizeSha256 } from './content-integrity';
import type { DesignSystemEntry } from './types';

export const ENTITLEMENT_TTL_MS = 60 * 60 * 1000;

export type EntitlementKey = { id: string; secret: string };
export type EntitlementKeyring = {
  current: EntitlementKey;
  previous: EntitlementKey[];
};

export type SettledPaymentEvidence = {
  network: string;
  payer: string;
  transaction: string;
};

export type EntitlementClaims = {
  version: 1;
  jti: string;
  issuer: string;
  audience: string;
  origin: string;
  productId: string;
  contentSha256: string;
  contentBytes: number;
  filename: string;
  mimeType: string;
  priceUsd: string;
  network: string;
  payer: string;
  paymentReceiptId: string;
  transaction: string;
  issuedAt: string;
  expiresAt: string;
};

export type FrozenAssetSnapshot = {
  productId: string;
  sourceProvider: string;
  blobPath: string;
  contentSha256: string;
  contentBytes: number;
  filename: string;
  mimeType: string;
  priceUsd: string;
};

export type StoredEntitlement = {
  version: 1;
  productId: string;
  token: string;
  expiresAtMs: number;
  asset: FrozenAssetSnapshot;
  payment: SettledPaymentEvidence & {
    paymentReceiptId: string;
  };
};

export interface EntitlementStore {
  find(settlementReference: string, productId: string): Promise<StoredEntitlement | undefined>;
  saveIfAbsent(
    settlementReference: string,
    record: StoredEntitlement,
  ): Promise<{ record: StoredEntitlement; created: boolean }>;
}

export class InMemoryEntitlementStore implements EntitlementStore {
  private readonly records = new Map<string, StoredEntitlement>();

  async find(
    settlementReference: string,
    productId: string,
  ): Promise<StoredEntitlement | undefined> {
    return this.records.get(storeKey(settlementReference, productId));
  }

  async saveIfAbsent(
    settlementReference: string,
    record: StoredEntitlement,
  ): Promise<{ record: StoredEntitlement; created: boolean }> {
    const key = storeKey(settlementReference, record.productId);
    const existing = this.records.get(key);
    if (existing) return { record: existing, created: false };
    const frozen = deepFreeze(structuredClone(record));
    this.records.set(key, frozen);
    return { record: frozen, created: true };
  }
}

export class EntitlementService {
  constructor(
    private readonly keyring: EntitlementKeyring,
    private readonly store: EntitlementStore,
    private readonly now: () => number = Date.now,
  ) {
    validateKeyring(keyring);
  }

  async issueAfterSettlement(
    entry: DesignSystemEntry,
    settlementReference: string,
    payment: SettledPaymentEvidence,
    canonicalOrigin: string,
  ): Promise<{
    record: StoredEntitlement;
    recovered: boolean;
  }> {
    validateSettlement(payment);
    const origin = normalizeOrigin(canonicalOrigin);
    const existing = await this.store.find(settlementReference, entry.id);
    if (existing) {
      assertStoredIdentity(existing, entry.id, payment, origin, this.keyring, this.now());
      return { record: existing, recovered: true };
    }

    const nowMs = this.now();
    const asset = snapshotEntry(entry);
    const paymentReceiptId = deterministicReceiptId(
      this.keyring.current.secret,
      settlementReference,
      entry.id,
    );
    const claims: EntitlementClaims = {
      version: 1,
      jti: deterministicJti(
        this.keyring.current.secret,
        settlementReference,
        entry.id,
        asset.contentSha256,
      ),
      issuer: origin,
      audience: `${origin}/assets/${encodeURIComponent(entry.id)}/redeem`,
      origin,
      productId: entry.id,
      contentSha256: asset.contentSha256,
      contentBytes: asset.contentBytes,
      filename: asset.filename,
      mimeType: asset.mimeType,
      priceUsd: asset.priceUsd,
      network: payment.network,
      payer: payment.payer.toLowerCase(),
      paymentReceiptId,
      transaction: payment.transaction.toLowerCase(),
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + ENTITLEMENT_TTL_MS).toISOString(),
    };
    const candidate: StoredEntitlement = {
      version: 1,
      productId: entry.id,
      token: signEntitlement(claims, this.keyring.current),
      expiresAtMs: Date.parse(claims.expiresAt),
      asset,
      payment: {
        network: claims.network,
        payer: claims.payer,
        transaction: claims.transaction,
        paymentReceiptId,
      },
    };
    const saved = await this.store.saveIfAbsent(settlementReference, candidate);
    assertStoredIdentity(saved.record, entry.id, payment, origin, this.keyring, this.now());
    return { record: saved.record, recovered: !saved.created };
  }

  async recover(
    productId: string,
    settlementReference: string,
    canonicalOrigin: string,
  ): Promise<StoredEntitlement | undefined> {
    const record = await this.store.find(settlementReference, productId);
    if (!record) return undefined;
    const claims = verifyEntitlement(record.token, this.keyring, this.now(), {
      productId,
      origin: canonicalOrigin,
    });
    assertRecordMatchesClaims(record, claims);
    return record;
  }

  verify(
    token: string,
    expected?: string | { productId?: string; origin?: string },
  ): EntitlementClaims {
    const constraints = typeof expected === 'string' ? { productId: expected } : expected;
    return verifyEntitlement(token, this.keyring, this.now(), constraints);
  }
}

export function signEntitlement(claims: EntitlementClaims, key: EntitlementKey): string {
  validateKey(key);
  validateClaims(claims);
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `v1.${key.id}.${payload}`;
  const signature = crypto.createHmac('sha256', key.secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

export function verifyEntitlement(
  token: string,
  keyring: EntitlementKeyring,
  nowMs = Date.now(),
  expected?: string | { productId?: string; origin?: string },
): EntitlementClaims {
  validateKeyring(keyring);
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Invalid entitlement token format.');
  }
  const [, keyId, payload, providedSignature] = parts;
  const key = [keyring.current, ...keyring.previous].find(candidate => candidate.id === keyId);
  if (!key) throw new Error('Entitlement signing key is no longer accepted.');
  const expectedSignature = crypto
    .createHmac('sha256', key.secret)
    .update(`v1.${keyId}.${payload}`)
    .digest();
  const provided = decodeBase64Url(providedSignature);
  if (
    provided.byteLength !== expectedSignature.byteLength ||
    !crypto.timingSafeEqual(provided, expectedSignature)
  ) {
    throw new Error('Invalid entitlement signature.');
  }

  let claims: EntitlementClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as EntitlementClaims;
  } catch {
    throw new Error('Invalid entitlement claims.');
  }
  validateClaims(claims);
  const issuedAtMs = Date.parse(claims.issuedAt);
  const expiresAtMs = Date.parse(claims.expiresAt);
  if (expiresAtMs <= nowMs) throw new Error('Entitlement has expired.');
  if (issuedAtMs > nowMs + 30_000) throw new Error('Entitlement was issued in the future.');

  const constraints = typeof expected === 'string' ? { productId: expected } : expected;
  if (constraints?.productId && claims.productId !== constraints.productId) {
    throw new Error('Entitlement belongs to a different product.');
  }
  if (constraints?.origin && claims.origin !== normalizeOrigin(constraints.origin)) {
    throw new Error('Entitlement belongs to a different origin.');
  }
  return claims;
}

export function keyringFromEnv(env: NodeJS.ProcessEnv = process.env): EntitlementKeyring {
  const currentSecret = env.ENTITLEMENT_SIGNING_KEY?.trim();
  if (!currentSecret) {
    throw new Error('ENTITLEMENT_SIGNING_KEY is required for paid binary asset delivery.');
  }
  const currentId = env.ENTITLEMENT_SIGNING_KEY_ID?.trim() || 'current';
  const previous = (env.ENTITLEMENT_PREVIOUS_SIGNING_KEYS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => {
      const separator = value.indexOf(':');
      if (separator <= 0) {
        throw new Error('Previous entitlement keys must use key-id:secret format.');
      }
      return { id: value.slice(0, separator), secret: value.slice(separator + 1) };
    });
  return { current: { id: currentId, secret: currentSecret }, previous };
}

/**
 * Dedicated HMAC key for Blob entitlement index paths.
 * Never derived from ENTITLEMENT_SIGNING_KEY so recover stays valid across signing-key rotation.
 */
export function storeIndexKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const indexKey = env.ENTITLEMENT_STORE_INDEX_KEY?.trim();
  if (!indexKey || Buffer.byteLength(indexKey) < 32) {
    throw new Error(
      'ENTITLEMENT_STORE_INDEX_KEY is required and must contain at least 32 bytes.',
    );
  }
  return indexKey;
}

function snapshotEntry(entry: DesignSystemEntry): FrozenAssetSnapshot {
  const contentSha256 = normalizeSha256(entry.content_sha256);
  if (
    entry.resource_type !== 'binary_asset' ||
    entry.delivery_mode !== 'entitlement' ||
    entry.integrity_status !== 'verified' ||
    !contentSha256 ||
    !Number.isSafeInteger(entry.content_bytes) ||
    Number(entry.content_bytes) <= 0 ||
    !entry.blob_path ||
    entry.blob_path !== buildImmutableBlobPath(contentSha256, entry.file)
  ) {
    throw new Error('Paid binary asset requires verified immutable metadata.');
  }
  return {
    productId: entry.id,
    sourceProvider: entry.source_provider ?? entry.source?.type ?? 'local',
    blobPath: entry.blob_path,
    contentSha256,
    contentBytes: Number(entry.content_bytes),
    filename: entry.file,
    mimeType: entry.mime_type ?? 'application/octet-stream',
    priceUsd: entry.price_usd,
  };
}

function validateClaims(claims: EntitlementClaims): void {
  const expectedKeys = [
    'audience',
    'contentBytes',
    'contentSha256',
    'expiresAt',
    'filename',
    'issuedAt',
    'issuer',
    'jti',
    'mimeType',
    'network',
    'origin',
    'payer',
    'paymentReceiptId',
    'priceUsd',
    'productId',
    'transaction',
    'version',
  ];
  const actualKeys = claims && typeof claims === 'object' ? Object.keys(claims).sort() : [];
  const issuedAtMs = Date.parse(claims?.issuedAt);
  const expiresAtMs = Date.parse(claims?.expiresAt);
  if (
    JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) ||
    claims.version !== 1 ||
    !/^[A-Za-z0-9_-]{32,}$/.test(claims.jti) ||
    normalizeOrigin(claims.issuer) !== claims.issuer ||
    claims.origin !== claims.issuer ||
    claims.audience !== `${claims.origin}/assets/${encodeURIComponent(claims.productId)}/redeem` ||
    !claims.productId ||
    !normalizeSha256(claims.contentSha256) ||
    !Number.isSafeInteger(claims.contentBytes) ||
    claims.contentBytes <= 0 ||
    !claims.filename ||
    !claims.mimeType ||
    !/^\d+(?:\.\d+)?$/.test(claims.priceUsd) ||
    !/^eip155:\d+$/.test(claims.network) ||
    !/^0x[0-9a-f]{40}$/.test(claims.payer) ||
    !/^rcpt_[A-Za-z0-9_-]{32,}$/.test(claims.paymentReceiptId) ||
    !/^0x[0-9a-f]{64}$/.test(claims.transaction) ||
    !Number.isFinite(issuedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= issuedAtMs ||
    expiresAtMs - issuedAtMs > ENTITLEMENT_TTL_MS
  ) {
    throw new Error('Invalid entitlement claims.');
  }
}

function assertStoredIdentity(
  record: StoredEntitlement,
  productId: string,
  payment: SettledPaymentEvidence,
  origin: string,
  keyring: EntitlementKeyring,
  nowMs: number,
): void {
  const claims = verifyEntitlement(record.token, keyring, nowMs, { productId, origin });
  assertRecordMatchesClaims(record, claims);
  if (
    record.version !== 1 ||
    record.productId !== productId ||
    claims.network !== payment.network ||
    claims.payer !== payment.payer.toLowerCase() ||
    claims.transaction !== payment.transaction.toLowerCase()
  ) {
    throw new Error('Stored entitlement conflicts with the settled payment or frozen asset.');
  }
}

function assertRecordMatchesClaims(
  record: StoredEntitlement,
  claims: EntitlementClaims,
): void {
  if (
    record.version !== 1 ||
    record.productId !== claims.productId ||
    record.expiresAtMs !== Date.parse(claims.expiresAt) ||
    claims.paymentReceiptId !== record.payment.paymentReceiptId ||
    claims.network !== record.payment.network ||
    claims.payer !== record.payment.payer ||
    claims.transaction !== record.payment.transaction ||
    claims.contentSha256 !== record.asset.contentSha256 ||
    claims.contentBytes !== record.asset.contentBytes ||
    claims.filename !== record.asset.filename ||
    claims.mimeType !== record.asset.mimeType ||
    claims.priceUsd !== record.asset.priceUsd
  ) {
    throw new Error('Stored entitlement conflicts with its signed claims.');
  }
}

function validateSettlement(payment: SettledPaymentEvidence): void {
  if (
    !/^eip155:\d+$/.test(payment.network) ||
    !/^0x[0-9a-f]{40}$/i.test(payment.payer) ||
    !/^0x[0-9a-f]{64}$/i.test(payment.transaction)
  ) {
    throw new Error('Authenticated finalized settlement evidence is incomplete.');
  }
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Canonical entitlement origin is invalid.');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Canonical entitlement origin is invalid.');
  }
  return parsed.origin;
}

function validateKeyring(keyring: EntitlementKeyring): void {
  validateKey(keyring.current);
  for (const key of keyring.previous) validateKey(key);
  const ids = [keyring.current, ...keyring.previous].map(key => key.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Entitlement signing key ids must be unique.');
  }
}

function validateKey(key: EntitlementKey): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key.id)) {
    throw new Error('Invalid entitlement signing key id.');
  }
  if (Buffer.byteLength(key.secret) < 32) {
    throw new Error('Entitlement signing keys must contain at least 32 bytes.');
  }
}

function storeKey(settlementReference: string, productId: string): string {
  if (!/^[a-f0-9]{64}$/.test(settlementReference)) {
    throw new Error('Settlement reference must be a SHA-256 digest.');
  }
  if (!productId) throw new Error('Product id is required.');
  return `${settlementReference}:${productId}`;
}

function deterministicJti(
  secret: string,
  settlementReference: string,
  productId: string,
  contentSha256: string,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`entitlement\0${settlementReference}\0${productId}\0${contentSha256}`)
    .digest('base64url');
}

function deterministicReceiptId(
  secret: string,
  settlementReference: string,
  productId: string,
): string {
  return `rcpt_${crypto
    .createHmac('sha256', secret)
    .update(`browser-receipt\0${settlementReference}\0${productId}`)
    .digest('base64url')}`;
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid entitlement signature encoding.');
  }
  return Buffer.from(value, 'base64url');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
