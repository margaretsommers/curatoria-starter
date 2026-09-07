/**
 * Structured delivery events for paid PSD purchase, recovery, and redemption.
 * Events are allowlisted and fail closed: forbidden keys or secret-like values
 * are rejected without echoing the offending material.
 */

import crypto from 'node:crypto';

export const OBSERVABILITY_SCHEMA_VERSION = 1;
export const CORRELATION_ID_PATTERN = /^corr_[A-Za-z0-9_-]{8,128}$/;
export const RECEIPT_ID_PATTERN = /^rcpt_[A-Za-z0-9_-]{32,128}$/;

export const DELIVERY_STAGES = [
  'purchase',
  'recover',
  'redeem',
  'sign',
  'blob',
  'download',
  'receipt_write',
  'preview',
] as const;

export const DELIVERY_OUTCOMES = ['ok', 'error', 'rejected', 'unavailable'] as const;
export const DELIVERY_PROVIDERS = ['local', 'url', 'gdrive', 'dropbox'] as const;

export type DeliveryStage = (typeof DELIVERY_STAGES)[number];
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];
export type DeliveryProvider = (typeof DELIVERY_PROVIDERS)[number];

export type ObservabilityEvent = {
  schema_version: typeof OBSERVABILITY_SCHEMA_VERSION;
  correlation_id: string;
  receipt_id?: string;
  stage: DeliveryStage;
  duration_ms: number;
  bytes?: number;
  provider?: DeliveryProvider;
  outcome: DeliveryOutcome;
};

export type ObservabilityInput = {
  correlation_id?: string;
  receipt_id?: string;
  stage: DeliveryStage;
  duration_ms: number;
  bytes?: number;
  provider?: DeliveryProvider;
  outcome: DeliveryOutcome;
};

export type ObservabilitySink = {
  emit(event: ObservabilityEvent): void;
};

const ALLOWED_KEYS = [
  'schema_version',
  'correlation_id',
  'receipt_id',
  'stage',
  'duration_ms',
  'bytes',
  'provider',
  'outcome',
] as const;

const FORBIDDEN_KEY_PARTS = [
  'authorization',
  'authheader',
  'bearer',
  'cookie',
  'credential',
  'downloadurl',
  'entitlement',
  'paymentproof',
  'paymentsignature',
  'presigned',
  'signedurl',
  'sourceurl',
  'token',
];

const FORBIDDEN_CONTENT = [
  /(?:https?|s3):\/\//i,
  /\bauthorization\s*:/i,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b8BPS/,
  /blob\.vercel-storage\.com/i,
  /drive\.google\.com/i,
  /dropbox\.com/i,
];

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_SAFE_STRING_BYTES = 256;

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function createCorrelationId(): string {
  return `corr_${crypto.randomBytes(16).toString('hex')}`;
}

export function resolveCorrelationId(candidate: string | undefined): string {
  const trimmed = candidate?.trim();
  if (trimmed && CORRELATION_ID_PATTERN.test(trimmed) && !CONTROL_CHARACTERS.test(trimmed)) {
    return trimmed;
  }
  return createCorrelationId();
}

export function createObservabilityEvent(input: ObservabilityInput): ObservabilityEvent {
  const event: ObservabilityEvent = {
    schema_version: OBSERVABILITY_SCHEMA_VERSION,
    correlation_id: input.correlation_id ?? createCorrelationId(),
    stage: input.stage,
    duration_ms: input.duration_ms,
    outcome: input.outcome,
  };
  if (input.receipt_id !== undefined) event.receipt_id = input.receipt_id;
  if (input.bytes !== undefined) event.bytes = input.bytes;
  if (input.provider !== undefined) event.provider = input.provider;
  return assertSafeObservabilityEvent(event);
}

export function assertSafeObservabilityEvent(value: unknown): ObservabilityEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Observability event must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    rejectForbiddenKey(key);
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
      throw new Error('Observability event contains an unexpected field; value was redacted.');
    }
  }
  if (record.schema_version !== OBSERVABILITY_SCHEMA_VERSION) {
    throw new Error('Observability event schema_version is unsupported.');
  }
  assertSafeId(record.correlation_id, 'correlation_id', CORRELATION_ID_PATTERN);
  if (record.receipt_id !== undefined) {
    assertSafeId(record.receipt_id, 'receipt_id', RECEIPT_ID_PATTERN);
  }
  if (
    typeof record.stage !== 'string' ||
    !(DELIVERY_STAGES as readonly string[]).includes(record.stage)
  ) {
    throw new Error('Observability event stage is invalid.');
  }
  if (
    typeof record.outcome !== 'string' ||
    !(DELIVERY_OUTCOMES as readonly string[]).includes(record.outcome)
  ) {
    throw new Error('Observability event outcome is invalid.');
  }
  assertNonNegativeInteger(record.duration_ms, 'duration_ms');
  if (record.bytes !== undefined) assertNonNegativeInteger(record.bytes, 'bytes');
  if (
    record.provider !== undefined &&
    (typeof record.provider !== 'string' ||
      !(DELIVERY_PROVIDERS as readonly string[]).includes(record.provider))
  ) {
    throw new Error('Observability event provider is invalid.');
  }
  return {
    schema_version: OBSERVABILITY_SCHEMA_VERSION,
    correlation_id: record.correlation_id as string,
    ...(typeof record.receipt_id === 'string' ? { receipt_id: record.receipt_id } : {}),
    stage: record.stage as DeliveryStage,
    duration_ms: record.duration_ms as number,
    ...(record.bytes !== undefined ? { bytes: record.bytes as number } : {}),
    ...(typeof record.provider === 'string'
      ? { provider: record.provider as DeliveryProvider }
      : {}),
    outcome: record.outcome as DeliveryOutcome,
  };
}

export function createObservabilitySink(write: (line: string) => void): ObservabilitySink {
  return {
    emit(event) {
      const safe = assertSafeObservabilityEvent(event);
      write(JSON.stringify(safe));
    },
  };
}

export function emitObserved(
  sink: ObservabilitySink | undefined,
  input: ObservabilityInput,
): ObservabilityEvent | undefined {
  try {
    const event = createObservabilityEvent(input);
    sink?.emit(event);
    return event;
  } catch {
    return undefined;
  }
}

export function outcomeFromStatus(status: number): DeliveryOutcome {
  if (status === 200) return 'ok';
  if (status === 401 || status === 404) return 'rejected';
  if (status === 503) return 'unavailable';
  return 'error';
}

function assertSafeId(value: unknown, label: string, pattern: RegExp): asserts value is string {
  if (typeof value !== 'string' || !pattern.test(value) || CONTROL_CHARACTERS.test(value)) {
    throw new Error(`Observability event ${label} is invalid.`);
  }
  assertSafeString(value, label);
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`Observability event ${label} must be a non-negative integer.`);
  }
}

function rejectForbiddenKey(key: string): void {
  const normalized = normalizedKey(key);
  if (FORBIDDEN_KEY_PARTS.some(part => normalized.includes(part))) {
    throw new Error('Forbidden observability field detected; value was redacted.');
  }
}

function assertSafeString(value: string, location: string): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_SAFE_STRING_BYTES) {
    throw new Error(`Observability string at ${location} exceeds the bounded inspection limit.`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new Error(`Control character detected in observability event; value was redacted.`);
  }
  if (FORBIDDEN_CONTENT.some(pattern => pattern.test(value))) {
    throw new Error('Forbidden observability content detected; value was redacted.');
  }
}
