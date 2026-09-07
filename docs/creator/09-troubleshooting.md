# 09 - Troubleshooting

> **Available today:** yes
> **Requires terminal:** yes

Most Curatoria issues come from environment values, network mismatch, missing files, or registry entries that do not match the files on disk. Start with the simplest checks before debugging x402 internals.

## Server Will Not Start

Check `.env`:

- `ADMIN_API_KEY` must be set.
- At least one valid payout target must be set: `WALLET_ADDRESS` or `WALLET_ENS`.
- `WALLET_ADDRESS` must be an EVM address that starts with `0x` and has 40 hex characters after it.
- `NETWORK` should be `base-sepolia` for testing or `base` for production.

Run:

```bash
npm install
npm run dev
```

If the error mentions wallet resolution, remove `WALLET_ENS` temporarily and use a direct `WALLET_ADDRESS` until the address path works.

## `/health` Is Not `ok`

Expected:

```json
{
  "status": "ok",
  "network": "base-sepolia",
  "wallet": "0x..."
}
```

If the network or wallet is wrong, fix `.env` and restart the server.

## Catalog Is Empty Or Wrong

Which endpoint you check depends on your discovery track. See [`01-before-you-start.md`](01-before-you-start.md). **Track A (default)** is what the starter ships.

### Track A — full listing at well-known (default)

```bash
curl http://localhost:3000/.well-known/design-catalog.json
```

Expected: `design_systems[]` includes active products with `id`, `price_usd`, and `access_url`. Storage paths are omitted. If the array is empty, fix registry `active` flags and IDs.

### Track B — teaser at well-known, full listing at `/catalog`

Only when `CATALOG_PAYWALL_ENABLED=1`. Missing `design_systems[]` at well-known is expected on Track B.

```bash
curl http://localhost:3000/.well-known/design-catalog.json
```

Expected: `owner`, `total`, `paid_catalog_url`, `payment_required: true` — no product list.

To inspect the full listing locally, either pay for `GET /catalog` or set `CATALOG_PAYWALL_BYPASS=1` in `.env` (dev/smoke only), restart, then:

```bash
curl http://localhost:3000/catalog
```

Expected: `design_systems[]` with your active products, prices, and `access_url` values. Storage paths and connector secrets are intentionally omitted from catalog JSON.

If the teaser shows `total: 0` but you published products, the registry entries are inactive, missing, or the server is not reading the repo you edited.

### Track A — full listing at well-known

If you customized well-known to serve the full catalog:

```bash
curl http://localhost:3000/.well-known/design-catalog.json
```

Expected: `design_systems[]` includes active products. If the array is empty, fix registry `active` flags and IDs as above.

## `/catalog` Always Returns `402`

On **Track B** (`CATALOG_PAYWALL_ENABLED=1`), unpaid `GET /catalog` should return `402` — that is correct production behavior for Track B.

On **Track A (default)**, `/catalog` should return `200` with the same free listing as well-known. If you get `402` on Track A, check that `CATALOG_PAYWALL_ENABLED` is not set.

If paid catalog requests still fail after payment:

- Buyer wallet has USDC on the same network as `NETWORK`.
- `FACILITATOR_URL` matches the network (testnet vs CDP mainnet).
- Check server logs for catalog settlement errors.

## Catalog Price Wrong Or Unexpected

Catalog access price resolves in this order:

1. `CATALOG_PRICE_USD` in `.env` (if set)
2. `owner.catalog_price_usd` in `design-systems/.registry.json`
3. Default `0.001` USDC

Edit the registry owner block or env var, restart the server, and retry an unpaid `GET /catalog` — the `402` challenge amount should match your configured price.

## Product Returns `404`

For Markdown:

- Confirm the product ID in the URL matches the registry `id`.
- Confirm `resource_type` is missing or set to `design_md`.
- Confirm `active` is `true`.

For bundles:

- Confirm `resource_type` is `bundle_zip`.
- Confirm the URL uses `/packs/:id/download`.

## Product Returns `500`

The registry points to a file the server cannot read. Check:

- Markdown files are under `design-systems/`.
- Bundle zip files are under `design-systems/`.
- The registry `file` or `bundle_file` exactly matches the filename.
- Filename casing matches the file on disk.

