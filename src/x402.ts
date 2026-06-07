/**
 * x402.ts — Custom X402 payment middleware
 *
 * Implements the HTTP 402 Payment Required protocol directly against the
 * published spec (https://x402.org) so each design system can carry its own
 * price without being hard-coded at server startup.
 *
 * Flow for a paying client (e.g. an AI agent with a funded wallet):
 *
 *   1. Agent sends GET /design-systems/:id  (no payment header)
 *   2. This middleware intercepts and returns HTTP 402 with a JSON body
 *      describing the price, network, and your wallet address.
 *   3. Agent signs an EIP-712 PaymentPayload and retries with an
 *      X-PAYMENT header containing the base64-encoded signed payload.
 *   4. This middleware decodes the header, calls the facilitator to verify
 *      the signature and settle the USDC transfer on-chain (~2 seconds).
 *   5. On success the request falls through to the route handler which
 *      reads and returns the design.md content.
 *
 * Facilitator: The Coinbase/x402.org hosted service that handles on-chain
 * verification and settlement so you don't need to run a blockchain node.
 * Testnet facilitator at https://x402.org/facilitator is free with no API key.
 */

import { Request, Response, NextFunction } from 'express';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { findEntry } from './catalog';
import {
  PaymentRequired,
  PaymentAccept,
  PaymentPayload,
  VerifyResponse,
  SettleResponse,
  ResourceType,
} from './types';

// ─── USDC contract addresses ──────────────────────────────────────────────────
// EIP-3009 compatible — enables gasless off-chain authorisation signatures.
const USDC_ADDRESSES: Record<string, string> = {
  'base': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  'polygon': '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a USD decimal string to USDC micro-units (6 decimal places). */
function usdToMicro(usd: string): string {
  return String(Math.round(parseFloat(usd) * 1_000_000));
}

/** Build the PaymentRequired descriptor for a given design system entry. */
function buildPaymentRequired(
  id: string,
  name: string,
  description: string,
  tags: string[],
  priceUsd: string,
  resource: string,
  network: string,
  payTo: string,
  mimeType: string,
  isBundle: boolean,
): PaymentRequired {
  const accept: PaymentAccept = {
    scheme: 'exact',
    network,
    maxAmountRequired: usdToMicro(priceUsd),
    resource,
    description: name,
    mimeType,
    payTo,
    maxTimeoutSeconds: 300,
    asset: USDC_ADDRESSES[network] ?? USDC_ADDRESSES['base-sepolia'],
    extra: { name, id },
  };

  return {
    x402Version: 1,
    accepts: [accept],
    error: `Payment of $${priceUsd} USDC required to access "${name}"`,
    extensions: {
      ...declareDiscoveryExtension({
        input: { id },
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Catalog slug for the paid Curatoria resource.',
            },
          },
          required: ['id'],
        },
        output: {
          example: isBundle ? '<zip binary bytes>' : '# paid design markdown\n',
          schema: {
            type: 'string',
            description: isBundle
              ? 'Zip binary content returned after successful x402 settlement.'
              : 'Markdown content returned after successful x402 settlement.',
          },
        },
      }),
      curatoria: {
        id,
        name,
        description,
        tags,
        resourceType: isBundle ? 'bundle_zip' : 'design_md',
      },
    },
  };
}

// ─── Facilitator calls ────────────────────────────────────────────────────────

async function callFacilitator<T>(
  facilitatorUrl: string,
  endpoint: 'verify' | 'settle',
  body: object,
): Promise<T> {
  const url = `${facilitatorUrl}/${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Facilitator ${endpoint} failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<T>;
}

// ─── Middleware factory ───────────────────────────────────────────────────────

export interface X402Config {
  walletAddress: string;
  network: string;
  facilitatorUrl: string;
  expectedResourceType?: ResourceType;
}

/**
 * Returns an Express middleware that guards GET /design-systems/:id with X402.
 *
 * On every incoming request it reads the price from the live registry, so
 * you can publish new design systems (or reprice existing ones) without
 * restarting the server.
 */
export function x402Paywall(config: X402Config) {
  const { walletAddress, network, facilitatorUrl, expectedResourceType } = config;

  return async function x402Middleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const id = req.params.id;

    // Look up the entry — 404 if unknown or inactive
    const entry = findEntry(id);
    if (!entry) {
      res.status(404).json({ error: `Design system "${id}" not found` });
      return;
    }

    const entryResourceType = entry.resource_type ?? 'design_md';
    if (expectedResourceType && entryResourceType !== expectedResourceType) {
      res.status(404).json({ error: `Resource "${id}" not found` });
      return;
    }

    const responseMimeType =
      entry.mime_type ?? (entryResourceType === 'bundle_zip' ? 'application/zip' : 'text/markdown');
    const isBundle = entryResourceType === 'bundle_zip';

    const resource = req.originalUrl;
    const paymentHeader = req.headers['x-payment'] as string | undefined;

    // ── Step 1: No payment header → return 402 with payment details ──────────
    if (!paymentHeader) {
      const paymentRequired = buildPaymentRequired(
        entry.id,
        entry.name,
        entry.description,
        entry.tags,
        entry.price_usd,
        resource,
        network,
        walletAddress,
        responseMimeType,
        isBundle,
      );

      // X-PAYMENT-REQUIRED header carries a base64 encoding of the JSON body.
      // Clients that speak X402 read this header to learn payment parameters.
      // The JSON body is also returned for human-readable debugging.
      res
        .status(402)
        .setHeader(
          'X-PAYMENT-REQUIRED',
          Buffer.from(JSON.stringify(paymentRequired)).toString('base64'),
        )
        .json(paymentRequired);
      return;
    }

    // ── Step 2: Payment header present → verify then settle ──────────────────
    let payload: PaymentPayload;
    try {
      payload = JSON.parse(
        Buffer.from(paymentHeader, 'base64').toString('utf-8'),
      ) as PaymentPayload;
    } catch {
      res.status(402).json({ error: 'X-PAYMENT header is not valid base64 JSON' });
      return;
    }

    const requirements = buildPaymentRequired(
      entry.id,
      entry.name,
      entry.description,
      entry.tags,
      entry.price_usd,
      resource,
      network,
      walletAddress,
      responseMimeType,
      isBundle,
    ).accepts[0];

    // Verify: checks EIP-712 signature, nonce, and time window
    let verifyResult: VerifyResponse;
    try {
      verifyResult = await callFacilitator<VerifyResponse>(
        facilitatorUrl,
        'verify',
        { payload, requirements },
      );
    } catch (err) {
      res.status(402).json({ error: 'Payment verification failed', detail: String(err) });
      return;
    }

    if (!verifyResult.isValid) {
      res.status(402).json({
        error: 'Payment invalid',
        reason: verifyResult.invalidReason ?? 'unknown',
      });
      return;
    }

    // Settle: submits the signed transfer to the blockchain
    let settleResult: SettleResponse;
    try {
      settleResult = await callFacilitator<SettleResponse>(
        facilitatorUrl,
        'settle',
        { payload, requirements },
      );
    } catch (err) {
      res.status(402).json({ error: 'Payment settlement failed', detail: String(err) });
      return;
    }

    if (!settleResult.success) {
      res.status(402).json({ error: 'Payment settlement unsuccessful' });
      return;
    }

    // Attach settlement info to the response headers so the client has a receipt.
    res.setHeader(
      'X-PAYMENT-RESPONSE',
      Buffer.from(JSON.stringify(settleResult)).toString('base64'),
    );

    // Payment confirmed — let the route handler serve the content.
    next();
  };
}
