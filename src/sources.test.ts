import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSource,
  parseDropboxShareUrl,
  resolveResource,
  resetDropboxTokenCacheForTests,
  rewriteDropboxShareUrl,
  storageStatus,
} from './sources';

test('parseDropboxShareUrl accepts allow-listed Dropbox hosts', () => {
  const standard = parseDropboxShareUrl('https://www.dropbox.com/s/abc123/my-doc.md?dl=0');
  const direct = parseDropboxShareUrl('https://dl.dropboxusercontent.com/s/abc123/my-doc.md');

  assert.equal(standard.hostname, 'www.dropbox.com');
  assert.equal(direct.hostname, 'dl.dropboxusercontent.com');
});

test('parseDropboxShareUrl rejects non-Dropbox hosts', () => {
  assert.throws(
    () => parseDropboxShareUrl('https://example.com/s/abc123/my-doc.md?dl=0'),
    /Unexpected Dropbox host/,
  );
});

test('rewriteDropboxShareUrl forces dl=1 for share links', () => {
  const rewritten = new URL(
    rewriteDropboxShareUrl('https://www.dropbox.com/s/abc123/my-doc.md?dl=0'),
  );
  assert.equal(rewritten.hostname, 'www.dropbox.com');
  assert.equal(rewritten.searchParams.get('dl'), '1');

  const unchangedDirect = new URL(
    rewriteDropboxShareUrl('https://dl.dropboxusercontent.com/s/abc123/my-doc.md'),
  );
  assert.equal(unchangedDirect.hostname, 'dl.dropboxusercontent.com');
});

