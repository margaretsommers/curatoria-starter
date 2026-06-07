/**
 * publish.ts — CLI for registering a design.md file with a price
 *
 * Writes directly to .registry.json without making HTTP requests,
 * so you don't need the server running to publish.
 *
 * Usage (local file in design-systems/):
 *   npm run publish-design -- \
 *     --id    stripe-inspired \
 *     --file  design-systems/stripe-inspired.md \
 *     --name  "Stripe-Inspired Design System" \
 *     --price 0.05 \
 *     --desc  "Fintech tokens inspired by Stripe's design language" \
 *     --tags  fintech,stripe,clean
 *
 * Usage (remote URL on your own domain / CDN):
 *   npm run publish-design -- --id my-doc --url https://files.yourdomain.com/my-doc.md \
 *     --name "My Doc" --price 0.05
 *
 * Usage (Google Drive file shared "Anyone with the link can view"):
 *   npm run publish-design -- --id my-doc --gdrive-id 1AbC...xyz \
 *     --name "My Doc" --price 0.05
 *   (You can also paste the full Drive share link to --gdrive-id.)
 *
 * Usage (Dropbox share URL, Mode A link-share):
 *   npm run publish-design -- --id my-doc --dropbox-url "https://www.dropbox.com/s/.../my-doc.md?dl=0" \
 *     --name "My Doc" --price 0.05
 *
 * Usage (Dropbox private file path, Mode B OAuth):
 *   npm run publish-design -- --id my-doc --dropbox-path "/Design Systems/my-doc.md" \
 *     --name "My Doc" --price 0.05
 *
 * Provide exactly one of --file, --url, --gdrive-id, --dropbox-url, or --dropbox-path. For --file the .md must
 * already exist in design-systems/. To unlist, set active: false in .registry.json.
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

// ─── Arg parser ───────────────────────────────────────────────────────────────

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

// ─── Validation ───────────────────────────────────────────────────────────────

const missing = ['id', 'name', 'price'].filter(k => !args[k]);
if (missing.length) {
  console.error(`\nMissing required arguments: ${missing.map(k => `--${k}`).join(', ')}\n`);
  console.error('Usage (choose one source):');
  console.error('  npm run publish-design -- --id <slug> --file <path>       --name "<name>" --price <usd>');
  console.error('  npm run publish-design -- --id <slug> --url <https://...> --name "<name>" --price <usd>');
  console.error('  npm run publish-design -- --id <slug> --gdrive-id <id>    --name "<name>" --price <usd>');
  console.error('  npm run publish-design -- --id <slug> --dropbox-url <https://www.dropbox.com/...> --name "<name>" --price <usd>');
  console.error('  npm run publish-design -- --id <slug> --dropbox-path </path/in/dropbox> --name "<name>" --price <usd>\n');
  process.exit(1);
}

if (!/^[a-z0-9-]+$/.test(args.id)) {
  console.error('--id must be lowercase alphanumeric with hyphens only (e.g. "stripe-inspired")');
  process.exit(1);
}

const priceNum = parseFloat(args.price);
if (isNaN(priceNum) || priceNum <= 0) {
  console.error('--price must be a positive decimal number (e.g. "0.01" for $0.01 USDC)');
  process.exit(1);
}

// ─── Resolve storage source (local file, remote URL, or Google Drive) ─────────

let built: { file: string; source?: import('../src/types').EntrySource };
try {
  built = buildSource({
    id: args.id,
    file: args.file,
    url: args.url,
    gdriveId: args['gdrive-id'],
    dropboxUrl: args['dropbox-url'],
    dropboxPath: args['dropbox-path'],
    kind: 'design_md',
  });
} catch (err) {
  console.error(`\n${String(err instanceof Error ? err.message : err)}\n`);
  process.exit(1);
}

// For local files, confirm the file is actually on disk before registering.
if (!built.source && args.file) {
  const filePath = path.isAbsolute(args.file)
    ? args.file
    : path.resolve(process.cwd(), args.file);
  if (!fs.existsSync(filePath)) {
    console.error(`\nFile not found: ${filePath}`);
    console.error('Make sure the .md file exists in the design-systems/ directory first.\n');
    process.exit(1);
  }
}

// ─── Register ────────────────────────────────────────────────────────────────

const entry = {
  id: args.id,
  file: built.file,
  ...(built.source ? { source: built.source } : {}),
  name: args.name,
  description: args.desc ?? args.description ?? '',
  price_usd: priceNum.toFixed(2),
  tags: args.tags ? args.tags.split(',').map((t: string) => t.trim()) : [],
  published_at: new Date().toISOString(),
  active: true,
};

appendEntry(entry);

console.log('');
console.log(`  ✓ Published "${entry.name}"`);
console.log(`    ID:     ${entry.id}`);
console.log(
  `    Source: ${
    entry.source
      ? `${entry.source.type} (${entry.source.url ?? entry.source.file_id ?? entry.source.share_url ?? entry.source.dropbox_path})`
      : `local (${entry.file})`
  }`,
);
console.log(`    Price:  $${entry.price_usd} USDC per access`);
if (entry.tags.length) console.log(`    Tags:  ${entry.tags.join(', ')}`);
console.log('');
console.log(`  Access URL (once server is running):`);
console.log(`    http://localhost:3000/design-systems/${entry.id}`);
console.log('');
