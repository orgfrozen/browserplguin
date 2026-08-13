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

function scriptedPage(rounds, { createError = null, deleteError = null, initializationResult = null, order = [] } = {}) {
  let i = 0;
  const calls = [];
  return {
    calls,
    async createTaskProject({ task }) {
      calls.push({ type: 'create', task_id: task.task_id });
      if (createError) throw createError;
      return { projectName: `vetatool2026081315-${task.task_id}`, sessionId: 's1' };
    },
    async initializeTask({ task }) {
      calls.push({ type: 'initialize', task_id: task.task_id });
      order.push(`initialize:${task.task_id}`);
      return initializationResult ?? { contextLimit: false, assistantText: 'initialized' };
    },
    async runRound({ prompt }) {
      calls.push({ type: 'round', prompt });
      return structuredClone(rounds[i++]);
    },
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


test('resource task initializes once before the first task prompt without counting an extra work round', async () => {
  const order = [];
  const api = new MockTaskApi([{
    task_id: 't-resource',
    project_id: 'vetatool',
    task_prompt: '修复功能',
    resource: { url: 'https://assets.example.com/source.zip' },
    initialization_prompt: '先分析项目'
  }]);
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] }], { order });
  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();
  assert.equal(result.status, 'completed');
  assert.equal(result.state.task_round_count, 1);
  assert.deepEqual(page.calls.filter(call => call.type === 'initialize').map(call => call.task_id), ['t-resource']);
  assert.deepEqual(page.calls.filter(call => call.type === 'round').map(call => call.prompt), ['修复功能']);
  const initIndex = page.calls.findIndex(call => call.type === 'initialize');
  const roundIndex = page.calls.findIndex(call => call.type === 'round');
  assert.ok(initIndex >= 0 && initIndex < roundIndex);
});

test('context limit during resource initialization terminates before any task work round', async () => {
  const api = new MockTaskApi([{
    task_id: 't-init-limit',
    project_id: 'vetatool',
    task_prompt: '修复功能',
    resource: { url: 'https://assets.example.com/source.zip' }
  }]);
  const page = scriptedPage([], { initializationResult: { contextLimit: true, assistantText: '' } });
  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();
  assert.equal(result.status, 'context_limit');
  assert.equal(result.state.task_round_count, 0);
  assert.equal(result.state.task_project.status, 'deleted');
  assert.equal(page.calls.filter(call => call.type === 'round').length, 0);
});

test('completed Patch is transferred locally before count persistence and artifact reporting', async () => {
  const order = [];
  const api = new MockTaskApi([{ task_id: 't-transfer', project_id: 'vetatool', task_prompt: 'fix' }]);
  const store = memoryStore();
  const originalReportArtifact = api.reportArtifact.bind(api);
  api.reportArtifact = async (taskId, artifact) => {
    order.push('report');
    const durable = await store.load();
    assert.equal(durable.task_patch_count, 1);
    assert.equal(artifact.transfer_mode, 'local');
    assert.deepEqual(artifact.transfer_receipt, {
      download_id: 77,
      filename: 'patch-s1-001.patch',
      local_path: '/Downloads/patch-s1-001.patch',
      source_url: 'blob:patch'
    });
    return originalReportArtifact(taskId, artifact);
  };
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename: 'patch-s1-001.patch' }] }]);
  const processPatch = async (candidate, context) => {
    order.push('download');
    return {
      task_id: context.taskId,
      session_id: context.sessionId,
      download_id: 77,
      filename: candidate.filename,
      local_path: `/Downloads/${candidate.filename}`,
      source_url: 'blob:patch',
      patch_key: candidate.filename
    };
  };
  const artifactTransfer = {
    async transfer(artifact) {
      order.push('transfer');
      return {
        mode: 'local',
        artifact,
        receipt: {
          download_id: artifact.download_id,
          filename: artifact.filename,
          local_path: artifact.local_path,
          source_url: artifact.source_url
        }
      };
    }
  };

  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch, artifactTransfer }).runOnce();
  assert.equal(result.status, 'completed');
  assert.equal(result.state.task_patch_count, 1);
  assert.deepEqual(order.slice(0, 3), ['download', 'transfer', 'report']);
});

