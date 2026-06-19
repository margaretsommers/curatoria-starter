# 04 - Products And Prices

> **Available today:** yes
> **Requires terminal:** yes

Curatoria sells products that live under `design-systems/` and are listed in `design-systems/.registry.json`. How agents discover that listing depends on your track — see [`01-before-you-start.md`](01-before-you-start.md). **Track A (default)** exposes the full listing for free at well-known; only asset delivery is paid. **Track B (optional)** uses a free teaser at well-known and paid full metadata at `GET /catalog`.

You can publish two product types today:

- Markdown products, served from `GET /design-systems/:id`.
- Zip bundle products, served from `GET /packs/:id/download`.

## Product Checklist

Before publishing, prepare:

- A stable lowercase ID, such as `starter-demo` or `accessibility-tokens`.
- A clear product name.
- A one-sentence description for the discovery catalog.
- A price in USD, settled as USDC.
- Search tags that help agents decide when the product is relevant.
- The source file in `design-systems/`.

Use lowercase letters, numbers, and hyphens for IDs. Avoid changing an ID after sharing it, because the ID becomes part of the paid URL.

## Two Price Layers

| Price | Applies on | Track A (default) | Track B (optional) |
| --- | --- | --- | --- |
| **Catalog access** | `GET /catalog` | Free (same as well-known) | x402 per fetch — default `$0.001` USDC |
| **Asset delivery** | `GET /design-systems/:id`, `GET /packs/:id/download` | x402 per product | x402 per product |

Set the catalog access fee (Track B only — requires `CATALOG_PAYWALL_ENABLED=1`) with either:

- `CATALOG_PRICE_USD` in `.env` (wins over registry when set), or
- `owner.catalog_price_usd` in `design-systems/.registry.json`

Example owner block:

```json
{
  "owner": {
    "wallet": "0xYOUR_BASE_WALLET",
    "name": "Your Name",
    "url": "https://yourdomain.com",
    "catalog_price_usd": "0.001"
  }
}
```

Per-product prices (`price_usd` on each registry entry) apply on **both** tracks. There is no session token for catalog access — each unpaid `GET /catalog` on Track B returns a new `402` challenge.

## Publish A Markdown Product

Create a `.md` file in `design-systems/`, then run:

```bash
npm run publish-design -- \
  --id starter-demo \
  --file design-systems/starter-demo.md \
  --name "Starter Demo Design System" \
  --price 0.01 \
  --desc "Starter demo product" \
  --tags demo,starter
```

The command writes to `design-systems/.registry.json`. The server reads the registry from disk on each request, so a running dev server picks up the new entry without a restart.

Your paid access URL will be:

```text
http://localhost:3000/design-systems/starter-demo
```

## Publish A Bundle Product

Create a `.zip` bundle in `design-systems/`, then run:

```bash
npm run publish-pack -- \
  --id starter-bundle \
  --zip design-systems/starter-bundle.zip \
  --name "Starter Bundle" \
  --price 0.03 \
  --desc "Starter demo bundle" \
  --tags demo,bundle
```

Your paid download URL will be:

```text
http://localhost:3000/packs/starter-bundle/download
```

## Pricing Guidelines

### Asset prices (both tracks)

Start with simple per-product prices while testing:

| Tier | Example price | Good for |
| --- | ---: | --- |
| Basic | `$0.01` | Utility tokens, simple examples, smoke tests. |
| Standard | `$0.05` | Complete design systems with practical guidance. |
| Premium | `$0.10` to `$0.25` | Niche, high-effort, or deeply documented resources. |
| Direct sale | `$1.00+` | Custom or customer-specific resources shared by direct URL. |

On **Track B**, agents pay the catalog fee before they see product names, prices, and descriptions in `design_systems[]`. On **Track A**, they see that metadata for free at well-known. Either way, keep descriptions concrete — good catalog metadata helps agents decide which asset is worth buying without exposing paid file bytes.

### Catalog access price (Track B only)

Default `$0.001` USDC per `GET /catalog` is enough to monetize discovery without blocking serious buyers. Raise it only when you have a reason (high-value catalogs, anti-scrape posture). Lower values still settle through x402; do not set `0` expecting a free paid route — use Track A customization if you want a free full listing.

## Alternative: Edit The Registry

You can edit `design-systems/.registry.json` directly when needed. Each active product should include:

```json
{
  "id": "starter-demo",
  "file": "starter-demo.md",
  "resource_type": "design_md",
  "mime_type": "text/markdown",
  "name": "Starter Demo Design System",
  "description": "Starter demo product",
  "price_usd": "0.01",
  "tags": ["demo", "starter"],
  "published_at": "2026-01-01T00:00:00.000Z",
  "active": true
}
```

For bundles, use `resource_type: "bundle_zip"`, `mime_type: "application/zip"`, and `bundle_file`.

Set `active` to `false` to hide a product from discovery without deleting its metadata.
