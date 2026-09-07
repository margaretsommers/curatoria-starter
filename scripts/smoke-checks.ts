/**
 * Shared smoke checks for local smoke and bug-bash scripts.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { isPaymentRequiredV2, validatePaymentRequired } from '@x402/core/schemas';
import { createObservabilityEvent } from '../src/observability';
import { assertPreviewAllowed, PREVIEW_WALLET } from '../src/paid-psd-harness';

export type CheckResult = { name: string; ok: boolean; detail: string };

export type SmokeCheckOptions = {
  markdownId?: string;
  bundleId?: string;
  binaryAssetId?: string;
};

export type PaidCheckTarget = {
  id: string;
  url: string;
  kind: 'markdown' | 'bundle';
};

const DEFAULT_MARKDOWN_ID = 'curatoria-demo-md';
const DEFAULT_BUNDLE_ID = 'curatoria-demo-pack';
const ROOT_DIR = path.resolve(__dirname, '..');
const DESIGN_SYSTEMS_DIR = path.join(ROOT_DIR, 'design-systems');

export async function checkHealth(baseUrl: string): Promise<CheckResult> {
  const res = await fetch(`${baseUrl}/health`);
  if (!res.ok) {
    return { name: 'health', ok: false, detail: `expected 200, got ${res.status}` };
  }
  const body = (await res.json()) as { status?: string; network?: string; wallet?: string };
  const ok = body.status === 'ok';
  const detail = ok
    ? `status ok (${body.network ?? 'unknown network'}, wallet ${shortAddress(body.wallet)})`
    : 'missing status=ok';
  return { name: 'health', ok, detail };
}

export async function checkFreeCatalog(baseUrl: string): Promise<CheckResult> {
  const res = await fetch(`${baseUrl}/.well-known/design-catalog.json`);
  if (!res.ok) {
    return { name: 'free catalog', ok: false, detail: `expected 200, got ${res.status}` };
  }
  const body = (await res.json()) as {
    total?: number;
    design_systems?: Array<{ id?: string; price_usd?: string; access_url?: string }>;
    paid_catalog_url?: string;
  };

  const products = body.design_systems ?? [];
  const first = products[0];
  const hasProductList = products.length > 0;
  const hasMetadata = Boolean(first?.id && first?.price_usd && first?.access_url);
  const isTeaser = typeof body.paid_catalog_url === 'string' && !hasProductList;

  if (isTeaser) {
    return {
      name: 'free catalog',
      ok: true,
      detail: 'SKIP (server has CATALOG_PAYWALL_ENABLED=1 — teaser only at well-known)',
    };
  }

  const ok = hasProductList && hasMetadata;
  return {
    name: 'free catalog',
    ok,
    detail: ok
      ? `${products.length} product(s) with id, price_usd, access_url at well-known`
      : `expected design_systems[] with metadata (total ${body.total ?? 0})`,
  };
}

export async function checkCatalogFreeAlias(baseUrl: string): Promise<CheckResult> {
  const res = await fetch(`${baseUrl}/catalog`);
  if (res.status === 402) {
    return {
      name: 'catalog free alias',
      ok: true,
      detail: 'SKIP (CATALOG_PAYWALL_ENABLED=1 — /catalog is paid on this server)',
    };
  }
  if (!res.ok) {
    return { name: 'catalog free alias', ok: false, detail: `expected 200, got ${res.status}` };
  }
  const body = (await res.json()) as { design_systems?: unknown[] };
  const ok = Array.isArray(body.design_systems) && body.design_systems.length > 0;
  return {
    name: 'catalog free alias',
    ok,
    detail: ok
      ? `GET /catalog returns free listing (${body.design_systems?.length ?? 0} products)`
      : 'expected design_systems[] at /catalog',
  };
}

export async function checkWellKnownSanity(baseUrl: string): Promise<CheckResult[]> {
  const res = await fetch(`${baseUrl}/.well-known/design-catalog.json`);
  if (!res.ok) {
    return [{ name: 'well-known sanity', ok: false, detail: `expected 200, got ${res.status}` }];
  }

  const body = (await res.json()) as {
    owner?: { wallet?: string; name?: string; url?: string };
    total?: number;
    base_url?: string;
    paid_catalog_url?: string;
    design_systems?: Array<{
      id?: string;
      price_usd?: string;
      access_url?: string;
      active?: boolean;
      source?: unknown;
      file?: unknown;
    }>;
  };

  if (typeof body.paid_catalog_url === 'string' && !Array.isArray(body.design_systems)) {
    return [
      {
        name: 'well-known sanity',
        ok: true,
        detail: 'SKIP (Track B teaser — use checkTeaserSanity or enable full catalog)',
      },
    ];
  }

  const checks: CheckResult[] = [];

  const wallet = body.owner?.wallet ?? '';
  checks.push({
    name: 'well-known owner wallet',
    ok: Boolean(wallet) && !wallet.includes('YOUR_WALLET') && wallet.startsWith('0x'),
    detail: wallet ? shortAddress(wallet) : 'missing owner.wallet',
  });

  const responseBaseUrl = body.base_url ?? '';
  const baseUrlOk =
    responseBaseUrl.startsWith('https://') ||
    responseBaseUrl.startsWith('http://localhost') ||
    responseBaseUrl.startsWith('http://127.0.0.1');
  checks.push({
    name: 'well-known base_url',
    ok: baseUrlOk,
    detail: responseBaseUrl || 'missing base_url',
  });

  const activeProducts = (body.design_systems ?? []).filter((entry) => entry.active !== false);
  checks.push({
    name: 'well-known has active products',
    ok: activeProducts.length > 0,
    detail: `${activeProducts.length} active product(s)`,
  });

  const first = activeProducts[0];
  checks.push({
    name: 'well-known product metadata',
    ok: Boolean(first?.id && first?.price_usd && first?.access_url),
    detail: first?.id ? `${first.id} @ ${first.price_usd} USD` : 'no active product metadata',
  });

  const leakedStorage = (body.design_systems ?? []).some(
    (entry) => entry.source !== undefined || entry.file !== undefined,
  );
  checks.push({
    name: 'well-known no storage leakage',
    ok: !leakedStorage,
    detail: leakedStorage ? 'catalog leaked source/file fields' : 'no storage URLs or file paths',
  });

  return checks;
}

/** Track B only: teaser shape at well-known */
export async function checkTeaserSanity(baseUrl: string): Promise<CheckResult[]> {
  const res = await fetch(`${baseUrl}/.well-known/design-catalog.json`);
  if (!res.ok) {
    return [{ name: 'teaser sanity', ok: false, detail: `expected 200, got ${res.status}` }];
  }

  const body = (await res.json()) as {
    owner?: { wallet?: string; name?: string; url?: string };
    total?: number;
    paid_catalog_url?: string;
    design_systems?: unknown;
  };

  if (Array.isArray(body.design_systems)) {
    return [
      {
        name: 'teaser sanity',
        ok: true,
        detail: 'SKIP (Track A — full catalog at well-known, not teaser)',
      },
    ];
  }

  const checks: CheckResult[] = [];

  const wallet = body.owner?.wallet ?? '';
  checks.push({
    name: 'teaser owner wallet',
    ok: Boolean(wallet) && !wallet.includes('YOUR_WALLET') && wallet.startsWith('0x'),
    detail: wallet ? shortAddress(wallet) : 'missing owner.wallet',
  });

  checks.push({
    name: 'teaser product count',
    ok: typeof body.total === 'number' && body.total > 0,
    detail: `${body.total ?? 0} active product(s)`,
  });

  checks.push({
    name: 'teaser no product leakage',
    ok: !Array.isArray(body.design_systems),
    detail: Array.isArray(body.design_systems)
      ? 'design_systems must not appear in free teaser'
      : 'no product IDs or access_url in teaser',
  });

  checks.push({
    name: 'teaser paid_catalog_url',
    ok: typeof body.paid_catalog_url === 'string' && body.paid_catalog_url.includes('/catalog'),
    detail: body.paid_catalog_url ?? 'missing paid_catalog_url',
  });

  return checks;
}

