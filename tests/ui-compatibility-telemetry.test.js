import test from 'node:test';
import assert from 'node:assert/strict';
import { UiCompatibilityTelemetry } from '../src/background/ui-compatibility-telemetry.js';

function memoryStorage() {
  const data = new Map();
  return {
    async get(key) { return data.get(key); },
    async set(key, value) { data.set(key, structuredClone(value)); },
    dump(key) { return data.get(key); }
  };
}

function selectorError(overrides = {}) {
  return {
    code: 'UI_SELECTOR_INCOMPATIBLE',
    message: 'Project super-secret-name selector failed',
    details: {
      diagnostics: {
        error_code: 'UI_SELECTOR_INCOMPATIBLE',
        selector_profile: { id: 'chatgpt-semantic-v1', version: 1 },
        access_state: { status: 'READY', reason: 'composer_present' },
        page: { hostname: 'chatgpt.com', pathname: '/c/:segment', title_category: 'chat' },
        control_count: 12,
        controls: [{ aria_hint: 'secret prompt body', href: 'https://chatgpt.com/c/secret?token=abc' }]
      }
    },
    ...overrides
  };
}

test('compatibility telemetry aggregates only privacy-safe compatibility metadata', async () => {
  const storage = memoryStorage();
  const telemetry = new UiCompatibilityTelemetry({ storage, now: () => new Date('2026-08-13T19:30:00Z') });

  await telemetry.record({ operation: 'CHATGPT_CREATE_PROJECT', error: selectorError() });
  await telemetry.record({ operation: 'CHATGPT_CREATE_PROJECT', error: selectorError() });

  const persisted = storage.dump('uiCompatibilityTelemetry');
  assert.equal(persisted.version, 1);
  assert.equal(persisted.total_events, 2);
  assert.equal(persisted.buckets.length, 1);
  assert.deepEqual(persisted.buckets[0], {
    selector_profile: { id: 'chatgpt-semantic-v1', version: 1 },
    operation: 'CHATGPT_CREATE_PROJECT',
    error_code: 'UI_SELECTOR_INCOMPATIBLE',
    access_status: 'READY',
    page_category: 'chat',
    count: 2,
    last_seen_at: '2026-08-13T19:30:00.000Z'
  });
  assert.deepEqual(persisted.last_event, {
    selector_profile: { id: 'chatgpt-semantic-v1', version: 1 },
    operation: 'CHATGPT_CREATE_PROJECT',
    error_code: 'UI_SELECTOR_INCOMPATIBLE',
    access_status: 'READY',
    page_category: 'chat',
    at: '2026-08-13T19:30:00.000Z'
  });

  const serialized = JSON.stringify(persisted).toLowerCase();
  for (const secret of ['super-secret-name', 'secret prompt body', 'token=abc', '/c/secret', 'controls', 'control_count', 'message']) {
    assert.equal(serialized.includes(secret), false, `telemetry leaked ${secret}`);
  }
});

test('compatibility telemetry ignores non-compatibility errors and sanitizes unknown values', async () => {
  const storage = memoryStorage();
  const telemetry = new UiCompatibilityTelemetry({ storage });

  assert.equal(await telemetry.record({ operation: 'CHATGPT_STATE', error: { code: 'MODEL_RESPONSE_TIMEOUT', details: { diagnostics: {} } } }), false);
  assert.equal(await storage.get('uiCompatibilityTelemetry'), undefined);

  await telemetry.record({
    operation: 'CHATGPT_DELETE_PROJECT<script>',
    error: {
      code: 'LOGIN_OR_CHALLENGE_REQUIRED',
      details: { diagnostics: {
        selector_profile: { id: 'custom profile !!', version: 999999999 },
        access_state: { status: 'SOMETHING_PRIVATE' },
        page: { title_category: 'private title here' }
      } }
    }
  });
  const persisted = await storage.get('uiCompatibilityTelemetry');
  assert.equal(persisted.total_events, 1);
  assert.equal(persisted.last_event.operation, 'UNKNOWN_OPERATION');
  assert.equal(persisted.last_event.access_status, 'UNKNOWN');
  assert.equal(persisted.last_event.page_category, 'unknown');
  assert.deepEqual(persisted.last_event.selector_profile, { id: 'unknown', version: null });
});

test('compatibility telemetry bounds bucket growth and exposes a compact summary', async () => {
  const storage = memoryStorage();
  let tick = 0;
  const telemetry = new UiCompatibilityTelemetry({
    storage,
    maxBuckets: 3,
    now: () => new Date(1700000000000 + (tick++ * 1000))
  });

  for (const operation of ['CHATGPT_CREATE_PROJECT', 'CHATGPT_SET_PROJECT_INSTRUCTIONS', 'CHATGPT_DELETE_PROJECT', 'CHATGPT_SEND_PROMPT']) {
    await telemetry.record({ operation, error: selectorError() });
  }

  const persisted = await storage.get('uiCompatibilityTelemetry');
  assert.equal(persisted.total_events, 4);
  assert.equal(persisted.buckets.length, 3);
  assert.equal(persisted.buckets.some(bucket => bucket.operation === 'CHATGPT_CREATE_PROJECT'), false);

  const summary = await telemetry.getSummary();
  assert.equal(summary.total_events, 4);
  assert.equal(summary.bucket_count, 3);
  assert.equal(summary.last_event.operation, 'CHATGPT_SEND_PROMPT');
  assert.equal(Array.isArray(summary.buckets), false);
});
