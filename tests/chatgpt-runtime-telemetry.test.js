import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGptRuntimeTelemetry } from '../src/background/chatgpt-runtime-telemetry.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
  return {
    async get(key) { return data.get(key); },
    async set(key, value) { data.set(key, structuredClone(value)); }
  };
}

test('runtime telemetry records active generation concurrency and rolling prompt starts without prompt text', async () => {
  const storage = memoryStorage();
  let nowMs = Date.parse('2026-08-29T14:00:00.000Z');
  const telemetry = new ChatGptRuntimeTelemetry({ storage, now: () => new Date(nowMs) });

  await telemetry.recordPromptSubmitted({ slotId: 'chatgpt-1', tabId: 11, taskId: 'task-a', type: 'initialization' });
  await telemetry.recordGenerationStart({ slotId: 'chatgpt-1', tabId: 11, taskId: 'task-a', type: 'initialization' });
  nowMs += 20_000;
  await telemetry.recordPromptSubmitted({ slotId: 'chatgpt-2', tabId: 12, taskId: 'task-b', type: 'continuation' });
  await telemetry.recordGenerationStart({ slotId: 'chatgpt-2', tabId: 12, taskId: 'task-b', type: 'continuation' });

  let snapshot = await telemetry.snapshot();
  assert.equal(snapshot.active_generation_count, 2);
  assert.equal(snapshot.prompt_starts_last_1m, 2);
  assert.equal(snapshot.prompt_starts_last_5m, 2);
  assert.equal(snapshot.prompt_starts_last_15m, 2);
  assert.deepEqual(snapshot.active_generations.map(item => item.type), ['initialization', 'continuation']);
  assert.equal(JSON.stringify(snapshot).includes('prompt text'), false);

  await telemetry.recordGenerationEnd({ slotId: 'chatgpt-1', tabId: 11, outcome: 'response_ready' });
  snapshot = await telemetry.snapshot();
  assert.equal(snapshot.active_generation_count, 1);
});

test('runtime telemetry snapshots safe access-limit evidence together with generation pressure', async () => {
  const storage = memoryStorage();
  const telemetry = new ChatGptRuntimeTelemetry({ storage, now: () => new Date('2026-08-29T14:05:00.000Z') });
  await telemetry.recordPromptSubmitted({ slotId: 'chatgpt-3', tabId: 13, taskId: 'task-c', type: 'task_prompt' });
  await telemetry.recordGenerationStart({ slotId: 'chatgpt-3', tabId: 13, taskId: 'task-c', type: 'task_prompt' });

  const evidence = await telemetry.recordAccessSignal({
    slotId: 'chatgpt-3',
    tabId: 13,
    taskId: 'task-c',
    accessState: {
      status: 'USAGE_LIMITED',
      reason: 'usage_limit_dialog',
      advisory: { kind: 'usage_limit_dialog', visible: true, composer_present: false }
    }
  });

  assert.equal(evidence.detector, 'usage_limit_dialog');
  assert.equal(evidence.composer_present, false);
  assert.equal(evidence.active_generation_count, 1);
  assert.equal(evidence.prompt_starts_last_5m, 1);
  assert.equal(JSON.stringify(evidence).includes('GPT-5'), false);
});
