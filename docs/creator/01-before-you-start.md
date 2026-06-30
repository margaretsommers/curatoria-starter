# Before You Start

> **Available today:** yes
> **Requires terminal:** yes

Curatoria is not a conventional checkout page. It is an agent-readable commerce service: the full catalog is exposed for free over HTTP, paid resources stay protected behind x402, and payment happens through `402 Payment Required` challenges.

Before you publish your first product, choose how agents discover your catalog. Curatoria supports two tracks. The shipped starter defaults to **Track A** (free full catalog + paid assets). **Track B** (paid catalog listing) is an optional advanced mode when you want to monetize discovery metadata.

## Two Discovery Tracks

| | **Track A — Free catalog (default)** | **Track B — Paid catalog (optional)** |
| --- | --- | --- |
| **Well-known** | Full `design_systems[]` with IDs, prices, tags, `access_url` | Free **teaser** only: `owner`, `total`, `paid_catalog_url` — no product list |
| **Catalog listing** | Same JSON at `GET /catalog` (free alias) | `GET /catalog` — x402 per fetch (default `$0.001` USDC) |
| **Assets** | x402 per markdown or zip | x402 per markdown or zip |
| **Agent steps** | 1) Read well-known → 2) Pick product → 3) Pay for asset | 1) Read teaser → 2) Pay for `/catalog` → 3) Pick product → 4) Pay for asset |
| **Revenue** | Asset sales only | Catalog access fee + asset sales |
| **Complexity** | Lower — one free metadata hop | Higher — catalog paywall before asset paywall |
| **When to choose** | Open catalogs, demos, maximum Bazaar visibility, starter default | Monetize discovery, limit free scraping of full metadata |

See [`00-accounts-and-env.md`](00-accounts-and-env.md) for env vars and [`03-connect-your-storage.md`](03-connect-your-storage.md) for how product payloads are fetched after payment.

### Track A — Free catalog (default)

The starter ships Track A out of the box.

Agents read the full product listing for free at:

```text
GET /.well-known/design-catalog.json
```

The response includes `owner`, `total`, `base_url`, and a `design_systems` array. Each entry has `id`, `name`, `price_usd`, `tags`, `description`, and `access_url` pointing at the paid asset route. Storage paths and connector secrets never appear in catalog JSON.

`GET /catalog` returns the same listing (free alias). `GET /design-systems` (list route, not `:id`) is also a free alias.

Only asset routes are paid:

- `GET /design-systems/:id` — markdown
- `GET /packs/:id/download` — zip bundle

**Tradeoffs**

- Easier agent onboarding — one free read gives full metadata
- Better discovery visibility — agents can compare products without paying
- No catalog fee revenue
- Full catalog metadata is public (IDs, prices, tags, access URLs)

**Configuration**

- No catalog env vars required
- Set `PUBLIC_BASE_URL` on deploy so `base_url` and `access_url` in catalog JSON are correct

### Track B — Paid catalog (optional advanced)

Enable with `CATALOG_PAYWALL_ENABLED=1` in `.env`. Well-known switches to a free teaser; full metadata moves behind paid `GET /catalog`.

**Free teaser** at:

```text
GET /.well-known/design-catalog.json
```

Returns `owner`, `total`, `paid_catalog_url`, and `payment_required: true`. No product IDs, names, prices, or `access_url` values.

**Paid full listing** at:

```text
GET /catalog
```

Returns the same `CatalogResponse` shape Track A exposes for free: `design_systems[]` with metadata and `access_url` per product. Every unpaid request returns `402 Payment Required`. Price defaults to `$0.001` USDC per fetch via `owner.catalog_price_usd` in `.registry.json` or `CATALOG_PRICE_USD` in `.env`. There is no session token — repeat catalog reads cost again.

**Paid assets** — same as Track A (`/design-systems/:id`, `/packs/:id/download`).

**Tradeoffs**

- Monetizes discovery — small fee per catalog fetch
- Reduces free scraping of full product metadata
- More agent friction — catalog payment, then per-asset payment
- Per-fetch billing — agents that re-read the catalog pay each time

**Configuration**

- Set `CATALOG_PAYWALL_ENABLED=1`
- Set catalog price: `CATALOG_PRICE_USD=0.001` or `owner.catalog_price_usd` in `design-systems/.registry.json`
- Optional dev only: `CATALOG_PAYWALL_BYPASS=1` skips the paywall on `/catalog` locally — never in production
- Set `PUBLIC_BASE_URL` on deploy so `base_url` and `access_url` in paid catalog JSON are correct

## Endpoints At A Glance

| Endpoint | Track A (default) | Track B (optional) |
| --- | --- | --- |
| `GET /.well-known/design-catalog.json` | Full catalog (free) | Teaser (free) |
| `GET /design-systems` | Full catalog alias | Teaser alias |
| `GET /catalog` | Full catalog (free) | Full catalog (x402 per fetch) |
| `GET /design-systems/:id` | Paid markdown | Paid markdown |
| `GET /packs/:id/download` | Paid zip | Paid zip |
| `GET /health` | Service health | Service health |

