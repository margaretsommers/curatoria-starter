import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import { appendEntry } from './catalog';
import { importPrivateBlob } from './blob-storage';
import { hashAndCopyStream, normalizeSha256, sha256Hex } from './content-integrity';
import { resolveResourceStream, type ResolvedResourceStream } from './sources';
import type { DesignSystemEntry, EntrySource } from './types';

export type BinaryAssetImportInput = {
  id: string;
  name: string;
  description: string;
  priceUsd: string;
  tags: string[];
  source: EntrySource;
  filename: string;
  mimeType: string;
  localOriginalBytes?: Uint8Array;
  localOriginalPath?: string;
  trustedOriginalSha256?: string;
  trustedOriginalBytes?: number;
};

export interface AssetImportDependencies {
  resolve(entry: DesignSystemEntry): Promise<ResolvedResourceStream>;
  store(input: {
    body: Readable;
    filename: string;
    mimeType: string;
    sha256: string;
    byteLength: number;
  }): Promise<{
    pathname: string;
    sha256: string;
    bytes: number;
    created: boolean;
    etag: string;
  }>;
  publish(entry: DesignSystemEntry): Promise<void>;
}

const defaultDependencies: AssetImportDependencies = {
  resolve: resolveResourceStream,
  store: importPrivateBlob,
  publish: appendEntry,
};

export async function importBinaryAsset(
  input: BinaryAssetImportInput,
  deps: AssetImportDependencies = defaultDependencies,
): Promise<DesignSystemEntry> {
  validateImportInput(input);

  const sharedEntry = {
    id: input.id,
    file: input.filename,
    resource_type: 'binary_asset' as const,
    mime_type: input.mimeType,
    name: input.name,
    description: input.description,
    price_usd: input.priceUsd,
    tags: input.tags,
  };
  const sourceEntry: DesignSystemEntry = {
    ...sharedEntry,
    source: input.source,
    published_at: new Date().toISOString(),
    active: false,
  };
  const stagingDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'curatoria-import-'));
  await fsp.chmod(stagingDirectory, 0o700);
  const stagedPath = path.join(stagingDirectory, 'asset.stage');
  try {
    const resolved = await deps.resolve(sourceEntry);
    const staged = await hashAndCopyStream(
      resolved.stream,
      fs.createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 }),
    );
    validateBinarySignature(staged.prefix, staged.bytes, input.filename, input.mimeType);
    const trusted = await trustedOriginal(input);
    if (staged.sha256 !== trusted.sha256 || staged.bytes !== trusted.bytes) {
      throw new Error('Provider bytes do not match the trusted original hash and size.');
    }

    const blobBody = fs.createReadStream(stagedPath);
    let stored: Awaited<ReturnType<AssetImportDependencies['store']>>;
    try {
      stored = await deps.store({
        body: blobBody,
        filename: input.filename,
        mimeType: input.mimeType,
        sha256: staged.sha256,
        byteLength: staged.bytes,
      });
    } finally {
      blobBody.destroy();
    }
    if (stored.sha256 !== trusted.sha256 || stored.bytes !== trusted.bytes) {
      throw new Error('Stored Blob metadata does not match the trusted original.');
    }

    const published: DesignSystemEntry = {
      ...sharedEntry,
      content_sha256: stored.sha256,
      content_bytes: stored.bytes,
      integrity_status: 'verified',
      delivery_mode: 'entitlement',
      source_provider: resolved.sourceType,
      blob_path: stored.pathname,
      published_at: new Date().toISOString(),
      active: true,
    };
    // Retain immutable content-addressed objects if catalog publication fails.
    // Vercel Blob cannot atomically prove both "unreferenced by the registry"
    // and "same storage generation" at delete time; deletion here could race a
    // concurrent deduplicating publisher and remove its now-referenced object.
    await deps.publish(published);
    return published;
  } finally {
    await fsp.rm(stagingDirectory, { recursive: true, force: true });
  }
}

function validateImportInput(input: BinaryAssetImportInput): void {
  if (!/^[a-z0-9-]+$/.test(input.id)) {
    throw new Error('Asset id must use lowercase letters, numbers, and hyphens only.');
  }
  if (!input.filename.trim()) throw new Error('Asset filename is required.');
  if (!input.mimeType.trim()) throw new Error('Asset MIME type is required.');
  if (!/^\d+(?:\.\d{1,6})?$/.test(input.priceUsd) || Number(input.priceUsd) <= 0) {
    throw new Error('Asset price must be a positive USD decimal with at most six places.');
  }
  if (!input.source?.type) throw new Error('Asset source is required.');
  validateTrustedOriginalInput(input);
}

function validateTrustedOriginalInput(input: BinaryAssetImportInput): void {
  const provided = [
    input.localOriginalBytes !== undefined,
    input.localOriginalPath !== undefined,
    input.trustedOriginalSha256 !== undefined || input.trustedOriginalBytes !== undefined,
  ].filter(Boolean).length;
  if (provided !== 1) {
    throw new Error(
      'Binary import requires exactly one trusted original: bytes, local path, or hash and size.',
    );
  }
}

async function trustedOriginal(
  input: BinaryAssetImportInput,
): Promise<{ sha256: string; bytes: number }> {
  if (input.localOriginalBytes) {
    const bytes = Buffer.from(input.localOriginalBytes);
    if (bytes.byteLength <= 0) throw new Error('Local original is empty.');
    validateBinarySignature(bytes.subarray(0, 512), bytes.byteLength, input.filename, input.mimeType);
    return { sha256: sha256Hex(bytes), bytes: bytes.byteLength };
  }
  if (input.localOriginalPath) {
    if (!path.isAbsolute(input.localOriginalPath) || input.localOriginalPath.includes('\0')) {
      throw new Error('Local original path must be absolute.');
    }
    const sink = new WritableDigestSink();
    const result = await hashAndCopyStream(fs.createReadStream(input.localOriginalPath), sink);
    validateBinarySignature(result.prefix, result.bytes, input.filename, input.mimeType);
    return { sha256: result.sha256, bytes: result.bytes };
  }
  const sha256 = normalizeSha256(input.trustedOriginalSha256);
  if (
    !sha256 ||
    !Number.isSafeInteger(input.trustedOriginalBytes) ||
    Number(input.trustedOriginalBytes) <= 0
  ) {
    throw new Error(
      'Binary import requires local original bytes or trusted original hash and size.',
    );
  }
  return { sha256, bytes: Number(input.trustedOriginalBytes) };
}

class WritableDigestSink extends Writable {
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }
}

function validateBinarySignature(
  prefix: Buffer,
  byteLength: number,
  filename: string,
  mimeType: string,
): void {
  if (byteLength === 0) throw new Error('Imported asset is empty.');
  const isPsd =
    filename.toLowerCase().endsWith('.psd') ||
    mimeType.toLowerCase().split(';', 1)[0] === 'image/vnd.adobe.photoshop';
  if (isPsd && prefix.subarray(0, 4).toString('latin1') !== '8BPS') {
    throw new Error('Imported PSD is missing PSD 8BPS signature.');
  }
}
