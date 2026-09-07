import fs from 'fs';
import { promises as fsp } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'path';
import { writeSitemapFile } from './sitemap';
import { normalizeSha256 } from './content-integrity';
import { sanitizeDownloadFilename } from './delivery';
import { DesignCatalog, DesignSystemEntry } from './types';
import { REGISTRY_PATH, resolveDesignSystemPath } from './paths';

const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MIN_MS = 2;
const LOCK_RETRY_JITTER_MS = 8;

/**
 * Confirmed 2026-09-06 in production: design-systems/.registry.json does not
 * exist in Vercel's deployed function bundle, so the plain filesystem read
 * below throws ENOENT for every request in production. server.ts already
 * composes a Blob-backed CatalogRepository for production (see
 * ./catalog-blob-repository), but x402.ts, x402-discovery.ts, discovery.ts,
 * openapi-spec.ts, and sitemap.ts all import readCatalog/findEntry/listActive
 * directly from this module rather than through that injected dependency --
 * threading DI through every one of those call sites would be a much larger
 * refactor than the actual problem calls for. Instead, readCatalog() itself
 * -- the single choke point findEntry/findEntryIncludingInactive/listActive/
 * resolveCatalogPriceUsd all already derive from -- checks for an active
 * override that server.ts installs once during production composition, and
 * only falls back to the filesystem read when none is set (every other
 * environment: local dev, tests, the starter export).
 */
export type CatalogSource = { readCatalog(): DesignCatalog };

let activeCatalogSource: CatalogSource | undefined;

/** Installed by server.ts during production composition; see comment above. */
export function setActiveCatalogSource(source: CatalogSource | undefined): void {
  activeCatalogSource = source;
}

/**
 * Reads the full registry from disk on every call (or from the active
 * override, when one has been installed for this process -- see
 * setActiveCatalogSource above).
 * No caching by design — lets you publish new design systems without restarting the server.
 */
export function readCatalog(): DesignCatalog {
  if (activeCatalogSource) return activeCatalogSource.readCatalog();
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
  return JSON.parse(raw) as DesignCatalog;
}

/**
 * Looks up one active design system by its URL slug.
 * Returns null if the ID doesn't exist or the entry is inactive (unlisted).
 */
export function findEntry(id: string): DesignSystemEntry | null {
  const catalog = readCatalog();
  return catalog.design_systems.find(e => e.id === id && e.active) ?? null;
}

/** Looks up immutable registry metadata even when an entry is no longer listed. */
export function findEntryIncludingInactive(id: string): DesignSystemEntry | null {
  return readCatalog().design_systems.find(e => e.id === id) ?? null;
}

/**
 * Reads the raw .md file content for a registry entry.
 * This is what gets served to the paying client.
 */
export function readDesignFile(entry: DesignSystemEntry): string {
  const filePath = resolveDesignSystemPath(entry.file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Design file not found on disk: ${entry.file}`);
  }
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Reads a bundle zip for a registry entry.
 * Uses bundle_file when present, otherwise falls back to file for compatibility.
 */
export function readBundleFile(entry: DesignSystemEntry): Buffer {
  const bundleName = entry.bundle_file ?? entry.file;
  const filePath = resolveDesignSystemPath(bundleName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Bundle file not found on disk: ${bundleName}`);
  }
  return fs.readFileSync(filePath);
}

/**
 * Appends a new entry to the registry, or overwrites an existing one with the same ID.
 * Safe to call while the server is running — the next request will pick up the change.
 */
export async function appendEntry(entry: DesignSystemEntry): Promise<void> {
  await publishCatalogEntry(entry);

  try {
    writeSitemapFile();
  } catch (err) {
    console.warn(`Failed to regenerate sitemap.xml: ${String(err)}`);
  }
}

export type CatalogPublicationOptions = {
  registryPath?: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
};

type LockMetadata = {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
  choosing: boolean;
  number?: number;
};

const SAFE_MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/**
 * Rejects publication metadata that discovery and paid delivery cannot safely honor.
 * E1.T5: verified status requires a 64-hex hash; filenames and MIME values must be safe.
 */
