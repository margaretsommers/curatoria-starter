import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { importBinaryAsset, type AssetImportDependencies } from './asset-import';
import type { DesignSystemEntry } from './types';

const PSD_BYTES = Buffer.from([0x38, 0x42, 0x50, 0x53, 0x00, 0x01]);
const PSD_SHA256 = crypto.createHash('sha256').update(PSD_BYTES).digest('hex');

function dependencies(overrides: Partial<AssetImportDependencies> = {}): {
  deps: AssetImportDependencies;
  published: DesignSystemEntry[];
} {
  const published: DesignSystemEntry[] = [];
  return {
    published,
    deps: {
      async resolve() {
        return {
          stream: Readable.from([PSD_BYTES]),
          mimeType: 'image/vnd.adobe.photoshop',
          filename: 'curatoria.psd',
          sourceType: 'gdrive',
        };
      },
      async store({ body, filename, mimeType, sha256, byteLength }) {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        assert.deepEqual(Buffer.concat(chunks), PSD_BYTES);
        assert.equal(filename, 'curatoria.psd');
        assert.equal(mimeType, 'image/vnd.adobe.photoshop');
        assert.equal(sha256, PSD_SHA256);
        assert.equal(byteLength, PSD_BYTES.byteLength);
        return {
          pathname: 'assets/sha256/abc/curatoria.psd',
          sha256: PSD_SHA256,
          bytes: PSD_BYTES.byteLength,
          created: true,
          etag: 'created',
        };
      },
      async publish(entry) {
        published.push(entry);
      },
      ...overrides,
    },
  };
}

test('importBinaryAsset publishes only private immutable metadata after Blob succeeds', async () => {
  const { deps, published } = dependencies();
  const entry = await importBinaryAsset(
    {
      id: 'curatoria-psd-drive',
      name: 'Curatoria PSD',
      description: 'Google Drive proof file.',
      priceUsd: '0.01',
      tags: ['psd', 'proof'],
      source: { type: 'gdrive', file_id: 'provider-secret-id' },
      filename: 'curatoria.psd',
      mimeType: 'image/vnd.adobe.photoshop',
      localOriginalBytes: PSD_BYTES,
    },
    deps,
  );

  assert.equal(entry.resource_type, 'binary_asset');
  assert.equal(entry.content_sha256, PSD_SHA256);
  assert.equal(entry.content_bytes, PSD_BYTES.byteLength);
  assert.equal(entry.integrity_status, 'verified');
  assert.equal(entry.delivery_mode, 'entitlement');
  assert.equal(entry.source_provider, 'gdrive');
  assert.equal(entry.blob_path, 'assets/sha256/abc/curatoria.psd');
  assert.equal(entry.price_usd, '0.01');
  assert.equal(entry.source, undefined);
  assert.deepEqual(published, [entry]);
  assert.equal(JSON.stringify(published).includes('provider-secret-id'), false);
});

test('importBinaryAsset rejects corrupt PSD bytes before storage or publication', async () => {
  let stored = false;
  const { deps, published } = dependencies({
    async resolve() {
      return {
        stream: Readable.from([Buffer.from('not a PSD')]),
        mimeType: 'image/vnd.adobe.photoshop',
        filename: 'bad.psd',
        sourceType: 'dropbox',
      };
    },
    async store() {
      stored = true;
      throw new Error('must not store');
    },
  });

  await assert.rejects(
    () =>
      importBinaryAsset(
        {
          id: 'bad-psd',
          name: 'Bad PSD',
          description: '',
          priceUsd: '0.01',
          tags: [],
          source: { type: 'dropbox', share_url: 'https://www.dropbox.com/example' },
          filename: 'bad.psd',
          mimeType: 'image/vnd.adobe.photoshop',
          localOriginalBytes: PSD_BYTES,
        },
        deps,
      ),
    /missing PSD 8BPS signature/,
  );
  assert.equal(stored, false);
  assert.deepEqual(published, []);
});

test('importBinaryAsset does not publish when private Blob storage fails', async () => {
  const { deps, published } = dependencies({
    async store() {
      throw new Error('Blob unavailable');
    },
  });

  await assert.rejects(
    () =>
      importBinaryAsset(
        {
          id: 'curatoria-psd-drive',
          name: 'Curatoria PSD',
          description: '',
          priceUsd: '0.01',
          tags: [],
          source: { type: 'gdrive', file_id: 'secret' },
          filename: 'curatoria.psd',
          mimeType: 'image/vnd.adobe.photoshop',
          localOriginalBytes: PSD_BYTES,
        },
        deps,
      ),
    /Blob unavailable/,
  );
  assert.deepEqual(published, []);
});

