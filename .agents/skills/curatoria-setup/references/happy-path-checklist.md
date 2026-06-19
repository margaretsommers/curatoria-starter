# Happy Path Checklist (agent reference)

Default: **Track A** + **Vercel** + **local demo products** first. Link user to `docs/creator/00-happy-path.md` for the human-readable version.

## Ordered phases

| # | Phase | Command / action | Proves |
| --- | --- | --- | --- |
| 0 | Skill level + track | Ask normie vs dev; offer Track A/B | Right verbosity and discovery model |
| 1 | Clone + install | `npm install`, `cp .env.example .env` | Repo ready |
| 2 | Env + wallet | Set `WALLET_ADDRESS`, `ADMIN_API_KEY`, `NETWORK=base-sepolia` | `/health` ok |
| 3 | Local smoke | `npm run smoke` | Free catalog 200, assets 402 |
| 4 | Local bug-bash | `npm run bug-bash -- --local` | Bazaar metadata in asset challenges |
| 5 | Publish (optional) | `npm run publish-design` or use demo products | Product in registry |
| 6 | Testnet deploy | Vercel + env on host | Public free catalog + asset 402 |
| 7 | Storage (when ready) | `--gdrive-id`, `--dropbox-url`, or `--url` | Non-local delivery |
| 8 | Track B (optional) | `CATALOG_PAYWALL_ENABLED=1` + catalog price | Paid `/catalog` |
| 9 | Mainnet | CDP keys, `NETWORK=base`, preflight, small paid test | Real USDC settlement |

## RED pauses

- CDP API keys
- Deploy / DNS approval
- GitHub push to user's remote
- Mainnet USDC spend
- awal OTP for paid proof

## One default simplification

If the user is overwhelmed: stop after phase 4 (local bug-bash green) and defer deploy until they confirm Vercel account is ready.
