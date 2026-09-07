import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodePaymentRequiredHeader } from '@x402/core/http';

import {
  continueCuratoriaEntitlement,
  downloadCuratoriaAsset,
  resumeCuratoriaDownload,
} from './agent-downloader';
import { writePrivateResumeState } from './local-delivery';
import type { CatalogEntry, CatalogResponse, PaymentRequired } from './types';
import type { EntitlementPurchase } from './wallet-purchasers';
import { createExternalEntitlementPurchaser } from './wallet-purchasers';

type BuyerState = {
  catalogAvailable?: boolean;
  destination: string | null;
  destinationExists: boolean;
  collisionChoice: 'overwrite' | 'rename' | 'cancel' | null;
  challengeMatches: boolean;
  entitlement: 'none' | 'valid' | 'expired';
  paymentStatus: 'not_started' | 'settled' | 'inconclusive';
  walletAvailable: boolean;
  browserSave: boolean;
  integrity: 'not_checked' | 'verified' | 'mismatch';
  budgetRemaining?: number;
};

type Fixture = {
  id: string;
  prompt: string;
  state: BuyerState;
  expected: {
    action: string;
    paymentCalls: number;
    requiresHumanDecision: boolean;
  };
};

type FixtureFile = {
  contract: Record<string, string>;
  fixtures: Fixture[];
};

const root = path.join(__dirname, '..');
const fixturePath = path.join(root, 'test/fixtures/buyer-prompts.json');
const skillPath = path.join(
  root,
  'public/.well-known/agent-skills/curatoria-buyer/SKILL.md',
);
const troubleshootingPath = path.join(root, 'docs/creator/09-troubleshooting.md');
const readinessPath = path.join(root, 'docs/creator/10-agent-readiness.md');
const agentDownloadCliPath = path.join(root, 'scripts/agent-download.ts');

const fixtureFile = JSON.parse(
  fs.readFileSync(fixturePath, 'utf8'),
) as FixtureFile;
const skill = fs.readFileSync(skillPath, 'utf8');
const troubleshooting = fs.readFileSync(troubleshootingPath, 'utf8');
const readiness = fs.readFileSync(readinessPath, 'utf8');
const agentDownloadCli = fs.readFileSync(agentDownloadCliPath, 'utf8');

function decideBuyerAction(state: BuyerState): {
  action: string;
  paymentCalls: number;
  requiresHumanDecision: boolean;
} {
  if (state.catalogAvailable === false) {
    return {
      action: 'stop_product_unavailable',
      paymentCalls: 0,
      requiresHumanDecision: false,
    };
  }
  if (!state.destination) {
    return {
      action: 'ask_destination',
      paymentCalls: 0,
      requiresHumanDecision: true,
    };
  }
  if (state.destinationExists && !state.collisionChoice) {
    return {
      action: 'ask_collision_resolution',
      paymentCalls: 0,
      requiresHumanDecision: true,
    };
  }
  if (state.paymentStatus === 'inconclusive') {
    return {
      action: 'stop_inconclusive_payment',
      paymentCalls: 0,
      requiresHumanDecision: true,
    };
  }
  if (state.entitlement === 'expired') {
    return {
      action: 'stop_expired_entitlement',
      paymentCalls: 0,
      requiresHumanDecision: true,
    };
  }
  if (state.integrity === 'mismatch') {
    return {
      action: 'stop_integrity_failure',
      paymentCalls: 0,
      requiresHumanDecision: true,
    };
  }
  if (state.browserSave && state.integrity !== 'verified') {
    return {
      action: 'require_local_disk_verifier',
      paymentCalls: 0,
      requiresHumanDecision: false,
    };
  }
  if (state.entitlement === 'valid') {
    return {
      action: 'resume_entitlement_download',
      paymentCalls: 0,
      requiresHumanDecision: false,
    };
  }
  if (!state.challengeMatches) {
    return {
      action: 'stop_terms_mismatch',
      paymentCalls: 0,
      requiresHumanDecision: true,
    };
  }
  if (typeof state.budgetRemaining === 'number' && state.budgetRemaining < 10000) {
    return {
      action: 'stop_budget_exhausted',
      paymentCalls: 0,
      requiresHumanDecision: true,
    };
  }
  if (!state.walletAvailable) {
    return {
      action: 'stop_wallet_unavailable',
      paymentCalls: 0,
      requiresHumanDecision: true,
    };
  }
  return {
    action: 'authorize_one_payment',
    paymentCalls: 1,
    requiresHumanDecision: true,
  };
}

