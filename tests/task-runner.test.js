import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRunner } from '../src/background/task-runner.js';
import { MockTaskApi } from '../src/background/mock-task-api.js';
import { TaskStore } from '../src/background/task-store.js';
import { RunnerError, ERROR_CODES } from '../src/shared/errors.js';

function memoryStore() {
  const data = new Map();
  return new TaskStore({
    async get(k) { return data.get(k); },
    async set(k, v) { data.set(k, structuredClone(v)); },
    async remove(k) { data.delete(k); }
  });
}

function scriptedPage(rounds, { createError = null, deleteError = null, order = [] } = {}) {
  let i = 0;
  const calls = [];
  return {
    calls,
    async createTaskProject({ task }) {
      calls.push({ type: 'create', task_id: task.task_id });
      if (createError) throw createError;
      return { projectName: `vetatool2026081315-${task.task_id}`, sessionId: 's1' };
    },
    async runRound() { return structuredClone(rounds[i++]); },
    async deleteTaskProject({ project }) {
      calls.push({ type: 'delete', projectName: project.project_name });
      order.push(`delete:${project.project_name}`);
      if (deleteError) throw deleteError;
      return { ok: true };
    }
  };
}

async function durablePatch(candidate, context) {
  return { filename: candidate.filename, patch_key: candidate.filename, task_id: context.taskId, session_id: context.sessionId };
}

test('normal fix task completes without patch quantity constraint', async () => {
  const api = new MockTaskApi([{ task_id: 't1', project_id: 'vetatool', task_prompt: 'fix' }]);
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename: 'patch-s1-001.patch' }] }]);
  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();
  assert.equal(result.status, 'completed');
  assert.equal(result.state.task_patch_count, 1);
  assert.equal(api.getSnapshot().tasks.t1.status, 'completed');
  assert.equal(result.state.task_project.status, 'deleted');
});

test('multi-round task continues until DONE', async () => {
  const api = new MockTaskApi([{ task_id: 't1', project_id: 'vetatool', task_prompt: 'feature' }]);
  const page = scriptedPage([
    { assistantText: '<TASK_STATUS>CONTINUE</TASK_STATUS>', patches: [{ filename: 'patch-s1-001.patch' }] },
    { assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename: 'patch-s1-002.patch' }] }
  ]);
  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();
  assert.equal(result.state.task_round_count, 2);
  assert.equal(result.state.task_patch_count, 2);
});

test('patch goal keeps task running after early DONE until minimum is met', async () => {
  const api = new MockTaskApi([{ task_id: 't1', project_id: 'vetatool', task_prompt: 'seo', patch_goal: { minimum: 3 } }]);
  const page = scriptedPage([
    { assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename: 'patch-s1-001.patch' }] },
    { assistantText: '<TASK_STATUS>CONTINUE</TASK_STATUS>', patches: [{ filename: 'patch-s1-002.patch' }] },
    { assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename: 'patch-s1-003.patch' }] }
  ]);
  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();
  assert.equal(result.state.task_patch_count, 3);
  assert.equal(result.state.task_round_count, 3);
});

test('every claimed task creates exactly one fresh ChatGPT Project', async () => {
  const api = new MockTaskApi([{ task_id: 't1', project_id: 'vetatool', task_prompt: 'fix' }]);
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] }]);
  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();
  assert.deepEqual(page.calls.filter(call => call.type === 'create').map(call => call.task_id), ['t1']);
  assert.equal(result.state.task_project.project_name, 'vetatool2026081315-t1');
});

test('task project creation failure reports and releases the task', async () => {
  const api = new MockTaskApi([{ task_id: 't1', project_id: 'vetatool', task_prompt: 'fix' }]);
  const page = scriptedPage([], { createError: new RunnerError(ERROR_CODES.PROJECT_CREATE_FAILED, 'create failed') });
  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();
  assert.equal(result.status, 'released');
  assert.equal(api.getSnapshot().tasks.t1.status, 'ready');
});

test('context limit terminates the task without creating another Project', async () => {
  const api = new MockTaskApi([{ task_id: 't1', project_id: 'vetatool', task_prompt: 'feature', patch_goal: { minimum: 30 } }]);
  const page = scriptedPage([
    { assistantText: '<TASK_STATUS>CONTINUE</TASK_STATUS>', patches: [{ filename: 'patch-s1-001.patch' }] },
    { contextLimit: true, assistantText: '', patches: [] }
  ]);
  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();
  assert.equal(result.status, 'context_limit');
  assert.equal(result.state.task_patch_count, 1);
  assert.equal(result.state.task_round_count, 1);
  assert.equal(result.state.task_project.status, 'deleted');
  assert.equal(page.calls.filter(call => call.type === 'create').length, 1);
  assert.equal(page.calls.some(call => call.type === 'migrate'), false);
  const snapshot = api.getSnapshot().tasks.t1;
  assert.equal(snapshot.status, 'failed');
  const failed = snapshot.events.find(event => event.type === 'FAILED');
  assert.equal(failed.error.code, ERROR_CODES.CHAT_LENGTH_LIMIT);
  assert.equal(failed.error.task_patch_count, 1);
  assert.equal(failed.error.patch_goal.minimum, 30);
});

test('finalization keeps task locked until its single Project is deleted', async () => {
  const order = [];
  const api = new MockTaskApi([{ task_id: 't-clean', project_id: 'vetatool', task_prompt: 'fix' }]);
  const originalProgress = api.reportProgress.bind(api);
  api.reportProgress = async (taskId, event) => {
    if (event.type === 'TASK_FINALIZING') order.push('finalizing');
    return originalProgress(taskId, event);
  };
  const originalComplete = api.completeTask.bind(api);
  api.completeTask = async (taskId, result) => {
    order.push('complete');
    return originalComplete(taskId, result);
  };
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] }], { order });
  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();
  assert.equal(result.status, 'completed');
  assert.deepEqual(order, ['finalizing', 'delete:vetatool2026081315-t-clean', 'complete']);
  assert.equal(result.state.phase, 'COMPLETED');
  assert.equal(result.state.task_project.status, 'deleted');
});

test('cleanup failure keeps durable state and does not complete release or fail the locked task', async () => {
  const api = new MockTaskApi([{ task_id: 't-clean-fail', project_id: 'vetatool', task_prompt: 'fix' }]);
  const store = memoryStore();
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] }], {
    deleteError: new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'delete selector not calibrated')
  });
  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch }).runOnce();
  assert.equal(result.status, 'cleanup_pending');
  assert.equal(api.getSnapshot().tasks['t-clean-fail'].status, 'locked');
  const durable = await store.load();
  assert.equal(durable.phase, 'CLEANUP');
  assert.equal(durable.cleanup_error.code, ERROR_CODES.UI_SELECTOR_INCOMPATIBLE);
});
