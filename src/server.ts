/**
 * server.ts — Curatoria service entry point
 *
 * Three route groups:
 *
 *   FREE    /.well-known/design-catalog.json  — catalog for agent discovery
 *           /design-systems                   — alias for the above
 *           /health                           — uptime check
 *           /                                 — redirects to local setup docs
 *
 *   PAID    /design-systems/:id               — returns design.md after payment
 *           (X402 payment required, ~$0.01 USDC per access)
 *
 *   ADMIN   POST /admin/publish               — register a new design system
 *           (requires X-Admin-Key header)
 */

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'path';

import { handleDiscovery } from './discovery';
import { findEntry, readDesignFile, readBundleFile, appendEntry, readCatalog } from './catalog';
import { x402Paywall } from './x402';
import { PublishRequest, DesignSystemEntry } from './types';

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const WALLET_ADDRESS = process.env.WALLET_ADDRESS ?? '';
const WALLET_ENS = process.env.WALLET_ENS ?? '';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? '';
const NETWORK = process.env.NETWORK ?? 'base-sepolia';
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? 'https://x402.org/facilitator';

if (!ADMIN_API_KEY) {
  console.error('ERROR: ADMIN_API_KEY env var is required.');
  process.exit(1);
}

function isValidAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

async function resolveWalletAddress(): Promise<string> {
  const fallbackAddress = WALLET_ADDRESS.trim();
  const ensName = WALLET_ENS.trim();

  if (ensName) {
    try {
      // Load ENS helpers lazily so TypeScript doesn't require browser DOM typings from viem's d.ts graph.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createPublicClient, http } = require('viem');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { mainnet } = require('viem/chains');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getEnsAddress, normalize } = require('viem/ens');

      const ensClient = createPublicClient({
        chain: mainnet,
        transport: http(),
      });
      const normalizedName = normalize(ensName);
      const resolvedAddress = await getEnsAddress(ensClient, { name: normalizedName });

      if (resolvedAddress && isValidAddress(resolvedAddress)) {
        console.log(`Resolved WALLET_ENS ${ensName} -> ${resolvedAddress}`);
        return resolvedAddress;
      }

      console.warn(
        `WALLET_ENS "${ensName}" did not resolve to an address. Falling back to WALLET_ADDRESS.`,
      );
    } catch (error) {
      console.warn(
        `Failed to resolve WALLET_ENS "${ensName}" (${String(error)}). Falling back to WALLET_ADDRESS.`,
      );
    }
  }

  if (fallbackAddress && isValidAddress(fallbackAddress)) {
    return fallbackAddress;
  }

  throw new Error(
    'No valid payout wallet found. Set WALLET_ENS to a resolvable ENS name and/or WALLET_ADDRESS to a valid 0x address.',
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

function requireAdmin(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_API_KEY) {
    res.status(401).json({ error: 'Unauthorized — X-Admin-Key header required' });
    return;
  }
  next();
}

/**
 * POST /admin/publish
 *
 * Registers a design.md file from the design-systems/ directory into the
 * registry with a price. The .md file must already exist on disk before
 * calling this endpoint (or use `npm run publish-design` CLI instead).
 *
 * Body: { id, file, name, description, price_usd, tags? }
 * Header: X-Admin-Key: <your ADMIN_API_KEY>
 */
async function startServer(): Promise<void> {
  const resolvedWalletAddress = await resolveWalletAddress();
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());
  app.get('/', (_req, res) => {
    res.redirect(302, '/docs.html');
  });
  app.use(express.static(path.resolve(__dirname, '../public')));

  // ─── Free: Discovery ────────────────────────────────────────────────────────

  // Agent-discovery endpoint — follows .well-known convention (RFC 5785).
  // Returns the full catalog with prices but not the actual design.md content.
  app.get('/.well-known/design-catalog.json', handleDiscovery);
  app.get('/design-systems', handleDiscovery);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', network: NETWORK, wallet: resolvedWalletAddress });
  });

  // ─── Paid: Design System Content ───────────────────────────────────────────

  // x402Paywall middleware intercepts every GET /design-systems/:id request:
  //   - No X-PAYMENT header → returns HTTP 402 with price and wallet info
  //   - Valid X-PAYMENT header → verifies + settles via facilitator, then falls through
  app.get(
    '/design-systems/:id',
    x402Paywall({
      walletAddress: resolvedWalletAddress,
      network: NETWORK,
      facilitatorUrl: FACILITATOR_URL,
      expectedResourceType: 'design_md',
    }),
    (req, res) => {
      const entry = findEntry(req.params.id);
      if (!entry) {
        // Shouldn't happen (middleware 404s first) but guards the type
        res.status(404).json({ error: 'Design system not found' });
        return;
      }

      let content: string;
      try {
        content = readDesignFile(entry);
      } catch (err) {
        res.status(500).json({ error: 'Design file missing from disk', detail: String(err) });
        return;
      }

      res
        .setHeader('Content-Type', `${entry.mime_type ?? 'text/markdown'}; charset=utf-8`)
        .setHeader('X-Design-System-Id', entry.id)
        .setHeader('X-Design-System-Name', entry.name)
        .setHeader('X-Design-System-Version', '1.0.0')
        .send(content);
    },
  );

  app.get(
    '/packs/:id/download',
    x402Paywall({
      walletAddress: resolvedWalletAddress,
      network: NETWORK,
      facilitatorUrl: FACILITATOR_URL,
      expectedResourceType: 'bundle_zip',
    }),
    (req, res) => {
      const entry = findEntry(req.params.id);
      if (!entry) {
        res.status(404).json({ error: 'Bundle not found' });
        return;
      }

      let content: Buffer;
      try {
        content = readBundleFile(entry);
      } catch (err) {
        res.status(500).json({ error: 'Bundle file missing from disk', detail: String(err) });
        return;
      }

      const filename = entry.bundle_file ?? entry.file;
      res
        .setHeader('Content-Type', entry.mime_type ?? 'application/zip')
        .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
        .setHeader('X-Design-System-Id', entry.id)
        .setHeader('X-Design-System-Name', entry.name)
        .setHeader('X-Design-System-Version', '1.0.0')
        .send(content);
    },
  );

  // ─── Admin: Publish a New Design System ────────────────────────────────────

  app.post('/admin/publish', requireAdmin, (req, res) => {
    const body = req.body as Partial<PublishRequest>;

    if (!body.id || !body.file || !body.name || !body.price_usd) {
      res.status(400).json({
        error: 'Missing required fields',
        required: ['id', 'file', 'name', 'price_usd'],
      });
      return;
    }

    if (!/^[a-z0-9-]+$/.test(body.id)) {
      res.status(400).json({ error: 'id must be lowercase alphanumeric with hyphens only' });
      return;
    }

    const entry: DesignSystemEntry = {
      id: body.id,
      file: body.file,
      resource_type: 'design_md',
      mime_type: 'text/markdown',
      name: body.name,
      description: body.description ?? '',
      price_usd: body.price_usd,
      tags: body.tags ?? [],
      published_at: new Date().toISOString(),
      active: true,
    };

    appendEntry(entry);

    res.json({
      success: true,
      entry,
      access_url: `${req.protocol}://${req.get('host')}/design-systems/${entry.id}`,
    });
  });

  // ─── Start ──────────────────────────────────────────────────────────────────

  app.listen(PORT, () => {
    const catalog = readCatalog();
    const active = catalog.design_systems.filter(e => e.active);

    console.log('');
    console.log('  Curatoria Service');
    console.log('  ─────────────────────────────────────────────');
    console.log(`  URL:      http://localhost:${PORT}`);
    console.log(`  Network:  ${NETWORK}`);
    console.log(`  Wallet:   ${resolvedWalletAddress}`);
    console.log(`  Designs:  ${active.length} published`);
    console.log('');
    console.log(`  Discovery: http://localhost:${PORT}/.well-known/design-catalog.json`);
    console.log('');
  });
}

startServer().catch((error) => {
  console.error(`ERROR: ${String(error)}`);
  process.exit(1);
});
