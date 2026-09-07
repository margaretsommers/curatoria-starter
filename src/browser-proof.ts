import crypto from 'node:crypto';

import { normalizeSha256 } from './content-integrity';

export type SanitizedPaymentResponse = {
  transaction: string;
  network: string;
  payer: string;
};

export type BrowserProofReceipt = {
  version: 1;
  receipt_id: string;
  product_id: string;
  source_provider: string;
  transaction: string;
  payer: string;
  network: string;
  entitlement_fingerprint: string;
  content_sha256: string;
  content_bytes: number;
  filename: string;
  mime_type: string;
  browser_verified_at: string;
  browser_verification: {
    sha256: string;
    bytes: number;
    psd_8bps: boolean;
  };
  disk_verification_required: true;
};

export type BrowserPurchaseMetadata = {
  receipt_id: string;
  product_id: string;
  source_provider: string;
  network: string;
  payer: string;
  transaction: string;
  entitlement: string;
  content_sha256: string;
  content_bytes: number;
  filename: string;
  mime_type: string;
};

export function entitlementFingerprint(entitlement: string): string {
  if (!entitlement) throw new Error('Entitlement is required for fingerprinting.');
  return crypto.createHash('sha256').update(entitlement, 'utf8').digest('hex');
}

export function sanitizePaymentResponse(input: unknown): SanitizedPaymentResponse {
  const candidate = decodePaymentResponse(input);
  const transaction = stringField(candidate, 'transaction');
  const network = stringField(candidate, 'network');
  const payer = stringField(candidate, 'payer').toLowerCase();
  if (
    candidate.success !== true ||
    !/^0x[0-9a-f]{64}$/i.test(transaction) ||
    !/^eip155:\d+$/.test(network) ||
    !/^0x[0-9a-f]{40}$/.test(payer)
  ) {
    throw new Error('PAYMENT-RESPONSE lacks finalized transaction identity.');
  }
  return { transaction, network, payer };
}

export function createBrowserProofReceipt(input: {
  purchase: BrowserPurchaseMetadata;
  paymentResponse: unknown;
  actualSha256: string;
  actualBytes: number;
  psd8bps: boolean;
  verifiedAt?: string;
}): BrowserProofReceipt {
  const payment = sanitizePaymentResponse(input.paymentResponse);
  const expectedSha256 = normalizeSha256(input.purchase.content_sha256);
  const actualSha256 = normalizeSha256(input.actualSha256);
  if (
    !/^rcpt_[A-Za-z0-9_-]{32,}$/.test(input.purchase.receipt_id) ||
    !input.purchase.product_id ||
    !input.purchase.source_provider ||
    !expectedSha256 ||
    actualSha256 !== expectedSha256 ||
    input.actualBytes !== input.purchase.content_bytes ||
    !Number.isSafeInteger(input.actualBytes) ||
    input.actualBytes <= 0 ||
    !input.purchase.filename ||
    !input.purchase.mime_type ||
    !input.psd8bps ||
    payment.network !== input.purchase.network ||
    payment.payer !== input.purchase.payer.toLowerCase() ||
    payment.transaction.toLowerCase() !== input.purchase.transaction.toLowerCase()
  ) {
    throw new Error('Browser proof does not match the paid entitlement metadata.');
  }
  const browserVerifiedAt = input.verifiedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(browserVerifiedAt))) {
    throw new Error('Browser verification timestamp is invalid.');
  }
  return {
    version: 1,
    receipt_id: input.purchase.receipt_id,
    product_id: input.purchase.product_id,
    source_provider: input.purchase.source_provider,
    transaction: payment.transaction,
    payer: payment.payer,
    network: payment.network,
    entitlement_fingerprint: entitlementFingerprint(input.purchase.entitlement),
    content_sha256: expectedSha256,
    content_bytes: input.actualBytes,
    filename: input.purchase.filename,
    mime_type: input.purchase.mime_type,
    browser_verified_at: browserVerifiedAt,
    browser_verification: {
      sha256: actualSha256,
      bytes: input.actualBytes,
      psd_8bps: true,
    },
    disk_verification_required: true,
  };
}

function decodePaymentResponse(input: unknown): Record<string, unknown> {
  if (isRecord(input)) return input;
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('PAYMENT-RESPONSE is missing.');
  }
  try {
    const parsed = JSON.parse(Buffer.from(input.trim(), 'base64url').toString('utf8'));
    if (!isRecord(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new Error('PAYMENT-RESPONSE is not valid encoded JSON.');
  }
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === 'string' ? value[key].trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
