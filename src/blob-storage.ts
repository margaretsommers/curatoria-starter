import {
  get,
  head,
  issueSignedToken,
  presignUrl,
  put,
} from '@vercel/blob';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import { sha256Hex, normalizeSha256 } from './content-integrity';
import { sanitizeDownloadFilename } from './delivery';

export const SIGNED_DOWNLOAD_TTL_MS = 60 * 1000;
const PRODUCTION_MAX_SIGNED_DOWNLOAD_TTL_MS = 75 * 1000;
const MULTIPART_THRESHOLD_BYTES = 4.5 * 1024 * 1024;

export type PrivateBlobPutOptions = {
  access: 'private';
  addRandomSuffix: false;
  allowOverwrite: false;
  contentType: string;
  multipart: boolean;
};

export type SignedTokenOptions = {
  pathname: string;
  operations: ['get'];
  validUntil: number;
};

export type SignedToken = {
  delegationToken: string;
  clientSigningToken: string;
  validUntil: number;
};

export type PresignGetOptions = {
  operation: 'get';
  pathname: string;
  access: 'private';
  validUntil: number;
};

export interface BlobSdkAdapter {
  put(
    pathname: string,
    body: Uint8Array | Readable,
    options: PrivateBlobPutOptions,
  ): Promise<{ pathname: string; url: string; etag?: string }>;
  head(pathname: string): Promise<{
    pathname: string;
    size: number;
    contentType?: string;
    etag: string;
  }>;
  read(pathname: string): Promise<{
    body: Readable;
    pathname: string;
    size: number;
    contentType: string;
    etag: string;
  }>;
  issueSignedToken(options: SignedTokenOptions): Promise<SignedToken>;
  presignUrl(
    token: Pick<SignedToken, 'delegationToken' | 'clientSigningToken'>,
    options: PresignGetOptions,
  ): Promise<{ presignedUrl: string }>;
}

/**
 * Writes a mutable JSON document to private Vercel Blob, overwriting any
 * existing object at that pathname. Deliberately separate from
 * `BlobSdkAdapter#put`, which is typed to accept only `allowOverwrite: false`
 * so every immutable-asset call site keeps that guarantee at the type level.
 * Used for the catalog registry (src/catalog-blob-repository.ts), which is a
 * single mutable document, not a content-addressed immutable asset.
 */
export async function putMutableJsonBlob(pathname: string, body: Uint8Array): Promise<void> {
  await put(pathname, Buffer.from(body), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
}

export const vercelBlobSdk: BlobSdkAdapter = {
  async put(pathname, body, options) {
    return put(pathname, body instanceof Uint8Array ? Buffer.from(body) : body, options);
  },
  async head(pathname) {
    const details = await head(pathname);
    return {
      pathname: details.pathname,
      size: details.size,
      contentType: details.contentType,
      etag: details.etag,
    };
  },
  async read(pathname) {
    const result = await get(pathname, { access: 'private', useCache: false });
    if (!result) {
      throw Object.assign(
        new Error('Immutable Blob was not found for authenticated reconciliation.'),
        { statusCode: 404 },
      );
    }
    if (result.statusCode !== 200 || !result.stream) {
      throw Object.assign(
        new Error('Immutable Blob could not be read for authenticated reconciliation.'),
        { statusCode: result.statusCode },
      );
    }
    return {
      body: Readable.fromWeb(result.stream),
      pathname: result.blob.pathname,
      size: result.blob.size,
      contentType: result.blob.contentType,
      etag: result.blob.etag,
    };
  },
  async issueSignedToken(options) {
    return issueSignedToken(options);
  },
  async presignUrl(token, options) {
    return presignUrl(token, options);
  },
};

export class BlobUploadReconciliationError extends Error {
  readonly uploadIdentity: { pathname: string; url: string; created: true };

  constructor(uploadIdentity: { pathname: string; url: string; created: true }) {
    super('Blob upload succeeded, but post-upload reconciliation failed; object was retained.');
    this.name = 'BlobUploadReconciliationError';
    this.uploadIdentity = uploadIdentity;
  }
}

export function buildImmutableBlobPath(sha256: string, filename: string): string {
  const digest = normalizeSha256(sha256);
  if (!digest) throw new Error('Immutable Blob path requires a valid SHA-256 digest.');
  const safeFilename = sanitizeDownloadFilename(filename, 'curatoria-asset.bin');
  return `assets/sha256/${digest}/${safeFilename}`;
}

export async function importPrivateBlob(
  input: {
    body?: Uint8Array | Readable;
    bytes?: Uint8Array;
    filename: string;
    mimeType: string;
    sha256?: string;
    byteLength?: number;
  },
  sdk: BlobSdkAdapter = vercelBlobSdk,
): Promise<{ pathname: string; sha256: string; bytes: number; created: boolean; etag: string }> {
  const body = input.body ?? input.bytes;
  if (!body) throw new Error('Blob import requires a body.');
  const byteLength = input.byteLength ?? (body instanceof Uint8Array ? body.byteLength : undefined);
  const sha256 = normalizeSha256(input.sha256) ??
    (body instanceof Uint8Array ? sha256Hex(body) : undefined);
  if (!sha256 || !Number.isSafeInteger(byteLength) || Number(byteLength) <= 0) {
    throw new Error('Streaming Blob import requires a trusted SHA-256 digest and byte count.');
  }
  if (Number(byteLength) === 0) {
    throw new Error('Cannot import an empty paid asset.');
  }
  const pathname = buildImmutableBlobPath(sha256, input.filename);
  try {
    const stored = await sdk.put(pathname, body, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: input.mimeType,
      multipart: Number(byteLength) > MULTIPART_THRESHOLD_BYTES,
    });
    const uploadIdentity = { pathname: stored.pathname, url: stored.url, created: true as const };
    if (stored.pathname !== pathname) {
      throw new BlobUploadReconciliationError(uploadIdentity);
    }
    let details: Awaited<ReturnType<BlobSdkAdapter['head']>>;
    try {
      details = await sdk.head(pathname);
      assertMatchingBlob(details, {
        pathname,
        byteLength: Number(byteLength),
        mimeType: input.mimeType,
      });
    } catch {
      // Vercel Blob does not expose an atomic registry-reference + conditional
      // delete transaction. Preserve the successful immutable upload identity
      // instead of risking deletion of content another publisher now references.
      throw new BlobUploadReconciliationError(uploadIdentity);
    }
    return {
      pathname,
      sha256,
      bytes: Number(byteLength),
      created: true,
      etag: details.etag,
    };
  } catch (error) {
    if (!isConflict(error)) throw error;
    const details = await sdk.head(pathname);
    await validateExistingBlob(sdk, details, {
      pathname,
      sha256,
      byteLength: Number(byteLength),
      mimeType: input.mimeType,
    });
    return {
      pathname,
      sha256,
      bytes: Number(byteLength),
      created: false,
      etag: details.etag,
    };
  }
}

