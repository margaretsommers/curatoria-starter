#!/usr/bin/env ts-node

import path from 'node:path';

import {
  continueCuratoriaEntitlement,
  downloadCuratoriaAsset,
  MAX_ENTITLEMENT_STDIN_BYTES,
  parseEntitlementContinuation,
  resumeCuratoriaDownload,
} from '../src/agent-downloader';
import {
  DEFAULT_SESSION_CAP_ATOMIC,
  SpendBudget,
} from '../src/spend-budget';
import {
  createAgentCashEntitlementPurchaser,
  createAwalEntitlementPurchaser,
  createExternalEntitlementPurchaser,
  type EntitlementPurchaserAdapter,
} from '../src/wallet-purchasers';
import type { CollisionPolicy } from '../src/destination-preflight';

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
  walletMode?: 'private-key' | 'awal' | 'agentcash' | 'external' | 'dry-run';
  walletExecutable?: string;
  awalExecutable?: string;
  agentCashExecutable?: string;
  walletArgs: string[];
  resumeState?: string;
  collisionPolicy?: CollisionPolicy;
  entitlementStdin?: boolean;
  sessionBudgetFile?: string;
  sessionBudgetAtomic?: number;
  prepareExternalPayment?: boolean;
  purchaseContext?: string;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.resumeState) {
    const result = await resumeCuratoriaDownload(options.resumeState);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (!options.productId) {
    usage(1, 'Missing --product-id.');
    return;
  }
  if (options.entitlementStdin) {
    if (
      options.walletMode ||
      options.walletExecutable ||
      options.awalExecutable ||
      options.agentCashExecutable ||
      options.privateKeyEnv ||
      options.prepareExternalPayment ||
      options.sessionBudgetFile
    ) {
      usage(
        1,
        '--entitlement-stdin cannot be combined with wallet, payment, or session-budget options.',
      );
    }
    const purchase = parseEntitlementContinuation(await readBoundedStdin());
    const result = await continueCuratoriaEntitlement(
      {
        catalogUrl: options.catalogUrl,
        productId: options.productId,
        out: options.out,
        yes: options.yes,
        maxAmountAtomic: options.maxAmountAtomic,
        maxDirectBytes: options.maxDirectBytes,
        allowedDomains: options.allowedDomains.length
          ? options.allowedDomains
          : undefined,
        collisionPolicy: options.collisionPolicy,
        isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        prompt: promptLine,
      },
      purchase,
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (options.prepareExternalPayment) {
    if (!options.purchaseContext) {
      usage(1, '--prepare-external-payment requires --purchase-context with an absolute path.');
    }
    if (
      options.walletMode ||
      options.walletExecutable ||
      options.awalExecutable ||
      options.agentCashExecutable ||
      options.privateKeyEnv ||
      options.entitlementStdin
    ) {
      usage(
        1,
        '--prepare-external-payment cannot be combined with wallet or entitlement-stdin.',
      );
    }
  }
  if (
    options.purchaseContext &&
    !path.isAbsolute(options.purchaseContext)
  ) {
    usage(1, '--purchase-context must be an absolute path.');
  }

  const spendBudget = await openSessionBudget(options);
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
    entitlementPurchaser: createEntitlementPurchaser(options),
    collisionPolicy: options.collisionPolicy,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt: promptLine,
    spendBudget,
    prepareExternalPayment: options.prepareExternalPayment,
    purchaseContextPath: options.purchaseContext,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok
    ? 0
    : result.code === 'dry_run_ready' || result.code === 'prepared_external_payment'
      ? 0
      : 1;
}

async function openSessionBudget(options: CliOptions): Promise<SpendBudget | undefined> {
  if (!options.sessionBudgetFile) {
    if (
      options.prepareExternalPayment ||
      (options.walletMode && options.walletMode !== 'dry-run')
    ) {
      usage(1, 'Paid wallet and --prepare-external-payment require --session-budget-file with an absolute path.');
    }
    return undefined;
  }
  if (!path.isAbsolute(options.sessionBudgetFile)) {
    usage(1, '--session-budget-file must be an absolute path.');
  }
  return SpendBudget.open(
    options.sessionBudgetFile,
    options.sessionBudgetAtomic ?? DEFAULT_SESSION_CAP_ATOMIC,
  );
}

function createEntitlementPurchaser(
  options: CliOptions,
): EntitlementPurchaserAdapter | undefined {
  if (options.walletMode === 'awal') {
    if (!options.awalExecutable) {
      throw new Error('--wallet awal requires --awal-executable with an absolute preinstalled awal path.');
    }
    return createAwalEntitlementPurchaser(options.awalExecutable);
  }
  if (options.walletMode === 'agentcash') {
    if (!options.agentCashExecutable) {
      throw new Error('--wallet agentcash requires --agentcash-executable with an absolute preinstalled agentcash path.');
    }
    return createAgentCashEntitlementPurchaser(options.agentCashExecutable);
  }
  if (options.walletMode === 'external' && options.walletExecutable) {
    return createExternalEntitlementPurchaser(options.walletExecutable, options.walletArgs);
  }
  return undefined;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { allowedDomains: [], walletArgs: [] };

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
    else if (arg === '--resume-state') options.resumeState = next();
    else if (arg === '--entitlement-stdin') options.entitlementStdin = true;
    else if (arg === '--session-budget-file') options.sessionBudgetFile = next();
    else if (arg === '--session-budget') options.sessionBudgetAtomic = parsePositiveInteger(next(), '--session-budget');
    else if (arg === '--prepare-external-payment') options.prepareExternalPayment = true;
    else if (arg === '--purchase-context') options.purchaseContext = next();
    else if (arg === '--on-collision') {
      const policy = next();
      if (!['ask', 'number', 'replace', 'cancel'].includes(policy)) {
        usage(1, `Unsupported --on-collision value: ${policy}`);
      }
      options.collisionPolicy = policy as CollisionPolicy;
    }
    else if (arg === '--awal-executable') options.awalExecutable = next();
    else if (arg === '--agentcash-executable') options.agentCashExecutable = next();
    else if (arg === '--wallet-executable') {
      options.walletExecutable = next();
      options.walletMode = 'external';
    } else if (arg === '--wallet-arg') {
      options.walletArgs.push(next());
    }
    else if (arg === '--payment-header') {
      usage(1, '--payment-header is no longer supported. Use --private-key-env or a signer adapter so each request creates a fresh x402 payment payload.');
    } else if (arg === '--private-key-env') {
      options.privateKeyEnv = next();
      options.walletMode = 'private-key';
    } else if (arg === '--wallet') {
      const wallet = next();
      if (!['awal', 'agentcash', 'private-key', 'external', 'dry-run'].includes(wallet)) {
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
  npm run agent-download -- --product-id curatoria-psd-drive --wallet awal --awal-executable /absolute/path/to/awal --out ~/Downloads
  npm run agent-download -- --product-id curatoria-psd-drive --wallet agentcash --agentcash-executable /absolute/path/to/agentcash --out ~/Downloads
  npm run agent-download -- --resume-state ~/.curatoria-download-state.json

Options:
  --catalog <url>             Catalog URL (default: https://curatoria.dev/.well-known/design-catalog.json)
  --product-id, --id <id>     Catalog product id to buy
  --out <path>                Destination file or directory (default: ~/Downloads/<filename>)
  --yes, -y                   Approve the exact validated spend without an interactive y/n prompt
  --dry-run                   Validate catalog, challenge, and spend boundaries without paying
  --max-amount <atomic>       Max USDC atomic units allowed (default: 10000 = $0.01)
  --allow-domain <domain>     Trust a creator domain in addition to localhost
  --private-key-env <name>    Env var containing a funded test wallet private key for fresh x402 signing
  --wallet awal               Let awal buy entitlement JSON; Curatoria downloads and saves the file (deprecated, prefer agentcash or the generic wallet bridge below)
  --awal-executable <path>    Absolute path to a reviewed, preinstalled awal executable
  --wallet agentcash          Let Agent Cash (agentcash.dev) buy entitlement JSON; Curatoria downloads and saves the file
  --agentcash-executable <path> Absolute path to a reviewed, preinstalled agentcash executable
  --wallet-executable <path>  Absolute generic JSON-stdin wallet bridge for any other agentic wallet (advanced adapter)
  --wallet-arg <value>        Repeatable argument passed without a shell to the wallet bridge
  --resume-state <path>       Resume a paid partial download without paying again
  --entitlement-stdin         Continue from entitlement JSON on stdin; never invokes a wallet
  --session-budget-file <path> Absolute mode-0600 JSON ledger for the four-cent session cap
  --session-budget <atomic>   Session cap (default: 40000 = $0.04)
  --prepare-external-payment  Destination/challenge/budget preflight only; writes --purchase-context
  --purchase-context <path>   Absolute mode-0600 file for the frozen external-payment challenge
  --on-collision <policy>     ask, number, replace, or cancel
`);
  process.exit(exitCode);
}

async function readBoundedStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_ENTITLEMENT_STDIN_BYTES) {
      throw new Error(
        `Entitlement stdin exceeds the ${MAX_ENTITLEMENT_STDIN_BYTES}-byte limit.`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

async function promptLine(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
