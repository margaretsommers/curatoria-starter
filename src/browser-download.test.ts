import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

type BrowserTesting = {
  configureStatusElement(element: { setAttribute(name: string, value: string): void }): void;
  validateEntitlementMetadata(
    candidate: Record<string, unknown>,
    expected: Record<string, unknown>,
    redemption: boolean,
  ): void;
  fulfillPaidEntitlement(
    purchase: Record<string, unknown>,
    entry: Record<string, unknown>,
    status: Record<string, unknown>,
    accessUrl: string,
    fetchImpl: typeof fetch,
    saveImpl: (response: Response) => Promise<void>,
  ): Promise<void>;
  rememberPaidEntitlement(
    entry: Record<string, unknown>,
    accessUrl: string,
    purchase: Record<string, unknown>,
  ): void;
  rememberedPaidEntitlement(
    entry: Record<string, unknown>,
    accessUrl: string,
  ): Record<string, unknown> | undefined;
  completionWording: string;
  states: string[];
  readBoundedResponse(response: Response, limit: number): Promise<Uint8Array>;
  downloadByteLimit(): number;
  sanitizePaymentResponse(value: string): {
    transaction: string;
    network: string;
    payer: string;
  };
  setDownloadState(
    element: { textContent: string; dataset: Record<string, string>; focus?(): void },
    state: string,
    message: string,
    focusError?: boolean,
  ): void;
  validateDownloadBounds(
    declaredLength: number,
    expectedLength: number,
    limit: number,
  ): void;
  createBrowserReceipt(input: {
    purchase: Record<string, unknown>;
    actualSha256: string;
    actualBytes: number;
    psd8bps: boolean;
  }): Promise<Record<string, unknown>>;
};

function loadBrowserTesting(): BrowserTesting {
  const source = fs.readFileSync(path.join(__dirname, '../public/download.js'), 'utf8');
  const context = {
    document: { querySelector: () => null },
    window: { location: { origin: 'https://curatoria.dev' } },
    TextDecoder,
    TextEncoder,
    Uint8Array,
    atob: globalThis.atob,
    crypto: globalThis.crypto,
    URL,
    globalThis: undefined as unknown,
  } as vm.Context & { curatoriaDownloadTesting?: BrowserTesting };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.curatoriaDownloadTesting as BrowserTesting;
}

test('browser download status is announced and does not overclaim disk completion', () => {
  const testing = loadBrowserTesting();
  const attributes = new Map<string, string>();
  testing.configureStatusElement({
    setAttribute(name, value) {
      attributes.set(name, value);
    },
  });

  assert.equal(attributes.get('role'), 'status');
  assert.equal(attributes.get('aria-live'), 'polite');
  assert.equal(attributes.get('aria-atomic'), 'true');
  assert.match(testing.completionWording, /download triggered/i);
  assert.match(testing.completionWording, /local verification is still required/i);
  assert.doesNotMatch(testing.completionWording, /saved successfully|download complete/i);
});

test('browser receipt requires PAYMENT-RESPONSE transaction to match signed purchase', async () => {
  const testing = loadBrowserTesting();
  const purchase = {
    receipt_id: `rcpt_${'r'.repeat(43)}`,
    product_id: 'layout',
    source_provider: 'gdrive',
    network: 'eip155:8453',
    payer: '0x2222222222222222222222222222222222222222',
    transaction: `0x${'c'.repeat(64)}`,
    entitlement: 'signed-entitlement',
    filename: 'layout.psd',
    mime_type: 'image/vnd.adobe.photoshop',
    content_sha256: 'a'.repeat(64),
    content_bytes: 8,
    payment_response_metadata: {
      transaction: `0x${'d'.repeat(64)}`,
      network: 'eip155:8453',
      payer: '0x2222222222222222222222222222222222222222',
    },
  };
  await assert.rejects(
    () =>
      testing.createBrowserReceipt({
        purchase,
        actualSha256: 'a'.repeat(64),
        actualBytes: 8,
        psd8bps: true,
      }),
    /does not match/,
  );
});

