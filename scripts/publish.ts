/**
 * publish.ts — CLI for registering a design.md file with a price
 *
 * Writes directly to .registry.json without making HTTP requests,
 * so you don't need the server running to publish.
 *
 * Usage:
 *   npm run publish-design -- \
 *     --id    stripe-inspired \
 *     --file  design-systems/stripe-inspired.md \
 *     --name  "Stripe-Inspired Design System" \
 *     --price 0.05 \
 *     --desc  "Fintech tokens inspired by Stripe's design language" \
 *     --tags  fintech,stripe,clean
 *
 * The .md file must already exist in the design-systems/ directory.
 * To unlist a design system, set active: false in .registry.json manually.
 */

import fs from 'fs';
import path from 'path';

// Resolve catalog.ts relative to this script (handles both ts-node and compiled)
const catalogPath = path.join(__dirname, '../src/catalog');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { appendEntry } = require(catalogPath) as typeof import('../src/catalog');

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

const missing = ['id', 'file', 'name', 'price'].filter(k => !args[k]);
if (missing.length) {
  console.error(`\nMissing required arguments: ${missing.map(k => `--${k}`).join(', ')}\n`);
  console.error('Usage:');
  console.error(
    '  npm run publish-design -- --id <slug> --file <path> --name "<name>" --price <usd>\n',
  );
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

// Resolve the file path — accept both relative-to-cwd and absolute
const filePath = path.isAbsolute(args.file)
  ? args.file
  : path.resolve(process.cwd(), args.file);

if (!fs.existsSync(filePath)) {
  console.error(`\nFile not found: ${filePath}`);
  console.error('Make sure the .md file exists in the design-systems/ directory first.\n');
  process.exit(1);
}

// ─── Register ────────────────────────────────────────────────────────────────

const entry = {
  id: args.id,
  file: path.basename(filePath),
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
console.log(`    ID:    ${entry.id}`);
console.log(`    File:  ${entry.file}`);
console.log(`    Price: $${entry.price_usd} USDC per access`);
if (entry.tags.length) console.log(`    Tags:  ${entry.tags.join(', ')}`);
console.log('');
console.log(`  Access URL (once server is running):`);
console.log(`    http://localhost:3000/design-systems/${entry.id}`);
console.log('');
