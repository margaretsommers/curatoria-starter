/**
 * Pure application factory. createApp performs no environment reads, ENS lookup,
 * facilitator network call, listener startup, or process exit.
 */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import type { RequestHandler } from 'express';

import {
  createFullCatalogDiscoveryHandler,
  createFullCatalogHandler,
  createTeaserDiscoveryHandler,
} from './discovery';
import { handleSitemap } from './sitemap';
import { handleApiCatalog } from './api-catalog';
import { handleOpenApiSpec } from './openapi-spec';
import {
  handleAgentClaimDiscovery,
  handleAgentRegisterDiscovery,
  handleAgentRevokeDiscovery,
  handleAuthMd,
  handleAuthMethods,
  handleAuthToken,
  handleJwks,
  handleOAuthAuthorizationServer,
  handleOAuthProtectedResource,
  respondAdminUnauthorized,
} from './auth-discovery';
import { handleHomepage } from './link-headers';
import { negotiateMarkdownStatic } from './markdown-negotiation';
import { handleMcpServerCard } from './mcp-server-card';
import { handleAgentSkillFile, handleAgentSkillsIndex } from './agent-skills-index';
import { createX402DiscoveryHandler } from './x402-discovery';
import { setPaidResourceHeaders } from './delivery';
import { X402_SETTLEMENT_LOCAL, type FacilitatorPreflightResult } from './x402';
import type { AssetDeliveryService } from './asset-delivery';
import type { BlobSdkAdapter } from './blob-storage';
import type { EntitlementStore } from './entitlements';
import {
  clientIp,
  createRateLimitMiddleware,
  entitlementFingerprint,
  purchaseLimitKey,
  RATE_LIMIT,
  recoverLimitKey,
  redeemEntitlementLimitKey,
  redeemIpLimitKey,
  type RateLimiter,
} from './rate-limit';
import type { DesignCatalog, DesignSystemEntry, PublishRequest } from './types';
import type { ResolvedResource } from './sources';
import {
  emitObserved,
  outcomeFromStatus,
  resolveCorrelationId,
  type DeliveryProvider,
  type ObservabilitySink,
} from './observability';

export type AppLogger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export type CatalogRepository = {
  findEntry(id: string): DesignSystemEntry | null;
  readCatalog(): DesignCatalog;
  appendEntry(entry: DesignSystemEntry): Promise<void>;
  resolveResource(entry: DesignSystemEntry): Promise<ResolvedResource>;
};

export type X402MiddlewareFactories = {
  paywall(config: {
    walletAddress: string;
    network: string;
    facilitatorUrl: string;
    expectedResourceType?: DesignSystemEntry['resource_type'];
  }): RequestHandler;
  purchasePaywall(config: {
    walletAddress: string;
    network: string;
    facilitatorUrl: string;
    expectedResourceType?: DesignSystemEntry['resource_type'];
  }): RequestHandler;
  catalogPaywall(config: {
    walletAddress: string;
    network: string;
    facilitatorUrl: string;
  }): RequestHandler;
};

export type StorageStatusProvider = () => {
  local: boolean;
  url: boolean;
  google_drive: { enabled: boolean; api_key: boolean };
  dropbox: { enabled: boolean; oauth: boolean };
};

export type AppConfig = {
  walletAddress: string;
  network: string;
  facilitatorUrl: string;
  adminApiKey: string;
  allowedOrigins: readonly string[];
  catalogPaywallEnabled: boolean;
  production: boolean;
  publicDir: string;
  publicOrigin?: string;
  entitlementStoreIndexKey?: string;
};

export type AppDependencies = {
  catalog: CatalogRepository;
  assetDelivery?: AssetDeliveryService;
  x402: X402MiddlewareFactories;
  facilitatorDiagnostic: (
    facilitatorUrl: string,
    network: string,
  ) => Promise<FacilitatorPreflightResult>;
  blob?: BlobSdkAdapter;
  localBlobDownloads?: RequestHandler;
  entitlementStore?: EntitlementStore;
  rateLimiter: RateLimiter;
  clock: () => number;
  logger: AppLogger;
  storageStatus: StorageStatusProvider;
  observe?: ObservabilitySink;
};

