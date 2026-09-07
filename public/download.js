const catalogUrl = '/.well-known/design-catalog.json';
const listEl = document.querySelector('#download-list');
const noticeEl = document.querySelector('#download-notice');
const paidEntitlements = new Map();
const DEFAULT_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_STATES = new Set([
  'disconnected',
  'connecting',
  'unlock',
  'wrong-network',
  'confirm',
  'sign',
  'paid',
  'redeem',
  'download',
  'browser-verified',
  'disk-required',
  'retryable',
  'payment-required-again',
]);

const mimeExtensions = {
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'font/ttf': '.ttf',
  'font/woff2': '.woff2',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/vnd.adobe.photoshop': '.psd',
  'text/markdown': '.md',
  'text/plain': '.txt',
};

if (listEl && noticeEl) {
  init().catch(error => {
    setNotice(`Could not load diagnostics: ${messageFor(error)}`, 'error');
  });
}

async function init() {
  const catalog = await fetchJson(catalogUrl);

  if (!Array.isArray(catalog.design_systems)) {
    const paidCatalogUrl = catalog.paid_catalog_url || '/catalog';
    setNotice(
      `This catalog is paywalled at ${paidCatalogUrl}. Use an agent wallet path for the primary proof; this browser diagnostics page can only list free catalog metadata.`,
      'error',
    );
    return;
  }

  setNotice(
    'Catalog loaded for diagnostics. Any browser save attempt must preserve raw response bytes and must not reconstruct file contents.',
    'success',
  );

  const owner = catalog.owner || {};
  listEl.replaceChildren(
    ...catalog.design_systems.map(entry =>
      renderCatalogEntry({ ...entry, catalog_owner: owner, owner_wallet: owner.wallet }),
    ),
  );
}

function renderCatalogEntry(entry) {
  const item = document.createElement('li');
  item.className = 'download-card';

  const header = document.createElement('div');
  header.className = 'download-card__header';

  const titleWrap = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = entry.name || entry.id || 'Untitled asset';
  const description = document.createElement('p');
  description.textContent = entry.description || 'Paid Curatoria asset.';
  titleWrap.append(title, description);

  const price = document.createElement('p');
  price.className = 'download-kicker';
  price.textContent = `$${entry.price_usd || '0.00'} USDC`;
  header.append(titleWrap, price);

  const meta = document.createElement('div');
  meta.className = 'download-meta';
  [
    entry.id,
    entry.resource_type || 'design_md',
    entry.mime_type || 'application/octet-stream',
    entry.owner_wallet ? `payTo ${shortAddress(entry.owner_wallet)}` : '',
    ...(Array.isArray(entry.tags) ? entry.tags : []),
  ]
    .filter(Boolean)
    .forEach(value => {
      const chip = document.createElement('span');
      chip.textContent = value;
      meta.append(chip);
    });

  const actions = document.createElement('div');
  actions.className = 'download-actions';

  const button = document.createElement('button');
  button.className = 'download-button';
  button.type = 'button';
  button.textContent = 'pay and prepare download';

  const link = document.createElement('a');
  link.className = 'download-link';
  link.href = entry.access_url || '#';
  link.textContent = 'open paid route';
  link.rel = 'noreferrer';

  const status = document.createElement('div');
  status.className = 'download-status';
  status.textContent = 'Diagnostics ready.';
  status.id = `download-status-${String(entry.id || 'asset').replace(/[^A-Za-z0-9_-]/g, '-')}`;
  configureStatusElement(status);
  setDownloadState(status, 'disconnected', 'Ready to connect a wallet.');
  button.setAttribute('aria-describedby', status.id);

  button.addEventListener('click', async () => {
    await payAndSave(entry, button, status);
  });

  actions.append(button, link);
  item.append(header, meta, actions, status);
  return item;
}

