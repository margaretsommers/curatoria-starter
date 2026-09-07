import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
} from '@x402/core/http';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

import type { CatalogEntry, CatalogResponse, PaymentAccept, PaymentRequired, SettleResponse } from './types';
import {
  normalizeDownloadMimeType,
  sanitizeDownloadFilename,
} from './delivery';
import { normalizeSha256, sha256Hex } from './content-integrity';
import {
  cleanupAbandonedReservation,
  commitDownloadWithReceipt,
  readPrivateResumeState,
  removeFileDurably,
  releaseDownloadReservation,
  writePrivateResumeState,
  type DownloadResumeState,
} from './local-delivery';
import {
  preflightDownloadDestination,
  type CollisionPolicy,
  type DestinationPreflightOptions,
} from './destination-preflight';
import {
  createDownloadReceipt,
  validateEntitlementReceiptMetadata,
} from './download-receipt';
import type {
  EntitlementPurchase,
  EntitlementPurchaserAdapter,
} from './wallet-purchasers';
import { WalletPurchasePreflightError } from './wallet-purchasers';
import {
  SpendBudgetError,
  fingerprintPaymentChallenge,
  writeOwnerOnlyJson,
  type SpendBudget,
  type SpendSettlementReceipt,
} from './spend-budget';
import { streamResumableDownload } from './resumable-download';

const DEFAULT_CATALOG_URL = 'https://curatoria.dev/.well-known/design-catalog.json';
const DEFAULT_MAX_AMOUNT_ATOMIC = 10_000; // $0.01 USDC
const DEFAULT_MAX_DIRECT_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_TIMEOUT_SECONDS = 300;
const DEFAULT_ALLOWED_DOMAINS = ['curatoria.dev'];
const DEFAULT_ALLOWED_NETWORKS = ['eip155:8453', 'eip155:84532'];
const DEFAULT_ALLOWED_ASSETS = [
  '0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913'.toLowerCase(), // Base USDC
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e'.toLowerCase(), // Base Sepolia USDC
];
export const MAX_ENTITLEMENT_STDIN_BYTES = 1024 * 1024;

export type DownloaderStage =
  | 'catalog'
  | 'selection'
  | 'challenge'
  | 'spend_validation'
  | 'approval'
  | 'payment'
  | 'paid_fetch'
  | 'save'
  | 'validation';

export type ValidationResult = {
  ok: boolean;
  kind: 'markdown' | 'zip' | 'psd' | 'opaque';
  detail: string;
};

export type DownloadProof = {
  ok: true;
  saved_path: string;
  sha256: string;
  bytes: number;
  mime_type: string;
  filename: string;
  resource_url: string;
  product_id: string;
  price_usd: string;
  network: string;
  asset: string;
  pay_to: string;
  payer?: string;
  transaction?: string;
  payment_response?: SettleResponse;
  validation: ValidationResult;
  delivered_via?: 'direct' | 'entitlement';
  receipt_path?: string;
  receipt_error?: string;
  cleanup_warning?: string;
  backup_path?: string;
  replacement_cleanup?: 'clean' | 'backup_retained' | 'cleanup_sync_uncertain';
};

export type DownloadFailure = {
  ok: false;
  stage: DownloaderStage;
  code: string;
  message: string;
  next_step: string;
  details?: Record<string, unknown>;
  proof?: Partial<DownloadProof>;
};

export type DownloadResult = DownloadProof | DownloadFailure;

export type ExternalPurchaseContext = {
  version: 1;
  attempt_id: string;
  product_id: string;
  resource_url: string;
  amount_atomic: number;
  network: string;
  asset: string;
  pay_to: string;
  challenge_fingerprint: string;
  payment_required: PaymentRequired;
};

export type PaymentHeaderSet = {
  headers: Record<string, string>;
  payer?: string;
};

export type PaymentSignerAdapter = {
  createFreshPayment(paymentRequired: PaymentRequired): Promise<PaymentHeaderSet>;
};

export type SpendValidation = {
  ok: true;
  failures: string[];
  accept: PaymentAccept;
  priceAtomic: number;
  priceUsd: string;
} | {
  ok: false;
  failures: string[];
  accept?: PaymentAccept;
  priceAtomic: number;
  priceUsd: string;
};

export type AgentDownloadOptions = {
  catalogUrl?: string;
  productId: string;
  out?: string;
  yes?: boolean;
  dryRun?: boolean;
  maxAmountAtomic?: number;
  maxTimeoutSeconds?: number;
  maxDirectBytes?: number;
  allowedDomains?: string[];
  allowedNetworks?: string[];
  allowedAssets?: string[];
  /**
   * Deprecated proof-only escape hatch. Prebuilt PAYMENT-SIGNATURE values are
   * intentionally rejected because x402 payment payloads must be fresh per
   * request and bound to the validated resource challenge.
   */
  paymentHeader?: string;
  paymentSigner?: PaymentSignerAdapter;
  entitlementPurchaser?: EntitlementPurchaserAdapter;
  privateKeyEnv?: string;
  walletMode?: 'private-key' | 'awal' | 'agentcash' | 'external' | 'dry-run';
  collisionPolicy?: CollisionPolicy;
  stateDirectory?: string;
  isTTY?: boolean;
  prompt?: (question: string) => Promise<string>;
  statfs?: DestinationPreflightOptions['statfs'];
  fetchImpl?: typeof fetch;
  spendBudget?: SpendBudget;
  spendAttemptId?: string;
  prepareExternalPayment?: boolean;
  purchaseContextPath?: string;
};

type PaymentMetadata = { ok: true } & PaymentHeaderSet;