test('paid PSD fixture pins every exact purchase term', () => {
  assert.deepEqual(fixtureFile.contract, {
    amountUsd: '0.01',
    amountAtomic: '10000',
    chain: 'Base mainnet',
    network: 'eip155:8453',
    token: 'USDC',
    tokenAddress: '0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913',
    payee: '0x8aa327403ED786cA56EB8F59C6c8831A8BD73485',
    productId: 'mock-published-layout',
    filename: 'mock-layout.psd',
    purchaseUrl: 'https://curatoria.dev/assets/mock-published-layout/purchase',
  });

  for (const term of Object.values(fixtureFile.contract)) {
    assert.ok(skill.includes(term), `buyer skill must state exact term ${term}`);
  }
});

test('buyer prompt fixtures deterministically stop or resume without repayment', () => {
  const requiredIds = [
    'missing-destination',
    'unavailable-product',
    'existing-file',
    'wrong-price-payee-network',
    'interrupted-post-payment',
    'expired-entitlement',
    'browser-renamed-save',
    'unavailable-wallet',
    'hash-mismatch',
    'inconclusive-payment',
    'session-budget-exhausted',
    'successful-exactly-one-payment',
  ];
  assert.deepEqual(
    new Set(fixtureFile.fixtures.map(fixture => fixture.id)),
    new Set(requiredIds),
  );

  for (const fixture of fixtureFile.fixtures) {
    assert.ok(fixture.prompt.length > 0);
    assert.deepEqual(
      decideBuyerAction(fixture.state),
      fixture.expected,
      fixture.id,
    );
  }
});

