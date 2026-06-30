import test from 'node:test';
import assert from 'node:assert/strict';

import { buildApiCatalogLinkset } from './api-catalog';
import { buildOpenApiDocument } from './openapi-spec';

test('buildApiCatalogLinkset includes RFC 9727 link relations', () => {
  const catalog = buildApiCatalogLinkset('https://curatoria.dev');
  const entry = catalog.linkset[0];

  assert.equal(entry.anchor, 'https://curatoria.dev/');
  assert.equal(entry['service-desc']?.[0]?.href, 'https://curatoria.dev/.well-known/openapi.json');
  assert.equal(entry['service-doc']?.[0]?.href, 'https://curatoria.dev/starter-guide.html');
  assert.equal(entry.status?.[0]?.href, 'https://curatoria.dev/health');
});

test('buildOpenApiDocument describes core discovery and paid routes', () => {
  const spec = buildOpenApiDocument('https://curatoria.dev') as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
    'x-discovery'?: { x402?: string };
    'x402'?: { discovery?: string };
  };

  assert.ok(spec.paths['/.well-known/design-catalog.json']);
  assert.ok(spec.paths['/design-systems/{id}']);
  assert.ok(spec.paths['/health']);
  assert.equal(spec['x-discovery']?.x402, 'https://curatoria.dev/.well-known/x402');
  assert.equal(spec['x402']?.discovery, 'https://curatoria.dev/.well-known/x402');
  assert.deepEqual(
    (spec.paths['/design-systems/{id}'].get['x-payment-info'] as { protocols: string[] }).protocols,
    ['x402'],
  );
});
