/**
 * sources.ts — storage connectors for sellable product bytes.
 *
 * A registry entry can live in one of four places:
 *
 *   local  — a file inside design-systems/ (the original behavior, still the default)
 *   url    — a direct https:// URL you control (your domain, a CDN, object storage)
 *   gdrive  — a Google Drive file shared as "Anyone with the link can view"
 *   dropbox — a Dropbox file shared by link (Mode A) or private path via OAuth (Mode B)
 *
 * Catalog metadata (price, name, tags) always lives in design-systems/.registry.json.
 * For url, gdrive, and dropbox sources only the *bytes* are remote — they are fetched on demand
 * after a successful x402 payment, never cached to disk, and never exposed before
 * payment because resolution only happens inside the paid route handler.
 *
 * Security posture for remote fetches:
 *   - url connector: https only, with a basic SSRF guard that blocks localhost,
 *     loopback, link-local, and RFC-1918 private addresses.
 *   - gdrive connector: locked to Google-owned hosts.
 *   - all remote fetches: hard timeout + response size ceiling.
 *   - redirects: manual follow with a hop limit, DNS/host revalidation per hop,
 *     and Authorization/Cookie stripped when the next hop crosses origins.
 */

import fs from 'fs';
import path from 'path';
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import { DesignSystemEntry, EntrySource, ResourceType, StorageSourceType } from './types';
import { resolveDesignSystemPath } from './paths';

/** Abort a remote source fetch that takes longer than this. */
const FETCH_TIMEOUT_MS = parseInt(process.env.STORAGE_FETCH_TIMEOUT_MS ?? '15000', 10);

/** Reject remote sources larger than this (default 50 MB). */
const MAX_REMOTE_BYTES = parseInt(
  process.env.STORAGE_MAX_BYTES ?? String(50 * 1024 * 1024),
  10,
);

const GOOGLE_API_KEY = (process.env.GOOGLE_API_KEY ?? '').trim();

const GOOGLE_HOSTS = new Set([
  'www.googleapis.com',
  'drive.google.com',
  'drive.usercontent.google.com',
  'docs.google.com',
]);

/** Hosts accepted when a publisher pastes a Drive share/download URL. */
const GOOGLE_DRIVE_SHARE_HOSTS = new Set([
  'drive.google.com',
  'docs.google.com',
  'drive.usercontent.google.com',
]);

const GOOGLE_WORKSPACE_PATH_SEGMENTS = new Set([
  'document',
  'spreadsheets',
  'presentation',
  'forms',
  'drawings',
]);

export const DROPBOX_HOSTS = new Set([
  'www.dropbox.com',
  'dl.dropboxusercontent.com',
  'content.dropboxapi.com',
]);

/**
 * Dropbox's own redirect for a file-share link lands on a per-file,
 * randomized subdomain of dl.dropboxusercontent.com (observed 2026-09-04,
 * e.g. `ucb8fd170dee70a30b19134b7f54.dl.dropboxusercontent.com`), not the
 * bare host. Exact `DROPBOX_HOSTS` membership stays for intake-time
 * validation of a user-supplied share URL (parseDropboxShareUrl); this
 * checks where Dropbox's own redirect actually lands.
 */
function isAllowedDropboxRedirectHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return DROPBOX_HOSTS.has(host) || host.endsWith('.dl.dropboxusercontent.com');
}

const DROPBOX_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

interface DropboxTokenCache {
  accessToken: string;
  expiresAtMs: number;
}

let dropboxTokenCache: DropboxTokenCache | undefined;

/** Test-only hook to reset module token cache between cases. */
export function resetDropboxTokenCacheForTests(): void {
  dropboxTokenCache = undefined;
}

export interface ResolvedResource {
  /** Raw bytes to send to the paying client. */
  buffer: Buffer;
  /** Content-Type to advertise (entry override wins, then remote, then default). */
  mimeType: string;
  /** Suggested filename for Content-Disposition on downloads. */
  filename: string;
  /** Which connector served the bytes. */
  sourceType: StorageSourceType;
}

export interface ResolvedResourceStream {
  stream: Readable;
  mimeType: string;
  filename: string;
  sourceType: StorageSourceType;
}

export type SourceResolutionOptions = {
  fetchImpl?: typeof fetch;
  lookup?: DnsLookup;
  requestImpl?: RemoteRequest;
  maxBytes?: number;
  timeoutMs?: number;
  /** Extra request headers for the first hop. Cross-origin redirects drop secrets. */
  headers?: RequestInit['headers'];
};

export type DnsLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export type ConnectionBinding = {
  hostname: string;
  address: string;
  family: number;
};

export type RemoteRequest = (
  url: string | URL,
  init: RequestInit,
  binding: ConnectionBinding,
) => Promise<Response>;

const NATIVE_FETCH = globalThis.fetch;

const DEFAULT_REMOTE_FETCH_HEADERS = {
  Accept: 'application/octet-stream,*/*;q=0.8',
  'Accept-Encoding': 'identity',
} as const;

/** Request headers that must not follow a cross-origin redirect. */
const SENSITIVE_REDIRECT_HEADERS = [
  'authorization',
  'cookie',
  'cookie2',
  'proxy-authorization',
] as const;

