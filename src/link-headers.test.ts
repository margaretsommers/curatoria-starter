import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHomepageLinkHeader } from './link-headers';

test('buildHomepageLinkHeader advertises agent discovery resources', () => {
  const header = buildHomepageLinkHeader();

  assert.match(header, /<\/.well-known\/api-catalog>; rel="api-catalog"/);
  assert.match(header, /<\/.well-known\/design-catalog\.json>; rel="catalog"/);
  assert.match(header, /<\/.well-known\/x402>; rel="payment-service"/);
});
