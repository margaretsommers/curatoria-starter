# Before You Start

> **Available today:** yes
> **Requires terminal:** yes

Curatoria is not a conventional checkout page. It is an agent-readable commerce service: discovery stays open, paid resources stay protected, and payment happens through an HTTP `402` challenge.

Before you publish your first product, it helps to understand the four moving parts.

## Today

### 1. Discovery

Agents discover your products by reading:

```text
/.well-known/design-catalog.json
```

That catalog lists what exists, what each item costs, which tags describe it, and which URL the agent should request to buy it.

Discovery is free on purpose. Agents need to compare resources before deciding whether to pay.

### 2. Challenge

When an agent requests a paid design system or bundle without payment, the server returns:

```text
402 Payment Required
```

The response includes the x402 payment requirements: network, asset, amount, timeout, resource URL, and payout address.

### 3. Payment

The client signs and sends a payment payload in the `X-PAYMENT` request header. The Curatoria server verifies and settles that payment with the configured x402 facilitator.

For the starter, begin with:

```text
NETWORK=base-sepolia
FACILITATOR_URL=https://x402.org/facilitator
```

Base Sepolia uses test funds, so you can validate the flow without spending real USDC.

### 4. Delivery

After payment settles, the server returns the paid resource:

- markdown for design systems, style guides, token docs, and other machine-readable guidance;
- zip files for icons, templates, assets, or larger bundles.

## What Creators Control

You control:

- your product files under `design-systems/`;
- product IDs, names, prices, tags, and descriptions in the registry;
- the payout wallet address in `.env`;
- the domain where your catalog is hosted;
- whether you stay on testnet or move to Base mainnet.

Curatoria does not hold your funds. Settled USDC goes to the wallet address you configure.

## What Agents Need

Agents and agent builders need predictable metadata:

- stable product IDs;
- clear prices;
- useful descriptions and tags;
- working access URLs;
- consistent unpaid `402` responses;
- paid responses that return the promised file type.

Treat the catalog as part of the product. Good discovery metadata helps agents decide when your work is worth buying.

## Planned

The broader Curatoria direction is to make creator-owned agent commerce easier to run:

- simpler guided setup for non-technical creators;
- cloud storage connectors for existing folders;
- richer rights and ownership metadata;
- broader external Bazaar indexing coverage beyond declared metadata;
- stronger publishing workflows for larger catalogs.

Those are planned improvements. Today, the reliable path is the starter repo, local files, CLI publishing, x402 payment checks, and deployment of your own Node service.

## Preflight Checklist

Before continuing, make sure you have:

- Node 18+ and npm available;
- a dedicated EVM wallet address for receiving Base USDC;
- a plan to start on `base-sepolia`;
- one test markdown product or bundle;
- a domain or deployment target for later;
- a private place to store secrets outside git.

Never commit `.env`, private keys, seed phrases, or recovery phrases. Curatoria only needs your public payout address for server configuration.