export async function checkUnpaidCatalog402(baseUrl: string): Promise<CheckResult> {
  const res = await fetch(`${baseUrl}/catalog`);
  if (res.status !== 402) {
    return {
      name: 'unpaid catalog challenge',
      ok: true,
      detail: `SKIP (server returned ${res.status}; Track A free /catalog)`,
    };
  }

  const challenge = await readPaymentChallenge(`${baseUrl}/catalog`);
  return {
    name: 'unpaid catalog challenge',
    ok: challenge.ok && challenge.hasBazaarExtension === true,
    detail: challenge.ok
      ? `status 402 with payment challenge${challenge.hasBazaarExtension ? ' + Bazaar metadata' : ', missing Bazaar metadata'}`
      : challenge.detail,
  };
}

export async function checkCatalogPerFetch402(baseUrl: string): Promise<CheckResult> {
  const first = await fetch(`${baseUrl}/catalog`);
  if (first.status !== 402) {
    return {
      name: 'catalog per-fetch 402',
      ok: true,
      detail: `SKIP (server returned ${first.status}; Track A free /catalog)`,
    };
  }

  const second = await fetch(`${baseUrl}/catalog`);
  const ok = second.status === 402;
  return {
    name: 'catalog per-fetch 402',
    ok,
    detail: ok
      ? 'each unpaid GET /catalog returns 402 (no session bypass)'
      : `expected 402 on second request, got ${second.status}`,
  };
}

