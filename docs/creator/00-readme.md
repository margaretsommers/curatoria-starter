# Creator Guide

> **Available today:** yes
> **Requires terminal:** yes

Curatoria Starter is a small service for selling creator-owned digital products to AI agents with x402. **Track A (default):** free full catalog at well-known; pay per asset only. **Track B (optional):** free teaser, paid `GET /catalog`, then paid assets. See [`01-before-you-start.md`](01-before-you-start.md).

This guide is for creators who want to fork the public starter, replace the example content with their own products, test the paywall locally, and plug the deployed service into their own site.

## Today

Today, the working path is technical but direct:

1. Create a new repo from the `curatoria-starter` template.
2. Clone it locally and run `npm install`.
3. Copy `.env.example` to `.env`.
4. Set `WALLET_ADDRESS`, `ADMIN_API_KEY`, and `NETWORK=base-sepolia`.
5. Run `npm run dev`.
6. Add files under `design-systems/`.
7. Publish markdown or bundle products with the CLI.
8. Deploy the Node service so agents can read your public catalog.
9. Link to the catalog and paid routes from your own site or product pages.

The local service gives you these core URLs. `/` redirects to `/docs.html` for setup docs; creators bring their own homepage.

```bash
http://localhost:3000/docs.html
http://localhost:3000/.well-known/design-catalog.json
http://localhost:3000/design-systems/example-minimal
```

On the default **Track A** setup, well-known and `/catalog` return the full free listing. Asset routes return `402` until the client sends a valid x402 payment. **Track B** (`CATALOG_PAYWALL_ENABLED=1`) uses a teaser at well-known and paid `/catalog` — see [`01-before-you-start.md`](01-before-you-start.md).

## Planned

The starter is moving toward a less technical creator workflow:

- connect cloud storage without moving files manually;
- publish from a guided flow instead of terminal commands;
- register catalogs with Bazaar-style discovery automatically;
- support a clearer no-terminal first run for non-technical creators.

Until those features ship, the honest production path is: local files in `design-systems/`, CLI publishing, self-hosted Node service, and manual sharing of your catalog URL.

## Agent-Guided Setup

An agent can walk a creator through the full setup in order. Point your agent at `.agents/skills/creator-setup/SKILL.md` or ask it to "guide me through curatoria-starter setup." The skill encodes the six-phase flow — wallet → storage → publish → Bazaar listing → testnet smoke → go live — and routes to the correct chapter for each step.

## Chapter Map

- `00-accounts-and-env.md` — accounts, env vars, deployment order, and common setup failures.
- `00-happy-path.md` — short ordered checklist from clone to mainnet.
- `01-before-you-start.md` explains the model: catalog, x402, agents, and payouts.
- `02-wallet-basics.md` covers the payout wallet setup.
- `03-connect-your-storage.md` explains the storage workaround today and the planned connector path.
- `04-products-and-prices.md` covers product publishing.
- `05-markdown-vs-bundle.md` helps choose between markdown and zip products.
- `06-test-on-testnet.md` walks through Base Sepolia testing.
- `07-go-live.md` covers mainnet and deployment.
- `08-bazaar-listing.md` explains built-in Bazaar metadata today and what external indexing still needs.
- `09-troubleshooting.md` collects common failures.

## Quick Start

```bash
git clone https://github.com/YOUR_NAME/curatoria-starter.git
cd curatoria-starter
npm install
cp .env.example .env
npm run dev
```

Then open:

- `http://localhost:3000/` to confirm it redirects to the local docs;
- `http://localhost:3000/.well-known/design-catalog.json` to inspect discovery;
- `http://localhost:3000/design-systems/example-minimal` to confirm the unpaid `402` response;
- `http://localhost:3000/health` to confirm the service is healthy.

Start on `base-sepolia`. Move to `base` only after local discovery, unpaid `402` responses, and test payments are working.