async function payAndSave(entry, button, status) {
  const accessUrl = absoluteUrl(entry.access_url);
  const remembered = paidEntitlements.get(entitlementKey(entry, accessUrl));

  button.disabled = true;
  setDownloadState(
    status,
    remembered ? 'redeem' : 'connecting',
    remembered
      ? 'Retrying paid download with the existing entitlement...'
      : 'Requesting x402 challenge...',
  );

  try {
    if (remembered) {
      await fulfillPaidEntitlement(remembered, entry, status, accessUrl);
      return;
    }
    const firstResponse = await fetch(accessUrl, {
      cache: 'no-store',
      headers: { Accept: entry.mime_type || '*/*' },
    });

    if (firstResponse.ok) {
      await handlePaidResponse(firstResponse, entry, status, accessUrl);
      return;
    }

    if (firstResponse.status !== 402) {
      throw new Error(`Expected 402 payment challenge, got ${firstResponse.status}`);
    }

    const challenge = await readPaymentChallenge(firstResponse);
    const paymentHeaders = await createPaymentHeaders({ accessUrl, challenge, entry, status });
    setDownloadState(status, 'paid', 'Payment authorized. Fetching entitlement metadata...');

    const paidResponse = await fetch(accessUrl, {
      cache: 'no-store',
      headers: {
        Accept: entry.mime_type || '*/*',
        ...paymentHeaders,
      },
    });

    if (!paidResponse.ok) {
      throw new Error(`Paid fetch failed with ${paidResponse.status}: ${await readErrorBody(paidResponse)}`);
    }

    await handlePaidResponse(paidResponse, entry, status, accessUrl);
  } catch (error) {
    const message = messageFor(error);
    setDownloadState(
      status,
      /expired|payment required|status 402/i.test(message)
        ? 'payment-required-again'
        : 'retryable',
      message,
      true,
    );
  } finally {
    button.disabled = false;
  }
}

async function handlePaidResponse(response, entry, status, accessUrl) {
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
  if (entry.resource_type !== 'binary_asset' || contentType !== 'application/json') {
    await saveResponseBytes(response, entry, status);
    return;
  }

  const purchase = await response.json();
  validateEntitlementMetadata(purchase, entry, false);
  purchase.payment_response_metadata = sanitizePaymentResponse(
    response.headers.get('PAYMENT-RESPONSE') ||
      response.headers.get('X-PAYMENT-RESPONSE'),
  );
  paidEntitlements.set(entitlementKey(entry, accessUrl), purchase);
  await fulfillPaidEntitlement(purchase, entry, status, accessUrl);
}

