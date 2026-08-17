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