export async function downloadCuratoriaAsset(options: AgentDownloadOptions): Promise<DownloadResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const catalogUrl = options.catalogUrl ?? DEFAULT_CATALOG_URL;

  try {
    assertAllowedUrl(catalogUrl, options.allowedDomains);
  } catch (error) {
    return failure('catalog', 'catalog_domain_not_allowed', messageFor(error), 'Pass --allow-domain for a trusted creator catalog.');
  }

  const catalogResult = await fetchCatalog(catalogUrl, fetchImpl);
  if (!catalogResult.ok) return catalogResult;
  const catalog = catalogResult.catalog;
  const entry = catalog.design_systems.find((candidate) => candidate.id === options.productId);
  if (!entry) {
    return failure('selection', 'product_not_found', `Product "${options.productId}" was not found in the catalog.`, 'Choose an id from /.well-known/design-catalog.json.');
  }
  if (!entry.access_url) {
    return failure('selection', 'missing_access_url', `Product "${entry.id}" does not include access_url.`, 'Fix the creator catalog before attempting payment.');
  }

  const resourceUrl = absoluteUrl(entry.access_url, catalog.base_url ?? catalogUrl);
  try {
    assertAllowedUrl(resourceUrl, options.allowedDomains);
  } catch (error) {
    return failure('spend_validation', 'resource_domain_not_allowed', messageFor(error), 'Do not pay until the resource domain is explicitly trusted.');
  }

  const challenge = await fetchPaymentChallenge(resourceUrl, fetchImpl);
  if (!challenge.ok) return challenge;

  const spend = validateSpend({
    catalog,
    entry,
    resourceUrl,
    paymentRequired: challenge.paymentRequired,
    maxAmountAtomic: options.maxAmountAtomic,
    maxTimeoutSeconds: options.maxTimeoutSeconds,
    allowedNetworks: options.allowedNetworks,
    allowedAssets: options.allowedAssets,
  });
  if (!spend.ok) {
    return failure('spend_validation', 'spend_validation_failed', spend.failures.join('; '), 'Resolve the mismatch or raise limits explicitly before payment.', {
      failures: spend.failures,
    });
  }

  if (options.dryRun || options.walletMode === 'dry-run') {
    return failure('payment', 'dry_run_ready', 'Dry run passed catalog, challenge, and spend validation. No payment was attempted.', 'Rerun with --yes and a supported payment source to settle and save bytes.', {
      resource_url: resourceUrl,
      product_id: entry.id,
      amount: spend.accept.amount,
      network: spend.accept.network,
      pay_to: spend.accept.payTo,
    });
  }

  if (options.paymentHeader) {
    return failure(
      'payment',
      'prebuilt_payment_header_unsupported',
      'Prebuilt PAYMENT-SIGNATURE headers are not accepted by this downloader.',
      'Use a signer adapter or --private-key-env proof path so each paid fetch gets a fresh x402 payload bound to the validated request.',
    );
  }

  const approved = options.yes ?? await promptForApproval(entry, spend, resourceUrl);
  if (!approved) {
    return failure('approval', 'payment_cancelled', 'Payment was not approved.', 'Rerun only when the user approves this exact resource and amount.');
  }

  if (entry.resource_type === 'binary_asset') {
    return downloadEntitledBinaryAsset({
      options,
      entry,
      resourceUrl,
      challenge: challenge.paymentRequired,
      spend,
      fetchImpl,
    });
  }

  const directFilename = sanitizeDownloadFilename(
    entry.download_filename ?? fallbackFilename(entry),
  );
  let reservation;
  try {
    reservation = await preflightDownloadDestination({
      out: options.out,
      filename: directFilename,
      contentBytes:
        Number.isSafeInteger(entry.content_bytes) && Number(entry.content_bytes) > 0
          ? Number(entry.content_bytes)
          : options.maxDirectBytes ?? DEFAULT_MAX_DIRECT_BYTES,
      yes: options.yes,
      collisionPolicy: options.collisionPolicy,
      stateDirectory: options.stateDirectory,
      isTTY: options.isTTY,
      prompt: options.prompt ?? promptForDestination,
      statfs: options.statfs,
    });
  } catch (error) {
    return failure(
      'save',
      'destination_preflight_failed',
      messageFor(error),
      'Choose a writable --out destination before approving payment.',
    );
  }

  const attemptId = spendAttemptIdFor(options);
  const reserved = await reserveSpendBeforeWallet({
    options,
    attemptId,
    resourceUrl,
    spend,
  });
  if (!reserved.ok) {
    await cleanupAbandonedReservation(reservation);
    return reserved;
  }
  if (options.prepareExternalPayment) {
    await cleanupAbandonedReservation(reservation);
    return writePreparedPurchaseContext({
      options,
      attemptId,
      entry,
      resourceUrl,
      challenge: challenge.paymentRequired,
      spend,
      fingerprint: reserved.fingerprint,
    });
  }

  const payment = await createPaymentHeaders(challenge.paymentRequired, options);
  if (!payment.ok) {
    await releaseSpendBeforeSettlement(options, attemptId);
    await cleanupAbandonedReservation(reservation);
    return payment;
  }

  const paidResponse = await fetchImpl(resourceUrl, {
    headers: {
      Accept: entry.mime_type ?? 'application/octet-stream,*/*;q=0.8',
      'Accept-Encoding': 'identity',
      ...payment.headers,
    },
  });
  const paymentResponse = parsePaymentResponse(paidResponse.headers);
  if (!paidResponse.ok) {
    await markSpendInconclusive(options, attemptId);
    await cleanupAbandonedReservation(reservation);
    return failure('paid_fetch', 'paid_fetch_failed', `Paid fetch returned ${paidResponse.status} ${paidResponse.statusText}.`, 'Keep the payment response and contact the creator; do not re-pay silently.', {
      status: paidResponse.status,
      body: await readSmallErrorBody(paidResponse),
      payment_response: paymentResponse,
    });
  }
  try {
    await commitSpendFromSettlement({
      options,
      attemptId,
      receipt: {
        transaction: paymentResponse?.transaction,
        payer: paymentResponse?.payer ?? payment.payer,
        network: paymentResponse?.network ?? spend.accept.network,
        source_provider: sourceProvider(options),
      },
    });
  } catch {
    await markSpendInconclusive(options, attemptId);
  }

  const declaredLength = Number(paidResponse.headers.get('content-length') ?? '0');
  const maxDirectBytes = options.maxDirectBytes ?? DEFAULT_MAX_DIRECT_BYTES;
  if (declaredLength > maxDirectBytes) {
    await cleanupAbandonedReservation(reservation);
    return failure('paid_fetch', 'direct_download_limit_exceeded', `Server declared ${declaredLength} bytes, over the ${maxDirectBytes}-byte direct download limit.`, 'Use a disposable paid access link flow; do not reconstruct this file from terminal output.', {
      requires_disposable_link: true,
      declared_bytes: declaredLength,
      max_direct_bytes: maxDirectBytes,
      payment_response: paymentResponse,
    });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await paidResponse.arrayBuffer());
  } catch (error) {
    await cleanupAbandonedReservation(reservation);
    return failure('paid_fetch', 'binary_read_failed', messageFor(error), 'Retry only by creating a fresh approved x402 payment for the same validated resource.', {
      payment_response: paymentResponse,
    });
  }
  if (buffer.byteLength > maxDirectBytes) {
    await cleanupAbandonedReservation(reservation);
    return failure('paid_fetch', 'direct_download_limit_exceeded', `Downloaded ${buffer.byteLength} bytes, over the ${maxDirectBytes}-byte direct download limit.`, 'Use a disposable paid access link flow; do not reconstruct this file from terminal output.', {
      requires_disposable_link: true,
      bytes: buffer.byteLength,
      max_direct_bytes: maxDirectBytes,
      payment_response: paymentResponse,
    });
  }

  const filename = filenameForResponse(paidResponse.headers, entry);
  const savedPath = reservation.finalPath;
  try {
    const handle = await fs.open(reservation.tempPath, 'r+');
    try {
      await handle.truncate(0);
      await handle.writeFile(buffer);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await cleanupAbandonedReservation(reservation);
    return failure('save', 'local_write_failed', messageFor(error), 'The paid bytes could not be written locally. Use a writable --out path before paying again with a fresh request-bound signature.', {
      saved_path: savedPath,
      payment_response: paymentResponse,
    });
  }

  const mimeType = normalizeDownloadMimeType(
    paidResponse.headers.get('content-type') ?? entry.mime_type,
  );
  const validation = validateDownloadedBytes(buffer, { filename, mimeType, declaredLength });
  const proof: DownloadProof = {
    ok: true,
    saved_path: savedPath,
    sha256: sha256Hex(buffer),
    bytes: buffer.byteLength,
    mime_type: mimeType,
    filename,
    resource_url: resourceUrl,
    product_id: entry.id,
    price_usd: entry.price_usd,
    network: paymentResponse?.network ?? spend.accept.network,
    asset: spend.accept.asset,
    pay_to: spend.accept.payTo,
    payer: paymentResponse?.payer ?? payment.payer,
    transaction: paymentResponse?.transaction,
    payment_response: paymentResponse,
    validation,
  };

  if (!validation.ok) {
    return failure('validation', 'validation_failed', validation.detail, 'Treat the local file as suspect and ask the creator for support; do not claim successful delivery.', undefined, proof);
  }

  const receipt = createDownloadReceipt({
    product_id: entry.id,
    saved_path: savedPath,
    filename,
    mime_type: mimeType,
    bytes: buffer.byteLength,
    sha256: proof.sha256,
    source_provider: sourceProvider(options),
    price_usd: entry.price_usd,
    network: proof.network,
    asset: proof.asset,
    pay_to: proof.pay_to,
    payer: proof.payer,
    transaction: proof.transaction,
    delivered_via: 'direct',
  });
  try {
    const committed = await commitDownloadWithReceipt(
      reservation.tempPath,
      reservation.finalPath,
      receipt,
      reservation.replaceExisting,
    );
    await releaseDownloadReservation(reservation);
    return {
      ...proof,
      receipt_path: committed.receiptPath,
      receipt_error: committed.receiptError,
      cleanup_warning: committed.cleanupWarning,
      backup_path: committed.backupPath,
      replacement_cleanup: committed.backupState,
      delivered_via: 'direct',
    };
  } catch (error) {
    return failure(
      'save',
      'atomic_commit_failed',
      messageFor(error),
      'Resume or choose another destination; do not repay.',
      { saved_path: reservation.finalPath },
    );
  }
}

