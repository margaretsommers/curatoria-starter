import fs from 'fs';
import path from 'path';
import { writeSitemapFile } from './sitemap';
import { DesignCatalog, DesignSystemEntry } from './types';

const REGISTRY_PATH = path.join(__dirname, '../design-systems/.registry.json');
const DESIGN_SYSTEMS_DIR = path.join(__dirname, '../design-systems');

/**
 * Reads the full registry from disk on every call.
 * No caching by design — lets you publish new design systems without restarting the server.
 */
export function readCatalog(): DesignCatalog {
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

/**
 * Reads the raw .md file content for a registry entry.
 * This is what gets served to the paying client.
 */
export function readDesignFile(entry: DesignSystemEntry): string {
  const filePath = path.join(DESIGN_SYSTEMS_DIR, entry.file);
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
  const filePath = path.join(DESIGN_SYSTEMS_DIR, bundleName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Bundle file not found on disk: ${bundleName}`);
  }
  return fs.readFileSync(filePath);
}

/**
 * Appends a new entry to the registry, or overwrites an existing one with the same ID.
 * Safe to call while the server is running — the next request will pick up the change.
 */
export function appendEntry(entry: DesignSystemEntry): void {
  const catalog = readCatalog();
  const idx = catalog.design_systems.findIndex(e => e.id === entry.id);
  if (idx >= 0) {
    catalog.design_systems[idx] = entry;
  } else {
    catalog.design_systems.push(entry);
  }
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(catalog, null, 2) + '\n');

  try {
    writeSitemapFile();
  } catch (err) {
    console.warn(`Failed to regenerate sitemap.xml: ${String(err)}`);
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
