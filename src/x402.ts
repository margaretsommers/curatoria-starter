/**
 * x402.ts — Curatoria x402 payment middleware
 *
 * Curatoria keeps catalog lookup and route validation local, then delegates the
 * x402 protocol work to the official resource-server middleware:
 * challenge generation, verification, settlement, and payment response headers.
 */

import { Request, Response, NextFunction } from 'express';
import {
  HTTPFacilitatorClient,
  RoutesConfig,
  x402HTTPResourceServer,
  x402ResourceServer,
} from '@x402/core/server';
import type { FacilitatorConfig } from '@x402/core/server';
import type { Network } from '@x402/core/types';
import { ExpressAdapter, paymentMiddlewareFromHTTPServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { findEntry, resolveCatalogPriceUsd } from './catalog';
import {
  authorizedPaymentIdentity,
  finalizedSettlementIdentity,
  settlementReference,
} from './asset-delivery';
import type { EntitlementStore } from './entitlements';
import type { SettlementJournal } from './settlement-journal';
import { DesignSystemEntry, ResourceType } from './types';

/** Track B: paid GET /catalog with free teaser at well-known. Default is Track A (free full catalog). */
export function isCatalogPaywallEnabled(): boolean {
  return process.env.CATALOG_PAYWALL_ENABLED === '1';
}

function isCatalogPaywallBypassed(): boolean {
  return process.env.CATALOG_PAYWALL_BYPASS === '1';
}

const NETWORK_CAIP_IDS: Record<string, string> = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  polygon: 'eip155:137',
};

const USDC_BY_NETWORK: Record<string, { asset: string; name: string; version: string }> = {
  'eip155:8453': {
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    name: 'USD Coin',
    version: '2',
  },
  'eip155:84532': {
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    name: 'USDC',
    version: '2',
  },
  'eip155:137': {
    asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    name: 'USD Coin',
    version: '2',
  },
};

type ProtectedResource = {
  routePattern: string;
  description: string;
  mimeType: string;
  resourceType: ResourceType;
};

const PROTECTED_RESOURCES: Record<ResourceType, ProtectedResource> = {
  design_md: {
    routePattern: 'GET /design-systems/:id',
    description: 'Curatoria paid markdown design system',
    mimeType: 'text/markdown',
    resourceType: 'design_md',
  },
  bundle_zip: {
    routePattern: 'GET /packs/:id/download',
    description: 'Curatoria paid zip bundle',
    mimeType: 'application/zip',
    resourceType: 'bundle_zip',
  },
  binary_asset: {
    routePattern: 'GET /assets/:id/purchase',
    description: 'Curatoria paid binary asset entitlement',
    mimeType: 'application/json',
    resourceType: 'binary_asset',
  },
};

export interface X402Config {
  walletAddress: string;
  network: string;
  facilitatorUrl: string;
  expectedResourceType?: ResourceType;
}

export type X402CatalogConfig = X402Config & {
  catalogPriceUsd?: string;
};

type SettlementFirstServer = Pick<
  x402HTTPResourceServer,
  'initialize' | 'processHTTPRequest' | 'processSettlement'
>;

export const X402_SETTLEMENT_LOCAL = 'x402Settlement';

export type FacilitatorPreflightResult = {
  ok: boolean;
  url: string;
  network: Network;
  cdpAuthConfigured: boolean;
  credentialEnv: {
    apiKeyId: 'CDP_API_KEY_ID' | 'COINBASE_CDP_API_KEY' | null;
    apiKeySecret: 'CDP_API_KEY_SECRET' | null;
  };
  supportedKinds?: number;
  supportsNetwork?: boolean;
  checkedAt: string;
  error?: string;
};