test('skill keeps payment signing separate from Curatoria file saving', () => {
  assert.match(skill, /wallet is only a signer\/payment\s+capability/i);
  assert.match(skill, /never chooses a path, downloads bytes, saves a file/i);
  assert.match(skill, /entitlement JSON directly to[\s\S]*--entitlement-stdin/i);
  assert.match(skill, /destination[\s\S]*challenge[\s\S]*session-budget preflight/i);
  assert.match(skill, /check_payment_requirements[\s\S]*make_x402_request/i);
  assert.match(skill, /make_x402_request` exactly once/i);
  assert.match(skill, /exactly `10000` atomic Base USDC/i);
  assert.match(skill, /never asset bytes/i);
  assert.match(skill, /Never call\s+`make_x402_request` again/i);
  assert.match(
    skill,
    /generic `--wallet-executable` bridge is an\s+advanced adapter[\s\S]*not Coinbase Payments MCP itself/i,
  );
});

test('CLI usage describes --wallet-executable as a generic JSON-stdin bridge, not Coinbase Payments MCP', () => {
  const usage = agentDownloadCli.match(/Usage:[\s\S]*--on-collision <policy>/);
  assert.ok(usage, 'agent-download usage string must be present');
  const walletExecutableLine = usage[0]
    .split('\n')
    .find(line => line.includes('--wallet-executable'));
  assert.ok(walletExecutableLine, 'usage must document --wallet-executable');
  assert.match(walletExecutableLine, /generic JSON-stdin wallet bridge/i);
  assert.doesNotMatch(walletExecutableLine, /Coinbase Payments MCP/i);
  assert.doesNotMatch(usage[0], /--wallet-executable[^\n]*Coinbase Payments MCP/i);
});

test('skill protects capabilities and requires safe uncertainty handling', () => {
  for (const secret of [
    'asset bytes',
    'entitlement bearer values',
    'signed private URLs',
    'payment signatures',
    'wallet seed phrases/private keys',
    'API keys',
    'admin keys',
  ]) {
    assert.ok(skill.includes(secret), `missing protected capability: ${secret}`);
  }
  assert.match(skill, /expired entitlement:[\s\S]*do not repay automatically/i);
  assert.match(skill, /inconclusive payment[\s\S]*do not retry payment/i);
  assert.match(
    skill,
    /Hash, byte-count, MIME, or PSD-signature mismatch[\s\S]*Never\s+repay/i,
  );
});

test('browser and MetaMask completion requires a local disk verifier', () => {
  assert.match(skill, /browser may rename the downloaded file/i);
  assert.match(skill, /completion requires a local disk verifier/i);
  assert.match(skill, /SHA-256, byte count, and PSD `8BPS` signature/i);
  assert.match(skill, /download started; local verification[\s\S]*required/i);
});

test('creator guidance mirrors the contract and links only to the public starter', () => {
  assert.match(
    troubleshooting,
    /check_payment_requirements`, then one `make_x402_request`/i,
  );
  assert.match(troubleshooting, /local disk verifier/i);
  assert.match(readiness, /destination[\s\S]*collision[\s\S]*before[\s\S]*wallet/i);
  assert.match(readiness, /resume[\s\S]*without[\s\S]*paying again/i);
  assert.match(readiness, /expired[\s\S]*inconclusive/i);

  const combined = `${skill}\n${troubleshooting}\n${readiness}`;
  assert.ok(
    combined.includes('https://github.com/margaretsommers/curatoria-starter'),
  );
  assert.doesNotMatch(combined, /github\.com\/margaretsommers\/curatoria(?:[/"\s)]|$)/);
});

const OWNER = '0x8aa327403ED786cA56EB8F59C6c8831A8BD73485';
const USDC = '0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913';

function mockedPublishedContract(bytes: Buffer): {
  entry: CatalogEntry;
  catalog: CatalogResponse;
  challenge: PaymentRequired;
  purchase: EntitlementPurchase;
} {
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const entry = {
    id: 'mock-published-layout',
    resource_type: 'binary_asset',
    mime_type: 'image/vnd.adobe.photoshop',
    name: 'Mock published layout',
    description: 'Test-only published contract.',
    price_usd: '0.01',
    tags: ['test'],
    published_at: '2026-01-01T00:00:00.000Z',
    active: true,
    access_url: 'https://curatoria.dev/assets/mock-published-layout/purchase',
    payment_required: true,
    download_filename: 'mock-layout.psd',
    content_sha256: sha,
    content_bytes: bytes.byteLength,
    integrity_status: 'verified',
    delivery_mode: 'entitlement',
  } as CatalogEntry;
  const catalog = {
    owner: { wallet: OWNER, name: 'Curatoria' },
    total: 1,
    base_url: 'https://curatoria.dev',
    design_systems: [entry],
  } as CatalogResponse;
  const challenge = {
    x402Version: 2,
    error: 'payment required',
    resource: { url: entry.access_url, mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000',
      payTo: OWNER,
      maxTimeoutSeconds: 300,
      asset: USDC,
      extra: { assetTransferMethod: 'eip3009', name: 'USD Coin', version: '2' },
    }],
  } as PaymentRequired;
  const purchase = {
    receipt_id: `rcpt_${'r'.repeat(43)}`,
    product_id: entry.id,
    source_provider: 'local',
    network: 'eip155:8453',
    payer: '0x1111111111111111111111111111111111111111',
    transaction: `0x${'a'.repeat(64)}`,
    entitlement: 'secret-entitlement',
    redeem_url: '/assets/mock-published-layout/redeem',
    expires_at: '2099-01-01T00:00:00.000Z',
    filename: 'mock-layout.psd',
    mime_type: 'image/vnd.adobe.photoshop',
    content_sha256: sha,
    content_bytes: bytes.byteLength,
  };
  return { entry, catalog, challenge, purchase };
}

function continuationFetch(
  contract: ReturnType<typeof mockedPublishedContract>,
  bytes: Buffer,
): typeof fetch {
  return async (url) => {
    const target = String(url);
    if (target.endsWith('/.well-known/design-catalog.json')) {
      return Response.json(contract.catalog);
    }
    if (target === contract.entry.access_url) {
      return new Response('', {
        status: 402,
        headers: {
          'PAYMENT-REQUIRED': encodePaymentRequiredHeader(contract.challenge as never),
        },
      });
    }
    if (target.endsWith('/assets/mock-published-layout/redeem')) {
      return Response.json({
        product_id: contract.entry.id,
        download_url:
          'https://store.private.blob.vercel-storage.com/mock-layout.psd?signature=secret',
        expires_at: '2099-01-01T00:00:00.000Z',
        filename: contract.purchase.filename,
        mime_type: contract.purchase.mime_type,
        content_sha256: contract.purchase.content_sha256,
        content_bytes: contract.purchase.content_bytes,
      });
    }
    if (target.includes('blob.vercel-storage.com')) {
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': contract.purchase.mime_type,
          'Content-Length': String(bytes.byteLength),
        },
      });
    }
    throw new Error(`Unexpected test URL: ${target}`);
  };
}

