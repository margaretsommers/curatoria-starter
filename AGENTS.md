# Curatoria Starter Agent Guide

This repository is a public starter template for creators who want to sell original design resources through an x402 paywall.

## Safe Work Areas

- `src/` for paywall service behavior
- `scripts/` for publish and smoke-test tooling
- `design-systems/` for example or creator-owned products
- `public/` for the docs redirect and static creator docs only
- `docs/` for public creator documentation
- `apps/` for workspace package wrappers

## Do Not Add

- Private operator notes, strategy docs, or experiments
- Real secrets, private keys, seed phrases, or `.env`
- Personal production catalog content from another Curatoria deployment
- Shopify experiments, waitlist tooling, operator agent folders, or archived operator material
# Note: starter agent skills live in curatoria-starter/.agents/skills/ (e.g. curatoria-setup).
# This script does NOT copy operator .agents/. Maintain starter skills directly in the starter repo.

## Template Defaults

Keep examples generic and replaceable. The starter should document what works today, clearly label planned capabilities, and prefer Base Sepolia for local testing. Do not add a homepage; creators should plug the service into their own site.

Use `npm run dev` for the real local path because the Node service serves both public files and paid routes.
