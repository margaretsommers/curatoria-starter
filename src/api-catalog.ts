import { Request, Response } from 'express';
import { requestBaseUrl } from './discovery';

const RFC9727_PROFILE = 'https://www.rfc-editor.org/info/rfc9727';

export type LinksetTarget = {
  href: string;
  type?: string;
};

export type ApiCatalogLinksetEntry = {
  anchor: string;
  'service-desc'?: LinksetTarget[];
  'service-doc'?: LinksetTarget[];
  status?: LinksetTarget[];
  'service-meta'?: LinksetTarget[];
};

export type ApiCatalogLinkset = {
  linkset: ApiCatalogLinksetEntry[];
};

export function buildApiCatalogLinkset(baseUrl: string): ApiCatalogLinkset {
  const origin = baseUrl.replace(/\/$/, '');

  return {
    linkset: [
      {
        anchor: `${origin}/`,
        'service-desc': [
          {
            href: `${origin}/.well-known/openapi.json`,
            type: 'application/json',
          },
        ],
        'service-doc': [
          {
            href: `${origin}/starter-guide.html`,
            type: 'text/html',
          },
          {
            href: `${origin}/llms.txt`,
            type: 'text/plain',
          },
          {
            href: `${origin}/auth.md`,
            type: 'text/markdown',
          },
          {
            href: `${origin}/.well-known/mcp/server-card.json`,
            type: 'application/json',
          },
          {
            href: `${origin}/.well-known/agent-skills/index.json`,
            type: 'application/json',
          },
          {
            href: `${origin}/.well-known/x402`,
            type: 'application/json',
          },
        ],
        status: [
          {
            href: `${origin}/health`,
            type: 'application/json',
          },
        ],
        'service-meta': [
          {
            href: `${origin}/.well-known/design-catalog.json`,
            type: 'application/json',
          },
          {
            href: `${origin}/.well-known/oauth-authorization-server`,
            type: 'application/json',
          },
          {
            href: `${origin}/.well-known/oauth-protected-resource`,
            type: 'application/json',
          },
        ],
      },
    ],
  };
}

export function handleApiCatalog(req: Request, res: Response): void {
  const linkset = buildApiCatalogLinkset(requestBaseUrl(req));

  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Content-Type', `application/linkset+json; profile="${RFC9727_PROFILE}"`);
  res.status(200).json(linkset);
}