export function parseEntitlementContinuation(
  input: Buffer | string,
): EntitlementPurchase {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  if (bytes.byteLength === 0) {
    throw new Error('Entitlement stdin was empty.');
  }
  if (bytes.byteLength > MAX_ENTITLEMENT_STDIN_BYTES) {
    throw new Error(
      `Entitlement stdin exceeds the ${MAX_ENTITLEMENT_STDIN_BYTES}-byte limit.`,
    );
  }
  const text = bytes.toString('utf8');
  if (text.includes('\uFFFD')) {
    throw new Error('Entitlement stdin must be valid UTF-8 JSON.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Entitlement stdin must contain one valid JSON object.');
  }
  return parseEntitlementPurchase(parsed);
}

export async function continueCuratoriaEntitlement(
  options: AgentDownloadOptions,
  purchase: EntitlementPurchase,
): Promise<DownloadResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const catalogUrl = options.catalogUrl ?? DEFAULT_CATALOG_URL;
  try {
    assertAllowedUrl(catalogUrl, options.allowedDomains);
  } catch (error) {
    return failure(
      'catalog',
      'catalog_domain_not_allowed',
      messageFor(error),
      'Pass --allow-domain for a trusted creator catalog.',
    );
  }
  const catalogResult = await fetchCatalog(catalogUrl, fetchImpl);
  if (!catalogResult.ok) return catalogResult;
  const entry = catalogResult.catalog.design_systems.find(
    candidate => candidate.id === options.productId,
  );
  if (!entry) {
    return failure(
      'selection',
      'product_not_found',
      `Product "${options.productId}" was not found in the catalog.`,
      'Stop. Do not pay or continue unless the product is currently published.',
    );
  }
  if (entry.resource_type !== 'binary_asset' || !entry.access_url) {
    return failure(
      'selection',
      'entitlement_product_unsupported',
      'Entitlement stdin requires a published binary asset with an access URL.',
      'Choose the matching published binary product.',
    );
  }
  const resourceUrl = absoluteUrl(
    entry.access_url,
    catalogResult.catalog.base_url ?? catalogUrl,
  );
  try {
    assertAllowedUrl(resourceUrl, options.allowedDomains);
  } catch (error) {
    return failure(
      'spend_validation',
      'resource_domain_not_allowed',
      messageFor(error),
      'Do not send the entitlement to an untrusted origin.',
    );
  }
  const challenge = await fetchPaymentChallenge(resourceUrl, fetchImpl);
  if (!challenge.ok) return challenge;
  const spend = validateSpend({
    catalog: catalogResult.catalog,
    entry,
    resourceUrl,
    paymentRequired: challenge.paymentRequired,
    maxAmountAtomic: options.maxAmountAtomic,
    maxTimeoutSeconds: options.maxTimeoutSeconds,
    allowedNetworks: options.allowedNetworks,
    allowedAssets: options.allowedAssets,
  });
  if (!spend.ok) {
    return failure(
      'spend_validation',
      'spend_validation_failed',
      spend.failures.join('; '),
      'Stop continuation because the published purchase contract has drifted.',
      { failures: spend.failures },
    );
  }
  return downloadEntitledBinaryAsset({
    options,
    entry,
    resourceUrl,
    challenge: challenge.paymentRequired,
    spend,
    fetchImpl,
    suppliedPurchase: purchase,
  });
}

