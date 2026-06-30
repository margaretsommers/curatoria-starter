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
- The server is running the Curatoria service with `npm run dev`.

## Paid Request Fails

Check:

- Buyer wallet is on the same network as `NETWORK`.
- Buyer wallet has enough USDC on that network.
- Buyer wallet has enough gas if required by the client flow.
- Payout wallet is a Base-compatible EVM address.
- The client sends the `X-PAYMENT` header on retry.
- `FACILITATOR_URL` is reachable.

For testnet, use Base Sepolia ETH and Base Sepolia USDC. Mainnet USDC on another chain will not satisfy a Base Sepolia test payment.

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

Common causes:

- File does not exist yet.
- ID contains uppercase letters, spaces, or underscores.
- Price is missing or not a positive decimal.
- Bundle path does not end in `.zip`.

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
