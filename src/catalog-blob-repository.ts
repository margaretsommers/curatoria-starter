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
 * fetch during composition, before the Express app is ever returned, so the
 * first request already has a warm in-memory cache. Reads afterward are
 * synchronous against that cache, refreshed on a short TTL
 * (stale-while-revalidate: an expired cache is served immediately while a
 * background refetch runs) so a publish from a different warm instance
 * eventually becomes visible without needing a redeploy or restart, echoing
 * the filesystem version's "no caching by design" intent as closely as an
 * async network store allows. Writes update the in-memory cache immediately
 * so the writing instance sees its own change without waiting on the TTL.
 */

import type { BlobSdkAdapter } from './blob-storage';
import type { CatalogRepository } from './app';
import { assertPublishableCatalogEntry } from './catalog';
import { resolveResource } from './sources';
import type { DesignCatalog, DesignSystemEntry } from './types';

const REGISTRY_PATHNAME = 'registry/v1/catalog.json';
const DEFAULT_REFRESH_TTL_MS = 30_000;

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
  /** Fetches the registry once and populates the in-memory cache. Must resolve before the app serves its first request. */
  initialize(): Promise<void>;
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
  options: { refreshTtlMs?: number; seed?: DesignCatalog } = {},
): BlobCatalogRepository {
  const refreshTtlMs = options.refreshTtlMs ?? DEFAULT_REFRESH_TTL_MS;
  let cache: DesignCatalog | undefined = options.seed;
  let fetchedAtMs = options.seed ? Date.now() : 0;
  let refreshing: Promise<void> | undefined;

  async function fetchCatalog(): Promise<DesignCatalog | undefined> {
    let read: Awaited<ReturnType<BlobSdkAdapter['read']>>;
    try {
      read = await sdk.read(REGISTRY_PATHNAME);
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

  async function refreshNow(): Promise<void> {
    const fresh = await fetchCatalog();
    if (fresh) {
      cache = fresh;
      fetchedAtMs = Date.now();
    }
  }

  function scheduleBackgroundRefreshIfStale(): void {
    if (refreshing || Date.now() - fetchedAtMs < refreshTtlMs) return;
    refreshing = refreshNow()
      .catch(() => {
        // A failed background refresh keeps serving the last good cache;
        // the next stale read will try again.
      })
      .finally(() => {
        refreshing = undefined;
      });
  }

  function requireCache(): DesignCatalog {
    if (!cache) {
      throw new Error(
        'Blob-backed catalog was read before initialize() completed. Call initialize() during app composition, before serving requests.',
      );
    }
    scheduleBackgroundRefreshIfStale();
    return cache;
  }

  const repository: BlobCatalogRepository = {
    async initialize() {
      cache = (await fetchCatalog()) ?? {
        owner: { wallet: '0x0000000000000000000000000000000000000000', name: 'Curatoria' },
        design_systems: [],
      };
      fetchedAtMs = Date.now();
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
          fetchedAtMs = Date.now();
          return;
        }
        throw new Error(`Catalog ID conflict: "${entry.id}" is already published.`);
      }
      const updated: DesignCatalog = {
        ...latest,
        design_systems: [...latest.design_systems, entry],
      };
      const body = Buffer.from(`${JSON.stringify(updated, null, 2)}\n`);
      await writeMutableJson(REGISTRY_PATHNAME, body);
      cache = updated;
      fetchedAtMs = Date.now();
    },
    resolveResource,
  };

  return repository;
}