function requestOrigin(rawUrl: string): string {
  const url = new URL(rawUrl);
  const port =
    url.port ||
    (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');
  return `${url.protocol}//${url.hostname.toLowerCase()}:${port}`;
}

function initialRemoteHeaders(extra?: RequestInit['headers']): Headers {
  const headers = new Headers(DEFAULT_REMOTE_FETCH_HEADERS);
  if (extra) {
    new Headers(extra).forEach((value, name) => {
      headers.set(name, value);
    });
  }
  return headers;
}

/**
 * Copy request headers onto the next redirect hop.
 * Same-origin hops keep Authorization/Cookie; a different origin drops them.
 */
export function headersAfterRedirect(
  fromUrl: string,
  toUrl: string,
  headers: RequestInit['headers'],
): Headers {
  const next = new Headers(headers);
  if (requestOrigin(fromUrl) === requestOrigin(toUrl)) {
    return next;
  }
  for (const name of SENSITIVE_REDIRECT_HEADERS) {
    next.delete(name);
  }
  return next;
}

// ─── Source resolution helpers ──────────────────────────────────────────────

/** The effective source for an entry; entries with no `source` are local. */
export function entrySourceType(entry: DesignSystemEntry): StorageSourceType {
  return entry.source?.type ?? 'local';
}

function defaultMimeFor(kind: ResourceType): string {
  if (kind === 'bundle_zip') return 'application/zip';
  if (kind === 'binary_asset') return 'application/octet-stream';
  return 'text/markdown';
}

function basenameFromUrl(rawUrl: string, fallback: string): string {
  try {
    const parsed = new URL(rawUrl);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return last && last.length > 0 ? decodeURIComponent(last) : fallback;
  } catch {
    return fallback;
  }
}

function resolveLocalSourcePath(localName: string): string {
  if (!localName) {
    throw new Error('Local source file cannot be empty.');
  }
  return resolveDesignSystemPath(localName);
}

function isHtmlContentType(contentType?: string): boolean {
  return (contentType ?? '').toLowerCase().split(';', 1)[0].trim() === 'text/html';
}

function looksLikeHtml(buffer: Buffer): boolean {
  const prefix = buffer.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  return (
    prefix.startsWith('<!doctype') ||
    prefix.startsWith('<html') ||
    prefix.startsWith('<head') ||
    prefix.startsWith('<body')
  );
}

function assertRawFileResponse(
  buffer: Buffer,
  contentType: string | undefined,
  contentEncoding: string | undefined,
  context: string,
): void {
  if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
    throw new Error(
      `${context} responded with content-encoding "${contentEncoding}", so original bytes cannot be verified.`,
    );
  }

  if (isHtmlContentType(contentType) || looksLikeHtml(buffer)) {
    throw new Error(
      `${context} returned an HTML page, not the file bytes. Check sharing permissions and use a raw download URL.`,
    );
  }
}

// ─── SSRF guard for the url connector ─────────────────────────────────────────

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, octet) => (value * 256 + Number(octet)) >>> 0, 0);
}

function ipv4InCidr(address: string, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

function ipv6Bytes(address: string): Buffer | undefined {
  let normalized = address.toLowerCase();
  const dotted = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    if (!net.isIPv4(dotted)) return undefined;
    const value = ipv4Number(dotted);
    normalized = normalized.slice(0, -dotted.length) +
      `${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const words = [...left, ...Array(missing).fill('0'), ...right];
  if (words.length !== 8 || words.some(word => !/^[a-f0-9]{1,4}$/.test(word))) return undefined;
  const result = Buffer.alloc(16);
  words.forEach((word, index) => result.writeUInt16BE(parseInt(word, 16), index * 2));
  return result;
}

function ipv6InCidr(bytes: Buffer, base: string, prefix: number): boolean {
  const baseBytes = ipv6Bytes(base);
  if (!baseBytes) return false;
  const fullBytes = Math.floor(prefix / 8);
  const remaining = prefix % 8;
  if (!bytes.subarray(0, fullBytes).equals(baseBytes.subarray(0, fullBytes))) return false;
  if (remaining === 0) return true;
  const mask = 0xff << (8 - remaining);
  return (bytes[fullBytes] & mask) === (baseBytes[fullBytes] & mask);
}

function isNonPublicIp(address: string): boolean {
  if (net.isIPv4(address)) {
    if (
      address === '192.0.0.9' ||
      address === '192.0.0.10' ||
      address === '192.88.99.2'
    ) {
      return false;
    }
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.88.99.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, prefix]) => ipv4InCidr(address, String(base), Number(prefix)));
  }
  if (net.isIPv6(address)) {
    const bytes = ipv6Bytes(address);
    if (!bytes) return true;
    if (ipv6InCidr(bytes, '::ffff:0:0', 96)) {
      return isNonPublicIp(
        `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`,
      );
    }
    if (ipv6InCidr(bytes, '::ffff:0:0:0', 96)) {
      return isNonPublicIp(
        `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`,
      );
    }
    if (ipv6InCidr(bytes, '64:ff9b::', 96)) {
      return isNonPublicIp(
        `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`,
      );
    }
    const globallyReachable2001Exceptions = [
      ['2001:1::1', 128],
      ['2001:1::2', 128],
      ['2001:1::3', 128],
      ['2001:3::', 32],
      ['2001:4:112::', 48],
      ['2001:30::', 28],
    ] as const;
    if (
      globallyReachable2001Exceptions.some(([base, prefix]) =>
        ipv6InCidr(bytes, base, prefix))
    ) {
      return false;
    }
    return [
      ['::', 128],
      ['::1', 128],
      ['::', 96],
      ['64:ff9b:1::', 48],
      ['100::', 64],
      ['2001::', 23],
      ['2001:db8::', 32],
      ['2002::', 16],
      ['3ffe::', 16],
      ['3fff::', 20],
      ['5f00::', 16],
      ['fc00::', 7],
      ['fe80::', 10],
      ['ff00::', 8],
    ].some(([base, prefix]) => ipv6InCidr(bytes, String(base), Number(prefix)));
  }
  return true;
}

function assertSafeRemoteUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid source URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Only https:// source URLs are allowed (got ${parsed.protocol}).`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Source URLs cannot contain credentials.');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '[::1]' ||
    (net.isIP(host) !== 0 && isNonPublicIp(host))
  ) {
    throw new Error(`Refusing to fetch from non-public host: ${host}`);
  }
  return parsed;
}

