import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHomepageLinkHeader } from './link-headers';

test('buildHomepageLinkHeader advertises agent discovery resources', () => {
  const header = buildHomepageLinkHeader();

  assert.match(header, /<\/.well-known\/api-catalog>; rel="api-catalog"/);
  assert.match(header, /<\/llms\.txt>; rel="service-desc"/);
  assert.match(header, /<\/starter-guide\.html>; rel="service-doc"/);
  assert.match(header, /<\/llms\.txt>; rel="describedby"/);
});