test('artifact transfer failure does not count or report the downloaded Patch', async () => {
  const api = new MockTaskApi([{ task_id: 't-transfer-fail', project_id: 'vetatool', task_prompt: 'fix' }]);
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename: 'patch-s1-001.patch' }] }]);
  const artifactTransfer = {
    async transfer() {
      throw new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_FAILED, 'local artifact path is unavailable');
    }
  };

  const result = await new TaskRunner({
    taskApi: api,
    taskStore: memoryStore(),
    page,
    processPatch: durablePatch,
    artifactTransfer
  }).runOnce();

  assert.equal(result.status, 'failed');
  assert.equal(result.state.task_patch_count, 0);
  assert.equal(api.getSnapshot().tasks['t-transfer-fail'].events.some(event => event.type === 'ARTIFACT'), false);
});

function recoveryState(taskId = 'recover-1', phase = 'RUNNING', terminalReason = null) {
  const task = { task_id: taskId, project_id: 'vetatool', task_prompt: 'fix' };
  return {
    task_id: taskId,
    project_id: 'vetatool',
    task_snapshot: task,
    lease: { token: 'lease-old', ttl_ms: 90000 },
    phase,
    session_id: 'session-r1',
    chatgpt_project_name: 'vetatool2026081318-recover-1',
    task_round_count: 3,
    task_patch_count: 2,
    downloaded_patch_keys: ['patch-session-r1-001.patch', 'patch-session-r1-002.patch'],
    task_project: {
      project_name: 'vetatool2026081318-recover-1',
      session_id: 'session-r1',
      status: 'active'
    },
    last_task_status: 'CONTINUE',
    fallback_count: 0,
    terminal_reason: terminalReason,
    cleanup_error: null
  };
}

function recoveryApi(order, { heartbeatError = null, refreshedLease = { token: 'lease-new', ttl_ms: 60000 } } = {}) {
  let lease = null;
  return {
    restoreLease(taskId, persisted) { order.push(`restore:${taskId}`); lease = structuredClone(persisted); return structuredClone(lease); },
    getLease() { return lease ? structuredClone(lease) : null; },
    async heartbeatTask(taskId) {
      order.push(`heartbeat:${taskId}`);
      if (heartbeatError) throw heartbeatError;
      lease = structuredClone(refreshedLease);
      return { lease: structuredClone(lease) };
    },
    async reportProgress(_taskId, event) { order.push(`progress:${event.type}`); },
    async completeTask(taskId) { order.push(`complete:${taskId}`); lease = null; },
    async failTask(taskId) { order.push(`fail:${taskId}`); lease = null; },
    async releaseTask(taskId) { order.push(`release:${taskId}`); lease = null; }
  };
}

test('RUNNING recovery validates persisted lease before opening only the exact recorded Project and never sends a prompt', async () => {
  const order = [];
  const store = memoryStore();
  await store.save(recoveryState());
  const api = recoveryApi(order);
  const page = {
    async prepareExistingTask(task) {
      order.push(`prepare:${task.chatgpt_project_name}:${task.session_id}`);
      assert.equal(task.chatgpt_project_name, 'vetatool2026081318-recover-1');
      assert.equal(task.session_id, 'session-r1');
      return { projectName: task.chatgpt_project_name, sessionId: task.session_id };
    },
    async createTaskProject() { throw new Error('must not create during recovery'); },
    async runRound() { throw new Error('must not replay prompt during safety recovery'); },
    async deleteTaskProject() { throw new Error('must not delete RUNNING project during safety recovery'); }
  };
  const runner = new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch });
  const result = await runner.recoverOnce();
  assert.equal(result.status, 'recovered_running');
  assert.deepEqual(order, [
    'restore:recover-1',
    'heartbeat:recover-1',
    'prepare:vetatool2026081318-recover-1:session-r1',
    'progress:TASK_RECOVERED_RUNNING'
  ]);
  const durable = await store.load();
  assert.deepEqual(durable.lease, { token: 'lease-new', ttl_ms: 60000 });
});

