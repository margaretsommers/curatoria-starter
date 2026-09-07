import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertSafeObservabilityEvent,
  createCorrelationId,
  createObservabilityEvent,
  createObservabilitySink,
  emitObserved,
  outcomeFromStatus,
  resolveCorrelationId,
  type ObservabilityEvent,
} from './observability';

function validEvent(
  overrides: Partial<ObservabilityEvent> = {},
): ObservabilityEvent {
  return {
    schema_version: 1,
    correlation_id: 'corr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    receipt_id: `rcpt_${'r'.repeat(43)}`,
    stage: 'purchase',
    duration_ms: 12,
    bytes: 43,
    provider: 'local',
    outcome: 'ok',
    ...overrides,
  };
}

test('createObservabilityEvent accepts the allowlisted delivery fields', () => {
  const event = createObservabilityEvent({
    correlation_id: 'corr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    receipt_id: `rcpt_${'s'.repeat(43)}`,
    stage: 'redeem',
    duration_ms: 4,
    bytes: 43,
    provider: 'gdrive',
    outcome: 'ok',
  });
  assert.deepEqual(event, {
    schema_version: 1,
    correlation_id: 'corr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    receipt_id: `rcpt_${'s'.repeat(43)}`,
    stage: 'redeem',
    duration_ms: 4,
    bytes: 43,
    provider: 'gdrive',
    outcome: 'ok',
  });
});

test('createCorrelationId and resolveCorrelationId stay within the safe pattern', () => {
  const generated = createCorrelationId();
  assert.match(generated, /^corr_[a-f0-9]{32}$/);
  assert.equal(resolveCorrelationId(generated), generated);
  assert.match(resolveCorrelationId('not-a-correlation'), /^corr_[a-f0-9]{32}$/);
  assert.match(resolveCorrelationId('corr_short'), /^corr_[a-f0-9]{32}$/);
});

test('redaction rejects auth headers, entitlements, signed and source URLs, and file content', () => {
  const secrets: Array<[string, unknown]> = [
    ['authorization', 'Bearer secret-capability'],
    ['Authorization', 'Basic abcdefgh'],
    ['entitlement', 'eyJhbGciOiJIUzI1NiJ9.payload.sig'],
    ['signed_url', 'https://blob.vercel-storage.com/asset?sig=1'],
    ['source_url', 'https://drive.google.com/file/d/example'],
    ['download_url', 'https://blob.example/signed-60s'],
    ['file_content', '8BPS'],
    ['auth_header', 'authorization: Bearer secret'],
  ];
  for (const [key, value] of secrets) {
    const payload = { ...validEvent(), [key]: value };
    assert.throws(
      () => assertSafeObservabilityEvent(payload),
      (error: Error) =>
        /redacted|unexpected field|invalid/i.test(error.message) &&
        !error.message.includes(String(value)),
    );
  }
});

test('redaction rejects secret-like string values without echoing them', () => {
  const entitlement = `rcpt_${'e'.repeat(43)}`;
  const attempts: Array<Partial<ObservabilityEvent>> = [
    { correlation_id: 'Bearer leaked-token-value-here' },
    { receipt_id: 'https://evil.example/source' },
    { receipt_id: `8BPS${'x'.repeat(40)}` },
  ];
  for (const override of attempts) {
    assert.throws(
      () => createObservabilityEvent({ ...validEvent(), ...override } as never),
      (error: Error) => {
        const serialized = error.message;
        assert.equal(serialized.includes('Bearer leaked-token-value-here'), false);
        assert.equal(serialized.includes('https://evil.example/source'), false);
        assert.equal(serialized.includes('8BPS'), false);
        assert.equal(serialized.includes(entitlement), false);
        return /redacted|invalid/i.test(serialized);
      },
    );
  }
});

test('sink serializes only the allowlisted event and drops unsafe emits', () => {
  const lines: string[] = [];
  const sink = createObservabilitySink(line => {
    lines.push(line);
  });
  sink.emit(validEvent());
  const parsed = JSON.parse(lines[0] ?? '{}') as ObservabilityEvent;
  assert.equal(parsed.stage, 'purchase');
  assert.equal(parsed.receipt_id, `rcpt_${'r'.repeat(43)}`);
  assert.equal(JSON.stringify(parsed).includes('https://'), false);
  assert.equal(JSON.stringify(parsed).includes('Bearer'), false);
  assert.equal(JSON.stringify(parsed).includes('entitlement'), false);

  const dropped = emitObserved(sink, {
    ...validEvent(),
    receipt_id: 'https://blob.example/signed',
  } as never);
  assert.equal(dropped, undefined);
  assert.equal(lines.length, 1);
});

test('outcomeFromStatus preserves the 401 rejected versus 503 unavailable split', () => {
  assert.equal(outcomeFromStatus(200), 'ok');
  assert.equal(outcomeFromStatus(401), 'rejected');
  assert.equal(outcomeFromStatus(404), 'rejected');
  assert.equal(outcomeFromStatus(503), 'unavailable');
  assert.equal(outcomeFromStatus(500), 'error');
});