/**
 * Vercel Blob's HEAD and GET responses for the same immutable object can
 * disagree on etag strength: observed 2026-09-04 on a real 18 MB
 * (multipart-uploaded) object, HEAD returned `"<tag>"` (strong) while GET
 * returned `W/"<tag>"` (weak) for byte-identical content. Per RFC 7232 a
 * weak and strong validator sharing the same opaque tag are the same
 * resource state, so strip the `W/` prefix before comparing. The actual
 * content is still independently verified by rehashing the full stream
 * below -- this only avoids treating a benign HEAD/GET representation
 * difference as a real conflict.
 */
function normalizeEtag(etag: string): string {
  return etag.startsWith('W/') ? etag.slice(2) : etag;
}

async function validateExistingBlob(
  sdk: BlobSdkAdapter,
  headDetails: Awaited<ReturnType<BlobSdkAdapter['head']>>,
  expected: { pathname: string; sha256: string; byteLength: number; mimeType: string },
): Promise<void> {
  // headDetails.size is already checked against expected.byteLength by
  // assertMatchingBlob above, and the streamed byte count is independently
  // re-verified after this block -- existing.size (from the GET/read
  // response, not HEAD) is not used here. Observed 2026-09-04 on a real
  // private multipart-uploaded object: get()'s reported blob.size was 0
  // while HEAD correctly reported the true size, so trusting it here would
  // reject a genuinely matching object based on unreliable metadata.
  assertMatchingBlob(headDetails, expected);
  const existing = await sdk.read(expected.pathname);
  if (
    existing.pathname !== expected.pathname ||
    existing.contentType !== expected.mimeType ||
    normalizeEtag(existing.etag) !== normalizeEtag(headDetails.etag)
  ) {
    existing.body.destroy();
    throw new Error('Immutable Blob conflict metadata changed during authenticated validation.');
  }
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of existing.body) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > expected.byteLength) {
        throw new Error('Immutable Blob conflict exceeds the expected byte count.');
      }
      hash.update(value);
    }
  } finally {
    existing.body.destroy();
  }
  if (bytes !== expected.byteLength || hash.digest('hex') !== expected.sha256) {
    throw new Error('Immutable Blob conflict content does not match the staged asset.');
  }
}

function assertMatchingBlob(
  details: { pathname: string; size: number; contentType?: string; etag: string },
  expected: { pathname: string; byteLength: number; mimeType: string },
): void {
  if (
    details.pathname !== expected.pathname ||
    details.size !== expected.byteLength ||
    (details.contentType !== undefined && details.contentType !== expected.mimeType) ||
    !details.etag
  ) {
    throw new Error('Immutable Blob conflict does not match the staged asset metadata.');
  }
}

function isConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const value = error as Error & { status?: number; statusCode?: number; code?: string };
  return (
    value.status === 409 ||
    value.statusCode === 409 ||
    value.code === 'BLOB_ALREADY_EXISTS' ||
    /\b(?:409|already exists|conflict)\b/i.test(value.message)
  );
}

export async function createSignedBlobDownload(
  pathname: string,
  sdk: BlobSdkAdapter = vercelBlobSdk,
  nowMs = Date.now(),
  ttlMs = SIGNED_DOWNLOAD_TTL_MS,
): Promise<{ url: string; expiresAt: string }> {
  if (!pathname.startsWith('assets/sha256/')) {
    throw new Error('Signed downloads require a content-addressed asset pathname.');
  }
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    (process.env.NODE_ENV === 'production' && ttlMs > PRODUCTION_MAX_SIGNED_DOWNLOAD_TTL_MS)
  ) {
    throw new Error('Signed download TTL is invalid or exceeds the production maximum.');
  }
  const validUntil = nowMs + ttlMs;
  const token = await sdk.issueSignedToken({
    pathname,
    operations: ['get'],
    validUntil,
  });
  const result = await sdk.presignUrl(
    {
      delegationToken: token.delegationToken,
      clientSigningToken: token.clientSigningToken,
    },
    {
      operation: 'get',
      pathname,
      access: 'private',
      validUntil,
    },
  );
  return {
    url: result.presignedUrl,
    expiresAt: new Date(validUntil).toISOString(),
  };
}
