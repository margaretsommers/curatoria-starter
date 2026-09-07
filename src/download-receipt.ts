import crypto from 'node:crypto';

const RECEIPT_ID_PATTERN = /^rcpt_[A-Za-z0-9_-]{32,128}$/;
const SOURCE_PROVIDER_PATTERN = /^(local|url|gdrive|dropbox)$/;
const BASE_NETWORK_PATTERN = /^eip155:(8453|84532)$/;
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TRANSACTION_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const PRODUCT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;

export type EntitlementReceiptMetadata = {
  receipt_id: string;
  product_id: string;
  source_provider: string;
  network: string;
  payer: string;
  filename: string;
  transaction?: string;
};

export type DownloadReceipt = {
  receipt_id: string;
  product_id: string;
  saved_path: string;
  filename: string;
  mime_type: string;
  bytes: number;
  sha256: string;
  source_provider: string;
  price_usd?: string;
  network?: string;
  asset?: string;
  pay_to?: string;
  payer?: string;
  transaction?: string;
  delivered_via?: 'direct' | 'entitlement';
  resumed?: boolean;
  verified_at: string;
  durability: {
    final_file: 'synced';
    parent_directory: 'synced';
    receipt_file: 'pending' | 'synced';
  };
};

export type DownloadReceiptInput = Omit<
  DownloadReceipt,
  'receipt_id' | 'verified_at' | 'durability'
> & {
  receipt_id?: string;
  entitlement?: unknown;
  download_url?: unknown;
  signed_url?: unknown;
  payment_signature?: unknown;
  payment_response?: unknown;
  [key: string]: unknown;
};

export function createDownloadReceipt(
  input: DownloadReceiptInput,
): DownloadReceipt {
  return {
    receipt_id: input.receipt_id ?? crypto.randomUUID(),
    product_id: input.product_id,
    saved_path: input.saved_path,
    filename: input.filename,
    mime_type: input.mime_type,
    bytes: input.bytes,
    sha256: input.sha256,
    source_provider: input.source_provider,
    ...(input.price_usd ? { price_usd: input.price_usd } : {}),
    ...(input.network ? { network: input.network } : {}),
    ...(input.asset ? { asset: input.asset } : {}),
    ...(input.pay_to ? { pay_to: input.pay_to } : {}),
    ...(input.payer ? { payer: input.payer } : {}),
    ...(input.transaction ? { transaction: input.transaction } : {}),
    ...(input.delivered_via ? { delivered_via: input.delivered_via } : {}),
    ...(input.resumed !== undefined ? { resumed: input.resumed } : {}),
    verified_at: new Date().toISOString(),
    durability: {
      final_file: 'synced',
      parent_directory: 'synced',
      receipt_file: 'pending',
    },
  };
}

export function validateEntitlementReceiptMetadata(
  input: EntitlementReceiptMetadata,
): EntitlementReceiptMetadata {
  if (
    !safeMetadataString(input.receipt_id, 133) ||
    !RECEIPT_ID_PATTERN.test(input.receipt_id) ||
    !safeMetadataString(input.product_id, 128) ||
    !PRODUCT_ID_PATTERN.test(input.product_id) ||
    !safeMetadataString(input.source_provider, 16) ||
    !SOURCE_PROVIDER_PATTERN.test(input.source_provider) ||
    !safeMetadataString(input.network, 32) ||
    !BASE_NETWORK_PATTERN.test(input.network) ||
    !safeMetadataString(input.payer, 42) ||
    !EVM_ADDRESS_PATTERN.test(input.payer) ||
    !safeMetadataString(input.filename, 255) ||
    input.filename !== input.filename.trim() ||
    input.filename !== input.filename.split(/[\\/]/).pop() ||
    (input.transaction !== undefined &&
      (!safeMetadataString(input.transaction, 66) ||
        !TRANSACTION_PATTERN.test(input.transaction)))
  ) {
    throw new Error('Entitlement receipt metadata is invalid.');
  }
  return { ...input };
}

function safeMetadataString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes &&
    !/[\x00-\x1F\x7F]/.test(value) &&
    !value.includes('://')
  );
}
