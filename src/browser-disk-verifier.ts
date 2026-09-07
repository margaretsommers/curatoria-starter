import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { BrowserProofReceipt } from './browser-proof';

const FORBIDDEN_RECEIPT_KEYS =
  /^(entitlement|download_url|signed_url|payment_signature|payment_response|authorization|signature|token)$/i;

export type BrowserDiskVerification = {
  receipt_id: string;
  product_id: string;
  transaction: string;
  saved_path: string;
  expected_filename: string;
  actual_filename: string;
  renamed_by_browser: boolean;
  bytes: number;
  sha256: string;
  psd_8bps: true;
  verified_at: string;
};

export async function verifyBrowserDownload(input: {
  receipt: BrowserProofReceipt;
  filePath: string;
  expected: {
    receiptId: string;
    productId: string;
    transaction: string;
    entitlementFingerprint: string;
  };
}): Promise<BrowserDiskVerification> {
  validateReceipt(input.receipt);
  const expected = input.expected;
  if (
    !expected ||
    expected.receiptId !== input.receipt.receipt_id ||
    expected.productId !== input.receipt.product_id ||
    expected.transaction !== input.receipt.transaction ||
    expected.entitlementFingerprint !== input.receipt.entitlement_fingerprint
  ) {
    throw new Error('Browser receipt identity does not match the expected transaction.');
  }

  const resolvedPath = path.resolve(input.filePath);
  const stats = await fs.promises.stat(resolvedPath);
  if (!stats.isFile()) throw new Error('Browser download path is not a regular file.');
  if (stats.size !== input.receipt.content_bytes) {
    throw new Error(
      `Saved file has ${stats.size} bytes; receipt requires ${input.receipt.content_bytes}.`,
    );
  }

  const hash = crypto.createHash('sha256');
  let prefix = Buffer.alloc(0);
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(resolvedPath);
    stream.on('data', chunk => {
      const data = Buffer.from(chunk);
      bytes += data.byteLength;
      hash.update(data);
      if (prefix.byteLength < 4) {
        prefix = Buffer.concat([prefix, data.subarray(0, 4 - prefix.byteLength)]);
      }
    });
    stream.once('error', reject);
    stream.once('end', resolve);
  });

  const sha256 = hash.digest('hex');
  if (bytes !== input.receipt.content_bytes || sha256 !== input.receipt.content_sha256) {
    throw new Error('Saved file bytes do not match the transaction-bound browser receipt.');
  }
  if (prefix.toString('ascii') !== '8BPS') {
    throw new Error('Saved file is missing the PSD 8BPS signature.');
  }

  const actualFilename = path.basename(resolvedPath);
  return {
    receipt_id: input.receipt.receipt_id,
    product_id: input.receipt.product_id,
    transaction: input.receipt.transaction,
    saved_path: resolvedPath,
    expected_filename: input.receipt.filename,
    actual_filename: actualFilename,
    renamed_by_browser: actualFilename !== input.receipt.filename,
    bytes,
    sha256,
    psd_8bps: true,
    verified_at: new Date().toISOString(),
  };
}

export function parseBrowserProofReceipt(value: unknown): BrowserProofReceipt {
  validateReceipt(value);
  return value;
}

function validateReceipt(value: unknown): asserts value is BrowserProofReceipt {
  if (!isRecord(value)) throw new Error('Browser receipt must be a JSON object.');
  assertCapabilityFree(value);
  const verification = value.browser_verification;
  if (
    value.version !== 1 ||
    typeof value.receipt_id !== 'string' ||
    !/^rcpt_[A-Za-z0-9_-]{32,}$/.test(value.receipt_id) ||
    typeof value.product_id !== 'string' ||
    !value.product_id ||
    typeof value.source_provider !== 'string' ||
    !/^(local|url|gdrive|dropbox)$/.test(value.source_provider) ||
    typeof value.transaction !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(value.transaction) ||
    typeof value.payer !== 'string' ||
    !/^0x[0-9a-f]{40}$/.test(value.payer) ||
    typeof value.network !== 'string' ||
    !/^eip155:\d+$/.test(value.network) ||
    typeof value.entitlement_fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.entitlement_fingerprint) ||
    typeof value.content_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.content_sha256) ||
    !Number.isSafeInteger(value.content_bytes) ||
    Number(value.content_bytes) <= 0 ||
    typeof value.filename !== 'string' ||
    !value.filename ||
    typeof value.mime_type !== 'string' ||
    value.mime_type !== 'image/vnd.adobe.photoshop' ||
    !Number.isFinite(Date.parse(String(value.browser_verified_at))) ||
    value.disk_verification_required !== true ||
    !isRecord(verification) ||
    verification.sha256 !== value.content_sha256 ||
    verification.bytes !== value.content_bytes ||
    verification.psd_8bps !== true
  ) {
    throw new Error('Browser receipt is incomplete or internally inconsistent.');
  }
}

function assertCapabilityFree(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertCapabilityFree);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RECEIPT_KEYS.test(key)) {
      throw new Error(`Browser receipt contains forbidden capability field "${key}".`);
    }
    assertCapabilityFree(child);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
