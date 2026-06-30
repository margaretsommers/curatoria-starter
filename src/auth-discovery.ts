import { Request, Response } from 'express';
import { requestBaseUrl } from './discovery';

export type OAuthAuthorizationServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint: string;
  grant_types_supported: string[];
  response_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
  service_documentation: string;
  agent_auth: AgentAuthMetadata;
  'x_curatoria_buyer_authentication': {
    mechanism: 'x402';
    challenge_status: number;
    payment_signature_header: string;
    payment_required_header: string;
    catalog_url: string;
    documentation: string;
    facilitator_url: string;
    network: string;
  };
  'x_curatoria_admin_authentication': {
    mechanism: 'api-key';
    header: string;
    routes: string[];
  };
};

export type AgentAuthMetadata = {
  skill: string;
  register_uri: string;
  claim_uri: string;
  revocation_uri: string;
  identity_types_supported: string[];
  anonymous: {
    credential_types_supported: string[];
  };
};

export type AuthMethodsDocument = {
  issuer: string;
  buyer: OAuthAuthorizationServerMetadata['x_curatoria_buyer_authentication'];
  admin: OAuthAuthorizationServerMetadata['x_curatoria_admin_authentication'];
  documentation: string[];
};

export type OAuthProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_documentation: string;
  'x_curatoria_buyer_authentication': OAuthAuthorizationServerMetadata['x_curatoria_buyer_authentication'];
  'x_curatoria_admin_authentication': OAuthAuthorizationServerMetadata['x_curatoria_admin_authentication'];
};

export function buildOAuthProtectedResourceMetadata(
  baseUrl: string,
  options: { facilitatorUrl: string; network: string },
): OAuthProtectedResourceMetadata {
  const origin = baseUrl.replace(/\/$/, '');
  const authMetadata = buildOAuthAuthorizationServerMetadata(baseUrl, options);

  return {
    resource: `${origin}/`,
    authorization_servers: [authMetadata.issuer],
    scopes_supported: authMetadata.scopes_supported,
    bearer_methods_supported: ['header'],
    resource_documentation: authMetadata.service_documentation,
    'x_curatoria_buyer_authentication': authMetadata.x_curatoria_buyer_authentication,
    'x_curatoria_admin_authentication': authMetadata.x_curatoria_admin_authentication,
  };
}

export function protectedResourceMetadataUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/.well-known/oauth-protected-resource`;
}

export function buildWwwAuthenticateResourceMetadata(baseUrl: string): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(baseUrl)}"`;
}

export function buildAgentAuthBlock(baseUrl: string): AgentAuthMetadata {
  const origin = baseUrl.replace(/\/$/, '');

  return {
    skill: `${origin}/auth.md`,
    register_uri: `${origin}/.well-known/agent/register`,
    claim_uri: `${origin}/.well-known/agent/claim`,
    revocation_uri: `${origin}/.well-known/agent/revoke`,
    identity_types_supported: ['anonymous'],
    anonymous: {
      credential_types_supported: ['x402_payment_signature'],
    },
  };
}

export function buildAuthMd(
  baseUrl: string,
  options: { facilitatorUrl: string; network: string },
): string {
  const origin = baseUrl.replace(/\/$/, '');
  const agentAuth = buildAgentAuthBlock(origin);

  return `# Curatoria auth.md

Curatoria is an x402 commerce API for creator-owned design catalogs. Buyer agents pay per asset in USDC on Base; operator admin routes use an API key.

## Discovery

- Protected Resource Metadata: \`${origin}/.well-known/oauth-protected-resource\`
- Authorization Server Metadata: \`${origin}/.well-known/oauth-authorization-server\`
- Agent integration guide: \`${origin}/llms.txt\`
- OpenAPI description: \`${origin}/.well-known/openapi.json\`

## Supported registration methods

### anonymous (buyer agents)

No user account or OAuth access token is required. Register for access by configuring an x402-capable wallet and following the free catalog at \`/.well-known/design-catalog.json\`.

- **Credential type:** \`x402_payment_signature\` via the \`PAYMENT-SIGNATURE\` header after HTTP 402 on paid routes
- **Register URI:** \`${agentAuth.register_uri}\`
- **Network:** ${options.network}
- **Facilitator:** ${options.facilitatorUrl}

### admin:publish (operators only)

Admin credentials are provisioned out of band. Send \`X-Admin-Key\` on \`POST /admin/publish\` and \`GET /admin/facilitator-preflight\`.

## Scopes

| Scope | Audience | Use |
| --- | --- | --- |
| \`admin:publish\` | Operators | Publish or update catalog entries |

## Claim and revocation

- **Claim URI:** \`${agentAuth.claim_uri}\` — user-claimed binding is not used for buyer x402 access
- **Revocation URI:** \`${agentAuth.revocation_uri}\` — rotate admin keys out of band; x402 payments are per request

## Policies

- Privacy: \`${origin}/privacy.html\`
- Setup guide: \`${origin}/starter-guide.html\`
`;
}

