import { Request, Response } from 'express';
import { requestBaseUrl } from './discovery';

const MCP_SERVER_CARD_SCHEMA =
  'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json';

export type McpServerCard = {
  $schema: string;
  version: string;
  protocolVersion: string;
  serverInfo: {
    name: string;
    title: string;
    version: string;
  };
  description: string;
  documentationUrl: string;
  transport: {
    type: string;
    endpoint: string;
  };
  capabilities: {
    tools: { listChanged: boolean };
    resources: { listChanged: boolean };
    prompts: Record<string, never>;
  };
  authentication: {
    required: boolean;
    schemes: string[];
    resource_metadata: string;
  };
  instructions: string;
  resources: string;
  tools: string;
};

export function buildMcpServerCard(baseUrl: string): McpServerCard {
  const origin = baseUrl.replace(/\/$/, '');

  return {
    $schema: MCP_SERVER_CARD_SCHEMA,
    version: '1.0',
    protocolVersion: '2025-11-25',
    serverInfo: {
      name: 'curatoria',
      title: 'Curatoria x402 Catalog',
      version: '1.0.0',
    },
    description:
      'Discovery metadata for Curatoria HTTP x402 catalog routes. Integration is via GET /.well-known/design-catalog.json and paid asset URLs — not a live MCP tool server.',
    documentationUrl: `${origin}/llms.txt`,
    transport: {
      type: 'streamable-http',
      endpoint: '/mcp',
    },
    capabilities: {
      tools: { listChanged: true },
      resources: { listChanged: true },
      prompts: {},
    },
    authentication: {
      required: true,
      schemes: ['oauth2', 'x402'],
      resource_metadata: `${origin}/.well-known/oauth-protected-resource`,
    },
    instructions:
      'No MCP transport is deployed at /mcp. Read /llms.txt for buyer flow. Free catalog: GET /.well-known/design-catalog.json. Paid assets use x402 after HTTP 402 on each access_url.',
    resources: 'dynamic',
    tools: 'dynamic',
  };
}

export function handleMcpServerCard(req: Request, res: Response): void {
  const card = buildMcpServerCard(requestBaseUrl(req));
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('application/json');
  res.status(200).json(card);
}