test('recovery blocks before any Project operation when server lease validation fails', async () => {
  const order = [];
  const store = memoryStore();
  await store.save(recoveryState());
  const api = recoveryApi(order, { heartbeatError: new Error('lease expired') });
  const page = {
    async prepareExistingTask() { order.push('prepare'); },
    async deleteTaskProject() { order.push('delete'); }
  };
  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch }).recoverOnce();
  assert.equal(result.status, 'recovery_blocked');
  assert.deepEqual(order, ['restore:recover-1', 'heartbeat:recover-1']);
  assert.match((await store.load()).recovery_error.message, /lease expired/);
});

test('CLEANUP recovery validates lease then deletes only the recorded Project before completing the original terminal action', async () => {
  const order = [];
  const store = memoryStore();
  await store.save(recoveryState('recover-clean', 'CLEANUP', 'SUCCESS'));
  const api = recoveryApi(order);
  const page = {
    async prepareExistingTask() { throw new Error('cleanup recovery must not reopen chat'); },
    async deleteTaskProject({ project }) { order.push(`delete:${project.project_name}`); return { ok: true }; }
  };
  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch }).recoverOnce();
  assert.equal(result.status, 'completed');
  assert.deepEqual(order, [
    'restore:recover-clean',
    'heartbeat:recover-clean',
    'delete:vetatool2026081318-recover-1',
    'progress:TASK_PROJECT_DELETED',
    'complete:recover-clean'
  ]);
  assert.equal(await store.load(), null);
});

test('terminal API failure leaves deleted Project in durable TERMINAL_PENDING with exact payload for idempotent retry', async () => {
  const api = new MockTaskApi([{ task_id: 't-terminal-pending', project_id: 'vetatool', task_prompt: 'fix' }]);
  const originalComplete = api.completeTask.bind(api);
  let attempts = 0;
  api.completeTask = async (taskId, payload) => {
    attempts += 1;
    if (attempts === 1) throw new Error('response lost after server write');
    return originalComplete(taskId, payload);
  };
  const store = memoryStore();
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] }]);
  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch }).runOnce();
  assert.equal(result.status, 'terminal_pending');
  const durable = await store.load();
  assert.equal(durable.phase, 'TERMINAL_PENDING');
  assert.equal(durable.task_project.status, 'deleted');
  assert.equal(durable.terminal_action, 'COMPLETE');
  assert.deepEqual(durable.terminal_payload, {
    task_patch_count: 0,
    task_round_count: 1,
    session_id: 's1',
    project_name: 'vetatool2026081315-t-terminal-pending',
    patch_goal: null,
    terminal_status: 'success'
  });
  assert.match(durable.terminal_error.message, /response lost/);
  assert.equal(api.getSnapshot().tasks['t-terminal-pending'].status, 'locked');
});

test('TERMINAL_PENDING recovery retries the persisted terminal payload without deleting or opening Project again', async () => {
  const order = [];
  const store = memoryStore();
  const state = recoveryState('recover-terminal', 'TERMINAL_PENDING', 'SUCCESS');
  state.task_project.status = 'deleted';
  state.terminal_action = 'COMPLETE';
  state.terminal_payload = {
    task_patch_count: 2,
    task_round_count: 3,
    session_id: 'session-r1',
    project_name: 'vetatool2026081318-recover-1',
    patch_goal: null,
    terminal_status: 'success'
  };
  await store.save(state);
  let receivedPayload = null;
  const api = recoveryApi(order);
  api.completeTask = async (taskId, payload) => {
    order.push(`complete:${taskId}`);
    receivedPayload = structuredClone(payload);
  };
  const page = {
    async prepareExistingTask() { order.push('prepare'); },
    async deleteTaskProject() { order.push('delete'); }
  };
  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch }).recoverOnce();
  assert.equal(result.status, 'completed');
  assert.deepEqual(order, ['restore:recover-terminal', 'heartbeat:recover-terminal', 'complete:recover-terminal']);
  assert.deepEqual(receivedPayload, state.terminal_payload);
  assert.equal(await store.load(), null);
});