## Well-Known Design Catalog Audit

`/.well-known/design-catalog.json` is Curatoria's stable discovery document. Its
job is to help an agent answer three questions before it pays: who owns this
catalog, what products are available, and which paid URL should it request next.
It is not the sellable asset, a storage manifest, or a secret-bearing config
file.

Agents use it as the first read in the flow:

1. Fetch `/.well-known/design-catalog.json` from the creator's domain.
2. Read `owner`, `total`, `base_url`, and `design_systems[]` on Track A, or
   `owner`, `total`, and `paid_catalog_url` on Track B.
3. Choose a product by `id`, `name`, `description`, `tags`, `resource_type`,
   `mime_type`, and `price_usd`.
4. Request the product's `access_url` or `download_url`, receive `402 Payment
   Required`, and complete x402 payment on that asset route.

Fields that are product-specific and must stay stable for v1:

- `id` — route slug and durable product identifier.
- `name`, `description`, and `tags` — agent-readable merchandising metadata.
- `price_usd` — decimal USD price used to build the x402 amount.
- `resource_type` and `mime_type` — tells an agent whether it is buying markdown
  or a zip bundle.
- `access_url` and `download_url` — paid route URLs; these are not raw storage
  links.
- `payment_required: true` — signals that the next route is paid.

Fields that should never appear in well-known: local filenames, Dropbox share
URLs, Dropbox private paths, Google Drive file IDs, direct source URLs, API keys,
admin keys, buyer wallets, or private operator notes. Curatoria strips `file` and
`source` from the catalog response for this reason.

Recommendation for v1: keep the `.well-known` location and JSON response stable,
but do not over-standardize the schema beyond Curatoria's current agent flow.
Generic `.well-known` conventions mostly require a predictable HTTPS URL,
machine-readable JSON, cacheable public metadata, and no secrets. Curatoria should
conform to those conventions while keeping Curatoria-specific fields such as
`design_systems`, `price_usd`, `access_url`, and Track B's `paid_catalog_url`.
Renaming to a generic product schema would add migration risk without improving
agent behavior today.

## Agent Flows

### Track A — numbered steps (default)

1. `GET /.well-known/design-catalog.json` → parse `design_systems[]`
2. Choose a product by `id`, `tags`, `price_usd`
3. `GET` the product `access_url` → receive `402` with x402 + Bazaar metadata
4. Retry with `X-PAYMENT` header → receive markdown or zip bytes

```text
Agent                    Curatoria
  |                          |
  |-- GET well-known ------->|
  |<-- 200 full catalog -----|
  |                          |
  |-- GET access_url ------->|
  |<-- 402 challenge --------|
  |-- GET + X-PAYMENT ------>|
  |<-- 200 asset bytes -------|
```

### Track B — numbered steps (optional)

1. `GET /.well-known/design-catalog.json` → read `owner`, `total`, `paid_catalog_url`
2. `GET /catalog` → receive `402` with catalog x402 + Bazaar directory metadata
3. Retry `GET /catalog` with `X-PAYMENT` → receive full `design_systems[]`
4. Choose a product; `GET` its `access_url` → receive asset `402`
5. Retry with `X-PAYMENT` → receive markdown or zip bytes

## The Four Moving Parts (Both Tracks)

### 1. Discovery

Agents find your service through well-known (free full catalog on Track A; teaser on Track B). Metadata quality matters: stable IDs, clear prices, useful tags, and working `access_url` values.

### 2. Challenge

When an agent requests a paid route without payment, the server returns `402 Payment Required` with x402 payment requirements. Track B also attaches Bazaar directory metadata on catalog `402` responses.

### 3. Payment

The client signs and sends a payment payload in the `X-PAYMENT` request header. Curatoria verifies and settles through the configured x402 facilitator. Start with `NETWORK=base-sepolia` and `FACILITATOR_URL=https://x402.org/facilitator`.

### 4. Delivery

After payment settles, the server returns markdown or zip bytes. On remote storage products, bytes are fetched from your configured source only after settlement. See [`03-connect-your-storage.md`](03-connect-your-storage.md).

## What Creators Control

You control product files, registry entries, IDs, prices, tags, descriptions, payout wallet, `PUBLIC_BASE_URL`, testnet vs mainnet, and optionally Track B via `CATALOG_PAYWALL_ENABLED=1`.

## Preflight Checklist

Before continuing, make sure you have:

- chosen Track A (default) or Track B (`CATALOG_PAYWALL_ENABLED=1`);
- Node 18+ and npm available;
- a dedicated EVM wallet address for receiving Base USDC;
- a plan to start on `base-sepolia`;
- one test markdown product or bundle;
- a domain or deployment target for later;
- a private place to store secrets outside git.

Never commit `.env`, private keys, seed phrases, or recovery phrases.
