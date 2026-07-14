(function installCuratoriaX402PaymentAdapter(root) {
  'use strict';

  const EIP3009_TYPES = {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };

  const NETWORKS = {
    'eip155:8453': {
      chainId: 8453,
      chainHex: '0x2105',
      chainName: 'Base',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://mainnet.base.org'],
      blockExplorerUrls: ['https://basescan.org'],
      usdcAsset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    },
    'eip155:84532': {
      chainId: 84532,
      chainHex: '0x14a34',
      chainName: 'Base Sepolia',
      nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://sepolia.base.org'],
      blockExplorerUrls: ['https://sepolia.basescan.org'],
      usdcAsset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    },
    'eip155:137': {
      chainId: 137,
      chainHex: '0x89',
      chainName: 'Polygon',
      nativeCurrency: { name: 'MATIC', symbol: 'POL', decimals: 18 },
      rpcUrls: ['https://polygon-rpc.com'],
      blockExplorerUrls: ['https://polygonscan.com'],
      usdcAsset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    },
  };
  const DEFAULT_ALLOWED_NETWORKS = ['eip155:8453', 'eip155:84532'];
  const DEFAULT_MAX_AMOUNT_ATOMIC = '10000';

  async function pay({ url, challenge, entry }) {
    const paymentRequired = decodePaymentRequired(challenge);
    const accepted = validatePaymentRequirement({ url, paymentRequired, entry });
    const network = NETWORKS[accepted.network];

    if (typeof root.confirm === 'function') {
      const approved = root.confirm(
        [
          `Pay ${formatAtomicUsdc(accepted.amount)} USDC for ${entry.name || entry.id}?`,
          `Network: ${accepted.network}`,
          `Pay to: ${accepted.payTo}`,
          `Resource: ${new URL(url).pathname}`,
        ].join('\n'),
      );
      if (!approved) {
        throw new Error('Payment cancelled before wallet authorization.');
      }
    }

    const ethereum = root.ethereum;
    if (!ethereum || typeof ethereum.request !== 'function') {
      throw new Error('No browser wallet found. Install or unlock Coinbase Wallet or another EIP-1193 wallet, then try again.');
    }

    await switchToNetwork(ethereum, network);

    const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
    const from = Array.isArray(accounts) ? accounts[0] : undefined;
    if (!isAddress(from)) {
      throw new Error('Wallet did not return a valid payer address.');
    }

    const authorization = buildAuthorization(accepted, from);
    const typedData = buildTypedData(accepted, authorization, network);
    const signature = await ethereum.request({
      method: 'eth_signTypedData_v4',
      params: [from, JSON.stringify(typedData)],
    });

    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      throw new Error('Wallet returned an invalid EIP-712 signature.');
    }

    return {
      headers: {
        'PAYMENT-SIGNATURE': encodePaymentPayload({
          x402Version: 2,
          resource: paymentRequired.resource,
          accepted,
          payload: {
            signature,
            authorization,
          },
          extensions: paymentRequired.extensions || {},
        }),
      },
    };
  }

  function decodePaymentRequired(challenge) {
    const header = typeof challenge?.header === 'string' ? challenge.header.trim() : '';
    if (header) {
      return parseBase64Json(header, 'PAYMENT-REQUIRED');
    }
    if (challenge?.body && typeof challenge.body === 'object' && Array.isArray(challenge.body.accepts)) {
      return challenge.body;
    }
    throw new Error('Payment challenge is missing a readable PAYMENT-REQUIRED header.');
  }

  function validatePaymentRequirement({ url, paymentRequired, entry, config }) {
    const policy = paymentPolicy(config);

    if (!paymentRequired || paymentRequired.x402Version !== 2) {
      throw new Error('Payment challenge is not x402 version 2.');
    }

    const accessUrl = absoluteUrl(url);
    assertSameOrigin(accessUrl);

    const challengeUrl = absoluteUrl(paymentRequired.resource?.url);
    if (challengeUrl.href !== accessUrl.href) {
      throw new Error('Payment challenge resource does not match the requested asset URL.');
    }

    const catalogUrl = absoluteUrl(entry?.access_url || url);
    if (catalogUrl.href !== accessUrl.href) {
      throw new Error('Catalog access_url does not match the requested asset URL.');
    }

    assertRouteMatchesEntry(accessUrl, entry);

    const exactOptions = (paymentRequired.accepts || []).filter(candidate => candidate?.scheme === 'exact');
    const accepted = exactOptions.find(candidate => policy.allowedNetworks.includes(candidate.network));
    if (!accepted) {
      throw new Error('Payment challenge does not include a Base or Base Sepolia exact payment option.');
    }

    if (!NETWORKS[accepted.network]) {
      throw new Error(`Payment challenge uses unsupported network ${accepted.network}.`);
    }
    if (!policy.allowedNetworks.includes(accepted.network)) {
      throw new Error(`Payment challenge network ${accepted.network} is not allowed by this adapter configuration.`);
    }

    assertSameAddress(accepted.asset, NETWORKS[accepted.network].usdcAsset, 'Payment challenge asset');
    assertSameAddress(accepted.payTo, ownerWalletFor(entry), 'Payment challenge payTo');

    const expectedAmount = usdToAtomicUsdc(entry?.price_usd);
    if (accepted.amount !== expectedAmount) {
      throw new Error(`Payment challenge amount ${accepted.amount} does not match catalog price ${expectedAmount}.`);
    }
    if (atomicGreaterThan(accepted.amount, policy.maxAmountAtomic)) {
      throw new Error(`Payment challenge amount ${accepted.amount} exceeds max spend ${policy.maxAmountAtomic} atomic USDC.`);
    }

    const timeout = Number(accepted.maxTimeoutSeconds);
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 300) {
      throw new Error('Payment challenge timeout is outside the expected Curatoria limit.');
    }

    const extra = accepted.extra || {};
    if (extra.assetTransferMethod && extra.assetTransferMethod !== 'eip3009') {
      throw new Error('Payment challenge uses an unsupported asset transfer method.');
    }
    if (typeof extra.name !== 'string' || typeof extra.version !== 'string') {
      throw new Error('Payment challenge is missing token EIP-712 domain metadata.');
    }

    const challengeMime = paymentRequired.resource?.mimeType;
    if (entry?.mime_type && challengeMime && normalizeMime(challengeMime) !== normalizeMime(entry.mime_type)) {
      throw new Error('Payment challenge MIME type does not match the catalog entry.');
    }

    return accepted;
  }

  function paymentPolicy(config) {
    const configured = config || root.curatoriaX402PaymentAdapterConfig || {};
    const allowedNetworks = Array.isArray(configured.allowedNetworks) && configured.allowedNetworks.length > 0
      ? configured.allowedNetworks.map(String)
      : DEFAULT_ALLOWED_NETWORKS.slice();
    return {
      allowedNetworks,
      maxAmountAtomic: normalizeAtomicLimit(configured.maxAmountAtomic ?? DEFAULT_MAX_AMOUNT_ATOMIC),
    };
  }

  function buildAuthorization(accepted, from) {
    const now = Math.floor(Date.now() / 1000);
    const validAfter = String(Math.max(0, now - 5));
    const validBefore = String(now + Math.min(Number(accepted.maxTimeoutSeconds), 300));
    return {
      from,
      to: accepted.payTo,
      value: accepted.amount,
      validAfter,
      validBefore,
      nonce: randomHex32(),
    };
  }

  function buildTypedData(accepted, authorization, network) {
    return {
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      domain: {
        name: accepted.extra.name,
        version: accepted.extra.version,
        chainId: network.chainId,
        verifyingContract: accepted.asset,
      },
      message: authorization,
    };
  }

  function encodePaymentPayload(payload) {
    return base64Encode(JSON.stringify(payload));
  }

  async function switchToNetwork(ethereum, network) {
    try {
      await ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: network.chainHex }],
      });
    } catch (error) {
      if (error && (error.code === 4902 || error.code === -32603)) {
        await ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: network.chainHex,
            chainName: network.chainName,
            nativeCurrency: network.nativeCurrency,
            rpcUrls: network.rpcUrls,
            blockExplorerUrls: network.blockExplorerUrls,
          }],
        });
        return;
      }
      throw error;
    }
  }

  function parseBase64Json(value, label) {
    try {
      return JSON.parse(base64Decode(value));
    } catch {
      throw new Error(`${label} was not valid base64-encoded JSON.`);
    }
  }

  function base64Decode(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    if (typeof root.atob === 'function') {
      const binary = root.atob(padded);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(padded, 'base64').toString('utf8');
    }
    throw new Error('No base64 decoder is available in this browser.');
  }

  function base64Encode(value) {
    if (typeof root.btoa === 'function') {
      const bytes = new TextEncoder().encode(value);
      let binary = '';
      bytes.forEach(byte => {
        binary += String.fromCharCode(byte);
      });
      return root.btoa(binary);
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(value, 'utf8').toString('base64');
    }
    throw new Error('No base64 encoder is available in this browser.');
  }

  function absoluteUrl(value) {
    if (!value) {
      throw new Error('Payment resource URL is missing.');
    }
    return new URL(value, root.location?.origin || 'http://localhost');
  }

  function assertSameOrigin(url) {
    if (root.location?.origin && url.origin !== root.location.origin) {
      throw new Error('Payment adapter only supports same-origin Curatoria assets.');
    }
  }

  function assertRouteMatchesEntry(url, entry) {
    const id = encodeURIComponent(entry?.id || '');
    if (!id) {
      throw new Error('Catalog entry is missing an id.');
    }
    const expectedPath = (entry.resource_type || 'design_md') === 'bundle_zip'
      ? `/packs/${id}/download`
      : `/design-systems/${id}`;
    if (url.pathname !== expectedPath) {
      throw new Error('Payment challenge route does not match the catalog entry type.');
    }
  }

  function ownerWalletFor(entry) {
    const wallet = entry?.owner_wallet || entry?.catalog_owner?.wallet || entry?.owner?.wallet;
    if (!wallet) {
      throw new Error('Catalog owner wallet is unavailable for payment validation.');
    }
    return wallet;
  }

  function assertSameAddress(actual, expected, label) {
    if (!isAddress(actual) || !isAddress(expected) || actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`${label} does not match the catalog payment target.`);
    }
  }

  function isAddress(value) {
    return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
  }

  function normalizeMime(value) {
    return String(value || '').split(';', 1)[0].trim().toLowerCase();
  }

  function usdToAtomicUsdc(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d+)(?:\.(\d{1,6})?)?$/);
    if (!match) {
      throw new Error(`Invalid catalog price_usd "${raw}".`);
    }
    const whole = BigInt(match[1]);
    const fraction = BigInt((match[2] || '').padEnd(6, '0'));
    return String(whole * 1_000_000n + fraction);
  }

  function normalizeAtomicLimit(value) {
    const normalized = String(value).trim();
    if (!/^\d+$/.test(normalized)) {
      throw new Error('Payment adapter maxAmountAtomic must be an unsigned integer string.');
    }
    return normalized;
  }

  function atomicGreaterThan(actual, limit) {
    const normalized = String(actual).trim();
    if (!/^\d+$/.test(normalized)) {
      throw new Error('Payment challenge amount is not an unsigned integer string.');
    }
    return BigInt(normalized) > BigInt(limit);
  }

  function formatAtomicUsdc(value) {
    const atomic = BigInt(value);
    const whole = atomic / 1_000_000n;
    const fraction = String(atomic % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : String(whole);
  }

  function randomHex32() {
    const bytes = new Uint8Array(32);
    root.crypto.getRandomValues(bytes);
    return `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  const adapter = { pay };
  Object.defineProperty(adapter, '__testing', {
    enumerable: false,
    value: {
      buildAuthorization,
      buildTypedData,
      decodePaymentRequired,
      encodePaymentPayload,
      formatAtomicUsdc,
      paymentPolicy,
      usdToAtomicUsdc,
      validatePaymentRequirement,
    },
  });

  if (!root.curatoriaX402PaymentAdapter) {
    root.curatoriaX402PaymentAdapter = adapter;
  }
})(globalThis);
