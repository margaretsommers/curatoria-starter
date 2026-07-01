---
name: creator-setup
description: "End-to-end Phase 5 creator onboarding for curatoria-starter: wallet setup (CDP-first), storage, product publishing, Bazaar metadata, testnet bug-bash checks, optional paid proof, and mainnet go-live. Use when a creator mentions setting up curatoria, selling design systems or digital products to AI agents, configuring a payout wallet, publishing products, running bug-bash or smoke tests, going live on Base mainnet, registering a catalog for discovery, or following the Curatoria creator guide. Also triggers on: 'curatoria-starter', 'start selling', 'x402 catalog', 'base-sepolia', 'design system products', 'paywall service', 'publish-design', 'publish-pack', 'npm run bug-bash', 'npm run smoke', or 'how do I set up curatoria'."
user-invocable: true
disable-model-invocation: false
allowed-tools: ["Bash(npm *)", "Bash(node *)", "Bash(curl *)", "Bash(cp *)", "Bash(mkdir *)", "Read(docs/creator/*)"]
---

# Creator Setup

Guide a creator through the complete curatoria-starter onboarding in six ordered phases. Complete each phase before the next. Reference the doc chapter listed in each phase's routing table; read it before giving instructions.

## Preflight: Confirm Repo State

Before any phase, confirm the creator has cloned and installed the starter:

```bash
# In the curatoria-starter directory
ls package.json          # confirm repo root
npm install              # install if not done
ls .env 2>/dev/null || echo "needs .env"
```

If `.env` does not exist, run Phase 1 wallet setup first.

---

## Phase Routing

| Phase | Goal | Chapter |
| --- | --- | --- |
| 1 — Wallet | Configure payout wallet (CDP-first), write `.env`, fund test wallet | `docs/creator/02-wallet-basics.md` |
| 2 — Storage | Place product files in `design-systems/` or publish from URL, Google Drive, or Dropbox | `docs/creator/03-connect-your-storage.md` |
| 3 — Publish | Publish markdown and/or bundle products with CLI, verify catalog | `docs/creator/04-products-and-prices.md` |
| 4 — Bazaar | Verify catalog URL, confirm built-in 402 metadata, share catalog links manually | `docs/creator/08-bazaar-listing.md` |
| 5 — Testnet Proof | Run `npm run bug-bash -- --local`, confirm Markdown + bundle 402, optional paid proof | `docs/creator/06-test-on-testnet.md` |
| 6 — Go Live | Switch to `NETWORK=base`, deploy service, run mainnet payment check | `docs/creator/07-go-live.md` |

Read the relevant chapter before giving phase-specific instructions.

---

## Phase 1 — Wallet (CDP-First)

**Read `docs/creator/02-wallet-basics.md` before proceeding.**

Recommended: **Coinbase Wallet + CDP** (aligns with the x402 facilitator Curatoria uses by default and gives the clearest testnet-to-mainnet path).

Minimum `.env` for testnet:

```bash
WALLET_ADDRESS=0xYOUR_BASE_SEPOLIA_WALLET
ADMIN_API_KEY=change-me-admin-key
NETWORK=base-sepolia
PORT=3000
FACILITATOR_URL=https://x402.org/facilitator
```

Hard rules:
- Never put private keys, seed phrases, or recovery phrases in `.env` or any file in the repo.
- `.env` is already in `.gitignore`; confirm this before the creator commits.
- `WALLET_ADDRESS` must be a Base-compatible EVM `0x...` address.

