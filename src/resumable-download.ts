import crypto from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';

import {
  assertOwnerOnlyRegularFile,
  type DownloadResumeState,
} from './local-delivery';
import { normalizeDownloadMimeType } from './delivery';

export type ResumableDownloadResult = {
  bytes: number;
  sha256: string;
  mimeType: string;
};

export async function streamResumableDownload(
  state: DownloadResumeState,
  fetchImpl: typeof fetch = fetch,
): Promise<ResumableDownloadResult> {
  let existingBytes = await partialFileSize(state.temp_path);
  if (existingBytes > state.content_bytes) {
    throw new Error('Resume temp file is larger than the expected paid asset.');
  }

  let response = await requestDownload(
    state,
    existingBytes,
    fetchImpl,
  );
  if (existingBytes > 0 && shouldRestartResponse(response, state, existingBytes)) {
    existingBytes = 0;
    state.bytes_written = 0;
    state.etag = undefined;
    response = await requestDownload(state, 0, fetchImpl);
  }
  if (!response.ok) {
    throw new Error(`Signed download returned ${response.status} ${response.statusText}.`);
  }
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') {
    throw new Error(`Signed download used unsupported content-encoding "${encoding}".`);
  }

  let append = existingBytes > 0 && response.status === 206;
  if (response.status === 206) {
    const range = parseContentRange(response.headers.get('content-range'));
    if (
      !range ||
      range.start !== existingBytes ||
      range.total !== state.content_bytes ||
      range.end < range.start ||
      range.end >= range.total
    ) {
      throw new Error('Signed download returned a mismatched Content-Range.');
    }
    const declared = parseContentLength(response.headers.get('content-length'));
    if (declared !== undefined && declared !== range.end - range.start + 1) {
      throw new Error('Signed download returned a malformed range length.');
    }
  } else if (response.status === 200) {
    const declared = parseContentLength(response.headers.get('content-length'));
    if (declared !== undefined && declared !== state.content_bytes) {
      throw new Error('Signed download Content-Length does not match the paid asset.');
    }
    append = false;
    existingBytes = 0;
  } else {
    throw new Error(`Signed download returned unsupported status ${response.status}.`);
  }
  const responseEtag = response.headers.get('etag');
  if (responseEtag) state.etag = responseEtag;

  const hash = crypto.createHash('sha256');
  if (append) {
    await hashExistingFile(state.temp_path, hash);
  }

  const handle = await openPartialForWrite(state.temp_path, append);
  let totalBytes = existingBytes;
  try {
    if (!response.body) throw new Error('Signed download response had no body.');
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      const bytes = Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      state.bytes_written = totalBytes;
      if (totalBytes > state.content_bytes) {
        throw new Error('Signed download exceeded the catalog byte count.');
      }
      hash.update(bytes);
      await handle.write(bytes);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (totalBytes !== state.content_bytes) {
    throw new Error(
      `Signed download ended at ${totalBytes} bytes; expected ${state.content_bytes}.`,
    );
  }
  const digest = hash.digest('hex');
  if (digest !== state.content_sha256) {
    throw new Error(
      `Signed download SHA-256 ${digest} does not match ${state.content_sha256}.`,
    );
  }
  return {
    bytes: totalBytes,
    sha256: digest,
    mimeType: normalizeDownloadMimeType(response.headers.get('content-type')),
  };
}

async function requestDownload(
  state: DownloadResumeState,
  existingBytes: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/octet-stream,*/*;q=0.8',
    'Accept-Encoding': 'identity',
  };
  if (existingBytes > 0) {
    headers.Range = `bytes=${existingBytes}-`;
    if (state.etag) headers['If-Range'] = state.etag;
  }
  return fetchImpl(state.download_url, { headers });
}

function shouldRestartResponse(
  response: Response,
  state: DownloadResumeState,
  existingBytes: number,
): boolean {
  if (response.status === 416) return true;
  if (response.status === 200) return false;
  if (response.status !== 206) return false;
  const range = parseContentRange(response.headers.get('content-range'));
  const etag = response.headers.get('etag');
  return (
    !range ||
    range.start !== existingBytes ||
    range.total !== state.content_bytes ||
    range.end < range.start ||
    range.end >= range.total ||
    Boolean(state.etag && etag !== state.etag)
  );
}

async function partialFileSize(filePath: string): Promise<number> {
  try {
    await assertOwnerOnlyRegularFile(filePath, 'Download partial');
    return (await fs.lstat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function openPartialForWrite(
  filePath: string,
  append: boolean,
): Promise<fs.FileHandle> {
  try {
    await assertOwnerOnlyRegularFile(filePath, 'Download partial');
    const handle = await fs.open(
      filePath,
      fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW |
        (append ? fsConstants.O_APPEND : 0),
    );
    if (!append) await handle.truncate(0);
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return fs.open(
      filePath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
  }
}

async function hashExistingFile(
  filePath: string,
  hash: ReturnType<typeof crypto.createHash>,
): Promise<void> {
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
}

function parseContentRange(
  value: string | null,
): { start: number; end: number; total: number } | undefined {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
  if (!match) return undefined;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: Number(match[3]),
  };
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error('Signed download returned malformed Content-Length.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('Signed download returned malformed Content-Length.');
  }
  return parsed;
}
