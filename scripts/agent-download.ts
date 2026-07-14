#!/usr/bin/env ts-node

import { downloadCuratoriaAsset } from '../src/agent-downloader';

type CliOptions = {
  catalogUrl?: string;
  productId?: string;
  out?: string;
  yes?: boolean;
  dryRun?: boolean;
  maxAmountAtomic?: number;
  maxDirectBytes?: number;
  allowedDomains: string[];
  privateKeyEnv?: string;
  walletMode?: 'private-key' | 'awal' | 'dry-run';
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.productId) {
    usage(1, 'Missing --product-id.');
    return;
  }

  const result = await downloadCuratoriaAsset({
    catalogUrl: options.catalogUrl,
    productId: options.productId,
    out: options.out,
    yes: options.yes,
    dryRun: options.dryRun,
    maxAmountAtomic: options.maxAmountAtomic,
    maxDirectBytes: options.maxDirectBytes,
    allowedDomains: options.allowedDomains.length ? options.allowedDomains : undefined,
    privateKeyEnv: options.privateKeyEnv,
    walletMode: options.walletMode,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : result.code === 'dry_run_ready' ? 0 : 1;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { allowedDomains: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = (): string => {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        usage(1, `Missing value for ${arg}.`);
      }
      index += 1;
      return value;
    };

    if (arg === '--catalog') options.catalogUrl = next();
    else if (arg === '--product-id' || arg === '--id') options.productId = next();
    else if (arg === '--out') options.out = next();
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--dry-run') {
      options.dryRun = true;
      options.walletMode = 'dry-run';
    } else if (arg === '--max-amount') options.maxAmountAtomic = parsePositiveInteger(next(), '--max-amount');
    else if (arg === '--max-direct-bytes') options.maxDirectBytes = parsePositiveInteger(next(), '--max-direct-bytes');
    else if (arg === '--allow-domain') options.allowedDomains.push(next());
    else if (arg === '--payment-header') {
      usage(1, '--payment-header is no longer supported. Use --private-key-env or a signer adapter so each request creates a fresh x402 payment payload.');
    } else if (arg === '--private-key-env') {
      options.privateKeyEnv = next();
      options.walletMode = 'private-key';
    } else if (arg === '--wallet') {
      const wallet = next();
      if (!['awal', 'private-key', 'dry-run'].includes(wallet)) {
        usage(1, `Unsupported --wallet value: ${wallet}`);
      }
      options.walletMode = wallet as CliOptions['walletMode'];
    } else if (arg === '--help' || arg === '-h') {
      usage(0);
    } else {
      usage(1, `Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parsePositiveInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    usage(1, `${flag} must be a positive integer.`);
  }
  return Number(value);
}

function usage(exitCode: number, message?: string): never {
  if (message) {
    process.stderr.write(`${message}\n\n`);
  }
  process.stderr.write(`Usage:
  npm run agent-download -- --product-id curatoria-demo-md --dry-run
  npm run agent-download -- --product-id curatoria-demo-md --yes --private-key-env CURATORIA_BUYER_PRIVATE_KEY

Options:
  --catalog <url>             Catalog URL (default: https://curatoria.dev/.well-known/design-catalog.json)
  --product-id, --id <id>     Catalog product id to buy
  --out <path>                Destination file or directory (default: ~/Downloads/<filename>)
  --yes, -y                   Approve the exact validated spend without an interactive y/n prompt
  --dry-run                   Validate catalog, challenge, and spend boundaries without paying
  --max-amount <atomic>       Max USDC atomic units allowed (default: 10000 = $0.01)
  --allow-domain <domain>     Trust a creator domain in addition to localhost
  --private-key-env <name>    Env var containing a funded test wallet private key for fresh x402 signing
  --wallet awal               Report that awal is settlement/debug only for this downloader
`);
  process.exit(exitCode);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
