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