async function assertPublicDns(
  rawUrl: string,
  lookup: DnsLookup,
): Promise<ConnectionBinding> {
  const hostname = new URL(rawUrl).hostname;
  if (net.isIP(hostname)) {
    if (isNonPublicIp(hostname)) {
      throw new Error(`Refusing to fetch from non-public address: ${hostname}`);
    }
    return { hostname, address: hostname, family: net.isIP(hostname) };
  }
  const records = await lookup(hostname);
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`Source host ${hostname} did not resolve to an address.`);
  }
  for (const record of records) {
    if (
      (record.family !== 4 && record.family !== 6) ||
      net.isIP(record.address) !== record.family ||
      isNonPublicIp(record.address)
    ) {
      throw new Error(`Source host ${hostname} resolved to a non-public address.`);
    }
  }
  const selected = records[0];
  return {
    hostname,
    address: selected.address,
    family: selected.family,
  };
}

async function pinnedHttpsRequest(
  rawUrl: string | URL,
  init: RequestInit,
  binding: ConnectionBinding,
): Promise<Response> {
  const url = new URL(rawUrl);
  if (url.hostname !== binding.hostname) {
    throw new Error('Pinned connection hostname does not match the request URL.');
  }
  return new Promise<Response>((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const request = https.request(
      url,
      {
        method: init.method ?? 'GET',
        headers,
        signal: init.signal ?? undefined,
        servername: binding.hostname,
        lookup: (_hostname, options, callback) => {
          const pinnedAddress = {
            address: binding.address,
            family: binding.family as 4 | 6,
          };
          if (options.all) {
            callback(null, [pinnedAddress]);
            return;
          }
          callback(null, pinnedAddress.address, pinnedAddress.family);
        },
      },
      incoming => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        }
        resolve(
          new Response(Readable.toWeb(incoming) as ReadableStream, {
            status: incoming.statusCode ?? 500,
            statusText: incoming.statusMessage,
            headers: responseHeaders,
          }),
        );
      },
    );
    request.on('error', reject);
    if (typeof init.body === 'string' || init.body instanceof URLSearchParams) {
      request.end(init.body.toString());
    } else if (init.body == null) {
      request.end();
    } else {
      request.destroy(new Error('Unsupported body type for pinned source request.'));
    }
  });
}

// ─── Remote fetch with timeout + size ceiling ─────────────────────────────────

async function fetchRemoteBytes(
  url: string,
  context: string,
  validateUrl: (value: string) => void,
  options: Required<Pick<SourceResolutionOptions, 'requestImpl' | 'lookup' | 'maxBytes'>> &
    Pick<SourceResolutionOptions, 'headers'>,
): Promise<{ buffer: Buffer; contentType?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let current = url;
    let res: Response | undefined;
    let requestHeaders = initialRemoteHeaders(options.headers);
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      validateUrl(current);
      const binding = await assertPublicDns(current, options.lookup);
      res = await options.requestImpl(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: requestHeaders,
      }, binding);
      if (res.status < 300 || res.status >= 400) break;
      const location = res.headers.get('location');
      if (!location) throw new Error(`${context} redirect omitted Location.`);
      const next = new URL(location, current).toString();
      requestHeaders = headersAfterRedirect(current, next, requestHeaders);
      current = next;
      res = undefined;
    }
    if (!res) throw new Error(`${context} exceeded 5 redirects.`);
    if (!res.ok) {
      throw new Error(`${context} responded ${res.status} ${res.statusText}`);
    }

    const declaredLength = Number(res.headers.get('content-length') ?? '0');
    if (declaredLength && declaredLength > options.maxBytes) {
      throw new Error(
        `${context} is ${declaredLength} bytes, over the ${options.maxBytes}-byte limit.`,
      );
    }

    const buffer = await readResponseWithLimit(res, options.maxBytes, context, controller);
    const contentType = res.headers.get('content-type') ?? undefined;
    const contentEncoding = res.headers.get('content-encoding') ?? undefined;
    assertRawFileResponse(buffer, contentType, contentEncoding, context);

    return { buffer, contentType };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`${context} timed out after ${FETCH_TIMEOUT_MS}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseWithLimit(
  response: Response,
  maxBytes: number,
  context: string,
  controller: AbortController,
): Promise<Buffer> {
  if (!response.body) throw new Error(`${context} returned no response body.`);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      controller.abort();
      throw new Error(`${context} exceeded the ${maxBytes}-byte limit while streaming.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