async function fulfillPaidEntitlement(
  purchase,
  entry,
  status,
  accessUrl,
  fetchImpl = fetch,
  saveImpl = saveResponseBytes,
) {
  const redeemUrl = new URL(purchase.redeem_url, accessUrl);
  if (redeemUrl.origin !== new URL(accessUrl).origin) {
    throw new Error('Entitlement redemption URL changed origin.');
  }
  setDownloadState(status, 'redeem', 'Payment complete. Redeeming private download access...');
  const redemptionResponse = await fetchImpl(redeemUrl, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${purchase.entitlement}`,
    },
  });
  if (!redemptionResponse.ok) {
    if (redemptionResponse.status === 401) {
      paidEntitlements.delete(entitlementKey(entry, accessUrl));
      setDownloadState(
        status,
        'payment-required-again',
        'The remembered entitlement is expired or invalid. Use the button again to request a fresh payment challenge; payment will not start automatically.',
        true,
      );
      throw new Error('Remembered entitlement is no longer valid; payment required again.');
    }
    throw new Error(`Entitlement redemption failed with ${redemptionResponse.status}`);
  }
  const redemption = await redemptionResponse.json();
  validateEntitlementMetadata(redemption, purchase, true);
  const downloadUrl = new URL(redemption.download_url);
  if (
    downloadUrl.protocol !== 'https:' ||
    !downloadUrl.hostname.endsWith('.blob.vercel-storage.com')
  ) {
    throw new Error('Redeemed URL is not a private Vercel Blob download.');
  }
  if (purchase.content_bytes > downloadByteLimit()) {
    throw new Error('Asset exceeds this browser download safety limit.');
  }
  setDownloadState(status, 'download', 'Downloading bounded private bytes...');
  const fileResponse = await fetchImpl(downloadUrl, {
    cache: 'no-store',
    headers: { Accept: purchase.mime_type, 'Accept-Encoding': 'identity' },
  });
  if (!fileResponse.ok) {
    throw new Error(`Private file download failed with ${fileResponse.status}`);
  }
  await saveImpl(fileResponse, purchase, status);
}

function entitlementKey(entry, accessUrl) {
  return `${entry.id || entry.product_id || ''}\0${accessUrl}`;
}

function validateEntitlementMetadata(candidate, expected, redemption) {
  const urlField = redemption ? 'download_url' : 'redeem_url';
  if (
    !candidate ||
    (!redemption && !/^rcpt_[A-Za-z0-9_-]{32,}$/.test(candidate.receipt_id || '')) ||
    typeof candidate.product_id !== 'string' ||
    (!redemption && !/^(local|url|gdrive|dropbox)$/.test(candidate.source_provider || '')) ||
    (!redemption && !/^eip155:\d+$/.test(candidate.network || '')) ||
    (!redemption && !/^0x[0-9a-f]{40}$/i.test(candidate.payer || '')) ||
    (!redemption && !/^0x[0-9a-f]{64}$/i.test(candidate.transaction || '')) ||
    (!redemption && typeof candidate.entitlement !== 'string') ||
    typeof candidate[urlField] !== 'string' ||
    typeof candidate.filename !== 'string' ||
    typeof candidate.mime_type !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(candidate.content_sha256 || '') ||
    !Number.isSafeInteger(candidate.content_bytes) ||
    candidate.content_bytes <= 0
  ) {
    throw new Error('Paid entitlement metadata is incomplete.');
  }
  const expectedId = expected.id || expected.product_id;
  const expectedFilename = expected.download_filename || expected.filename;
  if (
    candidate.product_id !== expectedId ||
    candidate.filename !== expectedFilename ||
    candidate.mime_type !== expected.mime_type ||
    candidate.content_sha256 !== expected.content_sha256 ||
    candidate.content_bytes !== expected.content_bytes
  ) {
    throw new Error('Paid entitlement metadata does not match the catalog asset.');
  }
}

async function createPaymentHeaders({ accessUrl, challenge, entry, status }) {
  const adapter = window.curatoriaX402PaymentAdapter || window.x402PaymentAdapter;

  if (!adapter || typeof adapter.pay !== 'function') {
    throw new Error(
      'Browser x402 payment adapter unavailable. Load x402-payment-adapter.js or provide window.curatoriaX402PaymentAdapter.pay({ url, challenge, entry }) that returns PAYMENT-SIGNATURE headers.',
    );
  }

  const result = await adapter.pay({
    url: accessUrl,
    challenge,
    entry,
    onStateChange(state) {
      if (state && DOWNLOAD_STATES.has(state.name)) {
        setDownloadState(status, state.name, state.message || state.name);
      }
    },
  });

  return normalizePaymentHeaders(result);
}

function normalizePaymentHeaders(result) {
  if (!result) {
    throw new Error('Payment adapter did not return payment headers.');
  }

  if (typeof result === 'string') {
    return { 'PAYMENT-SIGNATURE': result };
  }

  if (result.headers && typeof result.headers === 'object') {
    return normalizePaymentHeaders(result.headers);
  }

  const headers = {};
  Object.entries(result).forEach(([key, value]) => {
    if (value == null) return;
    if (/^(payment-signature|x-payment-signature|x-payment)$/i.test(key)) {
      headers[key] = String(value);
    }
  });

  if (!Object.keys(headers).length) {
    throw new Error('Payment adapter response did not include PAYMENT-SIGNATURE headers.');
  }

  return headers;
}

async function saveResponseBytes(response, entry, status) {
  const limit = downloadByteLimit();
  const declaredLength = parseDeclaredLength(response.headers.get('content-length'));
  const expectedLength = Number(entry.content_bytes || declaredLength || 0);
  try {
    validateDownloadBounds(declaredLength, expectedLength, limit);
  } catch (error) {
    response.body?.cancel?.().catch(() => {});
    throw error;
  }
  const bytes = await readBoundedResponse(response, limit);
  const blob = new Blob([bytes], {
    type: response.headers.get('content-type') || entry.mime_type || 'application/octet-stream',
  });
  const filename = entry.filename || filenameFor(response, entry);
  if (expectedLength && bytes.byteLength !== expectedLength) {
    throw new Error(`Downloaded ${bytes.byteLength} bytes; expected ${expectedLength}.`);
  }
  const actualSha256 = await sha256Hex(bytes);
  if (
    entry.content_sha256 &&
    actualSha256.toLowerCase() !== String(entry.content_sha256).toLowerCase()
  ) {
    throw new Error('Downloaded bytes did not match the catalog SHA-256.');
  }
  if (
    (filename.toLowerCase().endsWith('.psd') ||
      entry.mime_type === 'image/vnd.adobe.photoshop') &&
    new TextDecoder('latin1').decode(bytes.slice(0, 4)) !== '8BPS'
  ) {
    throw new Error('Downloaded file is missing the PSD 8BPS signature.');
  }
  triggerBrowserSave(blob, filename);

  let receipt = null;
  if (entry.entitlement && entry.receipt_id) {
    receipt = await createBrowserReceipt({
      purchase: entry,
      actualSha256,
      actualBytes: bytes.byteLength,
      psd8bps:
        new TextDecoder('latin1').decode(bytes.slice(0, 4)) === '8BPS',
    });
    triggerBrowserSave(
      new Blob([`${JSON.stringify(receipt, null, 2)}\n`], { type: 'application/json' }),
      `${filename}.curatoria-receipt.json`,
    );
    setDownloadState(
      status,
      'browser-verified',
      `Browser verified ${bytes.byteLength} in-memory bytes and prepared SHA-256 ${actualSha256}.`,
    );
  }

  const sizeDetail = declaredLength && declaredLength !== blob.size
    ? `verified ${blob.size} in-memory bytes; server declared ${declaredLength}`
    : `verified ${blob.size} in-memory bytes`;
  setDownloadState(
    status,
    'disk-required',
    `Browser download triggered for ${filename} (${sizeDetail}; SHA-256 ${actualSha256}). A capability-free receipt download was also triggered.${
      receipt
        ? ` Verify receipt ${receipt.receipt_id}, product ${receipt.product_id}, transaction ${receipt.transaction}, and entitlement fingerprint ${receipt.entitlement_fingerprint}.`
        : ''
    } The browser controls the final folder and collision name. Run the local verifier against the actual downloaded PSD before opening it.`,
  );
  return receipt;
}

async function readBoundedResponse(response, limit) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error(
      'Bounded browser download requires a readable response stream; non-streaming responses are rejected before allocation.',
    );
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel('browser download safety limit exceeded');
        throw new Error(`Chunked download exceeded the ${limit}-byte browser safety limit.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed.
    }
    throw error;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function parseDeclaredLength(value) {
  if (!value) return 0;
  if (!/^\d+$/.test(value)) throw new Error('Server returned an invalid Content-Length.');
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new Error('Server Content-Length is too large.');
  return length;
}

function validateDownloadBounds(declaredLength, expectedLength, limit) {
  if (expectedLength > limit || declaredLength > limit) {
    throw new Error(`Download exceeds the ${limit}-byte browser safety limit.`);
  }
  if (declaredLength && expectedLength && declaredLength !== expectedLength) {
    throw new Error(
      `Server declared ${declaredLength} bytes; entitlement requires ${expectedLength}.`,
    );
  }
}

function downloadByteLimit() {
  const configured = Number(window.curatoriaDownloadConfig?.maxDownloadBytes);
  if (!Number.isFinite(configured)) return DEFAULT_MAX_DOWNLOAD_BYTES;
  if (
    !Number.isSafeInteger(configured) ||
    configured <= 0 ||
    configured > DEFAULT_MAX_DOWNLOAD_BYTES
  ) {
    throw new Error('maxDownloadBytes may only lower the 100 MiB browser limit.');
  }
  return configured;
}

function triggerBrowserSave(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

function sanitizePaymentResponse(value) {
  if (!value) throw new Error('Paid response omitted transaction proof metadata.');
  let candidate;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      '=',
    );
    candidate = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(padded), character => character.charCodeAt(0)),
      ),
    );
  } catch {
    throw new Error('PAYMENT-RESPONSE was not valid encoded JSON.');
  }
  const transaction =
    typeof candidate.transaction === 'string' ? candidate.transaction.trim() : '';
  const network = typeof candidate.network === 'string' ? candidate.network.trim() : '';
  const payer =
    typeof candidate.payer === 'string' ? candidate.payer.trim().toLowerCase() : '';
  if (
    candidate.success !== true ||
    !/^0x[0-9a-f]{64}$/i.test(transaction) ||
    !/^eip155:\d+$/.test(network) ||
    !/^0x[0-9a-f]{40}$/.test(payer)
  ) {
    throw new Error('PAYMENT-RESPONSE lacks finalized transaction identity.');
  }
  return { transaction, network, payer };
}

