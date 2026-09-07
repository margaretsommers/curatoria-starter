/**
 * local-blob-storage.ts — filesystem-backed BlobSdkAdapter for creators without
 * a Vercel account.
 *
 * Objects live under `<root>/objects/<pathname>` with a JSON metadata sidecar
 * under `<root>/meta/<pathname>.json`. Signed downloads are HMAC-authenticated
 * URLs served by this same Express app at `/local-blob/<pathname>`, so the
 * downloader's signed-URL contract (HEAD, Range, If-Range, 416, expiry) works
 * against local disk exactly as it does against private Vercel Blob.
 *
 * This adapter assumes a single local process. It is never selected in
 * production, where private Vercel Blob remains required.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { RequestHandler } from 'express';

import type {
  BlobSdkAdapter,
  PresignGetOptions,
  PrivateBlobPutOptions,
  SignedToken,
  SignedTokenOptions,
} from './blob-storage';
import { sanitizeDownloadFilename } from './delivery';
import { resolvePathWithin } from './paths';

export const LOCAL_BLOB_ROUTE_PREFIX = '/local-blob';
const MIN_SIGNING_SECRET_BYTES = 32;
const MAX_PATHNAME_LENGTH = 1024;
const PATHNAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type LocalBlobStoreOptions = {
  rootDirectory: string;
  /** Origin for presigned URLs; a function defers it to first use (tests bind an ephemeral port after construction). */
  baseUrl: string | (() => string);
  signingSecret: Buffer | string;
  clock?: () => number;
};

type ObjectMetadata = {
  contentType: string;
  etag: string;
  size: number;
};

export function assertLocalBlobPathname(pathname: string): string {
  if (
    typeof pathname !== 'string' ||
    !pathname ||
    pathname.length > MAX_PATHNAME_LENGTH ||
    pathname.includes('\\')
  ) {
    throw new Error('Local Blob pathname is invalid.');
  }
  const segments = pathname.split('/');
  for (const segment of segments) {
    if (!PATHNAME_SEGMENT.test(segment) || segment === '..') {
      throw new Error('Local Blob pathname is invalid.');
    }
  }
  return pathname;
}

function notFoundError(): Error {
  return Object.assign(new Error('Local Blob object was not found.'), {
    statusCode: 404,
    code: 'BLOB_NOT_FOUND',
  });
}

function conflictError(): Error {
  return Object.assign(new Error('Local Blob object already exists.'), {
    statusCode: 409,
    code: 'BLOB_ALREADY_EXISTS',
  });
}

export class LocalBlobStore implements BlobSdkAdapter {
  private readonly root: string;
  private readonly resolveBaseUrl: () => string;
  private readonly secret: Buffer;
  private readonly clock: () => number;

  constructor(options: LocalBlobStoreOptions) {
    this.root = path.resolve(options.rootDirectory);
    const configured = options.baseUrl;
    this.resolveBaseUrl = () => {
      const value = (typeof configured === 'function' ? configured() : configured).replace(
        /\/$/,
        '',
      );
      if (!/^https?:\/\//.test(value)) {
        throw new Error('Local Blob base URL must be an absolute http(s) origin.');
      }
      return value;
    };
    this.secret = Buffer.isBuffer(options.signingSecret)
      ? options.signingSecret
      : Buffer.from(options.signingSecret, 'utf8');
    if (this.secret.byteLength < MIN_SIGNING_SECRET_BYTES) {
      throw new Error('Local Blob signing secret must contain at least 32 bytes.');
    }
    if (typeof configured === 'string') this.resolveBaseUrl();
    this.clock = options.clock ?? (() => Date.now());
    // resolvePathWithin requires an existing base directory for its
    // symlink-safe realpath check, so create the store layout eagerly.
    mkdirSync(path.join(this.root, 'objects'), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(this.root, 'meta'), { recursive: true, mode: 0o700 });
  }

  private objectPath(pathname: string): string {
    assertLocalBlobPathname(pathname);
    return resolvePathWithin(path.join(this.root, 'objects'), pathname, 'local Blob objects');
  }