export async function resumeCuratoriaDownload(
  statePath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DownloadResult> {
  let state;
  try {
    state = await readPrivateResumeState(statePath);
    validateEntitlementReceiptMetadata({
      receipt_id: state.receipt_id ?? '',
      product_id: state.product_id,
      source_provider: state.source_provider ?? '',
      network: state.network ?? '',
      payer: state.payer ?? '',
      filename: path.basename(state.final_path),
      transaction: state.transaction,
    });
  } catch (error) {
    return failure(
      'save',
      'resume_state_invalid',
      messageFor(error),
      'Use the owner-only resume state emitted by a failed entitlement download.',
    );
  }

  try {
    if (Date.parse(state.download_expires_at) <= Date.now()) {
      if (!state.redeem_url) {
        throw new Error('Signed URL expired and resume state has no redemption URL.');
      }
      const response = await fetchImpl(state.redeem_url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${state.entitlement}`,
        },
      });
      if (!response.ok) {
        throw new Error(`Entitlement refresh returned ${response.status} ${response.statusText}.`);
      }
      const redemption = parseEntitlementRedemption(await response.json());
      if (
        redemption.product_id !== state.product_id ||
        redemption.content_sha256 !== state.content_sha256 ||
        redemption.content_bytes !== state.content_bytes ||
        redemption.filename !== path.basename(state.final_path)
      ) {
        throw new Error('Refreshed redemption does not match resume state.');
      }
      assertPrivateBlobUrl(redemption.download_url);
      state.download_url = redemption.download_url;
      state.download_expires_at = redemption.expires_at;
      await writePrivateResumeState(statePath, state);
    } else {
      assertPrivateBlobUrl(state.download_url);
    }

    const streamed = await streamResumableDownload(state, fetchImpl);
    const sampleHandle = await fs.open(state.temp_path, 'r');
    const sample = Buffer.alloc(Math.min(8192, streamed.bytes));
    try {
      await sampleHandle.read(sample, 0, sample.byteLength, 0);
    } finally {
      await sampleHandle.close();
    }
    const validation = validateDownloadedBytes(sample, {
      filename: path.basename(state.final_path),
      mimeType: streamed.mimeType,
      declaredLength: state.content_bytes,
      actualLength: streamed.bytes,
    });
    if (!validation.ok) throw new Error(validation.detail);

    const committed = await commitDownloadWithReceipt(
      state.temp_path,
      state.final_path,
      createDownloadReceipt({
        receipt_id: state.receipt_id,
        product_id: state.product_id,
        saved_path: state.final_path,
        filename: path.basename(state.final_path),
        mime_type: streamed.mimeType,
        bytes: streamed.bytes,
        sha256: streamed.sha256,
        price_usd: state.price_usd,
        network: state.network,
        asset: state.asset,
        pay_to: state.pay_to,
        payer: state.payer,
        transaction: state.transaction,
        source_provider: state.source_provider ?? 'unknown',
        delivered_via: 'entitlement',
        resumed: true,
      }),
      state.replace_existing,
    );
    await removeFileDurably(statePath);
    if (state.reservation_path) await removeFileDurably(state.reservation_path);

    return {
      ok: true,
      saved_path: state.final_path,
      receipt_path: committed.receiptPath,
      receipt_error: committed.receiptError,
      cleanup_warning: committed.cleanupWarning,
      backup_path: committed.backupPath,
      replacement_cleanup: committed.backupState,
      sha256: streamed.sha256,
      bytes: streamed.bytes,
      mime_type: streamed.mimeType,
      filename: path.basename(state.final_path),
      resource_url: state.resource_url ?? state.redeem_url ?? '',
      product_id: state.product_id,
      price_usd: state.price_usd ?? '',
      network: state.network ?? '',
      asset: state.asset ?? '',
      pay_to: state.pay_to ?? '',
      payer: state.payer,
      transaction: state.transaction,
      validation,
      delivered_via: 'entitlement',
    };
  } catch (error) {
    try {
      await writePrivateResumeState(statePath, state);
    } catch {
      // Preserve the original resume failure and any prior private state.
    }
    return failure(
      'paid_fetch',
      'resume_failed',
      messageFor(error),
      'Keep the private state file and retry resume before the entitlement expires; do not repay.',
      {
        saved_path: state.final_path,
        resume_state_path: statePath,
      },
    );
  }
}

export function validateSpend(input: {
  catalog: CatalogResponse;
  entry: CatalogEntry;
  resourceUrl: string;
  paymentRequired: PaymentRequired;
  maxAmountAtomic?: number;
  maxTimeoutSeconds?: number;
  allowedNetworks?: string[];
  allowedAssets?: string[];
}): SpendValidation {
  const failures: string[] = [];
  const priceAtomic = priceUsdToAtomic(input.entry.price_usd);
  const accept = input.paymentRequired.accepts?.[0];
  if (!accept) {
    return {
      ok: false,
      failures: ['payment challenge did not include an accepted payment requirement'],
      priceAtomic,
      priceUsd: input.entry.price_usd,
    };
  }

  const maxAmountAtomic = input.maxAmountAtomic ?? DEFAULT_MAX_AMOUNT_ATOMIC;
  const maxTimeoutSeconds = input.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  const allowedNetworks = input.allowedNetworks ?? DEFAULT_ALLOWED_NETWORKS;
  const allowedAssets = (input.allowedAssets ?? DEFAULT_ALLOWED_ASSETS).map((asset) => asset.toLowerCase());
  const challengeResourceUrl = input.paymentRequired.resource?.url;
  const challengeMime = normalizeDownloadMimeType(input.paymentRequired.resource?.mimeType);
  const timeoutSeconds = Number(accept.maxTimeoutSeconds);

  if (accept.scheme !== 'exact') {
    failures.push(`scheme mismatch: expected "exact", challenge "${accept.scheme}"`);
  }
  if (normalizeAddress(accept.payTo) !== normalizeAddress(input.catalog.owner.wallet)) {
    failures.push(`payTo mismatch: catalog owner ${input.catalog.owner.wallet}, challenge ${accept.payTo}`);
  }
  if (challengeResourceUrl && normalizeUrl(challengeResourceUrl) !== normalizeUrl(input.resourceUrl)) {
    failures.push(`resource mismatch: catalog ${input.resourceUrl}, challenge ${challengeResourceUrl}`);
  }
  const expectedChallengeMime =
    input.entry.resource_type === 'binary_asset'
      ? 'application/json'
      : normalizeDownloadMimeType(input.entry.mime_type);
  if (challengeMime !== expectedChallengeMime) {
    failures.push(
      `response MIME mismatch: expected ${expectedChallengeMime}, challenge ${challengeMime}`,
    );
  }
  if (Number(accept.amount) !== priceAtomic) {
    failures.push(`amount mismatch: catalog ${priceAtomic} atomic USDC, challenge ${accept.amount}`);
  }
  if (Number(accept.amount) > maxAmountAtomic) {
    failures.push(`amount ${accept.amount} exceeds max ${maxAmountAtomic} atomic USDC`);
  }
  if (!allowedNetworks.includes(accept.network)) {
    failures.push(`network ${accept.network} is not allowed`);
  }
  if (!allowedAssets.includes(accept.asset.toLowerCase())) {
    failures.push(`asset ${accept.asset} is not allowed`);
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    failures.push('payment challenge is missing a positive maxTimeoutSeconds value');
  } else if (timeoutSeconds > maxTimeoutSeconds) {
    failures.push(`payment timeout ${timeoutSeconds}s exceeds max ${maxTimeoutSeconds}s`);
  }

  return {
    ok: failures.length === 0,
    failures,
    accept,
    priceAtomic,
    priceUsd: input.entry.price_usd,
  };
}

export function priceUsdToAtomic(priceUsd: string): number {
  const trimmed = priceUsd.trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(trimmed)) {
    throw new Error(`Invalid USD price: ${priceUsd}`);
  }
  const [dollars, cents = ''] = trimmed.split('.');
  return Number(dollars) * 1_000_000 + Number(cents.padEnd(6, '0'));
}

export function parseContentDispositionFilename(value: string | null): string | undefined {
  if (!value) return undefined;
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, ''));
    } catch {
      return utf8Match[1].trim().replace(/^"|"$/g, '');
    }
  }

  const asciiMatch = value.match(/filename="([^"]+)"|filename=([^;]+)/i);
  return (asciiMatch?.[1] || asciiMatch?.[2] || '').trim() || undefined;
}

export function resolveOutputPath(out: string | undefined, filename: string, homeDir = os.homedir()): string {
  const safeFilename = sanitizeDownloadFilename(filename, 'curatoria-download.bin');
  if (!out) {
    return path.join(homeDir, 'Downloads', safeFilename);
  }

  const expanded = out.startsWith('~/') ? path.join(homeDir, out.slice(2)) : out;
  if (expanded.endsWith('/') || expanded.endsWith(path.sep)) {
    return path.resolve(expanded, safeFilename);
  }

  const basename = path.basename(expanded);
  const looksLikeDirectory = !path.extname(basename);
  return looksLikeDirectory ? path.resolve(expanded, safeFilename) : path.resolve(expanded);
}

export function validateDownloadedBytes(
  buffer: Buffer,
  metadata: {
    filename: string;
    mimeType: string;
    declaredLength?: number;
    actualLength?: number;
  },
): ValidationResult {
  const actualLength = metadata.actualLength ?? buffer.byteLength;
  if (actualLength === 0) {
    return { ok: false, kind: 'opaque', detail: 'downloaded file is empty' };
  }
  if (metadata.declaredLength && metadata.declaredLength !== actualLength) {
    return {
      ok: false,
      kind: 'opaque',
      detail: `content-length mismatch: declared ${metadata.declaredLength}, saved ${actualLength}`,
    };
  }

  const lowerName = metadata.filename.toLowerCase();
  const mimeType = normalizeDownloadMimeType(metadata.mimeType);
  if (mimeType === 'application/zip' || lowerName.endsWith('.zip')) {
    return hasZipSignature(buffer)
      ? { ok: true, kind: 'zip', detail: 'zip signature ok' }
      : { ok: false, kind: 'zip', detail: 'missing PK zip signature' };
  }

  if (lowerName.endsWith('.psd') || mimeType === 'image/vnd.adobe.photoshop') {
    return buffer.subarray(0, 4).toString('latin1') === '8BPS'
      ? { ok: true, kind: 'psd', detail: 'PSD 8BPS signature ok' }
      : { ok: false, kind: 'psd', detail: 'missing PSD 8BPS signature' };
  }

  if (mimeType === 'text/markdown' || lowerName.endsWith('.md')) {
    const text = buffer.toString('utf8');
    if (buffer.includes(0) || text.includes('\uFFFD')) {
      return { ok: false, kind: 'markdown', detail: 'markdown is not clean UTF-8 text' };
    }
    return { ok: true, kind: 'markdown', detail: 'markdown readable' };
  }

  return { ok: true, kind: 'opaque', detail: 'opaque byte validation ok' };
}

export function makeFailure(
  stage: DownloaderStage,
  code: string,
  message: string,
  nextStep: string,
  details?: Record<string, unknown>,
  proof?: Partial<DownloadProof>,
): DownloadFailure {
  return failure(stage, code, message, nextStep, details, proof);
}

export function createExactEvmPrivateKeySigner(privateKey: string): PaymentSignerAdapter {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return {
    async createFreshPayment(paymentRequired: PaymentRequired): Promise<PaymentHeaderSet> {
      const client = new x402Client();
      registerExactEvmScheme(client, { signer: account });
      const httpClient = new x402HTTPClient(client);
      const payload = await httpClient.createPaymentPayload(paymentRequired as never);
      const authorization = (payload.payload as { authorization?: { from?: string } }).authorization;
      return {
        headers: httpClient.encodePaymentSignatureHeader(payload),
        payer: authorization?.from ?? account.address,
      };
    },
  };
}

function challengeFingerprintFor(
  resourceUrl: string,
  spend: Extract<SpendValidation, { ok: true }>,
): string {
  return fingerprintPaymentChallenge({
    resourceUrl,
    amount: spend.accept.amount,
    network: spend.accept.network,
    asset: spend.accept.asset,
    payTo: spend.accept.payTo,
  });
}

function spendAttemptIdFor(options: AgentDownloadOptions): string {
  return options.spendAttemptId ?? `attempt-${crypto.randomUUID()}`;
}

function budgetFailure(error: unknown): DownloadFailure {
  if (error instanceof SpendBudgetError) {
    return failure(
      'spend_validation',
      error.code,
      error.message,
      error.code === 'session_budget_exhausted'
        ? 'Stop. Do not pay. Reconcile pending or inconclusive attempts or start a new session budget.'
        : 'Fix the session budget file or attempt id before paying.',
    );
  }
  return failure(
    'spend_validation',
    'session_budget_failed',
    messageFor(error),
    'Fix the session budget file before paying.',
  );
}

async function reserveSpendBeforeWallet(input: {
  options: AgentDownloadOptions;
  attemptId: string;
  resourceUrl: string;
  spend: Extract<SpendValidation, { ok: true }>;
}): Promise<{ ok: true; fingerprint: string } | DownloadFailure> {
  if (!input.options.spendBudget) {
    return { ok: true, fingerprint: challengeFingerprintFor(input.resourceUrl, input.spend) };
  }
  const fingerprint = challengeFingerprintFor(input.resourceUrl, input.spend);
  try {
    await input.options.spendBudget.reserve(
      input.attemptId,
      input.spend.priceAtomic,
      fingerprint,
    );
    return { ok: true, fingerprint };
  } catch (error) {
    return budgetFailure(error);
  }
}

async function commitSpendFromSettlement(input: {
  options: AgentDownloadOptions;
  attemptId: string;
  receipt: SpendSettlementReceipt;
}): Promise<void> {
  if (!input.options.spendBudget) return;
  await input.options.spendBudget.commit(input.attemptId, input.receipt);
}

async function releaseSpendBeforeSettlement(
  options: AgentDownloadOptions,
  attemptId: string,
): Promise<void> {
  if (!options.spendBudget) return;
  try {
    await options.spendBudget.releaseBeforeSettlement(attemptId);
  } catch {
    // Keep the original failure; a missing reservation is not a second error.
  }
}

async function markSpendInconclusive(
  options: AgentDownloadOptions,
  attemptId: string,
): Promise<void> {
  if (!options.spendBudget) return;
  try {
    await options.spendBudget.markInconclusive(attemptId);
  } catch {
    // Keep the original failure; budget already consumed if the attempt exists.
  }
}

async function writePreparedPurchaseContext(input: {
  options: AgentDownloadOptions;
  attemptId: string;
  entry: CatalogEntry;
  resourceUrl: string;
  challenge: PaymentRequired;
  spend: Extract<SpendValidation, { ok: true }>;
  fingerprint: string;
}): Promise<DownloadFailure> {
  const contextPath = input.options.purchaseContextPath;
  if (!contextPath) {
    await releaseSpendBeforeSettlement(input.options, input.attemptId);
    return failure(
      'payment',
      'purchase_context_missing',
      'Preparing an external payment requires --purchase-context with an absolute path.',
      'Pass --purchase-context and rerun destination, challenge, and budget preflight.',
    );
  }
  try {
    const remaining = input.options.spendBudget
      ? await input.options.spendBudget.remaining()
      : input.spend.priceAtomic;
    const context: ExternalPurchaseContext = {
      version: 1,
      attempt_id: input.attemptId,
      product_id: input.entry.id,
      resource_url: input.resourceUrl,
      amount_atomic: input.spend.priceAtomic,
      network: input.spend.accept.network,
      asset: input.spend.accept.asset,
      pay_to: input.spend.accept.payTo,
      challenge_fingerprint: input.fingerprint,
      payment_required: input.challenge,
    };
    await writeOwnerOnlyJson(contextPath, context, 'Purchase context file');
    return failure(
      'payment',
      'prepared_external_payment',
      'Destination, challenge, and session budget preflight passed. No payment was attempted.',
      'Call check_payment_requirements, confirm exactly 10000 Base USDC to the expected payee and URL, then make_x402_request once. Pipe entitlement JSON to --entitlement-stdin. Do not auto-repay.',
      {
        purchase_context_path: contextPath,
        attempt_id: input.attemptId,
        remaining,
        resource_url: input.resourceUrl,
        product_id: input.entry.id,
        amount_atomic: input.spend.priceAtomic,
        challenge_fingerprint: input.fingerprint,
      },
    );
  } catch (error) {
    await releaseSpendBeforeSettlement(input.options, input.attemptId);
    return failure(
      'payment',
      'purchase_context_write_failed',
      messageFor(error),
      'Fix the --purchase-context path and rerun preflight; the reservation was released.',
    );
  }
}

function isProvenPreSettlementFailure(error: unknown): boolean {
  return error instanceof WalletPurchasePreflightError;
}

function settlementReceiptFromPurchase(
  purchase: EntitlementPurchase,
  paymentResponse?: SettleResponse,
  payer?: string,
): SpendSettlementReceipt {
  return {
    receipt_id: purchase.receipt_id,
    transaction: paymentResponse?.transaction ?? purchaseTransaction(purchase),
    payer: paymentResponse?.payer ?? purchase.payer ?? payer,
    network: paymentResponse?.network ?? purchase.network,
    source_provider: purchase.source_provider,
  };
}

async function downloadEntitledBinaryAsset(input: {
  options: AgentDownloadOptions;
  entry: CatalogEntry;
  resourceUrl: string;
  challenge: PaymentRequired;
  spend: Extract<SpendValidation, { ok: true }>;
  fetchImpl: typeof fetch;
  suppliedPurchase?: EntitlementPurchase;
}): Promise<DownloadResult> {
  const {
    options,
    entry,
    resourceUrl,
    challenge,
    spend,
    fetchImpl,
    suppliedPurchase,
  } = input;
  const expectedSha256 = normalizeSha256(entry.content_sha256);
  const expectedBytes = Number(entry.content_bytes);
  const expectedFilename = entry.download_filename;
  if (
    !expectedSha256 ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes <= 0 ||
    !expectedFilename
  ) {
    return failure(
      'selection',
      'asset_integrity_metadata_missing',
      'Binary asset catalog metadata is missing a verified hash, byte count, or filename.',
      'Ask the creator to re-import and publish the immutable asset before paying.',
    );
  }

  let reservation;
  try {
    reservation = await preflightDownloadDestination({
      out: options.out,
      filename: expectedFilename,
      contentBytes: expectedBytes,
      yes: options.yes,
      collisionPolicy: options.collisionPolicy,
      stateDirectory: options.stateDirectory,
      isTTY: options.isTTY,
      prompt: options.prompt ?? promptForDestination,
      statfs: options.statfs,
    });
  } catch (error) {
    return failure(
      'save',
      'destination_preflight_failed',
      messageFor(error),
      'Choose a writable --out destination before approving payment.',
    );
  }

  let purchase: EntitlementPurchase;
  let paymentResponse: SettleResponse | undefined;
  let payer: string | undefined;
  const attemptId = spendAttemptIdFor(options);
  let reservedFingerprint: string | undefined;
  try {
    if (suppliedPurchase) {
      purchase = suppliedPurchase;
    } else {
      const reserved = await reserveSpendBeforeWallet({
        options,
        attemptId,
        resourceUrl,
        spend,
      });
      if (!reserved.ok) {
        await cleanupAbandonedReservation(reservation);
        return reserved;
      }
      reservedFingerprint = reserved.fingerprint;
      if (options.prepareExternalPayment) {
        await cleanupAbandonedReservation(reservation);
        return writePreparedPurchaseContext({
          options,
          attemptId,
          entry,
          resourceUrl,
          challenge,
          spend,
          fingerprint: reserved.fingerprint,
        });
      }
      if (options.entitlementPurchaser) {
        purchase = await options.entitlementPurchaser.purchase({
          url: resourceUrl,
          challenge,
          maxAmountAtomic: options.maxAmountAtomic ?? DEFAULT_MAX_AMOUNT_ATOMIC,
        });
      } else {
        const payment = await createPaymentHeaders(challenge, options);
        if (!payment.ok) {
          await releaseSpendBeforeSettlement(options, attemptId);
          await cleanupAbandonedReservation(reservation);
          return payment;
        }
        payer = payment.payer;
        const response = await fetchImpl(resourceUrl, {
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'identity',
            ...payment.headers,
          },
        });
        paymentResponse = parsePaymentResponse(response.headers);
        if (!response.ok) {
          await markSpendInconclusive(options, attemptId);
          await cleanupAbandonedReservation(reservation);
          return failure(
            'paid_fetch',
            'entitlement_purchase_failed',
            `Paid entitlement request returned ${response.status} ${response.statusText}.`,
            'Keep the payment response and use payment recovery; do not pay again silently.',
            {
              status: response.status,
              payment_response: paymentResponse,
            },
          );
        }
        purchase = parseEntitlementPurchase(await response.json());
      }
      try {
        await commitSpendFromSettlement({
          options,
          attemptId,
          receipt: settlementReceiptFromPurchase(purchase, paymentResponse, payer),
        });
      } catch {
        await markSpendInconclusive(options, attemptId);
      }
    }
    assertEntitlementMatchesCatalog(
      purchase,
      entry,
      expectedSha256,
      expectedBytes,
      spend.accept.network,
    );
  } catch (error) {
    await cleanupAbandonedReservation(reservation);
    if (!suppliedPurchase && reservedFingerprint) {
      if (isProvenPreSettlementFailure(error)) {
        await releaseSpendBeforeSettlement(options, attemptId);
      } else {
        await markSpendInconclusive(options, attemptId);
      }
    }
    return failure(
      'payment',
      'entitlement_purchase_invalid',
      messageFor(error),
      'Keep the payment receipt and contact the creator; do not pay again silently.',
      { saved_path: reservation.finalPath },
    );
  }

  const redeemUrl = absoluteUrl(purchase.redeem_url, resourceUrl);
  try {
    assertSameOrigin(resourceUrl, redeemUrl);
  } catch (error) {
    await cleanupAbandonedReservation(reservation);
    return failure(
      'paid_fetch',
      'entitlement_redeem_url_invalid',
      messageFor(error),
      'Do not send the entitlement to another origin.',
    );
  }

  let redemption: EntitlementRedemption;
  try {
    const response = await fetchImpl(redeemUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${purchase.entitlement}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Entitlement redemption returned ${response.status} ${response.statusText}.`);
    }
    redemption = parseEntitlementRedemption(await response.json());
    assertRedemptionMatchesPurchase(redemption, purchase);
    assertPrivateBlobUrl(redemption.download_url);
  } catch (error) {
    await cleanupAbandonedReservation(reservation);
    return failure(
      'paid_fetch',
      'entitlement_redemption_failed',
      messageFor(error),
      'Retry redemption with the same entitlement before it expires; do not repay.',
    );
  }

  const resumeState: DownloadResumeState = {
    version: 1,
    product_id: entry.id,
    temp_path: reservation.tempPath,
    final_path: reservation.finalPath,
    bytes_written: 0,
    content_sha256: expectedSha256,
    content_bytes: expectedBytes,
    download_url: redemption.download_url,
    download_expires_at: redemption.expires_at,
    entitlement: purchase.entitlement,
    redeem_url: redeemUrl,
    reservation_path: reservation.reservationPath,
    replace_existing: reservation.replaceExisting,
    resource_url: resourceUrl,
    price_usd: entry.price_usd,
    network: paymentResponse?.network ?? purchase.network ?? spend.accept.network,
    asset: spend.accept.asset,
    pay_to: spend.accept.payTo,
    payer: paymentResponse?.payer ?? purchase.payer ?? payer,
    transaction: paymentResponse?.transaction ?? purchaseTransaction(purchase),
    source_provider: purchase.source_provider ?? sourceProvider(options),
    receipt_id: purchase.receipt_id,
  };
  await writePrivateResumeState(reservation.statePath, resumeState);

  let streamed: Awaited<ReturnType<typeof streamResumableDownload>>;
  try {
    streamed = await streamResumableDownload(resumeState, fetchImpl);
  } catch (error) {
    try {
      await writePrivateResumeState(reservation.statePath, resumeState);
    } catch {
      // Preserve the original streaming failure and any prior private state.
    }
    return failure(
      'paid_fetch',
      'signed_download_failed',
      messageFor(error),
      'Resume from the private state file with the same entitlement; do not repay.',
      {
        saved_path: reservation.finalPath,
        resume_state_path: reservation.statePath,
      },
    );
  }

  const sampleHandle = await fs.open(reservation.tempPath, 'r');
  const sample = Buffer.alloc(Math.min(8192, streamed.bytes));
  try {
    await sampleHandle.read(sample, 0, sample.byteLength, 0);
  } finally {
    await sampleHandle.close();
  }
  const mimeType = normalizeDownloadMimeType(streamed.mimeType || purchase.mime_type);
  const byteValidation = validateDownloadedBytes(sample, {
    filename: purchase.filename,
    mimeType,
    declaredLength: expectedBytes,
    actualLength: streamed.bytes,
  });
  if (!byteValidation.ok) {
    return failure(
      'validation',
      'download_integrity_failed',
      byteValidation.detail,
      'Keep the private resume state and suspect temp file for diagnosis; do not repay.',
      {
        saved_path: reservation.finalPath,
        resume_state_path: reservation.statePath,
      },
    );
  }

  let committed: Awaited<ReturnType<typeof commitDownloadWithReceipt>>;
  try {
    committed = await commitDownloadWithReceipt(
      reservation.tempPath,
      reservation.finalPath,
      createDownloadReceipt({
        receipt_id: purchase.receipt_id,
        product_id: entry.id,
        saved_path: reservation.finalPath,
        filename: purchase.filename,
        mime_type: mimeType,
        bytes: streamed.bytes,
        sha256: streamed.sha256,
        price_usd: entry.price_usd,
        network: paymentResponse?.network ?? purchase.network ?? spend.accept.network,
        asset: spend.accept.asset,
        pay_to: spend.accept.payTo,
        payer: paymentResponse?.payer ?? purchase.payer ?? payer,
        transaction: paymentResponse?.transaction ?? purchaseTransaction(purchase),
        source_provider: purchase.source_provider ?? sourceProvider(options),
        delivered_via: 'entitlement',
      }),
      reservation.replaceExisting,
    );
    await removeFileDurably(reservation.statePath);
    await releaseDownloadReservation(reservation);
  } catch (error) {
    return failure(
      'save',
      'atomic_commit_failed',
      messageFor(error),
      'Resolve the destination collision, then resume without repaying.',
      {
        saved_path: reservation.finalPath,
        resume_state_path: reservation.statePath,
      },
    );
  }

  return {
    ok: true,
    saved_path: reservation.finalPath,
    receipt_path: committed.receiptPath,
    receipt_error: committed.receiptError,
    cleanup_warning: committed.cleanupWarning,
    backup_path: committed.backupPath,
    replacement_cleanup: committed.backupState,
    sha256: streamed.sha256,
    bytes: streamed.bytes,
    mime_type: mimeType,
    filename: purchase.filename,
    resource_url: resourceUrl,
    product_id: entry.id,
    price_usd: entry.price_usd,
    network: paymentResponse?.network ?? purchase.network ?? spend.accept.network,
    asset: spend.accept.asset,
    pay_to: spend.accept.payTo,
    payer: paymentResponse?.payer ?? purchase.payer ?? payer,
    transaction: paymentResponse?.transaction ?? purchaseTransaction(purchase),
    payment_response: paymentResponse,
    validation: byteValidation,
    delivered_via: 'entitlement',
  };
}

type EntitlementRedemption = {
  product_id: string;
  download_url: string;
  expires_at: string;
  filename: string;
  mime_type: string;
  content_sha256: string;
  content_bytes: number;
};

function parseEntitlementPurchase(value: unknown): EntitlementPurchase {
  return parseEntitlementMetadata(value, false) as EntitlementPurchase;
}

function parseEntitlementRedemption(value: unknown): EntitlementRedemption {
  return parseEntitlementMetadata(value, true) as EntitlementRedemption;
}

function parseEntitlementMetadata(
  value: unknown,
  redemption: boolean,
): EntitlementPurchase | EntitlementRedemption {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Entitlement response was not a JSON object.');
  }
  const candidate = value as Record<string, unknown>;
  const sha = normalizeSha256(candidate.content_sha256);
  const urlField = redemption ? 'download_url' : 'redeem_url';
  const tokenValid = redemption || typeof candidate.entitlement === 'string';
  const receiptValid =
    redemption ||
    (typeof candidate.receipt_id === 'string' &&
      typeof candidate.source_provider === 'string' &&
      typeof candidate.network === 'string' &&
      typeof candidate.payer === 'string');
  if (
    typeof candidate.product_id !== 'string' ||
    !tokenValid ||
    !receiptValid ||
    typeof candidate[urlField] !== 'string' ||
    typeof candidate.expires_at !== 'string' ||
    typeof candidate.filename !== 'string' ||
    typeof candidate.mime_type !== 'string' ||
    !sha ||
    !Number.isSafeInteger(candidate.content_bytes) ||
    Number(candidate.content_bytes) <= 0
  ) {
    throw new Error('Entitlement response is missing required immutable metadata.');
  }
  const parsed = {
    product_id: candidate.product_id,
    ...(redemption
      ? { download_url: candidate.download_url }
      : {
          receipt_id: candidate.receipt_id,
          source_provider: candidate.source_provider,
          network: candidate.network,
          payer: candidate.payer,
          ...(typeof candidate.transaction === 'string'
            ? { transaction: candidate.transaction }
            : {}),
          entitlement: candidate.entitlement,
          redeem_url: candidate.redeem_url,
        }),
    expires_at: candidate.expires_at,
    filename: candidate.filename,
    mime_type: candidate.mime_type,
    content_sha256: sha,
    content_bytes: Number(candidate.content_bytes),
  } as EntitlementPurchase | EntitlementRedemption;
  if (!redemption) {
    const purchase = parsed as EntitlementPurchase;
    validateEntitlementReceiptMetadata({
      receipt_id: purchase.receipt_id,
      product_id: purchase.product_id,
      source_provider: purchase.source_provider,
      network: purchase.network,
      payer: purchase.payer,
      filename: purchase.filename,
      transaction: purchaseTransaction(purchase),
    });
  }
  return parsed;
}