/** @deprecated Use checkWellKnownSanity for Track A */
export async function checkFullCatalogSanity(baseUrl: string): Promise<CheckResult[]> {
  return checkWellKnownSanity(baseUrl);
}

/** @deprecated Use checkFreeCatalog */
export const checkCatalogTeaser = checkFreeCatalog;

/** @deprecated Use checkWellKnownSanity */
export async function checkCatalogSanity(baseUrl: string): Promise<CheckResult[]> {
  return checkWellKnownSanity(baseUrl);
}

export async function checkUnpaidMarkdown402(
  baseUrl: string,
  markdownId = DEFAULT_MARKDOWN_ID,
): Promise<CheckResult> {
  const challenge = await readPaymentChallenge(`${baseUrl}/design-systems/${markdownId}`);
  return {
    name: 'unpaid markdown challenge',
    ok: challenge.ok && challenge.hasBazaarExtension === true,
    detail: challenge.ok
      ? `status 402 with payment challenge${challenge.hasBazaarExtension ? ' + Bazaar metadata' : ', missing Bazaar metadata'}`
      : challenge.detail,
  };
}

export async function checkUnpaidBundle402(
  baseUrl: string,
  bundleId = DEFAULT_BUNDLE_ID,
): Promise<CheckResult> {
  const challenge = await readPaymentChallenge(`${baseUrl}/packs/${bundleId}/download`);
  return {
    name: 'unpaid bundle challenge',
    ok: challenge.ok && challenge.hasBazaarExtension === true,
    detail: challenge.ok
      ? `status 402 with payment challenge${challenge.hasBazaarExtension ? ' + Bazaar metadata' : ', missing Bazaar metadata'}`
      : challenge.detail,
  };
}

export async function checkUnpaidBinaryAsset402(
  baseUrl: string,
  binaryAssetId?: string,
): Promise<CheckResult> {
  let productId = binaryAssetId;
  if (!productId) {
    const res = await fetch(`${baseUrl}/.well-known/design-catalog.json`);
    if (!res.ok) {
      return {
        name: 'unpaid binary asset challenge',
        ok: false,
        detail: `expected 200 from catalog, got ${res.status}`,
      };
    }
    const body = (await res.json()) as {
      design_systems?: Array<{ id?: string; resource_type?: string }>;
    };
    const found = (body.design_systems ?? []).find(
      entry => entry.resource_type === 'binary_asset' && entry.id,
    );
    if (!found?.id) {
      return {
        name: 'unpaid binary asset challenge',
        ok: true,
        detail: 'SKIP (no binary_asset product published in this catalog yet)',
      };
    }
    productId = found.id;
  }

  const challenge = await readPaymentChallenge(`${baseUrl}/assets/${productId}/purchase`);
  return {
    name: 'unpaid binary asset challenge',
    ok: challenge.ok && challenge.hasBazaarExtension === true,
    detail: challenge.ok
      ? `status 402 with payment challenge for "${productId}"${challenge.hasBazaarExtension ? ' + Bazaar metadata' : ', missing Bazaar metadata'}`
      : challenge.detail,
  };
}

export async function checkHumanPages(baseUrl: string): Promise<CheckResult[]> {
  const pages = [
    { name: 'home page', path: '/' },
    { name: 'docs page', path: '/docs.html' },
  ];

  return Promise.all(
    pages.map(async ({ name, path }) => {
      const res = await fetch(`${baseUrl}${path}`);
      return {
        name,
        ok: res.ok,
        detail: `status ${res.status}`,
      };
    }),
  );
}

