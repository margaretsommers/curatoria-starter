# 07 - Go Live

> **Available today:** partial
> **Requires terminal:** yes

Go live only after your Base Sepolia test flow works end to end. Mainnet uses the same app and routes, but payments settle in real USDC on Base.

## Before You Switch

Confirm:

- Your products are final enough to sell.
- `npm run smoke` passes.
- A real testnet paid request succeeds.
- Your support or DMCA contact email is published somewhere public.
- You control the payout wallet and can access incoming Base USDC.
- Your `.env` is stored only in your host's secret manager or local machine.

## Mainnet Environment

Set production environment variables on your host:

```bash
WALLET_ADDRESS=0xYOUR_BASE_MAINNET_WALLET
ADMIN_API_KEY=use-a-long-random-secret
NETWORK=base
PORT=3000
FACILITATOR_URL=https://x402.org/facilitator
```

Use a real Base mainnet payout wallet. If you use Coinbase Wallet, confirm you are viewing the Base network and copying the Base-compatible EVM address.

## Deploy The Service

Curatoria is a Node service. Any host that can run a long-lived Node app can work, including Railway, Fly.io, Render, a VPS, or EC2.

Typical deployment shape:

1. Connect the repository to your host.
2. Set environment variables in the host dashboard.
3. Install dependencies with `npm install`.
4. Build if your host requires it:

```bash
npm run build
```

5. Start the service:

```bash
npm run start
```

The production service should serve both free discovery and paid routes from the same domain.

## Set Your Domain

Point your domain to the host according to that provider's DNS instructions. Once DNS resolves, verify:

```bash
curl https://yourdomain.com/health
curl https://yourdomain.com/.well-known/design-catalog.json
curl -v https://yourdomain.com/design-systems/example-minimal
```

The unpaid paid-route check should still return `402`. That means the paywall is active.

## Run A Small Mainnet Payment

Before announcing widely:

1. Use the smallest product price you are comfortable testing.
2. Pay from a buyer wallet that has Base USDC.
3. Confirm the paid content is returned.
4. Confirm USDC arrives in your configured payout wallet.
5. Save the transaction hash and product ID for your launch notes.

## Facilitator And Scale Notes

The default facilitator URL works for getting started:

```bash
FACILITATOR_URL=https://x402.org/facilitator
```

For higher volume or operator-specific requirements, review Coinbase Developer Platform options at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com). Keep provider API keys in your host's secret manager, not in source control.

## Launch Checklist

- `NETWORK=base`.
- Mainnet payout wallet configured.
- Admin key rotated from any demo value.
- Catalog URL works publicly.
- Unpaid paid routes return `402`.
- Paid Markdown flow succeeds.
- Paid bundle flow succeeds if you sell bundles.
- Logs are visible.
- `/health` is monitored.
- Support/DMCA contact is public.