function assertEntitlementMatchesCatalog(
  purchase: EntitlementPurchase,
  entry: CatalogEntry,
  sha256: string,
  bytes: number,
  network: string,
): void {
  validateEntitlementReceiptMetadata({
    receipt_id: purchase.receipt_id,
    product_id: purchase.product_id,
    source_provider: purchase.source_provider,
    network: purchase.network,
    payer: purchase.payer,
    filename: purchase.filename,
    transaction: purchaseTransaction(purchase),
  });
  if (
    purchase.product_id !== entry.id ||
    purchase.filename !== entry.download_filename ||
    purchase.mime_type !== entry.mime_type ||
    purchase.content_sha256 !== sha256 ||
    purchase.content_bytes !== bytes ||
    purchase.network !== network ||
    !purchase.receipt_id ||
    !purchase.source_provider ||
    !purchase.payer
  ) {
    throw new Error('Entitlement metadata does not match the catalog product.');
  }
}

function purchaseTransaction(
  purchase: EntitlementPurchase,
): string | undefined {
  const transaction = (purchase as EntitlementPurchase & {
    transaction?: unknown;
  }).transaction;
  return typeof transaction === 'string' ? transaction : undefined;
}

function assertRedemptionMatchesPurchase(
  redemption: EntitlementRedemption,
  purchase: EntitlementPurchase,
): void {
  if (
    redemption.product_id !== purchase.product_id ||
    redemption.filename !== purchase.filename ||
    redemption.mime_type !== purchase.mime_type ||
    redemption.content_sha256 !== purchase.content_sha256 ||
    redemption.content_bytes !== purchase.content_bytes
  ) {
    throw new Error('Redeemed download metadata does not match the paid entitlement.');
  }
}

