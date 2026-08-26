import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/background/task-store.js';

function memoryStorage() {
  const data = new Map();
  return {
    async get(key) { return data.get(key); },
    async set(key, value) { data.set(key, structuredClone(value)); },
    async remove(key) { data.delete(key); }
  };
}

function delayedObservationStorage(delayMs = 25) {
  const data = new Map();
  return {
    async get(key) { return data.get(key); },
    async set(key, value) {
      const slot = value?.['chatgpt-1'];
      if (slot?.last_observed_state) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      data.set(key, structuredClone(value));
    },
    async remove(key) { data.delete(key); }
  };
}

test('task store persists and clears serializable execution state', async () => {
  const store = new TaskStore(memoryStorage());
  await store.save({ task_id: 't1', task_patch_count: 7, downloaded_patch_keys: ['a'] });
  assert.deepEqual(await store.load(), { task_id: 't1', task_patch_count: 7, downloaded_patch_keys: ['a'] });
  await store.clear();
  assert.equal(await store.load(), null);
});

test('task store updates persisted lease only for the matching active task', async () => {
  const store = new TaskStore(memoryStorage());
  await store.save({ task_id: 't1', lease: { token: 'old', ttl_ms: 90000 } });
  assert.equal(await store.updateLease('other', { token: 'ignored', ttl_ms: 1000 }), false);
  assert.equal((await store.load()).lease.token, 'old');
  assert.equal(await store.updateLease('t1', { token: 'new', ttl_ms: 60000 }), true);
  assert.deepEqual((await store.load()).lease, { token: 'new', ttl_ms: 60000 });
});

test('task store lease refresh checkpoints rotated token without losing agent-control lineage', async () => {
  const store = new TaskStore(memoryStorage());
  await store.save({
    task_id: 't1', agent_id: 'agent-mac', assignment_id: 'assignment-1', execution_id: 'execution-1',
    lease_token: 'old', lease: { token: 'old', ttl_ms: 90000, assignment_id: 'assignment-1', execution_id: 'execution-1', agent_id: 'agent-mac' }
  });
  const refreshed = { token: 'new', ttl_ms: 60000, assignment_id: 'assignment-1', execution_id: 'execution-1', agent_id: 'agent-mac' };
  assert.equal(await store.updateLease('t1', refreshed), true);
  const state = await store.load();
  assert.equal(state.lease_token, 'new');
  assert.equal(state.assignment_id, 'assignment-1');
  assert.equal(state.execution_id, 'execution-1');
  assert.deepEqual(state.lease, refreshed);
});

test('task store refuses stale checkpoints for Tasks explicitly terminated by the operator', async () => {
  const storeBackend = memoryStorage();
  await storeBackend.set('terminatedTaskIds', ['task-old']);
  const store = new TaskStore(storeBackend);
  const saved = await store.save({ task_id: 'task-old', phase: 'RUNNING' });
  assert.equal(saved, false);
  assert.equal(await store.load(), null);
  assert.equal(await store.save({ task_id: 'task-new', phase: 'RUNNING' }), true);
  assert.equal((await store.load()).task_id, 'task-new');
});

test('browser tab slot store keeps an idle tab across Tasks and advances the assignment generation', async () => {
  const module = await import('../src/background/task-store.js');
  assert.equal(typeof module.BrowserTabSlotStore, 'function');
  const storage = memoryStorage();
  const slots = new module.BrowserTabSlotStore(storage);

  const first = await slots.assign({ taskId: 'task-a', tabId: 17 });
  assert.deepEqual(first, {
    slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 1, status: 'assigned'
  });

  const idle = await slots.release({ taskId: 'task-a', tabId: 17 });
  assert.deepEqual(idle, {
    slot_id: 'chatgpt-1', tab_id: 17, task_id: null, generation: 1, status: 'idle'
  });

  const second = await slots.assign({ taskId: 'task-b', tabId: 17 });
  assert.deepEqual(second, {
    slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-b', generation: 2, status: 'assigned'
  });
});

test('browser tab slot store resolves slots by tab and records passive observations for the current generation', async () => {
  const module = await import('../src/background/task-store.js');
  const storage = memoryStorage();
  const slots = new module.BrowserTabSlotStore(storage);
  await slots.assign({ taskId: 'task-a', tabId: 17, slotId: 'chatgpt-1' });
  await slots.assign({ taskId: 'task-b', tabId: 18, slotId: 'chatgpt-2' });

  assert.equal((await slots.findByTabId(18)).slot_id, 'chatgpt-2');
  assert.equal((await slots.list()).length, 2);
  const observed = await slots.recordObservation({
    slotId: 'chatgpt-1', tabId: 17, generation: 1, state: 'READY', source: 'content_event', observedAt: '2026-08-26T03:00:00.000Z'
  });
  assert.equal(observed.last_observed_state, 'READY');
  assert.equal(observed.last_observation_source, 'content_event');

  const stale = await slots.recordObservation({
    slotId: 'chatgpt-1', tabId: 17, generation: 0, state: 'GENERATING', source: 'late_event', observedAt: '2026-08-26T02:59:00.000Z'
  });
  assert.equal(stale.last_observed_state, 'READY');
});

