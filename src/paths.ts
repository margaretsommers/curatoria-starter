import path from 'path';

/** Repository root (parent of src/, dist/, scripts/, and design-systems/). */
export const REPO_ROOT = path.resolve(__dirname, '..');

export const DESIGN_SYSTEMS_DIR = path.join(REPO_ROOT, 'design-systems');
export const REGISTRY_PATH = path.join(DESIGN_SYSTEMS_DIR, '.registry.json');
export const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
export const ENV_PATH = path.join(REPO_ROOT, '.env');
export const SITEMAP_PATH = path.join(PUBLIC_DIR, 'sitemap.xml');

/**
 * Resolve a local product path from the repo root (not process.cwd()).
 * Ensures the file lives under design-systems/ so registry basenames match
 * what the server reads at request time.
 */
export function resolveLocalDesignSystemsFile(inputPath: string): string {
  const absolute = path.isAbsolute(inputPath)
    ? path.normalize(inputPath)
    : path.resolve(REPO_ROOT, inputPath);
  const relative = path.relative(DESIGN_SYSTEMS_DIR, absolute);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Local product files must live under design-systems/. Got: ${inputPath}`,
    );
  }

  return absolute;
}
