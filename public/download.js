const catalogUrl = '/.well-known/design-catalog.json';
const listEl = document.querySelector('#download-list');
const noticeEl = document.querySelector('#download-notice');

const mimeExtensions = {
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'font/ttf': '.ttf',
  'font/woff2': '.woff2',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'text/markdown': '.md',
  'text/plain': '.txt',
};

init().catch(error => {
  setNotice(`Could not load diagnostics: ${messageFor(error)}`, 'error');
});

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
  button.textContent = 'pay and save';

  const link = document.createElement('a');
  link.className = 'download-link';
  link.href = entry.access_url || '#';
  link.textContent = 'open paid route';
  link.rel = 'noreferrer';

  const status = document.createElement('div');
  status.className = 'download-status';
  status.textContent = 'Diagnostics ready.';

  button.addEventListener('click', async () => {
    await payAndSave(entry, button, status);
  });

  actions.append(button, link);
  item.append(header, meta, actions, status);
  return item;
}

async function payAndSave(entry, button, status) {
  const accessUrl = absoluteUrl(entry.access_url);

  button.disabled = true;
  setStatus(status, 'Requesting x402 challenge...', 'info');

  try {
    const firstResponse = await fetch(accessUrl, {
      cache: 'no-store',
      headers: { Accept: entry.mime_type || '*/*' },
    });

    if (firstResponse.ok) {
      await saveResponseBytes(firstResponse, entry, status);
      return;
    }

    if (firstResponse.status !== 402) {
      throw new Error(`Expected 402 payment challenge, got ${firstResponse.status}`);
    }

    const challenge = await readPaymentChallenge(firstResponse);
    const paymentHeaders = await createPaymentHeaders({ accessUrl, challenge, entry });
    setStatus(status, 'Payment authorized. Fetching paid bytes...', 'info');

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

    await saveResponseBytes(paidResponse, entry, status);
  } catch (error) {
    setStatus(status, messageFor(error), 'error');
  } finally {
    button.disabled = false;
  }
}

async function createPaymentHeaders({ accessUrl, challenge, entry }) {
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
  const blob = await response.blob();
  const declaredLength = Number(response.headers.get('content-length') || '0');
  const filename = filenameFor(response, entry);
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

  const sizeDetail = declaredLength && declaredLength !== blob.size
    ? `saved ${blob.size} bytes; server declared ${declaredLength}`
    : `saved ${blob.size} bytes`;
  setStatus(status, `Download started for ${filename} (${sizeDetail}).`, 'success');
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

function messageFor(error) {
  return error instanceof Error ? error.message : String(error);
}
