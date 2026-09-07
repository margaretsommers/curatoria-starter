/**
 * blob-mode.ts — one resolution of "which Blob backend is active" shared by
 * the server composition root and the publish-asset CLI, so a creator without
 * a Vercel account gets the same local filesystem store on both the import
 * path and the delivery path.
 */

import crypto from 'node:crypto';
import path from 'node:path';

import type { BlobSdkAdapter } from './blob-storage';
import { vercelBlobSdk } from './blob-storage';
import { LocalBlobStore } from './local-blob-storage';
import { PROJECT_ROOT } from './paths';

export type BlobMode = 'vercel' | 'local' | 'disabled';

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'production';
}

function isVercelBlobConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.BLOB_STORE_ID?.trim() || env.BLOB_READ_WRITE_TOKEN?.trim());
}

export function resolveBlobMode(env: NodeJS.ProcessEnv = process.env): BlobMode {
  const raw = (env.BLOB_MODE ?? '').trim().toLowerCase();
  const production = isProduction(env);
  if (raw && raw !== 'vercel' && raw !== 'local') {
    throw new Error(`BLOB_MODE must be "vercel" or "local", not "${raw}".`);
  }
  if (raw === 'local') {
    if (production) {
      throw new Error(
        'BLOB_MODE=local is a development mode. Production requires private Vercel Blob.',
      );
    }
    return 'local';
  }
  if (raw === 'vercel') {
    if (!isVercelBlobConfigured(env)) {
      throw new Error('BLOB_MODE=vercel requires BLOB_STORE_ID or BLOB_READ_WRITE_TOKEN.');
    }
    return 'vercel';
  }
  if (isVercelBlobConfigured(env)) return 'vercel';
  return production ? 'disabled' : 'local';
}

export function localBlobRootDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOCAL_BLOB_DIR?.trim()
    ? path.resolve(env.LOCAL_BLOB_DIR.trim())
    : path.join(PROJECT_ROOT, '.local-blob');
}

export function composeLocalBlobStore(
  env: NodeJS.ProcessEnv,
  baseUrl: string,
  clock?: () => number,
): LocalBlobStore {
  const configuredSecret = (env.LOCAL_BLOB_SECRET ?? '').trim();
  if (configuredSecret && Buffer.byteLength(configuredSecret) < 32) {
    throw new Error('LOCAL_BLOB_SECRET must contain at least 32 bytes when set.');
  }
  return new LocalBlobStore({
    rootDirectory: localBlobRootDirectory(env),
    baseUrl,
    // Without a configured secret, signed URLs are valid only for this process
    // lifetime; redemption re-signs on demand, so restarts cost one re-redeem.
    signingSecret: configuredSecret || crypto.randomBytes(32),
    clock,
  });
}

export function composeBlobAdapter(
  env: NodeJS.ProcessEnv,
  baseUrl: string,
  clock?: () => number,
): { mode: BlobMode; adapter?: BlobSdkAdapter; localStore?: LocalBlobStore } {
  const mode = resolveBlobMode(env);
  if (mode === 'vercel') return { mode, adapter: vercelBlobSdk };
  if (mode === 'disabled') return { mode };
  const localStore = composeLocalBlobStore(env, baseUrl, clock);
  return { mode, adapter: localStore, localStore };
}
