# Curatoria Starter

Curatoria Starter is a template for selling original design resources through an x402 paywall. It runs one Node service for catalog metadata and paid resource endpoints. Bring your own site, then link to the service's catalog and paid routes from there.

## What You Get

- A working x402 paywall service on `npm run dev`
- Generic demo products in `design-systems/`: one Markdown file and one zip bundle
- A free full catalog at `/.well-known/design-catalog.json` and `GET /catalog` (Track A default); pay per asset only
- A root URL that redirects to `/docs.html` for setup docs
- Publish scripts for markdown design systems and downloadable packs
- `npm run bug-bash` checks for health, free catalog at well-known, unpaid asset 402, and Bazaar metadata
- Starter policy guidance in `docs/acceptable-use-and-content-ownership.md`

## Quick Start

Before timing the install, finish the account preflight in `docs/creator/00-accounts-and-env.md`. It explains each account or tool, why Curatoria needs it, when it is required, and where to record the resulting value. The first local Track A run needs GitHub access, Node/npm, a Base-compatible payout wallet address for `WALLET_ADDRESS`, and a generated admin secret for `ADMIN_API_KEY`. Host, DNS, CDP, paid testnet funds, and external storage setup can wait until deploy, paid proof, or mainnet launch.

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
   WALLET_ADDRESS=0x0000000000000000000000000000000000000001
   ADMIN_API_KEY=change-me-admin-key
   NETWORK=base-sepolia
   PORT=3000
   FACILITATOR_URL=https://x402.org/facilitator
   ```

6. Start the service:

   ```bash
   npm run dev
   ```

Open:

- Docs redirect: `http://localhost:3000/` -> `http://localhost:3000/docs.html`
- Discovery catalog: `http://localhost:3000/.well-known/design-catalog.json` (full `design_systems[]` with prices and access_url)
- Catalog alias: `curl http://localhost:3000/catalog` (expect `200` with same listing)
- Markdown paywall check: `http://localhost:3000/design-systems/curatoria-demo-md`
- Bundle paywall check: `http://localhost:3000/packs/curatoria-demo-pack/download`

Unpaid asset routes should return `402 Payment Required` until a valid x402 payment is provided. Run the local bug bash while the service is running:

```bash
npm run bug-bash -- --local
```

## Replace The Demo Products

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

You do not have to commit the file. You can also sell from a URL you control,
from Google Drive, or from Dropbox by swapping the source flag:

```bash
# From your own domain / CDN / object storage
npm run publish-design -- --id my-doc --url https://files.yourdomain.com/my-doc.md \
  --name "My Doc" --price 5.00

# From a Google Drive file shared "Anyone with the link can view"
npm run publish-design -- --id my-doc --gdrive-id "https://drive.google.com/file/d/<ID>/view" \
  --name "My Doc" --price 5.00

# From a Dropbox file shared "Anyone with the link can view"
npm run publish-design -- --id my-doc --dropbox-url "https://www.dropbox.com/s/.../my-doc.md?dl=0" \
  --name "My Doc" --price 5.00
```

See `docs/creator/03-connect-your-storage.md` for the full storage guide. All
commands update `design-systems/.registry.json`, which powers catalog and asset
endpoints. Full product metadata is free at well-known and `/catalog` on the default track.
Optional Track B: set `CATALOG_PAYWALL_ENABLED=1` for paid `/catalog` (see `docs/creator/01-before-you-start.md`).

## Deploy

Deploy the Node service to Vercel, Railway, Fly, Render, or another host that supports Node services. Vercel is the reference path in the creator docs. Railway is optional: create a Railway account/project first, connect the GitHub repo, confirm trial or billing capacity, set env vars in Railway, and use the Railway URL or custom domain as `PUBLIC_BASE_URL`.

Set the same environment variables in your host dashboard, use `NETWORK=base` when you are ready for mainnet, and host the deployed service behind a domain or API subdomain you control. Agents discover your full catalog at the well-known URL:

```text
https://yourdomain.com/.well-known/design-catalog.json
https://yourdomain.com/catalog
```

## What Is Planned

Available today: local files in `design-systems/`, direct URL / your-domain sources, Google Drive sources, Dropbox Mode A share links, Dropbox Mode B private paths with OAuth env vars, CLI publishing, x402 payment checks, built-in Bazaar discovery metadata in `402` responses, and self-hosted deployment.

Coming soon: iCloud/CloudKit assessment follow-through, OAuth-based Google Drive, no-terminal publishing, and stronger zero-touch external Bazaar indexing coverage.

## Safety Notes

Never commit `.env`, private keys, seed phrases, or admin secrets. Curatoria only needs your public payout address in `WALLET_ADDRESS`.

Only publish content you own or have rights to distribute. See `docs/acceptable-use-and-content-ownership.md` before launching publicly.
