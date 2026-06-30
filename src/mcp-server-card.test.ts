import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMcpServerCard } from './mcp-server-card';

test('buildMcpServerCard includes SEP-1649 discovery fields', () => {
  const card = buildMcpServerCard('https://curatoria.dev');

  assert.equal(card.serverInfo.name, 'curatoria');
  assert.equal(card.serverInfo.version, '1.0.0');
  assert.equal(card.transport.type, 'streamable-http');
  assert.equal(card.transport.endpoint, '/mcp');
  assert.equal(card.capabilities.tools.listChanged, true);
  assert.equal(card.capabilities.resources.listChanged, true);
  assert.equal(card.authentication.resource_metadata, 'https://curatoria.dev/.well-known/oauth-protected-resource');
});
