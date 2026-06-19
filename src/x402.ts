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
import { paymentMiddlewareFromHTTPServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { findEntry, resolveCatalogPriceUsd } from './catalog';
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
            example: expectedResourceType === 'bundle_zip'
              ? '<zip binary bytes>'
              : '# paid design markdown\n',
            schema: {
              type: 'string',
              description: expectedResourceType === 'bundle_zip'
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

    aliasXPaymentHeader(req);
    officialMiddleware(req, res, next).catch(next);
  };
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

    aliasXPaymentHeader(req);
    officialMiddleware(req, res, next).catch(next);
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