  private metaPath(pathname: string): string {
    assertLocalBlobPathname(pathname);
    return resolvePathWithin(
      path.join(this.root, 'meta'),
      `${pathname}.json`,
      'local Blob metadata',
    );
  }

  downloadUrlPath(pathname: string): string {
    assertLocalBlobPathname(pathname);
    return `${LOCAL_BLOB_ROUTE_PREFIX}/${pathname
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/')}`;
  }

  sign(pathname: string, validUntil: number): string {
    assertLocalBlobPathname(pathname);
    if (!Number.isSafeInteger(validUntil) || validUntil <= 0) {
      throw new Error('Local Blob signature requires a positive expiry timestamp.');
    }
    return crypto
      .createHmac('sha256', this.secret)
      .update(`curatoria-local-blob\0get\0${pathname}\0${validUntil}`)
      .digest('hex');
  }

  verifySignature(pathname: string, validUntil: number, signature: string): boolean {
    try {
      const expected = this.sign(pathname, validUntil);
      const provided = String(signature);
      if (provided.length !== expected.length) return false;
      return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
    } catch {
      return false;
    }
  }

  now(): number {
    return this.clock();
  }

  async put(
    pathname: string,
    body: Uint8Array | Readable,
    options: PrivateBlobPutOptions,
  ): Promise<{ pathname: string; url: string; etag?: string }> {
    if (options.access !== 'private' || options.allowOverwrite) {
      throw new Error('Local Blob store only supports private immutable writes.');
    }
    const objectPath = this.objectPath(pathname);
    const metaPath = this.metaPath(pathname);
    await fs.mkdir(path.dirname(objectPath), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.dirname(metaPath), { recursive: true, mode: 0o700 });

    const temporaryPath = `${objectPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const hash = crypto.createHash('sha256');
    let size = 0;
    const handle = await fs.open(temporaryPath, 'wx', 0o600);
    try {
      const source = body instanceof Uint8Array ? Readable.from([Buffer.from(body)]) : body;
      for await (const chunk of source) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(value);
        size += value.byteLength;
        await handle.write(value);
      }
      await handle.sync();
    } catch (error) {
      await handle.close();
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
    await handle.close();

    const etag = hash.digest('hex');
    const metadata: ObjectMetadata = { contentType: options.contentType, etag, size };
    const metaTemporaryPath = `${metaPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      // Establish exclusive ownership of the pathname first via the hard link,
      // which fails atomically with EEXIST on conflict. Only a writer that
      // wins this link may commit metadata afterward — otherwise a losing
      // concurrent writer could overwrite the winner's already-published
      // metadata with its own (unlinked, about-to-be-discarded) values.
      await fs.link(temporaryPath, objectPath);
      await fs.writeFile(metaTemporaryPath, `${JSON.stringify(metadata)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      await fs.rename(metaTemporaryPath, metaPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      await fs.rm(metaTemporaryPath, { force: true });
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw conflictError();
      }
      throw error;
    }
    await fs.rm(temporaryPath, { force: true });
    return { pathname, url: `${this.resolveBaseUrl()}${this.downloadUrlPath(pathname)}`, etag };
  }

  async head(pathname: string): Promise<{
    pathname: string;
    size: number;
    contentType?: string;
    etag: string;
  }> {
    const metadata = await this.readMetadata(pathname);
    return {
      pathname,
      size: metadata.size,
      contentType: metadata.contentType,
      etag: metadata.etag,
    };
  }

  async read(pathname: string): Promise<{
    body: Readable;
    pathname: string;
    size: number;
    contentType: string;
    etag: string;
  }> {
    const metadata = await this.readMetadata(pathname);
    const body = createReadStream(this.objectPath(pathname));
    return {
      body,
      pathname,
      size: metadata.size,
      contentType: metadata.contentType,
      etag: metadata.etag,
    };
  }

  async readMetadata(pathname: string): Promise<ObjectMetadata> {
    const objectPath = this.objectPath(pathname);
    const metaPath = this.metaPath(pathname);
    let raw: string;
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(objectPath);
      raw = await fs.readFile(metaPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFoundError();
      throw error;
    }
    let metadata: Partial<ObjectMetadata>;
    try {
      metadata = JSON.parse(raw) as Partial<ObjectMetadata>;
    } catch {
      throw new Error('Local Blob metadata is not valid JSON.');
    }
    if (
      typeof metadata.contentType !== 'string' ||
      !metadata.contentType ||
      typeof metadata.etag !== 'string' ||
      !/^[a-f0-9]{64}$/.test(metadata.etag) ||
      !Number.isSafeInteger(metadata.size) ||
      Number(metadata.size) < 0 ||
      stat.size !== metadata.size
    ) {
      throw new Error('Local Blob metadata does not match the stored object.');
    }
    return metadata as ObjectMetadata;
  }

  openObjectStream(pathname: string, range?: { start: number; end: number }): Readable {
    return createReadStream(this.objectPath(pathname), range);
  }

  async issueSignedToken(options: SignedTokenOptions): Promise<SignedToken> {
    if (options.operations.length !== 1 || options.operations[0] !== 'get') {
      throw new Error('Local Blob signed tokens only support get.');
    }
    const signature = this.sign(options.pathname, options.validUntil);
    return {
      delegationToken: signature,
      clientSigningToken: signature,
      validUntil: options.validUntil,
    };
  }

  async presignUrl(
    token: Pick<SignedToken, 'delegationToken' | 'clientSigningToken'>,
    options: PresignGetOptions,
  ): Promise<{ presignedUrl: string }> {
    if (options.operation !== 'get' || options.access !== 'private') {
      throw new Error('Local Blob presigning only supports private get.');
    }
    if (!this.verifySignature(options.pathname, options.validUntil, token.delegationToken)) {
      throw new Error('Local Blob presign token does not match the requested object.');
    }
    const signature = this.sign(options.pathname, options.validUntil);
    return {
      presignedUrl: `${this.resolveBaseUrl()}${this.downloadUrlPath(options.pathname)}?exp=${
        options.validUntil
      }&sig=${signature}`,
    };
  }
}

type ParsedRange = { start: number; end: number } | 'unsatisfiable' | undefined;

function parseRangeHeader(header: string | undefined, size: number): ParsedRange {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined;
    if (size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined;
  if (start >= size) return 'unsatisfiable';
  if (end < start) return undefined;
  return { start, end: Math.min(end, size - 1) };
}

export function createLocalBlobDownloadHandler(store: LocalBlobStore): RequestHandler {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    const rawPathname = (req.params as Record<string, string>)[0] ?? '';
    let pathname: string;
    try {
      pathname = assertLocalBlobPathname(rawPathname);
    } catch {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const expiry = Number(req.query.exp);
    const signature = typeof req.query.sig === 'string' ? req.query.sig : '';
    if (!store.verifySignature(pathname, expiry, signature)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (store.now() > expiry) {
      res.status(403).json({ error: 'Signed download URL has expired' });
      return;
    }
    let metadata: ObjectMetadata;
    try {
      metadata = await store.readMetadata(pathname);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode === 404 ? 404 : 500;
      res.status(status).json({ error: status === 404 ? 'Not found' : 'Local Blob read failed' });
      return;
    }

    const etagHeader = `"${metadata.etag}"`;
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', etagHeader);
    res.setHeader('Content-Type', metadata.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${sanitizeDownloadFilename(
        path.posix.basename(pathname),
        'curatoria-asset.bin',
      )}"`,
    );

    const ifRange = req.headers['if-range'];
    const rangeApplies =
      !ifRange || ifRange === etagHeader || ifRange === metadata.etag;
    const range = rangeApplies
      ? parseRangeHeader(req.headers.range as string | undefined, metadata.size)
      : undefined;

    if (range === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${metadata.size}`);
      res.status(416).end();
      return;
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : metadata.size - 1;
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${metadata.size}`);
      res.setHeader('Content-Length', String(end - start + 1));
    } else {
      res.status(200);
      res.setHeader('Content-Length', String(metadata.size));
    }
    if (req.method === 'HEAD' || metadata.size === 0) {
      res.end();
      return;
    }
    const stream = store.openObjectStream(pathname, { start, end });
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Local Blob read failed' });
        return;
      }
      res.destroy();
    });
    res.on('close', () => {
      stream.destroy();
    });
    stream.pipe(res);
  };
}