test('mocked published contract completes after exactly one external payment', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'curatoria-buyer-success-'));
  const bytes = Buffer.from('8BPSmock', 'latin1');
  const contract = mockedPublishedContract(bytes);
  let paymentCalls = 0;
  const purchaser = createExternalEntitlementPurchaser(
    '/mock-wallet',
    ['purchase'],
    async request => {
      paymentCalls += 1;
      assert.equal(request.executable, '/mock-wallet');
      assert.deepEqual(request.args, ['purchase']);
      const context = JSON.parse(request.input ?? '{}');
      assert.equal(context.operation, 'purchase_entitlement');
      assert.equal(context.url, contract.entry.access_url);
      assert.equal(context.max_amount_atomic, 10000);
      assert.equal(context.payment_required.resource.url, contract.entry.access_url);
      return {
        stdout: JSON.stringify(contract.purchase),
        stderr: '',
        exitCode: 0,
      };
    },
  );
  const result = await downloadCuratoriaAsset({
    productId: contract.entry.id,
    out: root,
    stateDirectory: path.join(root, 'state'),
    yes: true,
    collisionPolicy: 'cancel',
    entitlementPurchaser: purchaser,
    fetchImpl: continuationFetch(contract, bytes),
  });

  assert.equal(paymentCalls, 1);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(await fsp.readFile(result.saved_path), bytes);
  const receipt = await fsp.readFile(result.receipt_path!, 'utf8');
  assert.match(receipt, new RegExp(`rcpt_${'r'.repeat(43)}`));
  assert.match(receipt, /"source_provider": "local"/);
  assert.match(receipt, /"network": "eip155:8453"/);
  assert.match(receipt, /"payer": "0x1111111111111111111111111111111111111111"/);
  assert.equal(receipt.includes('secret-entitlement'), false);
  assert.equal(receipt.includes('signature=secret'), false);
  assert.equal(JSON.stringify(result).includes('secret-entitlement'), false);
});

test('continuation stops when the product is absent from the current catalog', async () => {
  let walletCalls = 0;
  const bytes = Buffer.from('8BPSmock', 'latin1');
  const contract = mockedPublishedContract(bytes);
  const result = await continueCuratoriaEntitlement(
    {
      productId: 'layout',
      out: '/tmp/unused-layout.psd',
      yes: true,
      entitlementPurchaser: {
        async purchase() {
          walletCalls += 1;
          throw new Error('wallet must not run');
        },
      },
      fetchImpl: async () =>
        Response.json({ ...contract.catalog, total: 0, design_systems: [] }),
    },
    contract.purchase,
  );
  assert.equal(result.ok, false);
  assert.equal(walletCalls, 0);
  if (!result.ok) {
    assert.equal(result.code, 'product_not_found');
    assert.match(result.next_step, /Do not pay/);
  }
});

test('continuation rejects field mismatch and unresolved collision without wallet calls', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'curatoria-buyer-stop-'));
  const bytes = Buffer.from('8BPSmock', 'latin1');
  const contract = mockedPublishedContract(bytes);
  let walletCalls = 0;
  const options = {
    productId: contract.entry.id,
    out: root,
    stateDirectory: path.join(root, 'state'),
    yes: true,
    isTTY: false,
    entitlementPurchaser: {
      async purchase(): Promise<EntitlementPurchase> {
        walletCalls += 1;
        throw new Error('wallet must not run');
      },
    },
    fetchImpl: continuationFetch(contract, bytes),
  };
  const mismatch = await continueCuratoriaEntitlement(
    { ...options, collisionPolicy: 'cancel' },
    { ...contract.purchase, filename: 'wrong.psd' },
  );
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.code, 'entitlement_purchase_invalid');

  await fsp.writeFile(path.join(root, 'mock-layout.psd'), 'existing');
  const collision = await continueCuratoriaEntitlement(options, contract.purchase);
  assert.equal(collision.ok, false);
  if (!collision.ok) {
    assert.equal(collision.code, 'destination_preflight_failed');
    assert.match(collision.message, /explicit --on-collision/);
  }
  assert.equal(walletCalls, 0);
});

