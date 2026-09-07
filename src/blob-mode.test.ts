import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { composeBlobAdapter, localBlobRootDirectory, resolveBlobMode } from './blob-mode';
import { importPrivateBlob } from './blob-storage';
import { importBinaryAsset } from './asset-import';
import type { DesignSystemEntry } from './types';

test('blob mode defaults to local in development and vercel when configured', () => {
  assert.equal(resolveBlobMode({}), 'local');
  assert.equal(resolveBlobMode({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x' }), 'vercel');
  assert.equal(resolveBlobMode({ BLOB_STORE_ID: 'store_x' }), 'vercel');
  assert.equal(resolveBlobMode({ NODE_ENV: 'production' }), 'disabled');
  assert.equal(
    resolveBlobMode({ NODE_ENV: 'production', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x' }),
    'vercel',
  );
});

test('explicit blob mode overrides fail closed on invalid combinations', () => {
  assert.equal(resolveBlobMode({ BLOB_MODE: 'local' }), 'local');
  assert.equal(
    resolveBlobMode({ BLOB_MODE: 'vercel', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x' }),
    'vercel',
  );
  assert.throws(() => resolveBlobMode({ BLOB_MODE: 'vercel' }), /requires BLOB_STORE_ID/);
  assert.throws(
    () => resolveBlobMode({ BLOB_MODE: 'local', NODE_ENV: 'production' }),
    /development mode/,
  );
  assert.throws(() => resolveBlobMode({ BLOB_MODE: 's3' }), /must be "vercel" or "local"/);
});

test('composeBlobAdapter local mode rejects a short LOCAL_BLOB_SECRET', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-blob-mode-'));
  assert.throws(
    () =>
      composeBlobAdapter(
        { LOCAL_BLOB_DIR: root, LOCAL_BLOB_SECRET: 'short' },
        'http://localhost:3000',
      ),
    /at least 32 bytes/,
  );
});

test('publish-asset import path stores exact bytes through the local adapter', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-blob-mode-import-'));
  const env = { LOCAL_BLOB_DIR: root };
  assert.equal(localBlobRootDirectory(env), root);
  const { mode, adapter, localStore } = composeBlobAdapter(env, 'http://localhost:3000');
  assert.equal(mode, 'local');
  assert.ok(adapter);
  assert.ok(localStore);

  const bytes = Buffer.concat([Buffer.from('8BPS'), crypto.randomBytes(96)]);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const published: DesignSystemEntry[] = [];
  const entry = await importBinaryAsset(
    {
      id: 'local-proof',
      name: 'Local proof PSD',
      description: '',
      priceUsd: '0.01',
      tags: ['psd'],
      source: { type: 'url', url: 'https://provider.example/original.psd' },
      filename: 'local-proof.psd',
      mimeType: 'image/vnd.adobe.photoshop',
      localOriginalBytes: bytes,
    },
    {
      resolve: async () => ({
        stream: Readable.from([bytes]),
        sourceType: 'url' as const,
        mimeType: 'image/vnd.adobe.photoshop',
        filename: 'local-proof.psd',
      }),
      store: input => importPrivateBlob(input, adapter!),
      publish: async candidate => {
        published.push(candidate);
      },
    },
  );

  assert.equal(entry.content_sha256, sha256);
  assert.equal(entry.blob_path, `assets/sha256/${sha256}/local-proof.psd`);
  assert.equal(published.length, 1);

  const stored = await localStore!.read(entry.blob_path!);
  const chunks: Buffer[] = [];
  for await (const chunk of stored.body) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(stored.contentType, 'image/vnd.adobe.photoshop');
});