test('importBinaryAsset requires a trusted original commitment before resolving', async () => {
  let resolved = false;
  const { deps } = dependencies({
    async resolve() {
      resolved = true;
      throw new Error('must not resolve');
    },
  });

  await assert.rejects(
    () =>
      importBinaryAsset(
        {
          id: 'untrusted-psd',
          name: 'Untrusted PSD',
          description: '',
          priceUsd: '0.01',
          tags: [],
          source: { type: 'gdrive', file_id: 'secret' },
          filename: 'layout.psd',
          mimeType: 'image/vnd.adobe.photoshop',
        },
        deps,
      ),
    /exactly one trusted original/,
  );
  assert.equal(resolved, false);
});

test('importBinaryAsset rejects provider byte mismatch before Blob storage', async () => {
  let stored = false;
  const { deps, published } = dependencies({
    async store() {
      stored = true;
      throw new Error('must not store');
    },
  });

  await assert.rejects(
    () =>
      importBinaryAsset(
        {
          id: 'mismatched-psd',
          name: 'Mismatched PSD',
          description: '',
          priceUsd: '0.01',
          tags: [],
          source: { type: 'dropbox', share_url: 'https://www.dropbox.com/example' },
          filename: 'layout.psd',
          mimeType: 'image/vnd.adobe.photoshop',
          trustedOriginalSha256: 'f'.repeat(64),
          trustedOriginalBytes: PSD_BYTES.byteLength,
        },
        deps,
      ),
    /do(?:es)? not match the trusted original/,
  );
  assert.equal(stored, false);
  assert.deepEqual(published, []);
});

test('importBinaryAsset retains newly created immutable Blob when publication fails', async () => {
  let stored = false;
  const { deps } = dependencies({
    async store(input) {
      stored = true;
      return dependencies().deps.store(input);
    },
    async publish() {
      throw new Error('registry unavailable');
    },
  });
  await assert.rejects(
    () =>
      importBinaryAsset(
        {
          id: 'retain-created',
          name: 'Retain',
          description: '',
          priceUsd: '0.01',
          tags: [],
          source: { type: 'gdrive', file_id: 'secret' },
          filename: 'curatoria.psd',
          mimeType: 'image/vnd.adobe.photoshop',
          localOriginalBytes: PSD_BYTES,
        },
        deps,
      ),
    /registry unavailable/,
  );
  assert.equal(stored, true);
});

test('importBinaryAsset stages with private modes and always removes the staged file', async () => {
  let stagedPath = '';
  const { deps } = dependencies({
    async store({ body }) {
      stagedPath = String((body as fs.ReadStream).path);
      assert.equal(fs.statSync(stagedPath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(stagedPath)).mode & 0o777, 0o700);
      for await (const _chunk of body) {
        // Consume the staged stream.
      }
      return {
        pathname: 'assets/sha256/abc/curatoria.psd',
        sha256: PSD_SHA256,
        bytes: PSD_BYTES.byteLength,
        created: true,
        etag: 'created',
      };
    },
  });
  await importBinaryAsset(
    {
      id: 'private-stage',
      name: 'Private Stage',
      description: '',
      priceUsd: '0.01',
      tags: [],
      source: { type: 'gdrive', file_id: 'secret' },
      filename: 'curatoria.psd',
      mimeType: 'image/vnd.adobe.photoshop',
      localOriginalBytes: PSD_BYTES,
    },
    deps,
  );
  assert.equal(fs.existsSync(stagedPath), false);
  assert.equal(fs.existsSync(path.dirname(stagedPath)), false);
});

test('concurrent imports safely share one immutable Blob result', async () => {
  let stores = 0;
  const published: DesignSystemEntry[] = [];
  const { deps } = dependencies({
    async store({ body }) {
      for await (const _chunk of body) {
        // Consume each independent staged file.
      }
      stores += 1;
      return {
        pathname: `assets/sha256/${PSD_SHA256}/curatoria.psd`,
        sha256: PSD_SHA256,
        bytes: PSD_BYTES.byteLength,
        created: stores === 1,
        etag: stores === 1 ? 'created' : 'existing',
      };
    },
    async publish(entry) {
      published.push(entry);
    },
  });
  const input = {
    name: 'Concurrent',
    description: '',
    priceUsd: '0.01',
    tags: [],
    source: { type: 'gdrive' as const, file_id: 'secret' },
    filename: 'curatoria.psd',
    mimeType: 'image/vnd.adobe.photoshop',
    localOriginalBytes: PSD_BYTES,
  };
  await Promise.all([
    importBinaryAsset({ ...input, id: 'concurrent-one' }, deps),
    importBinaryAsset({ ...input, id: 'concurrent-two' }, deps),
  ]);
  assert.equal(stores, 2);
  assert.equal(published.length, 2);
  assert.equal(published[0].blob_path, published[1].blob_path);
});