test('browser tab slot store does not let a delayed heartbeat overwrite a newer Task assignment', async () => {
  const module = await import('../src/background/task-store.js');
  const slots = new module.BrowserTabSlotStore(delayedObservationStorage());

  await slots.assign({ taskId: 'task-a', tabId: 17 });
  await slots.release({ taskId: 'task-a', tabId: 17 });

  const observation = slots.recordObservation({
    slotId: 'chatgpt-1', tabId: 17, generation: 1, state: 'READY', source: 'background_heartbeat', observedAt: '2026-08-26T06:00:00.000Z'
  });
  await new Promise(resolve => setTimeout(resolve, 1));
  const assignment = slots.assign({ taskId: 'task-b', tabId: 17 });

  await Promise.all([observation, assignment]);
  assert.deepEqual(await slots.load('chatgpt-1'), {
    slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-b', generation: 2, status: 'assigned'
  });
});

test('browser tab slot store preserves concurrent assignments for different future worker slots', async () => {
  const module = await import('../src/background/task-store.js');
  const slots = new module.BrowserTabSlotStore(memoryStorage());

  await Promise.all([
    slots.assign({ taskId: 'task-a', tabId: 17, slotId: 'chatgpt-1' }),
    slots.assign({ taskId: 'task-b', tabId: 18, slotId: 'chatgpt-2' })
  ]);

  assert.deepEqual(await slots.list(), [
    { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 1, status: 'assigned' },
    { slot_id: 'chatgpt-2', tab_id: 18, task_id: 'task-b', generation: 1, status: 'assigned' }
  ]);
});

test('slot storage views isolate durable execution state while slot 1 keeps legacy keys', async () => {
  const module = await import('../src/background/task-store.js');
  assert.equal(typeof module.createSlotStorageView, 'function');
  const backend = memoryStorage();
  const slot1 = module.createSlotStorageView(backend, 'chatgpt-1');
  const slot2 = module.createSlotStorageView(backend, 'chatgpt-2');

  await slot1.set('activeExecution', { task_id: 'task-a', phase: 'RUNNING' });
  await slot1.set('lastRun', { status: 'waiting_external', taskId: 'task-a' });
  await slot1.set('lastRecovery', { status: 'scheduled', taskId: 'task-a' });
  await slot2.set('activeExecution', { task_id: 'task-b', phase: 'RUNNING' });
  await slot2.set('lastRun', { status: 'completed', taskId: 'task-b' });
  await slot2.set('lastRecovery', { status: 'completed', taskId: 'task-b' });

  assert.equal((await slot1.get('activeExecution')).task_id, 'task-a');
  assert.equal((await slot2.get('activeExecution')).task_id, 'task-b');
  assert.equal((await backend.get('activeExecution')).task_id, 'task-a');
  assert.equal((await backend.get('lastRun')).taskId, 'task-a');
  assert.equal((await backend.get('lastRecovery')).taskId, 'task-a');
  assert.equal(await backend.get('activeExecution:chatgpt-2'), undefined);
  assert.equal((await backend.get('slotExecutionState:chatgpt-2')).activeExecution.task_id, 'task-b');
  assert.equal((await backend.get('slotExecutionState:chatgpt-2')).lastRun.taskId, 'task-b');
  assert.equal((await backend.get('slotExecutionState:chatgpt-2')).lastRecovery.taskId, 'task-b');

  await slot2.remove('activeExecution');
  assert.equal(await slot2.get('activeExecution'), undefined);
  assert.equal((await slot1.get('activeExecution')).task_id, 'task-a');
});

test('slot storage views keep shared settings and pause flags shared across worker slots', async () => {
  const module = await import('../src/background/task-store.js');
  const backend = memoryStorage();
  const slot1 = module.createSlotStorageView(backend, 'chatgpt-1');
  const slot3 = module.createSlotStorageView(backend, 'chatgpt-3');

  await slot3.set('settings', { mode: 'real', maxParallelTasks: 3 });
  await slot1.set('manualPaused', true);

  assert.deepEqual(await slot1.get('settings'), { mode: 'real', maxParallelTasks: 3 });
  assert.deepEqual(await slot3.get('settings'), { mode: 'real', maxParallelTasks: 3 });
  assert.equal(await slot3.get('manualPaused'), true);
});

