import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { normalizeSha256 } from './content-integrity';
import type { PaymentRequired } from './types';

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const PROCESS_TIMEOUT_MS = 5 * 60 * 1000;

export class WalletPurchasePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletPurchasePreflightError';
  }
}

export type EntitlementPurchase = {
  receipt_id: string;
  product_id: string;
  source_provider: string;
  network: string;
  payer: string;
  entitlement: string;
  redeem_url: string;
  expires_at: string;
  filename: string;
  mime_type: string;
  content_sha256: string;
  content_bytes: number;
};

export type EntitlementPurchaseInput = {
  url: string;
  challenge: PaymentRequired;
  maxAmountAtomic: number;
};

export interface EntitlementPurchaserAdapter {
  purchase(input: EntitlementPurchaseInput): Promise<EntitlementPurchase>;
}

export type ProcessRequest = {
  executable: string;
  args: string[];
  input?: string;
};

export type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type ProcessExecutor = (request: ProcessRequest) => Promise<ProcessResult>;

export function createAwalEntitlementPurchaser(
  executable: string,
  executor: ProcessExecutor = executeIsolatedProcess,
  fetchImpl: typeof fetch = fetch,
): EntitlementPurchaserAdapter {
  assertAbsoluteExecutable(executable, 'Awal');
  return {
    async purchase(input) {
      try {
        validatePurchaseInput(input);
      } catch (error) {
        throw asPreflightError(error);
      }
      const amount = input.challenge.accepts[0].amount;
      let relay;
      try {
        relay = await startFrozenChallengeRelay(input, fetchImpl);
      } catch (error) {
        throw asPreflightError(error);
      }
      try {
        const result = await executor({
          executable,
          args: [
            'x402',
            'pay',
            relay.url,
            '--max-amount',
            amount,
            '--json',
          ],
          input: undefined,
        });
        return parseProcessPurchase(result, 'awal');
      } finally {
        await relay.close();
      }
    },
  };
}

/**
 * Agent Cash (https://agentcash.dev) — `agentcash fetch <url> --max-amount
 * <usd>` — negotiates its own x402 challenge against the URL directly, same
 * shape as awal, so it gets the same frozen-relay treatment: pin it to the
 * challenge we already validated rather than letting it renegotiate a
 * possibly-different one. `executable` must resolve to a real installed
 * binary (whatever the caller points it at); this function does not care
 * how it got there or invoke `npx` itself.
 */
export function createAgentCashEntitlementPurchaser(
  executable: string,
  executor: ProcessExecutor = executeIsolatedProcess,
  fetchImpl: typeof fetch = fetch,
): EntitlementPurchaserAdapter {
  assertAbsoluteExecutable(executable, 'Agent Cash');
  return {
    async purchase(input) {
      try {
        validatePurchaseInput(input);
      } catch (error) {
        throw asPreflightError(error);
      }
      const maxAmountUsd = atomicUsdcToUsdString(input.maxAmountAtomic);
      let relay;
      try {
        relay = await startFrozenChallengeRelay(input, fetchImpl);
      } catch (error) {
        throw asPreflightError(error);
      }
      try {
        const result = await executor({
          executable,
          args: [
            'fetch',
            relay.url,
            '--max-amount',
            maxAmountUsd,
            '--payment-protocol',
            'x402',
          ],
          input: undefined,
        });
        return parseProcessPurchase(result, 'agentcash');
      } finally {
        await relay.close();
      }
    },
  };
}

/** Atomic USDC (6 decimals) to a decimal USD string, e.g. 10_000 -> "0.01". */
function atomicUsdcToUsdString(atomic: number): string {
  if (!Number.isSafeInteger(atomic) || atomic <= 0) {
    throw new Error('Agent Cash max amount must be a positive integer of atomic USDC.');
  }
  const dollars = Math.floor(atomic / 1_000_000);
  const cents = String(atomic % 1_000_000).padStart(6, '0').replace(/0+$/, '') || '0';
  return cents === '0' ? String(dollars) : `${dollars}.${cents}`;
}

