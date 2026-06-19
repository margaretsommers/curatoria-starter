import { Request, Response } from 'express';
import { readCatalog, listActive } from './catalog';
import { CatalogEntry, CatalogResponse, CatalogTeaserResponse } from './types';

/**
 * GET /.well-known/design-catalog.json  (also aliased to GET /design-systems, GET /catalog)
 *
 * Track A (default): free full catalog — owner, design_systems[] with metadata and access_url.
 * Track B (CATALOG_PAYWALL_ENABLED=1): use handleTeaserDiscovery on well-known instead.
 */
export function handleFullCatalogDiscovery(req: Request, res: Response): void {
  const response = buildFullCatalogResponse(req);
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(response);
}

/**
 * GET /.well-known/design-catalog.json — Track B teaser only.
 * Owner, product count, pointer to paid /catalog. No product list.
 */
export function handleTeaserDiscovery(req: Request, res: Response): void {
  const response = buildTeaserResponse(req);
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(response);
}

/**
 * GET /catalog — full metadata listing after x402 settlement (Track B paid route).
 */
export function handleFullCatalog(req: Request, res: Response): void {
  const response = buildFullCatalogResponse(req);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(response);
}

export function buildTeaserResponse(req: Request): CatalogTeaserResponse {
  const catalog = readCatalog();
  const baseUrl = requestBaseUrl(req);

  return {
    owner: catalog.owner,
    total: listActive().length,
    paid_catalog_url: `${baseUrl}/catalog`,
    payment_required: true,
  };
}

export function buildFullCatalogResponse(req: Request): CatalogResponse {
  const catalog = readCatalog();
  const baseUrl = requestBaseUrl(req);

  const entries: CatalogEntry[] = listActive().map(({ file: _file, source: _source, ...rest }) => {
    const resourceType = rest.resource_type ?? 'design_md';
    const isBundle = resourceType === 'bundle_zip';
    const accessUrl = isBundle
      ? `${baseUrl}/packs/${rest.id}/download`
      : `${baseUrl}/design-systems/${rest.id}`;

    return {
      ...rest,
      resource_type: resourceType,
      mime_type: rest.mime_type ?? (isBundle ? 'application/zip' : 'text/markdown'),
      access_url: accessUrl,
      download_url: isBundle ? accessUrl : undefined,
      payment_required: true,
    };
  });

  return {
    owner: catalog.owner,
    total: entries.length,
    base_url: baseUrl,
    design_systems: entries,
  };
}

export function requestBaseUrl(req: Request): string {
  const configured = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  if (configured) return configured;

  const host = req.get('host') ?? 'localhost';
  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol = forwardedProto || req.protocol;
  return `${protocol}://${host}`;
}

/** @deprecated Use handleFullCatalogDiscovery (Track A) or handleTeaserDiscovery (Track B) */
export const handleDiscovery = handleFullCatalogDiscovery;
