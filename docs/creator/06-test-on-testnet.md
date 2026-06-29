# 06 - Test On Testnet

> **Available today:** yes
> **Requires terminal:** yes

Test on Base Sepolia before accepting real payments. The testnet flow uses the same Curatoria routes and x402 challenge pattern, but the ETH and USDC are faucet funds with no real value.

Your smoke and bug-bash expectations depend on which discovery track you run. **Track A (free full catalog)** is the shipped default. **Track B** (`CATALOG_PAYWALL_ENABLED=1`) changes well-known and `/catalog` behavior; see [`01-before-you-start.md`](01-before-you-start.md).

## 1. Configure Testnet

Create or update `.env`:

```bash
WALLET_ADDRESS=0xYOUR_BASE_SEPOLIA_WALLET
ADMIN_API_KEY=change-me-admin-key
NETWORK=base-sepolia
PORT=3000
FACILITATOR_URL=https://x402.org/facilitator
```

**Track B (optional)** — catalog price override:

```bash
# CATALOG_PRICE_USD=0.001
```

**Track A or local full-catalog reads** — dev bypass only (never production):

```bash
# CATALOG_PAYWALL_BYPASS=1
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

## 4. Check Discovery (Track-Specific)

### Track A — free full catalog (default)

```bash
curl http://localhost:3000/.well-known/design-catalog.json
```

Expected: `owner`, `total`, `base_url`, and a `design_systems` array with active products, prices, and `access_url` values.

```bash
curl http://localhost:3000/catalog
```

Expected: same `200` listing (free alias).

### Track B — paid catalog (optional)

Set `CATALOG_PAYWALL_ENABLED=1` in `.env`, restart, then:

**Step 1 — free teaser**

```bash
curl http://localhost:3000/.well-known/design-catalog.json
```

Expected: `owner`, `total`, `paid_catalog_url`, `payment_required: true` — **no** `design_systems` array.

**Step 2 — unpaid catalog paywall**

```bash
curl -v http://localhost:3000/catalog
```

Expected: `HTTP/1.1 402 Payment Required` with Bazaar directory metadata in the challenge.

## 5. Run The Bug Bash

```bash
npm run bug-bash -- --local
```

The bug bash is the main local gate. Shared checks (both tracks):

- `/health` is reachable and configured
- Unpaid markdown route returns `402 Payment Required`
- Unpaid bundle route returns `402 Payment Required`
- Each asset `402` challenge includes Bazaar discovery metadata

**Track A (default) checks:**

- Well-known returns `design_systems[]` with id, price_usd, access_url
- `/catalog` returns the same free listing
- Unpaid asset routes return `402`

**Track B additional checks** (when `CATALOG_PAYWALL_ENABLED=1`):

- Teaser returns correct shape (no product list leakage)
- Unpaid `GET /catalog` returns `402` with Bazaar metadata
- Per-fetch behavior: a second unpaid `GET /catalog` also returns `402` (unless bypass is set)
- Full catalog sanity runs when `/catalog` returns `200` (bypass or paid path) — skips with a note when catalog is still paywalled

**Track A additional checks:**

- If well-known serves full catalog: teaser sanity checks are replaced by full-catalog field checks on well-known
- Unpaid `/catalog` 402 checks are skipped when catalog is free (bypass or unpaywalled)
- Asset `402` checks still required

You can still run the smaller smoke command when you only need the core service checks:

```bash
npm run smoke
```

Smoke checks health, teaser shape (Track B), unpaid `/catalog` 402 (Track B, skipped when bypass is on), and unpaid asset paywalls. Bug bash is preferred before testnet proof because it also exercises bundle routes and Bazaar metadata expectations.

## 6. Check The Unpaid Asset Paywall Manually

For a Markdown product:

```bash
curl -v http://localhost:3000/design-systems/curatoria-demo-md
```

For a bundle product:

```bash
curl -v http://localhost:3000/packs/curatoria-demo-pack/download
```

Expected for both: `HTTP/1.1 402 Payment Required` and payment challenge headers. If you replaced the demo IDs, use your product IDs instead.

## 7. Optional Paid Proof

Unpaid `402` checks prove the service is presenting payment challenges. A paid proof additionally proves that a funded buyer wallet can pay and receive protected bytes.

Paid proof is optional during basic setup and required before you personally trust a catalog for real launch claims. Use an x402-compatible client with a funded Base Sepolia buyer wallet. The buyer wallet signs the payment; your configured `WALLET_ADDRESS` is the payout destination.

### Track B paid flow

The client must:

1. Request `GET /catalog` → read catalog `402` challenge
2. Confirm challenge `payTo` matches your payout wallet
3. Retry `GET /catalog` with `X-PAYMENT` → receive full `design_systems[]`
4. Request a product `access_url` → read asset `402` challenge
5. Retry with `X-PAYMENT` → receive markdown or zip bytes

### Track A paid flow

The client must:

1. Read free catalog (well-known or free `/catalog`)
2. Request a product `access_url` → read asset `402` challenge
3. Confirm challenge `payTo` matches your payout wallet
4. Retry with `X-PAYMENT` → receive paid content

### Awal opt-in

If you use `awal` for an agent-style paid test, keep it opt-in:

```bash
# Run only after the buyer wallet is authenticated and funded.
AWAL_PAID_TEST=1 npm run bug-bash -- --local --paid
```

On Track B, the paid bug-bash path pays for `/catalog` first, then for a demo asset. If authentication or balance is missing, the paid portion should skip and print the human next step instead of attempting payment. Keep buyer wallet signing material outside committed files.

## Stop/Go Checklist

Go forward only when:

- `/health` is `ok`
- The health response shows `base-sepolia`
- **Track B:** teaser shape is correct; unpaid `/catalog` returns `402`
- **Track A:** well-known (or free `/catalog`) returns full `design_systems[]`
- Unpaid markdown and bundle routes return `402`
- Asset `402` challenges include Bazaar metadata
- Optional paid proof is either green or explicitly deferred until the buyer wallet is funded/authenticated

Stop if faucet funds are missing, `.env` values are incomplete, or paid settlement fails. Fix testnet first; do not switch to mainnet while the test flow is unstable.
