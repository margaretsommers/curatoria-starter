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
- A clear license stance. Use `custom-commercial` or `proprietary` for most paid assets; reserve Creative Commons / CC0 for previews, samples, or intentionally open assets.
- Optional preview metadata that helps agents decide what to buy without revealing the paid payload.
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

## Discovery Preview Metadata

Agents need enough signal to buy intelligently, but the preview should not replace the paid product. Registry entries may include these optional public fields:

```json
{
  "license": "custom-commercial",
  "license_url": "https://example.com/license",
  "license_summary": "Paid commercial use for one buyer workspace.",
  "preview": "Short partial excerpt or product summary.",
  "preview_url": "https://example.com/previews/starter-bundle",
  "sample_files": ["samples/colors.sample.json"],
  "table_of_contents": ["Tokens", "Components", "Usage"],
  "token_categories": ["color", "spacing", "typography"],
  "component_list": ["Button", "Card", "Modal"],
  "content_sha256": "64-character-sha256-when-known",
  "bundle_manifest": [
    {
      "path": "tokens/colors.json",
      "kind": "tokens",
      "mime_type": "application/json",
      "bytes": 2048,
      "sha256": "optional-file-sha256"
    }
  ]
}
```

Keep `preview`, `preview_url`, `sample_files`, and `bundle_manifest` intentionally partial. A manifest can list safe filenames, categories, byte counts, and hashes; it must not include Drive, Dropbox, CDN source URLs, signed URLs, credentials, or enough raw content to reconstruct the paid bundle.

Use `content_sha256` when you know the exact paid payload hash. Paid responses also expose `X-Content-Sha256` when this registry value is present, so buyer agents can compare discovery metadata with the bytes they saved locally.

### License Defaults

For paid Curatoria assets, prefer `custom-commercial` or `proprietary` with a `license_url` that states what the buyer can do after payment. Payment should buy rights, provenance, and auditability, not just bytes.

Creative Commons and CC0 are better for public previews, samples, or deliberately open products:

- `cc0-1.0`: public-domain dedication; good for free samples, poor for paid exclusivity.
- `cc-by-4.0`: commercial reuse allowed with attribution.
- `cc-by-sa-4.0`: commercial reuse allowed with attribution and share-alike.
- `cc-by-nd-4.0`: redistribution allowed, but no derivatives.
- `cc-by-nc-*`: non-commercial only; usually a poor fit for commercial agent buyers.

MIT and Apache-2.0 are software licenses. Use them for code assets when appropriate, not as the default for design, media, or bundle rights.

## Large Files And Disposable Access

Direct paid download remains the primary path. For `.psd` files and other large binaries, Curatoria should treat payloads as opaque bytes: preserve the filename and MIME type, stream/save raw bytes, and verify byte count plus SHA-256 when available. Do not parse, flatten, preview, transcode, or reconstruct large binaries from terminal output.

Disposable paid links are designed as a fallback for files that exceed direct download limits or time out. The schema can describe a creator's intended limits:

```json
{
  "disposable_access": {
    "enabled": true,
    "max_downloads": 1,
    "max_views": 1,
    "hours_valid": 24,
    "max_total_bytes": 1073741824,
    "allow_regeneration_after_payment": true,
    "delivery": "fallback_when_direct_too_large"
  }
}
```

This pass defines the metadata and server-side limit logic, but it does not ship a public disposable-link route. A production route still needs payment-bound link issuance, unguessable tokens, persisted counters, expiry enforcement, and byte-safe proxying that never exposes the original Drive, Dropbox, or source URL.

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
  "license": "custom-commercial",
  "license_summary": "Paid commercial use under the linked terms.",
  "preview": "Short partial preview for discovery.",
  "published_at": "2026-01-01T00:00:00.000Z",
  "active": true
}
```

For bundles, use `resource_type: "bundle_zip"`, `mime_type: "application/zip"`, and `bundle_file`.

Set `active` to `false` to hide a product from discovery without deleting its metadata.
