---
name: curatoria-setup
description: "End-to-end Curatoria starter setup for creators and technical users: detect skill level, choose Track A vs B, configure accounts and env, local smoke, publish products, testnet deploy (Vercel default), public-link storage, mainnet CDP gate, and catalog price config. Use when setting up curatoria-starter, selling design systems to AI agents, x402 paywall, Base Sepolia testnet, npm run bug-bash, npm run smoke, publish-design, publish-pack, Vercel deploy, or 'how do I set up Curatoria'. Triggers on curatoria-starter, creator setup, paywall service, go live on Base."
user-invocable: true
disable-model-invocation: false
allowed-tools: ["Bash(npm *)", "Bash(node *)", "Bash(curl *)", "Bash(cp *)", "Bash(mkdir *)", "Bash(npx vercel*)", "Read(docs/creator/*)"]
---

# Curatoria Setup

Guide a creator through the full curatoria-starter arc. Complete phases in order unless the user explicitly skips ahead.

**Simplicity rule:** One default path (Track A + Vercel + local demo files first). Offer Track B only when the user asks.

**Operator dogfood:** Before each starter export, operator agents run Phase 3 local smoke against a fresh `export-starter.sh` clone. If dogfood finds friction, fix operator first, then re-export.

**Reference:** [`references/happy-path-checklist.md`](references/happy-path-checklist.md)

---

## Step 0 — Detect skill level

Ask one question early:

> Are you comfortable in the terminal and editing config files, or do you want me to run commands and explain each step in plain language?

| Profile | How to help |
| --- | --- |
| **Normie** | Short sentences, run commands when they approve, state what each phase *proved*, avoid jargon (say "payment challenge" not "x402 v2 middleware") |
| **Dev-comfortable** | Tighter steps, show curl/npm output, link to `docs/creator/` chapters, mention env var names |

---

## Step 1 — Choose discovery track

Offer both tracks with tradeoffs (from `docs/creator/01-before-you-start.md`). **Default: Track A.**

| | **Track A — Free catalog (default)** | **Track B — Paid catalog (optional)** |
| --- | --- | --- |
| Well-known | Full product list free | Free teaser only (count + pointer) |
| Catalog | Free full metadata (`/catalog` alias) | Paid `/catalog` per fetch (~$0.001 USDC) |
| Assets | Paid per file | Paid per file |
| Best for | Max discovery, demos; matches curatoria.dev | Monetize discovery metadata |
| Extra work | Works out of the box | Set `CATALOG_PAYWALL_ENABLED=1` |

If unsure, recommend **Track A**. Track B is env-gated — document but do not enable unless asked.

---

## Phase 1 — Prerequisites and accounts

**Read:** `docs/creator/00-accounts-and-env.md` (accounts, dependency order, env table).

Minimum accounts for happy path:

| Account | When | Why |
| --- | --- | --- |
| GitHub | Start | Template repo |
| Payout wallet (Coinbase Wallet recommended) | Before `.env` | Receives USDC |
| Vercel | Before testnet deploy | Default host |
| CDP (portal.cdp.coinbase.com) | Mainnet only | Facilitator API keys |

**Human gate (RED):** User creates wallet, CDP keys, Vercel login. Never ask for seed phrases or private keys.

Preflight in repo root:

```bash
ls package.json && npm install
test -f .env || cp .env.example .env
```

---

## Phase 2 — Environment

Minimum `.env` for local testnet (repo root — `npm run dev` loads it automatically):

```bash
# Replace placeholder before accepting real payments (valid hex format required for npm run dev).
WALLET_ADDRESS=0x0000000000000000000000000000000000000001
ADMIN_API_KEY=change-me-admin-key
NETWORK=base-sepolia
PORT=3000
FACILITATOR_URL=https://x402.org/facilitator
```

**Read:** `docs/creator/02-wallet-basics.md`

Fund test wallet (testnet only):

