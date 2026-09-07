import fs from 'node:fs';
import path from 'node:path';

function normalizedDirectory(startPath: string): string {
  const resolved = path.resolve(startPath);
  return fs.existsSync(resolved) && fs.statSync(resolved).isFile()
    ? path.dirname(resolved)
    : resolved;
}

export function findProjectRoot(startPath = __dirname): string {
  let current = normalizedDirectory(startPath);

  while (true) {
    if (
      fs.existsSync(path.join(current, 'package.json')) &&
      fs.existsSync(path.join(current, 'design-systems')) &&
      fs.statSync(path.join(current, 'design-systems')).isDirectory()
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `Unable to find Curatoria project root from ${path.resolve(startPath)}.`,
      );
    }
    current = parent;
  }
}

function nearestExistingPath(targetPath: string): string {
  let current = targetPath;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function isInside(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(basePath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolvePathWithin(
  basePath: string,
  requestedPath: string,
  label = path.basename(basePath),
): string {
  if (!requestedPath.trim()) {
    throw new Error(`${label} path cannot be empty.`);
  }

  const resolvedBase = path.resolve(basePath);
  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(resolvedBase, requestedPath);

  if (!isInside(resolvedBase, candidate)) {
    throw new Error(`Path escapes ${label}: ${requestedPath}`);
  }

  // If basePath itself doesn't exist, there is nothing to escape into via a
  // symlink and no file to serve either way -- callers (fs.existsSync,
  // fs.readFileSync, res.sendFile) will naturally treat the resolved path as
  // not-found. Skip the realpath/symlink check rather than crash: confirmed
  // 2026-09-06, design-systems/ and public/ are not reliably present in
  // Vercel's deployed function bundle for this project, and this function is
  // called both at module-load time (sitemap.ts's SITEMAP_OUTPUT_PATH,
  // link-headers.ts's HOMEPAGE_PATH) and at request time (markdown-negotiation.ts,
  // agent-skills-index.ts) -- neither should hard-crash the whole app just
  // because a directory tree isn't bundled for this deployment target.
  if (!fs.existsSync(resolvedBase)) {
    return candidate;
  }

  const realBase = fs.realpathSync(resolvedBase);
  const existingAncestor = nearestExistingPath(candidate);
  const realAncestor = fs.realpathSync(existingAncestor);
  if (!isInside(realBase, realAncestor)) {
    throw new Error(`Path escapes ${label} through a symbolic link: ${requestedPath}`);
  }

  return candidate;
}

/**
 * Confirmed 2026-09-06 in production: design-systems/ is not present in
 * Vercel's deployed function bundle for this project, full stop -- neither
 * a literal __dirname-relative path nor findProjectRoot's dynamic walk finds
 * it there (both were tried and both genuinely fail; a literal-vs-dynamic
 * bundler-tracing difference was suspected but disproved by direct
 * production testing, so don't rely on that theory). The real fix for
 * production is that the catalog itself no longer depends on this directory
 * existing at runtime (see src/catalog-blob-repository.ts, which reads/writes
 * the registry from Vercel Blob instead). What stays true regardless of
 * *why* the directory is missing, and is what this function guards: nothing
 * computing PROJECT_ROOT may ever throw, because it is a module-level
 * constant evaluated the instant anything imports paths.ts, before request
 * handling or that Blob-backed fallback gets a chance to run.
 */
export function resolveProjectRootOrFallback(startPath: string): string {
  const literalRoot = path.join(startPath, '..');
  try {
    if (
      fs.existsSync(path.join(literalRoot, 'package.json')) &&
      fs.existsSync(path.join(literalRoot, 'design-systems')) &&
      fs.statSync(path.join(literalRoot, 'design-systems')).isDirectory()
    ) {
      return literalRoot;
    }
    return findProjectRoot(startPath);
  } catch {
    return literalRoot;
  }
}

/**
 * Never throw here: this is a module-level constant, evaluated the instant
 * anything imports paths.ts, before any request-handling or Blob-backed
 * fallback (src/catalog-blob-repository.ts) gets a chance to run. Confirmed
 * 2026-09-06: design-systems/ is not present in Vercel's deployed function
 * bundle at all for this project, so both the literal check and
 * findProjectRoot's walk genuinely fail in production -- throwing here would
 * crash every single request at module load, exactly the outage this
 * comment is here to prevent a regression of. Falling back to the literal
 * guess (even though its own existence check failed) keeps PROJECT_ROOT a
 * plausible absolute path so DESIGN_SYSTEMS_DIR/REGISTRY_PATH/PUBLIC_DIR
 * below stay well-formed; anything that still reads the filesystem through
 * them (readDesignFile, readBundleFile, resolvePublicPath) fails at that
 * specific request instead of poisoning the whole app at import time.
 */
export const PROJECT_ROOT = resolveProjectRootOrFallback(__dirname);
export const DESIGN_SYSTEMS_DIR = path.join(PROJECT_ROOT, 'design-systems');
export const REGISTRY_PATH = path.join(DESIGN_SYSTEMS_DIR, '.registry.json');
export const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
export const ENV_PATH = path.join(PROJECT_ROOT, '.env');

export function resolveDesignSystemPath(requestedPath: string): string {
  return resolvePathWithin(DESIGN_SYSTEMS_DIR, requestedPath, 'design-systems');
}

export function resolveDesignSystemInputPath(
  requestedPath: string,
  cwd = process.cwd(),
): string {
  const absolute = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(cwd, requestedPath);
  return resolvePathWithin(DESIGN_SYSTEMS_DIR, absolute, 'design-systems');
}

export function resolvePublicPath(requestedPath: string): string {
  return resolvePathWithin(PUBLIC_DIR, requestedPath, 'public');
}