export function buildOAuthAuthorizationServerMetadata(
  baseUrl: string,
  options: { facilitatorUrl: string; network: string },
): OAuthAuthorizationServerMetadata {
  const origin = baseUrl.replace(/\/$/, '');

  return {
    issuer: origin,
    authorization_endpoint: `${origin}/.well-known/auth`,
    token_endpoint: `${origin}/.well-known/auth/token`,
    jwks_uri: `${origin}/.well-known/jwks.json`,
    revocation_endpoint: `${origin}/.well-known/agent/revoke`,
    grant_types_supported: ['client_credentials'],
    response_types_supported: ['token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'private_key_jwt'],
    scopes_supported: ['admin:publish'],
    service_documentation: `${origin}/llms.txt`,
    agent_auth: buildAgentAuthBlock(origin),
    'x_curatoria_buyer_authentication': {
      mechanism: 'x402',
      challenge_status: 402,
      payment_signature_header: 'PAYMENT-SIGNATURE',
      payment_required_header: 'PAYMENT-REQUIRED',
      catalog_url: `${origin}/.well-known/design-catalog.json`,
      documentation: `${origin}/llms.txt`,
      facilitator_url: options.facilitatorUrl,
      network: options.network,
    },
    'x_curatoria_admin_authentication': {
      mechanism: 'api-key',
      header: 'X-Admin-Key',
      routes: ['POST /admin/publish', 'GET /admin/facilitator-preflight'],
    },
  };
}

export function buildAuthMethodsDocument(
  baseUrl: string,
  options: { facilitatorUrl: string; network: string },
): AuthMethodsDocument {
  const metadata = buildOAuthAuthorizationServerMetadata(baseUrl, options);

  return {
    issuer: metadata.issuer,
    buyer: metadata.x_curatoria_buyer_authentication,
    admin: metadata.x_curatoria_admin_authentication,
    documentation: [metadata.service_documentation, `${metadata.issuer}/starter-guide.html`],
  };
}

function discoveryOptions(): { facilitatorUrl: string; network: string } {
  return {
    facilitatorUrl: process.env.FACILITATOR_URL ?? 'https://x402.org/facilitator',
    network: process.env.NETWORK ?? 'base-sepolia',
  };
}

export function handleOAuthAuthorizationServer(req: Request, res: Response): void {
  const metadata = buildOAuthAuthorizationServerMetadata(requestBaseUrl(req), discoveryOptions());
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('application/json');
  res.status(200).json(metadata);
}

export function handleOAuthProtectedResource(req: Request, res: Response): void {
  const metadata = buildOAuthProtectedResourceMetadata(requestBaseUrl(req), discoveryOptions());
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('application/json');
  res.status(200).json(metadata);
}

export function respondAdminUnauthorized(req: Request, res: Response): void {
  res.setHeader('WWW-Authenticate', buildWwwAuthenticateResourceMetadata(requestBaseUrl(req)));
  res.status(401).json({ error: 'Unauthorized — X-Admin-Key header required' });
}

export function handleAuthMethods(req: Request, res: Response): void {
  const document = buildAuthMethodsDocument(requestBaseUrl(req), discoveryOptions());
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('application/json');
  res.status(200).json(document);
}

export function handleAuthToken(req: Request, res: Response): void {
  const origin = requestBaseUrl(req).replace(/\/$/, '');
  res.type('application/json');
  res.status(400).json({
    error: 'unsupported_grant_type',
    error_description:
      'Curatoria buyer APIs authenticate with x402 payment signatures on paid routes, not OAuth tokens.',
    documentation: `${origin}/llms.txt`,
    auth_methods: `${origin}/.well-known/auth`,
    oauth_authorization_server: `${origin}/.well-known/oauth-authorization-server`,
  });
}

export function handleJwks(_req: Request, res: Response): void {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('application/json');
  res.status(200).json({ keys: [] });
}

export function handleAuthMd(req: Request, res: Response): void {
  const markdown = buildAuthMd(requestBaseUrl(req), discoveryOptions());
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('text/markdown; charset=utf-8');
  res.status(200).send(markdown);
}

export function handleAgentRegisterDiscovery(req: Request, res: Response): void {
  const origin = requestBaseUrl(req).replace(/\/$/, '');
  const options = discoveryOptions();

  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('application/json');
  res.status(200).json({
    methods: ['anonymous'],
    anonymous: {
      credential_types_supported: ['x402_payment_signature'],
      description:
        'Buyer agents authenticate with x402 payment signatures on paid routes. No account registration is required.',
      catalog_url: `${origin}/.well-known/design-catalog.json`,
      documentation: `${origin}/llms.txt`,
      network: options.network,
      facilitator_url: options.facilitatorUrl,
    },
    admin: {
      mechanism: 'api-key',
      header: 'X-Admin-Key',
      scope: 'admin:publish',
      description: 'Operator credentials are provisioned out of band.',
    },
  });
}

export function handleAgentClaimDiscovery(req: Request, res: Response): void {
  const origin = requestBaseUrl(req).replace(/\/$/, '');

  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('application/json');
  res.status(200).json({
    supported: false,
    description:
      'Curatoria buyer access uses anonymous x402 payment per request. User-claimed agent binding is not required.',
    documentation: `${origin}/auth.md`,
  });
}

export function handleAgentRevokeDiscovery(req: Request, res: Response): void {
  const origin = requestBaseUrl(req).replace(/\/$/, '');

  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('application/json');
  res.status(200).json({
    buyer: {
      mechanism: 'x402',
      description:
        'Paid access is per request. Revoke future spending by disabling or rotating the agent wallet.',
    },
    admin: {
      mechanism: 'api-key',
      description: 'Rotate ADMIN_API_KEY in deployment environment variables to revoke operator access.',
    },
    documentation: `${origin}/auth.md`,
  });
}