- Base Sepolia ETH: [CDP Faucet](https://portal.cdp.coinbase.com/products/faucet)
- Base Sepolia USDC: [Circle Faucet](https://faucet.circle.com/)

**Confidence builder:** After `npm run dev`, `curl http://localhost:3000/health` should show `status: ok`, `network: base-sepolia`, and their wallet.

---

## Phase 3 — Local smoke

```bash
npm run dev   # terminal A
npm run smoke # terminal B
```

**Proves:** Service runs; free catalog at well-known with `design_systems[]`; demo asset routes return 402.

Optional deeper gate:

```bash
npm run bug-bash -- --local
```

**Proves:** Health + catalog + markdown/bundle 402 + Bazaar metadata in challenges.

For Track B local dev only: `CATALOG_PAYWALL_ENABLED=1` (and optional `CATALOG_PAYWALL_BYPASS=1`) — **never in production unless intentional**.

**Read:** `docs/creator/06-test-on-testnet.md`

---

## Phase 4 — Publish a product (local demo)

Starter ships demo products (`curatoria-demo-md`, `curatoria-demo-pack`). For a custom product:

```bash
npm run publish-design -- \
  --id my-product \
  --file design-systems/my-product.md \
  --name "My Product" \
  --price 0.05 \
  --desc "One sentence" \
  --tags design
```

Verify:

```bash
curl -s http://localhost:3000/.well-known/design-catalog.json | head
curl -v http://localhost:3000/design-systems/my-product
# → 402 Payment Required
```

**Proves:** Registry updated; catalog knows the product; paywall active.

**Read:** `docs/creator/04-products-and-prices.md`, `docs/creator/05-markdown-vs-bundle.md`

---

## Phase 5 — Testnet deploy (Vercel default)

**Default happy path:** Vercel + GitHub connect.

1. Push repo to user's GitHub (user approves).
2. Import in Vercel; set env vars from `.env` (no `CATALOG_PAYWALL_BYPASS`).
3. Deploy; set `PUBLIC_BASE_URL=https://yourdomain.com` when custom domain is ready.

```bash
npx vercel@latest --prod   # if user prefers CLI
```

Verify production:

```bash
curl https://YOUR_DOMAIN/health
curl https://YOUR_DOMAIN/.well-known/design-catalog.json
curl https://YOUR_DOMAIN/catalog   # → 200 with design_systems[]
curl -v https://YOUR_DOMAIN/design-systems/curatoria-demo-md   # → 402
```

**Human gate (RED):** Deploy approval if not pre-authorized; domain DNS; Vercel env secrets.

**Proves:** Public catalog returns 200 with product metadata; unpaid assets return 402.

**Read:** `docs/creator/07-go-live.md` (testnet sections)

---

## Phase 6 — Storage (public-link)

Production path: files stay in creator storage; server fetches after payment.

```bash
# Google Drive — file shared "Anyone with the link can view"
npm run publish-design -- --id my-doc --gdrive-id "<file-id-or-share-url>" \
  --name "My Doc" --price 0.05

# Dropbox share URL
npm run publish-pack -- --id my-pack --dropbox-url "https://www.dropbox.com/s/.../file.zip?dl=0" \
  --name "My Pack" --price 0.10

# Direct HTTPS URL
npm run publish-design -- --id my-doc --url "https://files.example.com/doc.md" \
  --name "My Doc" --price 0.05
```

Local `design-systems/` files remain valid for demo and smoke — not required for production.

**Proves:** Paid fetch returns bytes with `X-Storage-Source` header (not `local`) after optional paid test.

**Read:** `docs/creator/03-connect-your-storage.md`

---

## Phase 7 — Optional paid catalog (Track B)

Only when user wants to monetize catalog discovery:

- Env: `CATALOG_PAYWALL_ENABLED=1` and `CATALOG_PRICE_USD=0.001`
- Or registry: `owner.catalog_price_usd` in `design-systems/.registry.json`

Verify unpaid `/catalog` → 402; well-known switches to teaser.

**Proves:** Two-tier discovery (optional advanced mode).

**Read:** `docs/creator/04-products-and-prices.md`, `docs/creator/08-bazaar-listing.md`

---

## Phase 8 — Mainnet + CDP (human pause)

**Stop/go:** Do not flip to mainnet until testnet bug-bash is green.

**Human gates (RED):**

- CDP API key creation (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`)
- Set `NETWORK=base`, `FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402` on host
- Small paid mainnet test (real USDC spend — user must approve)

Preflight (no spend):

```bash
curl -H "X-Admin-Key: $ADMIN_API_KEY" https://YOUR_DOMAIN/admin/facilitator-preflight
# → ok: true
```

Optional paid proof (user approves spend):

```bash
AWAL_PAID_TEST=1 npm run bug-bash -- --prod --paid
```

**Proves:** Facilitator green; at least one paid asset settles to payout wallet.

**Read:** `docs/creator/07-go-live.md`

---

## Phase 9 — Bazaar discovery (Track A default)

On mainnet with CDP Facilitator, asset routes are **auto-indexed** after successful settlement. No separate Bazaar registration in Curatoria.

**Track A (default):** Agents read `GET /.well-known/design-catalog.json` for free, then pay per asset. Bazaar metadata appears on unpaid asset `402` responses only.

Verify locally (unpaid):

```bash
curl -v http://localhost:3000/design-systems/curatoria-demo-md   # → 402 + Bazaar extensions
```

After mainnet deploy + optional paid settlement:

```bash
npx awal@2.10.0 x402 bazaar search YOUR_DOMAIN
```

**Notes:**

- Indexing is asynchronous (hours). Absence after one settlement is normal.
- If you previously ran Track B paid `/catalog`, Bazaar may show a stale catalog row after switching to Track A. Direct agents to well-known.
- [Agentic.Market](https://agentic.market) surfaces Bazaar services automatically; featured placement is Coinbase discretion.

**Read:** `docs/creator/08-bazaar-listing.md`

---

## Human gates summary

| Step | Gate | Color |
| --- | --- | --- |
| Wallet / CDP keys | User creates in browser | RED |
| GitHub push | User account | RED |
| Vercel deploy | User approves unless pre-authorized | RED |
| Mainnet USDC spend | Explicit approval | RED |
| awal OTP | User authenticates buyer wallet | RED |

Agents run GREEN commands when user approves shell execution.

---

## Automation

When user approves, run commands via shell. After each phase, state **what was proven** in one line.

| Phase | Proof statement |
| --- | --- |
| Local smoke | "Free catalog at well-known; 402 on demo asset routes" |
| Bug-bash | "Full local gate green including Bazaar metadata" |
| Deploy | "Production catalog 200; unpaid assets 402" |
| Storage | "Paid response served from gdrive/dropbox/url" |
| Mainnet | "Facilitator preflight ok; paid settlement confirmed" |
| Bazaar | "Asset routes in CDP index after mainnet settlement; well-known is free catalog entry" |

---

## Shared rules

- Never commit `.env`, private keys, or seed phrases.
- Product IDs are permanent once shared.
- Stay on `base-sepolia` until bug-bash passes.
- Paid proof is opt-in — not required for normie success.
- Troubleshooting: `docs/creator/09-troubleshooting.md`

---

## Quick commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Local server |
| `npm run smoke` | Fast unpaid checks |
| `npm run bug-bash -- --local` | Full local gate |
| `npm run publish-design -- --id ...` | Markdown product |
| `npm run publish-pack -- --id ...` | Zip bundle |
| `npm run build && npm run start` | Production start |

