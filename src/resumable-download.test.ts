import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

import { createSignedBlobDownload } from './blob-storage';
import { createLocalBlobDownloadHandler, LocalBlobStore } from './local-blob-storage';
import { streamResumableDownload } from './resumable-download';
import type { DownloadResumeState } from './local-delivery';

function state(directory: string, bytes: Buffer): DownloadResumeState {
  return {
    version: 1,
    product_id: 'layout',
    temp_path: path.join(directory, '.layout.part'),
    final_path: path.join(directory, 'layout.psd'),
    bytes_written: 0,
    content_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    content_bytes: bytes.byteLength,
    download_url: 'https://store.private.blob.vercel-storage.com/layout.psd?signature=secret',
    download_expires_at: '2026-08-29T13:00:00.000Z',
    entitlement: 'entitlement',
    etag: '"v1"',
  };
}

test('streamResumableDownload appends a valid 206 range to existing temp bytes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-resume-'));
  const bytes = Buffer.from([0x38, 0x42, 0x50, 0x53, 1, 2, 3, 4]);
  const resume = state(directory, bytes);
  await fs.writeFile(resume.temp_path, bytes.subarray(0, 4), { mode: 0o600 });
  const ranges: Array<{ range: string | null; ifRange: string | null }> = [];

  const result = await streamResumableDownload(
    resume,
    async (_url, init) => {
      const headers = new Headers(init?.headers);
      ranges.push({
        range: headers.get('range'),
        ifRange: headers.get('if-range'),
      });
      return new Response(bytes.subarray(4), {
        status: 206,
        headers: {
          'Content-Range': `bytes 4-7/${bytes.byteLength}`,
          'Content-Length': '4',
          'Content-Type': 'image/vnd.adobe.photoshop',
          ETag: '"v1"',
        },
      });
    },
  );

  assert.deepEqual(ranges, [{ range: 'bytes=4-', ifRange: '"v1"' }]);
  assert.deepEqual(await fs.readFile(resume.temp_path), bytes);
  assert.equal(result.sha256, resume.content_sha256);
  assert.equal(result.bytes, bytes.byteLength);
});

test('streamResumableDownload restarts when ETag changes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-etag-'));
  const bytes = Buffer.from([0x38, 0x42, 0x50, 0x53, 1, 2, 3, 4]);
  const resume = state(directory, bytes);
  await fs.writeFile(resume.temp_path, bytes.subarray(0, 4), { mode: 0o600 });
  let calls = 0;

  const result = await streamResumableDownload(resume, async (_url, init) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(new Headers(init?.headers).get('if-range'), '"v1"');
      return new Response(bytes.subarray(4), {
        status: 206,
        headers: {
          'Content-Range': `bytes 4-7/${bytes.byteLength}`,
          'Content-Length': '4',
          ETag: '"v2"',
        },
      });
    }
    assert.equal(new Headers(init?.headers).get('range'), null);
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Length': String(bytes.byteLength),
        'Content-Type': 'image/vnd.adobe.photoshop',
        ETag: '"v2"',
      },
    });
  });

  assert.equal(calls, 2);
  assert.equal(resume.etag, '"v2"');
  assert.equal(result.sha256, resume.content_sha256);
  assert.deepEqual(await fs.readFile(resume.temp_path), bytes);
});

test('streamResumableDownload restarts after 416 or malformed Content-Range', async () => {
  for (const firstResponse of [
    () => new Response(null, { status: 416 }),
    () => new Response(Buffer.from('nope'), {
      status: 206,
      headers: { 'Content-Range': 'not-a-range' },
    }),
  ]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-range-'));
    const bytes = Buffer.from([0x38, 0x42, 0x50, 0x53, 9, 8, 7, 6]);
    const resume = state(directory, bytes);
    await fs.writeFile(resume.temp_path, bytes.subarray(0, 4), { mode: 0o600 });
    let calls = 0;
    const result = await streamResumableDownload(resume, async () => {
      calls += 1;
      return calls === 1
        ? firstResponse()
        : new Response(bytes, {
            status: 200,
            headers: {
              'Content-Length': String(bytes.byteLength),
              'Content-Type': 'image/vnd.adobe.photoshop',
              ETag: '"fresh"',
            },
          });
    });
    assert.equal(calls, 2);
    assert.equal(result.sha256, resume.content_sha256);
  }
});

test('streamResumableDownload rejects malformed range lengths after restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-malformed-'));
  const bytes = Buffer.from([0x38, 0x42, 0x50, 0x53]);
  const resume = state(directory, bytes);
  resume.etag = undefined;

  await assert.rejects(
    () =>
      streamResumableDownload(
        resume,
        async () =>
          new Response(bytes, {
            status: 206,
            headers: {
              'Content-Range': `bytes 0-3/${bytes.byteLength}`,
              'Content-Length': '3',
            },
          }),
      ),
    /malformed range length/,
  );
});

test('streamResumableDownload rejects malformed full-response Content-Length', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-length-'));
  const bytes = Buffer.from([0x38, 0x42, 0x50, 0x53]);
  const resume = state(directory, bytes);
  resume.etag = undefined;

  await assert.rejects(
    () =>
      streamResumableDownload(
        resume,
        async () =>
          new Response(bytes, {
            status: 200,
            headers: { 'Content-Length': 'not-a-number' },
          }),
      ),
    /malformed Content-Length/,
  );
});