test('browser entitlement metadata validation rejects malformed hashes and byte counts', () => {
  const testing = loadBrowserTesting();
  const expected = {
    id: 'layout',
    download_filename: 'layout.psd',
    mime_type: 'image/vnd.adobe.photoshop',
    content_sha256: 'a'.repeat(64),
    content_bytes: 8,
  };
  const candidate = {
    receipt_id: `rcpt_${'r'.repeat(43)}`,
    product_id: 'layout',
    source_provider: 'gdrive',
    network: 'eip155:8453',
    payer: '0x2222222222222222222222222222222222222222',
    transaction: `0x${'c'.repeat(64)}`,
    entitlement: 'token',
    redeem_url: '/assets/layout/redeem',
    filename: 'layout.psd',
    mime_type: 'image/vnd.adobe.photoshop',
    content_sha256: 'a'.repeat(64),
    content_bytes: 8,
  };

  assert.doesNotThrow(() =>
    testing.validateEntitlementMetadata(candidate, expected, false),
  );
  assert.throws(
    () =>
      testing.validateEntitlementMetadata(
        { ...candidate, content_sha256: 'not-a-hash' },
        expected,
        false,
      ),
    /incomplete/,
  );
  assert.throws(
    () =>
      testing.validateEntitlementMetadata(
        { ...candidate, content_bytes: 0 },
        expected,
        false,
      ),
    /incomplete/,
  );
});

