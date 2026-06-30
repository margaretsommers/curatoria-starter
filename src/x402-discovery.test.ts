import test from 'node:test';
import assert from 'node:assert/strict';

import { buildX402DiscoveryDocument, normalizeX402Network } from './x402-discovery';

test('buildX402DiscoveryDocument lists active paid resources', () => {
  const doc = buildX402DiscoveryDocument('https://curatoria.dev', {
    facilitatorUrl: 'https://x402.org/facilitator',
    network: 'base',
    walletAddress: '0x8aa327403ED786cA56EB8F59C6c8831A8BD73485',
  });

  assert.equal(doc.protocol, 'x402');
  assert.equal(doc.x402Version, 2);
  assert.equal(doc.network, 'eip155:8453');
  assert.ok(doc.resources.some(url => url.includes('/design-systems/curatoria-demo-md')));
  assert.ok(doc.resources.some(url => url.includes('/packs/curatoria-demo-pack/download')));
  assert.deepEqual(doc.ownershipProofs, ['0x8aa327403ED786cA56EB8F59C6c8831A8BD73485']);
  assert.equal(doc.openapi, 'https://curatoria.dev/.well-known/openapi.json');
});

test('normalizeX402Network maps short network names to CAIP-2 ids', () => {
  assert.equal(normalizeX402Network('base-sepolia'), 'eip155:84532');
});