test('streamResumableDownload restarts safely when server ignores Range', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-restart-'));
  const bytes = Buffer.from([0x38, 0x42, 0x50, 0x53, 9, 8, 7, 6]);
  const resume = state(directory, bytes);
  await fs.writeFile(resume.temp_path, bytes.subarray(0, 4), { mode: 0o600 });

  const result = await streamResumableDownload(
    resume,
    async () =>
      new Response(bytes, {
        status: 200,
        headers: {
          'Content-Length': String(bytes.byteLength),
          'Content-Type': 'image/vnd.adobe.photoshop',
        },
      }),
  );

  assert.deepEqual(await fs.readFile(resume.temp_path), bytes);
  assert.equal(result.sha256, resume.content_sha256);
});

test('streamResumableDownload rejects hash drift after a complete stream', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-hash-drift-'));
  const expected = Buffer.from([0x38, 0x42, 0x50, 0x53, 1, 2, 3, 4]);
  const drifted = Buffer.from([0x38, 0x42, 0x50, 0x53, 9, 9, 9, 9]);
  const resume = state(directory, expected);
  resume.etag = undefined;

  await assert.rejects(
    () =>
      streamResumableDownload(
        resume,
        async () =>
          new Response(drifted, {
            status: 200,
            headers: {
              'Content-Length': String(drifted.byteLength),
              'Content-Type': 'image/vnd.adobe.photoshop',
            },
          }),
      ),
    /SHA-256/,
  );
  assert.deepEqual(await fs.readFile(resume.temp_path), drifted);
});

test('streamResumableDownload refuses symlinked partial files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-partial-link-'));
  const bytes = Buffer.from('8BPSdata', 'latin1');
  const resume = state(directory, bytes);
  const target = path.join(directory, 'target');
  await fs.writeFile(target, bytes, { mode: 0o600 });
  await fs.symlink(target, resume.temp_path);

  await assert.rejects(
    () =>
      streamResumableDownload(
        resume,
        async () => {
          throw new Error('network must not run');
        },
      ),
    /non-symlink/,
  );
});

test('disconnects at multiple byte offsets resume through the local blob server to identical bytes', async () => {
  const nowMs = 1_700_000_000_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-drill-blob-'));
  const store = new LocalBlobStore({
    rootDirectory: root,
    baseUrl: 'http://localhost:0',
    signingSecret: crypto.randomBytes(32),
    clock: () => nowMs,
  });
  const payload = Buffer.concat([Buffer.from('8BPS'), crypto.randomBytes(99_996)]);
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
  const pathname = `assets/sha256/${sha256}/drill.psd`;
  await store.put(pathname, payload, {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: 'image/vnd.adobe.photoshop',
    multipart: false,
  });

  const app = express();
  const handler = createLocalBlobDownloadHandler(store);
  app.get('/local-blob/*', handler);
  app.head('/local-blob/*', handler);
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as { port: number };

  const signed = await createSignedBlobDownload(pathname, store, nowMs);
  const signedUrl = new URL(signed.url);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'curatoria-drill-part-'));
  const resume: DownloadResumeState = {
    version: 1,
    product_id: 'drill',
    temp_path: path.join(directory, '.drill.part'),
    final_path: path.join(directory, 'drill.psd'),
    bytes_written: 0,
    content_sha256: sha256,
    content_bytes: payload.byteLength,
    download_url: `http://127.0.0.1:${port}${signedUrl.pathname}${signedUrl.search}`,
    download_expires_at: new Date(nowMs + 60_000).toISOString(),
    entitlement: 'entitlement',
  };

  // Each entry is the number of body bytes allowed through before the
  // connection "drops": immediately, after the first byte, mid-file twice,
  // and one byte before the end. Odd attempts end cleanly-short; even
  // attempts destroy the stream, covering both disconnect shapes.
  const cuts = [0, 1, 24_999, 35_000, payload.byteLength - 1 - 61_000];
  let attempt = 0;
  let rangedResponses = 0;
  const cuttingFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await fetch(input, init);
    if (response.status === 206) rangedResponses += 1;
    const allowed = attempt < cuts.length ? cuts[attempt] : Number.POSITIVE_INFINITY;
    const failCleanly = attempt % 2 === 0;
    attempt += 1;
    if (!Number.isFinite(allowed)) return response;
    const source = response.body;
    if (!source) return response;
    const reader = source.getReader();
    let delivered = 0;
    const limited = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (delivered >= allowed) {
          await reader.cancel();
          if (failCleanly) controller.close();
          else controller.error(new Error('socket hang up'));
          return;
        }
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        const remaining = allowed - delivered;
        const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
        delivered += chunk.byteLength;
        controller.enqueue(chunk);
        if (delivered >= allowed) {
          await reader.cancel();
          if (failCleanly) controller.close();
          else controller.error(new Error('socket hang up'));
        }
      },
      async cancel() {
        await reader.cancel();
      },
    });
    return new Response(limited, { status: response.status, headers: response.headers });
  }) as typeof fetch;

  try {
    for (let index = 0; index < cuts.length; index += 1) {
      await assert.rejects(
        () => streamResumableDownload(resume, cuttingFetch),
        /ended at|socket hang up/i,
        `disconnect at scheduled cut ${index}`,
      );
    }
    const result = await streamResumableDownload(resume, cuttingFetch);
    assert.equal(result.bytes, payload.byteLength);
    assert.equal(result.sha256, sha256);
    assert.equal(result.mimeType, 'image/vnd.adobe.photoshop');
    // An errored stream may discard its last enqueued chunk, so one early cut
    // can restart from zero instead of resuming; at least three attempts must
    // still resume with 206 for the drill to prove Range continuation.
    assert.ok(rangedResponses >= 3, `expected resumed 206 responses, saw ${rangedResponses}`);
    const saved = await fs.readFile(resume.temp_path);
    assert.deepEqual(saved, payload);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  }
});
