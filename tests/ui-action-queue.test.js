import test from 'node:test';
import assert from 'node:assert/strict';
import { UiActionQueue, UI_ACTION_PRIORITIES } from '../src/background/ui-action-queue.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function slotStore(slot = { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 3, status: 'assigned' }) {
  return { async load() { return structuredClone(slot); } };
}

test('UI action queue serializes foreground work and restores the user tab after the burst drains', async () => {
  const calls = [];
  const tabs = {
    async query(filter) { calls.push(['query', filter]); return [{ id: 99, active: true }]; },
    async update(tabId, update) { calls.push(['update', tabId, update]); return { id: tabId, ...update }; },
    async get(tabId) { calls.push(['get', tabId]); return { id: tabId }; }
  };
  const queue = new UiActionQueue({ tabs, slotStore: slotStore() });
  const firstGate = deferred();

  const first = queue.enqueue({
    slotId: 'chatgpt-1', tabId: 17, taskId: 'task-a', generation: 3,
    actionType: 'SEND_PROMPT', priority: UI_ACTION_PRIORITIES.RESPONSE,
    run: async () => { calls.push(['run', 'first']); await firstGate.promise; return 'first'; }
  });
  const second = queue.enqueue({
    slotId: 'chatgpt-1', tabId: 17, taskId: 'task-a', generation: 3,
    actionType: 'CREATE_PROJECT', priority: UI_ACTION_PRIORITIES.INITIALIZATION,
    run: async () => { calls.push(['run', 'second']); return 'second'; }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.filter(call => call[0] === 'run'), [['run', 'first']]);
  firstGate.resolve();
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  await queue.whenIdle();

  assert.deepEqual(calls.filter(call => call[0] === 'run'), [['run', 'first'], ['run', 'second']]);
  assert.deepEqual(calls.filter(call => call[0] === 'update'), [
    ['update', 17, { active: true }],
    ['update', 17, { active: true }],
    ['update', 99, { active: true }]
  ]);
});

test('UI action queue prioritizes queued recovery over response and initialization work', async () => {
  const order = [];
  const gate = deferred();
  const tabs = {
    async query() { return [{ id: 90, active: true }]; },
    async update() {},
    async get(tabId) { return { id: tabId }; }
  };
  const queue = new UiActionQueue({ tabs, slotStore: slotStore() });

  const active = queue.enqueue({ slotId: 'chatgpt-1', tabId: 17, taskId: 'task-a', generation: 3, actionType: 'ACTIVE', priority: 0, run: async () => { order.push('active'); await gate.promise; } });
  const initialization = queue.enqueue({ slotId: 'chatgpt-1', tabId: 17, taskId: 'task-a', generation: 3, actionType: 'INIT', priority: UI_ACTION_PRIORITIES.INITIALIZATION, run: async () => { order.push('init'); } });
  const response = queue.enqueue({ slotId: 'chatgpt-1', tabId: 17, taskId: 'task-a', generation: 3, actionType: 'RESPONSE', priority: UI_ACTION_PRIORITIES.RESPONSE, run: async () => { order.push('response'); } });
  const recovery = queue.enqueue({ slotId: 'chatgpt-1', tabId: 17, taskId: 'task-a', generation: 3, actionType: 'RECOVERY', priority: UI_ACTION_PRIORITIES.RECOVERY, run: async () => { order.push('recovery'); } });

  await new Promise(resolve => setImmediate(resolve));
  gate.resolve();
  await Promise.all([active, initialization, response, recovery]);
  assert.deepEqual(order, ['active', 'recovery', 'response', 'init']);
});

test('UI action queue deduplicates the same in-flight generation action', async () => {
  let runs = 0;
  const gate = deferred();
  const queue = new UiActionQueue({
    tabs: { async query() { return []; }, async update() {}, async get(tabId) { return { id: tabId }; } },
    slotStore: slotStore()
  });
  const item = {
    slotId: 'chatgpt-1', tabId: 17, taskId: 'task-a', generation: 3,
    actionType: 'PROCESS_RESPONSE', priority: UI_ACTION_PRIORITIES.RESPONSE,
    run: async () => { runs += 1; await gate.promise; return 'ok'; }
  };
  const first = queue.enqueue(item);
  const duplicate = queue.enqueue(item);
  assert.equal(first, duplicate);
  gate.resolve();
  assert.equal(await first, 'ok');
  assert.equal(runs, 1);
});

test('UI action queue refuses a stale slot generation before touching the browser', async () => {
  let ran = false;
  const queue = new UiActionQueue({
    tabs: { async query() { return []; }, async update() { throw new Error('must not activate'); }, async get(tabId) { return { id: tabId }; } },
    slotStore: slotStore({ slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-new', generation: 4, status: 'assigned' })
  });

  await assert.rejects(
    queue.enqueue({
      slotId: 'chatgpt-1', tabId: 17, taskId: 'task-old', generation: 3,
      actionType: 'PROCESS_RESPONSE', priority: UI_ACTION_PRIORITIES.RESPONSE,
      run: async () => { ran = true; }
    }),
    error => error?.code === 'STALE_UI_ACTION'
  );
  assert.equal(ran, false);
});

test('UI action queue rotates across slots before serving another action from the previous slot', async () => {
  const order = [];
  const gate = deferred();
  const slots = new Map([
    ['chatgpt-1', { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 3, status: 'assigned' }],
    ['chatgpt-2', { slot_id: 'chatgpt-2', tab_id: 18, task_id: 'task-b', generation: 1, status: 'assigned' }],
    ['chatgpt-3', { slot_id: 'chatgpt-3', tab_id: 19, task_id: 'task-c', generation: 1, status: 'assigned' }]
  ]);
  const queue = new UiActionQueue({
    tabs: { async query() { return []; }, async update() {}, async get(tabId) { return { id: tabId }; } },
    slotStore: { async load(slotId) { return structuredClone(slots.get(slotId)); } }
  });

  const active = queue.enqueue({ slotId: 'chatgpt-1', tabId: 17, taskId: 'task-a', generation: 3, actionType: 'ACTIVE', priority: UI_ACTION_PRIORITIES.RECOVERY, run: async () => { order.push('slot1-active'); await gate.promise; } });
  const slot1Recovery = queue.enqueue({ slotId: 'chatgpt-1', tabId: 17, taskId: 'task-a', generation: 3, actionType: 'RECOVERY_AGAIN', priority: UI_ACTION_PRIORITIES.RECOVERY, run: async () => { order.push('slot1-recovery'); } });
  const slot2Response = queue.enqueue({ slotId: 'chatgpt-2', tabId: 18, taskId: 'task-b', generation: 1, actionType: 'RESPONSE', priority: UI_ACTION_PRIORITIES.RESPONSE, run: async () => { order.push('slot2-response'); } });
  const slot3Init = queue.enqueue({ slotId: 'chatgpt-3', tabId: 19, taskId: 'task-c', generation: 1, actionType: 'INIT', priority: UI_ACTION_PRIORITIES.INITIALIZATION, run: async () => { order.push('slot3-init'); } });

  await new Promise(resolve => setImmediate(resolve));
  gate.resolve();
  await Promise.all([active, slot1Recovery, slot2Response, slot3Init]);

  assert.deepEqual(order, ['slot1-active', 'slot2-response', 'slot3-init', 'slot1-recovery']);
});

test('UI action queue records successful actions as progress for the current slot generation', async () => {
  const progress = [];
  const queue = new UiActionQueue({
    tabs: { async query() { return []; }, async update() {}, async get(tabId) { return { id: tabId }; } },
    slotStore: {
      async load() { return { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 3, status: 'assigned' }; },
      async recordUiAction(value) { progress.push(structuredClone(value)); }
    }
  });

  await queue.enqueue({
    slotId: 'chatgpt-1', tabId: 17, taskId: 'task-a', generation: 3,
    actionType: 'SEND_PROMPT', priority: UI_ACTION_PRIORITIES.RESPONSE,
    run: async () => 'sent'
  });

  assert.equal(progress.length, 1);
  assert.equal(progress[0].slotId, 'chatgpt-1');
  assert.equal(progress[0].actionType, 'SEND_PROMPT');
});

test('UI action queue exposes bounded backlog stats for adaptive backpressure without leaking action payloads', async () => {
  const gate = deferred();
  const queue = new UiActionQueue({
    tabs: { async query() { return []; }, async update() {}, async get(tabId) { return { id: tabId }; } },
    slotStore: slotStore()
  });
  const active = queue.enqueue({ slotId: 'chatgpt-1', tabId: 17, taskId: 'task-a', generation: 3, actionType: 'ACTIVE', run: async () => gate.promise });
  queue.enqueue({ slotId: 'chatgpt-1', tabId: 17, taskId: 'task-a', generation: 3, actionType: 'SECOND', dedupeKey: 'second', run: async () => 'second' });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(queue.getStats(), { pending: 1, in_flight: 2, draining: true });
  gate.resolve('done');
  await active;
  await queue.whenIdle();
  assert.deepEqual(queue.getStats(), { pending: 0, in_flight: 0, draining: false });
});