function streamedResponseBody(
  response: Response,
  input: {
    context: string;
    controller: AbortController;
    timer: NodeJS.Timeout;
    maxBytes: number;
    expectedBytes?: number;
  },
): Readable {
  if (!response.body) {
    clearTimeout(input.timer);
    input.controller.abort();
    throw new Error(`${input.context} returned no response body.`);
  }
  const source = Readable.fromWeb(response.body as never);
  const iterator = async function* (): AsyncGenerator<Buffer> {
    let bytes = 0;
    let inspected = false;
    let prefix = Buffer.alloc(0);
    try {
      for await (const value of source) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        bytes += chunk.byteLength;
        if (bytes > input.maxBytes) {
          throw new Error(
            `${input.context} exceeded the ${input.maxBytes}-byte limit while streaming.`,
          );
        }
        if (!inspected) {
          const needed = 512 - prefix.byteLength;
          prefix = Buffer.concat([prefix, chunk.subarray(0, needed)]);
          if (prefix.byteLength === 512) {
            if (looksLikeHtml(prefix)) {
              throw new Error(
                `${input.context} returned an HTML page, not the file bytes. Check sharing permissions and use a raw download URL.`,
              );
            }
            inspected = true;
          }
        }
        yield chunk;
      }
      if (!inspected && looksLikeHtml(prefix)) {
        throw new Error(
          `${input.context} returned an HTML page, not the file bytes. Check sharing permissions and use a raw download URL.`,
        );
      }
      if (input.expectedBytes !== undefined && bytes !== input.expectedBytes) {
        throw new Error(
          `${input.context} ended after ${bytes} bytes; expected ${input.expectedBytes} bytes.`,
        );
      }
    } catch (error) {
      if (input.controller.signal.aborted && error instanceof Error && error.name === 'AbortError') {
        throw new Error(`${input.context} timed out while streaming.`);
      }
      throw error;
    } finally {
      clearTimeout(input.timer);
      input.controller.abort();
      source.destroy();
    }
  };
  return Readable.from(iterator());
}

