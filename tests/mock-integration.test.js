import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { MockTaskApi } from '../src/background/mock-task-api.js';
import { MockPageDriver } from '../src/background/mock-page-driver.js';
import { TaskRunner } from '../src/background/task-runner.js';
import { TaskStore } from '../src/background/task-store.js';
import { ERROR_CODES } from '../src/shared/errors.js';

function memoryStore() {
  const map = new Map();
  return new TaskStore({
    async get(key) { return map.get(key); },
    async set(key, value) { map.set(key, structuredClone(value)); },
    async remove(key) { map.delete(key); }
  });
}

async function tasks() {
  return JSON.parse(await fs.readFile(new URL('../mock/tasks.json', import.meta.url), 'utf8'));
}

async function runMock(task) {
  const api = new MockTaskApi([task]);
  const result = await new TaskRunner({
    taskApi: api,
    taskStore: memoryStore(),
    page: new MockPageDriver(),
    processPatch: async (candidate, context) => ({
      filename: candidate.filename,
      patch_key: candidate.filename,
      task_id: context.taskId,
      session_id: context.sessionId
    })
  }).runOnce();
  return { result, api };
}

test('mock SEO task continues until three completed Patch artifacts', async () => {
  const task = (await tasks()).find(item => item.task_id === 'mock-seo-min-3');
  const { result } = await runMock(task);
  assert.equal(result.status, 'completed');
  assert.equal(result.state.task_patch_count, 3);
  assert.equal(result.state.task_round_count, 3);
  assert.equal(result.state.task_project.status, 'deleted');
});

test('mock context limit terminates task after preserving completed patches', async () => {
  const task = (await tasks()).find(item => item.task_id === 'mock-context-limit');
  const { result, api } = await runMock(task);
  assert.equal(result.status, 'context_limit');
  assert.equal(result.state.task_patch_count, 1);
  assert.equal(result.state.task_project.status, 'deleted');
  const failed = api.getSnapshot().tasks['mock-context-limit'].events.find(event => event.type === 'FAILED');
  assert.equal(failed.error.code, ERROR_CODES.CHAT_LENGTH_LIMIT);
});

test('mock resource task initializes before its single work round', async () => {
  const task = (await tasks()).find(item => item.task_id === 'mock-resource-init');
  const { result } = await runMock(task);
  assert.equal(result.status, 'completed');
  assert.equal(result.state.task_round_count, 1);
});
