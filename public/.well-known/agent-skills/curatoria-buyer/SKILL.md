---
name: curatoria-buyer
description: "Buy design assets from Curatoria x402 catalogs and save exact files locally. Use for paid markdown, zip, PSD, or binary assets with awal, Coinbase Payments bridges, or browser wallets."
---

# Curatoria Buyer

Purchase creator-owned design assets from a Curatoria x402 paywall with no accounts or checkout pages.

## Availability gate

Never assume a product mentioned in a prompt is currently for sale. Fetch the
catalog and require an active matching entry before destination work, wallet
signing, or payment. In particular, `layout` is not in the current Curatoria
registry, so a request to buy `layout` must stop as unavailable unless a future
catalog response actually publishes it. Do not claim that example is executable.

Tests use this safe mocked published-product contract; it is illustrative, not a
claim about the live registry:

- Amount: `$0.01 USDC`, exactly `10000` atomic units.
- Chain: Base mainnet, CAIP-2 network `eip155:8453`.
- Token: USDC at `0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913`.
- Payee: `0x8aa327403ED786cA56EB8F59C6c8831A8BD73485`.
- Product ID: `mock-published-layout`.
- Expected filename: `mock-layout.psd`.
- Purchase resource:
  `https://curatoria.dev/assets/mock-published-layout/purchase`.

Any different amount, chain, token, payee, product, filename, or resource is a
terms mismatch. Stop before payment and ask the human to decide; never
"correct" a challenge or substitute nearby terms.

## Required decision order

Follow this order on every purchase. A later step cannot repair a skipped
earlier step.

1. Fetch `https://curatoria.dev/.well-known/design-catalog.json`. If the
   requested product is absent or inactive, stop before payment. Otherwise
   record its ID, filename, byte count, SHA-256, MIME type, price, and access
   URL.
2. Ask the human for an explicit destination directory or full destination
   path. If no destination was supplied, stop and ask; do not pay.
3. Inspect the destination. If the exact filename already exists, require an
   explicit choice: **replace**, **number**, or **cancel**. Interactive runs ask.
   Noninteractive runs must pass `--on-collision number|replace|cancel`; omission
   is a hard stop. `--yes` is spend approval only and never chooses a collision
   policy or permits overwrite.
4. Check for a private resume-state file or already-issued entitlement. If a
   valid entitlement exists, skip wallet/payment and resume redemption and
   download. Never pay again for a retry. Resume and `--entitlement-stdin`
   never reserve session budget.
5. Make one unpaid request and validate the resulting HTTP 402 challenge against
   every fixed purchase term above. If any field differs, stop before payment.
6. After destination and challenge preflight, reserve the one-cent session
   budget (`10000` atomic, session cap `40000`). If remaining budget cannot
   cover `10000`, stop before wallet. Pending and inconclusive attempts consume
   budget until reconciled. There is no automatic paid retry.
7. Ask the human for final confirmation that names the amount, chain, token,
   payee, product, filename, and destination. Confirmation is not permission to
   expose secrets.
8. Let the wallet sign and pay once. The wallet is only a signer/payment
   capability; it never chooses a path, downloads bytes, saves a file, or
   declares local completion.
9. Give the metadata-only entitlement JSON directly to
   `agent-download --entitlement-stdin --product-id <published-id> --out <path>
   --on-collision <explicit-policy>` over stdin. The downloader accepts at most
   1 MiB of JSON, invokes no wallet, reserves no budget, and never retries
   payment. It redeems the entitlement, streams opaque bytes to a temporary
   file, checks byte count, SHA-256, MIME/signature, atomically moves it to the
   approved destination, and writes a metadata-only receipt.
10. Report completion only after local verification succeeds.

## Coinbase Payments MCP sequence

Coinbase Payments MCP is the `check_payment_requirements` /
`make_x402_request` tool pair. A generic `--wallet-executable` bridge is an
advanced adapter for other CLIs; it is not Coinbase Payments MCP itself.

