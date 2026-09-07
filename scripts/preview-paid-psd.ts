/**
 * Local no-spend paid PSD preview. Loopback only, generated PSD only, fake
 * settlement explicitly labeled. Refuses production origins and production
 * wallet configuration. Never spends and never calls a live facilitator.
 */

import {
  FAKE_SETTLEMENT_LABEL,
  PREVIEW_PRODUCT_ID,
  PREVIEW_WALLET,
  assertPreviewAllowed,
  collectProductionWalletMarkers,
  createPreviewHarness,
  listenPreview,
  runPreviewPurchaseRedeem,
} from '../src/paid-psd-harness';

async function main(): Promise<void> {
  const productionMarkers = collectProductionWalletMarkers(process.env);
  assertPreviewAllowed({
    bindHost: '127.0.0.1',
    publicOrigin: 'http://127.0.0.1',
    walletAddress: PREVIEW_WALLET,
    allowedOrigins: ['http://127.0.0.1'],
    production: false,
    env: process.env,
  });
  if (productionMarkers.length > 0) {
    throw new Error(
      `Paid PSD preview refuses production wallet configuration (${productionMarkers.join(', ')}).`,
    );
  }

  const harness = createPreviewHarness({ env: {} });
  const listener = await listenPreview(harness.app);
  try {
    const result = await runPreviewPurchaseRedeem(listener.url, harness);
    console.log(
      JSON.stringify(
        {
          kind: FAKE_SETTLEMENT_LABEL,
          host: listener.host,
          product_id: PREVIEW_PRODUCT_ID,
          purchase_status: result.purchaseStatus,
          redeem_status: result.redeemStatus,
          receipt_id: result.receiptId,
          settlement_kind: result.settlementKind,
          spend: 0,
          production_markers: [],
        },
        null,
        2,
      ),
    );
  } finally {
    await listener.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Paid PSD preview failed.');
    process.exitCode = 1;
  });
}
