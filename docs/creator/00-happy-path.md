# 00 - Happy Path Checklist

> **Available today:** yes
> **Requires terminal:** yes

Use this as the front door. Each step links to detail in [`00-accounts-and-env.md`](00-accounts-and-env.md) and the numbered chapters below.

**Discovery track:** Default is **Track A** (free full catalog at well-known + paid assets). Optional **Track B** (`CATALOG_PAYWALL_ENABLED=1`): teaser → paid `/catalog` → paid assets. Comparison: [`01-before-you-start.md`](01-before-you-start.md).

## Checklist

- [ ] **1. Clone the starter**
  - Create a repo from [curatoria-starter](https://github.com/margaretsommers/curatoria-starter), clone locally, `npm install`.
  - Detail: [Accounts — GitHub](00-accounts-and-env.md#github)

- [ ] **2. Configure environment**
  - `cp .env.example .env`
  - Set `WALLET_ADDRESS`, `ADMIN_API_KEY`, `NETWORK=base-sepolia`, `FACILITATOR_URL=https://x402.org/facilitator`
  - Detail: [`02-wallet-basics.md`](02-wallet-basics.md), [env reference](00-accounts-and-env.md#environment-variables-reference)

- [ ] **3. Local smoke**
  - `npm run dev` → open `/health` and `/.well-known/design-catalog.json`
  - `npm run smoke` — health, free catalog at well-known, unpaid asset 402s
  - Detail: [`06-test-on-testnet.md`](06-test-on-testnet.md) §3–5

- [ ] **4. Testnet proof**
  - Fund test wallet (CDP ETH faucet + Circle USDC faucet)
  - `npm run bug-bash -- --local`
  - Optional: `AWAL_PAID_TEST=1 npm run bug-bash -- --local --paid` after awal auth + buyer funding
  - Detail: [`06-test-on-testnet.md`](06-test-on-testnet.md)

- [ ] **5. Storage (when moving beyond demo files)**
  - Production path: Google Drive, Dropbox link, or HTTPS URL via publish flags — not required for first local bug-bash
  - Local `design-systems/` stays valid for demo and smoke
  - Detail: [`03-connect-your-storage.md`](03-connect-your-storage.md)

- [ ] **6. Deploy**
  - Connect repo to Vercel (or Railway / Fly / Render)
  - Set env vars in host dashboard; `npm run build` if required
  - Point custom domain; set `PUBLIC_BASE_URL=https://yourdomain.com`
  - Detail: [`07-go-live.md`](07-go-live.md), [dependency order](00-accounts-and-env.md#dependency-order)

- [ ] **7. Optional Track B (paid catalog)**
  - Only if you want per-fetch catalog revenue: set `CATALOG_PAYWALL_ENABLED=1` and `CATALOG_PRICE_USD` (or `owner.catalog_price_usd` in registry)
  - Confirm unpaid `/catalog` returns 402; well-known switches to teaser
  - Detail: [`04-products-and-prices.md`](04-products-and-prices.md), [`08-bazaar-listing.md`](08-bazaar-listing.md)

- [ ] **8. Mainnet (when ready)**
  - `NETWORK=base`, CDP facilitator URL + `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`
  - `/admin/facilitator-preflight` green, then small paid test
  - Detail: [`07-go-live.md`](07-go-live.md), [mainnet env](00-accounts-and-env.md#environment-variables-reference)

## If Something Breaks

Start with [`09-troubleshooting.md`](09-troubleshooting.md) and [common failure modes](00-accounts-and-env.md#common-failure-modes).

## Chapter Map

| Step | Chapter |
| --- | --- |
| Understand the model | [`01-before-you-start.md`](01-before-you-start.md) |
| Wallet | [`02-wallet-basics.md`](02-wallet-basics.md) |
| Storage | [`03-connect-your-storage.md`](03-connect-your-storage.md) |
| Products + catalog price | [`04-products-and-prices.md`](04-products-and-prices.md) |
| Markdown vs zip | [`05-markdown-vs-bundle.md`](05-markdown-vs-bundle.md) |
| Testnet | [`06-test-on-testnet.md`](06-test-on-testnet.md) |
| Go live | [`07-go-live.md`](07-go-live.md) |
| Bazaar / discovery | [`08-bazaar-listing.md`](08-bazaar-listing.md) |
| Self-hosting options | [`appendix-self-host.md`](appendix-self-host.md) |
