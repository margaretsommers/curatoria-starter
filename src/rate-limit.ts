/**
 * Bounded in-memory fixed-window limiter for local/test and per-instance defense.
 *
 * This is not a distributed rate limiter. On Vercel each instance has its own
 * map. Distributed enforcement is an external WAF gate — do not add Redis or
 * Postgres here.
 */

import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const RATE_LIMIT = {
  purchasePerIpProduct: 30,
  recoverPerIpProduct: 5,
  redeemPerEntitlement: 20,
  redeemPerIp: 60,
  windowMs: 60_000,
  maxKeys: 10_000,
} as const;

export type RateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number, nowMs: number): RateLimitDecision;
}

type WindowEntry = {
  count: number;
  resetAtMs: number;
};

export class InMemoryFixedWindowRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, WindowEntry>();

  get size(): number {
    return this.windows.size;
  }

  consume(key: string, limit: number, windowMs: number, nowMs: number): RateLimitDecision {
    this.pruneExpired(nowMs);
    const windowStart = Math.floor(nowMs / windowMs) * windowMs;
    const resetAtMs = windowStart + windowMs;
    const mapKey = `${key}\0${String(windowStart)}`;
    let entry = this.windows.get(mapKey);
    if (!entry) {
      if (this.windows.size >= RATE_LIMIT.maxKeys) {
        this.evictOldest();
      }
      entry = { count: 0, resetAtMs };
      this.windows.set(mapKey, entry);
    }
    entry.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
    if (entry.count > limit) {
      return { allowed: false, retryAfterSeconds };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private pruneExpired(nowMs: number): void {
    for (const [key, entry] of this.windows) {
      if (entry.resetAtMs <= nowMs) this.windows.delete(key);
    }
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestReset = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.windows) {
      if (entry.resetAtMs < oldestReset) {
        oldestReset = entry.resetAtMs;
        oldestKey = key;
      }
    }
    if (oldestKey) this.windows.delete(oldestKey);
  }
}

export function entitlementFingerprint(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function clientIp(req: Request): string {
  return req.ip?.trim() || req.socket?.remoteAddress || 'unknown';
}

export function purchaseLimitKey(ip: string, productId: string): string {
  return `purchase:${ip}:${productId}`;
}

export function recoverLimitKey(ip: string, productId: string): string {
  return `recover:${ip}:${productId}`;
}

export function redeemEntitlementLimitKey(fingerprint: string): string {
  return `redeem:entitlement:${fingerprint}`;
}

export function redeemIpLimitKey(ip: string): string {
  return `redeem:ip:${ip}`;
}

export function createRateLimitMiddleware(
  limiter: RateLimiter,
  resolveKeys: (req: Request) => Array<{ key: string; limit: number }>,
  clock: () => number,
  windowMs = RATE_LIMIT.windowMs,
) {
  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const nowMs = clock();
    for (const { key, limit } of resolveKeys(req)) {
      const decision = limiter.consume(key, limit, windowMs, nowMs);
      if (!decision.allowed) {
        res.setHeader('Retry-After', String(decision.retryAfterSeconds));
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(429).json({ error: 'Too many requests' });
        return;
      }
    }
    next();
  };
}
