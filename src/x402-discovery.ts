import { Request, Response } from 'express';
import { listActive, readCatalog } from './catalog';
import { productAccessPath, requestBaseUrl } from './discovery';

export type X402DiscoveryDocument = {
  version: number;
  protocol: 'x402';
  x402Version: number;
  facilitator: string;
  network: string;
  payTo: string;
  resources: string[];
  ownershipProofs: string[];
  instructions: string;
  openapi: string;
  catalog: string;
};

const NETWORK_CAIP_IDS: Record<string, string> = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  polygon: 'eip155:137',
};

export function normalizeX402Network(network: string): string {
  return NETWORK_CAIP_IDS[network] ?? network;
}

export function buildX402DiscoveryDocument(
  baseUrl: string,
  options: { facilitatorUrl: string; network: string; walletAddress: string },
): X402DiscoveryDocument {
  const origin = baseUrl.replace(/\/$/, '');
  const catalog = readCatalog();
  const wallet = options.walletAddress || catalog.owner.wallet;

  return {
    version: 1,
    protocol: 'x402',
    x402Version: 2,
    facilitator: options.facilitatorUrl,
    network: normalizeX402Network(options.network),
    payTo: wallet,
    resources: listActive().map(entry => `${origin}${productAccessPath(entry)}`),
    ownershipProofs: wallet ? [wallet] : [],
    instructions:
      'Probe any resource URL without PAYMENT-SIGNATURE to receive HTTP 402 with PAYMENT-REQUIRED (x402 v2). Retry with PAYMENT-SIGNATURE after USDC settlement on Base.',
    openapi: `${origin}/.well-known/openapi.json`,
    catalog: `${origin}/.well-known/design-catalog.json`,
  };
}

export function createX402DiscoveryHandler(options: {
  facilitatorUrl: string;
  network: string;
  walletAddress: string;
}) {
  return function handleX402Discovery(req: Request, res: Response): void {
    const document = buildX402DiscoveryDocument(requestBaseUrl(req), options);

    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('application/json');
    res.status(200).json(document);
  };
}
