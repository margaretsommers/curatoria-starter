/**
 * publish-pack.ts — CLI for registering a paid bundle (.zip) product.
 *
 * Writes directly to .registry.json so the service picks it up immediately.
 *
 * Usage:
 *   npm run publish-pack -- \
 *     --id    starter-bundle \
 *     --zip   design-systems/starter-bundle.zip \
 *     --name  "Starter Bundle" \
 *     --price 0.03 \
 *     --desc  "Starter demo bundle" \
 *     --tags  demo,bundle
 */

import fs from 'fs';
import path from 'path';

// Resolve catalog.ts relative to this script (handles both ts-node and compiled)
const catalogPath = path.join(__dirname, '../src/catalog');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { appendEntry } = require(catalogPath) as typeof import('../src/catalog');

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const missing = ['id', 'zip', 'name', 'price'].filter(k => !args[k]);
if (missing.length) {
  console.error(`\nMissing required arguments: ${missing.map(k => `--${k}`).join(', ')}\n`);
  console.error('Usage:');
  console.error(
    '  npm run publish-pack -- --id <slug> --zip <path> --name "<name>" --price <usd>\n',
  );
  process.exit(1);
}

if (!/^[a-z0-9-]+$/.test(args.id)) {
  console.error('--id must be lowercase alphanumeric with hyphens only (e.g. "starter-bundle")');
  process.exit(1);
}

const priceNum = parseFloat(args.price);
if (isNaN(priceNum) || priceNum <= 0) {
  console.error('--price must be a positive decimal number (e.g. "0.03")');
  process.exit(1);
}

const zipPath = path.isAbsolute(args.zip) ? args.zip : path.resolve(process.cwd(), args.zip);
if (!fs.existsSync(zipPath)) {
  console.error(`\nZip file not found: ${zipPath}`);
  console.error('Make sure the bundle file exists first.\n');
  process.exit(1);
}

if (path.extname(zipPath).toLowerCase() !== '.zip') {
  console.error('--zip must point to a .zip file');
  process.exit(1);
}

const zipFilename = path.basename(zipPath);

const entry = {
  id: args.id,
  // Keep file populated for compatibility with existing registry consumers.
  file: zipFilename,
  resource_type: 'bundle_zip' as const,
  bundle_file: zipFilename,
  mime_type: 'application/zip',
  name: args.name,
  description: args.desc ?? args.description ?? '',
  price_usd: priceNum.toFixed(2),
  tags: args.tags ? args.tags.split(',').map((t: string) => t.trim()) : [],
  published_at: new Date().toISOString(),
  active: true,
};

appendEntry(entry);

console.log('');
console.log(`  ✓ Published bundle "${entry.name}"`);
console.log(`    ID:    ${entry.id}`);
console.log(`    File:  ${entry.bundle_file}`);
console.log(`    Price: $${entry.price_usd} USDC per download`);
if (entry.tags.length) console.log(`    Tags:  ${entry.tags.join(', ')}`);
console.log('');
console.log('  Download URL (once server is running):');
console.log(`    http://localhost:3000/packs/${entry.id}/download`);
console.log('');
