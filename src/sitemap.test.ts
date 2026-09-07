import test from 'node:test';
import assert from 'node:assert/strict';

import { listActive } from './catalog';
import { productAccessPath } from './discovery';
import { buildSitemapXml } from './sitemap';
import type { DesignSystemEntry } from './types';

test('productAccessPath uses purchase URLs for binary_asset catalog fixtures', () => {
  const markdown: Pick<DesignSystemEntry, 'id' | 'resource_type'> = {
    id: 'curatoria-demo-md',
    resource_type: 'design_md',
  };
  const bundle: Pick<DesignSystemEntry, 'id' | 'resource_type'> = {
    id: 'curatoria-demo-pack',
    resource_type: 'bundle_zip',
  };
  const binary: Pick<DesignSystemEntry, 'id' | 'resource_type'> = {
    id: 'curatoria-psd-drive',
    resource_type: 'binary_asset',
  };

  assert.equal(productAccessPath(markdown), '/design-systems/curatoria-demo-md');
  assert.equal(productAccessPath(bundle), '/packs/curatoria-demo-pack/download');
  assert.equal(productAccessPath(binary), '/assets/curatoria-psd-drive/purchase');
  assert.equal(productAccessPath({ id: 'legacy-md' }), '/design-systems/legacy-md');
});

test('buildSitemapXml includes static pages and active catalog products', () => {
  const xml = buildSitemapXml('https://curatoria.dev');

  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
  assert.match(xml, /<loc>https:\/\/curatoria.dev\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/curatoria.dev\/(?:starter-guide\.html|docs\.html)<\/loc>/);
  assert.match(xml, /<loc>https:\/\/curatoria.dev\/.well-known\/design-catalog.json<\/loc>/);
  assert.match(xml, /<loc>https:\/\/curatoria.dev\/design-systems\/curatoria-demo-md<\/loc>/);
  assert.match(xml, /<loc>https:\/\/curatoria.dev\/packs\/curatoria-demo-pack\/download<\/loc>/);
  assert.match(xml, /<lastmod>2026-06-\d{2}<\/lastmod>/);
  assert.ok(xml.endsWith('</urlset>\n'));

  for (const entry of listActive()) {
    const loc = `https://curatoria.dev${productAccessPath(entry)}`;
    assert.match(xml, new RegExp(`<loc>${loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/loc>`));
    if (entry.resource_type === 'binary_asset') {
      assert.match(xml, new RegExp(`/assets/${entry.id}/purchase`));
      assert.doesNotMatch(xml, new RegExp(`/design-systems/${entry.id}<`));
    }
  }
});

test('buildSitemapXml escapes XML entities in URLs', () => {
  const xml = buildSitemapXml('https://example.com');
  assert.doesNotMatch(xml, /&amp;amp;/);
});