Then retry the paid route.

## Unpaid Request Does Not Return `402`

Run:

```bash
curl -v http://localhost:3000/design-systems/example-minimal
```

If you do not see `402 Payment Required`, check:

- You are calling a paid route (`/design-systems/:id`, `/packs/:id/download`, or unpaid `/catalog` on Track B) — not the free well-known teaser.
- The product exists and is active.
- The server is running the Curatoria service with `npm run dev`, not only the static site workspace.

## Paid Request Fails

Check:

- Buyer wallet is on the same network as `NETWORK`.
- Buyer wallet has enough USDC on that network.
- Buyer wallet has enough gas if required by the client flow.
- Payout wallet is a Base-compatible EVM address.
- The client sends the `X-PAYMENT` header on retry.
- `FACILITATOR_URL` is reachable.

For testnet, use Base Sepolia ETH and Base Sepolia USDC. Mainnet USDC on another chain will not satisfy a Base Sepolia test payment.

## Paid Download Cannot Be Saved Locally

A successful paid asset response should be saved as raw bytes by the buyer
client. Text assets, zip bundles, images, PDFs, JSON files, and fonts must not be
copied from terminal output, reconstructed by an agent, or parsed from a JSON
string body.

Use a browser or client flow that handles the paid response as an `ArrayBuffer`,
`Blob`, or raw stream, then saves it with the filename from `Content-Disposition`
when present. After saving:

- Markdown should open as readable UTF-8 text.
- Zip bundles should unzip and keep their internal files/directories.
- PNG/PDF/font assets should keep their file signatures.
- JSON should match the original bytes; do not reformat it as a verification
  step.
- PSD and other large design binaries should be treated as opaque bytes. Preserve
  the filename/MIME type and verify byte count plus SHA-256 when available; do
  not parse, flatten, transcode, or reconstruct the file in the buyer flow.

Debug path status: `awal x402 pay --json` can prove that settlement and route
access work, but it is not a binary-safe local-file download path unless it
exposes a safe signer handoff. Do not use its stdout or JSON body as the source
of a saved zip, image, PDF, or font. For agent-first local saves, use a downloader
or client adapter that creates a fresh x402 payment payload for the validated
resource before fetching raw bytes.

If a source exceeds `STORAGE_MAX_BYTES` or times out, direct paid delivery should
fail clearly instead of asking an agent to copy/rebuild bytes. Disposable paid
links are the intended fallback for that case, with creator-configured download
counts, view counts, expiry hours, and optional total bytes. The current backend
defines the schema and limit logic, but it does not yet expose a public
disposable-link route; do not claim large-file fallback is live until issuance,
storage, and counter persistence are wired.

## Buyer Agent Stops Safely

The buyer agent is expected to stop rather than improvise in these cases:

- **Product is absent from the current catalog:** it is not executable. Stop
  before payment instead of relying on an example ID or stale prompt.
- **No destination:** supply an explicit directory or full path. The agent must
  ask before payment.
- **Destination file exists:** choose replace, number, or cancel. Interactive
  runs ask; noninteractive runs require an explicit `--on-collision` policy.
  `--yes` never selects a collision policy or permits overwrite.
- **Purchase terms differ:** compare amount, chain, token, payee, product,
  filename, and resource with the catalog. A mismatch is not recoverable by
  editing the challenge.
- **Payment succeeded but download stopped:** resume with the private
  entitlement/resume state. Do not pay again.
- **Entitlement expired:** decide whether to seek recovery or authorize a new
  purchase. The agent must not repurchase automatically.
- **Payment result is inconclusive:** inspect non-paying status or receipt
  surfaces, then make a human decision. Do not retry a payment with unknown
  settlement.
- **Wallet is unavailable:** unlock, fund, or select a reviewed wallet yourself.
  The agent must not install or fund one during the purchase.
- **Hash, byte count, MIME, or signature differs:** treat the download as failed,
  preserve the entitlement for a safe retry, and never repay.

Coinbase Payments MCP has a strict two-call payment sequence:
`check_payment_requirements`, then one `make_x402_request`. The second call
returns entitlement JSON only. Send that JSON directly to the Curatoria
downloader with `--entitlement-stdin --product-id <published-id> --out <path>
--on-collision <policy>`. Stdin is JSON-only and capped at 1 MiB. This
continuation invokes no wallet and never retries payment. Never paste the
entitlement, signed URL, payment signature, or file bytes into chat or logs.

