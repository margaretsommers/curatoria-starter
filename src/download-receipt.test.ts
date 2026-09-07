import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDownloadReceipt,
  validateEntitlementReceiptMetadata,
} from './download-receipt';

test('receipt binds provider and settlement identity without capabilities', () => {
  const receipt = createDownloadReceipt({
    receipt_id: `rcpt_${'r'.repeat(43)}`,
    product_id: 'layout',
    saved_path: '/tmp/layout.psd',
    filename: 'layout.psd',
    mime_type: 'image/vnd.adobe.photoshop',
    bytes: 123,
    sha256: 'a'.repeat(64),
    source_provider: 'gdrive',
    network: 'eip155:8453',
    payer: '0xabc',
    transaction: `0x${'d'.repeat(64)}`,
    entitlement: 'must-not-appear',
    download_url: 'https://blob.example/file?signature=secret',
    payment_signature: 'must-not-appear',
  });

  assert.equal(receipt.receipt_id, `rcpt_${'r'.repeat(43)}`);
  assert.equal(receipt.source_provider, 'gdrive');
  assert.equal(receipt.network, 'eip155:8453');
  assert.equal(receipt.payer, '0xabc');
  assert.equal(receipt.transaction, `0x${'d'.repeat(64)}`);
  assert.deepEqual(receipt.durability, {
    final_file: 'synced',
    parent_directory: 'synced',
    receipt_file: 'pending',
  });
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes('must-not-appear'), false);
  assert.equal(serialized.includes('signature=secret'), false);
  assert.equal(serialized.includes('entitlement'), false);
  assert.equal(serialized.includes('download_url'), false);
  assert.equal(serialized.includes('payment_signature'), false);
});

test('entitlement receipt metadata rejects capabilities, URLs, controls, and oversized values', () => {
  const valid = {
    receipt_id: `rcpt_${'r'.repeat(43)}`,
    product_id: 'layout',
    source_provider: 'gdrive',
    network: 'eip155:8453',
    payer: `0x${'1'.repeat(40)}`,
    filename: 'layout.psd',
    transaction: `0x${'a'.repeat(64)}`,
  };
  assert.deepEqual(validateEntitlementReceiptMetadata(valid), valid);
  for (const override of [
    { receipt_id: 'Bearer secret-capability' },
    { source_provider: 'https://evil.example/token' },
    { source_provider: 'coinbase-payments-mcp' },
    { network: 'eip155:1' },
    { payer: '0x1234' },
    { filename: 'layout.psd\nsecret' },
    { filename: `${'x'.repeat(256)}.psd` },
    { transaction: '0xabc' },
  ]) {
    assert.throws(
      () => validateEntitlementReceiptMetadata({ ...valid, ...override }),
      /metadata is invalid/,
    );
  }
});
