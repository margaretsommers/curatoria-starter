/**
 * publish-pack.ts — CLI for registering a paid bundle (.zip) product.
 *
 * Writes directly to .registry.json so the service picks it up immediately.
 *
 * Usage (local zip in design-systems/):
 *   npm run publish-pack -- \
 *     --id    starter-bundle \
 *     --zip   design-systems/starter-bundle.zip \
 *     --name  "Starter Bundle" \
 *     --price 0.03 \
 *     --desc  "Starter demo bundle" \
 *     --tags  demo,bundle
 *
 * Usage (remote URL on your own domain / CDN):
 *   npm run publish-pack -- --id my-pack --url https://files.yourdomain.com/my-pack.zip \
 *     --name "My Pack" --price 0.10
 *
 * Usage (Google Drive zip shared "Anyone with the link can view"):
 *   npm run publish-pack -- --id my-pack --gdrive-id 1AbC...xyz \
 *     --name "My Pack" --price 0.10
 *
 * Usage (Dropbox share URL, Mode A link-share):
 *   npm run publish-pack -- --id my-pack --dropbox-url "https://www.dropbox.com/s/.../my-pack.zip?dl=0" \
 *     --name "My Pack" --price 0.10
 *
 * Usage (Dropbox private file path, Mode B OAuth):
 *   npm run publish-pack -- --id my-pack --dropbox-path "/Design Systems/my-pack.zip" \
 *     --name "My Pack" --price 0.10
 *
 * Provide exactly one of --zip, --url, --gdrive-id, --dropbox-url, or --dropbox-path.
 */

import fs from 'fs';
import path from 'path';

// Resolve src modules relative to this script (handles both ts-node and compiled)
const catalogPath = path.join(__dirname, '../src/catalog');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { appendEntry } = require(catalogPath) as typeof import('../src/catalog');
const sourcesPath = path.join(__dirname, '../src/sources');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildSource } = require(sourcesPath) as typeof import('../src/sources');

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

const missing = ['id', 'name', 'price'].filter(k => !args[k]);
if (missing.length) {
  console.error(`\nMissing required arguments: ${missing.map(k => `--${k}`).join(', ')}\n`);
  console.error('Usage (choose one source):');
  console.error('  npm run publish-pack -- --id <slug> --zip <path>         --name "<name>" --price <usd>');
  console.error('  npm run publish-pack -- --id <slug> --url <https://...>  --name "<name>" --price <usd>');
  console.error('  npm run publish-pack -- --id <slug> --gdrive-id <id>     --name "<name>" --price <usd>');
  console.error('  npm run publish-pack -- --id <slug> --dropbox-url <https://www.dropbox.com/...> --name "<name>" --price <usd>');
  console.error('  npm run publish-pack -- --id <slug> --dropbox-path </path/in/dropbox> --name "<name>" --price <usd>\n');
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

// ─── Resolve storage source (local zip, remote URL, or Google Drive) ──────────

let built: { file: string; source?: import('../src/types').EntrySource };
try {
  built = buildSource({
    id: args.id,
    file: args.zip,
    url: args.url,
    gdriveId: args['gdrive-id'],
    dropboxUrl: args['dropbox-url'],
    dropboxPath: args['dropbox-path'],
    kind: 'bundle_zip',
  });
} catch (err) {
  console.error(`\n${String(err instanceof Error ? err.message : err)}\n`);
  process.exit(1);
}

// For local bundles, confirm the .zip is actually on disk before registering.
if (!built.source && args.zip) {
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
}

const entry = {
  id: args.id,
  // Keep file populated for compatibility with existing registry consumers.
  file: built.file,
  resource_type: 'bundle_zip' as const,
  bundle_file: built.file,
  ...(built.source ? { source: built.source } : {}),
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
console.log(`    ID:     ${entry.id}`);
console.log(
  `    Source: ${
    entry.source
      ? `${entry.source.type} (${entry.source.url ?? entry.source.file_id ?? entry.source.share_url ?? entry.source.dropbox_path})`
      : `local (${entry.bundle_file})`
  }`,
);
console.log(`    Price:  $${entry.price_usd} USDC per download`);
if (entry.tags.length) console.log(`    Tags:  ${entry.tags.join(', ')}`);
console.log('');
console.log('  Download URL (once server is running):');
console.log(`    http://localhost:3000/packs/${entry.id}/download`);
console.log('');