export function assertPublishableCatalogEntry(entry: DesignSystemEntry): void {
  assertSafeFilename(entry.file);
  if (entry.bundle_file !== undefined) assertSafeFilename(entry.bundle_file);
  if (entry.mime_type !== undefined) assertSafeMimeType(entry.mime_type);
  if (entry.integrity_status === 'verified' && !normalizeSha256(entry.content_sha256)) {
    throw new Error('Verified catalog entries require a 64-hex content_sha256.');
  }
  if (entry.content_sha256 !== undefined && !normalizeSha256(entry.content_sha256)) {
    throw new Error('Catalog content_sha256 must be a 64-character hex digest.');
  }
}

function assertSafeFilename(value: string): void {
  if (
    !value ||
    /[\\/\x00-\x1F\x7F]/.test(value) ||
    value === '.' ||
    value === '..' ||
    sanitizeDownloadFilename(value) !== value
  ) {
    throw new Error('Catalog filename is unsafe.');
  }
}

function assertSafeMimeType(value: string): void {
  if (/[\x00-\x1F\x7F]/.test(value)) {
    throw new Error('Catalog MIME type is unsafe.');
  }
  const mediaType = value.split(';', 1)[0].trim();
  if (!SAFE_MIME_TYPE.test(mediaType)) {
    throw new Error('Catalog MIME type is unsafe.');
  }
}

/**
 * Publishes one immutable ID while holding a cross-process filesystem lock.
 * Identical retries are idempotent; a different value for an existing ID fails.
 */
