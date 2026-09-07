import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyStarterPath,
  scanStarterBoundary,
} from '../scripts/check-starter-boundary';

function withStarter(files: Record<string, string>, run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curatoria-boundary-'));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const target = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('starter manifest classifies shared, generated, preserved, and forbidden paths', () => {
  assert.equal(classifyStarterPath('src/catalog.ts'), 'shared');
  assert.equal(classifyStarterPath('scripts/preview-paid-psd.ts'), 'shared');
  assert.equal(classifyStarterPath('scripts/failure-drills.ts'), 'shared');
  assert.equal(classifyStarterPath('scripts/prepare-rollback-packet.ts'), 'shared');
  assert.equal(classifyStarterPath('scripts/generate-proof-report.ts'), 'shared');
  assert.equal(classifyStarterPath('test/fixtures/psd/tiny-rgb-1x1.psd'), 'shared');
  assert.equal(classifyStarterPath('README.md'), 'generated');
  assert.equal(classifyStarterPath('.git/config'), 'preserved');
  assert.equal(classifyStarterPath('docs/operator/runbook.md'), 'forbidden');
  assert.equal(classifyStarterPath('src/export-starter.test.ts'), 'forbidden');
  assert.equal(classifyStarterPath('unknown.txt'), 'forbidden');
});

test('starter boundary accepts generic starter-safe files', () => {
  withStarter({
    'src/catalog.ts': 'export const catalog = true;\n',
    'README.md': '# Generic creator starter\n',
    '.env.example': 'WALLET_ADDRESS=0x0000000000000000000000000000000000000001\n',
    'test/fixtures/psd/tiny-rgb-1x1.psd': '8BPS generated fixture\n',
  }, root => {
    assert.deepEqual(scanStarterBoundary(root), []);
  });
});

test('starter boundary detects labeled private keys with and without 0x', () => {
  const privateKeyHex = 'ab'.repeat(32);
  withStarter({
    'src/hex-key.ts': `const PRIVATE_KEY = "${privateKeyHex}";\n`,
    'src/prefixed-key.ts': `const walletPrivateKey = "0x${privateKeyHex}";\n`,
  }, root => {
    const findings = scanStarterBoundary(root);
    assert.deepEqual(
      findings.map(finding => ({ path: finding.path, reason: finding.reason })),
      [
        { path: 'src/hex-key.ts', reason: 'Wallet secret material detected.' },
        { path: 'src/prefixed-key.ts', reason: 'Wallet secret material detected.' },
      ],
    );
    assert.ok(findings.every(finding => !finding.reason.includes(privateKeyHex)));
  });
});

test('starter boundary detects realistic mnemonic word counts without exposing them', () => {
  const mnemonic = [
    'anchor', 'bright', 'cactus', 'drift', 'ember', 'forest',
    'gentle', 'harbor', 'island', 'jungle', 'kitten', 'lunar',
  ].join(' ');
  withStarter({
    'src/mnemonic.ts': `export const seedPhrase = "${mnemonic}";\n`,
  }, root => {
    const findings = scanStarterBoundary(root);
    assert.deepEqual(findings, [{
      path: 'src/mnemonic.ts',
      reason: 'Wallet secret material detected.',
    }]);
    assert.ok(findings.every(finding => !finding.reason.includes(mnemonic)));
  });
});

const canaries: Array<[string, string, RegExp]> = [
  ['.env', 'ADMIN_API_KEY=real-secret', /environment file/i],
  ['wallet.json', '{"privateKey":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}', /wallet|secret/i],
  ['src/provider.ts', 'const provider = "alchemy.com/v2/abcdefghijklmnop123456";', /provider/i],
  ['src/blob-canary.ts', 'BLOB_READ_WRITE_TOKEN=vercel_blob_rw_abcdefghijklmnop', /blob/i],
  ['design-systems/client-final.psd', '8BPS private client art', /PSD/i],
  ['receipts/payment-receipt.json', '{"transaction":"0xabc"}', /receipt/i],
  ['docs/operator/runbook.md', 'private operations', /operator|forbidden/i],
  ['public/styles-shader.css', '#shader-gradient-root {}', /shader/i],
];

for (const [relativePath, content, expected] of canaries) {
  test(`starter boundary fails closed for ${relativePath}`, () => {
    withStarter({ [relativePath]: content }, root => {
      const findings = scanStarterBoundary(root);
      assert.ok(findings.length > 0);
      assert.match(findings.map(finding => finding.reason).join('\n'), expected);
      assert.ok(findings.every(finding => !finding.reason.includes(content)));
    });
  });
}
