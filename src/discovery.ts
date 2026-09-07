import { Request, Response } from 'express';
import { readCatalog } from './catalog';
import {
  CatalogEntry,
  CatalogResponse,
  CatalogTeaserResponse,
  DesignCatalog,
  DesignSystemEntry,
} from './types';

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

export function createFullCatalogDiscoveryHandler(
  read: () => DesignCatalog = readCatalog,
): (req: Request, res: Response) => void {
  return (req, res) => {
    const response = buildFullCatalogResponse(req, read());
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(response);
  };
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

export function createTeaserDiscoveryHandler(
  read: () => DesignCatalog = readCatalog,
): (req: Request, res: Response) => void {
  return (req, res) => {
    const response = buildTeaserResponse(req, read());
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(response);
  };
}

/**
 * GET /catalog — full metadata listing after x402 settlement (Track B paid route).
 */
export function handleFullCatalog(req: Request, res: Response): void {
  const response = buildFullCatalogResponse(req);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(response);
}

export function createFullCatalogHandler(
  read: () => DesignCatalog = readCatalog,
): (req: Request, res: Response) => void {
  return (req, res) => {
    const response = buildFullCatalogResponse(req, read());
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(response);
  };
}

export function buildTeaserResponse(
  req: Request,
  catalog: DesignCatalog = readCatalog(),
): CatalogTeaserResponse {
  const baseUrl = requestBaseUrl(req);

  return {
    owner: catalog.owner,
    total: catalog.design_systems.filter(entry => entry.active).length,
    paid_catalog_url: `${baseUrl}/catalog`,
    payment_required: true,
  };
}

export function buildFullCatalogResponse(
  req: Request,
  catalog: DesignCatalog = readCatalog(),
): CatalogResponse {
  const baseUrl = requestBaseUrl(req);

  const entries: CatalogEntry[] = catalog.design_systems
    .filter(entry => entry.active)
    .map(entry => buildCatalogEntry(entry, baseUrl));

  return {
    owner: catalog.owner,
    total: entries.length,
    base_url: baseUrl,
    design_systems: entries,
  };
}

/** Paid access path used by discovery, x402 discovery, and the sitemap. */
export function productAccessPath(entry: Pick<DesignSystemEntry, 'id' | 'resource_type'>): string {
  const resourceType = entry.resource_type ?? 'design_md';
  if (resourceType === 'binary_asset') return `/assets/${entry.id}/purchase`;
  if (resourceType === 'bundle_zip') return `/packs/${entry.id}/download`;
  return `/design-systems/${entry.id}`;
}

export function buildCatalogEntry(entry: DesignSystemEntry, baseUrl: string): CatalogEntry {
  const { file: _file, source: _source, blob_path: _blobPath, ...rest } = entry;
  const resourceType = rest.resource_type ?? 'design_md';
  const isBundle = resourceType === 'bundle_zip';
  const accessUrl = `${baseUrl}${productAccessPath(entry)}`;

  return {
    ...rest,
    resource_type: resourceType,
    mime_type:
      rest.mime_type ??
      (resourceType === 'binary_asset'
        ? 'application/octet-stream'
        : isBundle
          ? 'application/zip'
          : 'text/markdown'),
    access_url: accessUrl,
    download_url: isBundle ? accessUrl : undefined,
    download_filename: resourceType === 'binary_asset' ? entry.file : undefined,
    payment_required: true,
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
