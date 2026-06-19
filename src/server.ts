/**
 * server.ts — Curatoria service entry point
 *
 * Three route groups:
 *
 *   FREE    /.well-known/design-catalog.json  — full catalog (Track A default)
 *           /design-systems                   — catalog list alias (not :id routes)
 *           /catalog                          — same free listing (alias)
 *           /health                           — uptime check
 *
 *   PAID    /design-systems/:id               — markdown bytes after payment
 *           /packs/:id/download               — zip bundle after payment
 *
 *   OPTIONAL (CATALOG_PAYWALL_ENABLED=1) — Track B: teaser at well-known, paid /catalog
 *
 *   ADMIN   POST /admin/publish               — register a new design system
 *           (requires X-Admin-Key header)
 */

import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'path';

// Load repo-root .env (npm workspaces run dev from apps/curatoria-service).
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import {
  handleFullCatalog,
  handleFullCatalogDiscovery,
  handleTeaserDiscovery,
} from './discovery';
import { findEntry, appendEntry, readCatalog } from './catalog';
import { resolveResource, storageStatus } from './sources';
import {
  checkFacilitatorPreflight,
  isCatalogPaywallEnabled,
  x402CatalogPaywall,
  x402Paywall,
} from './x402';
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

  if (fallbackAddress && isValidAddress(fallbackAddress)) {
    return fallbackAddress;
  }

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
let appPromise: Promise<express.Express> | undefined;

async function buildApp(): Promise<express.Express> {
  const resolvedWalletAddress = await resolveWalletAddress();
  const app = express();

  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://esm.sh'],
          connectSrc: ["'self'", 'https://esm.sh', 'https://ruucm.github.io'],
          workerSrc: ["'self'", 'blob:'],
          styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
          fontSrc: ["'self'", 'https:', 'data:'],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
          upgradeInsecureRequests: [],
        },
      },
    }),
  );
  app.use(
    cors({
      exposedHeaders: [
        'PAYMENT-REQUIRED',
        'PAYMENT-RESPONSE',
        'X-PAYMENT-REQUIRED',
        'X-PAYMENT-RESPONSE',
      ],
    }),
  );
  app.use(express.json());
  app.use(express.static(path.resolve(__dirname, '../public')));

  // ─── Free: Catalog discovery (Track A default) ─────────────────────────────

  if (isCatalogPaywallEnabled()) {
    app.get('/.well-known/design-catalog.json', handleTeaserDiscovery);
    app.get('/design-systems', handleTeaserDiscovery);
    app.get(
      '/catalog',
      x402CatalogPaywall({
        walletAddress: resolvedWalletAddress,
        network: NETWORK,
        facilitatorUrl: FACILITATOR_URL,
      }),
      handleFullCatalog,
    );
  } else {
    app.get('/.well-known/design-catalog.json', handleFullCatalogDiscovery);
    app.get('/design-systems', handleFullCatalogDiscovery);
    app.get('/catalog', handleFullCatalogDiscovery);
  }

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      network: NETWORK,
      wallet: resolvedWalletAddress,
      storage: storageStatus(),
    });
  });

  app.get('/admin/facilitator-preflight', requireAdmin, async (_req, res) => {
    const result = await checkFacilitatorPreflight(FACILITATOR_URL, NETWORK);
    res.status(result.ok ? 200 : 502).json(result);
  });

  // ─── Paid: Design System Content ───────────────────────────────────────────

  // x402Paywall middleware intercepts every GET /design-systems/:id request:
  //   - No PAYMENT-SIGNATURE header → returns HTTP 402 with PAYMENT-REQUIRED
  //   - Valid PAYMENT-SIGNATURE header → verifies + settles, then falls through
  app.get(
    '/design-systems/:id',
    x402Paywall({
      walletAddress: resolvedWalletAddress,
      network: NETWORK,
      facilitatorUrl: FACILITATOR_URL,
      expectedResourceType: 'design_md',
    }),
    async (req, res) => {
      const entry = findEntry(req.params.id);
      if (!entry) {
        // Shouldn't happen (middleware 404s first) but guards the type
        res.status(404).json({ error: 'Design system not found' });
        return;
      }

      let resolved;
      try {
        resolved = await resolveResource(entry);
      } catch (err) {
        // The buyer already paid; surface a server error but never leak the
        // underlying source URL or credentials.
        console.error(`Source resolution failed for "${entry.id}": ${String(err)}`);
        res.status(502).json({ error: 'Could not retrieve product from its storage source' });
        return;
      }

      res
        .setHeader('Cache-Control', 'private, no-store')
        .setHeader('Pragma', 'no-cache')
        .setHeader('Content-Type', `${resolved.mimeType}; charset=utf-8`)
        .setHeader('X-Design-System-Id', entry.id)
        .setHeader('X-Design-System-Name', entry.name)
        .setHeader('X-Design-System-Version', '1.0.0')
        .setHeader('X-Storage-Source', resolved.sourceType)
        .send(resolved.buffer);
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
    async (req, res) => {
      const entry = findEntry(req.params.id);
      if (!entry) {
        res.status(404).json({ error: 'Bundle not found' });
        return;
      }

      let resolved;
      try {
        resolved = await resolveResource(entry);
      } catch (err) {
        console.error(`Source resolution failed for "${entry.id}": ${String(err)}`);
        res.status(502).json({ error: 'Could not retrieve bundle from its storage source' });
        return;
      }

      res
        .setHeader('Cache-Control', 'private, no-store')
        .setHeader('Pragma', 'no-cache')
        .setHeader('Content-Type', resolved.mimeType)
        .setHeader('Content-Disposition', `attachment; filename="${resolved.filename}"`)
        .setHeader('X-Design-System-Id', entry.id)
        .setHeader('X-Design-System-Name', entry.name)
        .setHeader('X-Design-System-Version', '1.0.0')
        .setHeader('X-Storage-Source', resolved.sourceType)
        .send(resolved.buffer);
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

  return app;
}

async function getApp(): Promise<express.Express> {
  if (!appPromise) {
    appPromise = buildApp();
  }
  return appPromise;
}

// Vercel runs each request through this handler instead of a long-lived listener.
export default async function vercelHandler(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const app = await getApp();
  app(req, res);
}

async function startLocalServer(): Promise<void> {
  const app = await getApp();

  app.listen(PORT, () => {
    const catalog = readCatalog();
    const active = catalog.design_systems.filter(e => e.active);

    console.log('');
    console.log('  Curatoria Service');
    console.log('  ─────────────────────────────────────────────');
    console.log(`  URL:      http://localhost:${PORT}`);
    console.log(`  Network:  ${NETWORK}`);
    console.log(`  Designs:  ${active.length} published`);
    console.log('');
    const catalogMode = isCatalogPaywallEnabled() ? 'Track B (teaser + paid /catalog)' : 'Track A (free full catalog)';
    console.log(`  Catalog:   ${catalogMode}`);
    console.log(`  Discovery: http://localhost:${PORT}/.well-known/design-catalog.json`);
    console.log('');
  });
}

if (!process.env.VERCEL) {
  startLocalServer().catch((error) => {
    console.error(`ERROR: ${String(error)}`);
    process.exit(1);
  });
}