export async function publishCatalogEntry(
  entry: DesignSystemEntry,
  options: CatalogPublicationOptions = {},
): Promise<void> {
  assertPublishableCatalogEntry(entry);
  const targetPath = options.registryPath ?? REGISTRY_PATH;
  const lockPath = `${targetPath}.lock`;
  const release = await acquirePublicationLock(lockPath, {
    timeoutMs: options.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
    staleMs: options.staleLockMs ?? LOCK_STALE_MS,
  });
  try {
    await release.assertOwned();
    const raw = await fsp.readFile(targetPath, 'utf8');
    const catalog = JSON.parse(raw) as DesignCatalog;
    if (!catalog || !Array.isArray(catalog.design_systems)) {
      throw new Error('Catalog registry must contain a design_systems array.');
    }
    const existing = catalog.design_systems.find(candidate => candidate.id === entry.id);
    if (existing) {
      if (immutableEntryJson(existing) === immutableEntryJson(entry)) return;
      throw new Error(`Catalog ID conflict: "${entry.id}" is already published.`);
    }
    catalog.design_systems.push(entry);
    await writeJsonAtomically(targetPath, catalog, release.assertOwned);
  } finally {
    await release.unlock();
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function immutableEntryJson(entry: DesignSystemEntry): string {
  const { published_at: _publishedAt, ...immutable } = entry;
  return stableJson(immutable);
}

async function acquirePublicationLock(
  lockPath: string,
  options: { timeoutMs: number; staleMs: number },
): Promise<{ assertOwned(): Promise<void>; unlock(): Promise<void> }> {
  const startedAt = Date.now();
  await fsp.mkdir(lockPath, { recursive: true, mode: 0o700 });
  const token = crypto.randomUUID();
  const ticketPath = path.join(lockPath, `${token}.ticket`);
  let metadata: LockMetadata = {
    token,
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
    choosing: true,
  };
  await fsp.writeFile(ticketPath, `${JSON.stringify(metadata)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await fsyncDirectory(lockPath);
  const initial = await readLiveTickets(lockPath, options.staleMs);
  metadata = {
    ...metadata,
    choosing: false,
    number: initial.reduce((maximum, ticket) => Math.max(maximum, ticket.number ?? 0), 0) + 1,
  };
  await replaceTicketAtomically(ticketPath, metadata);

  while (true) {
    const tickets = await readLiveTickets(lockPath, options.staleMs);
    const blocked = tickets.some(ticket => {
      if (ticket.token === token) return false;
      if (ticket.choosing || ticket.number === undefined) return true;
      return (
        ticket.number < (metadata.number as number) ||
        (ticket.number === metadata.number && ticket.token < token)
      );
    });
    if (!blocked) break;
    if (Date.now() - startedAt >= options.timeoutMs) {
      await fsp.unlink(ticketPath).catch(() => undefined);
      throw new Error(`Timed out waiting for catalog publication lock after ${options.timeoutMs}ms.`);
    }
    await delay(LOCK_RETRY_MIN_MS + Math.floor(Math.random() * LOCK_RETRY_JITTER_MS));
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    void fsp.utimes(ticketPath, now, now).catch(() => undefined);
  }, Math.max(1, Math.floor(options.staleMs / 3)));
  heartbeat.unref();

  const assertOwned = async (): Promise<void> => {
    let current: LockMetadata;
    try {
      current = JSON.parse(await fsp.readFile(ticketPath, 'utf8')) as LockMetadata;
    } catch {
      throw new Error('Catalog publication lock ownership was lost.');
    }
    if (
      current.token !== metadata.token ||
      current.choosing ||
      current.number !== metadata.number
    ) {
      throw new Error('Catalog publication lock ownership was lost.');
    }
  };

  return {
    assertOwned,
    async unlock() {
      clearInterval(heartbeat);
      try {
        await assertOwned();
        await fsp.unlink(ticketPath);
        await fsyncDirectory(lockPath);
      } catch (error) {
        if (!isFsError(error, 'ENOENT')) throw error;
      }
    },
  };
}

async function replaceTicketAtomically(
  ticketPath: string,
  metadata: LockMetadata,
): Promise<void> {
  const temporaryPath = `${ticketPath}.${crypto.randomUUID()}.tmp`;
  const handle = await fsp.open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporaryPath, ticketPath);
  await fsyncDirectory(path.dirname(ticketPath));
}

async function readLiveTickets(lockPath: string, staleMs: number): Promise<LockMetadata[]> {
  const names = await fsp.readdir(lockPath);
  const tickets: LockMetadata[] = [];
  await Promise.all(
    names.filter(name => name.endsWith('.ticket')).map(async name => {
      const ticketPath = path.join(lockPath, name);
      try {
        const [raw, stat] = await Promise.all([
          fsp.readFile(ticketPath, 'utf8'),
          fsp.stat(ticketPath),
        ]);
        const ticket = JSON.parse(raw) as LockMetadata;
        if (ticket.token !== name.slice(0, -'.ticket'.length)) return;
        const stale = Date.now() - stat.mtimeMs >= staleMs;
        const locallyAlive =
          ticket.hostname === os.hostname() &&
          Number.isSafeInteger(ticket.pid) &&
          isProcessAlive(ticket.pid);
        if (stale && !locallyAlive) {
          // Ticket names contain an unrepeatable UUID. Removing this exact path
          // cannot unlink a replacement lock created by another contender.
          await fsp.unlink(ticketPath).catch(error => {
            if (!isFsError(error, 'ENOENT')) throw error;
          });
          return;
        }
        tickets.push(ticket);
      } catch (error) {
        if (isFsError(error, 'ENOENT')) return;
        const stat = await fsp.stat(ticketPath).catch(() => undefined);
        if (stat && Date.now() - stat.mtimeMs >= staleMs) {
          await fsp.unlink(ticketPath).catch(() => undefined);
          return;
        }
        // A choosing writer may be between durable file replacement steps.
        tickets.push({
          token: name.slice(0, -'.ticket'.length),
          pid: 0,
          hostname: '',
          createdAt: '',
          choosing: true,
        });
      }
    }),
  );
  return tickets;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isFsError(error, 'EPERM');
  }
}

function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function writeJsonAtomically(
  targetPath: string,
  value: unknown,
  assertOwned: () => Promise<void>,
): Promise<void> {
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertOwned();
    await fsp.rename(temporaryPath, targetPath);
    await fsyncDirectory(directory);
  } catch (error) {
    await handle?.close();
    try {
      await fsp.unlink(temporaryPath);
    } catch {
      // Ignore cleanup when the temporary file was never created or already renamed.
    }
    throw error;
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fsp.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Returns only the active entries — used by discovery and listing endpoints.
 */
export function listActive(): DesignSystemEntry[] {
  return readCatalog().design_systems.filter(e => e.active);
}

/**
 * Resolves the catalog access price. Env override wins over registry owner block.
 */
export function resolveCatalogPriceUsd(): string {
  const envOverride = process.env.CATALOG_PRICE_USD?.trim();
  if (envOverride) return envOverride;

  const catalog = readCatalog();
  return catalog.owner.catalog_price_usd ?? '0.001';
}