async function createBrowserReceipt({
  purchase,
  actualSha256,
  actualBytes,
  psd8bps,
}) {
  const payment = purchase.payment_response_metadata;
  if (
    !payment ||
    payment.network !== purchase.network ||
    payment.payer !== String(purchase.payer).toLowerCase() ||
    payment.transaction.toLowerCase() !== String(purchase.transaction).toLowerCase() ||
    actualSha256.toLowerCase() !== String(purchase.content_sha256).toLowerCase() ||
    actualBytes !== purchase.content_bytes ||
    !psd8bps
  ) {
    throw new Error('Browser proof does not match the transaction-bound entitlement.');
  }
  return {
    version: 1,
    receipt_id: purchase.receipt_id,
    product_id: purchase.product_id,
    source_provider: purchase.source_provider,
    transaction: payment.transaction,
    payer: payment.payer,
    network: payment.network,
    entitlement_fingerprint: await sha256Hex(
      new TextEncoder().encode(purchase.entitlement),
    ),
    content_sha256: actualSha256.toLowerCase(),
    content_bytes: actualBytes,
    filename: purchase.filename,
    mime_type: purchase.mime_type,
    browser_verified_at: new Date().toISOString(),
    browser_verification: {
      sha256: actualSha256.toLowerCase(),
      bytes: actualBytes,
      psd_8bps: true,
    },
    disk_verification_required: true,
  };
}

