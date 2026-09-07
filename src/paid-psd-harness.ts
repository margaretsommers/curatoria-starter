/**
 * Loopback-only paid PSD preview harness. Uses the generated tiny RGB fixture
 * and an explicitly labeled fake settlement. Refuses production origins and
 * production wallet configuration. Never spends.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { Express, Request } from 'express';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';

import { createApp, type AppConfig, type AppDependencies, type AppLogger } from './app';
import { AssetDeliveryService } from './asset-delivery';
import { BlobEntitlementStore } from './blob-entitlement-store';
import { createSignedBlobDownload, type BlobSdkAdapter } from './blob-storage';
import { createLocalBlobDownloadHandler, type LocalBlobStore } from './local-blob-storage';
import { sha256Hex } from './content-integrity';
import { DestinationPreflightError, preflightDownloadDestination } from './destination-preflight';
import { commitDownloadWithReceipt, type DownloadResumeState } from './local-delivery';
import { createDownloadReceipt } from './download-receipt';
import { EntitlementService, type EntitlementKeyring } from './entitlements';
import { streamResumableDownload } from './resumable-download';
import type { CatalogResponse, PaymentRequired } from './types';
import {
  createObservabilityEvent,
  createObservabilitySink,
  type ObservabilityEvent,
  type ObservabilitySink,
} from './observability';
import { buildTinyRgbPsd } from '../scripts/generate-psd-fixture';
import { InMemoryFixedWindowRateLimiter } from './rate-limit';
import type { DesignSystemEntry } from './types';
import { X402_SETTLEMENT_LOCAL } from './x402';

export const FAKE_SETTLEMENT_LABEL = 'FAKE_SETTLEMENT_NO_SPEND';
export const PREVIEW_PRODUCT_ID = 'tiny-rgb-1x1';
export const PREVIEW_WALLET = '0x0000000000000000000000000000000000000a01';
export const PREVIEW_PAYER = '0x2222222222222222222222222222222222222222';
export const PREVIEW_NETWORK = 'eip155:84532';
export const PRODUCTION_WALLET = '0x8aa327403ed786ca56eb8f59c6c8831a8bd73485';

export const PREVIEW_FAKE_SETTLEMENT = {
  label: FAKE_SETTLEMENT_LABEL,
  network: PREVIEW_NETWORK,
  payer: PREVIEW_PAYER,
  transaction: `0x${'c'.repeat(64)}`,
} as const;

export const PRODUCTION_ENV_NAMES = [
  'NODE_ENV',
  'WALLET_ADDRESS',
  'WALLET_ENS',
  'NETWORK',
  'PUBLIC_BASE_URL',
  'BLOB_STORE_ID',
  'BLOB_READ_WRITE_TOKEN',
  'CDP_API_KEY_ID',
  'CDP_API_KEY_SECRET',
  'FACILITATOR_URL',
] as const;

export type PreviewFault =
  | 'none'
  | 'blob_failure'
  | 'signing_failure'
  | 'url_expiry'
  | 'disconnect'
  | 'disk_full'
  | 'receipt_write_failure';

export type PreviewHarness = {
  app: Express;
  config: AppConfig;
  events: ObservabilityEvent[];
  observe: ObservabilitySink;
  product: DesignSystemEntry;
  fixture: { bytes: Buffer; sha256: string; bytesCount: number };
  settlement: typeof PREVIEW_FAKE_SETTLEMENT;
  paymentSignature: string;
  logger: AppLogger;
};

const PRODUCTION_HOSTS = new Set(['curatoria.dev', 'www.curatoria.dev']);

export function generatedPreviewFixture(): { bytes: Buffer; sha256: string; bytesCount: number } {
  const bytes = buildTinyRgbPsd();
  return { bytes, sha256: sha256Hex(bytes), bytesCount: bytes.byteLength };
}

export function previewPaymentSignature(): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: {
        scheme: 'exact',
        network: PREVIEW_NETWORK,
        amount: '10000',
        payTo: PREVIEW_WALLET,
        maxTimeoutSeconds: 300,
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        extra: {},
      },
      payload: {
        signature: `0x${'ab'.repeat(65)}`,
        authorization: {
          from: PREVIEW_PAYER,
          to: PREVIEW_WALLET,
          value: '10000',
          validAfter: '1',
          validBefore: '9999999999',
          nonce: `0x${'01'.repeat(32)}`,
        },
      },
    }),
  ).toString('base64url');
}

export function collectProductionWalletMarkers(env: NodeJS.ProcessEnv = process.env): string[] {
  const names: string[] = [];
  if (env.NODE_ENV === 'production') names.push('NODE_ENV');
  if (isProductionWallet(env.WALLET_ADDRESS)) names.push('WALLET_ADDRESS');
  if (env.WALLET_ENS?.trim()) names.push('WALLET_ENS');
  if ((env.NETWORK ?? '').trim() === 'base') names.push('NETWORK');
  if (isProductionOrigin(env.PUBLIC_BASE_URL)) names.push('PUBLIC_BASE_URL');
  if (env.BLOB_STORE_ID?.trim()) names.push('BLOB_STORE_ID');
  if (env.BLOB_READ_WRITE_TOKEN?.trim()) names.push('BLOB_READ_WRITE_TOKEN');
  if (env.CDP_API_KEY_ID?.trim()) names.push('CDP_API_KEY_ID');
  if (env.CDP_API_KEY_SECRET?.trim()) names.push('CDP_API_KEY_SECRET');
  if (isProductionFacilitator(env.FACILITATOR_URL)) names.push('FACILITATOR_URL');
  return names;
}

export function assertPreviewAllowed(input: {
  bindHost?: string;
  publicOrigin?: string;
  walletAddress?: string;
  allowedOrigins?: readonly string[];
  production?: boolean;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = input.env ?? {};
  if (input.production || env.NODE_ENV === 'production') {
    throw new Error('Paid PSD preview refuses production.');
  }
  const host = (input.bindHost ?? '127.0.0.1').trim();
  if (host !== '127.0.0.1') {
    throw new Error('Paid PSD preview binds loopback only.');
  }
  if (input.publicOrigin && !isLoopbackOrigin(input.publicOrigin)) {
    throw new Error('Paid PSD preview refuses production origins.');
  }
  for (const origin of input.allowedOrigins ?? []) {
    if (!isLoopbackOrigin(origin)) {
      throw new Error('Paid PSD preview refuses production origins.');
    }
  }
  if (input.walletAddress && isProductionWallet(input.walletAddress)) {
    throw new Error('Paid PSD preview refuses production wallet configuration.');
  }
  const markers = collectProductionWalletMarkers(env);
  if (markers.length > 0) {
    throw new Error(
      `Paid PSD preview refuses production wallet configuration (${markers.join(', ')}).`,
    );
  }
}

export function createPreviewHarness(
  options: {
    fault?: PreviewFault;
    env?: NodeJS.ProcessEnv;
    clock?: () => number;
    /** Serve entitlement storage and signed downloads from this real local store instead of the mocked Blob SDK. */
    localBlob?: LocalBlobStore;
  } = {},
): PreviewHarness {
  const fault = options.fault ?? 'none';
  if (options.localBlob && fault !== 'none') {
    throw new Error('Local blob preview does not combine with injected faults.');
  }
  assertPreviewAllowed({
    bindHost: '127.0.0.1',
    publicOrigin: 'http://127.0.0.1',
    walletAddress: PREVIEW_WALLET,
    allowedOrigins: ['http://127.0.0.1'],
    production: false,
    env: options.env ?? {},
  });

  const fixture = generatedPreviewFixture();
  const product = previewProduct(fixture);
  const events: ObservabilityEvent[] = [];
  const logs: string[] = [];
  const logger: AppLogger = {
    info(message) {
      logs.push(message);
    },
    warn(message) {
      logs.push(message);
    },
    error(message) {
      logs.push(message);
    },
  };
  const observe = createObservabilitySink(line => {
    events.push(createObservabilityEvent(JSON.parse(line) as ObservabilityEvent));
  });
  const now = options.clock ?? (() => Date.parse('2026-08-29T12:00:00.000Z'));
  const keyring: EntitlementKeyring = {
    current: { id: 'preview', secret: 'p'.repeat(64) },
    previous: [],
  };
  const indexKey = 'h'.repeat(64);
  const sdk = options.localBlob ?? previewBlobSdk(fixture, fault);
  const store = new BlobEntitlementStore(indexKey, sdk);
  const delivery = new AssetDeliveryService({
    findEntry: id => (id === PREVIEW_PRODUCT_ID ? product : null),
    entitlements: new EntitlementService(keyring, store, now),
    createSignedDownload: options.localBlob
      ? pathname => createSignedBlobDownload(pathname, options.localBlob, now())
      : async () => {
          if (fault === 'signing_failure' || fault === 'blob_failure') {
            throw new Error(fault === 'blob_failure' ? 'Blob unavailable.' : 'Signing unavailable.');
          }
          const expiresAt =
            fault === 'url_expiry'
              ? '2026-08-29T11:59:00.000Z'
              : '2026-08-29T12:01:00.000Z';
          return { url: 'https://blob.example/preview-signed', expiresAt };
        },
  });

  const config: AppConfig = {
    walletAddress: PREVIEW_WALLET,
    network: 'base-sepolia',
    facilitatorUrl: 'http://127.0.0.1/preview-facilitator',
    adminApiKey: 'preview-admin',
    allowedOrigins: ['http://127.0.0.1'],
    catalogPaywallEnabled: false,
    production: false,
    publicDir: fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-preview-public-')),
    publicOrigin: 'http://127.0.0.1',
    entitlementStoreIndexKey: indexKey,
  };
  const dependencies: AppDependencies = {
    catalog: {
      findEntry: id => (id === PREVIEW_PRODUCT_ID ? product : null),
      readCatalog: () =>
        ({
          owner: { name: 'Preview', wallet: PREVIEW_WALLET },
          design_systems: [product],
        }) as never,
      appendEntry: async () => undefined,
      resolveResource: async () => {
        throw new Error('preview harness does not resolve live sources');
      },
    },
    assetDelivery: delivery,
    x402: {
      paywall: () => (_req, _res, next) => next(),
      purchasePaywall: () => (req, res, next) => {
        const signature = req.get('payment-signature') ?? req.get('x-payment');
        if (!signature) {
          const challenge = previewPaymentRequired(req);
          res.setHeader('PAYMENT-REQUIRED', encodePaymentRequiredHeader(challenge as never));
          res.setHeader('Cache-Control', 'private, no-store');
          res.status(402).json(challenge);
          return;
        }
        res.locals[X402_SETTLEMENT_LOCAL] = {
          network: PREVIEW_FAKE_SETTLEMENT.network,
          payer: PREVIEW_FAKE_SETTLEMENT.payer,
          transaction: PREVIEW_FAKE_SETTLEMENT.transaction,
        };
        res.setHeader('X-Settlement-Kind', FAKE_SETTLEMENT_LABEL);
        next();
      },
      catalogPaywall: () => (_req, _res, next) => next(),
    },
    facilitatorDiagnostic: async () => {
      throw new Error('preview harness does not call a live facilitator');
    },
    blob: sdk,
    localBlobDownloads: options.localBlob
      ? createLocalBlobDownloadHandler(options.localBlob)
      : undefined,
    entitlementStore: store,
    rateLimiter: new InMemoryFixedWindowRateLimiter(),
    clock: now,
    logger,
    storageStatus: () => ({
      local: true,
      url: false,
      google_drive: { enabled: false, api_key: false },
      dropbox: { enabled: false, oauth: false },
    }),
    observe,
  };

  return {
    app: createApp(config, dependencies),
    config,
    events,
    observe,
    product,
    fixture,
    settlement: PREVIEW_FAKE_SETTLEMENT,
    paymentSignature: previewPaymentSignature(),
    logger,
  };
}