export function createApp(config: AppConfig, dependencies: AppDependencies): express.Express {
  assertCreateAppContract(config, dependencies);

  const app = express();
  const paywallConfig = {
    walletAddress: config.walletAddress,
    network: config.network,
    facilitatorUrl: config.facilitatorUrl,
  };
  const assetCors = createAssetCors(config.allowedOrigins);
  const purchaseRateLimit = createRateLimitMiddleware(
    dependencies.rateLimiter,
    req => [
      {
        key: purchaseLimitKey(clientIp(req), req.params.id),
        limit: RATE_LIMIT.purchasePerIpProduct,
      },
    ],
    dependencies.clock,
  );
  const recoverRateLimit = createRateLimitMiddleware(
    dependencies.rateLimiter,
    req => [
      {
        key: recoverLimitKey(clientIp(req), req.params.id),
        limit: RATE_LIMIT.recoverPerIpProduct,
      },
    ],
    dependencies.clock,
  );
  const redeemRateLimit = createRateLimitMiddleware(
    dependencies.rateLimiter,
    req => redeemRateKeys(req),
    dependencies.clock,
  );

  app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://esm.sh'],
          connectSrc: [
            "'self'",
            'https://esm.sh',
            'https://ruucm.github.io',
            'https://*.blob.vercel-storage.com',
          ],
          workerSrc: ["'self'", 'blob:'],
          styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
          fontSrc: ["'self'", 'https:', 'data:'],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
          upgradeInsecureRequests: [],
        },
      },
    }),
  );
  const openCors = cors({
    exposedHeaders: [
      'PAYMENT-REQUIRED',
      'PAYMENT-RESPONSE',
      'X-PAYMENT-REQUIRED',
      'X-PAYMENT-RESPONSE',
      'Content-Disposition',
      'Content-Length',
      'Content-Type',
      'X-Design-System-Id',
      'X-Design-System-Name',
      'X-Design-System-Version',
      'X-Storage-Source',
      'X-Content-Sha256',
    ],
  });
  app.use((req, res, next) => {
    if (req.path.startsWith('/assets/')) {
      next();
      return;
    }
    openCors(req, res, next);
  });
  app.use(express.json());
  app.get('/', handleHomepage);
  app.get('/index.html', handleHomepage);
  app.get('/auth.md', handleAuthMd);
  app.get('/sitemap.xml', handleSitemap);
  app.get('/.well-known/api-catalog', handleApiCatalog);
  app.get('/.well-known/openapi.json', handleOpenApiSpec);
  app.get('/.well-known/oauth-authorization-server', handleOAuthAuthorizationServer);
  app.get('/.well-known/oauth-protected-resource', handleOAuthProtectedResource);
  app.get('/.well-known/auth', handleAuthMethods);
  app.post('/.well-known/auth/token', handleAuthToken);
  app.get('/.well-known/jwks.json', handleJwks);
  app.get('/.well-known/agent/register', handleAgentRegisterDiscovery);
  app.get('/.well-known/agent/claim', handleAgentClaimDiscovery);
  app.get('/.well-known/agent/revoke', handleAgentRevokeDiscovery);
  app.get('/.well-known/mcp/server-card.json', handleMcpServerCard);
  app.get('/.well-known/agent-skills/index.json', handleAgentSkillsIndex);
  app.get('/.well-known/agent-skills/:name/SKILL.md', handleAgentSkillFile);
  app.get('/.well-known/x402', createX402DiscoveryHandler(paywallConfig));
  app.get('/.well-known/x402.json', createX402DiscoveryHandler(paywallConfig));
  app.use(negotiateMarkdownStatic);
  app.use(express.static(config.publicDir));

  const discoverFull = createFullCatalogDiscoveryHandler(() =>
    dependencies.catalog.readCatalog(),
  );
  const discoverTeaser = createTeaserDiscoveryHandler(() => dependencies.catalog.readCatalog());
  const paidCatalog = createFullCatalogHandler(() => dependencies.catalog.readCatalog());
  if (config.catalogPaywallEnabled) {
    app.get('/.well-known/design-catalog.json', discoverTeaser);
    app.get('/design-systems', discoverTeaser);
    app.get('/catalog', dependencies.x402.catalogPaywall(paywallConfig), paidCatalog);
  } else {
    app.get('/.well-known/design-catalog.json', discoverFull);
    app.get('/design-systems', discoverFull);
    app.get('/catalog', discoverFull);
  }

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      network: config.network,
      wallet: config.walletAddress,
      storage: dependencies.storageStatus(),
    });
  });

  app.options('/assets/:id/purchase', assetCors);
  app.options('/assets/:id/recover', assetCors);
  app.options('/assets/:id/redeem', assetCors);
  app.get(
    '/assets/:id/purchase',
    assetCors,
    purchaseRateLimit,
    requireBinaryDelivery(dependencies.assetDelivery),
    dependencies.x402.purchasePaywall({
      ...paywallConfig,
      expectedResourceType: 'binary_asset',
    }),
    async (req, res) => {
      const started = dependencies.clock();
      const correlationId = beginObservation(req, res);
      try {
        const paymentSignature = req.get('payment-signature') ?? req.get('x-payment') ?? '';
        const settlement = res.locals[X402_SETTLEMENT_LOCAL];
        if (!settlement) throw new Error('Finalized x402 settlement evidence is missing.');
        const result = await dependencies.assetDelivery?.purchase(
          req.params.id,
          paymentSignature,
          settlement,
          entitlementOrigin(req, config),
        );
        observeDelivery(dependencies, {
          correlationId,
          started,
          stage: 'purchase',
          status: 200,
          receiptId: result?.receipt_id,
          bytes: result?.content_bytes,
          provider: result?.source_provider,
        });
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(200).json(result);
      } catch (error) {
        observeDelivery(dependencies, {
          correlationId,
          started,
          stage: 'purchase',
          status: 500,
        });
        dependencies.logger.error(
          `Entitlement issuance failed for "${req.params.id}": ${sanitizeLogError(error)}`,
        );
        res.status(500).json({
          error: 'Payment settled, but entitlement recovery is required',
          recovery: `/assets/${encodeURIComponent(req.params.id)}/recover`,
        });
      }
    },
  );
  app.post('/assets/:id/recover', assetCors, recoverRateLimit, async (req, res) => {
    const started = dependencies.clock();
    const correlationId = beginObservation(req, res);
    if (!dependencies.assetDelivery) {
      observeDelivery(dependencies, {
        correlationId,
        started,
        stage: 'recover',
        status: 503,
      });
      res.status(503).json({ error: 'Binary asset delivery is not configured' });
      return;
    }
    const paymentSignature = req.get('payment-signature') ?? req.get('x-payment') ?? '';
    try {
      const result = await dependencies.assetDelivery.recover(
        req.params.id,
        paymentSignature,
        entitlementOrigin(req, config),
      );
      if (!result) {
        observeDelivery(dependencies, {
          correlationId,
          started,
          stage: 'recover',
          status: 404,
        });
        res.status(404).json({ error: 'No settled entitlement exists for this payment' });
        return;
      }
      observeDelivery(dependencies, {
        correlationId,
        started,
        stage: 'recover',
        status: 200,
        receiptId: result.receipt_id,
        bytes: result.content_bytes,
        provider: result.source_provider,
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(result);
    } catch (error) {
      const mapped = respondRecoverRedeemFailure(
        res,
        error,
        'recover',
        dependencies.logger,
        req.params.id,
      );
      observeDelivery(dependencies, {
        correlationId,
        started,
        stage: 'recover',
        status: mapped,
      });
    }
  });
  app.get('/assets/:id/redeem', assetCors, redeemRateLimit, async (req, res) => {
    const started = dependencies.clock();
    const correlationId = beginObservation(req, res);
    if (!dependencies.assetDelivery) {
      observeDelivery(dependencies, {
        correlationId,
        started,
        stage: 'redeem',
        status: 503,
      });
      res.status(503).json({ error: 'Binary asset delivery is not configured' });
      return;
    }
    const entitlement = bearerToken(req);
    if (!entitlement) {
      observeDelivery(dependencies, {
        correlationId,
        started,
        stage: 'redeem',
        status: 401,
      });
      res.status(401).json({ error: 'Authorization: Bearer <entitlement> is required' });
      return;
    }
    try {
      const result = await dependencies.assetDelivery.redeem(
        req.params.id,
        entitlement,
        entitlementOrigin(req, config),
      );
      observeDelivery(dependencies, {
        correlationId,
        started,
        stage: 'redeem',
        status: 200,
        bytes: result.content_bytes,
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(result);
    } catch (error) {
      const mapped = respondRecoverRedeemFailure(
        res,
        error,
        'redeem',
        dependencies.logger,
        req.params.id,
      );
      observeDelivery(dependencies, {
        correlationId,
        started,
        stage: 'redeem',
        status: mapped,
      });
    }
  });

  if (dependencies.localBlobDownloads) {
    // Local Blob mode only: serves HMAC-signed short-lived downloads from
    // local disk so paid delivery works without a Vercel account.
    app.get('/local-blob/*', dependencies.localBlobDownloads);
    app.head('/local-blob/*', dependencies.localBlobDownloads);
  }

  app.get('/admin/facilitator-preflight', requireAdmin(config.adminApiKey), async (_req, res) => {
    const result = await dependencies.facilitatorDiagnostic(config.facilitatorUrl, config.network);
    res.status(result.ok ? 200 : 502).json(result);
  });

  app.get(
    '/design-systems/:id',
    dependencies.x402.paywall({
      ...paywallConfig,
      expectedResourceType: 'design_md',
    }),
    async (req, res) => {
      const entry = dependencies.catalog.findEntry(req.params.id);
      if (!entry) {
        res.status(404).json({ error: 'Design system not found' });
        return;
      }
      try {
        const resolved = await dependencies.catalog.resolveResource(entry);
        setPaidResourceHeaders(res, resolved, {
          id: entry.id,
          name: entry.name,
          contentSha256: entry.content_sha256,
        }).send(resolved.buffer);
      } catch (error) {
        dependencies.logger.error(
          `Source resolution failed for "${entry.id}": ${sanitizeLogError(error)}`,
        );
        res.status(502).json({ error: 'Could not retrieve product from its storage source' });
      }
    },
  );

  app.get(
    '/packs/:id/download',
    dependencies.x402.paywall({
      ...paywallConfig,
      expectedResourceType: 'bundle_zip',
    }),
    async (req, res) => {
      const entry = dependencies.catalog.findEntry(req.params.id);
      if (!entry) {
        res.status(404).json({ error: 'Bundle not found' });
        return;
      }
      try {
        const resolved = await dependencies.catalog.resolveResource(entry);
        setPaidResourceHeaders(res, resolved, {
          id: entry.id,
          name: entry.name,
          contentSha256: entry.content_sha256,
        }).send(resolved.buffer);
      } catch (error) {
        dependencies.logger.error(
          `Source resolution failed for "${entry.id}": ${sanitizeLogError(error)}`,
        );
        res.status(502).json({ error: 'Could not retrieve bundle from its storage source' });
      }
    },
  );

  app.post('/admin/publish', requireAdmin(config.adminApiKey), async (req, res, next) => {
    const body = req.body as Partial<PublishRequest>;

    if (!body.id || !body.file || !body.name || !body.price_usd) {
      res.status(400).json({
        error: 'Missing required fields',
        required: ['id', 'file', 'name', 'price_usd'],
      });
      return;
    }

    if (!/^[a-z0-9-]+$/.test(body.id)) {
      res.status(400).json({ error: 'id must be lowercase alphanumeric with hyphens only' });
      return;
    }

    const entry: DesignSystemEntry = {
      id: body.id,
      file: body.file,
      resource_type: 'design_md',
      mime_type: 'text/markdown',
      name: body.name,
      description: body.description ?? '',
      price_usd: body.price_usd,
      tags: body.tags ?? [],
      published_at: new Date().toISOString(),
      active: true,
    };

    try {
      await dependencies.catalog.appendEntry(entry);
    } catch (error) {
      next(error);
      return;
    }

    res.json({
      success: true,
      entry,
      access_url: `${req.protocol}://${req.get('host')}/design-systems/${entry.id}`,
    });
  });

  return app;
}

export function assertCreateAppContract(config: AppConfig, dependencies: AppDependencies): void {
  if (!config.production) return;
  if (!config.walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(config.walletAddress)) {
    throw new Error('Production payout wallet is required.');
  }
  if (!config.publicOrigin) {
    throw new Error('Production entitlement issuer/origin (PUBLIC_BASE_URL) is required.');
  }
  if (!config.entitlementStoreIndexKey || Buffer.byteLength(config.entitlementStoreIndexKey) < 32) {
    throw new Error(
      'ENTITLEMENT_STORE_INDEX_KEY is required in production and must contain at least 32 bytes.',
    );
  }
  if (!dependencies.assetDelivery) {
    throw new Error('Production binary asset delivery is required.');
  }
  if (!dependencies.entitlementStore) {
    throw new Error('Production entitlement store is required.');
  }
  if (!dependencies.blob) {
    throw new Error('Production Blob store is required.');
  }
}

function requireAdmin(adminApiKey: string): RequestHandler {
  return (req, res, next) => {
    const key = req.headers['x-admin-key'];
    if (!key || key !== adminApiKey) {
      respondAdminUnauthorized(req, res);
      return;
    }
    next();
  };
}

function requireBinaryDelivery(assetDelivery: AssetDeliveryService | undefined): RequestHandler {
  return (_req, res, next) => {
    if (!assetDelivery) {
      res.status(503).json({ error: 'Binary asset delivery is not configured' });
      return;
    }
    next();
  };
}

function createAssetCors(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  const assetCors = cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (origin === 'null' || !allowed.has(origin)) {
        callback(null, false);
        return;
      }
      callback(null, true);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'PAYMENT-SIGNATURE', 'X-PAYMENT'],
    exposedHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE'],
    maxAge: 600,
  });
  return function applyAssetCors(req, res, next) {
    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: string | number | readonly string[]) => {
      if (name.toLowerCase() === 'vary') {
        const current = Array.isArray(value) ? value.join(', ') : String(value);
        if (!/\borigin\b/i.test(current)) {
          return originalSetHeader(name, `${current}, Origin`);
        }
      }
      return originalSetHeader(name, value);
    }) as typeof res.setHeader;
    res.removeHeader('Access-Control-Allow-Origin');
    res.append('Vary', 'Origin');
    assetCors(req, res, next);
  };
}