async function fetchRemoteStream(
  url: string,
  context: string,
  validateUrl: (value: string) => void,
  options: Required<
    Pick<SourceResolutionOptions, 'requestImpl' | 'lookup' | 'maxBytes' | 'timeoutMs'>
  > &
    Pick<SourceResolutionOptions, 'headers'>,
): Promise<{ stream: Readable; contentType?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    let current = url;
    let response: Response | undefined;
    let requestHeaders = initialRemoteHeaders(options.headers);
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      validateUrl(current);
      const binding = await assertPublicDns(current, options.lookup);
      response = await options.requestImpl(
        current,
        {
          redirect: 'manual',
          signal: controller.signal,
          headers: requestHeaders,
        },
        binding,
      );
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error(`${context} redirect omitted Location.`);
      const next = new URL(location, current).toString();
      requestHeaders = headersAfterRedirect(current, next, requestHeaders);
      current = next;
      response = undefined;
    }
    if (!response) throw new Error(`${context} exceeded 5 redirects.`);
    if (!response.ok) throw new Error(`${context} responded ${response.status} ${response.statusText}`);

    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength && declaredLength > options.maxBytes) {
      throw new Error(
        `${context} is ${declaredLength} bytes, over the ${options.maxBytes}-byte limit.`,
      );
    }
    const contentType = response.headers.get('content-type') ?? undefined;
    const contentEncoding = response.headers.get('content-encoding') ?? undefined;
    if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
      throw new Error(
        `${context} responded with content-encoding "${contentEncoding}", so original bytes cannot be verified.`,
      );
    }
    if (isHtmlContentType(contentType)) {
      throw new Error(
        `${context} returned an HTML page, not the file bytes. Check sharing permissions and use a raw download URL.`,
      );
    }
    return {
      stream: streamedResponseBody(response, {
        context,
        controller,
        timer,
        maxBytes: options.maxBytes,
        expectedBytes: declaredLength || undefined,
      }),
      contentType,
    };
  } catch (error) {
    clearTimeout(timer);
    controller.abort();
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${context} timed out after ${options.timeoutMs}ms.`);
    }
    throw error;
  }
}

function googleDriveUrl(fileId: string): string {
  if (GOOGLE_API_KEY) {
    // Authenticated Drive API path: reliable for any file shared with the key's
    // project, including large files, and returns the raw bytes via alt=media.
    return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId,
    )}?alt=media&key=${encodeURIComponent(GOOGLE_API_KEY)}`;
  }
  // Keyless fallback: works for files shared "Anyone with the link can view".
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(
    fileId,
  )}&export=download`;
}

function isDropboxFileSharePath(pathname: string): boolean {
  return (
    pathname === '/s' ||
    pathname.startsWith('/s/') ||
    pathname === '/scl/fi' ||
    pathname.startsWith('/scl/fi/')
  );
}

function assertNoUrlUserinfo(parsed: URL, message: string): void {
  if (parsed.username || parsed.password) {
    throw new Error(message);
  }
}

/**
 * Parse + validate a Dropbox URL for Mode A link-share access.
 * Accepts only file-share paths (`/s/`, `/scl/fi/`) on dropbox.com and
 * dl.dropboxusercontent.com raw file links with those same paths.
 * Rejects embedded credentials (userinfo), Transfer (`/t/`), folders
 * (`/scl/fo/`, `/sh/`), Paper, and unknown `/scl/` prefixes. Errors never
 * echo the input URL, username, or password.
 */
export function parseDropboxShareUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error('Invalid Dropbox URL. Use a file share link (/scl/fi/ or /s/).');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Only https:// Dropbox URLs are allowed.');
  }

  assertNoUrlUserinfo(
    parsed,
    'Dropbox URLs cannot contain credentials. Use a file share link (/scl/fi/ or /s/) without a username or password.',
  );

  const host = parsed.hostname.toLowerCase();
  if (host === 'paper.dropbox.com') {
    throw new Error(
      'Dropbox Paper links are not supported. Use a Dropbox file share link (/scl/fi/ or /s/), not Paper.',
    );
  }
  if (!DROPBOX_HOSTS.has(host)) {
    throw new Error('Unexpected Dropbox host. Use a www.dropbox.com file share link.');
  }

  const pathname = parsed.pathname.toLowerCase();
  if (pathname === '/t' || pathname.startsWith('/t/')) {
    throw new Error(
      'Dropbox Transfer links (/t/) are not supported. Use a Dropbox share link (/scl/fi/ or /s/), not Transfer.',
    );
  }

  if (pathname === '/scl/fo' || pathname.startsWith('/scl/fo/')) {
    throw new Error(
      'Dropbox folder links (/scl/fo/) are not supported. Use a Dropbox file share link (/scl/fi/ or /s/), not a folder.',
    );
  }

  if (pathname === '/sh' || pathname.startsWith('/sh/')) {
    throw new Error(
      'Dropbox folder links (/sh/) are not supported. Use a Dropbox file share link (/scl/fi/ or /s/), not a folder.',
    );
  }

  if (pathname === '/paper' || pathname.startsWith('/paper/')) {
    throw new Error(
      'Dropbox Paper links are not supported. Use a Dropbox file share link (/scl/fi/ or /s/), not Paper.',
    );
  }

  if (isDropboxFileSharePath(pathname)) {
    return parsed;
  }

  if (pathname === '/scl' || pathname.startsWith('/scl/')) {
    throw new Error(
      'Dropbox links with this /scl/ path are not supported. Use a Dropbox file share link (/scl/fi/ or /s/).',
    );
  }

  throw new Error('Unsupported Dropbox URL. Use a file share link (/scl/fi/ or /s/).');
}

/** Force Dropbox share links to the raw download variant. */
export function rewriteDropboxShareUrl(input: string): string {
  const parsed = parseDropboxShareUrl(input);
  const host = parsed.hostname.toLowerCase();

  // Force raw download for regular share links.
  if (host === 'www.dropbox.com') {
    parsed.searchParams.set('dl', '1');
  }

  return parsed.toString();
}

function parseDropboxPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Dropbox path cannot be empty.');
  }
  if (!trimmed.startsWith('/')) {
    throw new Error(`Dropbox path must start with "/" (got "${trimmed}").`);
  }
  return trimmed;
}

function hasDropboxOauthConfig(): boolean {
  const { appKey, appSecret, refreshToken } = getDropboxOauthEnv();
  return Boolean(appKey && appSecret && refreshToken);
}

function getDropboxOauthEnv(): {
  appKey: string;
  appSecret: string;
  refreshToken: string;
} {
  return {
    appKey: (process.env.DROPBOX_APP_KEY ?? '').trim(),
    appSecret: (process.env.DROPBOX_APP_SECRET ?? '').trim(),
    refreshToken: (process.env.DROPBOX_REFRESH_TOKEN ?? '').trim(),
  };
}

type RemoteRequestOptions = Required<
  Pick<SourceResolutionOptions, 'requestImpl' | 'lookup' | 'maxBytes'>
>;

async function refreshDropboxAccessToken(
  options: RemoteRequestOptions,
): Promise<string> {
  if (!hasDropboxOauthConfig()) {
    throw new Error(
      'Dropbox OAuth is not configured. Set DROPBOX_APP_KEY, DROPBOX_APP_SECRET, and DROPBOX_REFRESH_TOKEN.',
    );
  }

  const env = getDropboxOauthEnv();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: env.refreshToken,
    client_id: env.appKey,
    client_secret: env.appSecret,
  });

  const tokenUrl = 'https://api.dropboxapi.com/oauth2/token';
  const binding = await assertPublicDns(tokenUrl, options.lookup);
  const res = await options.requestImpl(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }, binding);

  if (!res.ok) {
    throw new Error(`Dropbox token refresh failed: ${res.status} ${res.statusText}`);
  }

  const payload = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!payload.access_token || !payload.expires_in) {
    throw new Error('Dropbox token refresh response was missing access_token or expires_in.');
  }

  dropboxTokenCache = {
    accessToken: payload.access_token,
    expiresAtMs: Date.now() + payload.expires_in * 1000,
  };
  return payload.access_token;
}

async function getDropboxAccessToken(options: RemoteRequestOptions): Promise<string> {
  if (
    dropboxTokenCache &&
    Date.now() < dropboxTokenCache.expiresAtMs - DROPBOX_TOKEN_REFRESH_SKEW_MS
  ) {
    return dropboxTokenCache.accessToken;
  }
  return refreshDropboxAccessToken(options);
}

async function fetchDropboxPathBytes(
  dropboxPath: string,
  options: RemoteRequestOptions,
): Promise<{ buffer: Buffer; contentType?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const downloadUrl = 'https://content.dropboxapi.com/2/files/download';
  const binding = await assertPublicDns(downloadUrl, options.lookup);
  const request = async (token: string): Promise<Response> =>
    options.requestImpl(downloadUrl, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/octet-stream,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath }),
      },
    }, binding);
  try {
    let res = await request(await getDropboxAccessToken(options));
    if (res.status === 401) {
      // Retry once with a fresh token in case our cache expired early.
      dropboxTokenCache = undefined;
      res = await request(await refreshDropboxAccessToken(options));
    }
    if (!res.ok) {
      throw new Error(`Dropbox source responded ${res.status} ${res.statusText}`);
    }

    const declaredLength = Number(res.headers.get('content-length') ?? '0');
    if (declaredLength && declaredLength > options.maxBytes) {
      throw new Error(
        `Dropbox source is ${declaredLength} bytes, over the ${options.maxBytes}-byte limit.`,
      );
    }

    const buffer = await readResponseWithLimit(
      res,
      options.maxBytes,
      'Dropbox source',
      controller,
    );
    const contentType = res.headers.get('content-type') ?? undefined;
    const contentEncoding = res.headers.get('content-encoding') ?? undefined;
    assertRawFileResponse(buffer, contentType, contentEncoding, 'Dropbox source');

    return { buffer, contentType };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Dropbox source timed out after ${FETCH_TIMEOUT_MS}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Opens a bounded source stream without materializing the complete response.
 * The remote abort timer remains active until the returned stream is consumed
 * or destroyed.
 */
export async function resolveResourceStream(
  entry: DesignSystemEntry,
  options: SourceResolutionOptions = {},
): Promise<ResolvedResourceStream> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const useInjectedFetch = Boolean(options.fetchImpl) || fetchImpl !== NATIVE_FETCH;
  const resolutionOptions = {
    requestImpl:
      options.requestImpl ??
      (useInjectedFetch
        ? ((url: string | URL, init: RequestInit) => fetchImpl(url, init))
        : pinnedHttpsRequest),
    lookup:
      options.lookup ??
      ((hostname: string) => dns.lookup(hostname, { all: true, verbatim: true })),
    maxBytes: options.maxBytes ?? MAX_REMOTE_BYTES,
    timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
    headers: options.headers,
  };
  const kind: ResourceType = entry.resource_type ?? 'design_md';
  const sourceType = entrySourceType(entry);
  const source = entry.source;
  const fallbackName =
    entry.file ||
    `${entry.id}.${kind === 'bundle_zip' ? 'zip' : kind === 'binary_asset' ? 'bin' : 'md'}`;

  if (sourceType === 'local') {
    const localName = entry.bundle_file ?? entry.file;
    const filePath = resolveLocalSourcePath(localName);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Local source file not found on disk: ${localName}`);
    }
    return {
      stream: fs.createReadStream(filePath),
      mimeType: entry.mime_type ?? defaultMimeFor(kind),
      filename: path.basename(localName),
      sourceType,
    };
  }

  let remote: { stream: Readable; contentType?: string };
  let filename = entry.bundle_file ?? fallbackName;
  if (sourceType === 'url') {
    if (!source?.url) {
      throw new Error(`Entry "${entry.id}" has source.type=url but no source.url.`);
    }
    assertSafeRemoteUrl(source.url);
    remote = await fetchRemoteStream(
      source.url,
      'Remote URL source',
      value => {
        assertSafeRemoteUrl(value);
      },
      resolutionOptions,
    );
    filename = entry.bundle_file ?? basenameFromUrl(source.url, fallbackName);
  } else if (sourceType === 'gdrive') {
    if (!source?.file_id) {
      throw new Error(`Entry "${entry.id}" has source.type=gdrive but no source.file_id.`);
    }
    const driveUrl = googleDriveUrl(source.file_id);
    remote = await fetchRemoteStream(
      driveUrl,
      'Google Drive source',
      value => {
        const parsed = assertSafeRemoteUrl(value);
        if (!GOOGLE_HOSTS.has(parsed.hostname.toLowerCase())) {
          throw new Error('Google Drive redirected to an unexpected host.');
        }
      },
      resolutionOptions,
    );
  } else if (sourceType === 'dropbox' && source?.share_url) {
    const dropboxUrl = rewriteDropboxShareUrl(source.share_url);
    remote = await fetchRemoteStream(
      dropboxUrl,
      'Dropbox source',
      value => {
        const parsed = assertSafeRemoteUrl(value);
        if (!isAllowedDropboxRedirectHost(parsed.hostname)) {
          throw new Error('Dropbox redirected to an unexpected host.');
        }
      },
      resolutionOptions,
    );
    filename = entry.bundle_file ?? basenameFromUrl(dropboxUrl, fallbackName);
  } else if (sourceType === 'dropbox' && source?.dropbox_path) {
    const dropboxPath = parseDropboxPath(source.dropbox_path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), resolutionOptions.timeoutMs);
    try {
      const downloadUrl = 'https://content.dropboxapi.com/2/files/download';
      const binding = await assertPublicDns(downloadUrl, resolutionOptions.lookup);
      const request = async (token: string): Promise<Response> =>
        resolutionOptions.requestImpl(
          downloadUrl,
          {
            method: 'POST',
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/octet-stream,*/*;q=0.8',
              'Accept-Encoding': 'identity',
              'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath }),
            },
          },
          binding,
        );
      let response = await request(await getDropboxAccessToken(resolutionOptions));
      if (response.status === 401) {
        await response.body?.cancel();
        dropboxTokenCache = undefined;
        response = await request(await refreshDropboxAccessToken(resolutionOptions));
      }
      if (!response.ok) {
        throw new Error(`Dropbox source responded ${response.status} ${response.statusText}`);
      }
      const contentType = response.headers.get('content-type') ?? undefined;
      const contentEncoding = response.headers.get('content-encoding') ?? undefined;
      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (declaredLength && declaredLength > resolutionOptions.maxBytes) {
        throw new Error(
          `Dropbox source is ${declaredLength} bytes, over the ${resolutionOptions.maxBytes}-byte limit.`,
        );
      }
      if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
        throw new Error(
          `Dropbox source responded with content-encoding "${contentEncoding}", so original bytes cannot be verified.`,
        );
      }
      if (isHtmlContentType(contentType)) {
        throw new Error('Dropbox source returned an HTML page, not the file bytes.');
      }
      remote = {
        stream: streamedResponseBody(response, {
          context: 'Dropbox source',
          controller,
          timer,
          maxBytes: resolutionOptions.maxBytes,
          expectedBytes: declaredLength || undefined,
        }),
        contentType,
      };
      filename = entry.bundle_file ?? (path.basename(dropboxPath) || fallbackName);
    } catch (error) {
      clearTimeout(timer);
      controller.abort();
      throw error;
    }
  } else {
    throw new Error(
      `Entry "${entry.id}" has an unsupported or incomplete ${String(sourceType)} source.`,
    );
  }

  return {
    stream: remote.stream,
    mimeType: entry.mime_type ?? remote.contentType ?? defaultMimeFor(kind),
    filename,
    sourceType,
  };
}

/**
 * Fetch the sellable bytes for an entry from whichever storage backs it.
 *
 * Throws a descriptive Error if the source is missing or unreachable; callers
 * should surface that as a 5xx (never leak the underlying URL/credentials to
 * the buyer).
 */
export async function resolveResource(
  entry: DesignSystemEntry,
  options: SourceResolutionOptions = {},
): Promise<ResolvedResource> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const useInjectedFetch = Boolean(options.fetchImpl) || fetchImpl !== NATIVE_FETCH;
  const resolutionOptions = {
    requestImpl:
      options.requestImpl ??
      (useInjectedFetch
        ? ((url: string | URL, init: RequestInit) => fetchImpl(url, init))
        : pinnedHttpsRequest),
    lookup:
      options.lookup ??
      ((hostname: string) => dns.lookup(hostname, { all: true, verbatim: true })),
    maxBytes: options.maxBytes ?? MAX_REMOTE_BYTES,
    headers: options.headers,
  };
  const kind: ResourceType = entry.resource_type ?? 'design_md';
  const sourceType = entrySourceType(entry);
  const source: EntrySource | undefined = entry.source;
  const fallbackName =
    entry.file ||
    `${entry.id}.${kind === 'bundle_zip' ? 'zip' : kind === 'binary_asset' ? 'bin' : 'md'}`;

  if (sourceType === 'local') {
    const localName = entry.bundle_file ?? entry.file;
    const filePath = resolveLocalSourcePath(localName);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Local source file not found on disk: ${localName}`);
    }
    return {
      buffer: fs.readFileSync(filePath),
      mimeType: entry.mime_type ?? defaultMimeFor(kind),
      filename: path.basename(localName),
      sourceType,
    };
  }

  if (sourceType === 'url') {
    if (!source?.url) {
      throw new Error(`Entry "${entry.id}" has source.type=url but no source.url.`);
    }
    assertSafeRemoteUrl(source.url);
    const { buffer, contentType } = await fetchRemoteBytes(
      source.url,
      'Remote URL source',
      (value) => {
        assertSafeRemoteUrl(value);
      },
      resolutionOptions,
    );
    return {
      buffer,
      mimeType: entry.mime_type ?? contentType ?? defaultMimeFor(kind),
      filename: entry.bundle_file ?? basenameFromUrl(source.url, fallbackName),
      sourceType,
    };
  }

  if (sourceType === 'gdrive') {
    if (!source?.file_id) {
      throw new Error(`Entry "${entry.id}" has source.type=gdrive but no source.file_id.`);
    }
    const driveUrl = googleDriveUrl(source.file_id);
    // Sanity: the constructed URL must point at a Google host.
    const host = new URL(driveUrl).hostname.toLowerCase();
    if (!GOOGLE_HOSTS.has(host)) {
      throw new Error(`Unexpected Google Drive host: ${host}`);
    }
    const { buffer } = await fetchRemoteBytes(
      driveUrl,
      'Google Drive source',
      (value) => {
        const parsed = assertSafeRemoteUrl(value);
        if (!GOOGLE_HOSTS.has(parsed.hostname.toLowerCase())) {
          throw new Error('Google Drive redirected to an unexpected host.');
        }
      },
      resolutionOptions,
    );

    return {
      buffer,
      mimeType: entry.mime_type ?? defaultMimeFor(kind),
      filename: entry.bundle_file ?? fallbackName,
      sourceType,
    };
  }

  if (sourceType === 'dropbox') {
    if (source?.share_url) {
      const dropboxUrl = rewriteDropboxShareUrl(source.share_url);
      const { buffer, contentType } = await fetchRemoteBytes(
        dropboxUrl,
        'Dropbox source',
        (value) => {
          const parsed = assertSafeRemoteUrl(value);
          if (!isAllowedDropboxRedirectHost(parsed.hostname)) {
            throw new Error('Dropbox redirected to an unexpected host.');
          }
        },
        resolutionOptions,
      );
      if ((contentType ?? '').includes('text/html')) {
        throw new Error(
          'Dropbox returned an HTML page, not the file bytes. Check that the file is shared ' +
            '"Anyone with link", and verify the link is still valid.',
        );
      }
      return {
        buffer,
        mimeType: entry.mime_type ?? contentType ?? defaultMimeFor(kind),
        filename: entry.bundle_file ?? basenameFromUrl(dropboxUrl, fallbackName),
        sourceType,
      };
    }

    if (source?.dropbox_path) {
      const dropboxPath = parseDropboxPath(source.dropbox_path);
      const { buffer, contentType } = await fetchDropboxPathBytes(
        dropboxPath,
        resolutionOptions,
      );
      if ((contentType ?? '').includes('text/html')) {
        throw new Error(
          'Dropbox returned an HTML page, not the file bytes. Check that the file path is valid and accessible by the app.',
        );
      }
      return {
        buffer,
        mimeType: entry.mime_type ?? contentType ?? defaultMimeFor(kind),
        filename: entry.bundle_file ?? path.basename(dropboxPath) ?? fallbackName,
        sourceType,
      };
    }

    throw new Error(
      `Entry "${entry.id}" has source.type=dropbox but no source.share_url or source.dropbox_path.`,
    );
  }

  throw new Error(`Unknown storage source type: ${String(sourceType)}`);
}

// ─── Publish-time helpers (no network) ─────────────────────────────────────────

export interface BuildSourceInput {
  /** Local file path passed to the publisher, if any. */
  file?: string;
  /** Direct https URL, if any. */
  url?: string;
  /** Google Drive file ID, if any. */
  gdriveId?: string;
  /** Dropbox share URL for Mode A (link-share, no OAuth). */
  dropboxUrl?: string;
  /** Dropbox file path for Mode B (private-file OAuth). */
  dropboxPath?: string;
  /** Resource kind, used to derive a sensible display filename. */
  kind: ResourceType;
  /** Entry slug, used as a last-resort display filename. */
  id: string;
}

export interface BuiltSource {
  /** Display filename written to the registry `file` field. */
  file: string;
  /** Source descriptor, or undefined for local entries. */
  source?: EntrySource;
}

/**
 * Extract a Google Drive file ID from a raw ID or a file share/download URL.
 * Rejects embedded credentials (userinfo), folder links, and Google Workspace
 * document URLs at intake so operators get a file-share error instead of an
 * opaque HTML fetch. Never echo the input URL, username, or password.
 */
export function parseGoogleDriveId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Google Drive file ID cannot be empty.');
  }

  let parsed: URL | undefined;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = undefined;
  }

  if (parsed) {
    if (parsed.protocol !== 'https:') {
      throw new Error('Only https:// Google Drive file links are allowed.');
    }

    assertNoUrlUserinfo(
      parsed,
      'Google Drive URLs cannot contain credentials. Use a file share link (/file/d/ or open?id=) or a raw file ID, not a URL with a username or password.',
    );

    const host = parsed.hostname.toLowerCase();
    if (!GOOGLE_DRIVE_SHARE_HOSTS.has(host)) {
      throw new Error('Unexpected Google Drive host. Use a drive.google.com file share link or a raw file ID.');
    }

    const segments = parsed.pathname.toLowerCase().split('/').filter(Boolean);
    if (segments.includes('folders')) {
      throw new Error(
        'Google Drive folder links are not supported. Use a file share link (/file/d/ or open?id=), not a folder.',
      );
    }

    const workspaceKind = segments.find(segment => GOOGLE_WORKSPACE_PATH_SEGMENTS.has(segment));
    if (workspaceKind) {
      throw new Error(
        'Google Docs, Sheets, Slides, Forms, and Drawings links are not supported. Use a Google Drive file share link for the uploaded file.',
      );
    }

    const fileMatch = parsed.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/i);
    if (fileMatch) return fileMatch[1];

    const queryId = parsed.searchParams.get('id');
    if (queryId && /^[a-zA-Z0-9_-]+$/.test(queryId)) return queryId;

    throw new Error(
      'Could not parse a Google Drive file ID. Use a file share link (/file/d/ or open?id=) or a raw file ID.',
    );
  }

  if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) return trimmed;

  throw new Error(
    'Could not parse a Google Drive file ID. Use a file share link (/file/d/ or open?id=) or a raw file ID.',
  );
}

/**
 * Validate publisher inputs and build the `{ file, source }` pair to register.
 * Exactly one of file/url/gdriveId/dropboxUrl/dropboxPath must be provided.
 */
export function buildSource(input: BuildSourceInput): BuiltSource {
  const provided = [
    input.file,
    input.url,
    input.gdriveId,
    input.dropboxUrl,
    input.dropboxPath,
  ].filter(Boolean);
  if (provided.length === 0) {
    throw new Error(
      'Provide one source: --file, --url, --gdrive-id, --dropbox-url, or --dropbox-path.',
    );
  }
  if (provided.length > 1) {
    throw new Error(
      'Provide only one source: --file, --url, --gdrive-id, --dropbox-url, or --dropbox-path.',
    );
  }

  const ext =
    input.kind === 'bundle_zip' ? 'zip' : input.kind === 'binary_asset' ? 'bin' : 'md';

  if (input.url) {
    assertSafeRemoteUrl(input.url);
    return {
      file: basenameFromUrl(input.url, `${input.id}.${ext}`),
      source: { type: 'url', url: input.url },
    };
  }

  if (input.gdriveId) {
    const fileId = parseGoogleDriveId(input.gdriveId);
    return {
      file: `${input.id}.${ext}`,
      source: { type: 'gdrive', file_id: fileId },
    };
  }

  if (input.dropboxUrl) {
    parseDropboxShareUrl(input.dropboxUrl);
    return {
      file: basenameFromUrl(input.dropboxUrl, `${input.id}.${ext}`),
      source: { type: 'dropbox', share_url: input.dropboxUrl.trim() },
    };
  }

  if (input.dropboxPath) {
    const dropboxPath = parseDropboxPath(input.dropboxPath);
    return {
      file: path.basename(dropboxPath) || `${input.id}.${ext}`,
      source: { type: 'dropbox', dropbox_path: dropboxPath },
    };
  }

  // Local file — caller validates existence.
  return { file: path.basename(input.file as string) };
}

/** Connector availability for /health and operator diagnostics. */
export function storageStatus(): {
  local: boolean;
  url: boolean;
  google_drive: { enabled: boolean; api_key: boolean };
  dropbox: { enabled: boolean; oauth: boolean };
} {
  return {
    local: true,
    url: true,
    google_drive: { enabled: true, api_key: Boolean(GOOGLE_API_KEY) },
    dropbox: { enabled: true, oauth: hasDropboxOauthConfig() },
  };
}