function assertSameOrigin(expectedUrl: string, actualUrl: string): void {
  if (new URL(expectedUrl).origin !== new URL(actualUrl).origin) {
    throw new Error('Entitlement redemption must stay on the paid resource origin.');
  }
}

function assertPrivateBlobUrl(rawUrl: string): void {
  const url = new URL(rawUrl);
  if (
    url.protocol !== 'https:' ||
    (!url.hostname.endsWith('.blob.vercel-storage.com') &&
      url.hostname !== 'blob.vercel-storage.com') ||
    url.username ||
    url.password
  ) {
    throw new Error('Signed download URL is not an allowed private Vercel Blob URL.');
  }
}

async function fetchCatalog(
  catalogUrl: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; catalog: CatalogResponse } | DownloadFailure> {
  try {
    const res = await fetchImpl(catalogUrl, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return failure('catalog', 'catalog_fetch_failed', `Catalog fetch returned ${res.status} ${res.statusText}.`, 'Check the catalog URL and network connection.');
    }
    const catalog = await res.json() as Partial<CatalogResponse>;
    if (!Array.isArray(catalog.design_systems)) {
      return failure('catalog', 'paid_catalog_not_supported', 'The public catalog did not include design_systems[].', 'Use a free discovery catalog for this downloader increment.');
    }
    return { ok: true, catalog: catalog as CatalogResponse };
  } catch (error) {
    return failure('catalog', 'catalog_fetch_failed', messageFor(error), 'Check the catalog URL and network connection.');
  }
}

