# 02 - Wallet Basics

> **Available today:** yes
> **Requires terminal:** partial

Curatoria sends settled payments to the payout address configured in your `.env` file. You only need to give the server a public receive address. Do not put a recovery phrase, private key, or seed phrase in this project.

The recommended path is **Coinbase Wallet plus Coinbase Developer Platform (CDP) tools** because Curatoria already uses Coinbase-backed x402 rails and the default x402 facilitator. This gives creators the clearest path from testnet setup to Base mainnet USDC and, when needed, cashing out through Coinbase.

## What Your Wallet Must Support

Your payout wallet must be:

- An EVM-compatible `0x...` address.
- Able to receive USDC on Base.
- Used on Base Sepolia while testing and Base mainnet when live.

Curatoria can support any wallet that meets those requirements. Coinbase Wallet is recommended, but MetaMask, Rainbow, Rabby, a hardware wallet, or another EVM wallet can work if it supports Base USDC.

## Recommended: Coinbase Wallet

1. Create a dedicated creator payout wallet in Coinbase Wallet.
2. Save the recovery phrase securely outside this repo.
3. Add or select the Base network.
4. Copy the public receive address.
5. Paste only the public address into `.env`:

```bash
WALLET_ADDRESS=0xYOUR_BASE_WALLET
NETWORK=base-sepolia
```

You can optionally use `WALLET_ENS` if you own an ENS name that resolves to your payout address. If both `WALLET_ENS` and `WALLET_ADDRESS` are set, the server tries ENS first and falls back to `WALLET_ADDRESS`.

## Fund Testnet Wallet

Use testnet funds before trying a real payment:

1. Get Base Sepolia test ETH from the [CDP Faucet](https://portal.cdp.coinbase.com/products/faucet).
2. Get Base Sepolia test USDC from the [Circle testnet faucet](https://faucet.circle.com/).
3. Confirm both assets appear on Base Sepolia in your wallet.
4. Start Curatoria and check the resolved wallet:

```bash
npm run dev
curl http://localhost:3000/health
```

The `/health` response should include `network: "base-sepolia"` and your configured payout wallet.

## Use Another Base USDC Wallet

If you already use another wallet, the same rules apply:

| Wallet | Creator notes |
| --- | --- |
| MetaMask, Rainbow, Rabby | Add Base, confirm you are receiving USDC on Base, then use the EVM address as `WALLET_ADDRESS`. |
| Hardware wallet | Use the Base-compatible EVM receive address. The server only needs the public address. |
| Other EVM wallets | Valid if the wallet supports Base and can receive USDC on that network. |

Phantom or other non-EVM-first wallets only work if they provide a Base-compatible EVM address. A Solana-only address cannot receive Curatoria payouts today.

## Go From Testnet To Mainnet

When you are ready to accept real payments:

1. Change `NETWORK=base`.
2. Set `WALLET_ADDRESS` to the wallet where you want real Base USDC to arrive.
3. Send a small amount of Base USDC to that wallet first so you can verify the address and network.
4. Run a small paid test before sharing the catalog broadly.

If you use Coinbase Wallet, the simplest cash-out path is usually transferring USDC to your Coinbase account, then selling or withdrawing according to Coinbase's current flow. If you use another wallet, choose the exchange, bridge, or offramp you trust.

## Useful Links

- [x402 on CDP](https://docs.cdp.coinbase.com/x402/welcome)
- [CDP Portal](https://portal.cdp.coinbase.com)
- [Base Sepolia faucet](https://portal.cdp.coinbase.com/products/faucet)
- [x402 protocol docs](https://docs.x402.org)
