import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCatalogEntry } from './discovery';
import { DesignSystemEntry } from './types';

test('buildCatalogEntry publishes preview and license metadata without storage source', () => {
  const entry: DesignSystemEntry = {
    id: 'agent-preview-pack',
    file: 'private-pack.zip',
    source: {
      type: 'gdrive',
      file_id: 'private-drive-id',
    },
    resource_type: 'bundle_zip',
    bundle_file: 'private-pack.zip',
    mime_type: 'application/zip',
    name: 'Agent Preview Pack',
    description: 'A bundle with enough metadata for agents to evaluate before buying.',
    price_usd: '0.10',
    tags: ['tokens', 'components'],
    license: 'custom-commercial',
    license_url: 'https://example.com/license',
    license_summary: 'Paid commercial use for one buyer workspace.',
    preview: 'Includes tokens and component guidance. Full files require payment.',
    preview_url: 'https://example.com/previews/agent-preview-pack',
    sample_files: ['samples/colors.sample.json'],
    table_of_contents: ['Tokens', 'Components'],
    token_categories: ['color', 'spacing'],
    component_list: ['Button', 'Card'],
    content_sha256: 'b'.repeat(64),
    bundle_manifest: [
      {
        path: 'tokens/colors.json',
        kind: 'tokens',
        mime_type: 'application/json',
        bytes: 128,
        sha256: 'c'.repeat(64),
      },
    ],
    disposable_access: {
      enabled: true,
      max_downloads: 2,
      max_views: 3,
      hours_valid: 12,
      delivery: 'fallback_when_direct_too_large',
    },
    published_at: '2026-01-01T00:00:00.000Z',
    active: true,
  };

  const catalogEntry = buildCatalogEntry(entry, 'https://curatoria.example');

  assert.equal(catalogEntry.access_url, 'https://curatoria.example/packs/agent-preview-pack/download');
  assert.equal(catalogEntry.download_url, catalogEntry.access_url);
  assert.equal(catalogEntry.payment_required, true);
  assert.equal(catalogEntry.license, 'custom-commercial');
  assert.equal(catalogEntry.license_summary, 'Paid commercial use for one buyer workspace.');
  assert.deepEqual(catalogEntry.sample_files, ['samples/colors.sample.json']);
  assert.deepEqual(catalogEntry.token_categories, ['color', 'spacing']);
  assert.deepEqual(catalogEntry.component_list, ['Button', 'Card']);
  assert.equal(catalogEntry.content_sha256, 'b'.repeat(64));
  assert.deepEqual(catalogEntry.bundle_manifest?.[0], {
    path: 'tokens/colors.json',
    kind: 'tokens',
    mime_type: 'application/json',
    bytes: 128,
    sha256: 'c'.repeat(64),
  });
  assert.equal(catalogEntry.disposable_access?.max_downloads, 2);
  assert.equal('file' in catalogEntry, false);
  assert.equal('source' in catalogEntry, false);
});

test('buildCatalogEntry exposes verified PSD metadata through the JSON purchase route', () => {
  const catalogEntry = buildCatalogEntry(
    {
      id: 'curatoria-psd-drive',
      file: 'curatoria.psd',
      resource_type: 'binary_asset',
      mime_type: 'image/vnd.adobe.photoshop',
      name: 'Curatoria PSD',
      description: 'Provider-imported PSD proof.',
      price_usd: '0.01',
      tags: ['psd', 'proof'],
      content_sha256: 'a'.repeat(64),
      content_bytes: 123456,
      integrity_status: 'verified',
      delivery_mode: 'entitlement',
      source_provider: 'gdrive',
      blob_path: 'sha256/secret-internal-path/curatoria.psd',
      published_at: '2026-08-29T00:00:00.000Z',
      active: true,
    },
    'https://curatoria.example',
  );

  assert.equal(
    catalogEntry.access_url,
    'https://curatoria.example/assets/curatoria-psd-drive/purchase',
  );
  assert.equal(catalogEntry.download_url, undefined);
  assert.equal(catalogEntry.mime_type, 'image/vnd.adobe.photoshop');
  assert.equal(catalogEntry.download_filename, 'curatoria.psd');
  assert.equal(catalogEntry.content_bytes, 123456);
  assert.equal(catalogEntry.integrity_status, 'verified');
  assert.equal(catalogEntry.delivery_mode, 'entitlement');
  assert.equal(catalogEntry.source_provider, 'gdrive');
  assert.equal('blob_path' in catalogEntry, false);
});

test('buildCatalogEntry labels unverified integrity without exposing source or Blob path', () => {
  const catalogEntry = buildCatalogEntry(
    {
      id: 'creator-opt-out',
      file: 'notes.bin',
      resource_type: 'binary_asset',
      mime_type: 'application/octet-stream',
      name: 'Unverified binary',
      description: 'Creator opted out of a trusted hash commitment.',
      price_usd: '0.01',
      tags: ['unverified'],
      integrity_status: 'unverified',
      delivery_mode: 'entitlement',
      source_provider: 'url',
      blob_path: 'assets/sha256/not-a-public-path/notes.bin',
      source: { type: 'url', url: 'https://files.example/private/notes.bin' },
      published_at: '2026-08-29T00:00:00.000Z',
      active: true,
    },
    'https://curatoria.example',
  );

  assert.equal(catalogEntry.integrity_status, 'unverified');
  assert.equal(catalogEntry.access_url, 'https://curatoria.example/assets/creator-opt-out/purchase');
  assert.equal('source' in catalogEntry, false);
  assert.equal('blob_path' in catalogEntry, false);
  assert.equal(JSON.stringify(catalogEntry).includes('files.example'), false);
});