async function fetchPaymentChallenge(
  resourceUrl: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; paymentRequired: PaymentRequired } | DownloadFailure> {
  let res: Response;
  try {
    res = await fetchImpl(resourceUrl, {
      headers: { Accept: 'application/octet-stream,*/*;q=0.8' },
    });
  } catch (error) {
    return failure('challenge', 'challenge_fetch_failed', messageFor(error), 'Retry after checking network access to the paid route.');
  }

  if (res.status !== 402) {
    return failure('challenge', 'expected_402', `Expected 402 payment challenge, got ${res.status}.`, 'Confirm the selected product is an x402 paid route.');
  }

  const header = res.headers.get('payment-required') ?? res.headers.get('PAYMENT-REQUIRED');
  if (!header) {
    return failure('challenge', 'missing_payment_required', '402 response did not include PAYMENT-REQUIRED.', 'Fix server CORS/header behavior before payment.');
  }

  try {
    return { ok: true, paymentRequired: decodePaymentRequiredHeader(header) as PaymentRequired };
  } catch (error) {
    return failure('challenge', 'invalid_payment_required', messageFor(error), 'Fix the x402 challenge before attempting payment.');
  }
}

async function createPaymentHeaders(
  paymentRequired: PaymentRequired,
  options: AgentDownloadOptions,
): Promise<PaymentMetadata | DownloadFailure> {
  if (options.paymentHeader) {
    return failure(
      'payment',
      'prebuilt_payment_header_unsupported',
      'Prebuilt PAYMENT-SIGNATURE headers are not accepted by this downloader.',
      'Use a signer adapter or --private-key-env proof path so each paid fetch gets a fresh x402 payload bound to the validated request.',
    );
  }

  if (options.walletMode === 'awal') {
    return failure(
      'payment',
      'awal_binary_header_unavailable',
      '`awal x402 pay` remains a settlement/debug proof path here; it does not expose a safe signer handoff for byte-safe local saves.',
      'Use a signer adapter or --private-key-env for a controlled test wallet proof. Do not save binary files from awal JSON/string output.',
    );
  }
  if (options.walletMode === 'agentcash') {
    return failure(
      'payment',
      'agentcash_binary_header_unavailable',
      '`agentcash fetch` remains an entitlement-adapter proof path here; it does not expose a safe signer handoff for byte-safe local saves.',
      'Pass --agentcash-executable so an entitlement adapter is supplied; do not save binary files from agentcash JSON/string output directly.',
    );
  }

  const signer = options.paymentSigner ?? signerFromPrivateKeyEnv(options.privateKeyEnv);
  if (!signer) {
    return failure('payment', 'payment_source_missing', 'No binary-safe payment signer was provided.', 'Use --private-key-env for a funded test wallet, or integrate a signer adapter that creates a fresh x402 payment after validation. The current awal CLI path is settlement/debug only.');
  }

  try {
    const payment = await signer.createFreshPayment(paymentRequired);
    return { ok: true, headers: payment.headers, payer: payment.payer };
  } catch (error) {
    return failure('payment', 'payment_header_creation_failed', messageFor(error), 'Check the signer, private key env var, and wallet balance, then retry only with approval.');
  }
}

