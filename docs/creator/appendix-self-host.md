# Appendix - Self Host Curatoria

> **Available today:** partial
> **Requires terminal:** yes

Self-hosting gives you control over your domain, catalog, payout wallet, logs, and infrastructure. Today Curatoria is a Node service with local catalog and asset files. For heavier traffic, move secrets, files, monitoring, and rate limits into managed services.

**Discovery tracks:** The shipped starter uses **Track A** — free full catalog at well-known, paid assets only. **Track B** (`CATALOG_PAYWALL_ENABLED=1`) adds a paid `/catalog` listing. See [`01-before-you-start.md`](01-before-you-start.md).

## Minimum Architecture

The starter architecture is:

- Node.js runtime.
- x402 facilitator endpoint.
- `design-systems/.registry.json` for catalog metadata.
- Local files in `design-systems/` for Markdown and zip products.
- Public domain serving free full catalog (Track A default) and paid asset routes.

**Track A route behavior (default):**

| Route | Paid? | Response |
| --- | --- | --- |
| `/.well-known/design-catalog.json` | No | Full `design_systems[]` |
| `/catalog` | No | Same free listing (alias) |
| `/design-systems/:id`, `/packs/:id/download` | Yes | File bytes after x402 |

**Track B route behavior** (`CATALOG_PAYWALL_ENABLED=1`):

| Route | Paid? | Response |
| --- | --- | --- |
| `/.well-known/design-catalog.json` | No | Teaser — owner, count, `paid_catalog_url` |
| `/catalog` | Yes (per fetch) | Full `design_systems[]` after x402 |
| `/design-systems/:id`, `/packs/:id/download` | Yes | File bytes after x402 |

This is enough for early testing and small launches.

## Hosting Options

Use any host that can run a Node app:

| Host type | Notes |
| --- | --- |
| Railway, Render, Fly.io | Good first managed options for a small Node service. |
| VPS or EC2 | More control, more operations responsibility. |
| Container host | Useful when you already deploy containerized services. |

Set the host's start command to:

```bash
npm run start
```

If the host needs a build step:

```bash
npm run build
```

## Required Environment Variables

Set these in your host's secret manager:

```bash
WALLET_ADDRESS=0xYOUR_BASE_WALLET
ADMIN_API_KEY=use-a-long-random-secret
NETWORK=base
PORT=3000
PUBLIC_BASE_URL=https://yourdomain.com
FACILITATOR_URL=https://x402.org/facilitator
```

**Track B (optional)** — enable paid catalog with `CATALOG_PAYWALL_ENABLED=1` and catalog access price:

```bash
# CATALOG_PAYWALL_ENABLED=1
# CATALOG_PRICE_USD=0.001
# CATALOG_PAYWALL_BYPASS=1   # local dev only — skips /catalog paywall on Track B
```

Use separate values for development, staging, and production. Rotate any demo admin key before launch.

## Domain And Routes

Your public domain should expose at minimum:

```text
GET /health
GET /.well-known/design-catalog.json
GET /design-systems          # full catalog list alias (Track A) or teaser (Track B)
GET /catalog                  # free alias (Track A) or paid listing (Track B)
GET /design-systems/:id       # paid markdown
GET /packs/:id/download       # paid zip bundle
POST /admin/publish
```

Agents need a stable entry URL. Share well-known for discovery:

```text
https://yourdomain.com/.well-known/design-catalog.json
```

On Track B only, document that full metadata requires paid `GET /catalog`.

## Storage Today

Today, Curatoria expects:

- Product metadata in `design-systems/.registry.json`.
- Markdown files in `design-systems/`.
- Zip bundles in `design-systems/`.

For a small launch, deploy these files with the app. For larger catalogs or bigger bundles, plan to move assets to object storage such as S3, R2, or GCS and keep the registry metadata clean and backed up.

## Reliability Baseline

Before public traffic, add:

- Uptime check on `/health`.
- Logs for paid routes (including `/catalog` on Track B).
- Alerts for 5xx spikes.
- Alerts for payment verification or settlement failures.
- Rate limiting on paid endpoints (`/catalog`, asset routes).
- Backup of `design-systems/.registry.json`.
- **Track A:** verify well-known returns `design_systems[]` and asset 402s in production smoke checks.
- **Track B:** verify teaser at well-known and unpaid `/catalog` 402.

If you expect large bundles or heavy traffic, add CDN/WAF protection and object storage before launch.

## Security Baseline

- Keep `.env` out of git.
- Store production secrets in your host dashboard or secret manager.
- Use a long random `ADMIN_API_KEY`.
- Do not expose `/admin/publish` without the admin key.
- Keep payout wallet recovery material outside the app.
- Publish a support or DMCA contact email.
- Disable products with `active: false` while investigating ownership or abuse reports.

## Scaling Path

The practical progression is:

1. Local files and local registry for early launch.
2. Managed host with production env vars and custom domain.
3. Monitoring, alerts, and rate limiting.
4. Object storage for large assets.
5. Managed database or storage-backed registry for larger catalogs.
6. Provider-specific facilitator configuration if volume or reliability needs require it.

Do not add CDP or provider API keys until your chosen facilitator path requires them. Most creators only need a public payout wallet address to start.
