import crypto from 'node:crypto';
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type ContentHashVerification =
  | {
      ok: true;
      actualSha256: string;
      detail: string;
    }
  | {
      ok: false;
      code: 'content_hash_mismatch' | 'content_hash_header_mismatch';
      message: string;
      actualSha256: string;
      details: {
        catalog_content_sha256: string;
        saved_bytes_sha256: string;
        response_content_sha256: string | null;
        failed_checks: string[];
      };
    };

export function sha256Hex(bytes: Buffer | Uint8Array | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function hashAndCopyStream(
  source: Readable,
  destination: Writable,
  prefixLimit = 512,
): Promise<{ sha256: string; bytes: number; prefix: Buffer }> {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let prefix = Buffer.alloc(0);
  const inspector = new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      hash.update(value);
      if (prefix.byteLength < prefixLimit) {
        prefix = Buffer.concat([
          prefix,
          value.subarray(0, prefixLimit - prefix.byteLength),
        ]);
      }
      callback(null, value);
    },
  });
  await pipeline(source, inspector, destination);
  return { sha256: hash.digest('hex'), bytes, prefix };
}

export function normalizeSha256(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

export function verifyCatalogContentHash(
  bytes: Uint8Array,
  catalogSha256: string,
  responseSha256: string | null,
): ContentHashVerification {
  const actualSha256 = sha256Hex(bytes);
  const failures: string[] = [];

  if (actualSha256 !== catalogSha256) {
    failures.push(
      `saved bytes SHA-256 ${actualSha256} does not match catalog content_sha256 ${catalogSha256}`,
    );
  }

  if (responseSha256 !== null) {
    const normalizedHeader = normalizeSha256(responseSha256);
    if (normalizedHeader !== catalogSha256) {
      failures.push(
        `response X-Content-Sha256 ${JSON.stringify(responseSha256)} does not match catalog content_sha256 ${catalogSha256}`,
      );
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      code:
        actualSha256 !== catalogSha256
          ? 'content_hash_mismatch'
          : 'content_hash_header_mismatch',
      message: `Content integrity verification failed: ${failures.join('; ')}.`,
      actualSha256,
      details: {
        catalog_content_sha256: catalogSha256,
        saved_bytes_sha256: actualSha256,
        response_content_sha256: responseSha256,
        failed_checks: failures,
      },
    };
  }

  return {
    ok: true,
    actualSha256,
    detail:
      responseSha256 === null
        ? 'saved bytes SHA-256 matches catalog content_sha256'
        : 'saved bytes and X-Content-Sha256 match catalog content_sha256',
  };
}
