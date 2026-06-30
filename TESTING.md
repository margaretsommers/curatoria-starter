# Curatoria Starter Testing Guide

Use this guide when you are testing Curatoria Starter for the first time. The goal is not only to get a green run. It is also to tell the Curatoria team where setup felt unclear, slow, brittle, or surprising.

If you get stuck, investigate enough to describe what happened. You can search the repo, read nearby docs, retry a command after fixing an obvious local issue, or ask the Curatoria team for help at `curatoria.dev@pm.me`. Record what you tried and whether help was needed.

Send feedback to `curatoria.dev@pm.me`. Include your operating system, Node/npm versions if relevant, elapsed time, the step where anything failed, and copied terminal output for errors. Do not send private keys, seed phrases, `.env` files, admin secrets, or wallet recovery material.

## Timing Rules

Track two times separately:

- **Account setup time:** Time spent creating or verifying accounts, wallets, hosting access, DNS, storage, CDP, or test funds.
- **Timed local install test:** Time from the fresh clone command through `npm run bug-bash -- --local`.

The local install target is 15-20 minutes after account preflight is complete. Account setup may take longer and should not count against the local install timer.

## Account Preflight

Complete this before starting the timed local install test.

- [ ] **GitHub:** You can access `https://github.com/margaretsommers/curatoria-starter` and can clone or fork the repo.
- [ ] **Node.js and npm:** Node and npm are installed. If install friction appears, record `node --version` and `npm --version`.
- [ ] **Payout wallet on Base:** You have a Base-compatible public wallet address for `WALLET_ADDRESS`. The local unpaid smoke test can use the placeholder address in `.env.example`, but paid tests and deploy need your real public payout address.
- [ ] **Admin secret:** You have a long random value for `ADMIN_API_KEY`. Record where you stored it, not the secret itself.
- [ ] **Managed Node host:** You know which host you may use later. Vercel is the reference path; Railway, Fly, Render, or a VPS are alternatives. This is not required for the timed local run.
- [ ] **Public URL and DNS:** You know what public HTTPS origin will eventually become `PUBLIC_BASE_URL`. This is not required for localhost.
- [ ] **Optional testnet funds:** Base Sepolia ETH and test USDC are only needed for optional paid proof, not for unpaid smoke or this timed local run.
- [ ] **Coinbase Developer Platform (CDP):** CDP is optional for testnet faucet access and required before mainnet facilitator use. It is not required for the timed local run.
- [ ] **Storage provider:** Local files in `design-systems/` are enough for the starter run. Google Drive, Dropbox, or your own HTTPS file hosting can wait until you replace demo products.
- [ ] **Track choice:** Use Track A for this test: free catalog, paid assets only. Do not enable paid catalog mode during this run.

Preflight result:

- [ ] Complete - start the timed checklist below.
- [ ] Incomplete - stop and send feedback about the missing account or setup work.

**Account preflight time:**  
**Accounts/services created or verified:**  
**Preflight friction:**  

```text

```

## Before The Timed Local Install Test

- [ ] Start a timer.
- [ ] Confirm account preflight is complete.
- [ ] Use a fresh clone from GitHub. Do not reuse an existing checkout.
- [ ] Keep terminal output for any failing command.

## 1. Fresh Clone And Install

Run:

```bash
mkdir -p ~/Desktop/curatoria-starter-test
cd ~/Desktop/curatoria-starter-test
git clone https://github.com/margaretsommers/curatoria-starter.git
cd curatoria-starter
npm install
```

Result:

- [ ] Pass
- [ ] Fail
- [ ] Friction noted below

Notes:

```text

```

## 2. Configure `.env`

Run:

```bash
cp .env.example .env
```

Open `.env` and confirm these local-test values are present:

```text
WALLET_ADDRESS=0x0000000000000000000000000000000000000001
ADMIN_API_KEY=change-me-admin-key
NETWORK=base-sepolia
FACILITATOR_URL=https://x402.org/facilitator
```

For this local spot-check, do not configure mainnet, CDP credentials, `AWAL_PAID_TEST`, Google Drive, or Dropbox.

Result:

- [ ] Pass
- [ ] Fail
- [ ] Friction noted below

Notes:

```text

```

## 3. Local Dev, Health, Catalog, Smoke

Start the local server:

```bash
npm run dev
```

In a second terminal, from the same `curatoria-starter` folder, run:

```bash
curl -fsS http://localhost:3000/health
curl -fsS http://localhost:3000/.well-known/design-catalog.json
npm run smoke
```

Expected:

- `/health` returns JSON with `"status":"ok"` or equivalent healthy status.
- `/.well-known/design-catalog.json` returns a full catalog with design systems.
- `npm run smoke` exits 0.

Result:

- [ ] Pass
- [ ] Fail
- [ ] Friction noted below

Notes:

```text

```

## 4. Local Bug Bash

Run:

```bash
npm run bug-bash -- --local
```

Expected:

- The command exits 0.
- Local service checks pass.
- Catalog sanity checks pass.
- Paid proof is not required for this first-time local test.

Result:

- [ ] Pass
- [ ] Fail
- [ ] Friction noted below

Notes:

```text

```

## Friction Log

Record anything confusing, surprising, slow, or missing. Useful feedback includes:

- The exact step where you hesitated or failed.
- The command you ran and the output you saw.
- What you expected to happen.
- What you tried next.
- Whether you found the answer yourself or needed help.
- Severity: critical, major, or minor.

```text
1.
2.
3.
```

## Pass/Fail Verdict

- [ ] Pass - reached `npm run bug-bash -- --local` green, with 0 critical findings and no more than 2 major friction items.
- [ ] Fail - could not complete, found any critical blocker, or found more than 2 major friction items.

**Timed local install test time:**  
**Account setup time:**  
**Tester name or handle:**  
**Date/time:**  
**Operating system:**  
**Node/npm versions, if relevant:**  

## Feedback Template

Email `curatoria.dev@pm.me` with this template:

```text
Subject: Curatoria Starter test feedback

Tester:
Operating system:
Account setup time:
Timed local install test time:
Pass or fail:

Steps completed:

Where I got stuck or slowed down:

Terminal output for errors:

What I tried:

What would have made this easier:

Can the Curatoria team follow up with questions? Yes/No
```