export function x402Paywall(config: X402Config) {
  const { walletAddress, network, facilitatorUrl, expectedResourceType = 'design_md' } = config;
  const resource = PROTECTED_RESOURCES[expectedResourceType];
  const caipNetwork = normalizeNetwork(network);

  const facilitatorClient = new HTTPFacilitatorClient(
    facilitatorConfigForNetwork(facilitatorUrl, caipNetwork),
  );
  const evmScheme = new ExactEvmScheme().registerMoneyParser(async (amount, parserNetwork) => {
    const usdc = USDC_BY_NETWORK[parserNetwork];
    if (!usdc) return null;
    return {
      amount: String(Math.round(amount * 1_000_000)),
      asset: usdc.asset,
      extra: {
        assetTransferMethod: 'eip3009',
        name: usdc.name,
        version: usdc.version,
      },
    };
  });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    caipNetwork,
    evmScheme,
  );
  const routes = {
    [resource.routePattern]: {
      accepts: {
        scheme: 'exact',
        network: caipNetwork,
        payTo: walletAddress,
        price: (context) => priceForRequest(context.adapter.getPath(), expectedResourceType),
        maxTimeoutSeconds: 300,
      },
      description: resource.description,
      mimeType: resource.mimeType,
      serviceName: 'Curatoria',
      tags: ['curatoria', 'design-systems', resource.resourceType],
      extensions: {
        ...declareDiscoveryExtension({
          input: { id: '<catalog-slug>' },
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Catalog slug for the paid Curatoria resource.',
              },
            },
            required: ['id'],
          },
          output: {
            example:
              expectedResourceType === 'binary_asset'
                ? {
                    entitlement: '<short-lived-signed-token>',
                    redeem_url: '/assets/<id>/redeem',
                    expires_at: '<ISO-8601>',
                  }
                : expectedResourceType === 'bundle_zip'
                  ? '<zip binary bytes>'
                  : '# paid design markdown\n',
            schema: {
              type: expectedResourceType === 'binary_asset' ? 'object' : 'string',
              description:
                expectedResourceType === 'binary_asset'
                  ? 'Short-lived entitlement returned after successful x402 settlement.'
                  : expectedResourceType === 'bundle_zip'
                    ? 'Zip binary content returned after successful x402 settlement.'
                    : 'Markdown content returned after successful x402 settlement.',
            },
          },
        }),
        curatoria: {
          resourceType: resource.resourceType,
          routePattern: resource.routePattern,
        },
      },
    },
  } as RoutesConfig;

  const httpServer = new x402HTTPResourceServer(resourceServer, routes);

  const officialMiddleware = paymentMiddlewareFromHTTPServer(httpServer);

  return function x402Middleware(req: Request, res: Response, next: NextFunction): void {
    const entry = catalogEntryForRequest(req, expectedResourceType);
    if (!entry) {
      res.status(404).json({ error: `Resource "${req.params.id}" not found` });
      return;
    }

    invokeX402Middleware(officialMiddleware, req, res, next);
  };
}

/**
 * Binary entitlement purchases must see authenticated finalized evidence before
 * issuing claims. Official `paymentMiddlewareFromHTTPServer` buffers the route
 * handler and calls `processSettlement` only after `res.end`, so a JSON
 * entitlement would exist before facilitator finality. `onAfterSettle` cannot
 * close that gap: resource-server hook errors are swallowed. This purchase
 * middleware therefore verifies and settles first, then exposes only the
 * authenticated facilitator identity in `res.locals`.
 *
 * Installed `HTTPFacilitatorClient` still has no settlement-status lookup. The
 * crash window between `processSettlement` and `EntitlementStore.saveIfAbsent`
 * is closed by persisting a durable settlement receipt immediately after
 * facilitator finality, then skipping a second settle on retry. Direct byte
 * routes continue using the official buffered flow.
 */
export function x402PurchasePaywall(
  config: X402Config & {
    settlementServer?: SettlementFirstServer;
    settlementJournal?: SettlementJournal;
    entitlementStore?: EntitlementStore;
  },
) {
  const httpServer =
    config.settlementServer ??
    buildHttpResourceServer(config, PROTECTED_RESOURCES.binary_asset);
  const middleware = createSettlementFirstMiddleware(httpServer, {
    initialize: !config.settlementServer,
    journal: config.settlementJournal,
    entitlements: config.entitlementStore,
  });
  return function purchasePaywall(req: Request, res: Response, next: NextFunction): void {
    if (!catalogEntryForRequest(req, 'binary_asset')) {
      res.status(404).json({ error: `Resource "${req.params.id}" not found` });
      return;
    }
    void middleware(req, res, next);
  };
}

export type SettlementFirstOptions = {
  initialize?: boolean;
  journal?: SettlementJournal;
  entitlements?: EntitlementStore;
};

