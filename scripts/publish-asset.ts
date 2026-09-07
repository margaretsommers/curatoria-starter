#!/usr/bin/env ts-node

import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

import { importBinaryAsset } from '../src/asset-import';
import { composeBlobAdapter, localBlobRootDirectory } from '../src/blob-mode';
import { importPrivateBlob } from '../src/blob-storage';
import { appendEntry } from '../src/catalog';
import { hashAndCopyStream } from '../src/content-integrity';
import { resolveResourceStream } from '../src/sources';
import { sanitizeDownloadFilename } from '../src/delivery';
import { parseGoogleDriveId, parseDropboxShareUrl } from '../src/sources';
import type { EntrySource } from '../src/types';

type Args = Record<string, string>;
const sensitiveValues = new Set<string>();
const BOOLEAN_FLAGS = new Set(['preflight']);
const SAFE_MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export type PreflightReport = {
  ok: boolean;
  preflight: true;
  filename: string;
  mime_type: string;
  content_bytes: number;
  content_sha256: string;
  psd_signature: string;
  psd_signature_ok: boolean;
  filename_safe: boolean;
  mime_safe: boolean;
  error?: string;
};

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.preflight) {
    const missing = ['filename', 'mime', 'original-file'].filter(key => !args[key]);
    if (missing.length > 0) {
      usage(`Missing required arguments: ${missing.map(key => `--${key}`).join(', ')}`);
    }
    if (!path.isAbsolute(args['original-file']) || args['original-file'].includes('\0')) {
      usage('--original-file must be an absolute local path.');
    }
    const report = await preflightLocalAsset({
      originalFile: args['original-file'],
      filename: args.filename,
      mimeType: args.mime,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }

  const missing = ['id', 'name', 'price', 'filename', 'mime', 'original-file'].filter(key => !args[key]);
  if (missing.length > 0) {
    usage(`Missing required arguments: ${missing.map(key => `--${key}`).join(', ')}`);
  }

  const source = sourceFromArgs(args);
  if (!path.isAbsolute(args['original-file']) || args['original-file'].includes('\0')) {
    usage('--original-file must be an absolute local path.');
  }
  const port = process.env.PORT?.trim() || '3000';
  const { mode, adapter } = composeBlobAdapter(process.env, `http://localhost:${port}`);
  if (!adapter) {
    usage(
      'Blob storage is disabled. Set BLOB_READ_WRITE_TOKEN (or BLOB_MODE=local outside production).',
    );
  }
  if (mode === 'local') {
    process.stderr.write(
      `Blob mode: local filesystem (${localBlobRootDirectory(process.env)}). No Vercel account is required.\n`,
    );
  }
  const entry = await importBinaryAsset(
    {
      id: args.id,
      name: args.name,
      description: args.desc ?? args.description ?? '',
      priceUsd: args.price,
      tags: args.tags ? args.tags.split(',').map(value => value.trim()).filter(Boolean) : [],
      source,
      filename: args.filename,
      mimeType: args.mime,
      localOriginalPath: args['original-file'],
    },
    {
      resolve: resolveResourceStream,
      store: input => importPrivateBlob(input, adapter),
      publish: appendEntry,
    },
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        id: entry.id,
        filename: entry.file,
        resource_type: entry.resource_type,
        mime_type: entry.mime_type,
        price_usd: entry.price_usd,
        content_sha256: entry.content_sha256,
        content_bytes: entry.content_bytes,
        source_provider: entry.source_provider,
        delivery_mode: entry.delivery_mode,
      },
      null,
      2,
    )}\n`,
  );
}

export async function preflightLocalAsset(input: {
  originalFile: string;
  filename: string;
  mimeType: string;
}): Promise<PreflightReport> {
  if (!path.isAbsolute(input.originalFile) || input.originalFile.includes('\0')) {
    throw new Error('Local original path must be absolute.');
  }
  const sink = new WritableDigestSink();
  const hashed = await hashAndCopyStream(fs.createReadStream(input.originalFile), sink);
  const psdSignature = hashed.prefix.subarray(0, 4).toString('latin1');
  const filenameSafe = filenameIsSafe(input.filename);
  const mimeSafe = mimeIsSafe(input.mimeType);
  const signatureOk = hashed.bytes > 0 && psdSignature === '8BPS';
  const errors: string[] = [];
  if (hashed.bytes === 0) errors.push('Local original is empty.');
  else if (!signatureOk) errors.push('Imported PSD is missing PSD 8BPS signature.');
  if (!filenameSafe) errors.push('Catalog filename is unsafe.');
  if (!mimeSafe) errors.push('Catalog MIME type is unsafe.');
  const report: PreflightReport = {
    ok: errors.length === 0,
    preflight: true,
    filename: input.filename,
    mime_type: input.mimeType,
    content_bytes: hashed.bytes,
    content_sha256: hashed.sha256,
    psd_signature: psdSignature,
    psd_signature_ok: signatureOk,
    filename_safe: filenameSafe,
    mime_safe: mimeSafe,
  };
  if (errors.length > 0) report.error = errors.join(' ');
  return report;
}

class WritableDigestSink extends Writable {
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }
}

function filenameIsSafe(value: string): boolean {
  return Boolean(
    value &&
      !/[\\/\x00-\x1F\x7F]/.test(value) &&
      value !== '.' &&
      value !== '..' &&
      sanitizeDownloadFilename(value) === value,
  );
}

function mimeIsSafe(value: string): boolean {
  if (!value || /[\x00-\x1F\x7F]/.test(value)) return false;
  return SAFE_MIME_TYPE.test(value.split(';', 1)[0].trim());
}

function parseArgs(argv: string[]): Args {
  const result: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) usage(`Unknown argument: ${key}`);
    const name = key.slice(2);
    const value = argv[index + 1];
    if (BOOLEAN_FLAGS.has(name) && (!value || value.startsWith('--'))) {
      result[name] = 'true';
      continue;
    }
    if (!value || value.startsWith('--')) usage(`Missing value for ${key}`);
    result[name] = value;
    index += 1;
  }
  return result;
}

export function sourceFromArgs(
  args: Args,
  env: NodeJS.ProcessEnv = process.env,
): EntrySource {
  for (const forbidden of ['gdrive-id', 'dropbox-url', 'url']) {
    if (args[forbidden]) {
      throw new Error(`Unknown argument --${forbidden}; provider identifiers must come from an environment variable.`);
    }
  }
  const provider = args.provider;
  if (!['gdrive', 'dropbox', 'url'].includes(provider)) {
    throw new Error('--provider must be gdrive, dropbox, or url.');
  }
  const envName = args['source-env'];
  if (!envName || !/^[A-Z_][A-Z0-9_]*$/.test(envName)) {
    throw new Error('--source-env environment variable name must use uppercase letters, digits, and underscores.');
  }
  const sourceValue = env[envName]?.trim();
  if (!sourceValue) {
    throw new Error(`Source environment variable ${envName} is not set or is empty.`);
  }
  if (sourceValue.includes('\0')) {
    throw new Error(`Source environment variable ${envName} is invalid.`);
  }
  sensitiveValues.add(sourceValue);
  if (provider === 'gdrive') {
    const fileId = parseGoogleDriveId(sourceValue);
    return { type: 'gdrive', file_id: fileId };
  }
  if (provider === 'dropbox') {
    parseDropboxShareUrl(sourceValue);
    return { type: 'dropbox', share_url: sourceValue };
  }
  return { type: 'url', url: sourceValue };
}

function usage(message: string): never {
  process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    'Usage: npm run publish-asset -- --id <slug> --name <name> --price 0.01 --filename <file.psd> --mime image/vnd.adobe.photoshop --original-file </absolute/path/to/file.psd> --provider <gdrive|dropbox|url> --source-env <ENV_VAR_NAME> [--desc <text>] [--tags psd,proof]\n       npm run publish-asset -- --preflight --filename <file.psd> --mime image/vnd.adobe.photoshop --original-file </absolute/path/to/file.psd>\n',
  );
  process.exit(1);
}

function redactError(value: string): string {
  let redacted = value;
  for (const secret of sensitiveValues) {
    redacted = redacted.split(secret).join('[redacted source]');
  }
  return redacted;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: redactError(error instanceof Error ? error.message : String(error)),
      })}\n`,
    );
    process.exitCode = 1;
  });
}
