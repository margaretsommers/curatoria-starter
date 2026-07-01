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
 */

import fs from 'fs';
import path from 'path';
import { DESIGN_SYSTEMS_DIR } from './paths';
import { DesignSystemEntry, EntrySource, ResourceType, StorageSourceType } from './types';

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

export const DROPBOX_HOSTS = new Set([
  'www.dropbox.com',
  'dl.dropboxusercontent.com',
  'content.dropboxapi.com',
]);

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

// ─── Source resolution helpers ──────────────────────────────────────────────

/** The effective source for an entry; entries with no `source` are local. */
export function entrySourceType(entry: DesignSystemEntry): StorageSourceType {
  return entry.source?.type ?? 'local';
}

function defaultMimeFor(kind: ResourceType): string {
  return kind === 'bundle_zip' ? 'application/zip' : 'text/markdown';
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

// ─── SSRF guard for the url connector ─────────────────────────────────────────

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
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
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '[::1]' ||
    isPrivateIpv4(host)
  ) {
    throw new Error(`Refusing to fetch from non-public host: ${host}`);
  }
  return parsed;
}

// ─── Remote fetch with timeout + size ceiling ─────────────────────────────────

async function fetchRemoteBytes(
  url: string,
  context: string,
): Promise<{ buffer: Buffer; contentType?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!res.ok) {
      throw new Error(`${context} responded ${res.status} ${res.statusText}`);
    }

    const declaredLength = Number(res.headers.get('content-length') ?? '0');
    if (declaredLength && declaredLength > MAX_REMOTE_BYTES) {
      throw new Error(
        `${context} is ${declaredLength} bytes, over the ${MAX_REMOTE_BYTES}-byte limit.`,
      );
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_REMOTE_BYTES) {
      throw new Error(
        `${context} is ${buffer.byteLength} bytes, over the ${MAX_REMOTE_BYTES}-byte limit.`,
      );
    }

    return { buffer, contentType: res.headers.get('content-type') ?? undefined };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`${context} timed out after ${FETCH_TIMEOUT_MS}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
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

/**
 * Parse + validate a Dropbox URL for Mode A link-share access.
 * Accepts both dropbox.com share URLs and direct dl.dropboxusercontent.com URLs.
 */
export function parseDropboxShareUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error(`Invalid Dropbox URL: ${input}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Only https:// Dropbox URLs are allowed (got ${parsed.protocol}).`);
  }

  const host = parsed.hostname.toLowerCase();
  if (!DROPBOX_HOSTS.has(host)) {
    throw new Error(`Unexpected Dropbox host: ${host}`);
  }

  return parsed;
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

async function refreshDropboxAccessToken(): Promise<string> {
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

  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

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

async function getDropboxAccessToken(): Promise<string> {
  if (
    dropboxTokenCache &&
    Date.now() < dropboxTokenCache.expiresAtMs - DROPBOX_TOKEN_REFRESH_SKEW_MS
  ) {
    return dropboxTokenCache.accessToken;
  }
  return refreshDropboxAccessToken();
}

async function fetchDropboxPathBytes(
  dropboxPath: string,
): Promise<{ buffer: Buffer; contentType?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const request = async (token: string): Promise<Response> =>
    fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath }),
      },
    });
  try {
    let res = await request(await getDropboxAccessToken());
    if (res.status === 401) {
      // Retry once with a fresh token in case our cache expired early.
      dropboxTokenCache = undefined;
      res = await request(await refreshDropboxAccessToken());
    }
    if (!res.ok) {
      throw new Error(`Dropbox source responded ${res.status} ${res.statusText}`);
    }

    const declaredLength = Number(res.headers.get('content-length') ?? '0');
    if (declaredLength && declaredLength > MAX_REMOTE_BYTES) {
      throw new Error(
        `Dropbox source is ${declaredLength} bytes, over the ${MAX_REMOTE_BYTES}-byte limit.`,
      );
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_REMOTE_BYTES) {
      throw new Error(
        `Dropbox source is ${buffer.byteLength} bytes, over the ${MAX_REMOTE_BYTES}-byte limit.`,
      );
    }

    return { buffer, contentType: res.headers.get('content-type') ?? undefined };
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
 * Fetch the sellable bytes for an entry from whichever storage backs it.
 *
 * Throws a descriptive Error if the source is missing or unreachable; callers
 * should surface that as a 5xx (never leak the underlying URL/credentials to
 * the buyer).
 */
export async function resolveResource(entry: DesignSystemEntry): Promise<ResolvedResource> {
  const kind: ResourceType = entry.resource_type ?? 'design_md';
  const sourceType = entrySourceType(entry);
  const source: EntrySource | undefined = entry.source;
  const fallbackName =
    entry.file || `${entry.id}.${kind === 'bundle_zip' ? 'zip' : 'md'}`;

  if (sourceType === 'local') {
    const localName = entry.bundle_file ?? entry.file;
    const filePath = path.join(DESIGN_SYSTEMS_DIR, localName);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Local source file not found on disk: ${localName}`);
    }
    return {
      buffer: fs.readFileSync(filePath),
      mimeType: entry.mime_type ?? defaultMimeFor(kind),
      filename: localName,
      sourceType,
    };
  }

  if (sourceType === 'url') {
    if (!source?.url) {
      throw new Error(`Entry "${entry.id}" has source.type=url but no source.url.`);
    }
    assertSafeRemoteUrl(source.url);
    const { buffer, contentType } = await fetchRemoteBytes(source.url, 'Remote URL source');
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
    const { buffer, contentType } = await fetchRemoteBytes(driveUrl, 'Google Drive source');

    // Without an API key, a non-public or oversized file returns Google's HTML
    // interstitial instead of bytes. Detect that and give a fixable error.
    if (
      !GOOGLE_API_KEY &&
      (contentType ?? '').includes('text/html') &&
      kind !== 'design_md'
    ) {
      throw new Error(
        'Google Drive returned an HTML page, not the file. Share the file as ' +
          '"Anyone with the link can view", or set GOOGLE_API_KEY for private/large files.',
      );
    }

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
      const { buffer, contentType } = await fetchRemoteBytes(dropboxUrl, 'Dropbox source');
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
      const { buffer, contentType } = await fetchDropboxPathBytes(dropboxPath);
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

/** Extract a Google Drive file ID from either a raw ID or a share URL. */
export function parseGoogleDriveId(input: string): string {
  const trimmed = input.trim();
  // https://drive.google.com/file/d/<ID>/view
  const dMatch = trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (dMatch) return dMatch[1];
  // https://drive.google.com/open?id=<ID> or ...?id=<ID>
  try {
    const u = new URL(trimmed);
    const id = u.searchParams.get('id');
    if (id) return id;
  } catch {
    // not a URL — fall through
  }
  return trimmed;
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

  const ext = input.kind === 'bundle_zip' ? 'zip' : 'md';

  if (input.url) {
    assertSafeRemoteUrl(input.url);
    return {
      file: basenameFromUrl(input.url, `${input.id}.${ext}`),
      source: { type: 'url', url: input.url },
    };
  }

  if (input.gdriveId) {
    const fileId = parseGoogleDriveId(input.gdriveId);
    if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
      throw new Error(`Could not parse a Google Drive file ID from: ${input.gdriveId}`);
    }
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