function signerFromPrivateKeyEnv(privateKeyEnv: string | undefined): PaymentSignerAdapter | undefined {
  const privateKey = privateKeyEnv ? process.env[privateKeyEnv]?.trim() : undefined;
  return privateKey ? createExactEvmPrivateKeySigner(privateKey) : undefined;
}

async function promptForApproval(
  entry: CatalogEntry,
  spend: Extract<SpendValidation, { ok: true }>,
  resourceUrl: string,
): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      `Pay ${spend.accept.amount} atomic USDC (${entry.price_usd} USD) for ${entry.id} at ${resourceUrl}? [y/N] `,
    );
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function promptForDestination(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return '';
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export function sourceProvider(options: AgentDownloadOptions): string {
  if (options.walletMode === 'awal') return 'awal';
  if (options.walletMode === 'agentcash') return 'agentcash';
  if (options.walletMode === 'external') return 'external-wallet-bridge';
  if (options.walletMode === 'private-key') return 'x402-private-key';
  if (options.entitlementPurchaser) return 'entitlement-adapter';
  if (options.paymentSigner) return 'x402-signer-adapter';
  return 'unknown';
}

function filenameForResponse(headers: Headers, entry: CatalogEntry): string {
  const fromDisposition = parseContentDispositionFilename(headers.get('content-disposition'));
  if (fromDisposition) return sanitizeDownloadFilename(fromDisposition, fallbackFilename(entry));
  return sanitizeDownloadFilename(fallbackFilename(entry));
}

function fallbackFilename(entry: CatalogEntry): string {
  const type = normalizeDownloadMimeType(entry.mime_type);
  const extension =
    type === 'application/zip' || entry.resource_type === 'bundle_zip'
      ? '.zip'
      : type === 'text/markdown'
        ? '.md'
        : '.bin';
  return `${entry.id}${extension}`;
}

function parsePaymentResponse(headers: Headers): SettleResponse | undefined {
  const header = headers.get('payment-response') ?? headers.get('PAYMENT-RESPONSE') ?? headers.get('x-payment-response');
  if (!header) return undefined;
  try {
    return decodePaymentResponseHeader(header) as SettleResponse;
  } catch {
    return undefined;
  }
}

async function readSmallErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

function assertAllowedUrl(rawUrl: string, allowedDomains = DEFAULT_ALLOWED_DOMAINS): void {
  const parsed = new URL(rawUrl);
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (isLocalhost(host)) return;
  if (parsed.protocol !== 'https:') {
    throw new Error(`Non-local URL must use https: ${rawUrl}`);
  }
  if (!allowedDomains.map((domain) => domain.toLowerCase()).includes(host)) {
    throw new Error(`Domain ${host} is not allowed`);
  }
}

function absoluteUrl(value: string, base: string): string {
  return new URL(value, base).toString();
}

function normalizeUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function hasZipSignature(buffer: Buffer): boolean {
  return (
    buffer.byteLength >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    [0x03, 0x05, 0x07].includes(buffer[2]) &&
    [0x04, 0x06, 0x08].includes(buffer[3])
  );
}

function isLocalhost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function failure(
  stage: DownloaderStage,
  code: string,
  message: string,
  nextStep: string,
  details?: Record<string, unknown>,
  proof?: Partial<DownloadProof>,
): DownloadFailure {
  return { ok: false, stage, code, message, next_step: nextStep, details, proof };
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
