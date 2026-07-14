---
name: curatoria-buyer
description: "Buy design assets from Curatoria x402 catalogs. Use when an agent needs to discover a free design catalog, pay per markdown or zip asset in USDC on Base, or follow curatoria.dev buyer flows. Triggers on: curatoria catalog, x402 design system, pay for markdown, curatoria.dev buyer, design-catalog.json, or agent commerce on Curatoria."
---

# Curatoria Buyer

Purchase creator-owned design assets from a Curatoria x402 paywall with no accounts or checkout pages.

## Discovery

1. Read `https://curatoria.dev/llms.txt` for the full buyer overview.
2. Fetch the free catalog: `GET https://curatoria.dev/.well-known/design-catalog.json`
3. Optional linkset: `GET https://curatoria.dev/.well-known/api-catalog`
4. Auth discovery: `GET https://curatoria.dev/auth.md`

## Payment flow

1. Parse `design_systems[]` from the catalog JSON. Each entry includes `price_usd`, `access_url`, and metadata — never storage paths or file IDs.
2. Request an asset via its `access_url` (for example `/design-systems/:id` or `/packs/:id/download`).
3. On HTTP **402**, read the x402 v2 payment challenge (`PAYMENT-REQUIRED` / `X-PAYMENT-REQUIRED`).
4. Pay with an x402-capable wallet that creates a fresh payment payload for this exact challenge, then retry with `PAYMENT-SIGNATURE` (or `X-PAYMENT-SIGNATURE`).
5. Receive the paid response bytes after settlement on Base mainnet (`eip155:8453`, USDC).
6. Save the response as raw bytes (`ArrayBuffer`, `Blob`, or stream). Use
   `Content-Disposition` for the filename when present; otherwise infer a safe
   filename from the catalog entry or route.

## Demo fixtures (curatoria.dev)

| Product ID | Price (USDC) | Route |
| --- | --- | --- |
| `curatoria-demo-md` | $0.01 | `GET /design-systems/curatoria-demo-md` |
| `curatoria-demo-pack` | $0.03 | `GET /packs/curatoria-demo-pack/download` |

## Wallet tooling

Coinbase Agentic Wallet skills: `npx skills add coinbase/agentic-wallet-skills`, or:

```bash
npx awal@2.10.0 x402 pay <url> --max-amount <micro-units> --json
```

Search Bazaar listings after settlement: `npx awal@2.10.0 x402 bazaar search curatoria`

## Download integrity

Use wallet/HTTP clients that expose the paid response as bytes and sign fresh per
request. Do not cache or persist reusable `PAYMENT-SIGNATURE` values. Do not copy
file content from terminal output, ask an agent to reconstruct a paid asset, or
parse a binary file from `awal x402 pay --json` body data. That path can prove
settlement/debug behavior, but it is not a product-grade download method for
zips, images, PDFs, fonts, or any other binary payload unless `awal` exposes a
safe signer handoff.

After saving, verify by file type: markdown opens as text, zip bundles unzip with
their original structure, JSON remains byte-identical to the delivered payload,
and image/PDF/font files keep their signatures.

## Rules

- Prefer `/.well-known/design-catalog.json` for discovery; `/catalog` is a free alias on Track A.
- Do not treat curatoria.dev as a clone template — creators use https://github.com/margaretsommers/curatoria-starter
- Buyer agents register anonymously via x402 payment signatures; no OAuth token is required.
- Never reconstruct paid assets from stdout, screenshots, copied snippets, or JSON string bodies.