export async function checkLocalFixtureIntegrity(): Promise<CheckResult> {
  const required = [
    validateFixture('curatoria-demo-md.md', 'markdown', true),
    validateFixture('curatoria-demo-pack.zip', 'zip', true),
  ];
  const optional = [
    validateFixture('curatoria-demo-image.png', 'png', false),
    validateFixture('curatoria-demo-doc.pdf', 'pdf', false),
    validateFixture('curatoria-demo-tokens.json', 'json', false),
    validateFixture('curatoria-demo-font.woff2', 'font', false),
  ];

  const checks = [...required, ...optional];
  const failures = checks.filter((check) => check.required && !check.ok);
  const present = checks.filter((check) => check.present);
  const missingOptional = checks.filter((check) => !check.required && !check.present);

  if (failures.length > 0) {
    return {
      name: 'local fixture integrity',
      ok: false,
      detail: failures.map((check) => check.detail).join('; '),
    };
  }

  return {
    name: 'local fixture integrity',
    ok: true,
    detail:
      `${present.map((check) => check.detail).join('; ')}` +
      (missingOptional.length > 0
        ? `; optional absent: ${missingOptional.map((check) => check.filename).join(', ')}`
        : ''),
  };
}

export function checkPaidPsdPreviewReadiness(): CheckResult {
  try {
    assertPreviewAllowed({
      production: true,
      publicOrigin: 'http://127.0.0.1',
      walletAddress: PREVIEW_WALLET,
      env: {},
    });
    return {
      name: 'paid PSD preview readiness',
      ok: false,
      detail: 'preview harness accepted production',
    };
  } catch {
    try {
      createObservabilityEvent({
        correlation_id: 'corr_dddddddddddddddddddddddddddddddd',
        receipt_id: `rcpt_${'r'.repeat(43)}`,
        stage: 'preview',
        duration_ms: 0,
        bytes: 43,
        provider: 'local',
        outcome: 'ok',
      });
    } catch (error) {
      return {
        name: 'paid PSD preview readiness',
        ok: false,
        detail: `observability event rejected: ${error instanceof Error ? error.message : 'unknown'}`,
      };
    }
    return {
      name: 'paid PSD preview readiness',
      ok: true,
      detail: 'preview refuses production; observability allowlist is intact; no spend',
    };
  }
}

export async function runSmokeChecks(
  baseUrl: string,
  options: SmokeCheckOptions = {},
): Promise<CheckResult[]> {
  return [
    await checkHealth(baseUrl),
    await checkFreeCatalog(baseUrl),
    await checkCatalogFreeAlias(baseUrl),
    await checkUnpaidCatalog402(baseUrl),
    await checkCatalogPerFetch402(baseUrl),
    await checkUnpaidMarkdown402(baseUrl, options.markdownId),
    await checkUnpaidBundle402(baseUrl, options.bundleId),
    await checkUnpaidBinaryAsset402(baseUrl, options.binaryAssetId),
    await checkLocalFixtureIntegrity(),
    checkPaidPsdPreviewReadiness(),
  ];
}