async function readPaymentChallenge(response) {
  const header =
    response.headers.get('PAYMENT-REQUIRED') || response.headers.get('X-PAYMENT-REQUIRED') || '';
  let body = null;

  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  return { header, body, status: response.status };
}

function filenameFor(response, entry) {
  const disposition = response.headers.get('content-disposition') || '';
  const fromHeader = parseContentDispositionFilename(disposition);
  if (fromHeader) return sanitizeFilename(fromHeader);

  const type = (response.headers.get('content-type') || entry.mime_type || '').split(';')[0].trim();
  const extension = mimeExtensions[type] || (entry.resource_type === 'bundle_zip' ? '.zip' : '.bin');
  return sanitizeFilename(`${entry.id || 'curatoria-asset'}${extension}`);
}

function parseContentDispositionFilename(value) {
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, ''));
    } catch {
      return utf8Match[1].trim().replace(/^"|"$/g, '');
    }
  }

  const asciiMatch = value.match(/filename="([^"]+)"|filename=([^;]+)/i);
  return (asciiMatch?.[1] || asciiMatch?.[2] || '').trim();
}

function sanitizeFilename(value) {
  return String(value)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'curatoria-download.bin';
}

function shortAddress(value) {
  const text = String(value);
  return text.length > 12 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
}

function absoluteUrl(value) {
  if (!value) throw new Error('Catalog entry is missing access_url.');
  return new URL(value, window.location.origin).toString();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }

  return response.json();
}

async function readErrorBody(response) {
  const text = await response.text();
  return text.slice(0, 300) || response.statusText || 'unknown error';
}

function setNotice(message, kind = 'info') {
  noticeEl.textContent = message;
  noticeEl.dataset.kind = kind;
}

function setStatus(element, message, kind) {
  element.textContent = message;
  element.dataset.kind = kind;
}

function setDownloadState(element, state, message, focusError = false) {
  if (!DOWNLOAD_STATES.has(state)) throw new Error(`Unknown download state "${state}".`);
  element.textContent = `${state}: ${message}`;
  element.dataset.state = state;
  element.dataset.kind =
    state === 'retryable' || state === 'payment-required-again'
      ? 'error'
      : state === 'browser-verified' || state === 'disk-required'
        ? 'success'
        : 'info';
  if (focusError && typeof element.focus === 'function') element.focus();
}

function configureStatusElement(element) {
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.setAttribute('aria-atomic', 'true');
  element.setAttribute('tabindex', '-1');
}

function messageFor(error) {
  return error instanceof Error ? error.message : String(error);
}

globalThis.curatoriaDownloadTesting = {
  configureStatusElement,
  createBrowserReceipt,
  downloadByteLimit,
  readBoundedResponse,
  sanitizePaymentResponse,
  setDownloadState,
  validateDownloadBounds,
  validateEntitlementMetadata,
  fulfillPaidEntitlement,
  rememberPaidEntitlement(entry, accessUrl, purchase) {
    paidEntitlements.set(entitlementKey(entry, accessUrl), purchase);
  },
  rememberedPaidEntitlement(entry, accessUrl) {
    return paidEntitlements.get(entitlementKey(entry, accessUrl));
  },
  completionWording:
    'Browser download triggered; the browser controls the final folder and local verification is still required.',
  states: Array.from(DOWNLOAD_STATES),
};
