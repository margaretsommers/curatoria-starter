# Bazaar Listing

> **Available today:** yes
> **Requires terminal:** yes

Curatoria now declares Bazaar discovery metadata directly in each `402 Payment Required` challenge. That means every published product exposes machine-readable discovery details without any extra publish step.

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

## What Is Automatic Today

When an agent requests a paid route:

- Curatoria returns a `402` challenge;
- the challenge includes `extensions.bazaar` from `declareDiscoveryExtension(...)`;
- metadata is generated from your live registry entry (ID, name, tags, type);
- updates to products and prices are reflected on the next request automatically.

Because metadata is attached to the payment challenge, publishing or repricing products does not require a separate discovery registration command.

## Still Manual Today

You still need to make sure agents can find your catalog URL:

- link your catalog URL from your website;
- include it in your `llms.txt` if you maintain one;
- share it directly with agent builders and buyers;
- include it in product docs, launch posts, and demos;
- keep the endpoint stable so agents can revisit it.

Some discovery directories may also require manual submission or their own indexing policy.

## What Is Not Guaranteed Yet

- Curatoria does not force external Bazaar operators to index your catalog.
- Curatoria does not control third-party refresh cadence or ranking.
- Curatoria does not replace the need for a stable public domain/catalog URL.

The working model today: deploy Curatoria, verify `/.well-known/design-catalog.json`, and rely on built-in discovery metadata in each `402` challenge while you continue sharing your catalog URL.

## Useful Links

- x402 protocol docs: https://docs.x402.org
- Coinbase x402 docs: https://docs.cdp.coinbase.com/x402/welcome
