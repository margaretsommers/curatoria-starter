import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/paths';

export type StarterPathClass = 'shared' | 'generated' | 'preserved' | 'forbidden';

type StarterManifest = Record<StarterPathClass, string[]>;

export type BoundaryFinding = {
  path: string;
  reason: string;
};

const MANIFEST_PATH = path.join(PROJECT_ROOT, 'starter-export.manifest.json');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as StarterManifest;

function normalize(relativePath: string): string {
  return relativePath.split(path.sep).join('/').replace(/^\.\//, '');
}

function matches(rule: string, relativePath: string): boolean {
  if (rule.endsWith('/')) {
    return relativePath === rule.slice(0, -1) || relativePath.startsWith(rule);
  }
  if (rule.includes('*')) {
    const escaped = rule
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`).test(relativePath);
  }
  return relativePath === rule;
}

export function classifyStarterPath(relativePath: string): StarterPathClass {
  const normalized = normalize(relativePath);
  if (manifest.forbidden.some(rule => matches(rule, normalized))) return 'forbidden';
  for (const classification of ['preserved', 'shared', 'generated'] as const) {
    if (manifest[classification].some(rule => matches(rule, normalized))) {
      return classification;
    }
  }
  return 'forbidden';
}

function canContainAllowedPath(relativePath: string): boolean {
  const prefix = `${normalize(relativePath).replace(/\/$/, '')}/`;
  return (['preserved', 'shared', 'generated'] as const).some(classification =>
    manifest[classification].some(rule => rule.startsWith(prefix)),
  );
}

function listFiles(root: string, current = root): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = normalize(path.relative(root, absolute));
    if (classifyStarterPath(relative) === 'preserved') continue;
    if (entry.isSymbolicLink()) {
      files.push(relative);
    } else if (entry.isDirectory()) {
      if (
        classifyStarterPath(relative) === 'forbidden' &&
        !canContainAllowedPath(relative)
      ) {
        files.push(`${relative}/`);
      } else {
        files.push(...listFiles(root, absolute));
      }
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

function pathFinding(relativePath: string): string | undefined {
  const lower = relativePath.toLowerCase();
  const basename = path.posix.basename(lower);
  if (basename === '.env' || (basename.startsWith('.env.') && basename !== '.env.example')) {
    return 'Environment file is not allowed; only .env.example may be exported.';
  }
  if (/(^|\/)(wallet|keystore)(\.|\/|$)/i.test(relativePath)) {
    return 'Wallet or keystore artifacts are forbidden.';
  }
  if (/(^|\/)(receipts?|payment-receipts?)(\/|\.|$)/i.test(relativePath)) {
    return 'Payment receipt artifacts are forbidden.';
  }
  if (/(^|\/)docs\/operator(\/|$)/i.test(relativePath)) {
    return 'Operator-only documentation is forbidden.';
  }
  if (lower.endsWith('.psd') && !normalize(relativePath).startsWith('test/fixtures/psd/')) {
    return 'PSD source assets are operator-only.';
  }
  if (lower.includes('shader')) return 'Shader brand assets are operator-only.';
  return undefined;
}

function contentFinding(relativePath: string, content: string): string | undefined {
  const walletSecretLabel = String.raw`(?:private[_ -]?key|seed[_ -]?phrase|mnemonic)`;
  const privateKey = String.raw`(?:0x)?[a-f0-9]{64}`;
  const mnemonic = String.raw`[a-z]+(?:\s+[a-z]+){11}(?:(?:\s+[a-z]+){3}){0,4}`;
  if (
    new RegExp(
      String.raw`${walletSecretLabel}["']?\s*[:=]\s*["']?(?:${privateKey}|${mnemonic})(?=["'\s,;}]|$)`,
      'i',
    ).test(content)
  ) {
    return 'Wallet secret material detected.';
  }
  if (/alchemy\.com\/v2\/[A-Za-z0-9_-]{16,}/i.test(content)) {
    return 'Provider credential detected.';
  }
  if (/BLOB_READ_WRITE_TOKEN\s*=\s*(?!your-|replace-|example|$)[A-Za-z0-9_-]{16,}/i.test(content)) {
    return 'Blob credential detected.';
  }
  if (
    /\.(?:css|html)$/i.test(relativePath) &&
    /shader-gradient-root|styles-shader\.css/i.test(content)
  ) {
    return 'Shader brand implementation detected.';
  }
  return undefined;
}

export function scanStarterBoundary(root: string): BoundaryFinding[] {
  const findings: BoundaryFinding[] = [];
  for (const relativePath of listFiles(root)) {
    const classification = classifyStarterPath(relativePath);
    if (classification === 'forbidden') {
      findings.push({
        path: relativePath,
        reason: pathFinding(relativePath) ?? 'Path is not allowed by the starter export manifest.',
      });
      continue;
    }

    const specificPathFinding = pathFinding(relativePath);
    if (specificPathFinding) {
      findings.push({ path: relativePath, reason: specificPathFinding });
      continue;
    }

    const absolute = path.join(root, relativePath);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      findings.push({ path: relativePath, reason: 'Symbolic links are not allowed in starter exports.' });
      continue;
    }
    if (stat.size > 1024 * 1024) continue;
    if (
      relativePath === 'scripts/check-starter-boundary.ts' ||
      relativePath === 'src/starter-boundary.test.ts' ||
      relativePath === 'starter-export.manifest.json'
    ) {
      continue;
    }
    const buffer = fs.readFileSync(absolute);
    if (buffer.includes(0)) continue;
    const reason = contentFinding(relativePath, buffer.toString('utf8'));
    if (reason) findings.push({ path: relativePath, reason });
  }
  return findings;
}

export function checkStarterBoundary(root: string): void {
  const findings = scanStarterBoundary(root);
  if (findings.length === 0) return;
  for (const finding of findings) {
    console.error(`${finding.path}: ${finding.reason}`);
  }
  throw new Error(`Starter boundary check failed with ${findings.length} finding(s).`);
}

if (require.main === module) {
  const root = path.resolve(process.argv[2] ?? PROJECT_ROOT);
  try {
    checkStarterBoundary(root);
    console.log(`Starter boundary check passed (${root}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Starter boundary check failed.');
    process.exitCode = 1;
  }
}
