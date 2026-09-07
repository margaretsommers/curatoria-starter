import { Request, Response } from 'express';
import { sendPublicHtml } from './markdown-negotiation';
import { resolvePublicPath } from './paths';

const HOMEPAGE_PATH = resolvePublicPath('index.html');

/**
 * RFC 8288 Link header values for the site homepage (RFC 9727 Section 3).
 * Targets are URI references relative to the homepage origin.
 */
export function buildHomepageLinkHeader(): string {
  return [
    '</.well-known/api-catalog>; rel="api-catalog"',
    '</.well-known/x402>; rel="payment-service"; type="application/json"',
    '</llms.txt>; rel="service-desc"',
    '</starter-guide.html>; rel="service-doc"',
    '</llms.txt>; rel="describedby"',
  ].join(', ');
}

export function handleHomepage(req: Request, res: Response): void {
  res.setHeader('Link', buildHomepageLinkHeader());
  sendPublicHtml(req, res, HOMEPAGE_PATH);
}
