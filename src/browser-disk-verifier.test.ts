import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBrowserProofReceipt } from './browser-proof';
import {
  parseBrowserProofReceipt,
  verifyBrowserDownload,
} from './browser-disk-verifier';
import { main as verifyBrowserDownloadCli, parseArguments } from '../scripts/verify-browser-download';

const bytes = Buffer.from('8BPSdata');
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const transaction = `0x${'a'.repeat(64)}`;
const receipt = createBrowserProofReceipt({
  purchase: {
    receipt_id: `rcpt_${'r'.repeat(43)}`,
    product_id: 'layout',
    source_provider: 'gdrive',
    network: 'eip155:8453',
    payer: '0x2222222222222222222222222222222222222222',
    transaction,
    entitlement: 'secret-entitlement',
    content_sha256: sha256,
    content_bytes: bytes.byteLength,
    filename: 'layout.psd',
    mime_type: 'image/vnd.adobe.photoshop',
  },
  paymentResponse: {
    success: true,
    transaction,
    network: 'eip155:8453',
    payer: '0x2222222222222222222222222222222222222222',
  },
  actualSha256: sha256,
  actualBytes: bytes.byteLength,
  psd8bps: true,
});

test('disk verifier accepts browser collision rename with matching identity and bytes', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'curatoria-browser-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const savedPath = path.join(directory, 'layout (1).psd');
  await fs.promises.writeFile(savedPath, bytes);

  const result = await verifyBrowserDownload({
    receipt,
    filePath: savedPath,
    expected: {
      receiptId: receipt.receipt_id,
      productId: receipt.product_id,
      transaction,
      entitlementFingerprint: receipt.entitlement_fingerprint,
    },
  });

  assert.equal(result.renamed_by_browser, true);
  assert.equal(result.actual_filename, 'layout (1).psd');
  assert.equal(result.sha256, sha256);
  assert.equal(result.psd_8bps, true);
});

test('disk verifier rejects wrong bytes, missing 8BPS, and identity mismatches', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'curatoria-browser-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const wrongPath = path.join(directory, 'layout.psd');
  await fs.promises.writeFile(wrongPath, Buffer.from('NOPEdata'));

  await assert.rejects(
    () =>
      verifyBrowserDownload({
        receipt,
        filePath: wrongPath,
        expected: {
          receiptId: receipt.receipt_id,
          productId: receipt.product_id,
          transaction,
          entitlementFingerprint: receipt.entitlement_fingerprint,
        },
      }),
    /transaction-bound browser receipt|8BPS/,
  );
  await assert.rejects(
    () =>
      verifyBrowserDownload({
        receipt,
        filePath: wrongPath,
        expected: {
          receiptId: receipt.receipt_id,
          productId: receipt.product_id,
          transaction: `0x${'b'.repeat(64)}`,
          entitlementFingerprint: receipt.entitlement_fingerprint,
        },
      }),
    /identity/,
  );
});

test('receipt parser rejects capability-bearing and internally inconsistent receipts', () => {
  assert.throws(
    () => parseBrowserProofReceipt({ ...receipt, entitlement: 'secret' }),
    /forbidden capability/,
  );
  assert.throws(
    () =>
      parseBrowserProofReceipt({
        ...receipt,
        browser_verification: { ...receipt.browser_verification, bytes: 9 },
      }),
    /internally inconsistent/,
  );
});

test('verifier CLI requires every external identity binding', () => {
  assert.throws(
    () => parseArguments(['--receipt', 'proof.json', '--file', 'layout.psd']),
    /all transaction identity bindings/,
  );
  assert.deepEqual(
    parseArguments([
      '--receipt', 'proof.json',
      '--file', 'layout (1).psd',
      '--receipt-id', receipt.receipt_id,
      '--product', receipt.product_id,
      '--transaction', receipt.transaction,
      '--entitlement-fingerprint', receipt.entitlement_fingerprint,
    ]),
    {
      receipt: 'proof.json',
      file: 'layout (1).psd',
      receiptId: receipt.receipt_id,
      productId: receipt.product_id,
      transaction: receipt.transaction,
      entitlementFingerprint: receipt.entitlement_fingerprint,
    },
  );
});

test('verifier CLI proves actual saved PSD bytes and emits no capabilities', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'curatoria-browser-cli-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'layout (2).psd');
  const receiptPath = path.join(directory, 'layout.receipt.json');
  await fs.promises.writeFile(filePath, bytes);
  await fs.promises.writeFile(receiptPath, JSON.stringify(receipt));
  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await verifyBrowserDownloadCli([
      '--receipt', receiptPath,
      '--file', filePath,
      '--receipt-id', receipt.receipt_id,
      '--product', receipt.product_id,
      '--transaction', receipt.transaction,
      '--entitlement-fingerprint', receipt.entitlement_fingerprint,
    ]);
  } finally {
    process.stdout.write = originalWrite;
  }
  const result = JSON.parse(output);
  assert.equal(result.actual_filename, 'layout (2).psd');
  assert.equal(result.bytes, bytes.byteLength);
  assert.equal(result.sha256, sha256);
  assert.equal(result.psd_8bps, true);
  assert.doesNotMatch(output, /secret-entitlement|download_url|payment_signature/);
});
