import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { Readable } from 'node:stream';

import {
  buildSource,
  headersAfterRedirect,
  parseDropboxShareUrl,
  parseGoogleDriveId,
  resolveResource,
  resolveResourceStream,
  resetDropboxTokenCacheForTests,
  rewriteDropboxShareUrl,
  storageStatus,
} from './sources';

function binaryEntry() {
  return {
    id: 'streamed-asset',
    file: 'streamed.psd',
    resource_type: 'binary_asset' as const,
    mime_type: 'image/vnd.adobe.photoshop',
    name: 'Streamed Asset',
    description: '',
    price_usd: '0.01',
    tags: [],
    published_at: new Date().toISOString(),
    active: false,
    source: { type: 'url' as const, url: 'https://files.example.com/streamed.psd' },
  };
}

const publicLookup = (async () => [
  { address: '8.8.8.8', family: 4 as const },
]);

function resolveMocked(
  entry: Parameters<typeof resolveResource>[0],
  maxBytes?: number,
) {
  return resolveResource(entry, { lookup: publicLookup, maxBytes });
}

function headerRecord(init?: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

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

test('parseDropboxShareUrl rejects Dropbox Transfer /t/ URLs without fetching', () => {
  const transferUrls = [
    'https://www.dropbox.com/t/AbCdEfGhIjKlMnOp',
    'https://www.dropbox.com/t/AbCdEfGhIjKlMnOp?dl=0',
    'https://www.dropbox.com/T/AbCdEfGhIjKlMnOp',
  ];

  for (const url of transferUrls) {
    assert.throws(
      () => parseDropboxShareUrl(url),
      error => {
        assert.match(String(error), /Transfer links \(\/t\/\) are not supported[\s\S]*share link \(\/scl\/fi\/ or \/s\/\)/);
        assert.doesNotMatch(String(error), /AbCdEfGhIjKlMnOp|dropbox\.com/);
        return true;
      },
    );
    assert.throws(
      () => rewriteDropboxShareUrl(url),
      /Use a Dropbox share link/,
    );
  }
});

test('parseDropboxShareUrl rejects Dropbox folder /scl/fo/ URLs without fetching or echoing the input', () => {
  const folderUrls = [
    'https://www.dropbox.com/scl/fo/FolderSecretId123/shared-folder',
    'https://www.dropbox.com/scl/fo/FolderSecretId123/shared-folder?rlkey=xyz&dl=0',
    'https://www.dropbox.com/SCL/FO/FolderSecretId123/shared-folder',
    'https://dl.dropboxusercontent.com/scl/fo/FolderSecretId123/shared-folder',
    'https://www.dropbox.com/scl/fo',
  ];

  for (const url of folderUrls) {
    assert.throws(
      () => parseDropboxShareUrl(url),
      error => {
        assert.match(
          String(error),
          /folder links \(\/scl\/fo\/\) are not supported[\s\S]*file share link \(\/scl\/fi\/ or \/s\/\)/,
        );
        assert.doesNotMatch(String(error), /FolderSecretId123|dropbox\.com|rlkey|shared-folder/);
        return true;
      },
    );
    assert.throws(
      () => rewriteDropboxShareUrl(url),
      /Use a Dropbox file share link/,
    );
  }
});

test('parseDropboxShareUrl rejects classic Dropbox folder /sh/ URLs without fetching or echoing the input', () => {
  const folderUrls = [
    'https://www.dropbox.com/sh/FolderSecretId123/shared-folder',
    'https://www.dropbox.com/sh/FolderSecretId123/shared-folder?dl=0',
    'https://www.dropbox.com/SH/FolderSecretId123/shared-folder',
    'https://dl.dropboxusercontent.com/sh/FolderSecretId123/shared-folder',
    'https://www.dropbox.com/sh',
  ];

  for (const url of folderUrls) {
    assert.throws(
      () => parseDropboxShareUrl(url),
      error => {
        assert.match(
          String(error),
          /folder links \(\/sh\/\) are not supported[\s\S]*file share link \(\/scl\/fi\/ or \/s\/\)/,
        );
        assert.doesNotMatch(String(error), /FolderSecretId123|dropbox\.com|shared-folder/);
        return true;
      },
    );
    assert.throws(
      () => rewriteDropboxShareUrl(url),
      /Use a Dropbox file share link/,
    );
  }
});

test('parseDropboxShareUrl rejects Dropbox Paper URLs without fetching or echoing the input', () => {
  const paperUrls = [
    'https://paper.dropbox.com/doc/PaperSecretId123',
    'https://paper.dropbox.com/doc/PaperSecretId123?dl=0',
    'https://www.dropbox.com/paper/doc/PaperSecretId123',
    'https://www.dropbox.com/paper/doc/PaperSecretId123?rlkey=xyz',
    'https://www.dropbox.com/PAPER/doc/PaperSecretId123',
    'https://www.dropbox.com/paper',
  ];

  for (const url of paperUrls) {
    assert.throws(
      () => parseDropboxShareUrl(url),
      error => {
        assert.match(
          String(error),
          /Paper links are not supported[\s\S]*file share link \(\/scl\/fi\/ or \/s\/\)/,
        );
        assert.doesNotMatch(String(error), /PaperSecretId123|dropbox\.com|rlkey/);
        return true;
      },
    );
    assert.throws(
      () => rewriteDropboxShareUrl(url),
      /not Paper/,
    );
  }
});

test('parseDropboxShareUrl rejects unknown Dropbox /scl/ paths without fetching or echoing the input', () => {
  const unknownSclUrls = [
    'https://www.dropbox.com/scl/xx/UnknownSecretId123/mystery',
    'https://www.dropbox.com/scl/xx/UnknownSecretId123/mystery?rlkey=xyz&dl=0',
    'https://www.dropbox.com/SCL/XX/UnknownSecretId123/mystery',
    'https://dl.dropboxusercontent.com/scl/xx/UnknownSecretId123/mystery',
    'https://www.dropbox.com/scl',
  ];

  for (const url of unknownSclUrls) {
    assert.throws(
      () => parseDropboxShareUrl(url),
      error => {
        assert.match(
          String(error),
          /\/scl\/ path are not supported[\s\S]*file share link \(\/scl\/fi\/ or \/s\/\)/,
        );
        assert.doesNotMatch(String(error), /UnknownSecretId123|dropbox\.com|rlkey|mystery/);
        return true;
      },
    );
    assert.throws(
      () => rewriteDropboxShareUrl(url),
      /Use a Dropbox file share link/,
    );
  }
});

test('parseDropboxShareUrl rejects URLs with userinfo without fetching or echoing credentials', () => {
  const credentialUrls = [
    'https://SecretUser:SecretPass@www.dropbox.com/s/abc123/my-doc.md?dl=0',
    'https://SecretUser@www.dropbox.com/s/abc123/my-doc.md',
    'https://:SecretPass@www.dropbox.com/scl/fi/abc123/layout.psd?rlkey=xyz',
    'https://SecretUser:SecretPass@dl.dropboxusercontent.com/s/abc123/my-doc.md',
    'https://SecretUser%40mail:Secret%2FPass@www.dropbox.com/s/abc123/my-doc.md',
  ];

  for (const url of credentialUrls) {
    assert.throws(
      () => parseDropboxShareUrl(url),
      error => {
        assert.match(
          String(error),
          /cannot contain credentials[\s\S]*file share link \(\/scl\/fi\/ or \/s\/\)/,
        );
        assert.doesNotMatch(
          String(error),
          /SecretUser|SecretPass|SecretUser@mail|Secret\/Pass|%40mail|%2FPass|dropbox\.com|abc123|rlkey/,
        );
        return true;
      },
    );
    assert.throws(
      () => rewriteDropboxShareUrl(url),
      /cannot contain credentials/,
    );
  }
});

test('parseDropboxShareUrl and rewriteDropboxShareUrl still accept share-link shapes', () => {
  const share = parseDropboxShareUrl('https://www.dropbox.com/s/abc123/my-doc.md?dl=0');
  const scl = parseDropboxShareUrl(
    'https://www.dropbox.com/scl/fi/abc123/layout.psd?rlkey=xyz&dl=0',
  );
  const direct = parseDropboxShareUrl('https://dl.dropboxusercontent.com/s/abc123/my-doc.md');

  assert.equal(share.pathname, '/s/abc123/my-doc.md');
  assert.equal(scl.pathname, '/scl/fi/abc123/layout.psd');
  assert.equal(direct.hostname, 'dl.dropboxusercontent.com');

  const rewrittenShare = new URL(
    rewriteDropboxShareUrl('https://www.dropbox.com/s/abc123/my-doc.md?dl=0'),
  );
  const rewrittenScl = new URL(
    rewriteDropboxShareUrl('https://www.dropbox.com/scl/fi/abc123/layout.psd?rlkey=xyz&dl=0'),
  );
  assert.equal(rewrittenShare.searchParams.get('dl'), '1');
  assert.equal(rewrittenScl.searchParams.get('dl'), '1');
  assert.equal(rewrittenScl.searchParams.get('rlkey'), 'xyz');
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

    const resolved = await resolveMocked({
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
        resolveMocked({
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
        resolveMocked({
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
        resolveMocked({
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

test('resolveResource enforces the byte ceiling while streaming', async () => {
  const prevFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.enqueue(new Uint8Array([4, 5, 6]));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'application/octet-stream' } },
      )) as typeof fetch;

    await assert.rejects(
      () =>
        resolveMocked(
          {
            id: 'oversized',
            file: 'oversized.bin',
            resource_type: 'binary_asset',
            name: 'Oversized',
            description: '',
            price_usd: '0.01',
            tags: [],
            published_at: new Date().toISOString(),
            active: true,
            source: { type: 'url', url: 'https://files.example.com/oversized.bin' },
          },
          4,
        ),
      /exceeded the 4-byte limit while streaming/,
    );
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('resolveResourceStream consumes a 75 MB provider response in 64 KB chunks', async () => {
  const chunkBytes = 64 * 1024;
  const totalBytes = 75 * 1024 * 1024;
  let arrayBufferCalled = false;
  let emitted = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(chunkBytes));
        emitted += chunkBytes;
        if (emitted >= totalBytes) controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(totalBytes),
      },
    },
  );
  Object.defineProperty(response, 'arrayBuffer', {
    value: async () => {
      arrayBufferCalled = true;
      throw new Error('whole-file buffering is forbidden');
    },
  });

  const resolved = await resolveResourceStream(binaryEntry(), {
    lookup: publicLookup,
    maxBytes: 80 * 1024 * 1024,
    requestImpl: async () => response,
  });
  let consumed = 0;
  let largestChunk = 0;
  for await (const value of resolved.stream) {
    const chunk = Buffer.from(value);
    consumed += chunk.byteLength;
    largestChunk = Math.max(largestChunk, chunk.byteLength);
  }
  assert.equal(consumed, totalBytes);
  assert.equal(largestChunk, chunkBytes);
  assert.equal(arrayBufferCalled, false);
});

test('resolveResourceStream rejects limits, truncation, and HTML at the prefix boundary', async () => {
  const consume = async (response: Response, maxBytes = 1024): Promise<void> => {
    const resolved = await resolveResourceStream(binaryEntry(), {
      lookup: publicLookup,
      maxBytes,
      requestImpl: async () => response,
    });
    for await (const _chunk of resolved.stream) {
      // Consume to force streaming validation.
    }
  };

  await assert.rejects(
    () => consume(new Response(Buffer.alloc(5), { headers: { 'content-length': '5' } }), 4),
    /over the 4-byte limit/,
  );
  await assert.rejects(
    () => consume(new Response(Buffer.alloc(4), { headers: { 'content-length': '8' } })),
    /ended after 4 bytes; expected 8 bytes/,
  );
  await assert.rejects(
    () =>
      consume(
        new Response(`${' '.repeat(500)}<!doctype html><title>Preview</title>`, {
          headers: { 'content-type': 'application/octet-stream' },
        }),
      ),
    /returned an HTML page/,
  );
});

test('resolveResourceStream destroys the provider body when consumption fails', async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  const resolved = await resolveResourceStream(binaryEntry(), {
    lookup: publicLookup,
    maxBytes: 4,
    requestImpl: async () => response,
  });
  await assert.rejects(async () => {
    for await (const _chunk of resolved.stream) {
      // Consume until the limiter destroys the source.
    }
  }, /exceeded the 4-byte limit/);
  assert.equal(cancelled, true);
});

test('resolveResource rejects private DNS answers before fetching', async () => {
  let fetched = false;
  await assert.rejects(
    () =>
      resolveResource(
        {
          id: 'private-dns',
          file: 'private.bin',
          resource_type: 'binary_asset',
          name: 'Private DNS',
          description: '',
          price_usd: '0.01',
          tags: [],
          published_at: new Date().toISOString(),
          active: true,
          source: { type: 'url', url: 'https://files.example.com/private.bin' },
        },
        {
          fetchImpl: (async () => {
            fetched = true;
            throw new Error('must not fetch');
          }) as typeof fetch,
          lookup: (async () => [
            { address: '127.0.0.1', family: 4 as const },
          ]),
        },
      ),
    /resolved to a non-public address/,
  );
  assert.equal(fetched, false);
});

test('resolveResource rejects IANA special-purpose IPv4, IPv6, mapped, and translation answers', async () => {
  const blocked = [
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.31.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '::',
    '::1',
    '::192.168.1.1',
    '::ffff:127.0.0.1',
    '::ffff:0:192.168.1.1',
    '64:ff9b::10.0.0.1',
    '64:ff9b:1::1',
    '100::1',
    '2001::1',
    '2001:2::1',
    '2001:db8::1',
    '2002::1',
    '3ffe::1',
    '3fff::1',
    '5f00::1',
    'fc00::1',
    'fe80::1',
    'ff00::1',
  ];
  for (const address of blocked) {
    let requested = false;
    await assert.rejects(
      () =>
        resolveResource(binaryEntry(), {
          lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
          requestImpl: async () => {
            requested = true;
            return new Response('must not fetch');
          },
        }),
      /resolved to a non-public address/,
      address,
    );
    assert.equal(requested, false, address);
  }
});

test('resolveResource permits documented globally reachable special-purpose exceptions', async () => {
  for (const address of [
    '192.0.0.9',
    '192.0.0.10',
    '192.88.99.2',
    '2001:1::1',
    '2001:3::1',
    '2001:4:112::1',
  ]) {
    const resolved = await resolveResource(binaryEntry(), {
      lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
      requestImpl: async () =>
        new Response('global', {
          headers: { 'content-type': 'application/octet-stream' },
        }),
    });
    assert.equal(resolved.buffer.toString(), 'global');
  }
});

test('resolveResource pins the validated address for the connection', async () => {
  let lookupCalls = 0;
  const connections: Array<{ hostname: string; address: string; family: number }> = [];
  const resolved = await resolveResource(
    {
      id: 'pinned-dns',
      file: 'asset.bin',
      resource_type: 'binary_asset',
      name: 'Pinned DNS',
      description: '',
      price_usd: '0.01',
      tags: [],
      published_at: new Date().toISOString(),
      active: true,
      source: { type: 'url', url: 'https://files.example.com/asset.bin' },
    },
    {
      lookup: async () => {
        lookupCalls += 1;
        return lookupCalls === 1
          ? [{ address: '8.8.8.8', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }];
      },
      requestImpl: async (url, init, binding) => {
        connections.push(binding);
        assert.equal(String(url), 'https://files.example.com/asset.bin');
        assert.equal(init.redirect, 'manual');
        return new Response('safe-bytes', {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      },
    },
  );

  assert.equal(resolved.buffer.toString(), 'safe-bytes');
  assert.equal(lookupCalls, 1, 'the connection must not perform a second DNS lookup');
  assert.deepEqual(connections, [
    { hostname: 'files.example.com', address: '8.8.8.8', family: 4 },
  ]);
});

test('resolveResource returns a pinned address array when HTTPS lookup requests all addresses', async () => {
  const originalRequest = https.request;
  try {
    https.request = ((
      url: URL,
      options: https.RequestOptions,
      onResponse: (response: Readable) => void,
    ) => {
      const request = new EventEmitter() as EventEmitter & {
        end: () => void;
        destroy: (error: Error) => void;
      };
      request.end = () => {
        assert.equal(url.hostname, 'files.example.com');
        assert.equal(options.servername, 'files.example.com');
        assert.ok(options.lookup);
        options.lookup(url.hostname, { all: false }, (error, address, family) => {
          assert.ifError(error);
          assert.equal(address, '8.8.8.8');
          assert.equal(family, 4);
        });
        options.lookup(url.hostname, { all: true }, (error, addresses) => {
          if (error) {
            request.emit('error', error);
            return;
          }
          if (!Array.isArray(addresses)) {
            const invalidAddress = Object.assign(
              new TypeError(`Invalid IP address: ${String(addresses)}`),
              { code: 'ERR_INVALID_IP_ADDRESS' },
            );
            request.emit('error', invalidAddress);
            return;
          }
          assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
          onResponse(Object.assign(Readable.from(['pinned-bytes']), {
            rawHeaders: ['content-type', 'application/octet-stream'],
            statusCode: 200,
            statusMessage: 'OK',
          }));
        });
      };
      request.destroy = error => request.emit('error', error);
      return request;
    }) as unknown as typeof https.request;

    const resolved = await resolveResource(
      {
        id: 'all-addresses',
        file: 'asset.bin',
        resource_type: 'binary_asset',
        name: 'All Addresses',
        description: '',
        price_usd: '0.01',
        tags: [],
        published_at: new Date().toISOString(),
        active: true,
        source: { type: 'url', url: 'https://files.example.com/asset.bin' },
      },
      {
        lookup: publicLookup,
      },
    );

    assert.equal(resolved.buffer.toString(), 'pinned-bytes');
  } finally {
    https.request = originalRequest;
  }
});

test('headersAfterRedirect strips Authorization and Cookie only when the origin changes', () => {
  const secrets = {
    Authorization: 'Bearer hop-secret',
    Cookie: 'session=hop-cookie',
    'Proxy-Authorization': 'Basic cHJveHk6c2VjcmV0',
    Accept: 'application/octet-stream',
  };

  const sameOrigin = headersAfterRedirect(
    'https://files.example.com/asset.bin',
    'https://files.example.com:443/cdn/asset.bin',
    secrets,
  );
  assert.equal(sameOrigin.get('Authorization'), 'Bearer hop-secret');
  assert.equal(sameOrigin.get('Cookie'), 'session=hop-cookie');
  assert.equal(sameOrigin.get('Proxy-Authorization'), 'Basic cHJveHk6c2VjcmV0');
  assert.equal(sameOrigin.get('Accept'), 'application/octet-stream');

  const crossOrigin = headersAfterRedirect(
    'https://files.example.com/asset.bin',
    'https://cdn.example.com/asset.bin',
    secrets,
  );
  assert.equal(crossOrigin.get('Authorization'), null);
  assert.equal(crossOrigin.get('Cookie'), null);
  assert.equal(crossOrigin.get('Cookie2'), null);
  assert.equal(crossOrigin.get('Proxy-Authorization'), null);
  assert.equal(crossOrigin.get('Accept'), 'application/octet-stream');
});

test('resolveResource revalidates and repins every redirect hop', async () => {
  const bindings: Array<{ hostname: string; address: string; family: number }> = [];
  const answers: Record<string, string> = {
    'files.example.com': '8.8.8.8',
    'cdn.example.com': '1.1.1.1',
  };
  await resolveResource(
    {
      id: 'redirect-pins',
      file: 'asset.bin',
      resource_type: 'binary_asset',
      name: 'Redirect Pins',
      description: '',
      price_usd: '0.01',
      tags: [],
      published_at: new Date().toISOString(),
      active: true,
      source: { type: 'url', url: 'https://files.example.com/asset.bin' },
    },
    {
      lookup: async hostname => [{ address: answers[hostname], family: 4 }],
      requestImpl: async (url, _init, binding) => {
        bindings.push(binding);
        return String(url).includes('files.example.com')
          ? new Response(null, {
              status: 302,
              headers: { location: 'https://cdn.example.com/asset.bin' },
            })
          : new Response('redirected-bytes', {
              status: 200,
              headers: { 'content-type': 'application/octet-stream' },
            });
      },
    },
  );
  assert.deepEqual(bindings, [
    { hostname: 'files.example.com', address: '8.8.8.8', family: 4 },
    { hostname: 'cdn.example.com', address: '1.1.1.1', family: 4 },
  ]);
});

test('resolveResource does not forward Authorization or Cookie across origins', async () => {
  const hops: Array<{ url: string; headers: Record<string, string> }> = [];
  const answers: Record<string, string> = {
    'files.example.com': '8.8.8.8',
    'cdn.example.com': '1.1.1.1',
  };
  const resolved = await resolveResource(
    {
      id: 'redirect-secrets',
      file: 'asset.bin',
      resource_type: 'binary_asset',
      name: 'Redirect Secrets',
      description: '',
      price_usd: '0.01',
      tags: [],
      published_at: new Date().toISOString(),
      active: true,
      source: { type: 'url', url: 'https://files.example.com/asset.bin' },
    },
    {
      headers: {
        Authorization: 'Bearer hop-secret',
        Cookie: 'session=hop-cookie',
        'Proxy-Authorization': 'Basic cHJveHk6c2VjcmV0',
      },
      lookup: async hostname => [{ address: answers[hostname], family: 4 }],
      requestImpl: async (url, init) => {
        hops.push({ url: String(url), headers: headerRecord(init) });
        return String(url).includes('files.example.com')
          ? new Response(null, {
              status: 302,
              headers: { location: 'https://cdn.example.com/asset.bin' },
            })
          : new Response('redirected-bytes', {
              status: 200,
              headers: { 'content-type': 'application/octet-stream' },
            });
      },
    },
  );

  assert.equal(resolved.buffer.toString(), 'redirected-bytes');
  assert.equal(hops.length, 2);
  assert.equal(hops[0].headers.authorization, 'Bearer hop-secret');
  assert.equal(hops[0].headers.cookie, 'session=hop-cookie');
  assert.equal(hops[0].headers['proxy-authorization'], 'Basic cHJveHk6c2VjcmV0');
  assert.equal(hops[1].headers.authorization, undefined);
  assert.equal(hops[1].headers.cookie, undefined);
  assert.equal(hops[1].headers['proxy-authorization'], undefined);
  assert.equal(hops[1].headers.accept, 'application/octet-stream,*/*;q=0.8');
});

test('resolveResource keeps Authorization and Cookie on same-origin redirects', async () => {
  const hops: Array<{ url: string; headers: Record<string, string> }> = [];
  const resolved = await resolveResource(
    {
      id: 'same-origin-secrets',
      file: 'asset.bin',
      resource_type: 'binary_asset',
      name: 'Same Origin Secrets',
      description: '',
      price_usd: '0.01',
      tags: [],
      published_at: new Date().toISOString(),
      active: true,
      source: { type: 'url', url: 'https://files.example.com/asset.bin' },
    },
    {
      headers: {
        Authorization: 'Bearer hop-secret',
        Cookie: 'session=hop-cookie',
      },
      lookup: publicLookup,
      requestImpl: async (url, init) => {
        hops.push({ url: String(url), headers: headerRecord(init) });
        return String(url).includes('/cdn/')
          ? new Response('same-origin-bytes', {
              status: 200,
              headers: { 'content-type': 'application/octet-stream' },
            })
          : new Response(null, {
              status: 302,
              headers: { location: 'https://files.example.com/cdn/asset.bin' },
            });
      },
    },
  );

  assert.equal(resolved.buffer.toString(), 'same-origin-bytes');
  assert.equal(hops.length, 2);
  assert.equal(hops[1].url, 'https://files.example.com/cdn/asset.bin');
  assert.equal(hops[1].headers.authorization, 'Bearer hop-secret');
  assert.equal(hops[1].headers.cookie, 'session=hop-cookie');
});

test('resolveResourceStream does not forward Authorization or Cookie across origins', async () => {
  const hops: Array<{ url: string; headers: Record<string, string> }> = [];
  const answers: Record<string, string> = {
    'files.example.com': '8.8.8.8',
    'cdn.example.com': '1.1.1.1',
  };
  const resolved = await resolveResourceStream(binaryEntry(), {
    headers: {
      Authorization: 'Bearer hop-secret',
      Cookie: 'session=hop-cookie',
    },
    lookup: async hostname => [{ address: answers[hostname], family: 4 }],
    requestImpl: async (url, init) => {
      hops.push({ url: String(url), headers: headerRecord(init) });
      return String(url).includes('files.example.com')
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://cdn.example.com/streamed.psd' },
          })
        : new Response('streamed-bytes', {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          });
    },
  });

  const chunks: Buffer[] = [];
  for await (const value of resolved.stream) {
    chunks.push(Buffer.from(value));
  }
  assert.equal(Buffer.concat(chunks).toString(), 'streamed-bytes');
  assert.equal(hops[0].headers.authorization, 'Bearer hop-secret');
  assert.equal(hops[0].headers.cookie, 'session=hop-cookie');
  assert.equal(hops[1].headers.authorization, undefined);
  assert.equal(hops[1].headers.cookie, undefined);
});

test('resolveResource follows redirects manually and rejects Dropbox host escapes', async () => {
  const prevFetch = globalThis.fetch;
  const requests: Array<{ url: string; redirect?: string }> = [];
  try {
    globalThis.fetch = (async (url, init) => {
      requests.push({ url: String(url), redirect: init?.redirect });
      if (String(url).includes('dropbox.com')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/stolen.psd' },
        });
      }
      throw new Error('redirect target must be rejected before fetch');
    }) as typeof fetch;

    await assert.rejects(
      () =>
        resolveMocked({
          id: 'dropbox-redirect',
          file: 'layout.psd',
          resource_type: 'design_md',
          mime_type: 'image/vnd.adobe.photoshop',
          name: 'Layout',
          description: '',
          price_usd: '0.01',
          tags: [],
          published_at: new Date().toISOString(),
          active: true,
          source: {
            type: 'dropbox',
            share_url: 'https://www.dropbox.com/scl/fi/example/layout.psd?dl=0',
          },
        }),
      /redirected to an unexpected host/,
    );
    assert.deepEqual(requests, [
      {
        url: 'https://www.dropbox.com/scl/fi/example/layout.psd?dl=1',
        redirect: 'manual',
      },
    ]);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('resolveResource accepts Dropbox\'s real per-file randomized dl.dropboxusercontent.com subdomain', async () => {
  // Observed 2026-09-04 against a real Dropbox share link: Dropbox's own
  // redirect lands on a per-file randomized subdomain of
  // dl.dropboxusercontent.com, not the bare host.
  const prevFetch = globalThis.fetch;
  const requests: Array<{ url: string; redirect?: string }> = [];
  try {
    globalThis.fetch = (async (url, init) => {
      requests.push({ url: String(url), redirect: init?.redirect });
      if (String(url).includes('dropbox.com')) {
        return new Response(null, {
          status: 302,
          headers: {
            location:
              'https://ucb8fd170dee70a30b19134b7f54.dl.dropboxusercontent.com/cd/0/inline/example/file',
          },
        });
      }
      return new Response('real-dropbox-bytes', {
        status: 200,
        headers: { 'content-type': 'image/vnd.adobe.photoshop' },
      });
    }) as typeof fetch;

    const resolved = await resolveMocked({
      id: 'dropbox-real-redirect',
      file: 'layout.psd',
      resource_type: 'design_md',
      mime_type: 'image/vnd.adobe.photoshop',
      name: 'Layout',
      description: '',
      price_usd: '0.01',
      tags: [],
      published_at: new Date().toISOString(),
      active: true,
      source: {
        type: 'dropbox',
        share_url: 'https://www.dropbox.com/scl/fi/example/layout.psd?dl=0',
      },
    });

    assert.equal(resolved.buffer.toString(), 'real-dropbox-bytes');
    assert.equal(requests.length, 2);
    assert.match(
      new URL(requests[1].url).hostname,
      /^ucb8fd170dee70a30b19134b7f54\.dl\.dropboxusercontent\.com$/,
    );
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('resolveResource still rejects an attacker domain that merely contains the Dropbox host as a prefix', async () => {
  const prevFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url) => {
      if (String(url).includes('dropbox.com')) {
        return new Response(null, {
          status: 302,
          // Contains "dl.dropboxusercontent.com" but as a prefix of an
          // attacker-owned domain, not a suffix -- must still be rejected.
          headers: { location: 'https://dl.dropboxusercontent.com.attacker.example/file' },
        });
      }
      throw new Error('redirect target must be rejected before fetch');
    }) as typeof fetch;

    await assert.rejects(
      () =>
        resolveMocked({
          id: 'dropbox-suffix-attack',
          file: 'layout.psd',
          resource_type: 'design_md',
          mime_type: 'image/vnd.adobe.photoshop',
          name: 'Layout',
          description: '',
          price_usd: '0.01',
          tags: [],
          published_at: new Date().toISOString(),
          active: true,
          source: {
            type: 'dropbox',
            share_url: 'https://www.dropbox.com/scl/fi/example/layout.psd?dl=0',
          },
        }),
      /redirected to an unexpected host/,
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

test('parseGoogleDriveId accepts file share links, download URLs, and raw IDs', () => {
  assert.equal(
    parseGoogleDriveId('https://drive.google.com/file/d/safe_file_id/view?usp=sharing'),
    'safe_file_id',
  );
  assert.equal(parseGoogleDriveId('https://drive.google.com/open?id=safe_file_id'), 'safe_file_id');
  assert.equal(
    parseGoogleDriveId('https://drive.google.com/uc?id=safe_file_id&export=download'),
    'safe_file_id',
  );
  assert.equal(
    parseGoogleDriveId('https://docs.google.com/uc?id=safe_file_id&export=download'),
    'safe_file_id',
  );
  assert.equal(parseGoogleDriveId('safe_file_id'), 'safe_file_id');
});

test('parseGoogleDriveId rejects folder and Workspace URLs without fetching or echoing the input', () => {
  const folderUrls = [
    'https://drive.google.com/drive/folders/FolderSecretId123',
    'https://drive.google.com/drive/u/0/folders/FolderSecretId123?usp=sharing',
    'https://drive.google.com/drive/folders/FolderSecretId123',
  ];
  const workspaceUrls = [
    'https://docs.google.com/document/d/DocSecretId123/edit',
    'https://docs.google.com/spreadsheets/d/SheetSecretId123/edit',
    'https://docs.google.com/presentation/d/SlideSecretId123/edit',
  ];

  for (const url of folderUrls) {
    assert.throws(
      () => parseGoogleDriveId(url),
      error => {
        assert.match(String(error), /folder links are not supported[\s\S]*file share link \(\/file\/d\/ or open\?id=\)/);
        assert.doesNotMatch(String(error), /FolderSecretId123|drive\.google\.com/);
        return true;
      },
    );
  }

  for (const url of workspaceUrls) {
    assert.throws(
      () => parseGoogleDriveId(url),
      error => {
        assert.match(String(error), /Docs, Sheets, Slides, Forms, and Drawings/);
        assert.doesNotMatch(String(error), /DocSecretId123|SheetSecretId123|SlideSecretId123|docs\.google\.com/);
        return true;
      },
    );
  }

  assert.throws(
    () => parseGoogleDriveId('https://example.com/file/d/safe_file_id/view'),
    /Unexpected Google Drive host/,
  );
  assert.throws(
    () => parseGoogleDriveId('http://drive.google.com/file/d/safe_file_id/view'),
    /https:\/\//,
  );
});

test('parseGoogleDriveId rejects URLs with userinfo without fetching or echoing credentials', () => {
  const credentialUrls = [
    'https://SecretUser:SecretPass@drive.google.com/file/d/safe_file_id/view?usp=sharing',
    'https://SecretUser@drive.google.com/open?id=safe_file_id',
    'https://:SecretPass@drive.google.com/uc?id=safe_file_id&export=download',
    'https://SecretUser:SecretPass@docs.google.com/uc?id=safe_file_id&export=download',
    'https://SecretUser%40mail:Secret%2FPass@drive.usercontent.google.com/download?id=safe_file_id',
  ];

  for (const url of credentialUrls) {
    assert.throws(
      () => parseGoogleDriveId(url),
      error => {
        assert.match(
          String(error),
          /cannot contain credentials[\s\S]*file share link \(\/file\/d\/ or open\?id=\)/,
        );
        assert.doesNotMatch(
          String(error),
          /SecretUser|SecretPass|SecretUser@mail|Secret\/Pass|%40mail|%2FPass|drive\.google\.com|docs\.google\.com|safe_file_id/,
        );
        return true;
      },
    );
  }
});

test('buildSource rejects Google Drive folder URLs at intake', () => {
  assert.throws(
    () =>
      buildSource({
        id: 'folder-doc',
        gdriveId: 'https://drive.google.com/drive/folders/FolderSecretId123',
        kind: 'design_md',
      }),
    error => {
      assert.match(String(error), /folder links are not supported/);
      assert.doesNotMatch(String(error), /FolderSecretId123/);
      return true;
    },
  );
});

test('buildSource stores a Drive file ID from a file share link', () => {
  const built = buildSource({
    id: 'drive-doc',
    gdriveId: 'https://drive.google.com/file/d/safe_file_id/view?usp=sharing',
    kind: 'design_md',
  });
  assert.equal(built.file, 'drive-doc.md');
  assert.deepEqual(built.source, { type: 'gdrive', file_id: 'safe_file_id' });
});

test('buildSource rejects Dropbox Transfer URLs at intake', () => {
  assert.throws(
    () =>
      buildSource({
        id: 'transfer-doc',
        dropboxUrl: 'https://www.dropbox.com/t/AbCdEfGhIjKlMnOp',
        kind: 'design_md',
      }),
    /Use a Dropbox share link \(\/scl\/fi\/ or \/s\/\), not Transfer/,
  );
});

test('buildSource rejects Dropbox folder URLs at intake without echoing them', () => {
  assert.throws(
    () =>
      buildSource({
        id: 'folder-doc',
        dropboxUrl: 'https://www.dropbox.com/scl/fo/FolderSecretId123/shared-folder?rlkey=xyz',
        kind: 'design_md',
      }),
    error => {
      assert.match(String(error), /folder links \(\/scl\/fo\/\) are not supported/);
      assert.doesNotMatch(String(error), /FolderSecretId123|rlkey/);
      return true;
    },
  );
});

test('buildSource rejects classic Dropbox folder /sh/ URLs at intake without echoing them', () => {
  assert.throws(
    () =>
      buildSource({
        id: 'folder-doc',
        dropboxUrl: 'https://www.dropbox.com/sh/FolderSecretId123/shared-folder?dl=0',
        kind: 'design_md',
      }),
    error => {
      assert.match(String(error), /folder links \(\/sh\/\) are not supported/);
      assert.doesNotMatch(String(error), /FolderSecretId123|shared-folder/);
      return true;
    },
  );
});

test('buildSource rejects Dropbox Paper URLs at intake without echoing them', () => {
  assert.throws(
    () =>
      buildSource({
        id: 'paper-doc',
        dropboxUrl: 'https://paper.dropbox.com/doc/PaperSecretId123',
        kind: 'design_md',
      }),
    error => {
      assert.match(String(error), /Paper links are not supported/);
      assert.doesNotMatch(String(error), /PaperSecretId123|paper\.dropbox\.com/);
      return true;
    },
  );
});

test('buildSource rejects unknown Dropbox /scl/ URLs at intake without echoing them', () => {
  assert.throws(
    () =>
      buildSource({
        id: 'unknown-doc',
        dropboxUrl: 'https://www.dropbox.com/scl/xx/UnknownSecretId123/mystery?rlkey=xyz',
        kind: 'design_md',
      }),
    error => {
      assert.match(String(error), /\/scl\/ path are not supported/);
      assert.doesNotMatch(String(error), /UnknownSecretId123|rlkey/);
      return true;
    },
  );
});

test('buildSource rejects Dropbox URLs with userinfo at intake without echoing them', () => {
  assert.throws(
    () =>
      buildSource({
        id: 'cred-doc',
        dropboxUrl: 'https://SecretUser:SecretPass@www.dropbox.com/s/abc123/my-doc.md?dl=0',
        kind: 'design_md',
      }),
    error => {
      assert.match(String(error), /cannot contain credentials/);
      assert.doesNotMatch(String(error), /SecretUser|SecretPass|abc123/);
      return true;
    },
  );
});

test('buildSource rejects Google Drive URLs with userinfo at intake without echoing them', () => {
  assert.throws(
    () =>
      buildSource({
        id: 'cred-doc',
        gdriveId: 'https://SecretUser:SecretPass@drive.google.com/file/d/safe_file_id/view',
        kind: 'design_md',
      }),
    error => {
      assert.match(String(error), /cannot contain credentials/);
      assert.doesNotMatch(String(error), /SecretUser|SecretPass|safe_file_id/);
      return true;
    },
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

    const first = await resolveMocked(entry);
    const second = await resolveMocked(entry);

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
