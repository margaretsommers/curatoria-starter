/**
 * server.ts — composition root for the Curatoria service.
 *
 * createApp is a pure factory. This module loads dotenv, validates env, resolves
 * the payout wallet, constructs Blob adapters / rate limiters, and caches the
 * Vercel handler. Facilitator preflight is a diagnostic, not an import
 * prerequisite. The listener starts only when this file is the process entrypoint.
 */

import dotenv from 'dotenv';
import type express from 'express';
import { ENV_PATH, PUBLIC_DIR } from './paths';

dotenv.config({ path: ENV_PATH });

import {
  appendEntry,
  findEntry,
  readCatalog,
  setActiveCatalogSource,
} from './catalog';
import { createBlobCatalogRepository, type BlobCatalogRepository } from './catalog-blob-repository';
import { resolveResource, storageStatus } from './sources';
import {
  checkFacilitatorPreflight,
  x402CatalogPaywall,
  x402Paywall,
  x402PurchasePaywall,
} from './x402';
import { AssetDeliveryService } from './asset-delivery';
import { EntitlementService, keyringFromEnv, storeIndexKeyFromEnv } from './entitlements';
import { createSignedBlobDownload, putMutableJsonBlob, type BlobSdkAdapter } from './blob-storage';
import { composeBlobAdapter } from './blob-mode';
import { createLocalBlobDownloadHandler } from './local-blob-storage';
import { BlobEntitlementStore } from './blob-entitlement-store';
import { BlobSettlementJournal } from './settlement-journal';
import { createApp, type AppConfig, type AppDependencies, type AppLogger } from './app';
import { createObservabilitySink } from './observability';
import { InMemoryFixedWindowRateLimiter } from './rate-limit';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const logger: AppLogger = {
  info(message) {
    console.log(message);
  },
  warn(message) {
    console.warn(message);
  },
  error(message) {
    console.error(message);
  },
};

function isValidAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production';
}

async function resolveWalletAddress(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const fallbackAddress = (env.WALLET_ADDRESS ?? '').trim();
  const ensName = (env.WALLET_ENS ?? '').trim();

  if (fallbackAddress && isValidAddress(fallbackAddress)) {
    return fallbackAddress;
  }

  if (ensName) {
    try {
      // Load ENS helpers lazily so TypeScript doesn't require browser DOM typings from viem's d.ts graph.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createPublicClient, http } = require('viem');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { mainnet } = require('viem/chains');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getEnsAddress, normalize } = require('viem/ens');

      const ensClient = createPublicClient({
        chain: mainnet,
        transport: http(),
      });
      const normalizedName = normalize(ensName);
      const resolvedAddress = await getEnsAddress(ensClient, { name: normalizedName });

      if (resolvedAddress && isValidAddress(resolvedAddress)) {
        logger.info(`Resolved WALLET_ENS ${ensName} -> ${resolvedAddress}`);
        return resolvedAddress;
      }

      logger.warn(
        `WALLET_ENS "${ensName}" did not resolve to an address. Falling back to WALLET_ADDRESS.`,
      );
    } catch (error) {
      logger.warn(
        `Failed to resolve WALLET_ENS "${ensName}" (${String(error)}). Falling back to WALLET_ADDRESS.`,
      );
    }
  }

  throw new Error(
    'No valid payout wallet found. Set WALLET_ENS to a resolvable ENS name and/or WALLET_ADDRESS to a valid 0x address.',
  );
}

function composeBinaryDelivery(
  env: NodeJS.ProcessEnv,
  production: boolean,
  clock: () => number,
  blob: BlobSdkAdapter | undefined,
): {
  assetDelivery?: AssetDeliveryService;
  entitlementStore?: BlobEntitlementStore;
  settlementJournal?: BlobSettlementJournal;
  indexKey?: string;
} {
  try {
    const keyring = keyringFromEnv(env);
    const indexKey = storeIndexKeyFromEnv(env);
    if (!blob) {
      throw new Error('Private Blob store is required for paid binary asset delivery.');
    }
    const entitlementStore = new BlobEntitlementStore(indexKey, blob);
    const settlementJournal = new BlobSettlementJournal(indexKey, blob);
    return {
      indexKey,
      entitlementStore,
      settlementJournal,
      assetDelivery: new AssetDeliveryService({
        findEntry,
        entitlements: new EntitlementService(keyring, entitlementStore, clock),
        createSignedDownload: pathname => createSignedBlobDownload(pathname, blob, clock()),
      }),
    };
  } catch (error) {
    if (production) throw error;
    logger.warn(
      `Binary asset delivery is disabled until entitlement signing is configured: ${String(error)}`,
    );
    return {};
  }
}

