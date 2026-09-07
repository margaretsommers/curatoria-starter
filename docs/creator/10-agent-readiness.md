# 10 — Agent Readiness

> **Available today:** partial (service routes built-in; marketing-site files are yours)
> **Requires terminal:** yes for deploy and verification

This chapter explains how to make a Curatoria instance discoverable and usable by AI agents — the same surfaces checked by tools like [isitagentready.com](https://isitagentready.com).

Curatoria splits into two surfaces:

1. **Service (API)** — the Node app from this starter. Most `/.well-known/*` routes, x402 paywalls, OpenAPI, and catalog discovery are **already implemented in `src/`**. Deploy the service and they go live on your domain.
2. **Marketing site (HTML)** — your homepage, docs page, or separate brand site. You add `robots.txt`, optional WebMCP, and branding. The starter ships a minimal `public/` docs redirect; you extend it or host pages on the same domain as the service.

**Recommended:** serve marketing files and the API from one origin (for example `https://yourdomain.com`). Agents, scanners, and x402 buyers then see a single coherent site.

Reference implementation: [curatoria.dev](https://curatoria.dev) (operator shop — not a clone template).

---

## Quick validation

After deploy, scan your live domain:

```bash
curl -sI https://yourdomain.com/robots.txt
curl -s https://yourdomain.com/.well-known/x402 | jq .
curl -sv https://yourdomain.com/design-systems/example-minimal 2>&1 | grep -E 'HTTP/|payment-required'
```

Or use the [isitagentready scan API](https://isitagentready.com):

```bash
curl -s -X POST https://isitagentready.com/api/scan \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://yourdomain.com"}'
```

---

## What the starter service provides automatically

These routes are registered in `src/server.ts` when you deploy. No extra code required — set `PUBLIC_BASE_URL` to your live domain so URLs inside JSON responses are correct.

| Surface | URL | Notes |
| --- | --- | --- |
| Design catalog | `GET /.well-known/design-catalog.json` | Free product metadata (Track A default) |
| x402 discovery | `GET /.well-known/x402` | Paid resource URLs, facilitator, network, `payTo` |
| OpenAPI | `GET /.well-known/openapi.json` | Paid routes declare `x-payment-info` for x402 |
| API catalog (RFC 9727) | `GET /.well-known/api-catalog` | Linkset to OpenAPI, llms.txt, auth, MCP, x402 |
| OAuth / auth discovery | `GET /.well-known/oauth-authorization-server`, `oauth-protected-resource`, `/auth.md` | Honest x402 buyer model + admin API key |
| Agent skills index | `GET /.well-known/agent-skills/index.json` | Skills served from `/.well-known/agent-skills/*/SKILL.md` |
| MCP server card | `GET /.well-known/mcp/server-card.json` | Discovery card; `/mcp` handler not required for listing |
| Sitemap | `GET /sitemap.xml` | Static pages + active catalog products |
| Paid assets | `GET /design-systems/:id`, `GET /packs/:id/download`, `GET /assets/:id/purchase` | HTTP **402** + `PAYMENT-REQUIRED` when unpaid |
| Binary redemption | `GET /assets/:id/redeem` | Entitlement bearer token returns a short-lived private Blob URL |
| Health | `GET /health` | Network, wallet, storage status |

**Markdown negotiation:** send `Accept: text/markdown` on HTML pages under `public/` to receive markdown with YAML frontmatter (homepage/docs if you add them).

**Link headers:** if you serve a homepage from `public/index.html` through the service, add RFC 8288 `Link` headers pointing at `/.well-known/api-catalog` and `/.well-known/x402` (see `src/link-headers.ts` for the pattern).

---

## MCP in plain words

MCP is useful packaging for agents later. It is not the P0 marketplace or payment proof.

For Curatoria, the split is simple:

- **Coinbase owns payment:** wallet authentication, funds, x402 challenge payment, and settlement.
- **Curatoria owns buying logic:** catalog interpretation, product selection, entitlement redemption, save destination, file validation, and proof output.
- **Creators own supply:** each starter deployment is one creator's catalog unless you deliberately build an aggregator.

A Curatoria wallet bridge may expose `buy_asset` through Coinbase Payments MCP,
but its output is entitlement JSON only. Curatoria's downloader owns the private
URL fetch and local file save. Future MCP tools can add `search_catalog`,
`verify_download`, and `explain_receipt` without moving binary bytes through MCP.

### Buyer prompt contract

A buyer prompt or skill is ready only when its control flow is explicit and
testable:

1. Ask for the local destination and resolve an existing-file collision before
   any wallet call.
2. Require the requested product to be active in the current catalog; an
   example or stale product ID is not executable. Compare amount, chain, token
   contract, payee, product ID, filename, and
   purchase resource with catalog metadata and the 402 challenge.
3. Keep the wallet's role to signing/payment. Curatoria's downloader receives
   metadata-only entitlement JSON on stdin and exclusively owns redemption,
   streaming, atomic saving, and local integrity checks.
4. Resume an interrupted post-payment download from entitlement state without
   paying again.
5. Stop for a human decision when entitlement is expired or payment settlement
   is inconclusive.
6. Never expose file bytes, an entitlement bearer value, a signed private URL,
   a payment signature, wallet secrets, or provider/admin credentials in chat,
   logs, receipts, command arguments, or model prompts.

For Coinbase Payments MCP, the only payment sequence is
`check_payment_requirements` followed by exactly one
`make_x402_request`. Pass its entitlement JSON directly to downloader
`--entitlement-stdin` with a published product ID, explicit destination, and
explicit collision policy. The JSON-only stdin channel is capped at 1 MiB and
the continuation invokes no wallet or payment retry. Never route binary bytes
through MCP. For MetaMask/browser purchases, do not
claim completion until a local disk verifier finds the actual browser-selected
filename and verifies hash, byte count, and file signature.

---

## What you add in `public/`

Copy or adapt these files onto your deployed domain (same origin as the service).

### 1. `public/llms.txt`

Agent integration guide: buyer flow, creator flow, example URLs, wallet tooling. Scanners and agents read this first.

- Keep `/llms.txt` URLs relative to your domain.
- Link to your GitHub starter fork for creators, not the private operator repo.
- See [curatoria.dev/llms.txt](https://curatoria.dev/llms.txt) for structure.

### 2. `public/robots.txt`

RFC 9309 crawl rules plus AI bot allowances. Include:

- `Allow: /.well-known/`, `/catalog`, `/design-systems/`, `/packs/`, `/llms.txt`
- `Disallow: /admin/`, `/health`
- `Content-Signal: search=yes, ai-input=yes, ai-train=no` (per [Content Signals](https://contentsignals.org/))
- `Sitemap: https://yourdomain.com/sitemap.xml`

Regenerate or edit `public/sitemap.xml` when you publish products (`npm run publish-design` updates it; after publish, confirm sitemap includes new product URLs).

### 3. Optional: WebMCP (`public/webmcp.js`)

Expose browser tools via `document.modelContext.registerTool()` for in-browser agents (Chrome WebMCP early preview). Load the script on pages you want agents to drive:

```html
<script src="/webmcp.js"></script>
```

Tools should wrap your site's key actions (fetch catalog, search products, navigate). See [curatoria.dev/webmcp.js](https://curatoria.dev/webmcp.js) for a reference — adapt URLs and copy to your catalog.

### 4. Optional: agent skills artifacts

The service indexes skills listed in `src/agent-skills-index.ts`. To publish custom skills:

1. Add `SKILL.md` files under `public/.well-known/agent-skills/<name>/` **or** register paths in `AGENT_SKILLS_REGISTRY`.
2. Restart/redeploy so digests in `/.well-known/agent-skills/index.json` match file bytes.

Default registry includes buyer/setup skills; fork and edit for your product.

---

## x402 commerce (required for paid routes)

The starter already uses `@x402/express` middleware on asset routes. Scanners expect:

1. A discovery manifest at `/.well-known/x402`
2. Unpaid requests to paid URLs returning **402** with `PAYMENT-REQUIRED` (x402 v2)

### Testnet (Base Sepolia)

```bash
NETWORK=base-sepolia
FACILITATOR_URL=https://x402.org/facilitator
```

```bash
curl -sv https://yourdomain.com/design-systems/example-minimal 2>&1 | grep -E 'HTTP/|payment-required'
# Expect: HTTP/2 402 and payment-required header
```

### Mainnet (Base)

`x402.org/facilitator` does **not** settle Base mainnet. Use the CDP facilitator and API keys:

```bash
NETWORK=base
PUBLIC_BASE_URL=https://yourdomain.com
FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
CDP_API_KEY_ID=your-cdp-api-key-id
CDP_API_KEY_SECRET=your-cdp-api-key-secret
```

If facilitator preflight fails, paid routes return **503** (fail-closed) instead of free bytes. Fix env vars before announcing.

See [`07-go-live.md`](07-go-live.md) and [`09-troubleshooting.md`](09-troubleshooting.md).

---

## Auth discovery (honest model)

Curatoria does **not** issue OAuth tokens to buyer agents. Buyers pay per request with x402 `PAYMENT-SIGNATURE` after HTTP 402. The OAuth discovery documents describe that model honestly so scanners find machine-readable metadata without pretending you run a full identity provider.

- **`/auth.md`** — markdown summary for agents
- **`/.well-known/oauth-authorization-server`** — RFC 8414 + `agent_auth` block
- **`/.well-known/oauth-protected-resource`** — RFC 9728 for admin routes

Admin publish routes still use `X-Admin-Key`. Do not expose that key in any public doc.

---

## DNS-AID (optional, advanced)

DNS-based agent discovery (`_index._agents` HTTPS SVCB records) is optional and requires DNS provider support plus DNSSEC. Most creators can skip it until the specification is widely checked by scanners.

---

## Deploy checklist

Use this before claiming “agent-ready” on your domain:

- [ ] `PUBLIC_BASE_URL` matches your live HTTPS origin
- [ ] `npm run smoke` passes against production
- [ ] `public/llms.txt` and `public/robots.txt` return 200
- [ ] `GET /.well-known/x402` lists your paid resource URLs
- [ ] Unpaid paid routes return **402** with `PAYMENT-REQUIRED`
- [ ] Binary catalog entries expose hash, bytes, filename, and `/assets/<id>/purchase` without source or Blob paths
- [ ] Mainnet: CDP facilitator env vars set and preflight OK
- [ ] Buyer prompts ask for destination/collision choice before payment and stop on challenge drift
- [ ] Buyer prompts stop when the requested product is absent from the current catalog
- [ ] Noninteractive buyers pass an explicit collision policy; `--yes` never chooses one
- [ ] Paid entitlement continuation uses JSON-only `--entitlement-stdin` and zero wallet calls
- [ ] Buyer prompts resume entitlements without repayment and require local disk verification after browser saves
- [ ] Sitemap includes catalog and product URLs
- [ ] (Optional) WebMCP script on your homepage
- [ ] (Optional) isitagentready scan — review `checks.discovery.*` and `checks.commerce.x402`

---

## Split domain (API vs marketing site)

If your shop API lives at `api.example.com` and your site is `example.com`:

- Put `llms.txt`, `robots.txt`, and WebMCP on the domain agents visit first, **or**
- Redirect agents to the API origin in `llms.txt` and ensure that origin has full `/.well-known/*` + x402.

Avoid advertising paid URLs on one host while serving free bytes from another — scanners probe the URL you publish.

---

## Related chapters

- [`07-go-live.md`](07-go-live.md) — mainnet env, CDP facilitator, deploy
- [`08-bazaar-listing.md`](08-bazaar-listing.md) — Bazaar metadata on 402 responses
- [`09-troubleshooting.md`](09-troubleshooting.md) — 402, facilitator, and catalog failures
- [`appendix-self-host.md`](appendix-self-host.md) — DNS, hosting, production checks
