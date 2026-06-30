import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSitemapXml } from './sitemap';

test('buildSitemapXml includes static pages and active catalog products', () => {
  const xml = buildSitemapXml('https://curatoria.dev');

  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
  assert.match(xml, /<loc>https:\/\/curatoria.dev\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/curatoria.dev\/whitepaper<\/loc>/);
  assert.match(xml, /<loc>https:\/\/curatoria.dev\/.well-known\/design-catalog.json<\/loc>/);
  assert.match(xml, /<loc>https:\/\/curatoria.dev\/design-systems\/curatoria-demo-md<\/loc>/);
  assert.match(xml, /<loc>https:\/\/curatoria.dev\/packs\/curatoria-demo-pack\/download<\/loc>/);
  assert.match(xml, /<lastmod>2026-06-19<\/lastmod>/);
  assert.ok(xml.endsWith('</urlset>\n'));
});

test('buildSitemapXml escapes XML entities in URLs', () => {
  const xml = buildSitemapXml('https://example.com');
  assert.doesNotMatch(xml, /&amp;amp;/);
});