export function createSettlementFirstMiddleware(
  httpServer: SettlementFirstServer,
  options: SettlementFirstOptions = {},
) {
  const initialize = options.initialize ?? false;
  let initialization: Promise<void> | undefined;
  return async function settlementFirst(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    aliasXPaymentHeader(req);
    const adapter = new ExpressAdapter(req);
    const context = {
      adapter,
      path: req.path,
      method: req.method,
      paymentHeader: adapter.getHeader('payment-signature') || adapter.getHeader('x-payment'),
    };
    try {
      if (initialize) {
        initialization ??= httpServer.initialize();
        await initialization;
      }
      const signature = context.paymentHeader;
      if (signature) {
        let authorized: { network: string; payer: string } | undefined;
        try {
          authorized = authorizedPaymentIdentity(signature);
        } catch {
          authorized = undefined;
        }
        if (authorized) {
          const recovered = await recoverSettledEvidence(
            options,
            settlementReference(signature),
            idFromPath(req.path, 'binary_asset'),
            authorized,
          );
          if (recovered) {
            res.locals[X402_SETTLEMENT_LOCAL] = recovered;
            next();
            return;
          }
        }
      }
      const result = await httpServer.processHTTPRequest(context);
      if (result.type === 'no-payment-required') {
        next();
        return;
      }
      if (result.type === 'payment-error') {
        sendInstructions(res, result.response);
        return;
      }
      const verifiedSignature = context.paymentHeader ?? '';
      const authorized = authorizedPaymentIdentity(verifiedSignature);
      const reference = settlementReference(verifiedSignature);
      const settled = await httpServer.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        { request: context },
      );
      if (!settled.success) {
        sendInstructions(res, settled.response);
        return;
      }
      const evidence = finalizedSettlementIdentity(
        {
          network: settled.network,
          payer: settled.payer ?? '',
          transaction: settled.transaction,
        },
        authorized,
      );
      const settledProductId = idFromPath(req.path, 'binary_asset');
      if (options.journal && !settledProductId) {
        throw new Error('Settled purchase path did not resolve to a product id.');
      }
      const persisted =
        options.journal && settledProductId
          ? (
              await options.journal.saveIfAbsent(reference, {
                version: 1,
                productId: settledProductId,
                ...evidence,
              })
            ).receipt
          : evidence;
      Object.entries(settled.headers).forEach(([key, value]) => res.setHeader(key, value));
      res.locals[X402_SETTLEMENT_LOCAL] = {
        network: persisted.network,
        payer: persisted.payer,
        transaction: persisted.transaction,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

async function recoverSettledEvidence(
  options: SettlementFirstOptions,
  reference: string,
  productId: string | undefined,
  authorized: { network: string; payer: string },
) {
  if (options.entitlements && productId) {
    const issued = await options.entitlements.find(reference, productId);
    if (issued) {
      return finalizedSettlementIdentity(issued.payment, authorized);
    }
  }
  if (!options.journal || !productId) return undefined;
  const receipt = await options.journal.find(reference);
  // The journal is keyed by the payment header digest alone, so the receipt's
  // own product binding is the only thing preventing one settled header from
  // recovering settlement evidence for every product in the catalog.
  if (!receipt || receipt.productId !== productId) return undefined;
  return finalizedSettlementIdentity(receipt, authorized);
}

export function x402CatalogPaywall(config: X402CatalogConfig) {
  const { walletAddress, network, facilitatorUrl } = config;
  const catalogPriceUsd = config.catalogPriceUsd ?? resolveCatalogPriceUsd();
  const caipNetwork = normalizeNetwork(network);

  const facilitatorClient = new HTTPFacilitatorClient(
    facilitatorConfigForNetwork(facilitatorUrl, caipNetwork),
  );
  const evmScheme = new ExactEvmScheme().registerMoneyParser(async (amount, parserNetwork) => {
    const usdc = USDC_BY_NETWORK[parserNetwork];
    if (!usdc) return null;
    return {
      amount: String(Math.round(amount * 1_000_000)),
      asset: usdc.asset,
      extra: {
        assetTransferMethod: 'eip3009',
        name: usdc.name,
        version: usdc.version,
      },
    };
  });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    caipNetwork,
    evmScheme,
  );
  const routes = {
    'GET /catalog': {
      accepts: {
        scheme: 'exact',
        network: caipNetwork,
        payTo: walletAddress,
        price: `$${catalogPriceUsd}`,
        maxTimeoutSeconds: 300,
      },
      description: 'Curatoria catalog listing',
      mimeType: 'application/json',
      serviceName: 'Curatoria',
      tags: ['curatoria', 'catalog', 'directory'],
      extensions: {
        ...declareDiscoveryExtension({
          input: {},
          inputSchema: {
            type: 'object',
            properties: {},
          },
          output: {
            example: {
              owner: { wallet: '0x...', name: 'Creator' },
              total: 1,
              base_url: 'https://example.com',
              design_systems: [],
            },
            schema: {
              type: 'object',
              description: 'Full catalog metadata returned after successful x402 settlement.',
            },
          },
        }),
        curatoria: {
          resourceType: 'catalog_list',
          routePattern: 'GET /catalog',
        },
      },
    },
  } as RoutesConfig;

  const httpServer = new x402HTTPResourceServer(resourceServer, routes);
  const officialMiddleware = paymentMiddlewareFromHTTPServer(httpServer);

  return function x402CatalogMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (isCatalogPaywallBypassed()) {
      next();
      return;
    }

    invokeX402Middleware(officialMiddleware, req, res, next);
  };
}

export async function checkFacilitatorPreflight(
  facilitatorUrl: string,
  network: string,
): Promise<FacilitatorPreflightResult> {
  const caipNetwork = normalizeNetwork(network);
  const config = facilitatorConfigForNetwork(facilitatorUrl, caipNetwork);
  const credentials = readCdpCredentials();
  const client = new HTTPFacilitatorClient(config);
  const resultBase: Omit<FacilitatorPreflightResult, 'ok'> = {
    url: config.url ?? facilitatorUrlForNetwork(facilitatorUrl, caipNetwork),
    network: caipNetwork,
    cdpAuthConfigured: Boolean(credentials.apiKeyId && credentials.apiKeySecret),
    credentialEnv: credentials.env,
    checkedAt: new Date().toISOString(),
  };

  try {
    const supported = await client.getSupported();
    const supportsNetwork = supported.kinds.some((kind) => kind.network === caipNetwork);
    return {
      ...resultBase,
      ok: supportsNetwork,
      supportedKinds: supported.kinds.length,
      supportsNetwork,
      error: supportsNetwork ? undefined : `Facilitator does not list support for ${caipNetwork}`,
    };
  } catch (error) {
    return {
      ...resultBase,
      ok: false,
      error: sanitizeFacilitatorError(error),
    };
  }
}

function catalogEntryForRequest(req: Request, expectedResourceType: ResourceType): DesignSystemEntry | undefined {
  const entry = findEntry(req.params.id);
  const entryResourceType = entry?.resource_type ?? 'design_md';
  return entry && entryResourceType === expectedResourceType ? entry : undefined;
}

function buildHttpResourceServer(
  config: X402Config,
  resource: ProtectedResource,
): x402HTTPResourceServer {
  const caipNetwork = normalizeNetwork(config.network);
  const facilitatorClient = new HTTPFacilitatorClient(
    facilitatorConfigForNetwork(config.facilitatorUrl, caipNetwork),
  );
  const evmScheme = new ExactEvmScheme().registerMoneyParser(async (amount, parserNetwork) => {
    const usdc = USDC_BY_NETWORK[parserNetwork];
    if (!usdc) return null;
    return {
      amount: String(Math.round(amount * 1_000_000)),
      asset: usdc.asset,
      extra: {
        assetTransferMethod: 'eip3009',
        name: usdc.name,
        version: usdc.version,
      },
    };
  });
  const server = new x402ResourceServer(facilitatorClient).register(caipNetwork, evmScheme);
  const routes = {
    [resource.routePattern]: {
      accepts: {
        scheme: 'exact',
        network: caipNetwork,
        payTo: config.walletAddress,
        price: (context) => priceForRequest(context.adapter.getPath(), resource.resourceType),
        maxTimeoutSeconds: 300,
      },
      description: resource.description,
      mimeType: resource.mimeType,
      serviceName: 'Curatoria',
      tags: ['curatoria', 'design-systems', resource.resourceType],
    },
  } as RoutesConfig;
  return new x402HTTPResourceServer(server, routes);
}

function sendInstructions(
  res: Response,
  response: { status: number; headers: Record<string, string>; body?: unknown; isHtml?: boolean },
): void {
  res.status(response.status);
  Object.entries(response.headers).forEach(([key, value]) => res.setHeader(key, value));
  if (response.isHtml) {
    res.send(response.body);
  } else {
    res.json(response.body ?? {});
  }
}

function priceForRequest(path: string, expectedResourceType: ResourceType): string {
  const id = idFromPath(path, expectedResourceType);
  const entry = id ? findEntry(id) : undefined;
  const entryResourceType = entry?.resource_type ?? 'design_md';
  if (!entry || entryResourceType !== expectedResourceType) {
    throw new Error(`Resource "${id ?? path}" not found`);
  }
  return `$${entry.price_usd}`;
}

function idFromPath(path: string, expectedResourceType: ResourceType): string | undefined {
  const normalizedPath = path.split(/[?#]/)[0].replace(/\/+$/, '');
  const pattern =
    expectedResourceType === 'bundle_zip'
      ? /^\/packs\/([^/]+)\/download$/i
      : expectedResourceType === 'binary_asset'
        ? /^\/assets\/([^/]+)\/purchase$/i
        : /^\/design-systems\/([^/]+)$/i;
  const match = normalizedPath.match(pattern);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function normalizeNetwork(network: string): Network {
  return (NETWORK_CAIP_IDS[network] ?? network) as Network;
}

function facilitatorConfigForNetwork(facilitatorUrl: string, network: Network): FacilitatorConfig {
  const url = facilitatorUrlForNetwork(facilitatorUrl, network);
  if (!isCoinbaseFacilitator(url)) {
    return { url };
  }

  return {
    url,
    createAuthHeaders: async () => {
      const { apiKeyId, apiKeySecret } = readCdpCredentials();
      const coinbase = await import('@coinbase/x402');
      const facilitator = coinbase.createFacilitatorConfig(apiKeyId, apiKeySecret);
      if (!facilitator.createAuthHeaders) {
        return { verify: {}, settle: {}, supported: {} };
      }
      return facilitator.createAuthHeaders();
    },
  };
}

function facilitatorUrlForNetwork(facilitatorUrl: string, network: Network): string {
  if (isCoinbaseFacilitator(facilitatorUrl) && network === 'eip155:84532') {
    return 'https://x402.org/facilitator';
  }
  return facilitatorUrl;
}

function isCoinbaseFacilitator(facilitatorUrl: string): boolean {
  return facilitatorUrl.includes('api.cdp.coinbase.com');
}

function readCdpCredentials(): {
  apiKeyId: string | undefined;
  apiKeySecret: string | undefined;
  env: FacilitatorPreflightResult['credentialEnv'];
} {
  const officialApiKeyId = readEnv('CDP_API_KEY_ID');
  const legacyApiKeyId = readEnv('COINBASE_CDP_API_KEY');
  const apiKeySecret = readEnv('CDP_API_KEY_SECRET');

  return {
    apiKeyId: officialApiKeyId ?? legacyApiKeyId,
    apiKeySecret,
    env: {
      apiKeyId: officialApiKeyId
        ? 'CDP_API_KEY_ID'
        : legacyApiKeyId
          ? 'COINBASE_CDP_API_KEY'
          : null,
      apiKeySecret: apiKeySecret ? 'CDP_API_KEY_SECRET' : null,
    },
  };
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function sanitizeFacilitatorError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]');
}

function aliasXPaymentHeader(req: Request): void {
  const xPayment = req.headers['x-payment'];
  if (!req.headers['payment-signature'] && typeof xPayment === 'string') {
    req.headers['payment-signature'] = xPayment;
  }
}

function invokeX402Middleware(
  officialMiddleware: ReturnType<typeof paymentMiddlewareFromHTTPServer>,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  aliasXPaymentHeader(req);
  void officialMiddleware(req, res, (err?: unknown) => {
    if (err) {
      console.error(`x402 middleware error on ${req.method} ${req.path}:`, err);
      if (!res.headersSent) {
        res.status(503).json({ error: 'x402 payment service unavailable' });
      }
      return;
    }
    next();
  }).catch((err: unknown) => {
    console.error(`x402 middleware rejected on ${req.method} ${req.path}:`, err);
    if (!res.headersSent) {
      res.status(503).json({ error: 'x402 payment service unavailable' });
    }
  });
}
