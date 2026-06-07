// ─── Registry Types ───────────────────────────────────────────────────────────

export type ResourceType = 'design_md' | 'bundle_zip';

/**
 * Where a product's sellable bytes actually live.
 *
 *   local  — a file inside the repo's design-systems/ directory (default)
 *   url    — a direct https:// URL you control (your domain, a CDN, object storage)
 *   gdrive — a Google Drive file shared as "Anyone with the link can view"
 *
 * Only registry metadata (price, name, tags) is ever stored locally for url/gdrive
 * sources; the bytes are fetched on demand after a successful x402 payment.
 */
export type StorageSourceType = 'local' | 'url' | 'gdrive';

export interface EntrySource {
  /** Connector kind. Defaults to 'local' when omitted. */
  type: StorageSourceType;
  /** Direct https URL for type 'url'. */
  url?: string;
  /** Google Drive file ID for type 'gdrive' (the long token in the share link). */
  file_id?: string;
}

export interface DesignSystemEntry {
  /** URL-safe slug used in the route: GET /design-systems/:id */
  id: string;
  /**
   * Display filename / local path inside design-systems/.
   * For url and gdrive sources this is a label only; the bytes come from `source`.
   */
  file: string;
  /** Where the sellable bytes live. Absent means a local design-systems/ file. */
  source?: EntrySource;
  /** Resource kind for routing + response behavior */
  resource_type?: ResourceType;
  /** Optional bundle filename for downloadable zip products */
  bundle_file?: string;
  /** MIME type served after payment, defaults by resource type */
  mime_type?: string;
  /** Human-readable display name */
  name: string;
  /** One-sentence description shown in the discovery catalog */
  description: string;
  /** Price in USD as a decimal string — "0.01" means one cent in USDC */
  price_usd: string;
  /** Searchable tags for agent filtering */
  tags: string[];
  /** ISO 8601 creation timestamp */
  published_at: string;
  /** false = hidden from catalog but not deleted */
  active: boolean;
}

export interface RegistryOwner {
  /** EVM address that receives USDC payments */
  wallet: string;
  name: string;
  url?: string;
}

export interface DesignCatalog {
  owner: RegistryOwner;
  design_systems: DesignSystemEntry[];
}

// ─── API Response Types ───────────────────────────────────────────────────────

/** Response body for GET /.well-known/design-catalog.json */
export interface CatalogResponse {
  owner: RegistryOwner;
  total: number;
  base_url: string;
  design_systems: CatalogEntry[];
}

/** A single entry in the discovery catalog — file path intentionally omitted */
export interface CatalogEntry extends Omit<DesignSystemEntry, 'file'> {
  access_url: string;
  download_url?: string;
  payment_required: true;
}

// ─── Admin Types ──────────────────────────────────────────────────────────────

/** Body for POST /admin/publish */
export interface PublishRequest {
  id: string;
  file: string;
  name: string;
  description: string;
  price_usd: string;
  tags?: string[];
}

// ─── X402 Protocol Types ──────────────────────────────────────────────────────

/** The JSON body returned in an HTTP 402 response */
export interface PaymentRequired {
  x402Version: number;
  accepts: PaymentAccept[];
  error: string;
  extensions?: Record<string, unknown>;
}

export interface PaymentAccept {
  scheme: 'exact' | 'upto';
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: Record<string, string>;
}

/** Decoded contents of the X-PAYMENT request header */
export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
  extensions?: Record<string, unknown>;
}

/** Facilitator /verify response */
export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

/** Facilitator /settle response */
export interface SettleResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
}
