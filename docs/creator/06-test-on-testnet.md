# 06 - Test On Testnet

> **Available today:** yes
> **Requires terminal:** yes

Test on Base Sepolia before accepting real payments. The testnet flow uses the same Curatoria routes and x402 challenge pattern, but the ETH and USDC are faucet funds with no real value.

## 1. Configure Testnet

Create or update `.env`:

```bash
WALLET_ADDRESS=0xYOUR_BASE_SEPOLIA_WALLET
ADMIN_API_KEY=change-me-admin-key
NETWORK=base-sepolia
PORT=3000
FACILITATOR_URL=https://x402.org/facilitator
```

Set `WALLET_ADDRESS` to the public receive address for your dedicated test wallet. Do not commit `.env`.

## 2. Fund Your Test Wallet

Add testnet funds:

1. Base Sepolia test ETH from the [CDP Faucet](https://portal.cdp.coinbase.com/products/faucet).
2. Base Sepolia test USDC from the [Circle testnet faucet](https://faucet.circle.com/).

Stop here if the funds do not appear in your wallet. Payment tests will fail without both gas and test USDC.

## 3. Start The Server

```bash
npm run dev
```

In another terminal, check health:

```bash
curl http://localhost:3000/health
```

Expected:

```json
{
  "status": "ok",
  "network": "base-sepolia",
  "wallet": "0x..."
}
```

## 4. Check Free Discovery

```bash
curl http://localhost:3000/.well-known/design-catalog.json
```

The response should include `owner`, `total`, `base_url`, and a `design_systems` array. This endpoint stays free so agents can discover products and prices before paying.

## 5. Check The Unpaid Paywall

```bash
curl -v http://localhost:3000/design-systems/example-minimal
```

Expected: `HTTP/1.1 402 Payment Required` and an `X-PAYMENT-REQUIRED` header.

You can also run the smoke checks:

```bash
npm run smoke
```

The smoke command checks health, catalog, and unpaid paywall behavior. It does not prove that a paid settlement succeeded.

## 6. Run A Paid Request

Use an x402-compatible client with a funded Base Sepolia buyer wallet. The client must:

1. Request the paid URL.
2. Read the `402` challenge.
3. Sign the payment authorization from the buyer wallet.
4. Retry with the `X-PAYMENT` header.
5. Confirm the server returns the paid content.

For a Markdown product, test:

```text
GET http://localhost:3000/design-systems/example-minimal
```

For a bundle product, test:

```text
GET http://localhost:3000/packs/starter-bundle/download
```

Keep buyer wallet signing material outside committed files. If you use a script, load sensitive values from local environment variables or a local secret manager.

## Stop/Go Checklist

Go forward only when:

- `/health` is `ok`.
- The health response shows `base-sepolia`.
- The catalog endpoint returns your active products.
- Unpaid paid-route requests return `402`.
- At least one paid request returns the expected Markdown or zip content.

Stop if faucet funds are missing, `.env` values are incomplete, or paid settlement fails. Fix testnet first; do not switch to mainnet while the test flow is unstable.
