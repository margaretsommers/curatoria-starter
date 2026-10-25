/**
 * catalog-blob-repository.ts — Blob-backed catalog storage for production.
 *
 * Why this exists: design-systems/.registry.json (read by src/catalog.ts via
 * plain fs calls) does not get included in Vercel's deployed function bundle
 * for this project -- confirmed 2026-09-06 by direct production testing
 * (multiple includeFiles configurations, a literal-vs-dynamic path rewrite,
 * and a forced no-cache rebuild all failed identically; every request
 * crashed at module load because the directory genuinely isn't present at
 * runtime). This module stores the whole registry as one JSON object in
 * Vercel Blob instead, which is already proven reliable this session for
 * binary-asset delivery.
 *
 * `readCatalog()` in the CatalogRepository interface is synchronous, and
 * changing that would cascade through every caller (x402.ts, discovery.ts,
 * sitemap.ts, ...). Instead: composeApp() (already async) awaits one Blob
 * fetch during composition, before the Express app is ever returned. Reads
 * afterward are synchronous against that cache and never trigger network
 * traffic. Publication explicitly refreshes the authoritative document and
 * updates the writing instance's cache. Deployments pick up external changes;
 * there is deliberately no per-instance polling.
 */

import type { BlobSdkAdapter } from './blob-storage';
import type { CatalogRepository } from './app';
import { assertPublishableCatalogEntry } from './catalog';
import { resolveResource } from './sources';
import type { DesignCatalog, DesignSystemEntry } from './types';

export const CATALOG_BLOB_PATHNAME = 'registry/v1/catalog.json';

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function immutableEntryJson(entry: DesignSystemEntry): string {
  const { published_at: _publishedAt, ...immutable } = entry;
  return stableJson(immutable);
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const value = error as Error & { status?: number; statusCode?: number; code?: string };
  return (
    value.status === 404 ||
    value.statusCode === 404 ||
    value.code === 'BLOB_NOT_FOUND' ||
    /\b(?:404|not found)\b/i.test(value.message)
  );
}

function isValidCatalog(value: unknown): value is DesignCatalog {
  return Boolean(
    value &&
      typeof value === 'object' &&
      Array.isArray((value as DesignCatalog).design_systems) &&
      (value as DesignCatalog).owner &&
      typeof (value as DesignCatalog).owner.wallet === 'string',
  );
}

export type BlobCatalogRepository = CatalogRepository & {
  /** Tries Blob once, then uses the deployment-bundled snapshot when Blob is unavailable. */
  initialize(): Promise<void>;
  status(): CatalogRepositoryStatus;
};

export type CatalogRepositoryStatus = {
  initialized: boolean;
  source: 'blob' | 'snapshot';
  authoritative: boolean;
  error?: string;
};

/**
 * The registry is a mutable single document, unlike the content-addressed
 * immutable asset blobs the rest of the codebase writes -- BlobSdkAdapter#put
 * is intentionally typed to accept only `allowOverwrite: false` so every
 * other call site keeps that immutability guarantee at the type level. This
 * takes a narrow, separately-typed write function instead of widening (or
 * casting around) that shared type.
 */
export type MutableJsonBlobWriter = (pathname: string, body: Uint8Array) => Promise<void>;

export function createBlobCatalogRepository(
  sdk: BlobSdkAdapter,
  writeMutableJson: MutableJsonBlobWriter,
  options: { snapshot?: DesignCatalog } = {},
): BlobCatalogRepository {
  const snapshot = options.snapshot;
  let cache: DesignCatalog | undefined;
  let currentStatus: CatalogRepositoryStatus = {
    initialized: false,
    source: 'snapshot',
    authoritative: false,
  };

  async function fetchCatalog(): Promise<DesignCatalog | undefined> {
    let read: Awaited<ReturnType<BlobSdkAdapter['read']>>;
    try {
      read = await sdk.read(CATALOG_BLOB_PATHNAME, { useCache: true });
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of read.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!isValidCatalog(parsed)) {
      throw new Error('Blob-backed catalog registry is malformed.');
    }
    return parsed;
  }

  function requireCache(): DesignCatalog {
    if (!cache) {
      throw new Error(
        'Blob-backed catalog was read before initialize() completed. Call initialize() during app composition, before serving requests.',
      );
    }
    return cache;
  }

  const repository: BlobCatalogRepository = {
    async initialize() {
      try {
        const fresh = await fetchCatalog();
        if (!fresh) throw new Error('Blob-backed catalog registry was not found.');
        cache = fresh;
        currentStatus = { initialized: true, source: 'blob', authoritative: true };
      } catch (error) {
        if (!snapshot || !isValidCatalog(snapshot)) throw error;
        cache = snapshot;
        currentStatus = {
          initialized: true,
          source: 'snapshot',
          authoritative: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    status() {
      return { ...currentStatus };
    },
    readCatalog() {
      return requireCache();
    },
    findEntry(id) {
      return requireCache().design_systems.find(e => e.id === id && e.active) ?? null;
    },
    async appendEntry(entry) {
      assertPublishableCatalogEntry(entry);
      // Best-effort compare-and-swap: re-fetch immediately before writing to
      // narrow (not eliminate) the race window against a concurrent
      // publisher. Catalog publication is an infrequent, admin-only action;
      // this is a deliberately simpler safety model than the filesystem
      // version's cross-process ticket lock, appropriate for that frequency.
      const latest = (await fetchCatalog()) ?? cache ?? { owner: requireCache().owner, design_systems: [] };
      const existingIndex = latest.design_systems.findIndex(candidate => candidate.id === entry.id);
      if (existingIndex >= 0) {
        const existing = latest.design_systems[existingIndex];
        if (immutableEntryJson(existing) === immutableEntryJson(entry)) {
          cache = latest;
          currentStatus = { initialized: true, source: 'blob', authoritative: true };
          return;
        }
        throw new Error(`Catalog ID conflict: "${entry.id}" is already published.`);
      }
      const updated: DesignCatalog = {
        ...latest,
        design_systems: [...latest.design_systems, entry],
      };
      const body = Buffer.from(`${JSON.stringify(updated, null, 2)}\n`);
      await writeMutableJson(CATALOG_BLOB_PATHNAME, body);
      cache = updated;
      currentStatus = { initialized: true, source: 'blob', authoritative: true };
    },
    resolveResource,
  };

  return repository;
}
