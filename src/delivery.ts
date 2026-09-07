import type { Response } from 'express';

import { ResolvedResource } from './sources';

const FALLBACK_DOWNLOAD_NAME = 'curatoria-download';

function basenameForDownload(input: string): string {
  return input.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
}

export function sanitizeDownloadFilename(input: string | undefined, fallback = FALLBACK_DOWNLOAD_NAME): string {
  const candidate = basenameForDownload(input ?? '');
  const safe = candidate
    .replace(/[\x00-\x1F\x7F<>:"/\\|?*]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/-+(\.[A-Za-z0-9]{1,12})$/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '');

  if (!safe || safe === '.' || safe === '..') {
    return sanitizeDownloadFilename(fallback, FALLBACK_DOWNLOAD_NAME);
  }

  return safe;
}

export function contentDispositionAttachment(filename: string): string {
  const safeFilename = sanitizeDownloadFilename(filename);
  const asciiFilename = safeFilename
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_');

  return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`;
}

export function normalizeDownloadMimeType(mimeType: string | null | undefined): string {
  const mediaType = (mimeType ?? '').split(';', 1)[0].trim().toLowerCase();
  return mediaType || 'application/octet-stream';
}

export function setPaidResourceHeaders(
  res: Response,
  resource: ResolvedResource,
  metadata: { id: string; name: string; contentSha256?: string },
): Response {
  const filename = sanitizeDownloadFilename(resource.filename, metadata.id);
  const response = res
    .setHeader('Cache-Control', 'private, no-store')
    .setHeader('Pragma', 'no-cache')
    .setHeader('Content-Type', normalizeDownloadMimeType(resource.mimeType))
    .setHeader('Content-Length', String(resource.buffer.byteLength))
    .setHeader('Content-Disposition', contentDispositionAttachment(filename))
    .setHeader('X-Design-System-Id', metadata.id)
    .setHeader('X-Design-System-Name', metadata.name)
    .setHeader('X-Design-System-Version', '1.0.0')
    .setHeader('X-Storage-Source', resource.sourceType);

  if (metadata.contentSha256) {
    response.setHeader('X-Content-Sha256', metadata.contentSha256);
  }

  return response;
}
