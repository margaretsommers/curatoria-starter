// ─── Registry Types ───────────────────────────────────────────────────────────

export type ResourceType = 'design_md' | 'bundle_zip' | 'binary_asset';
export type IntegrityStatus = 'verified' | 'unverified';
export type DeliveryMode = 'direct' | 'entitlement';

export type LicenseCode =
  | 'proprietary'
  | 'custom-commercial'
  | 'cc0-1.0'
  | 'cc-by-4.0'
  | 'cc-by-sa-4.0'
  | 'cc-by-nd-4.0'
  | 'cc-by-nc-4.0'
  | 'cc-by-nc-sa-4.0'
  | 'cc-by-nc-nd-4.0'
  | 'mit'
  | 'apache-2.0'
  | (string & {});

export interface BundleManifestEntry {
  /** Safe relative path inside the paid bundle. Never include source URLs. */
  path: string;
  kind?: string;
  mime_type?: string;
  bytes?: number;
  sha256?: string;
  description?: string;
}

export type DisposableAccessDeliveryMode =
  | 'fallback_when_direct_too_large'
  | 'disposable_link_only';

export interface DisposableAccessPolicy {
  /** Enables post-payment disposable-link delivery for this product. */
  enabled: boolean;
  /** Maximum successful file responses before the link is exhausted. */
  max_downloads?: number;
  /** Maximum successful view/open responses before the link is exhausted. */
  max_views?: number;
  /** Number of hours after issue time before the link expires. */
  hours_valid?: number;
  /** Optional cumulative byte ceiling across successful responses. */
  max_total_bytes?: number;
  /** Whether a buyer can receive a fresh link after another payment. */
  allow_regeneration_after_payment?: boolean;
  /** Direct paid download remains primary unless this is explicitly link-only. */
  delivery?: DisposableAccessDeliveryMode;
}

/**
 * Where a product's sellable bytes actually live.
 *
 *   local  — a file inside the repo's design-systems/ directory (default)
 *   url    — a direct https:// URL you control (your domain, a CDN, object storage)
 *   gdrive  — a Google Drive file shared as "Anyone with the link can view"
 *   dropbox — a Dropbox shared link (Mode A) or private path (Mode B OAuth)
 *
 * Only registry metadata (price, name, tags) is ever stored locally for url/gdrive/dropbox
 * sources; the bytes are fetched on demand after a successful x402 payment.
 */
export type StorageSourceType = 'local' | 'url' | 'gdrive' | 'dropbox';

export interface EntrySource {
  /** Connector kind. Defaults to 'local' when omitted. */
  type: StorageSourceType;
  /** Direct https URL for type 'url'. */
  url?: string;
  /** Google Drive file ID for type 'gdrive' (the long token in the share link). */
  file_id?: string;
  /** Dropbox share URL for type 'dropbox' (Mode A: link-share). */
  share_url?: string;
  /** Dropbox file path for type 'dropbox' (Mode B OAuth/private-file access). */
  dropbox_path?: string;
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
  /** License code for the paid asset or public preview material. */
  license?: LicenseCode;
  /** Public URL for the license terms. Should not require the paid asset. */
  license_url?: string;
  /** Short human/agent-readable rights summary for discovery. */
  license_summary?: string;
  /** Short inline preview. Keep partial enough that it is not the product. */
  preview?: string;
  /** Public preview, thumbnail, excerpt, or sample URL. Never the paid source URL. */
  preview_url?: string;
  /** Safe sample filenames or intentionally free sample assets. */
  sample_files?: string[];
  /** High-level sections for markdown/PDF-like products. */
  table_of_contents?: string[];
  /** Token categories included in the paid asset. */
  token_categories?: string[];
  /** Component names included in the paid asset. */
  component_list?: string[];
  /** SHA-256 of the paid payload when known and safe to publish. */
  content_sha256?: string;
  /** Exact immutable payload size recorded during import. */
  content_bytes?: number;
  /** Whether import verified the immutable payload hash and byte count. */
  integrity_status?: IntegrityStatus;
  /** Binary assets use entitlement delivery; legacy small products may remain direct. */
  delivery_mode?: DeliveryMode;
  /** Original provider category, without exposing the source URL or provider object id. */
  source_provider?: StorageSourceType;
  /** Private immutable object path. Never expose this field through discovery. */
  blob_path?: string;
  /** Safe public bundle listing. Do not include storage/source URLs. */
  bundle_manifest?: BundleManifestEntry[];
  /** Optional large-file fallback policy. Does not expose the underlying storage URL. */
  disposable_access?: DisposableAccessPolicy;
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
  /** Track B only: flat USD price for paid GET /catalog (decimal string, e.g. "0.001") */
  catalog_price_usd?: string;
}

export interface DesignCatalog {
  owner: RegistryOwner;
  design_systems: DesignSystemEntry[];
}

// ─── API Response Types ───────────────────────────────────────────────────────

/** Track B: free teaser for GET /.well-known/design-catalog.json when CATALOG_PAYWALL_ENABLED=1 */
export interface CatalogTeaserResponse {
  owner: RegistryOwner;
  total: number;
  paid_catalog_url: string;
  payment_required: true;
}

/** Full catalog listing — free at well-known (Track A default) or paid at GET /catalog (Track B) */
export interface CatalogResponse {
  owner: RegistryOwner;
  total: number;
  base_url: string;
  design_systems: CatalogEntry[];
}

/** A single entry in the discovery catalog — file path intentionally omitted */
export interface CatalogEntry extends Omit<DesignSystemEntry, 'file' | 'source' | 'blob_path'> {
  access_url: string;
  download_url?: string;
  /** Safe output filename for paid binary delivery; never a source path. */
  download_filename?: string;
  payment_required: true;
}

export interface PaidAccessReceipt {
  product_id: string;
  resource_url: string;
  amount_usd: string;
  network: string;
  asset?: string;
  pay_to: string;
  payer?: string;
  transaction?: string;
  payment_response?: unknown;
  content_sha256?: string;
  created_at: string;
  delivered_via: 'direct' | 'disposable_link';
  disposable_link_expires_at?: string;
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
  resource: {
    url: string;
    description?: string;
    mimeType?: string;
  };
  accepts: PaymentAccept[];
  error: string;
  extensions?: Record<string, unknown>;
}

export interface PaymentAccept {
  scheme: 'exact' | 'upto' | string;
  network: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: Record<string, unknown>;
}

/** Decoded contents of the x402 payment signature header */
export interface PaymentPayload {
  x402Version: number;
  resource?: {
    url: string;
    description?: string;
    mimeType?: string;
  };
  accepted: PaymentAccept;
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
  invalidMessage?: string;
  payer?: string;
}

/** Facilitator /settle response */
export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  transaction?: string;
  network?: string;
  payer?: string;
}
