import { Request, Response } from 'express';
import { readCatalog, listActive } from './catalog';
import { CatalogResponse, CatalogEntry } from './types';

/**
 * GET /.well-known/design-catalog.json  (also aliased to GET /design-systems)
 *
 * Free endpoint — no payment required. Returns machine-readable metadata for
 * every active design system: name, price, tags, and the URL to access it.
 * The actual .md content is NOT included; agents must pay to retrieve it.
 *
 * Follows the .well-known URI convention (RFC 5785) so agent frameworks and
 * crawlers know where to look, similar to how robots.txt or llms.txt work.
 *
 * Cache-Control is set to 60 seconds so discovery responses are cheap to serve
 * at scale but still refresh quickly after you publish a new design system.
 */
export function handleDiscovery(req: Request, res: Response): void {
  const catalog = readCatalog();
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  const entries: CatalogEntry[] = listActive().map(({ file: _file, ...rest }) => {
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

  const response: CatalogResponse = {
    owner: catalog.owner,
    total: entries.length,
    base_url: baseUrl,
    design_systems: entries,
  };

  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(response);
}
