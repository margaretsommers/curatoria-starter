import fs from 'fs';
import { Request, Response } from 'express';
import { listActive, readCatalog } from './catalog';
import { requestBaseUrl } from './discovery';
import { SITEMAP_PATH } from './paths';
import { DesignSystemEntry } from './types';

export const SITEMAP_OUTPUT_PATH = SITEMAP_PATH;

const STATIC_PAGES: Array<{ path: string; priority?: string }> = [
  { path: '/', priority: '1.0' },
  { path: '/auth.md', priority: '0.7' },
  { path: '/.well-known/agent-skills/index.json', priority: '0.7' },
  { path: '/.well-known/x402', priority: '0.8' },
  { path: '/.well-known/design-catalog.json', priority: '0.9' },
  { path: '/catalog', priority: '0.8' },
];

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function productAccessPath(entry: DesignSystemEntry): string {
  const isBundle = (entry.resource_type ?? 'design_md') === 'bundle_zip';
  return isBundle ? `/packs/${entry.id}/download` : `/design-systems/${entry.id}`;
}

function formatLastmod(iso?: string): string | undefined {
  if (!iso) return undefined;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10);
}

export function resolvePublicBaseUrl(req?: Request): string {
  if (req) return requestBaseUrl(req);

  const configured = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  if (configured) return configured;

  const ownerUrl = readCatalog().owner.url?.replace(/\/$/, '');
  if (ownerUrl) return ownerUrl;

  return 'https://curatoria.dev';
}

export function buildSitemapXml(baseUrl: string): string {
  const origin = baseUrl.replace(/\/$/, '');
  const urls: Array<{ loc: string; lastmod?: string; priority?: string }> = [];

  for (const page of STATIC_PAGES) {
    urls.push({
      loc: page.path === '/' ? `${origin}/` : `${origin}${page.path}`,
      priority: page.priority,
    });
  }

  for (const entry of listActive()) {
    urls.push({
      loc: `${origin}${productAccessPath(entry)}`,
      lastmod: formatLastmod(entry.published_at),
      priority: '0.6',
    });
  }

  const body = urls
    .map(url => {
      const lines = [`    <loc>${escapeXml(url.loc)}</loc>`];
      if (url.lastmod) lines.push(`    <lastmod>${url.lastmod}</lastmod>`);
      if (url.priority) lines.push(`    <priority>${url.priority}</priority>`);
      return `  <url>\n${lines.join('\n')}\n  </url>`;
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    body,
    '</urlset>',
    '',
  ].join('\n');
}

export function writeSitemapFile(baseUrl?: string): void {
  const xml = buildSitemapXml(baseUrl ?? resolvePublicBaseUrl());
  fs.writeFileSync(SITEMAP_OUTPUT_PATH, xml, 'utf-8');
}

export function handleSitemap(req: Request, res: Response): void {
  const xml = buildSitemapXml(requestBaseUrl(req));
  res
    .setHeader('Content-Type', 'application/xml; charset=utf-8')
    .setHeader('Cache-Control', 'public, max-age=300')
    .status(200)
    .send(xml);
}