async function composeApp(env: NodeJS.ProcessEnv = process.env): Promise<express.Express> {
  const production = isProductionEnv(env);
  const adminApiKey = env.ADMIN_API_KEY?.trim() ?? '';
  if (!adminApiKey) {
    throw new Error('ADMIN_API_KEY env var is required.');
  }

  const resolvedWalletAddress = await resolveWalletAddress(env);
  const publicOrigin = env.PUBLIC_BASE_URL?.replace(/\/$/, '').trim() || undefined;
  const clock = () => Date.now();
  const {
    mode: blobMode,
    adapter: blob,
    localStore: localBlobStore,
  } = composeBlobAdapter(env, publicOrigin ?? `http://localhost:${PORT}`, clock);
  if (blobMode === 'local') {
    logger.info(
      'Blob mode: local filesystem (.local-blob). No Vercel account is required; set BLOB_READ_WRITE_TOKEN or BLOB_MODE=vercel for private Vercel Blob.',
    );
  }

  if (production) {
    if (!publicOrigin) {
      throw new Error('PUBLIC_BASE_URL is required in production for entitlement issuer/origin.');
    }
    if (!blob) {
      throw new Error('BLOB_STORE_ID or BLOB_READ_WRITE_TOKEN is required in production.');
    }
    storeIndexKeyFromEnv(env);
    keyringFromEnv(env);
  }

  const binary = composeBinaryDelivery(env, production, clock, blob);

  // design-systems/.registry.json (read via the filesystem in ./catalog) is
  // confirmed absent from Vercel's deployed function bundle for this project
  // -- every request crashed at module load before this fix. In production,
  // the whole catalog lives in Blob instead (see catalog-blob-repository.ts);
  // local/dev/test keep the existing, unchanged filesystem catalog.
  let blobCatalog: BlobCatalogRepository | undefined;
  if (production) {
    if (!blob) throw new Error('BLOB_STORE_ID or BLOB_READ_WRITE_TOKEN is required in production.');
    blobCatalog = createBlobCatalogRepository(blob, putMutableJsonBlob);
    await blobCatalog.initialize();
    // x402.ts, x402-discovery.ts, discovery.ts, openapi-spec.ts, and sitemap.ts
    // all call readCatalog/findEntry/listActive imported directly from
    // ./catalog rather than through the dependencies.catalog DI below --
    // install the Blob-backed repository as catalog.ts's own active source so
    // every one of those call sites gets Blob data too, without threading DI
    // through each of them individually. See catalog.ts's own comment above
    // readCatalog() for the full rationale.
    setActiveCatalogSource(blobCatalog);
  }

  const config: AppConfig = {
    walletAddress: resolvedWalletAddress,
    network: env.NETWORK ?? 'base-sepolia',
    facilitatorUrl: env.FACILITATOR_URL ?? 'https://x402.org/facilitator',
    adminApiKey,
    allowedOrigins: (env.BROWSER_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
    catalogPaywallEnabled: env.CATALOG_PAYWALL_ENABLED === '1',
    production,
    publicDir: PUBLIC_DIR,
    publicOrigin,
    entitlementStoreIndexKey: binary.indexKey,
  };
  const dependencies: AppDependencies = {
    catalog: blobCatalog ?? {
      findEntry,
      readCatalog,
      appendEntry,
      resolveResource,
    },
    assetDelivery: binary.assetDelivery,
    x402: {
      paywall: x402Paywall,
      purchasePaywall: config =>
        x402PurchasePaywall({
          ...config,
          settlementJournal: binary.settlementJournal,
          entitlementStore: binary.entitlementStore,
        }),
      catalogPaywall: x402CatalogPaywall,
    },
    facilitatorDiagnostic: checkFacilitatorPreflight,
    blob,
    localBlobDownloads: localBlobStore
      ? createLocalBlobDownloadHandler(localBlobStore)
      : undefined,
    entitlementStore: binary.entitlementStore,
    rateLimiter: new InMemoryFixedWindowRateLimiter(),
    clock,
    logger,
    storageStatus,
    observe: createObservabilitySink(line => logger.info(line)),
  };

  const app = createApp(config, dependencies);
  void checkFacilitatorPreflight(config.facilitatorUrl, config.network).then(preflight => {
    if (!preflight.ok) {
      logger.error(
        `WARNING: x402 facilitator preflight failed (${preflight.error ?? 'unknown error'}). Paid routes will return 503 until facilitator config is fixed.`,
      );
    }
  });
  return app;
}

let appPromise: Promise<express.Express> | undefined;

export async function getApp(): Promise<express.Express> {
  if (!appPromise) {
    appPromise = composeApp();
  }
  return appPromise;
}

export default async function vercelHandler(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const app = await getApp();
  app(req, res);
}

async function startLocalServer(): Promise<void> {
  const app = await getApp();
  const network = process.env.NETWORK ?? 'base-sepolia';

  app.listen(PORT, () => {
    const catalog = readCatalog();
    const active = catalog.design_systems.filter(e => e.active);

    console.log('');
    console.log('  Curatoria Service');
    console.log('  ─────────────────────────────────────────────');
    console.log(`  URL:      http://localhost:${PORT}`);
    console.log(`  Network:  ${network}`);
    console.log(`  Designs:  ${active.length} published`);
    console.log('');
    const catalogMode =
      process.env.CATALOG_PAYWALL_ENABLED === '1'
        ? 'Track B (teaser + paid /catalog)'
        : 'Track A (free full catalog)';
    console.log(`  Catalog:   ${catalogMode}`);
    console.log(`  Discovery: http://localhost:${PORT}/.well-known/design-catalog.json`);
    console.log('');
  });
}

if (require.main === module) {
  startLocalServer().catch(error => {
    console.error(`ERROR: ${String(error)}`);
    process.exit(1);
  });
}
