---
name: curatoria-setup
description: "End-to-end Curatoria starter setup for creators: clone the public starter, configure env, run local dev, smoke, and bug-bash, then choose storage/deploy/mainnet only after the local Track A path is green. Use when setting up curatoria-starter, selling design systems to AI agents, x402 paywall, Base Sepolia testnet, npm run bug-bash, npm run smoke, publish-design, publish-pack, Vercel deploy, or 'how do I set up Curatoria'. Triggers on curatoria-starter, creator setup, paywall service, go live on Base."
user-invocable: true
disable-model-invocation: false
allowed-tools: ["Bash(git clone *)", "Bash(npm *)", "Bash(node *)", "Bash(curl *)", "Bash(cp *)", "Bash(test *)", "Bash(npx vercel*)", "Read(docs/creator/*)"]
---

# Curatoria Setup

Guide a creator through the public `curatoria-starter` setup in six ordered phases. Complete phases in order unless the user explicitly skips ahead, and read the linked `docs/creator/` chapter before giving phase-specific instructions.

**Default path:** Track A — free full catalog at `/.well-known/design-catalog.json` and `/catalog`, paid per asset. Mention Track B only as the optional paid-catalog mode after the Track A local proof is green.

Creators should only need the public starter, their local terminal, and the creator docs in this repo.

**Happy-path reference:** `docs/creator/00-happy-path.md`.

---

## Step 0 — Calibrate Help Level

Ask one question early:

> Are you comfortable in the terminal and editing config files, or do you want me to run commands and explain each step in plain language?

| Profile | How to help |
| --- | --- |
| **Normie** | Short sentences, run commands when they approve, state what each phase *proved*, avoid jargon (say "payment challenge" not "x402 v2 middleware") |
| **Dev-comfortable** | Tighter steps, show curl/npm output, link to `docs/creator/` chapters, mention env var names |

If the user is not ready to run shell commands, explain the phase and ask before executing.

---

## Phase Map

| Phase | Goal | Read first |
| --- | --- | --- |
| 1 | Clone and install the starter | `docs/creator/00-happy-path.md`, `docs/creator/00-accounts-and-env.md` |
| 2 | Configure local `.env` and payout wallet | `docs/creator/02-wallet-basics.md` |
| 3 | Start local dev and verify Track A catalog | `docs/creator/06-test-on-testnet.md` |
| 4 | Run smoke | `docs/creator/06-test-on-testnet.md` |
| 5 | Run bug-bash and publish/storage checks | `docs/creator/04-products-and-prices.md`, `docs/creator/03-connect-your-storage.md` |
| 6 | Deploy/mainnet readiness | `docs/creator/07-go-live.md`, `docs/creator/08-bazaar-listing.md` |

Stop after any failed verification. Fix the local issue before moving forward.

---

## Phase 1 — Clone And Install

**Read:** `docs/creator/00-happy-path.md` steps 1-2 and `docs/creator/00-accounts-and-env.md`.

Start from the public GitHub repo:

```bash
git clone https://github.com/margaretsommers/curatoria-starter.git
cd curatoria-starter
npm install
test -f .env || cp .env.example .env
```

Use the user's fork/template repo if they already created one, but keep the public starter as the source of truth.

**Verification command:**

```bash
npm run build
```

**Expected output:** TypeScript build completes with exit code 0.

---

## Phase 2 — Configure Environment

**Read:** `docs/creator/02-wallet-basics.md` and the env table in `docs/creator/00-accounts-and-env.md`.

AskQuestion gate before editing `.env`:

> What Base-compatible payout wallet address should receive USDC, and are we staying on `base-sepolia` for local testing?

Never ask for seed phrases, private keys, or recovery phrases. For local setup, `.env` lives at the repo root and should look like:

```bash
WALLET_ADDRESS=0x0000000000000000000000000000000000000001
ADMIN_API_KEY=change-me-admin-key
NETWORK=base-sepolia
PORT=3000
FACILITATOR_URL=https://x402.org/facilitator
```

Replace the placeholder wallet with the creator's Base-compatible `0x...` payout address before accepting real payments. The placeholder is only for local smoke mechanics.

**Verification command:**

```bash
node -e "const fs=require('fs'); const env=fs.readFileSync('.env','utf8'); for (const key of ['WALLET_ADDRESS','ADMIN_API_KEY','NETWORK','FACILITATOR_URL']) { if (!env.includes(key + '=')) throw new Error('missing ' + key); } console.log('env ok')"
```

**Expected output:** `env ok`.

---

## Phase 3 — Start Local Dev

```bash
npm run dev
```