test('browser retries redemption, download, and hash failures without losing entitlement', async () => {
  const testing = loadBrowserTesting();
  const accessUrl = 'https://curatoria.dev/assets/layout/purchase';
  const entry = {
    id: 'layout',
    download_filename: 'layout.psd',
    mime_type: 'image/vnd.adobe.photoshop',
    content_sha256: 'a'.repeat(64),
    content_bytes: 8,
  };
  const purchase = {
    receipt_id: `rcpt_${'r'.repeat(43)}`,
    product_id: 'layout',
    source_provider: 'gdrive',
    network: 'eip155:8453',
    payer: '0x2222222222222222222222222222222222222222',
    transaction: `0x${'c'.repeat(64)}`,
    entitlement: 'memory-only-token',
    redeem_url: '/assets/layout/redeem',
    filename: 'layout.psd',
    mime_type: 'image/vnd.adobe.photoshop',
    content_sha256: 'a'.repeat(64),
    content_bytes: 8,
  };
  testing.rememberPaidEntitlement(entry, accessUrl, purchase);

  let redemptionCalls = 0;
  let downloadCalls = 0;
  let saveCalls = 0;
  const status = { textContent: '', dataset: {} };
  const fetchImpl = (async input => {
    const url = String(input);
    if (url.includes('/redeem')) {
      redemptionCalls += 1;
      return Response.json({
        product_id: 'layout',
        download_url:
          redemptionCalls === 1
            ? 'https://private.blob.vercel-storage.com/expired'
            : 'https://private.blob.vercel-storage.com/fresh',
        filename: 'layout.psd',
        mime_type: 'image/vnd.adobe.photoshop',
        content_sha256: 'a'.repeat(64),
        content_bytes: 8,
      });
    }
    downloadCalls += 1;
    return url.endsWith('/expired')
      ? new Response(null, { status: 403 })
      : new Response('8BPSdata', {
          status: 200,
          headers: { 'content-type': 'image/vnd.adobe.photoshop' },
        });
  }) as typeof fetch;
  const saveImpl = async () => {
    saveCalls += 1;
    if (saveCalls === 1) throw new Error('Downloaded bytes did not match the catalog SHA-256.');
  };

  await assert.rejects(
    () =>
      testing.fulfillPaidEntitlement(
        purchase,
        entry,
        status,
        accessUrl,
        fetchImpl,
        saveImpl,
      ),
    /download failed with 403/i,
  );
  assert.equal(testing.rememberedPaidEntitlement(entry, accessUrl), purchase);
  await assert.rejects(
    () =>
      testing.fulfillPaidEntitlement(
        purchase,
        entry,
        status,
        accessUrl,
        fetchImpl,
        saveImpl,
      ),
    /SHA-256/,
  );
  assert.equal(testing.rememberedPaidEntitlement(entry, accessUrl), purchase);
  await testing.fulfillPaidEntitlement(
    purchase,
    entry,
    status,
    accessUrl,
    fetchImpl,
    saveImpl,
  );

  assert.equal(redemptionCalls, 3);
  assert.equal(downloadCalls, 3);
  assert.equal(saveCalls, 2);
  assert.equal(testing.rememberedPaidEntitlement(entry, accessUrl), purchase);
  const source = fs.readFileSync(path.join(__dirname, '../public/download.js'), 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});

test('blocked browser save surfaces a failure, keeps the entitlement, and never claims completion', async () => {
  const testing = loadBrowserTesting();
  const accessUrl = 'https://curatoria.dev/assets/layout/purchase';
  const entry = {
    id: 'layout',
    download_filename: 'layout.psd',
    mime_type: 'image/vnd.adobe.photoshop',
    content_sha256: 'a'.repeat(64),
    content_bytes: 8,
  };
  const purchase = {
    receipt_id: `rcpt_${'r'.repeat(43)}`,
    product_id: 'layout',
    source_provider: 'gdrive',
    network: 'eip155:8453',
    payer: '0x2222222222222222222222222222222222222222',
    transaction: `0x${'c'.repeat(64)}`,
    entitlement: 'memory-only-token',
    redeem_url: '/assets/layout/redeem',
    filename: 'layout.psd',
    mime_type: 'image/vnd.adobe.photoshop',
    content_sha256: 'a'.repeat(64),
    content_bytes: 8,
  };
  testing.rememberPaidEntitlement(entry, accessUrl, purchase);

  const status = { textContent: '', dataset: {} as Record<string, string> };
  const fetchImpl = (async input => {
    const url = String(input);
    if (url.includes('/redeem')) {
      return Response.json({
        product_id: 'layout',
        download_url: 'https://private.blob.vercel-storage.com/fresh',
        filename: 'layout.psd',
        mime_type: 'image/vnd.adobe.photoshop',
        content_sha256: 'a'.repeat(64),
        content_bytes: 8,
      });
    }
    return new Response('8BPSdata', {
      status: 200,
      headers: { 'content-type': 'image/vnd.adobe.photoshop' },
    });
  }) as typeof fetch;
  // The browser cannot observe a silently blocked anchor download, so the only
  // detectable block is the save step throwing (popup/download policy,
  // revoked object URL, disabled programmatic clicks). That failure must
  // propagate, keep the paid entitlement for a free retry, and leave no
  // completion claim behind.
  const saveImpl = async () => {
    throw new Error('The browser blocked the download.');
  };

  await assert.rejects(
    () =>
      testing.fulfillPaidEntitlement(purchase, entry, status, accessUrl, fetchImpl, saveImpl),
    /blocked/i,
  );
  assert.equal(testing.rememberedPaidEntitlement(entry, accessUrl), purchase);
  assert.doesNotMatch(status.textContent, /download triggered|verified|complete/i);
  assert.notEqual(status.textContent, testing.completionWording);
});

test('expired remembered entitlement is removed and requires a fresh explicit action', async () => {
  const testing = loadBrowserTesting();
  const accessUrl = 'https://curatoria.dev/assets/layout/purchase';
  const entry = {
    id: 'layout',
    download_filename: 'layout.psd',
    mime_type: 'image/vnd.adobe.photoshop',
    content_sha256: 'a'.repeat(64),
    content_bytes: 8,
  };
  const purchase = {
    receipt_id: `rcpt_${'r'.repeat(43)}`,
    product_id: 'layout',
    source_provider: 'gdrive',
    network: 'eip155:8453',
    payer: '0x2222222222222222222222222222222222222222',
    transaction: `0x${'c'.repeat(64)}`,
    entitlement: 'expired-memory-only-token',
    redeem_url: '/assets/layout/redeem',
    filename: 'layout.psd',
    mime_type: 'image/vnd.adobe.photoshop',
    content_sha256: 'a'.repeat(64),
    content_bytes: 8,
  };
  testing.rememberPaidEntitlement(entry, accessUrl, purchase);
  let calls = 0;
  const status = { textContent: '', dataset: {} as Record<string, string>, focus() {} };
  await assert.rejects(
    () =>
      testing.fulfillPaidEntitlement(
        purchase,
        entry,
        status,
        accessUrl,
        (async () => {
          calls += 1;
          return new Response(null, { status: 401 });
        }) as typeof fetch,
        async () => {},
      ),
    /payment required again/,
  );
  assert.equal(calls, 1);
  assert.equal(testing.rememberedPaidEntitlement(entry, accessUrl), undefined);
  assert.equal(status.dataset.state, 'payment-required-again');
  assert.match(status.textContent, /will not start automatically/i);
});

test('browser download enforces declared and chunked limits with downward-only configuration', async () => {
  const testing = loadBrowserTesting();
  assert.throws(
    () => testing.validateDownloadBounds(9, 8, 8),
    /safety limit/,
  );
  assert.throws(
    () => testing.validateDownloadBounds(7, 8, 8),
    /declared 7 bytes/,
  );
  await assert.rejects(
    () =>
      testing.readBoundedResponse(
        new Response(new Uint8Array(9)),
        8,
      ),
    /exceeded/,
  );
  let allocated = false;
  await assert.rejects(
    () =>
      testing.readBoundedResponse(
        {
          body: null,
          async arrayBuffer() {
            allocated = true;
            return new ArrayBuffer(1024);
          },
        } as Response,
        8,
      ),
    /requires a readable response stream/,
  );
  assert.equal(allocated, false);

  const contextSource = fs.readFileSync(path.join(__dirname, '../public/download.js'), 'utf8');
  const context = {
    document: { querySelector: () => null },
    window: {
      location: { origin: 'https://curatoria.dev' },
      curatoriaDownloadConfig: { maxDownloadBytes: 1024 },
    },
    TextDecoder,
    TextEncoder,
    Uint8Array,
    atob: globalThis.atob,
    URL,
    globalThis: undefined as unknown,
  } as vm.Context & { curatoriaDownloadTesting?: BrowserTesting };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(contextSource, context);
  assert.equal(context.curatoriaDownloadTesting?.downloadByteLimit(), 1024);
  context.window.curatoriaDownloadConfig.maxDownloadBytes = 101 * 1024 * 1024;
  assert.throws(
    () => context.curatoriaDownloadTesting?.downloadByteLimit(),
    /only lower/,
  );
});

test('browser state machine exposes non-color text and focuses retryable errors', () => {
  const testing = loadBrowserTesting();
  const required = [
    'disconnected', 'connecting', 'unlock', 'wrong-network', 'confirm', 'sign',
    'paid', 'redeem', 'download', 'browser-verified', 'disk-required',
    'retryable', 'payment-required-again',
  ];
  assert.deepEqual([...testing.states].sort(), required.sort());
  let focused = false;
  const status = {
    textContent: '',
    dataset: {} as Record<string, string>,
    focus() {
      focused = true;
    },
  };
  testing.setDownloadState(status, 'retryable', 'Try redemption again.', true);
  assert.match(status.textContent, /^retryable:/);
  assert.equal(status.dataset.state, 'retryable');
  assert.equal(status.dataset.kind, 'error');
  assert.equal(focused, true);
});
