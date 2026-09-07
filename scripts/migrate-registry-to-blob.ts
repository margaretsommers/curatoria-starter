#!/usr/bin/env ts-node
/**
 * One-time migration: uploads the current local design-systems/.registry.json
 * to the production Blob registry object (see src/catalog-blob-repository.ts)
 * so the deployed function can read the catalog without design-systems/
 * needing to exist in the bundle at all.
 *
 * Requires real Vercel Blob credentials (BLOB_READ_WRITE_TOKEN or
 * BLOB_STORE_ID+VERCEL_OIDC_TOKEN) in the environment. Refuses to run against
 * local Blob mode -- this migrates the real production registry.
 *
 * Usage:
 *   set -a && source .env && source .env.local && set +a && \
 *     npm run migrate-registry-to-blob
 */
import fs from 'node:fs';

import { putMutableJsonBlob, vercelBlobSdk } from '../src/blob-storage';
import { REGISTRY_PATH } from '../src/paths';
import { resolveBlobMode } from '../src/blob-mode';
import type { DesignCatalog } from '../src/types';

const REGISTRY_PATHNAME = 'registry/v1/catalog.json';

async function main(): Promise<void> {
  const mode = resolveBlobMode(process.env);
  if (mode !== 'vercel') {
    throw new Error(
      `This migrates the real production Blob registry and refuses to run in "${mode}" mode. Set BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID) in the environment.`,
    );
  }

  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  const catalog = JSON.parse(raw) as DesignCatalog;
  if (!catalog?.owner?.wallet || !Array.isArray(catalog.design_systems)) {
    throw new Error('Local registry.json is malformed; refusing to migrate.');
  }

  let existing: DesignCatalog | undefined;
  try {
    const read = await vercelBlobSdk.read(REGISTRY_PATHNAME);
    const chunks: Buffer[] = [];
    for await (const chunk of read.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    existing = JSON.parse(Buffer.concat(chunks).toString('utf8')) as DesignCatalog;
  } catch {
    existing = undefined;
  }

  if (existing) {
    console.log(
      `Blob registry already has ${existing.design_systems.length} entries. This will overwrite it with the local registry's ${catalog.design_systems.length} entries.`,
    );
    const existingIds = new Set(existing.design_systems.map(e => e.id));
    const localIds = new Set(catalog.design_systems.map(e => e.id));
    const droppedIds = [...existingIds].filter(id => !localIds.has(id));
    if (droppedIds.length > 0) {
      throw new Error(
        `Refusing to migrate: the Blob registry has entries not present locally (${droppedIds.join(', ')}). Reconcile manually before overwriting.`,
      );
    }
  }

  const body = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
  await putMutableJsonBlob(REGISTRY_PATHNAME, body);
  console.log(
    `Migrated ${catalog.design_systems.length} catalog entries to Blob at ${REGISTRY_PATHNAME}: ${catalog.design_systems.map(e => e.id).join(', ')}`,
  );
}

main().catch(error => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
