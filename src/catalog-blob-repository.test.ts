import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { createBlobCatalogRepository, type MutableJsonBlobWriter } from './catalog-blob-repository';
import type { BlobSdkAdapter } from './blob-storage';
import type { DesignCatalog, DesignSystemEntry } from './types';

const REGISTRY_PATHNAME = 'registry/v1/catalog.json';

function catalog(entries: DesignSystemEntry[] = []): DesignCatalog {
  return {
    owner: { wallet: '0x8aa327403ed786ca56eb8f59c6c8831a8bd73485', name: 'Curatoria' },
    design_systems: entries,
  };
}

function entry(overrides: Partial<DesignSystemEntry> = {}): DesignSystemEntry {
  return {
    id: 'example',
    file: 'example.md',
    name: 'Example',
    description: '',
    price_usd: '0.01',
    tags: [],
    published_at: '2026-09-06T00:00:00.000Z',
    active: true,
    ...overrides,
  };
}

function mockSdk(initial?: DesignCatalog): {
  sdk: BlobSdkAdapter;
  writeMutableJson: MutableJsonBlobWriter;
  writes: DesignCatalog[];
  currentStored(): DesignCatalog | undefined;
} {
  let stored = initial ? Buffer.from(JSON.stringify(initial)) : undefined;
  const writes: DesignCatalog[] = [];
  const sdk: BlobSdkAdapter = {
    async put() {
      throw new Error('not used');
    },
    async head() {
      throw new Error('not used');
    },
    async read(pathname) {
      if (pathname !== REGISTRY_PATHNAME || !stored) {
        throw Object.assign(new Error('not found'), { statusCode: 404, code: 'BLOB_NOT_FOUND' });
      }
      return {
        body: Readable.from([stored]),
        pathname,
        size: stored.byteLength,
        contentType: 'application/json',
        etag: 'etag',
      };
    },
    async issueSignedToken() {
      throw new Error('not used');
    },
    async presignUrl() {
      throw new Error('not used');
    },
  };
  const writeMutableJson: MutableJsonBlobWriter = async (pathname, body) => {
    assert.equal(pathname, REGISTRY_PATHNAME);
    stored = Buffer.from(body);
    writes.push(JSON.parse(Buffer.from(body).toString('utf8')));
  };
  return { sdk, writeMutableJson, writes, currentStored: () => (stored ? JSON.parse(stored.toString('utf8')) : undefined) };
}

test('initialize seeds an empty catalog when no registry blob exists yet', async () => {
  const { sdk, writeMutableJson } = mockSdk();
  const repo = createBlobCatalogRepository(sdk, writeMutableJson);
  await repo.initialize();
  assert.deepEqual(repo.readCatalog().design_systems, []);
  assert.equal(repo.findEntry('anything'), null);
});

test('initialize loads an existing registry blob and readCatalog/findEntry serve from it', async () => {
  const seeded = catalog([entry({ id: 'curatoria-demo-md' })]);
  const { sdk, writeMutableJson } = mockSdk(seeded);
  const repo = createBlobCatalogRepository(sdk, writeMutableJson);
  await repo.initialize();
  assert.deepEqual(repo.readCatalog(), seeded);
  assert.equal(repo.findEntry('curatoria-demo-md')?.id, 'curatoria-demo-md');
  assert.equal(repo.findEntry('missing'), null);
});

test('findEntry hides inactive entries, matching the filesystem catalog contract', async () => {
  const seeded = catalog([entry({ id: 'inactive-one', active: false })]);
  const { sdk, writeMutableJson } = mockSdk(seeded);
  const repo = createBlobCatalogRepository(sdk, writeMutableJson);
  await repo.initialize();
  assert.equal(repo.findEntry('inactive-one'), null);
});

test('readCatalog throws a clear error if called before initialize', async () => {
  const { sdk, writeMutableJson } = mockSdk();
  const repo = createBlobCatalogRepository(sdk, writeMutableJson);
  assert.throws(() => repo.readCatalog(), /before initialize\(\) completed/);
});

test('appendEntry writes the new entry to Blob and updates the in-memory cache immediately', async () => {
  const { sdk, writeMutableJson, writes } = mockSdk(catalog());
  const repo = createBlobCatalogRepository(sdk, writeMutableJson);
  await repo.initialize();

  await repo.appendEntry(entry({ id: 'new-one' }));

  assert.equal(repo.findEntry('new-one')?.id, 'new-one');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].design_systems.length, 1);
});

test('appendEntry is idempotent for an identical re-publish of the same id', async () => {
  const existing = entry({ id: 'stable' });
  const { sdk, writeMutableJson, writes } = mockSdk(catalog([existing]));
  const repo = createBlobCatalogRepository(sdk, writeMutableJson);
  await repo.initialize();

  await repo.appendEntry({ ...existing });

  assert.equal(writes.length, 0, 'identical republish must not write a new document');
  assert.equal(repo.readCatalog().design_systems.length, 1);
});

test('appendEntry rejects a conflicting republish of the same id with different content', async () => {
  const existing = entry({ id: 'stable', price_usd: '0.01' });
  const { sdk, writeMutableJson, writes } = mockSdk(catalog([existing]));
  const repo = createBlobCatalogRepository(sdk, writeMutableJson);
  await repo.initialize();

  await assert.rejects(
    () => repo.appendEntry({ ...existing, price_usd: '0.02' }),
    /already published/,
  );
  assert.equal(writes.length, 0);
});

test('appendEntry rejects unsafe filenames the same way the filesystem catalog does', async () => {
  const { sdk, writeMutableJson } = mockSdk(catalog());
  const repo = createBlobCatalogRepository(sdk, writeMutableJson);
  await repo.initialize();

  await assert.rejects(
    () => repo.appendEntry(entry({ id: 'bad', file: '../escape.md' })),
    /unsafe/i,
  );
});

test('a stale cache is served immediately while a background refresh runs, and refreshed content appears afterward', async () => {
  const { sdk, writeMutableJson, currentStored } = mockSdk(catalog([entry({ id: 'first' })]));
  const repo = createBlobCatalogRepository(sdk, writeMutableJson, { refreshTtlMs: 0 });
  await repo.initialize();

  // Simulate another warm instance publishing, bypassing this instance's cache.
  await writeMutableJson('registry/v1/catalog.json', Buffer.from(JSON.stringify(catalog([
    entry({ id: 'first' }),
    entry({ id: 'second' }),
  ]))));
  assert.equal(currentStored()?.design_systems.length, 2);

  const immediate = repo.readCatalog();
  assert.equal(immediate.design_systems.length, 1, 'stale-while-revalidate serves the old cache on this call');

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(repo.findEntry('second')?.id, 'second', 'background refresh eventually picks up the other instance\'s write');
});

test('appendEntry surfaces the underlying error when the registry write fails', async () => {
  const { sdk } = mockSdk(catalog());
  const failingWriter: MutableJsonBlobWriter = async () => {
    throw new Error('blob write failed');
  };
  const repo = createBlobCatalogRepository(sdk, failingWriter);
  await repo.initialize();

  await assert.rejects(() => repo.appendEntry(entry({ id: 'x' })), /blob write failed/);
  assert.equal(repo.findEntry('x'), null, 'a failed write must not appear to have succeeded');
});
