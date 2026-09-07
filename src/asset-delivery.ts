import { sha256Hex } from './content-integrity';
import { buildImmutableBlobPath } from './blob-storage';
import {
  EntitlementService,
  type SettledPaymentEvidence,
  type StoredEntitlement,
} from './entitlements';
import type { DesignSystemEntry, PaymentPayload } from './types';

export type AssetDeliveryDependencies = {
  findEntry(id: string): DesignSystemEntry | null;
  entitlements: EntitlementService;
  createSignedDownload(pathname: string): Promise<{ url: string; expiresAt: string }>;
};

export type PurchaseResult = {
  receipt_id: string;
  product_id: string;
  source_provider: string;
  network: string;
  payer: string;
  transaction: string;
  entitlement: string;
  redeem_url: string;
  expires_at: string;
  recovered: boolean;
  filename: string;
  mime_type: string;
  content_sha256: string;
  content_bytes: number;
};

export type RedeemResult = {
  product_id: string;
  download_url: string;
  expires_at: string;
  filename: string;
  mime_type: string;
  content_sha256: string;
  content_bytes: number;
};

export class AssetDeliveryService {
  constructor(private readonly deps: AssetDeliveryDependencies) {}

  async purchase(
    productId: string,
    paymentSignature: string,
    settlement: SettledPaymentEvidence,
    canonicalOrigin: string,
  ): Promise<PurchaseResult> {
    const entry = this.requireAsset(productId);
    const authorized = authorizedPaymentIdentity(paymentSignature);
    const finalized = finalizedSettlementIdentity(settlement, authorized);
    const issued = await this.deps.entitlements.issueAfterSettlement(
      entry,
      settlementReference(paymentSignature),
      finalized,
      canonicalOrigin,
    );
    return purchaseResult(issued.record, issued.recovered);
  }

  async recover(
    productId: string,
    paymentSignature: string,
    canonicalOrigin: string,
  ): Promise<PurchaseResult | undefined> {
    // Recovery deliberately does not verify or settle again. The exact header's
    // digest can only resolve a record that was written after authenticated
    // settlement. Any payload change produces a different, absent index.
    if (!paymentSignature) return undefined;
    const record = await this.deps.entitlements.recover(
      productId,
      settlementReference(paymentSignature),
      canonicalOrigin,
    );
    return record ? purchaseResult(record, true) : undefined;
  }

  async redeem(
    productId: string,
    entitlement: string,
    canonicalOrigin?: string,
  ): Promise<RedeemResult> {
    const claims = this.deps.entitlements.verify(entitlement, {
      productId,
      origin: canonicalOrigin,
    });
    const signed = await this.deps.createSignedDownload(
      buildImmutableBlobPath(claims.contentSha256, claims.filename),
    );
    return {
      product_id: claims.productId,
      download_url: signed.url,
      expires_at: signed.expiresAt,
      filename: claims.filename,
      mime_type: claims.mimeType,
      content_sha256: claims.contentSha256,
      content_bytes: claims.contentBytes,
    };
  }

  private requireAsset(productId: string): DesignSystemEntry {
    const entry = this.deps.findEntry(productId);
    if (
      !entry ||
      !entry.active ||
      entry.resource_type !== 'binary_asset' ||
      entry.delivery_mode !== 'entitlement' ||
      entry.integrity_status !== 'verified' ||
      !entry.content_sha256 ||
      !entry.content_bytes ||
      !entry.blob_path
    ) {
      throw new Error(`Paid binary asset "${productId}" is unavailable.`);
    }
    return entry;
  }
}

export function settlementReference(paymentSignature: string): string {
  if (!paymentSignature?.trim()) {
    throw new Error('Payment signature is required.');
  }
  return sha256Hex(paymentSignature.trim());
}

export function finalizedSettlementIdentity(
  settlement: SettledPaymentEvidence | undefined,
  authorized: { network: string; payer: string },
): SettledPaymentEvidence {
  const transaction = settlement?.transaction?.trim().toLowerCase() ?? '';
  const network = settlement?.network?.trim() ?? '';
  const payer = settlement?.payer?.trim().toLowerCase() ?? '';
  if (
    !/^0x[0-9a-f]{64}$/.test(transaction) ||
    network !== authorized.network ||
    payer !== authorized.payer.toLowerCase()
  ) {
    throw new Error(
      'Finalized transaction metadata is required and must match the verified payment.',
    );
  }
  return { transaction, network, payer };
}

export function authorizedPaymentIdentity(paymentSignature: string): {
  network: string;
  payer: string;
} {
  let payload: PaymentPayload;
  try {
    payload = JSON.parse(
      Buffer.from(paymentSignature.trim(), 'base64url').toString('utf8'),
    ) as PaymentPayload;
  } catch {
    throw new Error('Settled payment payload is not valid encoded JSON.');
  }
  const accepted = payload.accepted;
  const authorization = payload.payload?.authorization;
  if (
    payload.x402Version !== 2 ||
    accepted?.scheme !== 'exact' ||
    !/^eip155:\d+$/.test(accepted?.network ?? '') ||
    !/^0x[0-9a-f]{40}$/i.test(authorization?.from ?? '') ||
    authorization?.to?.toLowerCase() !== accepted?.payTo?.toLowerCase() ||
    authorization?.value !== accepted?.amount
  ) {
    throw new Error('Verified payment payload identity is invalid.');
  }
  return {
    network: accepted.network,
    payer: authorization.from.toLowerCase(),
  };
}

function purchaseResult(
  record: StoredEntitlement,
  recovered: boolean,
): PurchaseResult {
  return {
    receipt_id: record.payment.paymentReceiptId,
    product_id: record.productId,
    source_provider: record.asset.sourceProvider,
    network: record.payment.network,
    payer: record.payment.payer,
    transaction: record.payment.transaction,
    entitlement: record.token,
    redeem_url: `/assets/${encodeURIComponent(record.productId)}/redeem`,
    expires_at: new Date(record.expiresAtMs).toISOString(),
    recovered,
    filename: record.asset.filename,
    mime_type: record.asset.mimeType,
    content_sha256: record.asset.contentSha256,
    content_bytes: record.asset.contentBytes,
  };
}