export async function listenPreview(app: Express): Promise<{
  url: string;
  host: string;
  port: number;
  close: () => Promise<void>;
}> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  if (address.address !== '127.0.0.1') {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
    throw new Error('Paid PSD preview binds loopback only.');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    host: address.address,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      ),
  };
}

export async function runPreviewCatalogToReceipt(
  url: string,
  harness: PreviewHarness,
  workspace: string,
): Promise<{
  catalogStatus: number;
  unpaidStatus: number;
  purchaseStatus: number;
  redeemStatus: number;
  rangeStatus: number;
  savedPath: string;
  receiptPath?: string;
  sha256: string;
  bytes: number;
  settlementKind: string;
}> {
  const catalog = await fetch(`${url}/.well-known/design-catalog.json`);
  const listing = (await catalog.json()) as CatalogResponse;
  const entry = listing.design_systems.find(item => item.id === PREVIEW_PRODUCT_ID);
  if (
    !entry ||
    !entry.access_url?.endsWith(`/assets/${PREVIEW_PRODUCT_ID}/purchase`) ||
    'source' in entry ||
    'blob_path' in entry
  ) {
    throw new Error('Preview catalog missing a secret-free binary purchase entry.');
  }

  const unpaid = await fetch(`${url}/assets/${PREVIEW_PRODUCT_ID}/purchase`);
  if (unpaid.status !== 402 || !unpaid.headers.get('payment-required')) {
    throw new Error(`Preview unpaid purchase expected 402, got ${unpaid.status}.`);
  }

  const purchased = await fetch(`${url}/assets/${PREVIEW_PRODUCT_ID}/purchase`, {
    headers: { 'payment-signature': harness.paymentSignature },
  });
  const purchaseBody = (await purchased.json()) as {
    entitlement?: string;
    receipt_id?: string;
    filename?: string;
    mime_type?: string;
    content_sha256?: string;
    content_bytes?: number;
    source_provider?: string;
  };
  if (purchased.status !== 200 || !purchaseBody.entitlement) {
    throw new Error(`Preview paid purchase expected entitlement JSON, got ${purchased.status}.`);
  }

  const redeemed = await fetch(`${url}/assets/${PREVIEW_PRODUCT_ID}/redeem`, {
    headers: { authorization: `Bearer ${purchaseBody.entitlement}` },
  });
  if (redeemed.status !== 200) {
    throw new Error(`Preview redeem expected 200, got ${redeemed.status}.`);
  }
  await redeemed.json();

  const reservation = await preflightDownloadDestination({
    out: workspace,
    filename: purchaseBody.filename ?? 'tiny-rgb-1x1.psd',
    contentBytes: harness.fixture.bytesCount,
    collisionPolicy: 'number',
    homeDirectory: workspace,
    stateDirectory: workspace,
    isTTY: false,
  });
  const blob = await listenPreviewBlob(harness.fixture.bytes);
  try {
    await fs.promises.writeFile(reservation.tempPath, harness.fixture.bytes.subarray(0, 8), {
      mode: 0o600,
    });
    const resume: DownloadResumeState = {
      version: 1,
      product_id: PREVIEW_PRODUCT_ID,
      temp_path: reservation.tempPath,
      final_path: reservation.finalPath,
      bytes_written: 8,
      content_sha256: harness.fixture.sha256,
      content_bytes: harness.fixture.bytesCount,
      download_url: blob.url,
      download_expires_at: '2026-08-29T12:01:00.000Z',
      entitlement: purchaseBody.entitlement,
      etag: '"preview-fixture"',
    };
    const streamed = await streamResumableDownload(resume);
    const committed = await commitDownloadWithReceipt(
      reservation.tempPath,
      reservation.finalPath,
      createDownloadReceipt({
        receipt_id: purchaseBody.receipt_id,
        product_id: PREVIEW_PRODUCT_ID,
        saved_path: reservation.finalPath,
        filename: purchaseBody.filename ?? 'tiny-rgb-1x1.psd',
        mime_type: purchaseBody.mime_type ?? 'image/vnd.adobe.photoshop',
        bytes: streamed.bytes,
        sha256: streamed.sha256,
        source_provider: purchaseBody.source_provider ?? 'local',
        delivered_via: 'entitlement',
      }),
    );
    return {
      catalogStatus: catalog.status,
      unpaidStatus: unpaid.status,
      purchaseStatus: purchased.status,
      redeemStatus: redeemed.status,
      rangeStatus: blob.lastRangeStatus,
      savedPath: reservation.finalPath,
      receiptPath: committed.receiptPath,
      sha256: streamed.sha256,
      bytes: streamed.bytes,
      settlementKind: purchased.headers.get('x-settlement-kind') ?? '',
    };
  } finally {
    await blob.close();
  }
}

