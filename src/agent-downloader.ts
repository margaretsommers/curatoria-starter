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
import { sanitizeDownloadFilename } from './delivery';

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
  privateKeyEnv?: string;
  walletMode?: 'private-key' | 'awal' | 'dry-run';
  fetchImpl?: typeof fetch;
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

  const approved = options.yes ?? await promptForApproval(entry, spend, resourceUrl);
  if (!approved) {
    return failure('approval', 'payment_cancelled', 'Payment was not approved.', 'Rerun only when the user approves this exact resource and amount.');
  }

  const payment = await createPaymentHeaders(challenge.paymentRequired, options);
  if (!payment.ok) return payment;

  const paidResponse = await fetchImpl(resourceUrl, {
    headers: {
      Accept: entry.mime_type ?? 'application/octet-stream,*/*;q=0.8',
      'Accept-Encoding': 'identity',
      ...payment.headers,
    },
  });
  const paymentResponse = parsePaymentResponse(paidResponse.headers);
  if (!paidResponse.ok) {
    return failure('paid_fetch', 'paid_fetch_failed', `Paid fetch returned ${paidResponse.status} ${paidResponse.statusText}.`, 'Keep the payment response and contact the creator; do not re-pay silently.', {
      status: paidResponse.status,
      body: await readSmallErrorBody(paidResponse),
      payment_response: paymentResponse,
    });
  }

  const declaredLength = Number(paidResponse.headers.get('content-length') ?? '0');
  const maxDirectBytes = options.maxDirectBytes ?? DEFAULT_MAX_DIRECT_BYTES;
  if (declaredLength > maxDirectBytes) {
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
    return failure('paid_fetch', 'binary_read_failed', messageFor(error), 'Retry only by creating a fresh approved x402 payment for the same validated resource.', {
      payment_response: paymentResponse,
    });
  }
  if (buffer.byteLength > maxDirectBytes) {
    return failure('paid_fetch', 'direct_download_limit_exceeded', `Downloaded ${buffer.byteLength} bytes, over the ${maxDirectBytes}-byte direct download limit.`, 'Use a disposable paid access link flow; do not reconstruct this file from terminal output.', {
      requires_disposable_link: true,
      bytes: buffer.byteLength,
      max_direct_bytes: maxDirectBytes,
      payment_response: paymentResponse,
    });
  }

  const filename = filenameForResponse(paidResponse.headers, entry);
  const savedPath = resolveOutputPath(options.out, filename);
  try {
    await fs.mkdir(path.dirname(savedPath), { recursive: true });
    await fs.writeFile(savedPath, buffer);
  } catch (error) {
    return failure('save', 'local_write_failed', messageFor(error), 'The paid bytes could not be written locally. Use a writable --out path before paying again with a fresh request-bound signature.', {
      saved_path: savedPath,
      payment_response: paymentResponse,
    });
  }

  const mimeType = normalizeMime(paidResponse.headers.get('content-type') ?? entry.mime_type);
  const validation = validateDownloadedBytes(buffer, { filename, mimeType, declaredLength });
  const proof: DownloadProof = {
    ok: true,
    saved_path: savedPath,
    sha256: sha256(buffer),
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

  return proof;
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
  const timeoutSeconds = Number(accept.maxTimeoutSeconds);

  if (normalizeAddress(accept.payTo) !== normalizeAddress(input.catalog.owner.wallet)) {
    failures.push(`payTo mismatch: catalog owner ${input.catalog.owner.wallet}, challenge ${accept.payTo}`);
  }
  if (challengeResourceUrl && normalizeUrl(challengeResourceUrl) !== normalizeUrl(input.resourceUrl)) {
    failures.push(`resource mismatch: catalog ${input.resourceUrl}, challenge ${challengeResourceUrl}`);
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
  metadata: { filename: string; mimeType: string; declaredLength?: number },
): ValidationResult {
  if (buffer.byteLength === 0) {
    return { ok: false, kind: 'opaque', detail: 'downloaded file is empty' };
  }
  if (metadata.declaredLength && metadata.declaredLength !== buffer.byteLength) {
    return {
      ok: false,
      kind: 'opaque',
      detail: `content-length mismatch: declared ${metadata.declaredLength}, saved ${buffer.byteLength}`,
    };
  }

  const lowerName = metadata.filename.toLowerCase();
  const mimeType = normalizeMime(metadata.mimeType);
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

function filenameForResponse(headers: Headers, entry: CatalogEntry): string {
  const fromDisposition = parseContentDispositionFilename(headers.get('content-disposition'));
  if (fromDisposition) return sanitizeDownloadFilename(fromDisposition, fallbackFilename(entry));
  return sanitizeDownloadFilename(fallbackFilename(entry));
}

function fallbackFilename(entry: CatalogEntry): string {
  const type = normalizeMime(entry.mime_type);
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

function normalizeMime(mimeType: string | null | undefined): string {
  return (mimeType ?? 'application/octet-stream').split(';', 1)[0].trim().toLowerCase() || 'application/octet-stream';
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

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
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