export async function runPaidChecks(baseUrl: string): Promise<CheckResult[]> {
  const ownerWallet = await readOwnerWallet(baseUrl);
  const catalogUrl = `${baseUrl}/catalog`;
  const targets: PaidCheckTarget[] = [
    {
      id: DEFAULT_MARKDOWN_ID,
      kind: 'markdown',
      url: `${baseUrl}/design-systems/${DEFAULT_MARKDOWN_ID}`,
    },
    {
      id: DEFAULT_BUNDLE_ID,
      kind: 'bundle',
      url: `${baseUrl}/packs/${DEFAULT_BUNDLE_ID}/download`,
    },
  ];

  const challengeChecks: CheckResult[] = [];
  let totalMaxAmount = 0;

  const catalogProbe = await fetch(catalogUrl);
  const catalogIsPaid = catalogProbe.status === 402;

  if (catalogIsPaid) {
    const catalogChallenge = await readPaymentChallenge(catalogUrl);
    if (!catalogChallenge.ok || !catalogChallenge.accept) {
      challengeChecks.push({
        name: 'paid catalog payTo',
        ok: false,
        detail: catalogChallenge.detail,
      });
      return challengeChecks;
    }

    const catalogPayToMatches =
      normalizeAddress(catalogChallenge.accept.payTo) === normalizeAddress(ownerWallet.wallet);
    const catalogMaxAmount = Number(catalogChallenge.accept.amount);
    if (Number.isFinite(catalogMaxAmount) && catalogMaxAmount > 0) {
      totalMaxAmount += catalogMaxAmount;
    }
    challengeChecks.push({
      name: 'paid catalog payTo',
      ok: catalogPayToMatches,
      detail: catalogPayToMatches
        ? `${shortAddress(catalogChallenge.accept.payTo)} matches /health owner`
        : `expected ${shortAddress(ownerWallet.wallet)}, got ${shortAddress(catalogChallenge.accept.payTo)}`,
    });
  }

  for (const target of targets) {
    const challenge = await readPaymentChallenge(target.url);
    if (!challenge.ok || !challenge.accept) {
      challengeChecks.push({
        name: `paid ${target.kind} payTo`,
        ok: false,
        detail: challenge.detail,
      });
      continue;
    }

    const payToMatches =
      normalizeAddress(challenge.accept.payTo) === normalizeAddress(ownerWallet.wallet);
    const maxAmount = Number(challenge.accept.amount);
    if (Number.isFinite(maxAmount) && maxAmount > 0) {
      totalMaxAmount += maxAmount;
    }
    challengeChecks.push({
      name: `paid ${target.kind} payTo`,
      ok: payToMatches,
      detail: payToMatches
        ? `${shortAddress(challenge.accept.payTo)} matches /health owner`
        : `expected ${shortAddress(ownerWallet.wallet)}, got ${shortAddress(challenge.accept.payTo)}`,
    });
  }

  const failedChallenge = challengeChecks.find((check) => !check.ok);
  if (failedChallenge) {
    return challengeChecks;
  }

  if (process.env.AWAL_PAID_TEST !== '1') {
    return [
      ...challengeChecks,
      {
        name: 'paid x402 proof',
        ok: true,
        detail:
          'SKIP paid (set AWAL_PAID_TEST=1 only after MCP buyer auth and testnet funding are ready)',
      },
    ];
  }

  const awalExecutable = (process.env.AWAL_EXECUTABLE ?? '').trim();
  if (!path.isAbsolute(awalExecutable) || awalExecutable.includes('\0')) {
    return [
      ...challengeChecks,
      {
        name: 'paid x402 proof',
        ok: false,
        detail:
          'AWAL_PAID_TEST=1 requires AWAL_EXECUTABLE to be an absolute path to a reviewed, preinstalled awal binary',
      },
    ];
  }

  const status = runAwal(awalExecutable, ['status']);
  if (status.status !== 0) {
    return [
      ...challengeChecks,
      {
        name: 'paid x402 proof',
        ok: true,
        detail:
          `SKIP paid (MCP buyer not authenticated). Human next: ${awalExecutable} auth login <email>`,
      },
    ];
  }

  const balance = runAwal(awalExecutable, ['balance', '--chain', ownerWallet.network]);
  if (balance.status !== 0 || !hasSufficientBalance(balance.output, totalMaxAmount)) {
    return [
      ...challengeChecks,
      {
        name: 'paid x402 proof',
        ok: true,
        detail: `SKIP paid (could not confirm buyer balance on ${ownerWallet.network})`,
      },
    ];
  }

  const paidResults: CheckResult[] = [];

  if (catalogIsPaid) {
    const catalogPayResult = runAwal(awalExecutable, [
      'x402',
      'pay',
      catalogUrl,
      '--max-amount',
      maxAmountForTarget(catalogUrl),
      '--json',
    ]);
    const catalogPaidCheck: CheckResult = {
      name: 'paid catalog fetch',
      ok: catalogPayResult.status === 0,
      detail:
        catalogPayResult.status === 0
          ? 'awal x402 pay succeeded for /catalog'
          : `awal x402 pay failed: ${trimOutput(catalogPayResult.output)}`,
    };
    paidResults.push(catalogPaidCheck);

    if (!catalogPaidCheck.ok) {
      return [...challengeChecks, ...paidResults];
    }

    paidResults.push(await checkPaidCatalogPerFetch402(baseUrl));
  }

  const assetPaidResults = targets.map((target) => {
    const result = runAwal(awalExecutable, [
      'x402',
      'pay',
      target.url,
      '--max-amount',
      maxAmountForTarget(target.url),
      '--json',
    ]);
    return {
      name: `paid ${target.kind} fetch`,
      ok: result.status === 0,
      detail:
        result.status === 0
          ? `awal x402 pay succeeded for ${target.id}`
          : `awal x402 pay failed: ${trimOutput(result.output)}`,
    };
  });

  return [...challengeChecks, ...paidResults, ...assetPaidResults];
}

