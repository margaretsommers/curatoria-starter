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