test('resolveResource fetches Dropbox share-link bytes directly', async () => {
  const prevFetch = globalThis.fetch;
  try {
    let fetchUrl = '';
    globalThis.fetch = (async (input: string | URL) => {
      fetchUrl = String(input);
      return new Response('dropbox-bytes', {
        status: 200,
        headers: { 'content-type': 'text/markdown' },
      });
    }) as typeof fetch;

    const resolved = await resolveResource({
      id: 'dropbox-doc',
      file: 'my-doc.md',
      name: 'Dropbox Doc',
      description: '',
      price_usd: '0.05',
      tags: [],
      published_at: new Date().toISOString(),
      active: true,
      source: {
        type: 'dropbox',
        share_url: 'https://www.dropbox.com/s/abc123/my-doc.md?dl=0',
      },
    });

    const fetched = new URL(fetchUrl);
    assert.equal(fetched.hostname, 'www.dropbox.com');
    assert.equal(fetched.searchParams.get('dl'), '1');
    assert.equal(resolved.buffer.toString(), 'dropbox-bytes');
    assert.equal(resolved.mimeType, 'text/markdown');
    assert.equal(resolved.sourceType, 'dropbox');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('resolveResource rejects direct URL HTML responses before delivery', async () => {
  const prevFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response('<!doctype html><title>Preview</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })) as typeof fetch;

    await assert.rejects(
      () =>
        resolveResource({
          id: 'url-doc',
          file: 'url-doc.md',
          name: 'URL Doc',
          description: '',
          price_usd: '0.05',
          tags: [],
          published_at: new Date().toISOString(),
          active: true,
          source: { type: 'url', url: 'https://files.example.com/url-doc.md' },
        }),
      /returned an HTML page, not the file bytes/,
    );
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('resolveResource rejects Google Drive HTML for markdown sources', async () => {
  const prevFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response('<html><body>Google Drive interstitial</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as typeof fetch;

    await assert.rejects(
      () =>
        resolveResource({
          id: 'drive-doc',
          file: 'drive-doc.md',
          name: 'Drive Doc',
          description: '',
          price_usd: '0.05',
          tags: [],
          published_at: new Date().toISOString(),
          active: true,
          source: { type: 'gdrive', file_id: 'abc123' },
        }),
      /returned an HTML page, not the file bytes/,
    );
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('resolveResource rejects encoded remote responses because raw bytes are not verifiable', async () => {
  const prevFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response('encoded-bytes', {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-encoding': 'gzip',
        },
      })) as typeof fetch;

    await assert.rejects(
      () =>
        resolveResource({
          id: 'encoded-zip',
          file: 'encoded-zip.zip',
          bundle_file: 'encoded-zip.zip',
          resource_type: 'bundle_zip',
          mime_type: 'application/zip',
          name: 'Encoded Zip',
          description: '',
          price_usd: '0.05',
          tags: [],
          published_at: new Date().toISOString(),
          active: true,
          source: { type: 'url', url: 'https://files.example.com/encoded-zip.zip' },
        }),
      /original bytes cannot be verified/,
    );
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('resolveResource rejects local files outside design-systems', async () => {
  await assert.rejects(
    () =>
      resolveResource({
        id: 'escape',
        file: '../package.json',
        name: 'Escape',
        description: '',
        price_usd: '0.05',
        tags: [],
        published_at: new Date().toISOString(),
        active: true,
      }),
    /escapes design-systems/,
  );
});

test('buildSource stores Dropbox share URL and enforces exclusivity', () => {
  const built = buildSource({
    id: 'dropbox-doc',
    dropboxUrl: 'https://www.dropbox.com/s/abc123/my-doc.md?dl=0',
    kind: 'design_md',
  });

  assert.equal(built.file, 'my-doc.md');
  assert.deepEqual(built.source, {
    type: 'dropbox',
    share_url: 'https://www.dropbox.com/s/abc123/my-doc.md?dl=0',
  });

  assert.throws(
    () =>
      buildSource({
        id: 'bad',
        dropboxUrl: 'https://www.dropbox.com/s/abc123/my-doc.md?dl=0',
        url: 'https://files.example.com/my-doc.md',
        kind: 'design_md',
      }),
    /Provide only one source/,
  );
});

test('buildSource supports dropbox-path and enforces exclusivity with other flags', () => {
  const built = buildSource({
    id: 'dropbox-private-doc',
    dropboxPath: '/Design Systems/private-doc.md',
    kind: 'design_md',
  });

  assert.equal(built.file, 'private-doc.md');
  assert.deepEqual(built.source, {
    type: 'dropbox',
    dropbox_path: '/Design Systems/private-doc.md',
  });

  assert.throws(
    () =>
      buildSource({
        id: 'bad',
        dropboxPath: '/Design Systems/private-doc.md',
        dropboxUrl: 'https://www.dropbox.com/s/abc123/my-doc.md?dl=0',
        kind: 'design_md',
      }),
    /Provide only one source/,
  );
});

test('buildSource rejects invalid dropbox-path values', () => {
  assert.throws(
    () =>
      buildSource({
        id: 'bad-path',
        dropboxPath: 'Design Systems/private-doc.md',
        kind: 'design_md',
      }),
    /must start with "\/"/,
  );
});

test('storageStatus reports Dropbox oauth enabled when creds exist', () => {
  const prev = {
    appKey: process.env.DROPBOX_APP_KEY,
    appSecret: process.env.DROPBOX_APP_SECRET,
    refreshToken: process.env.DROPBOX_REFRESH_TOKEN,
  };
  try {
    process.env.DROPBOX_APP_KEY = 'key';
    process.env.DROPBOX_APP_SECRET = 'secret';
    process.env.DROPBOX_REFRESH_TOKEN = 'refresh';
    assert.equal(storageStatus().dropbox.oauth, true);

    process.env.DROPBOX_APP_KEY = '';
    process.env.DROPBOX_APP_SECRET = '';
    process.env.DROPBOX_REFRESH_TOKEN = '';
    assert.equal(storageStatus().dropbox.oauth, false);
  } finally {
    process.env.DROPBOX_APP_KEY = prev.appKey;
    process.env.DROPBOX_APP_SECRET = prev.appSecret;
    process.env.DROPBOX_REFRESH_TOKEN = prev.refreshToken;
  }
});

test('resolveResource refreshes Dropbox token once and reuses cached token', async () => {
  const prevFetch = globalThis.fetch;
  const prev = {
    appKey: process.env.DROPBOX_APP_KEY,
    appSecret: process.env.DROPBOX_APP_SECRET,
    refreshToken: process.env.DROPBOX_REFRESH_TOKEN,
  };

  try {
    process.env.DROPBOX_APP_KEY = 'key';
    process.env.DROPBOX_APP_SECRET = 'secret';
    process.env.DROPBOX_REFRESH_TOKEN = 'refresh';
    resetDropboxTokenCacheForTests();

    let tokenCalls = 0;
    let downloadCalls = 0;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/oauth2/token')) {
        tokenCalls += 1;
        return new Response(
          JSON.stringify({ access_token: 'access-token', expires_in: 14400 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url.includes('/2/files/download')) {
        downloadCalls += 1;
        return new Response('private-bytes', {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }

      throw new Error(`Unexpected fetch URL in test: ${url}`);
    }) as typeof fetch;

    const entry = {
      id: 'private-dropbox',
      file: 'private-doc.md',
      name: 'Private Dropbox Doc',
      description: '',
      price_usd: '0.05',
      tags: [],
      published_at: new Date().toISOString(),
      active: true,
      source: { type: 'dropbox' as const, dropbox_path: '/Design Systems/private-doc.md' },
    };

    const first = await resolveResource(entry);
    const second = await resolveResource(entry);

    assert.equal(first.buffer.toString(), 'private-bytes');
    assert.equal(second.buffer.toString(), 'private-bytes');
    assert.equal(tokenCalls, 1);
    assert.equal(downloadCalls, 2);
  } finally {
    globalThis.fetch = prevFetch;
    process.env.DROPBOX_APP_KEY = prev.appKey;
    process.env.DROPBOX_APP_SECRET = prev.appSecret;
    process.env.DROPBOX_REFRESH_TOKEN = prev.refreshToken;
    resetDropboxTokenCacheForTests();
  }
});
