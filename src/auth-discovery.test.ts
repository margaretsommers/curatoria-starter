import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAgentAuthBlock,
  buildAuthMd,
  buildAuthMethodsDocument,
  buildOAuthAuthorizationServerMetadata,
  buildOAuthProtectedResourceMetadata,
  buildWwwAuthenticateResourceMetadata,
} from './auth-discovery';

test('buildOAuthAuthorizationServerMetadata includes RFC 8414 discovery fields', () => {
  const metadata = buildOAuthAuthorizationServerMetadata('https://curatoria.dev', {
    facilitatorUrl: 'https://x402.org/facilitator',
    network: 'base',
  });

  assert.equal(metadata.issuer, 'https://curatoria.dev');
  assert.equal(metadata.authorization_endpoint, 'https://curatoria.dev/.well-known/auth');
  assert.equal(metadata.token_endpoint, 'https://curatoria.dev/.well-known/auth/token');
  assert.equal(metadata.jwks_uri, 'https://curatoria.dev/.well-known/jwks.json');
  assert.deepEqual(metadata.grant_types_supported, ['client_credentials']);
  assert.ok(metadata.response_types_supported.length > 0);
  assert.equal(metadata.x_curatoria_buyer_authentication.mechanism, 'x402');
  assert.equal(metadata.agent_auth.skill, 'https://curatoria.dev/auth.md');
  assert.equal(metadata.agent_auth.register_uri, 'https://curatoria.dev/.well-known/agent/register');
  assert.deepEqual(metadata.agent_auth.identity_types_supported, ['anonymous']);
});

test('buildAuthMethodsDocument describes buyer x402 and admin api-key flows', () => {
  const document = buildAuthMethodsDocument('https://curatoria.dev', {
    facilitatorUrl: 'https://x402.org/facilitator',
    network: 'base',
  });

  assert.equal(document.buyer.catalog_url, 'https://curatoria.dev/.well-known/design-catalog.json');
  assert.equal(document.admin.header, 'X-Admin-Key');
});

test('buildOAuthProtectedResourceMetadata includes RFC 9728 discovery fields', () => {
  const metadata = buildOAuthProtectedResourceMetadata('https://curatoria.dev', {
    facilitatorUrl: 'https://x402.org/facilitator',
    network: 'base',
  });

  assert.equal(metadata.resource, 'https://curatoria.dev/');
  assert.deepEqual(metadata.authorization_servers, ['https://curatoria.dev']);
  assert.deepEqual(metadata.scopes_supported, ['admin:publish']);
});

test('buildWwwAuthenticateResourceMetadata points to protected resource metadata', () => {
  assert.equal(
    buildWwwAuthenticateResourceMetadata('https://curatoria.dev'),
    'Bearer resource_metadata="https://curatoria.dev/.well-known/oauth-protected-resource"',
  );
});

test('buildAuthMd includes auth.md heading and discovery links', () => {
  const markdown = buildAuthMd('https://curatoria.dev', {
    facilitatorUrl: 'https://x402.org/facilitator',
    network: 'base',
  });

  assert.match(markdown, /^# Curatoria auth\.md/m);
  assert.match(markdown, /oauth-protected-resource/);
  assert.match(markdown, /x402_payment_signature/);
});

test('buildAgentAuthBlock advertises anonymous x402 registration', () => {
  const block = buildAgentAuthBlock('https://curatoria.dev');

  assert.equal(block.claim_uri, 'https://curatoria.dev/.well-known/agent/claim');
  assert.equal(block.revocation_uri, 'https://curatoria.dev/.well-known/agent/revoke');
  assert.deepEqual(block.anonymous.credential_types_supported, ['x402_payment_signature']);
});
