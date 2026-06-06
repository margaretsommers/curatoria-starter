# Curatoria Starter

Curatoria Starter is a template for selling original design resources through an x402 paywall. It runs one Node service that serves your public site, catalog metadata, and paid resource endpoints.

## What You Get

- A working x402 paywall service on `npm run dev`
- One example product in `design-systems/example-minimal.md`
- A public catalog at `/.well-known/design-catalog.json`
- Publish scripts for markdown design systems and downloadable packs
- Starter policy guidance in `docs/acceptable-use-and-content-ownership.md`

## Quick Start

1. Use this repository as a GitHub template, then clone your new repo.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Create your local environment file:

   ```bash
   cp .env.example .env
   ```

4. Create a dedicated payout wallet. Coinbase Wallet is the recommended path because it works well with Base, Base Sepolia testnet, and USDC offramp flows. Any EVM wallet that can receive USDC on Base also works.
5. Edit `.env`:

   ```bash
   WALLET_ADDRESS=0xYOUR_BASE_WALLET
   ADMIN_API_KEY=change-me-to-a-long-random-secret
   NETWORK=base-sepolia
   PORT=3000
   FACILITATOR_URL=https://x402.org/facilitator
   ```

6. Start the service:

   ```bash
   npm run dev
   ```

Open:

- Site: `http://localhost:3000`
- Catalog: `http://localhost:3000/.well-known/design-catalog.json`
- Paywall check: `http://localhost:3000/design-systems/example-minimal`

The paid route should return `402 Payment Required` until a valid x402 payment is provided.

## Replace The Example Product

Add your own markdown product under `design-systems/`, then publish it:

```bash
npm run publish-design -- \
  --id my-product \
  --file design-systems/my-product.md \
  --name "My Product" \
  --price 5.00
```

For downloadable bundles, use:

```bash
npm run publish-pack -- \
  --id my-pack \
  --zip path/to/my-pack.zip \
  --name "My Pack" \
  --price 12.00
```

Both commands update `design-systems/.registry.json`, which powers the public catalog and paid endpoints.

## Deploy

Deploy the Node service to Railway, Fly, Render, or another host that supports long-running Node processes.

Set the same environment variables in your host dashboard, use `NETWORK=base` when you are ready for mainnet, and point your domain at the deployed service. Buyers and agents can discover your catalog at:

```text
https://yourdomain.com/.well-known/design-catalog.json
```

## What Is Planned

Available today: local files in `design-systems/`, CLI publishing, x402 payment checks, and self-hosted deployment.

Coming soon: cloud storage connectors, no-terminal publishing, and automatic x402 Bazaar registration.

## Safety Notes

Never commit `.env`, private keys, seed phrases, or admin secrets. Curatoria only needs your public payout address in `WALLET_ADDRESS`.

Only publish content you own or have rights to distribute. See `docs/acceptable-use-and-content-ownership.md` before launching publicly.