async function startFrozenChallengeRelay(
  input: EntitlementPurchaseInput,
  fetchImpl: typeof fetch,
): Promise<{ url: string; close(): Promise<void> }> {
  const frozenBody = JSON.stringify(input.challenge);
  const frozenHeader = Buffer.from(frozenBody, 'utf8').toString('base64url');
  let forwarded = false;
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' || request.url !== '/') {
        response.writeHead(404, { 'Cache-Control': 'no-store' }).end();
        return;
      }
      const signature = singleHeader(request.headers['payment-signature']);
      if (!signature) {
        response.writeHead(402, {
          'Cache-Control': 'private, no-store',
          'Content-Type': 'application/json',
          'PAYMENT-REQUIRED': frozenHeader,
        }).end(frozenBody);
        return;
      }
      if (forwarded) {
        response.writeHead(409, { 'Cache-Control': 'no-store' }).end();
        return;
      }
      forwarded = true;
      const paidResponse = await fetchImpl(input.url, {
        redirect: 'error',
        headers: { 'PAYMENT-SIGNATURE': signature },
      });
      const body = Buffer.from(await paidResponse.arrayBuffer());
      if (body.byteLength > MAX_PROCESS_OUTPUT_BYTES) {
        throw new Error('Paid response exceeded the 1 MiB entitlement limit.');
      }
      response.writeHead(paidResponse.status, {
        'Cache-Control': 'private, no-store',
        'Content-Type': paidResponse.headers.get('content-type') ?? 'application/json',
      }).end(body);
    } catch {
      response.writeHead(502, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
      }).end(JSON.stringify({ error: 'Frozen payment relay failed.' }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      }),
  };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    if (value.length !== 1) return undefined;
    value = value[0];
  }
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes('\0') || Buffer.byteLength(trimmed) > 64 * 1024) {
    return undefined;
  }
  return trimmed;
}

export function createExternalEntitlementPurchaser(
  executable: string,
  args: string[] = [],
  executor: ProcessExecutor = executeIsolatedProcess,
): EntitlementPurchaserAdapter {
  assertAbsoluteExecutable(executable, 'External wallet');
  if (
    args.length > 32 ||
    args.some(arg => arg.includes('\0') || Buffer.byteLength(arg) > 4096)
  ) {
    throw new Error('External wallet arguments exceed safe process limits.');
  }
  return {
    async purchase(input) {
      try {
        validatePurchaseInput(input);
      } catch (error) {
        throw asPreflightError(error);
      }
      const result = await executor({
        executable,
        args: [...args],
        input: JSON.stringify({
          operation: 'purchase_entitlement',
          url: input.url,
          max_amount_atomic: input.maxAmountAtomic,
          payment_required: input.challenge,
        }),
      });
      return parseProcessPurchase(result, 'external wallet bridge');
    },
  };
}

export async function executeIsolatedProcess(
  request: ProcessRequest,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.executable, request.args, {
      cwd: os.tmpdir(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        USER: process.env.USER ?? '',
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(error);
    };
    const append = (
      chunks: Buffer[],
      currentBytes: number,
      chunk: Buffer,
      stream: string,
    ): number => {
      const nextBytes = currentBytes + chunk.byteLength;
      if (nextBytes > MAX_PROCESS_OUTPUT_BYTES) {
        finishError(new Error(`${stream} exceeded the 1 MiB wallet bridge limit.`));
        return currentBytes;
      }
      chunks.push(chunk);
      return nextBytes;
    };
    child.stdout.on('data', chunk => {
      stdoutBytes = append(stdoutChunks, stdoutBytes, Buffer.from(chunk), 'stdout');
    });
    child.stderr.on('data', chunk => {
      stderrBytes = append(stderrChunks, stderrBytes, Buffer.from(chunk), 'stderr');
    });
    child.on('error', finishError);
    child.on('close', exitCode => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
        stderr: Buffer.concat(stderrChunks, stderrBytes).toString('utf8'),
        exitCode,
      });
    });
    const timer = setTimeout(
      () => finishError(new Error('Wallet approval timed out after 5 minutes.')),
      PROCESS_TIMEOUT_MS,
    );
    if (request.input) child.stdin.end(request.input);
    else child.stdin.end();
  });
}

