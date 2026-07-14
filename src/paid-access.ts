import { DisposableAccessPolicy } from './types';

export type DisposableAccessFailureReason =
  | 'disabled'
  | 'expired'
  | 'downloads_exhausted'
  | 'views_exhausted'
  | 'bytes_exceeded';

export interface NormalizedDisposableAccessPolicy {
  enabled: boolean;
  maxDownloads: number;
  maxViews: number;
  hoursValid: number;
  maxTotalBytes?: number;
  allowRegenerationAfterPayment: boolean;
  delivery: 'fallback_when_direct_too_large' | 'disposable_link_only';
}

export interface DisposableLinkState {
  linkId: string;
  resourceId: string;
  receiptId: string;
  expiresAt: string;
  remainingDownloads: number;
  remainingViews: number;
  bytesServed: number;
  maxTotalBytes?: number;
  contentSha256?: string;
}

export interface DisposableLinkCheck {
  ok: boolean;
  reason?: DisposableAccessFailureReason;
}

function assertPositiveNumber(value: number | undefined, field: string): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number.`);
  }
}

function assertPositiveInteger(value: number | undefined, field: string): void {
  assertPositiveNumber(value, field);
  if (value !== undefined && !Number.isInteger(value)) {
    throw new Error(`${field} must be a whole number.`);
  }
}

export function normalizeDisposableAccessPolicy(
  policy: DisposableAccessPolicy | undefined,
): NormalizedDisposableAccessPolicy {
  if (!policy?.enabled) {
    return {
      enabled: false,
      maxDownloads: 0,
      maxViews: 0,
      hoursValid: 0,
      allowRegenerationAfterPayment: false,
      delivery: 'fallback_when_direct_too_large',
    };
  }

  assertPositiveInteger(policy.max_downloads, 'disposable_access.max_downloads');
  assertPositiveInteger(policy.max_views, 'disposable_access.max_views');
  assertPositiveNumber(policy.hours_valid, 'disposable_access.hours_valid');
  assertPositiveInteger(policy.max_total_bytes, 'disposable_access.max_total_bytes');

  const maxDownloads = policy.max_downloads ?? 1;
  const maxViews = policy.max_views ?? maxDownloads;

  return {
    enabled: true,
    maxDownloads,
    maxViews,
    hoursValid: policy.hours_valid ?? 24,
    maxTotalBytes: policy.max_total_bytes,
    allowRegenerationAfterPayment: policy.allow_regeneration_after_payment ?? false,
    delivery: policy.delivery ?? 'fallback_when_direct_too_large',
  };
}

export function createDisposableLinkState(input: {
  linkId: string;
  resourceId: string;
  receiptId: string;
  policy: DisposableAccessPolicy;
  issuedAt?: Date;
  contentSha256?: string;
}): DisposableLinkState {
  const policy = normalizeDisposableAccessPolicy(input.policy);
  if (!policy.enabled) {
    throw new Error('Cannot create a disposable link when disposable_access.enabled is false.');
  }

  const issuedAtMs = input.issuedAt?.getTime() ?? Date.now();
  const expiresAt = new Date(issuedAtMs + policy.hoursValid * 60 * 60 * 1000).toISOString();

  return {
    linkId: input.linkId,
    resourceId: input.resourceId,
    receiptId: input.receiptId,
    expiresAt,
    remainingDownloads: policy.maxDownloads,
    remainingViews: policy.maxViews,
    bytesServed: 0,
    maxTotalBytes: policy.maxTotalBytes,
    contentSha256: input.contentSha256,
  };
}

export function checkDisposableLinkAccess(
  state: DisposableLinkState,
  options: { now?: Date; bytesToServe?: number; countDownload?: boolean } = {},
): DisposableLinkCheck {
  const nowMs = options.now?.getTime() ?? Date.now();
  if (nowMs >= new Date(state.expiresAt).getTime()) {
    return { ok: false, reason: 'expired' };
  }

  if (state.remainingViews <= 0) {
    return { ok: false, reason: 'views_exhausted' };
  }

  if ((options.countDownload ?? true) && state.remainingDownloads <= 0) {
    return { ok: false, reason: 'downloads_exhausted' };
  }

  const bytesToServe = options.bytesToServe ?? 0;
  if (
    state.maxTotalBytes !== undefined &&
    state.bytesServed + bytesToServe > state.maxTotalBytes
  ) {
    return { ok: false, reason: 'bytes_exceeded' };
  }

  return { ok: true };
}

export function recordDisposableLinkResponse(
  state: DisposableLinkState,
  options: {
    successfulResponse: boolean;
    now?: Date;
    bytesServed?: number;
    countDownload?: boolean;
  },
): { state: DisposableLinkState; access: DisposableLinkCheck } {
  const access = checkDisposableLinkAccess(state, {
    now: options.now,
    bytesToServe: options.successfulResponse ? options.bytesServed : 0,
    countDownload: options.countDownload,
  });

  if (!access.ok || !options.successfulResponse) {
    return { state, access };
  }

  return {
    access,
    state: {
      ...state,
      remainingViews: state.remainingViews - 1,
      remainingDownloads: (options.countDownload ?? true)
        ? state.remainingDownloads - 1
        : state.remainingDownloads,
      bytesServed: state.bytesServed + (options.bytesServed ?? 0),
    },
  };
}