function redeemRateKeys(req: express.Request): Array<{ key: string; limit: number }> {
  const keys: Array<{ key: string; limit: number }> = [
    { key: redeemIpLimitKey(clientIp(req)), limit: RATE_LIMIT.redeemPerIp },
  ];
  const token = bearerToken(req);
  if (token) {
    keys.push({
      key: redeemEntitlementLimitKey(entitlementFingerprint(token)),
      limit: RATE_LIMIT.redeemPerEntitlement,
    });
  }
  return keys;
}

function bearerToken(req: express.Request): string | undefined {
  const authorization = req.get('authorization')?.trim();
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function entitlementOrigin(req: express.Request, config: AppConfig): string {
  if (config.publicOrigin) return config.publicOrigin;
  return new URL(`${req.protocol}://${req.get('host')}`).origin;
}

function sanitizeLogError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

const ENTITLEMENT_PROOF_ERRORS = new Set([
  'Canonical entitlement origin is invalid.',
  'Entitlement belongs to a different origin.',
  'Entitlement belongs to a different product.',
  'Entitlement has expired.',
  'Entitlement signing key is no longer accepted.',
  'Entitlement was issued in the future.',
  'Invalid entitlement claims.',
  'Invalid entitlement signature encoding.',
  'Invalid entitlement signature.',
  'Invalid entitlement token format.',
  'Payment signature is required.',
  'Settled payment payload is not valid encoded JSON.',
  'Stored entitlement conflicts with its signed claims.',
  'Stored entitlement conflicts with the settled payment or frozen asset.',
  'Verified payment payload identity is invalid.',
]);

function isEntitlementProofError(error: unknown): boolean {
  return error instanceof Error && ENTITLEMENT_PROOF_ERRORS.has(error.message);
}

function respondRecoverRedeemFailure(
  res: express.Response,
  error: unknown,
  kind: 'recover' | 'redeem',
  logger: AppLogger,
  productId: string,
): 401 | 503 {
  const sanitized = sanitizeLogError(error);
  if (isEntitlementProofError(error)) {
    logger.warn(
      kind === 'recover'
        ? `Entitlement recovery rejected for "${productId}": ${sanitized}`
        : `Entitlement redemption rejected for "${productId}": ${sanitized}`,
    );
    res.status(401).json({
      error:
        kind === 'recover'
          ? 'Entitlement recovery proof is invalid or expired'
          : 'Entitlement is invalid, expired, or no longer redeemable',
    });
    return 401;
  }
  logger.error(
    kind === 'recover'
      ? `Entitlement recovery store unavailable for "${productId}": ${sanitized}`
      : `Entitlement redemption store unavailable for "${productId}": ${sanitized}`,
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(503).json({
    error:
      kind === 'recover'
        ? 'Entitlement recovery is temporarily unavailable'
        : 'Entitlement redemption is temporarily unavailable',
  });
  return 503;
}

function beginObservation(req: express.Request, res: express.Response): string {
  const correlationId = resolveCorrelationId(req.get('x-correlation-id'));
  res.setHeader('X-Correlation-Id', correlationId);
  return correlationId;
}

function observeDelivery(
  dependencies: AppDependencies,
  input: {
    correlationId: string;
    started: number;
    stage: 'purchase' | 'recover' | 'redeem';
    status: number;
    receiptId?: string;
    bytes?: number;
    provider?: string;
  },
): void {
  const duration = Math.max(0, dependencies.clock() - input.started);
  emitObserved(dependencies.observe, {
    correlation_id: input.correlationId,
    ...(input.receiptId ? { receipt_id: input.receiptId } : {}),
    stage: input.stage,
    duration_ms: duration,
    ...(typeof input.bytes === 'number' ? { bytes: input.bytes } : {}),
    ...(isDeliveryProvider(input.provider) ? { provider: input.provider } : {}),
    outcome: outcomeFromStatus(input.status),
  });
}

function isDeliveryProvider(value: string | undefined): value is DeliveryProvider {
  return value === 'local' || value === 'url' || value === 'gdrive' || value === 'dropbox';
}

/**
 * Confirmed 2026-09-06 in production: Vercel's Express zero-config framework
 * preset (as of the CLI/builder upgraded to 59.11.7 earlier this session)
 * auto-detects src/app.ts as the deployed function's entrypoint by filename
 * convention -- it silently overrides this project's own explicit
 * `functions: { "src/server.ts": ... }` config in vercel.json, which points
 * at the file with the real default-exported request handler
 * (vercelHandler). Disabling the preset entirely (`framework: null` in
 * vercel.json) is not viable either: it switches Vercel to the generic
 * builder, which requires functions to live under an `api/` directory and
 * rejects the `src/server.ts` pattern outright.
 *
 * Rather than fight the builder, give it what it wants: re-export the real
 * handler as this module's own default export. This is a lazy re-export
 * (evaluated only when accessed, well after both modules finish loading at
 * request time), so the otherwise-circular app.ts <-> server.ts import is
 * safe -- neither module calls anything from the other at module-load time,
 * only inside functions invoked later.
 */
export { default } from './server';
