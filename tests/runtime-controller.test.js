import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeController } from '../src/background/runtime-controller.js';

function storage() {
  const data = new Map();
  return {
    async get(key) { return data.get(key); },
    async set(key, value) { data.set(key, structuredClone(value)); }
  };
}

test('runtime controller runs selected mock task and persists last result', async () => {
  const store = storage();
  const tasks = [{ task_id: 'a' }, { task_id: 'b' }];
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => tasks,
    createMockRunner: task => ({ async runOnce() { return { status: 'completed', taskId: task.task_id }; } }),
    createRealRunner: async () => { throw new Error('not used'); }
  });
  const result = await controller.runMock('b');
  assert.deepEqual(result, { status: 'completed', taskId: 'b' });
  assert.equal((await controller.getStatus()).lastRun.taskId, 'b');
});

test('runtime controller refuses overlapping runs', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const controller = new RuntimeController({
    storage: storage(),
    loadMockTasks: async () => [{ task_id: 'a' }],
    createMockRunner: () => ({ async runOnce() { await gate; return { status: 'completed' }; } }),
    createRealRunner: async () => ({ runOnce: async () => ({ status: 'completed' }) })
  });
  const first = controller.runMock('a');
  await assert.rejects(controller.runMock('a'), /already running/);
  release();
  await first;
});

test('runtime controller exposes explicit real recovery without claiming a new task', async () => {
  const store = storage();
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => ({
      async runOnce() { throw new Error('must not claim during recovery'); },
      async recoverOnce() { return { status: 'recovered_running' }; }
    })
  });
  const result = await controller.recoverReal();
  assert.deepEqual(result, { status: 'recovered_running' });
  assert.equal((await controller.getStatus()).lastRecovery.status, 'recovered_running');
});

test('runtime controller skips automatic recovery when no active execution exists', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real' });
  let created = 0;
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => { created += 1; return { recoverOnce: async () => ({ status: 'recovered_running' }) }; }
  });
  const result = await controller.recoverRealIfNeeded();
  assert.deepEqual(result, { status: 'no_recovery_needed', reason: 'no_active_execution' });
  assert.equal(created, 0);
});

test('runtime controller skips automatic recovery while extension is in mock mode', async () => {
  const store = storage();
  await store.set('settings', { mode: 'mock' });
  await store.set('activeExecution', { task_id: 'task-real-leftover', phase: 'RUNNING' });
  let created = 0;
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => { created += 1; return { recoverOnce: async () => ({ status: 'recovered_running' }) }; }
  });
  const result = await controller.recoverRealIfNeeded();
  assert.deepEqual(result, { status: 'no_recovery_needed', reason: 'mode_not_real' });
  assert.equal(created, 0);
});

test('runtime controller automatically recovers a durable real execution', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real', taskApiBaseUrl: 'https://tasks.example.test' });
  await store.set('activeExecution', { task_id: 'task-1', phase: 'RUNNING' });
  let recoverCalls = 0;
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async settings => {
      assert.equal(settings.mode, 'real');
      return {
        async recoverOnce() {
          recoverCalls += 1;
          return { status: 'recovered_running', task_id: 'task-1' };
        }
      };
    }
  });
  const result = await controller.recoverRealIfNeeded();
  assert.equal(result.status, 'recovered_running');
  assert.equal(recoverCalls, 1);
  assert.equal((await controller.getStatus()).lastRecovery.status, 'recovered_running');
});

test('runtime controller refuses a new real claim while durable active execution still exists', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real' });
  await store.set('activeExecution', { task_id: 'task-active', phase: 'RUNNING' });
  let created = 0;
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => {
      created += 1;
      return { runOnce: async () => ({ status: 'completed' }) };
    }
  });
  await assert.rejects(controller.runReal(), error => {
    assert.equal(error.code, 'ACTIVE_EXECUTION_PRESENT');
    assert.match(error.message, /recovery/i);
    return true;
  });
  assert.equal(created, 0);
});

test('runtime controller status is privacy-safe and does not expose durable prompt or tokens', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real', taskApiBaseUrl: 'https://tasks.example.test', taskApiToken: 'api-secret' });
  await store.set('activeExecution', {
    task_id: 'task-safe',
    project_id: 'vetatool',
    phase: 'RUNNING',
    task_round_count: 2,
    task_patch_count: 1,
    task_snapshot: { task_id: 'task-safe', project_id: 'vetatool', task_prompt: 'private prompt' },
    lease: { token: 'lease-secret', ttl_ms: 60000 },
    in_flight_round: null
  });
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => { throw new Error('not used'); }
  });
  const status = await controller.getStatus();
  const serialized = JSON.stringify(status);
  assert.equal(status.activeExecution.task_id, 'task-safe');
  assert.equal(status.settings.mode, 'real');
  assert.equal(serialized.includes('private prompt'), false);
  assert.equal(serialized.includes('api-secret'), false);
  assert.equal(serialized.includes('lease-secret'), false);
});
