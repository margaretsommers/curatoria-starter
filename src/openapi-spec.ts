import { Request, Response } from 'express';
import { readCatalog } from './catalog';
import { requestBaseUrl } from './discovery';
import { normalizeX402Network } from './x402-discovery';

const X402_PAYMENT_INFO = {
  protocols: ['x402'],
  price: {
    mode: 'dynamic',
    currency: 'USD',
    min: '0.01',
    max: '999.00',
  },
};

export function buildOpenApiDocument(baseUrl: string): Record<string, unknown> {
  const origin = baseUrl.replace(/\/$/, '');
  const catalog = readCatalog();
  const ownerWallet = catalog.owner.wallet;
  const facilitatorUrl = process.env.FACILITATOR_URL ?? 'https://x402.org/facilitator';
  const network = normalizeX402Network(process.env.NETWORK ?? 'base-sepolia');

  return {
    openapi: '3.1.0',
    info: {
      title: 'Curatoria x402 Commerce API',
      version: '1.0.0',
      description:
        'Creator-owned design catalog with free discovery and x402 USDC paywalls on Base for paid asset delivery.',
    },
    servers: [{ url: origin }],
    'x-discovery': {
      ownershipProofs: ownerWallet ? [ownerWallet] : [],
      x402: `${origin}/.well-known/x402`,
    },
    'x-payment-protocols': ['x402'],
    'x402': {
      version: 2,
      facilitator: facilitatorUrl,
      network,
      payTo: ownerWallet,
      discovery: `${origin}/.well-known/x402`,
    },
    components: {
      securitySchemes: {
        X402Payment: {
          type: 'apiKey',
          in: 'header',
          name: 'PAYMENT-SIGNATURE',
          description:
            'x402 v2 payment signature presented after receiving HTTP 402 with PAYMENT-REQUIRED on paid routes.',
        },
        AdminApiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Admin-Key',
          description: 'Operator API key for admin publish routes.',
        },
      },
    },
    paths: {
      '/.well-known/design-catalog.json': {
        get: {
          summary: 'Free design catalog discovery',
          operationId: 'getDesignCatalog',
          responses: {
            '200': {
              description: 'Full product metadata with access_url values (Track A default)',
              content: {
                'application/json': {
                  schema: { type: 'object' },
                },
              },
            },
          },
        },
      },
      '/catalog': {
        get: {
          summary: 'Catalog listing alias',
          operationId: 'getCatalogAlias',
          responses: {
            '200': {
              description: 'Free catalog alias on Track A',
              content: {
                'application/json': {
                  schema: { type: 'object' },
                },
              },
            },
            '402': {
              description: 'Paid catalog listing on Track B',
            },
          },
        },
      },
      '/design-systems/{id}': {
        get: {
          summary: 'Paid markdown asset',
          operationId: 'getDesignSystemAsset',
          'x-payment-info': X402_PAYMENT_INFO,
          security: [{ X402Payment: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Markdown bytes after successful x402 payment',
              content: {
                'text/markdown': {
                  schema: { type: 'string' },
                },
              },
            },
            '402': {
              description: 'x402 payment required',
            },
          },
        },
      },
      '/packs/{id}/download': {
        get: {
          summary: 'Paid zip bundle',
          operationId: 'downloadPack',
          'x-payment-info': X402_PAYMENT_INFO,
          security: [{ X402Payment: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Zip bytes after successful x402 payment',
              content: {
                'application/zip': {
                  schema: { type: 'string', format: 'binary' },
                },
              },
            },
            '402': {
              description: 'x402 payment required',
            },
          },
        },
      },
      '/health': {
        get: {
          summary: 'Service health and configuration',
          operationId: 'getHealth',
          responses: {
            '200': {
              description: 'Service status',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string' },
                      network: { type: 'string' },
                      wallet: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/.well-known/oauth-authorization-server': {
        get: {
          summary: 'OAuth 2.0 authorization server metadata',
          operationId: 'getOAuthAuthorizationServerMetadata',
          responses: {
            '200': {
              description: 'RFC 8414 discovery document with Curatoria x402 extensions',
              content: {
                'application/json': {
                  schema: { type: 'object' },
                },
              },
            },
          },
        },
      },
      '/.well-known/oauth-protected-resource': {
        get: {
          summary: 'OAuth 2.0 protected resource metadata',
          operationId: 'getOAuthProtectedResourceMetadata',
          responses: {
            '200': {
              description: 'RFC 9728 discovery document for protected admin routes',
              content: {
                'application/json': {
                  schema: { type: 'object' },
                },
              },
            },
          },
        },
      },
    },
  };
}

export function handleOpenApiSpec(req: Request, res: Response): void {
  const document = buildOpenApiDocument(requestBaseUrl(req));
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('application/json');
  res.status(200).json(document);
}
