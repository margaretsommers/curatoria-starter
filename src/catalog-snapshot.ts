import fs from 'node:fs';
import path from 'node:path';

import bundledSnapshot from './catalog.snapshot.json';
import { PROJECT_ROOT, REGISTRY_PATH } from './paths';
import type { DesignCatalog } from './types';

export const CATALOG_SNAPSHOT_PATH = path.join(PROJECT_ROOT, 'src', 'catalog.snapshot.json');

export function readBundledCatalogSnapshot(): DesignCatalog {
  return structuredClone(bundledSnapshot) as DesignCatalog;
}

export function writeCatalogSnapshot(
  registryPath = REGISTRY_PATH,
  snapshotPath = CATALOG_SNAPSHOT_PATH,
): void {
  const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as unknown;
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as DesignCatalog).design_systems) ||
    typeof (parsed as DesignCatalog).owner?.wallet !== 'string'
  ) {
    throw new Error('Catalog registry is malformed; refusing to update the bundled snapshot.');
  }
  fs.writeFileSync(snapshotPath, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}