async function checkPaidCatalogPerFetch402(baseUrl: string): Promise<CheckResult> {
  const res = await fetch(`${baseUrl}/catalog`);
  const ok = res.status === 402;
  return {
    name: 'paid catalog per-fetch 402',
    ok,
    detail: ok
      ? 'second GET /catalog without payment returns 402'
      : `expected 402 on follow-up unpaid /catalog, got ${res.status}`,
  };
}

async function readOwnerWallet(baseUrl: string): Promise<{ wallet: string; network: string }> {
  const res = await fetch(`${baseUrl}/health`);
  if (!res.ok) {
    throw new Error(`Could not read /health (${res.status})`);
  }
  const body = (await res.json()) as { wallet?: string; network?: string };
  if (!body.wallet) {
    throw new Error('/health did not include wallet');
  }
  return { wallet: body.wallet, network: body.network ?? 'base-sepolia' };
}

type PaymentAcceptLike = {
  payTo: string;
  amount: string;
  network: string;
  extra?: {
    assetTransferMethod?: string;
    name?: string;
    version?: string;
  } | null;
};

async function readPaymentChallenge(
  url: string,
): Promise<{
  ok: boolean;
  detail: string;
  accept?: PaymentAcceptLike;
  hasBazaarExtension?: boolean;
}> {
  const res = await fetch(url);
  if (res.status !== 402) {
    return { ok: false, detail: `expected 402 at ${url}, got ${res.status}` };
  }

  const header = res.headers.get('x-payment-required');
  const standardHeader = res.headers.get('payment-required');
  if (!standardHeader && header) {
    return { ok: false, detail: `legacy x-payment-required header found at ${url}; expected PAYMENT-REQUIRED` };
  }
  if (!standardHeader) {
    return { ok: false, detail: `missing PAYMENT-REQUIRED at ${url}` };
  }

  const exposedHeaders = (res.headers.get('access-control-expose-headers') ?? '').toLowerCase();
  if (!exposedHeaders.includes('payment-required')) {
    return { ok: false, detail: `CORS does not expose PAYMENT-REQUIRED at ${url}` };
  }

  try {
    const parsed = validatePaymentRequired(decodePaymentRequiredHeader(standardHeader));
    if (!isPaymentRequiredV2(parsed)) {
      return { ok: false, detail: `payment challenge is not x402 v2 at ${url}` };
    }

    const accept = parsed.accepts?.[0];
    if (!parsed.resource?.url || !parsed.resource.mimeType) {
      return { ok: false, detail: `payment challenge missing v2 resource info at ${url}` };
    }
    if (!accept?.payTo || !accept.amount) {
      return { ok: false, detail: `payment challenge missing payTo or amount at ${url}` };
    }
    if (!accept.network.includes(':')) {
      return { ok: false, detail: `payment challenge network is not CAIP-2 at ${url}` };
    }
    if (
      accept.extra?.assetTransferMethod !== 'eip3009' ||
      !accept.extra.name ||
      !accept.extra.version
    ) {
      return {
        ok: false,
        detail: `payment challenge missing EIP-3009 domain metadata at ${url}`,
      };
    }
    paymentMaxByUrl.set(url, accept.amount);
    return {
      ok: true,
      detail: `x402 v2 challenge parsed (${accept.network}, amount ${accept.amount})`,
      accept,
      hasBazaarExtension: hasBazaarExtension(parsed.extensions),
    };
  } catch (err) {
    return { ok: false, detail: `could not decode payment challenge: ${String(err)}` };
  }
}

const paymentMaxByUrl = new Map<string, string>();

function maxAmountForTarget(url: string): string {
  return paymentMaxByUrl.get(url) ?? '0';
}

function hasBazaarExtension(extensions?: Record<string, unknown> | null): boolean {
  if (!extensions) return false;
  return Object.keys(extensions).some((key) => key.toLowerCase().includes('bazaar'));
}

function runAwal(executable: string, args: string[]): { status: number; output: string } {
  const result = spawnSync(executable, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim(),
  };
}

