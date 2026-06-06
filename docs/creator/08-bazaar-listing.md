# Bazaar Listing

> **Available today:** partial
> **Requires terminal:** yes

Automatic Bazaar registration is planned, not built yet. Today, agents can still discover your Curatoria catalog if you share or publish your catalog URL.

Your catalog URL is the important public entry point:

```text
https://YOUR_DOMAIN/.well-known/design-catalog.json
```

## Today

After you deploy Curatoria, your service exposes a free catalog endpoint. That endpoint lists your paid products, prices, tags, and access URLs.

Agents that understand the catalog can:

1. read the public catalog;
2. choose a product;
3. request its access URL;
4. receive a `402 Payment Required` response;
5. retry with x402 payment;
6. receive the paid file.

To verify your catalog locally:

```bash
curl http://localhost:3000/.well-known/design-catalog.json
```

To verify your deployed catalog:

```bash
curl https://YOUR_DOMAIN/.well-known/design-catalog.json
```

## Current Workaround

Until automatic Bazaar registration exists, use manual discovery:

- link your catalog URL from your website;
- include it in your `llms.txt` if you maintain one;
- share it directly with agent builders and buyers;
- include it in product docs, launch posts, and demos;
- keep the endpoint stable so agents can revisit it.

If a Bazaar or x402 discovery directory accepts manual submissions, submit the catalog URL there. The starter does not currently perform that registration for you.

## Planned

The planned path is automatic discovery registration. In that version, Curatoria would be able to declare or register a discovery extension so Bazaar-style services can index your catalog without a manual submission step.

When this ships, creators should be able to:

- deploy their catalog;
- confirm the public URL;
- register with Bazaar-style discovery from the Curatoria workflow;
- refresh listing metadata when product names, tags, or prices change.

## What Not To Assume Yet

The starter does not currently:

- call a Bazaar registration API;
- implement `declareDiscoveryExtension`;
- guarantee indexing by any external marketplace;
- update third-party listings when your registry changes;
- replace the need for a stable public catalog URL.

The working model today is simple: deploy Curatoria, verify `/.well-known/design-catalog.json`, and share that URL wherever agents or buyers can find it.

## Useful Links

- x402 protocol docs: https://docs.x402.org
- Coinbase x402 docs: https://docs.cdp.coinbase.com/x402/welcome
