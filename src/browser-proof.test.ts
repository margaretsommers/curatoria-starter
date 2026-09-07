import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBrowserProofReceipt,
  entitlementFingerprint,
  sanitizePaymentResponse,
} from './browser-proof';

const payer = '0x2222222222222222222222222222222222222222';
const payment = {
  success: true,
  transaction: `0x${'a'.repeat(64)}`,
  network: 'eip155:8453',
  payer,
  signature: 'must-not-be-copied',
};
const purchase = {
  receipt_id: `rcpt_${'r'.repeat(43)}`,
  product_id: 'layout',
  source_provider: 'gdrive',
  network: 'eip155:8453',
  payer,
  transaction: payment.transaction,
  entitlement: 'secret-bearer-entitlement',
  content_sha256: 'a'.repeat(64),
  content_bytes: 8,
  filename: 'layout.psd',
  mime_type: 'image/vnd.adobe.photoshop',
};

test('browser proof binds transaction, product, entitlement fingerprint, and bytes', () => {
  const receipt = createBrowserProofReceipt({
    purchase,
    paymentResponse: Buffer.from(JSON.stringify(payment)).toString('base64url'),
    actualSha256: 'a'.repeat(64),
    actualBytes: 8,
    psd8bps: true,
    verifiedAt: '2026-08-29T12:00:00.000Z',
  });

  assert.equal(receipt.receipt_id, purchase.receipt_id);
  assert.equal(receipt.transaction, payment.transaction);
  assert.equal(receipt.entitlement_fingerprint, entitlementFingerprint(purchase.entitlement));
  assert.equal(receipt.disk_verification_required, true);
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /secret-bearer-entitlement|must-not-be-copied/);
  assert.doesNotMatch(serialized, /download_url|payment_signature|signature/);
});

test('browser proof rejects transaction, payer, network, hash, byte, and PSD mismatches', () => {
  const base = {
    purchase,
    paymentResponse: payment,
    actualSha256: 'a'.repeat(64),
    actualBytes: 8,
    psd8bps: true,
  };
  assert.throws(
    () => createBrowserProofReceipt({ ...base, paymentResponse: { ...payment, transaction: '' } }),
    /transaction identity/,
  );
  assert.throws(
    () =>
      createBrowserProofReceipt({
        ...base,
        paymentResponse: { ...payment, transaction: `0x${'b'.repeat(64)}` },
      }),
    /does not match/,
  );
  assert.throws(
    () => createBrowserProofReceipt({ ...base, paymentResponse: { ...payment, payer: `0x${'3'.repeat(40)}` } }),
    /does not match/,
  );
  assert.throws(
    () => createBrowserProofReceipt({ ...base, paymentResponse: { ...payment, network: 'eip155:84532' } }),
    /does not match/,
  );
  assert.throws(
    () => createBrowserProofReceipt({ ...base, actualSha256: 'b'.repeat(64) }),
    /does not match/,
  );
  assert.throws(
    () => createBrowserProofReceipt({ ...base, actualBytes: 7 }),
    /does not match/,
  );
  assert.throws(
    () => createBrowserProofReceipt({ ...base, psd8bps: false }),
    /does not match/,
  );
});

test('PAYMENT-RESPONSE sanitizer returns metadata only', () => {
  assert.deepEqual(sanitizePaymentResponse(payment), {
    transaction: payment.transaction,
    network: payment.network,
    payer,
  });
});
