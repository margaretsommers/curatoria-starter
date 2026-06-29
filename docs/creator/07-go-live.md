# 07 - Go Live

> **Available today:** partial
> **Requires terminal:** yes

Go live only after your Base Sepolia test flow works end to end. Mainnet uses the same app and routes, but payments settle in real USDC on Base.

**Track A (default):** is the starter default: free full catalog at well-known, paid assets only. **Track B** (`CATALOG_PAYWALL_ENABLED=1`): free teaser at well-known, paid `GET /catalog`, paid assets — see [`01-before-you-start.md`](01-before-you-start.md).

## Before You Switch

Confirm:

- Your products are final enough to sell.
- `npm run smoke` passes.
- A real testnet paid request succeeds.
- Your support or DMCA contact email is published somewhere public.
- You control the payout wallet and can access incoming Base USDC.
- Your `.env` is stored only in your host's secret manager or local machine.

## Mainnet Environment

Set production environment variables on your host:

```bash
WALLET_ADDRESS=0xYOUR_BASE_MAINNET_WALLET
ADMIN_API_KEY=use-a-long-random-secret
NETWORK=base
PORT=3000
PUBLIC_BASE_URL=https://yourdomain.com
FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
CDP_API_KEY_ID=your-cdp-api-key-id
CDP_API_KEY_SECRET=your-cdp-api-key-secret
```

**Track B (optional)** — enable paid catalog with `CATALOG_PAYWALL_ENABLED=1` and catalog price:

```bash
# CATALOG_PRICE_USD=0.001
```

Leave `CATALOG_PAYWALL_BYPASS` unset in production. Set `PUBLIC_BASE_URL` to your live domain so `base_url` and product `access_url` values in paid catalog JSON are correct.

Use a real Base mainnet payout wallet. If you use Coinbase Wallet, confirm you are viewing the Base network and copying the Base-compatible EVM address.
Use Coinbase Developer Platform API credentials for the CDP facilitator. Store the key ID and secret only in your host's secret manager or local `.env`; never commit them.
Do not rely on a legacy or partial CDP key name alone: mainnet preflight requires both `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` to be present in the production environment that your deployed service actually uses.

## Deploy The Service

Curatoria is a Node service. Any host that can run a long-lived Node app can work, including Railway, Fly.io, Render, a VPS, or EC2.

Typical deployment shape:

1. Connect the repository to your host.
2. Set environment variables in the host dashboard.
3. Install dependencies with `npm install`.
4. Build if your host requires it:

```bash
npm run build
```

5. Start the service:

```bash
npm run start
```

The production service should serve free discovery metadata, paid catalog access (Track B), and paid asset routes from the same domain.

## Set Your Domain

Point your domain to the host according to that provider's DNS instructions. Once DNS resolves, verify:

```bash
curl https://yourdomain.com/health
curl https://yourdomain.com/.well-known/design-catalog.json
curl -v https://yourdomain.com/catalog
curl -v https://yourdomain.com/design-systems/example-minimal
```

**Track B expectations:**

- Well-known returns a teaser — `owner`, `total`, `paid_catalog_url`, no `design_systems` array.
- Unpaid `GET /catalog` returns `402 Payment Required` with catalog x402 metadata.
- Unpaid asset routes return `402`.

**Track A expectations** (if you customized well-known to serve the full listing):

- Well-known returns `design_systems[]` with active products.
- Asset routes still return `402` when unpaid.

Either track: unpaid asset `402` means the paywall is active.

## Preflight The Facilitator

Before a real payment, verify the CDP facilitator can authenticate without spending USDC:

```bash
curl -H "X-Admin-Key: $ADMIN_API_KEY" https://yourdomain.com/admin/facilitator-preflight
```

The response should have `ok: true`, `cdpAuthConfigured: true`, and `supportsNetwork: true`. This calls the facilitator's `/supported` endpoint only; it does not verify, settle, or charge a buyer.

If the response says `cdpAuthConfigured: true` but returns `401 Unauthorized`, stop. Your app found CDP credentials, but Coinbase rejected the key, secret, or permissions for x402. Fix that before checking buyer balances or running any paid request.

This is a real mainnet launch gate, not just an environment-shape check. A redeployed service can report `NETWORK=base` and the correct payout wallet while still being unable to serve paid mainnet routes if Coinbase rejects the CDP credential pair.

After preflight passes, check one unpaid paid-route response before spending. Confirm the `402` challenge uses `network: "eip155:8453"`, Base USDC asset `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, and a `payTo` address that matches your payout wallet. Record the buyer wallet balance before and after your first paid request. If the payment client exits ambiguously or you cannot confirm paid content delivery and settlement, stop and investigate logs instead of retrying repeatedly.

## Run A Small Mainnet Payment

Before announcing widely:

1. Use the smallest product price you are comfortable testing.
2. Pay from a buyer wallet that has Base USDC.
3. Confirm the paid content is returned.
4. Confirm USDC arrives in your configured payout wallet.
5. Save the transaction hash and product ID for your launch notes.

## Facilitator And Scale Notes

The default testnet facilitator URL works for getting started on Base Sepolia:

```bash
FACILITATOR_URL=https://x402.org/facilitator
```

For mainnet, use Coinbase Developer Platform's facilitator at `https://api.cdp.coinbase.com/platform/v2/x402` with `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`. Keep provider API keys in your host's secret manager, not in source control. If `/admin/facilitator-preflight` reports `cdpAuthConfigured: false` or returns a Coinbase `401 Unauthorized` error, stop and fix the production env or CDP key permissions before running any paid request.

## Launch Checklist

- `NETWORK=base`.
- `PUBLIC_BASE_URL` set to your production domain.
- Mainnet payout wallet configured.
- CDP facilitator credentials configured.
- `/admin/facilitator-preflight` passes with `supportsNetwork: true`.
- No Coinbase `401 Unauthorized` error appears in the preflight response.
- Admin key rotated from any demo value.
- **`CATALOG_PAYWALL_BYPASS` unset** in production env.
- Well-known URL works publicly (`https://yourdomain.com/.well-known/design-catalog.json`).
- **Track B:** teaser shape correct (no product list at well-known); `owner.catalog_price_usd` or `CATALOG_PRICE_USD` set intentionally; unpaid `GET /catalog` returns `402`.
- **Track A:** well-known returns full `design_systems[]` if that is your chosen model.
- Unpaid asset routes return `402`.
- Paid catalog flow succeeds on Track B (optional but recommended before wide launch).
- Paid Markdown flow succeeds.
- Paid bundle flow succeeds if you sell bundles.
- Logs are visible.
- `/health` is monitored.
- Support/DMCA contact is public.