test('browser tab slot store tracks semantic progress without treating identical heartbeats as progress', async () => {
  const module = await import('../src/background/task-store.js');
  const slots = new module.BrowserTabSlotStore(memoryStorage());
  await slots.assign({ taskId: 'task-a', tabId: 17, slotId: 'chatgpt-1' });

  const first = await slots.recordObservation({
    slotId: 'chatgpt-1', tabId: 17, generation: 1, state: 'READY', source: 'content_event', observedAt: '2026-08-26T08:00:00.000Z'
  });
  assert.equal(first.last_progress_at, '2026-08-26T08:00:00.000Z');

  const heartbeat = await slots.recordObservation({
    slotId: 'chatgpt-1', tabId: 17, generation: 1, state: 'READY', source: 'content_heartbeat', observedAt: '2026-08-26T08:05:00.000Z'
  });
  assert.equal(heartbeat.last_heartbeat_at, '2026-08-26T08:05:00.000Z');
  assert.equal(heartbeat.last_progress_at, '2026-08-26T08:00:00.000Z');

  const changed = await slots.recordObservation({
    slotId: 'chatgpt-1', tabId: 17, generation: 1, state: 'GENERATING', source: 'background_heartbeat', observedAt: '2026-08-26T08:06:00.000Z'
  });
  assert.equal(changed.last_progress_at, '2026-08-26T08:06:00.000Z');
});

test('browser tab slot store records successful foreground UI actions as slot progress', async () => {
  const module = await import('../src/background/task-store.js');
  const slots = new module.BrowserTabSlotStore(memoryStorage());
  await slots.assign({ taskId: 'task-a', tabId: 17, slotId: 'chatgpt-1' });

  const next = await slots.recordUiAction({
    slotId: 'chatgpt-1', tabId: 17, generation: 1, actionType: 'SEND_PROMPT', actedAt: '2026-08-26T08:07:00.000Z'
  });

  assert.equal(next.last_ui_action_at, '2026-08-26T08:07:00.000Z');
  assert.equal(next.last_ui_action_type, 'SEND_PROMPT');
  assert.equal(next.last_progress_at, '2026-08-26T08:07:00.000Z');
});

test('browser tab slot store can record recovery using slot identity when tab generation details are omitted', async () => {
  const module = await import('../src/background/task-store.js');
  const slots = new module.BrowserTabSlotStore(memoryStorage());
  await slots.assign({ taskId: 'task-a', tabId: 17, slotId: 'chatgpt-1' });

  const next = await slots.recordRecovery({
    slotId: 'chatgpt-1', reason: 'manual_recovery', recoveredAt: '2026-08-26T08:08:00.000Z'
  });

  assert.equal(next.recovery_count, 1);
  assert.equal(next.last_recovery_reason, 'manual_recovery');
});


test('browser tab slot assignment preserves the original assigned timestamp across same-task tab recovery', async () => {
  const module = await import('../src/background/task-store.js');
  const slots = new module.BrowserTabSlotStore(memoryStorage());
  const first = await slots.assign({ taskId: 'task-a', tabId: 17, slotId: 'chatgpt-2', assignedAt: '2026-08-26T10:00:00.000Z' });
  const recovered = await slots.assign({ taskId: 'task-a', tabId: 18, slotId: 'chatgpt-2', assignedAt: '2026-08-26T10:10:00.000Z' });
  assert.equal(first.assigned_at, '2026-08-26T10:00:00.000Z');
  assert.equal(recovered.assigned_at, '2026-08-26T10:00:00.000Z');
  const nextTask = await slots.assign({ taskId: 'task-b', tabId: 18, slotId: 'chatgpt-2', assignedAt: '2026-08-26T10:20:00.000Z' });
  assert.equal(nextTask.assigned_at, '2026-08-26T10:20:00.000Z');
});

test('browser tab slot recovery circuit degrades at three attempts, opens at five, and semantic progress resets the window', async () => {
  const module = await import('../src/background/task-store.js');
  const slots = new module.BrowserTabSlotStore(memoryStorage());
  await slots.assign({ taskId: 'task-circuit', tabId: 17, slotId: 'chatgpt-1' });
  const times = ['10:00:00','10:01:00','10:02:00','10:03:00','10:04:00'];
  let state;
  for (const time of times) state = await slots.recordRecovery({ slotId: 'chatgpt-1', reason: 'tab_lost', recoveredAt: `2026-08-26T${time}.000Z` });
  assert.equal(state.recovery_window_count, 5);
  assert.equal(state.recovery_circuit_state, 'open');
  assert.equal(state.recovery_count, 5);
  await slots.recordUiAction({ slotId: 'chatgpt-1', tabId: 17, generation: 1, actionType: 'MANUAL_RECOVER', actedAt: '2026-08-26T10:05:00.000Z' });
  state = await slots.load('chatgpt-1');
  assert.equal(state.recovery_window_count, 0);
  assert.equal(state.recovery_circuit_state, 'closed');
});

test('browser tab slot recovery window drops attempts older than ten minutes', async () => {
  const module = await import('../src/background/task-store.js');
  const slots = new module.BrowserTabSlotStore(memoryStorage());
  await slots.assign({ taskId: 'task-window', tabId: 17, slotId: 'chatgpt-1' });
  await slots.recordRecovery({ slotId: 'chatgpt-1', recoveredAt: '2026-08-26T10:00:00.000Z' });
  const next = await slots.recordRecovery({ slotId: 'chatgpt-1', recoveredAt: '2026-08-26T10:11:00.000Z' });
  assert.equal(next.recovery_window_count, 1);
  assert.equal(next.recovery_circuit_state, 'closed');
});