In a second terminal:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/.well-known/design-catalog.json
curl http://localhost:3000/catalog
```

**Expected output:** `/health` includes `status: "ok"` and `network: "base-sepolia"`. The well-known catalog and `/catalog` return HTTP 200 with a `design_systems` array. This proves Track A is active.

If `/catalog` returns 402, the user probably enabled optional Track B; unset `CATALOG_PAYWALL_ENABLED` and restart unless they intentionally asked for paid catalog discovery.

---

## Phase 4 — Smoke Test

```bash
npm run smoke
```

**Expected output:** Smoke exits 0 and reports health, catalog, and unpaid asset paywall checks as passing.

If smoke fails, read `docs/creator/09-troubleshooting.md` before changing unrelated settings.

---

## Phase 5 — Bug-Bash And Product Proof

**Read:** `docs/creator/06-test-on-testnet.md`. If the creator wants to add their own product before bug-bash, also read `docs/creator/04-products-and-prices.md`.

Run the full local gate:

```bash
npm run bug-bash -- --local
```

**Expected output:** Bug-bash exits 0. It should pass health, free catalog, unpaid Markdown 402, unpaid bundle 402, and Bazaar metadata checks.

For custom products, publish with the CLI and re-run the catalog checks:

```bash
npm run publish-design -- \
  --id my-product \
  --file design-systems/my-product.md \
  --name "My Product" \
  --price 0.05 \
  --desc "One sentence" \
  --tags design

curl http://localhost:3000/.well-known/design-catalog.json
curl -v http://localhost:3000/design-systems/my-product
```

**Expected output:** The catalog includes `my-product`; the product route returns `402 Payment Required` when unpaid.

Storage choices available today are local folder, HTTPS URL, Google Drive, Dropbox link-share, and Dropbox OAuth/private path. Read `docs/creator/03-connect-your-storage.md` before using `--url`, `--gdrive-id`, `--dropbox-url`, or `--dropbox-path`.

---

## Phase 6 — Deploy And Mainnet Readiness

**Read:** `docs/creator/07-go-live.md` and `docs/creator/08-bazaar-listing.md`.

AskQuestion gate before any mainnet language:

> Are you ready to use real Base mainnet USDC, and do you have CDP facilitator API keys for this deployment?

If the answer is no, stay on `base-sepolia`. Do not run paid mainnet commands.

For a public testnet deploy, set host env vars and verify:

```bash
curl https://YOUR_DOMAIN/health
curl https://YOUR_DOMAIN/.well-known/design-catalog.json
curl https://YOUR_DOMAIN/catalog
curl -v https://YOUR_DOMAIN/design-systems/curatoria-demo-md
```

**Expected output:** Health is ok, catalog endpoints return HTTP 200 with Track A metadata, and the demo asset route returns `402`.

Only after the user confirms mainnet readiness:

```bash
curl -H "X-Admin-Key: $ADMIN_API_KEY" https://YOUR_DOMAIN/admin/facilitator-preflight
```

**Expected output:** JSON includes `ok: true`. Optional paid proof requires explicit approval because it can spend real USDC.

---

## Optional Track B — Paid Catalog

Track B is advanced and optional. Use it only if the creator explicitly wants to monetize catalog discovery in addition to asset downloads.

```bash
CATALOG_PAYWALL_ENABLED=1
CATALOG_PRICE_USD=0.001
```

**Verification command:**

```bash
curl -v http://localhost:3000/catalog
```

**Expected output:** Unpaid `/catalog` returns `402`, while well-known switches to a teaser with a `paid_catalog_url`.

---

## Human gates summary

| Step | Gate | Color |
| --- | --- | --- |
| Wallet address | User supplies payout address | RED |
| GitHub/Vercel account actions | User signs in and approves | RED |
| CDP keys | User creates and stores secrets | RED |
| Mainnet USDC spend | Explicit approval | RED |
| awal OTP | User authenticates buyer wallet only if paid proof is requested | RED |

Agents can run local GREEN commands after user approval. Never store secrets in chat or committed files.

---

## Automation Contract

After each phase, state one proof sentence:

| Phase | Proof statement |
| --- | --- |
| Clone/install | "Dependencies install and build exits 0" |
| Env | "Required env keys exist and network is base-sepolia" |
| Local dev | "Health is ok and Track A catalog is free" |
| Smoke | "Fast unpaid checks pass" |
| Bug-bash | "Full local gate green including Bazaar metadata" |
| Deploy/mainnet | "Public catalog 200, unpaid assets 402, and preflight green before mainnet paid proof" |

---

## Shared rules

- Never commit `.env`, private keys, seed phrases, or recovery phrases.
- Product IDs are permanent once shared.
- Stay on `base-sepolia` until bug-bash passes.
- Paid proof is opt-in and can spend real money on mainnet.
- Track A is default; Track B is optional and env-gated.
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