function validatePurchaseInput(input: EntitlementPurchaseInput): void {
  const accept = input.challenge.accepts?.[0];
  if (!accept) throw new Error('Payment challenge has no accepted payment option.');
  if (input.challenge.x402Version !== 2) {
    throw new Error('Payment challenge must use x402 version 2.');
  }
  if (input.challenge.accepts.length !== 1 || accept.scheme !== 'exact') {
    throw new Error('Wallet purchase requires exactly one exact payment option.');
  }
  if (!Number.isSafeInteger(input.maxAmountAtomic) || input.maxAmountAtomic <= 0) {
    throw new Error('Wallet maximum amount must be a positive integer.');
  }
  if (!/^\d+$/.test(accept.amount) || BigInt(accept.amount) > BigInt(input.maxAmountAtomic)) {
    throw new Error('Payment challenge exceeds the approved wallet maximum.');
  }
  if (
    input.challenge.resource?.url &&
    normalizeUrl(input.challenge.resource.url) !== normalizeUrl(input.url)
  ) {
    throw new Error('Payment challenge resource does not match the purchase URL.');
  }
  const url = new URL(input.url);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Wallet purchase URL must be credential-free HTTPS.');
  }
  if ((input.challenge.resource?.mimeType ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new Error('Wallet purchase challenge must describe an application/json response.');
  }
  if (!/^eip155:(8453|84532)$/.test(accept.network)) {
    throw new Error('Wallet purchase challenge must use Base or Base Sepolia.');
  }
  if (!/^0x[0-9a-f]{40}$/i.test(accept.payTo) || !/^0x[0-9a-f]{40}$/i.test(accept.asset)) {
    throw new Error('Wallet purchase challenge contains an invalid payee or asset.');
  }
  if (
    !Number.isSafeInteger(Number(accept.maxTimeoutSeconds)) ||
    Number(accept.maxTimeoutSeconds) <= 0 ||
    Number(accept.maxTimeoutSeconds) > 300
  ) {
    throw new Error('Wallet purchase challenge timeout is outside the supported limit.');
  }
}

function parseProcessPurchase(result: ProcessResult, source: string): EntitlementPurchase {
  if (result.exitCode !== 0) {
    throw new Error(
      `${source} failed with exit ${String(result.exitCode)}: ${redactStderr(result.stderr)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${source} did not return JSON entitlement metadata.`);
  }
  const candidate =
    isRecord(parsed) && isRecord(parsed.data) ? parsed.data : parsed;
  if (!isRecord(candidate)) {
    throw new Error(`${source} did not return entitlement JSON.`);
  }
  const contentSha256 = normalizeSha256(candidate.content_sha256);
  if (
    typeof candidate.receipt_id !== 'string' ||
    !/^rcpt_[A-Za-z0-9_-]{32,}$/.test(candidate.receipt_id) ||
    typeof candidate.product_id !== 'string' ||
    typeof candidate.source_provider !== 'string' ||
    !/^(local|url|gdrive|dropbox)$/.test(candidate.source_provider) ||
    typeof candidate.network !== 'string' ||
    !/^eip155:\d+$/.test(candidate.network) ||
    typeof candidate.payer !== 'string' ||
    !/^0x[0-9a-f]{40}$/i.test(candidate.payer) ||
    typeof candidate.entitlement !== 'string' ||
    typeof candidate.redeem_url !== 'string' ||
    typeof candidate.expires_at !== 'string' ||
    typeof candidate.filename !== 'string' ||
    typeof candidate.mime_type !== 'string' ||
    !contentSha256 ||
    !Number.isSafeInteger(candidate.content_bytes) ||
    Number(candidate.content_bytes) <= 0
  ) {
    throw new Error(`${source} did not return complete entitlement JSON.`);
  }
  return {
    receipt_id: candidate.receipt_id,
    product_id: candidate.product_id,
    source_provider: candidate.source_provider,
    network: candidate.network,
    payer: candidate.payer,
    entitlement: candidate.entitlement,
    redeem_url: candidate.redeem_url,
    expires_at: candidate.expires_at,
    filename: candidate.filename,
    mime_type: candidate.mime_type,
    content_sha256: contentSha256,
    content_bytes: Number(candidate.content_bytes),
  };
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactStderr(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(signature|entitlement|token)=\S+/gi, '$1=[redacted]')
    .slice(0, 500);
}

function assertAbsoluteExecutable(executable: string, label: string): void {
  if (!path.isAbsolute(executable) || executable.includes('\0')) {
    throw new Error(`${label} executable must be an absolute path to a preinstalled binary.`);
  }
}

function asPreflightError(error: unknown): WalletPurchasePreflightError {
  if (error instanceof WalletPurchasePreflightError) return error;
  return new WalletPurchasePreflightError(
    error instanceof Error ? error.message : String(error),
  );
}