export async function runPreviewPurchaseRedeem(
  url: string,
  harness: PreviewHarness,
): Promise<{
  purchaseStatus: number;
  redeemStatus: number;
  receiptId?: string;
  settlementKind: string;
}> {
  const purchased = await fetch(`${url}/assets/${PREVIEW_PRODUCT_ID}/purchase`, {
    headers: { 'payment-signature': harness.paymentSignature },
  });
  const purchaseBody = (await purchased.json()) as {
    entitlement?: string;
    receipt_id?: string;
  };
  const redeemed = purchaseBody.entitlement
    ? await fetch(`${url}/assets/${PREVIEW_PRODUCT_ID}/redeem`, {
        headers: { authorization: `Bearer ${purchaseBody.entitlement}` },
      })
    : { status: purchased.status };
  return {
    purchaseStatus: purchased.status,
    redeemStatus: redeemed.status,
    receiptId: purchaseBody.receipt_id,
    settlementKind: purchased.headers.get('x-settlement-kind') ?? '',
  };
}

export async function runInjectedFailure(
  fault: Exclude<PreviewFault, 'none'>,
  workspace: string,
): Promise<{
  fault: PreviewFault;
  observed: string;
  status?: number;
  settlementKind?: string;
}> {
  if (fault === 'disk_full') {
    await assert.rejectsDiskFull(workspace);
    return { fault, observed: 'disk_full' };
  }
  if (fault === 'receipt_write_failure') {
    await assert.rejectsReceiptWrite(workspace);
    return { fault, observed: 'receipt_write_failure' };
  }
  if (fault === 'disconnect') {
    await assert.rejectsDisconnect();
    return { fault, observed: 'disconnect' };
  }

  const harness = createPreviewHarness({ fault, env: {} });
  const listener = await listenPreview(harness.app);
  try {
    const purchased = await fetch(`${listener.url}/assets/${PREVIEW_PRODUCT_ID}/purchase`, {
      headers: { 'payment-signature': harness.paymentSignature },
    });
    const purchaseBody = (await purchased.json()) as {
      entitlement?: string;
      receipt_id?: string;
    };
    if (purchased.status !== 200 || !purchaseBody.entitlement) {
      throw new Error(`${fault} drill lost the fake-settlement purchase (${purchased.status}).`);
    }
    const redeemed = await fetch(`${listener.url}/assets/${PREVIEW_PRODUCT_ID}/redeem`, {
      headers: { authorization: `Bearer ${purchaseBody.entitlement}` },
    });
    if (fault === 'url_expiry') {
      const body = (await redeemed.json()) as { expires_at?: string };
      if (
        redeemed.status !== 200 ||
        !body.expires_at ||
        Date.parse(body.expires_at) >= Date.parse('2026-08-29T12:00:00.000Z')
      ) {
        throw new Error('URL expiry drill did not observe an expired signed URL.');
      }
      return {
        fault,
        observed: 'url_expiry',
        status: redeemed.status,
        settlementKind: purchased.headers.get('x-settlement-kind') ?? '',
      };
    }
    if (redeemed.status !== 503) {
      throw new Error(`${fault} drill expected redeem 503, got ${redeemed.status}.`);
    }
    return {
      fault,
      observed: fault,
      status: redeemed.status,
      settlementKind: purchased.headers.get('x-settlement-kind') ?? '',
    };
  } finally {
    await listener.close();
  }
}

