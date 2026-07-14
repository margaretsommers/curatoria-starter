import test from 'node:test';
import assert from 'node:assert/strict';

import {
  contentDispositionAttachment,
  normalizeDownloadMimeType,
  sanitizeDownloadFilename,
  setPaidResourceHeaders,
} from './delivery';
import { ResolvedResource } from './sources';

function createHeaderRecorder(): {
  headers: Record<string, string>;
  res: { setHeader(name: string, value: string): unknown };
} {
  const headers: Record<string, string> = {};
  const res = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
  };
  return { headers, res };
}

test('sanitizeDownloadFilename strips paths and unsafe characters deterministically', () => {
  assert.equal(sanitizeDownloadFilename('../nested/../Design System: v1?.zip'), 'Design System- v1.zip');
  assert.equal(sanitizeDownloadFilename(''), 'curatoria-download');
  assert.equal(sanitizeDownloadFilename('../../', 'fallback.md'), 'fallback.md');
});

test('contentDispositionAttachment emits safe ASCII and RFC 5987 filenames', () => {
  const header = contentDispositionAttachment('Résumé "Brand".md');

  assert.match(header, /^attachment; filename="R_sum_ -Brand.md"; filename\*=UTF-8''/);
  assert.match(header, /R%C3%A9sum%C3%A9%20-Brand.md$/);
});

test('normalizeDownloadMimeType strips response parameters from source metadata', () => {
  assert.equal(normalizeDownloadMimeType('application/pdf; charset=utf-8'), 'application/pdf');
  assert.equal(normalizeDownloadMimeType('Text/Markdown; Charset=UTF-8'), 'text/markdown');
  assert.equal(normalizeDownloadMimeType(undefined), 'application/octet-stream');
});

test('setPaidResourceHeaders preserves raw MIME and content length for binary downloads', () => {
  const { headers, res } = createHeaderRecorder();
  const resource: ResolvedResource = {
    buffer: Buffer.from([0, 1, 2, 3, 4]),
    mimeType: 'application/zip; charset=utf-8',
    filename: '../../unsafe bundle.zip',
    sourceType: 'url',
  };

  setPaidResourceHeaders(res as never, resource, {
    id: 'bundle-id',
    name: 'Bundle Name',
    contentSha256: 'a'.repeat(64),
  });

  assert.equal(headers['content-type'], 'application/zip');
  assert.equal(headers['content-length'], '5');
  assert.equal(headers['cache-control'], 'private, no-store');
  assert.equal(headers['pragma'], 'no-cache');
  assert.match(headers['content-disposition'], /^attachment; filename="unsafe bundle.zip"/);
  assert.equal(headers['x-design-system-id'], 'bundle-id');
  assert.equal(headers['x-storage-source'], 'url');
  assert.equal(headers['x-content-sha256'], 'a'.repeat(64));
  assert.equal(headers['content-type'].includes('charset'), false);
});

test('setPaidResourceHeaders gives markdown downloads attachment and byte length', () => {
  const { headers, res } = createHeaderRecorder();
  const resource: ResolvedResource = {
    buffer: Buffer.from('# Brand\n'),
    mimeType: 'text/markdown',
    filename: 'brand.md',
    sourceType: 'local',
  };

  setPaidResourceHeaders(res as never, resource, { id: 'brand', name: 'Brand' });

  assert.equal(headers['content-type'], 'text/markdown');
  assert.equal(headers['content-length'], '8');
  assert.match(headers['content-disposition'], /^attachment; filename="brand.md"/);
});
