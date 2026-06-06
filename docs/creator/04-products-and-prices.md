# 04 - Products And Prices

> **Available today:** yes
> **Requires terminal:** yes

Curatoria sells products that live under `design-systems/` and are listed in `design-systems/.registry.json`. Discovery is free, but each product's content is returned only after a valid x402 payment.

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

Start with simple prices while testing:

| Tier | Example price | Good for |
| --- | ---: | --- |
| Basic | `$0.01` | Utility tokens, simple examples, smoke tests. |
| Standard | `$0.05` | Complete design systems with practical guidance. |
| Premium | `$0.10` to `$0.25` | Niche, high-effort, or deeply documented resources. |
| Direct sale | `$1.00+` | Custom or customer-specific resources shared by direct URL. |

Agents can inspect your free catalog before paying, so keep descriptions concrete. A good catalog entry makes the product's value obvious without exposing the paid content.

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