1. Destination, challenge, and session-budget preflight. Run
   `npm run agent-download -- --prepare-external-payment --purchase-context
   <absolute-0600-file> --session-budget-file <absolute-ledger>
   --session-budget 40000 --product-id <published-id> --out <path>
   --on-collision <policy> --yes`. Do not pay yet. If no destination was
   supplied or remaining budget is below `10000`, stop; no reservation and no
   payment.
2. Call `check_payment_requirements` for the prepared purchase URL.
3. Confirm the challenge is exactly `10000` atomic Base USDC, payee
   `0x8aa327403ED786cA56EB8F59C6c8831A8BD73485`, token
   `0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913`, network `eip155:8453`, and
   the expected purchase URL. Any mismatch: stop. Do not call
   `make_x402_request`. Do not redeem.
4. Call `make_x402_request` exactly once for that validated resource.
5. Its successful output must be small entitlement JSON, never asset bytes.
   Pipe that JSON directly to `npm run agent-download -- --entitlement-stdin
   --product-id <published-id> --out <path> --on-collision <policy>`. Do not
   paste it into chat, logs, command arguments, files, or another model
   prompt. Never echo entitlement bytes.
6. Resume or retry uses the same entitlement or `--resume-state`. Never call
   `make_x402_request` again and never auto-repay.

For `awal` (deprecated — prefer Agent Cash or any other agentic wallet below)
or `agentcash` (https://agentcash.dev), use a reviewed, preinstalled
executable by absolute path. Never use `npx`, `--yes`, or any
install-on-payment command. Its output may return entitlement JSON only; it
is not a file downloader. Reserve session budget after destination and
challenge preflight and before spawning the wallet executable.

Curatoria works with **any x402-compatible agentic wallet**, not only the
named ones above — the paid routes accept a standard x402 payment regardless
of which tool produced it. A wallet with no dedicated integration here still
works through the generic `--wallet-executable` JSON-stdin bridge: it
receives the validated challenge on stdin and must return the same
entitlement JSON shape.

## Resume and uncertain states

- Interrupted after payment: retain the private entitlement/resume state and
  restart only redemption/download with `--resume-state <private-state-file>`.
  Payment call count stays zero on the resumed run.
- Expired entitlement: do not repay automatically. Stop and ask the human
  whether to attempt recovery or authorize a new purchase.
- Inconclusive payment (timeout, unknown settlement, missing response, or
  ambiguous wallet result): do not retry payment. Stop for a human decision
  after checking non-paying status/receipt surfaces.
- Unavailable, locked, unsupported, or underfunded wallet: stop before payment;
  never install, switch, or fund a wallet without explicit human action.
- Hash, byte-count, MIME, or PSD-signature mismatch: quarantine/delete the
  uncommitted temporary file, preserve entitlement/resume state, and stop. Never
  repay and never claim success.

## Browser and MetaMask completion

Browser download APIs and MetaMask do not prove the final local pathname. The
browser may rename the downloaded file to avoid a collision. After a browser/MetaMask
flow, completion requires a local disk verifier to locate the actual saved file
and confirm the catalog SHA-256, byte count, and PSD `8BPS` signature. Until
that verifier passes, report only "download started; local verification
required," not "saved" or "complete."

## Capability and secret boundaries

- Never paste, echo, log, persist in receipts, or include in model prompts:
  asset bytes, entitlement bearer values, signed private URLs, payment
  signatures, wallet seed phrases/private keys, API keys, or admin keys.
- Pass secrets only through the narrow process channel that requires them.
  Entitlements go through downloader stdin; file bytes flow only through the
  downloader's raw stream to its temporary file.
- Never reconstruct an asset from stdout, JSON bodies, screenshots, snippets,
  base64, or model output.
- Receipts may contain only non-secret metadata and verification results.
- Buyer agents use x402 payment signatures; no OAuth token is required.

Creators should clone the public starter:
https://github.com/margaretsommers/curatoria-starter
