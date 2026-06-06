# Appendix - Self Host Curatoria

> **Available today:** partial
> **Requires terminal:** yes

Self-hosting gives you control over your domain, catalog, payout wallet, logs, and infrastructure. Today Curatoria is a Node service with local catalog and asset files. For heavier traffic, move secrets, files, monitoring, and rate limits into managed services.

## Minimum Architecture

The starter architecture is:

- Node.js runtime.
- x402 facilitator endpoint.
- `design-systems/.registry.json` for catalog metadata.
- Local files in `design-systems/` for Markdown and zip products.
- Public domain serving both free discovery and paid routes.

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
FACILITATOR_URL=https://x402.org/facilitator
```

Optional:

```bash
WALLET_ENS=yourname.eth
```

Use separate values for development, staging, and production. Rotate any demo admin key before launch.

## Domain And Routes

Your public domain should expose:

```text
GET /health
GET /.well-known/design-catalog.json
GET /design-systems
GET /design-systems/:id
GET /packs/:id/download
POST /admin/publish
```

The same domain should serve free discovery and paid content. Agents need a stable catalog URL they can crawl or receive directly:

```text
https://yourdomain.com/.well-known/design-catalog.json
```

## Storage Today

Today, Curatoria expects:

- Product metadata in `design-systems/.registry.json`.
- Markdown files in `design-systems/`.
- Zip bundles in `design-systems/`.

For a small launch, deploy these files with the app. For larger catalogs or bigger bundles, plan to move assets to object storage such as S3, R2, or GCS and keep the registry metadata clean and backed up.

## Reliability Baseline

Before public traffic, add:

- Uptime check on `/health`.
- Logs for paid routes.
- Alerts for 5xx spikes.
- Alerts for payment verification or settlement failures.
- Rate limiting on paid endpoints.
- Backup of `design-systems/.registry.json`.

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
