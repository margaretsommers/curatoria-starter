# Creator Guide

> **Available today:** yes
> **Requires terminal:** yes

Curatoria is a starter for selling creator-owned digital products to AI agents with x402. Agents can read your public catalog for free, request a paid resource, receive a `402 Payment Required` challenge, pay in USDC on Base, and get the file back from your server.

This guide is for creators who want to fork the public starter, replace the example content with their own products, test the paywall locally, and deploy a catalog at their own domain.

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

The local service gives you the setup guide plus three core service URLs:

```bash
http://localhost:3000/docs.html
http://localhost:3000/.well-known/design-catalog.json
http://localhost:3000/health
http://localhost:3000/design-systems/example-minimal
```

The root path redirects to the setup guide. The catalog endpoint is free. Paid design files and bundle downloads return `402` until the client sends a valid x402 payment.

## Planned

The starter is moving toward a less technical creator workflow:

- connect cloud storage without moving files manually;
- publish from a guided flow instead of terminal commands;
- register catalogs with Bazaar-style discovery automatically;
- support a clearer no-terminal first run for non-technical creators.

Until those features ship, the honest production path is: local files in `design-systems/`, CLI publishing, self-hosted Node service, and manual sharing of your catalog URL.

## Chapter Map

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

- `http://localhost:3000/.well-known/design-catalog.json` to inspect discovery;
- `http://localhost:3000/design-systems/example-minimal` to confirm the unpaid `402` response;
- `http://localhost:3000/health` to confirm the service is healthy.

Start on `base-sepolia`. Move to `base` only after local discovery, unpaid `402` responses, and test payments are working.
