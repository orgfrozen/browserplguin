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