test('entitlement receipt metadata probes stop before redemption or persistence', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'curatoria-metadata-stop-'));
  const bytes = Buffer.from('8BPSmock', 'latin1');
  const contract = mockedPublishedContract(bytes);
  let redemptionCalls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/redeem')) redemptionCalls += 1;
    return continuationFetch(contract, bytes)(url, init);
  };
  const invalid = [
    { receipt_id: 'Bearer secret-capability' },
    { source_provider: 'https://evil.example/private' },
    { source_provider: 'coinbase-payments-mcp' },
    { network: 'eip155:1' },
    { payer: '0x1234' },
    { transaction: '0xabc' },
    { transaction: `0x${'a'.repeat(64)}\nsecret` },
    { receipt_id: `rcpt_${'r'.repeat(129)}` },
  ];
  for (const override of invalid) {
    const result = await continueCuratoriaEntitlement(
      {
        productId: contract.entry.id,
        out: root,
        stateDirectory: path.join(root, 'state'),
        collisionPolicy: 'number',
        yes: true,
        fetchImpl,
      },
      { ...contract.purchase, ...override } as EntitlementPurchase,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'entitlement_purchase_invalid');
      assert.equal(result.message.includes('secret-capability'), false);
      assert.equal(result.message.includes('evil.example'), false);
    }
  }
  assert.equal(redemptionCalls, 0);
  assert.deepEqual(await fsp.readdir(path.join(root, 'state')), []);
});

test('resume state completes without a payment-capable interface', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'curatoria-buyer-resume-'));
  const stateDirectory = path.join(root, 'state');
  await fsp.mkdir(stateDirectory, { mode: 0o700 });
  const bytes = Buffer.from('8BPSresume', 'latin1');
  const statePath = path.join(stateDirectory, 'resume.json');
  const tempPath = path.join(stateDirectory, 'resume.part');
  const finalPath = path.join(root, 'resumed.psd');
  const reservationPath = path.join(root, '.resumed.psd.curatoria.reserve');
  await fsp.writeFile(tempPath, '', { mode: 0o600 });
  await fsp.writeFile(reservationPath, '', { mode: 0o600 });
  await writePrivateResumeState(statePath, {
    version: 1,
    product_id: 'mock-published-layout',
    temp_path: tempPath,
    final_path: finalPath,
    bytes_written: 0,
    content_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    content_bytes: bytes.byteLength,
    download_url:
      'https://store.private.blob.vercel-storage.com/resumed.psd?signature=secret',
    download_expires_at: '2099-01-01T00:00:00.000Z',
    entitlement: 'secret-entitlement',
    reservation_path: reservationPath,
    source_provider: 'local',
    receipt_id: `rcpt_${'s'.repeat(43)}`,
    network: 'eip155:8453',
    payer: `0x${'1'.repeat(40)}`,
    transaction: `0x${'b'.repeat(64)}`,
  });

  let downloadCalls = 0;
  const result = await resumeCuratoriaDownload(statePath, async () => {
    downloadCalls += 1;
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'image/vnd.adobe.photoshop',
        'Content-Length': String(bytes.byteLength),
      },
    });
  });
  assert.equal(result.ok, true);
  assert.equal(downloadCalls, 1);
  assert.equal(JSON.stringify(result).includes('secret-entitlement'), false);
});

test('CLI entitlement stdin rejects invalid JSON without echoing secrets', async () => {
  const secret = 'secret-entitlement-value-not-json';
  const result = await new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--require',
          'ts-node/register',
          path.join(root, 'scripts/agent-download.ts'),
          '--entitlement-stdin',
          '--product-id',
          'mock-published-layout',
          '--out',
          os.tmpdir(),
        ],
        { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.on('data', chunk => {
        output += String(chunk);
      });
      child.stderr.on('data', chunk => {
        output += String(chunk);
      });
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
      child.stdin.end(secret);
    },
  );
  assert.notEqual(result.code, 0);
  assert.match(result.output, /valid JSON object/);
  assert.equal(result.output.includes(secret), false);
});
