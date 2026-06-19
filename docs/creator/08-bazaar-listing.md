# Bazaar Listing

> **Available today:** yes
> **Requires terminal:** yes

Curatoria declares Bazaar discovery metadata in `402 Payment Required` challenges via `declareDiscoveryExtension(...)`. There is no separate Bazaar registration command — metadata is generated from your live registry on each request.

Which routes expose Bazaar metadata depends on your discovery track. See [`01-before-you-start.md`](01-before-you-start.md) for Track A vs Track B.

## Public Entry Point

Your stable catalog URL for agents and directories:

```text
https://YOUR_DOMAIN/.well-known/design-catalog.json
```

On **Track A (default)**, this URL returns the full `design_systems[]` listing for free.

On **Track B** (`CATALOG_PAYWALL_ENABLED=1`), this URL returns a free teaser — owner, product count, and `paid_catalog_url`. It does not list individual products.

## Bazaar Metadata By Track

| Route | Track A | Track B |
| --- | --- | --- |
| `GET /.well-known/design-catalog.json` | No Bazaar on `200` (free JSON listing) | No Bazaar on `200` (free teaser) |
| `GET /catalog` | No Bazaar if catalog is free (`200`) | Bazaar on unpaid `402` — directory listing extension |
| `GET /design-systems/:id` | Bazaar on unpaid asset `402` | Bazaar on unpaid asset `402` |
| `GET /packs/:id/download` | Bazaar on unpaid bundle `402` | Bazaar on unpaid bundle `402` |

### Track A — Bazaar on asset routes only

Agents read the full catalog for free, choose a product, then hit the asset `access_url`. The first unpaid request returns `402` with `extensions.bazaar` describing that product (ID input schema, output example, live tags and type from registry).

Publishing or repricing updates asset challenge metadata on the next request automatically.

### Track B — Bazaar on catalog and asset routes

Agents read the free teaser, then request `GET /catalog`. The unpaid catalog request returns `402` with Bazaar **directory** metadata — empty input schema, catalog JSON output example, tags `curatoria`, `catalog`, `directory`.

After paying for the catalog, agents receive full `design_systems[]` and proceed to asset routes. Each asset `402` carries product-level Bazaar metadata, same as Track A.

Repeat catalog fetches on Track B trigger a new catalog `402` (per-fetch billing, no session).

## Verify Locally

**Track B — teaser**

```bash
curl http://localhost:3000/.well-known/design-catalog.json
```

Confirm `paid_catalog_url` and no `design_systems` array.

**Track B — catalog Bazaar on 402**

```bash
curl -v http://localhost:3000/catalog
```

Confirm `402` and payment challenge headers include Bazaar directory extensions.

**Both tracks — asset Bazaar on 402**

```bash
curl -v http://localhost:3000/design-systems/curatoria-demo-md
curl -v http://localhost:3000/packs/curatoria-demo-pack/download
```

Confirm `402` with product-level Bazaar metadata.

**Track A — full catalog at well-known** (if customized)

```bash
curl http://localhost:3000/.well-known/design-catalog.json
```

Confirm `design_systems[]` is present and asset `402` checks still pass.

## What Is Automatic Today

When an agent requests a paid route:

- Curatoria returns a `402` challenge
- the challenge includes `extensions.bazaar` from `declareDiscoveryExtension(...)`
- metadata reflects the live registry entry (ID, name, tags, resource type)
- catalog directory metadata is attached to unpaid `GET /catalog` on Track B only

Because metadata rides on payment challenges, publishing or repricing does not require a separate discovery registration step.

## CDP Auto-Index (Bazaar)

When you use the **CDP Facilitator** on mainnet (`FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402`), routes with Bazaar extensions are **automatically cataloged** after the first successful settlement. There is no separate registration command in Curatoria.

Verify discovery:

```bash
npx awal@2.10.0 x402 bazaar search YOUR_DOMAIN
```

Indexing is asynchronous (can take hours). Asset routes (`/design-systems/:id`, `/packs/:id/download`) appear as template URLs after settlement. The free well-known catalog is **not** a Bazaar row — agents read it directly.

**Track B note:** If you previously ran a paid `/catalog`, Bazaar may retain a stale catalog row after you switch to Track A. Agents should use `/.well-known/design-catalog.json` for free discovery.

## Still Manual Today

Even with CDP auto-index, make agents aware of your service:

- link your well-known URL from your website
- include it in `llms.txt` if you maintain one
- on Track B, document that full metadata requires `GET /catalog` (paid)
- share URLs directly with agent builders and buyers
- include catalog and product URLs in launch posts and demos
- keep endpoints stable so agents can revisit them

[Agentic.Market](https://agentic.market) surfaces Bazaar services automatically; curated/featured placement is Coinbase discretion. MCP sellers use a separate submission flow at [agenticmarket.dev](https://agenticmarket.dev) — not applicable to HTTP x402 catalogs.

## What Is Not Guaranteed Yet

- External Bazaar operators will index your catalog or asset challenges
- Third-party refresh cadence or search ranking
- A stable public domain without your own DNS and deploy discipline
- Automatic Track A / Track B switching without code or env customization

The working model today: deploy Curatoria, verify well-known (and `/catalog` on Track B), confirm Bazaar extensions on relevant `402` responses, and continue sharing your catalog URL while external indexing catches up.

## Useful Links

- x402 protocol docs: https://docs.x402.org
- Coinbase x402 docs: https://docs.cdp.coinbase.com/x402/welcome
- Discovery tracks: [`01-before-you-start.md`](01-before-you-start.md)
- Env vars: [`00-accounts-and-env.md`](00-accounts-and-env.md)