Fund test wallet before any smoke check:
- Base Sepolia test ETH: [CDP Faucet](https://portal.cdp.coinbase.com/products/faucet)
- Base Sepolia test USDC: [Circle Testnet Faucet](https://faucet.circle.com/)

Verify after configuration:

```bash
npm run dev &
curl http://localhost:3000/health
# expected: { "status": "ok", "network": "base-sepolia", "wallet": "0x..." }
```

Stop here if `network` is wrong or `wallet` is missing.

---

## Phase 2 — Storage

**Read `docs/creator/03-connect-your-storage.md` before proceeding.**

Today, sellable files can live in `design-systems/` or stay in cloud storage you already use. Local folder is the default; URL, Google Drive, and Dropbox sources are available via publish flags.

Creator workflow:
1. Export or copy the finished `.md` or `.zip` file to the local machine.
2. Place it under `design-systems/`.
3. Do not point the registry at external paths, cloud sync folders, or temp downloads.

Required layout before publishing:

```text
design-systems/
├── .registry.json        ← written by publish CLI
├── example-minimal.md   ← ships with starter
└── your-product.md      ← creator's file
```

---

## Phase 3 — Publish Products

**Read `docs/creator/04-products-and-prices.md` before proceeding.**

### Markdown product

```bash
npm run publish-design -- \
  --id YOUR-PRODUCT-ID \
  --file design-systems/your-product.md \
  --name "Your Product Name" \
  --price 0.05 \
  --desc "One-sentence description" \
  --tags design,tokens
```

### Bundle (zip) product

```bash
npm run publish-pack -- \
  --id YOUR-BUNDLE-ID \
  --zip design-systems/your-bundle.zip \
  --name "Your Bundle Name" \
  --price 0.10 \
  --desc "Short bundle description" \
  --tags assets,bundle
```

Verify the product appears in the catalog immediately (no server restart needed):

```bash
curl http://localhost:3000/.well-known/design-catalog.json
```

Confirm the new product ID is present in `design_systems` array. The paid route should return `402` unpaid:

```bash
curl -v http://localhost:3000/design-systems/YOUR-PRODUCT-ID
# expected: HTTP/1.1 402 Payment Required
```

**ID rules:** lowercase letters, numbers, and hyphens only. Do not change an ID after sharing it — the ID is part of the paid URL.

See `docs/creator/05-markdown-vs-bundle.md` for help choosing product format.

---

## Phase 4 — Bazaar Discovery

**Read `docs/creator/08-bazaar-listing.md` before proceeding.**

Curatoria attaches Bazaar discovery metadata to each `402` challenge today. External directory indexing is still not guaranteed, so the creator must keep the catalog URL stable and share it where agents can find it.

Today's working approach:

1. Confirm the deployed catalog URL:
   ```bash
   curl https://YOUR_DOMAIN/.well-known/design-catalog.json
   ```
2. Confirm unpaid paid routes include an `X-PAYMENT-REQUIRED` challenge with Bazaar extension metadata. The Phase 5 bug bash checks this automatically.
3. Share the catalog URL wherever agents or buyers can find it:
   - Link from your website
   - Add to `llms.txt` if you maintain one
   - Include in launch posts, product docs, and demos
   - Submit to any Bazaar or x402 directory that accepts manual submissions

Keep the catalog URL stable. Agents revisit it to check products and prices. Do not promise zero-touch external Bazaar indexing yet.

---

## Phase 5 — Testnet Proof

**Read `docs/creator/06-test-on-testnet.md` before proceeding.**

Start the service in one terminal:

```bash
npm run dev
```

In another terminal, run the bug bash first:

```bash
npm run bug-bash -- --local
```

The bug bash checks: health endpoint, catalog endpoint, unpaid Markdown `402`, unpaid bundle `402`, and Bazaar metadata in the payment challenge.

If the creator only wants the smaller legacy check, run smoke after bug bash:

```bash
npm run smoke
```

The smoke command checks: health endpoint, catalog endpoint, and unpaid paywall behavior. It is not the main proof gate when bundles and Bazaar metadata matter.

Manual verification checklist — pass all five before moving to mainnet:

```bash
# 1. Health
curl http://localhost:3000/health
# → { "status": "ok", "network": "base-sepolia", "wallet": "0x..." }

# 2. Free catalog
curl http://localhost:3000/.well-known/design-catalog.json
# → includes your products

# 3. Unpaid Markdown 402
curl -v http://localhost:3000/design-systems/YOUR-PRODUCT-ID
# → HTTP/1.1 402 Payment Required + X-PAYMENT-REQUIRED header

# 4. Unpaid bundle 402, if selling bundles or using the starter demo bundle
curl -v http://localhost:3000/packs/YOUR-BUNDLE-ID/download
# → HTTP/1.1 402 Payment Required + X-PAYMENT-REQUIRED header

# 5. Optional paid proof with a funded buyer wallet
AWAL_PAID_TEST=1 npm run bug-bash -- --local --paid
```

Paid proof rules:
- Treat the buyer wallet as separate from the payout wallet, even when the same human controls both.
- Confirm `payTo` in the `402` challenge matches `/health.wallet` before paying.
- If `awal` is not authenticated or funded, skip paid proof and print the human next step. Do not invent keys or put signing material in the repo.

**Stop/go gate:** do not switch to mainnet until bug bash is green and paid proof is either green or explicitly deferred by the creator. Fix testnet issues first.

---

## Phase 6 — Go Live

**Read `docs/creator/07-go-live.md` before proceeding.**

### Switch environment

```bash
WALLET_ADDRESS=0xYOUR_BASE_MAINNET_WALLET
ADMIN_API_KEY=use-a-long-random-secret
NETWORK=base
PORT=3000
FACILITATOR_URL=https://x402.org/facilitator
```

Set these as secrets in your host's dashboard. Do not commit to source control.

### Deploy

Any host that runs a long-lived Node app works: Railway, Fly.io, Render, VPS, EC2.

```bash
npm install
npm run build    # if host requires a build step
npm run start
```

### Verify production

```bash
curl https://yourdomain.com/health
curl https://yourdomain.com/.well-known/design-catalog.json
curl -v https://yourdomain.com/design-systems/YOUR-PRODUCT-ID
# last one should still return 402
```

### Mainnet launch checklist

- `NETWORK=base` is set.
- Mainnet payout wallet configured and tested (send yourself a small amount first).
- Admin key rotated from any demo value.
- Catalog URL resolves publicly.
- Unpaid paid routes return `402`.
- At least one paid Markdown request succeeds with real USDC.
- Paid bundle flow succeeds if selling bundles.
- `/health` is monitored.
- Support/DMCA contact is public somewhere.

---

## Shared Rules

- **Never commit `.env`, private keys, seed phrases, or recovery phrases.**
- **Product IDs are permanent** once shared; the ID is the paid URL path.
- **Stay on `base-sepolia`** until the full testnet bug bash passes.
- **Bug bash before mainnet** — `npm run bug-bash -- --local` is the main gate; `npm run smoke` is the smaller legacy check.
- **Paid proof is opt-in** — use `AWAL_PAID_TEST=1` only after a buyer wallet is authenticated and funded.
- If `.env` values look wrong, re-read Phase 1 and `docs/creator/02-wallet-basics.md`.
- If product does not appear in catalog, check `design-systems/.registry.json` directly.
- For persistent issues, read `docs/creator/09-troubleshooting.md`.

---

## Quick Command Index

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start local dev server |
| `npm run bug-bash -- --local` | Health + catalog + Markdown 402 + bundle 402 + Bazaar metadata |
| `AWAL_PAID_TEST=1 npm run bug-bash -- --local --paid` | Optional paid x402 proof after buyer wallet auth/funding |
| `npm run smoke` | Health + catalog + paywall smoke check |
| `npm run publish-design -- --id ...` | Publish a markdown product |
| `npm run publish-pack -- --id ...` | Publish a bundle product |
| `curl localhost:3000/health` | Verify server + wallet config |
| `curl localhost:3000/.well-known/design-catalog.json` | Inspect free catalog |
| `curl -v localhost:3000/design-systems/:id` | Confirm unpaid 402 |
| `npm run build && npm run start` | Production start |

## Related Skills

- `agentic-wallet` — wallet auth, balance, send USDC, x402 pay, Bazaar search