const assert = {
  async rejectsDiskFull(workspace: string): Promise<void> {
    try {
      await preflightDownloadDestination({
        out: workspace,
        filename: 'tiny-rgb-1x1.psd',
        contentBytes: 43,
        collisionPolicy: 'number',
        homeDirectory: workspace,
        stateDirectory: workspace,
        isTTY: false,
        statfs: async () => ({ bavail: 0, bsize: 4096, blocks: 1 }),
      });
      throw new Error('disk_full drill did not fail.');
    } catch (error) {
      if (!(error instanceof DestinationPreflightError) || error.code !== 'insufficient_space') {
        throw error;
      }
    }
  },
  async rejectsReceiptWrite(workspace: string): Promise<void> {
    const { writeFile, mkdir, rm, chmod } = await import('node:fs/promises');
    const path = await import('node:path');
    const finalPath = path.join(workspace, 'tiny-rgb-1x1.psd');
    const tempPath = `${finalPath}.part`;
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await writeFile(tempPath, buildTinyRgbPsd(), { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await mkdir(`${finalPath}.receipt.json`, { recursive: true });
    const receipt = createDownloadReceipt({
      receipt_id: `rcpt_${'r'.repeat(43)}`,
      product_id: PREVIEW_PRODUCT_ID,
      saved_path: finalPath,
      filename: 'tiny-rgb-1x1.psd',
      mime_type: 'image/vnd.adobe.photoshop',
      bytes: 43,
      sha256: generatedPreviewFixture().sha256,
      source_provider: 'local',
    });
    const result = await commitDownloadWithReceipt(tempPath, finalPath, receipt);
    if (!result.receiptError) {
      throw new Error('receipt_write_failure drill did not fail.');
    }
    await rm(`${finalPath}.receipt.json`, { recursive: true, force: true });
  },
  async rejectsDisconnect(): Promise<void> {
    const stream = new Readable({
      read() {
        this.push(Buffer.from('8B'));
        this.destroy(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
      },
    });
    await new Promise<void>((resolve, reject) => {
      stream.on('error', error => {
        if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') resolve();
        else reject(error);
      });
      stream.on('end', () => reject(new Error('disconnect drill completed the stream')));
      stream.resume();
    });
  },
};

function previewPaymentRequired(req: Request): PaymentRequired {
  const host = req.get('host') ?? '127.0.0.1';
  const pathName = (req.originalUrl ?? req.url ?? `/assets/${PREVIEW_PRODUCT_ID}/purchase`).split(
    '?',
  )[0];
  return {
    x402Version: 2,
    error: 'payment required',
    resource: {
      url: `http://${host}${pathName}`,
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: PREVIEW_NETWORK,
        amount: '10000',
        payTo: PREVIEW_WALLET,
        maxTimeoutSeconds: 300,
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        extra: { assetTransferMethod: 'eip3009', name: 'USDC', version: '2' },
      },
    ],
    extensions: {
      ...declareDiscoveryExtension({
        input: { id: PREVIEW_PRODUCT_ID },
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      }),
    },
  };
}

async function listenPreviewBlob(bytes: Buffer): Promise<{
  url: string;
  lastRangeStatus: number;
  close: () => Promise<void>;
}> {
  const etag = '"preview-fixture"';
  const state = { lastRangeStatus: 0 };
  const server = http.createServer((req, res) => {
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', etag);
    res.setHeader('Content-Type', 'image/vnd.adobe.photoshop');
    res.setHeader('Cache-Control', 'private, no-store');
    const range = parsePreviewRange(req.headers.range, bytes.byteLength);
    if (range === 'unsatisfiable') {
      state.lastRangeStatus = 416;
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${bytes.byteLength}`);
      res.end();
      return;
    }
    if (range) {
      const slice = bytes.subarray(range.start, range.end + 1);
      state.lastRangeStatus = 206;
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${bytes.byteLength}`);
      res.setHeader('Content-Length', String(slice.byteLength));
      res.end(slice);
      return;
    }
    state.lastRangeStatus = 200;
    res.statusCode = 200;
    res.setHeader('Content-Length', String(bytes.byteLength));
    res.end(bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  if (address.address !== '127.0.0.1') {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
    throw new Error('Paid PSD preview blob binds loopback only.');
  }
  return {
    url: `http://127.0.0.1:${address.port}/preview-blob`,
    get lastRangeStatus() {
      return state.lastRangeStatus;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      ),
  };
}

function parsePreviewRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | undefined {
  if (!header) return undefined;
  const match = header.match(/^bytes=(\d+)-(\d*)$/i);
  if (!match) return 'unsatisfiable';
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    return 'unsatisfiable';
  }
  return { start, end: Math.min(end, size - 1) };
}

function previewProduct(fixture: { sha256: string; bytesCount: number }): DesignSystemEntry {
  return {
    id: PREVIEW_PRODUCT_ID,
    file: 'tiny-rgb-1x1.psd',
    resource_type: 'binary_asset',
    mime_type: 'image/vnd.adobe.photoshop',
    name: 'Generated tiny RGB preview',
    description: 'Loopback-only generated PSD. Fake settlement. No spend.',
    price_usd: '0.01',
    tags: ['preview', FAKE_SETTLEMENT_LABEL],
    content_sha256: fixture.sha256,
    content_bytes: fixture.bytesCount,
    integrity_status: 'verified',
    delivery_mode: 'entitlement',
    blob_path: `assets/sha256/${fixture.sha256}/tiny-rgb-1x1.psd`,
    source_provider: 'local',
    published_at: '2026-08-29T00:00:00.000Z',
    active: true,
  };
}

function previewBlobSdk(fixture: { bytes: Buffer }, fault: PreviewFault): BlobSdkAdapter {
  const assetPath = `assets/sha256/${sha256Hex(fixture.bytes)}/tiny-rgb-1x1.psd`;
  const objects = new Map<string, { bytes: Buffer; contentType: string }>([
    [assetPath, { bytes: fixture.bytes, contentType: 'image/vnd.adobe.photoshop' }],
  ]);
  return {
    async put(pathname, body, options) {
      if (objects.has(pathname)) {
        throw Object.assign(new Error('already exists'), { status: 409 });
      }
      objects.set(pathname, {
        bytes: Buffer.from(body as Uint8Array),
        contentType: options.contentType,
      });
      return { pathname, url: `https://blob.example/${pathname}` };
    },
    async head(pathname) {
      const found = objects.get(pathname);
      if (!found) throw Object.assign(new Error('not found'), { status: 404 });
      return {
        pathname,
        size: found.bytes.byteLength,
        contentType: found.contentType,
        etag: 'preview',
      };
    },
    async read(pathname) {
      const found = objects.get(pathname);
      if (!found) throw Object.assign(new Error('not found'), { status: 404 });
      if (fault === 'disconnect' && pathname === assetPath) {
        return {
          body: new Readable({
            read() {
              this.push(found.bytes.subarray(0, 8));
              this.destroy(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
            },
          }),
          pathname,
          size: found.bytes.byteLength,
          contentType: found.contentType,
          etag: 'preview',
        };
      }
      return {
        body: Readable.from([found.bytes]),
        pathname,
        size: found.bytes.byteLength,
        contentType: found.contentType,
        etag: 'preview',
      };
    },
    async issueSignedToken() {
      if (fault === 'blob_failure' || fault === 'signing_failure') {
        throw new Error('Blob signing unavailable.');
      }
      return {
        delegationToken: 'preview-deleg',
        clientSigningToken: 'preview-client',
        validUntil: Date.parse('2026-08-29T12:01:00.000Z'),
      };
    },
    async presignUrl() {
      if (fault === 'blob_failure') throw new Error('Blob unavailable.');
      return { presignedUrl: 'https://blob.example/preview-signed' };
    },
  };
}

function isProductionWallet(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === PRODUCTION_WALLET;
}

function isProductionFacilitator(value: string | undefined): boolean {
  const trimmed = (value ?? '').trim().toLowerCase();
  return trimmed.includes('api.cdp.coinbase.com');
}

function isProductionOrigin(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return PRODUCTION_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

function isLoopbackOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

export function previewFixtureFingerprint(): string {
  return crypto.createHash('sha256').update(buildTinyRgbPsd()).digest('hex');
}