MetaMask and browser downloads need one extra proof step. A browser can silently
rename a colliding file, so "download started" is not proof that the expected
path exists. Run a local disk verifier against the actual saved file and require
the catalog SHA-256, byte count, and PSD `8BPS` signature before reporting
completion.

## Work-Machine Decision Tree

If a buyer is on a corporate or school machine and downloads fail, separate the
failure before changing product settings:

1. **No wallet/payment prompt or wallet cannot sign:** the machine or browser may
   block wallet extensions, popups, passkeys, or Coinbase/CDP domains. Retry from
   a personal browser profile or network.
2. **Payment succeeds but the route returns `500`/`502`:** check server logs for
   source-fetch errors. Google Drive or Dropbox may be blocked, expired, moved,
   or returning an HTML preview page instead of file bytes.
3. **Payment succeeds but the saved file is corrupted:** confirm the buyer flow
   saved raw response bytes. Terminal copying, JSON body parsing, or agent
   reconstruction will corrupt binary assets.
4. **Only external-storage products fail:** switch one product temporarily to a
   local `design-systems/` file or your own direct HTTPS URL. If that works, the
   issue is the Drive/Dropbox/source-host path, not x402 settlement.
5. **Only production fails:** confirm `PUBLIC_BASE_URL`, `NETWORK`,
   `FACILITATOR_URL`, source permissions, and any `GOOGLE_API_KEY`/Dropbox env
   vars are set in the deployed host, not just local `.env`.

## Publish Command Fails

For Markdown:

```bash
npm run publish-design -- \
  --id starter-demo \
  --file design-systems/starter-demo.md \
  --name "Starter Demo Design System" \
  --price 0.01
```

For bundles:

```bash
npm run publish-pack -- \
  --id starter-bundle \
  --zip design-systems/starter-bundle.zip \
  --name "Starter Bundle" \
  --price 0.03
```

For binaries, hash the local PSD first. This does not touch Blob, the catalog,
Drive, Dropbox, or payment:

```bash
npm run publish-asset -- \
  --preflight \
  --filename starter.psd \
  --mime image/vnd.adobe.photoshop \
  --original-file /absolute/path/to/starter.psd
```

Common causes:

- File does not exist yet.
- ID contains uppercase letters, spaces, or underscores.
- Price is missing or not a positive decimal.
- Bundle path does not end in `.zip`.
- `--original-file` is missing, relative, empty, or not a PSD (`8BPS`).
- Dropbox Transfer (`/t/`), a folder share (`/scl/fo/` or `/sh/`), Paper, or another `/scl/` URL was used instead of a file share link (`/s/` or `/scl/fi/`).
- A Google Drive folder (`/folders/`) or Docs/Sheets/Slides URL was used instead of a file share link (`/file/d/` or `open?id=`).
- A Dropbox or Google Drive share URL included a username or password; paste a normal share link without credentials in the URL.
- A provider URL or Drive ID was passed as a CLI flag; it must come from `--source-env`.
- `BLOB_MODE=vercel` is set without `BLOB_READ_WRITE_TOKEN` or `BLOB_STORE_ID`.
  Without those variables, development defaults to the local `.local-blob/`
  store, so a full import works with no Vercel account. `--preflight` needs no
  storage at all.

## Production Problems

If the local flow works but production fails:

- Confirm production env vars match the intended network.
- Confirm `PUBLIC_BASE_URL` matches your live domain.
- Confirm DNS points to the Node service host.
- Confirm the host is running `npm run start`.
- Confirm `CATALOG_PAYWALL_BYPASS` is **not** set in production unless you intentionally disabled the catalog paywall.
- **Track B:** confirm well-known returns teaser only; unpaid `GET /catalog` returns `402`.
- Confirm public requests hit `https://yourdomain.com/.well-known/design-catalog.json`.
- Check host logs for payment verification or settlement failures.

Do not switch back and forth between `base-sepolia` and `base` on the same public deployment without clearly labeling the environment. Buyers and agents need one stable network expectation per catalog.
