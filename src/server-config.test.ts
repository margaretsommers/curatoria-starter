import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePublicOrigin } from './server';

test('explicit PUBLIC_BASE_URL remains authoritative in production', () => {
  assert.equal(
    resolvePublicOrigin({
      NODE_ENV: 'production',
      VERCEL_ENV: 'preview',
      PUBLIC_BASE_URL: 'https://curatoria.dev/',
      VERCEL_URL: 'ignored-preview.vercel.app',
    }),
    'https://curatoria.dev',
  );
});

test('Vercel Preview derives an HTTPS origin from a valid VERCEL_URL hostname', () => {
  assert.equal(
    resolvePublicOrigin({
      NODE_ENV: 'production',
      VERCEL_ENV: 'preview',
      VERCEL_URL: 'curatoria-AbC123.vercel.app',
    }),
    'https://curatoria-abc123.vercel.app',
  );
});

test('Vercel Preview rejects a malformed platform URL', () => {
  assert.throws(
    () =>
      resolvePublicOrigin({
        NODE_ENV: 'production',
        VERCEL_ENV: 'preview',
        VERCEL_URL: 'curatoria-preview.vercel.app/path',
      }),
    /valid VERCEL_URL hostname ending in \.vercel\.app/,
  );
});

test('production fails clearly when no canonical URL source exists', () => {
  assert.throws(
    () => resolvePublicOrigin({ NODE_ENV: 'production' }),
    /PUBLIC_BASE_URL is required in production outside Vercel Preview/,
  );
});