function hasSufficientBalance(output: string, requiredAtomicUnits: number): boolean {
  const requiredUsdc = requiredAtomicUnits / 1_000_000;
  const relevantLines = output
    .split('\n')
    .filter((line) => /(?:balance|usdc)/i.test(line));
  const amounts = relevantLines
    .flatMap((line) => Array.from(line.matchAll(/(\d+(?:\.\d+)?)\s*(?:USDC|usd)?/gi)))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  return amounts.some((amount) => amount >= requiredUsdc);
}

function normalizeAddress(address?: string): string {
  return (address ?? '').trim().toLowerCase();
}

function trimOutput(text: string): string {
  return text.trim().split('\n').slice(-3).join(' | ').slice(0, 240);
}

function shortAddress(address?: string): string {
  if (!address) return 'missing';
  if (address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

type FixtureKind = 'markdown' | 'zip' | 'png' | 'pdf' | 'json' | 'font';

type FixtureValidation = {
  filename: string;
  required: boolean;
  present: boolean;
  ok: boolean;
  detail: string;
};

function validateFixture(
  filename: string,
  kind: FixtureKind,
  required: boolean,
): FixtureValidation {
  const filePath = path.join(DESIGN_SYSTEMS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return {
      filename,
      required,
      present: false,
      ok: !required,
      detail: `${filename} missing`,
    };
  }

  try {
    const buffer = fs.readFileSync(filePath);
    const hash = sha256(buffer).slice(0, 12);
    const size = buffer.byteLength;
    const kindDetail = validateBytes(filename, kind, buffer);
    return {
      filename,
      required,
      present: true,
      ok: true,
      detail: `${filename} ${size}B sha256:${hash} ${kindDetail}`,
    };
  } catch (err) {
    return {
      filename,
      required,
      present: true,
      ok: false,
      detail: `${filename} invalid: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function validateBytes(filename: string, kind: FixtureKind, buffer: Buffer): string {
  if (buffer.byteLength === 0) {
    throw new Error('file is empty');
  }

  if (kind === 'markdown') {
    if (buffer.includes(0)) {
      throw new Error('markdown contains NUL bytes');
    }
    const text = buffer.toString('utf8');
    if (text.includes('\uFFFD')) {
      throw new Error('markdown is not clean UTF-8 text');
    }
    if (text.trim().length < 20) {
      throw new Error('markdown content is unexpectedly short');
    }
    return 'markdown readable';
  }

  if (kind === 'zip') {
    if (!hasZipSignature(buffer)) {
      throw new Error('missing PK zip signature');
    }
    const entries = listZipEntries(buffer);
    const requiredEntries = ['README.md', 'tokens.json'];
    const missing = requiredEntries.filter((entry) => !entries.includes(entry));
    if (missing.length > 0) {
      throw new Error(`zip missing ${missing.join(', ')}`);
    }
    return `zip entries:${entries.join('|')}`;
  }

  if (kind === 'png') {
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!buffer.subarray(0, pngSignature.length).equals(pngSignature)) {
      throw new Error('missing PNG signature');
    }
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return `png ${width}x${height}`;
  }

  if (kind === 'pdf') {
    if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new Error('missing PDF signature');
    }
    return 'pdf signature ok';
  }

  if (kind === 'json') {
    JSON.parse(buffer.toString('utf8'));
    return 'json parses without rewrite';
  }

  if (kind === 'font') {
    const signature = buffer.subarray(0, 4).toString('latin1');
    if (!['wOF2', 'wOFF', 'OTTO', '\x00\x01\x00\x00'].includes(signature)) {
      throw new Error(`unexpected font signature ${JSON.stringify(signature)}`);
    }
    return `font signature:${signature === '\x00\x01\x00\x00' ? 'ttf' : signature}`;
  }

  throw new Error(`unknown fixture kind for ${filename}`);
}

function hasZipSignature(buffer: Buffer): boolean {
  return (
    buffer.byteLength >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    [0x03, 0x05, 0x07].includes(buffer[2]) &&
    [0x04, 0x06, 0x08].includes(buffer[3])
  );
}

function listZipEntries(buffer: Buffer): string[] {
  const entries: string[] = [];
  let offset = 0;
  while (offset <= buffer.byteLength - 46) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.byteLength) {
      throw new Error('zip central directory is truncated');
    }
    const name = buffer.subarray(nameStart, nameEnd).toString('utf8');
    if (name && !name.endsWith('/')) {
      entries.push(name);
    }
    offset = nameEnd + extraLength + commentLength;
  }
  if (entries.length === 0) {
    throw new Error('zip central directory has no file entries');
  }
  return entries;
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
