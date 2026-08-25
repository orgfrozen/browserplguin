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
    async initializeTask({ task, hooks = {} }) {
      calls.push({ type: 'initialize', task_id: task.task_id });
      order.push(`initialize:${task.task_id}`);
      await hooks.onResourceDownloaded?.();
      await hooks.onResourceAttached?.();
      return initializationResult ?? { contextLimit: false, assistantText: 'initialized' };
    },
    async runRound({ prompt, hooks = {} }) {
      calls.push({ type: 'round', prompt });
      const round = structuredClone(rounds[i++]);
      await hooks.onPromptSent?.();
      if (!round?.contextLimit) await hooks.onResponseReady?.(round?.assistantText ?? '');
      return round;
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

test('resumeCurrentOnce continues a server-claimed Task without claiming a new Assignment', async () => {
  const api = new MockTaskApi([{ task_id: 'resume-claimed', project_id: 'vetatool', task_prompt: 'fix' }]);
  api.resumeCurrentTask = () => api.claimTask();
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] }]);

  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).resumeCurrentOnce();

  assert.equal(result.status, 'completed');
  assert.deepEqual(page.calls.filter(call => call.type === 'create').map(call => call.task_id), ['resume-claimed']);
});

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
  assert.equal(snapshot.status, 'context_limit');
  const limited = snapshot.events.find(event => event.type === 'CONTEXT_LIMIT');
  assert.equal(limited.result.code, ERROR_CODES.CHAT_LENGTH_LIMIT);
  assert.equal(limited.result.terminal_status, 'context_limit');
  assert.equal(limited.result.task_patch_count, 1);
  assert.equal(limited.result.patch_goal.minimum, 30);
});

test('READY_TO_FINALIZE completes on the server before deleting its single temporary Project', async () => {
  const order = [];
  const api = new MockTaskApi([{ task_id: 't-clean', project_id: 'vetatool', task_prompt: 'fix' }]);
  api.completionCheckTask = async () => { order.push('completion-check'); return { directive: 'READY_TO_FINALIZE', status: 'satisfied', summary: 'Ready' }; };
  const originalProgress = api.reportProgress.bind(api);
  api.reportProgress = async (taskId, event) => {
    if (event.type === 'TASK_FINALIZING') order.push('finalizing');
    return originalProgress(taskId, event);
  };
  const originalComplete = api.completeTask.bind(api);
  api.completeTask = async (taskId, result) => {
    order.push('complete-server');
    return originalComplete(taskId, result);
  };
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] }], { order });
  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();
  assert.equal(result.status, 'completed');
  assert.deepEqual(order, ['completion-check', 'finalizing', 'complete-server', 'delete:vetatool2026081315-t-clean']);
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
  assert.equal(api.getSnapshot().tasks['t-clean-fail'].status, 'completed');
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

test('resource E2E observer sees successful initialization milestones only after durable/report boundaries', async () => {
  const events = [];
  const api = new MockTaskApi([{
    task_id: 't-resource-evidence',
    project_id: 'vetatool',
    task_prompt: 'fix',
    resource: { url: 'https://assets.example.com/source.zip' }
  }]);
  const originalProgress = api.reportProgress.bind(api);
  api.reportProgress = async (taskId, event) => {
    if (event.type === 'TASK_INITIALIZING') events.push('api-initializing');
    if (event.type === 'TASK_INITIALIZED') events.push('api-initialized');
    return originalProgress(taskId, event);
  };
  const baseStore = memoryStore();
  const originalSave = baseStore.save.bind(baseStore);
  baseStore.save = async state => {
    if (state.initialization_completed === true) events.push('durable-initialized');
    return originalSave(state);
  };
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] }], { order: events });
  const observer = {
    onResourceInitializationStarted() { events.push('observe-started'); },
    onResourceDownloaded() { events.push('observe-downloaded'); },
    onResourceAttached() { events.push('observe-attached'); },
    onResourceInitializationResponseReady() { events.push('observe-response-ready'); },
    onResourceInitializationCompleted() { events.push('observe-completed'); }
  };
  const result = await new TaskRunner({ taskApi: api, taskStore: baseStore, page, processPatch: durablePatch, observer }).runOnce();
  assert.equal(result.status, 'completed');
  assert.ok(events.indexOf('observe-started') > events.indexOf('api-initializing'));
  assert.ok(events.indexOf('observe-downloaded') > events.indexOf('observe-started'));
  assert.ok(events.indexOf('observe-attached') > events.indexOf('observe-downloaded'));
  assert.ok(events.indexOf('observe-response-ready') > events.indexOf('observe-attached'));
  assert.ok(events.indexOf('durable-initialized') > events.indexOf('observe-response-ready'));
  assert.ok(events.indexOf('api-initialized') > events.indexOf('durable-initialized'));
  assert.ok(events.indexOf('observe-completed') > events.indexOf('api-initialized'));
});

test('resource evidence observer failures never change Task execution', async () => {
  const api = new MockTaskApi([{
    task_id: 't-resource-observer-fail', project_id: 'vetatool', task_prompt: 'fix',
    resource: { url: 'https://assets.example.com/source.zip' }
  }]);
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] }]);
  const observer = {
    onResourceInitializationStarted() { throw new Error('observer start failed'); },
    onResourceDownloaded() { throw new Error('observer download failed'); },
    onResourceAttached() { throw new Error('observer attach failed'); },
    onResourceInitializationResponseReady() { throw new Error('observer response failed'); },
    onResourceInitializationCompleted() { throw new Error('observer complete failed'); }
  };
  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch, observer }).runOnce();
  assert.equal(result.status, 'completed');
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
  const snapshot = api.getSnapshot().tasks['t-init-limit'];
  assert.equal(snapshot.status, 'context_limit');
  assert.equal(snapshot.events.some(event => event.type === 'CONTEXT_LIMIT'), true);
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
    initialization_completed: true,
    in_flight_round: null,
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
    async completionCheckTask(taskId) { order.push(`completion-check:${taskId}`); return { directive: 'READY_TO_FINALIZE', status: 'satisfied', summary: 'Ready' }; },
    async completeTask(taskId) { order.push(`complete:${taskId}`); lease = null; return { task: { task_id: taskId, status: 'completed' }, acceptance_evaluation: { status: 'satisfied' } }; },
    async failTask(taskId) { order.push(`fail:${taskId}`); lease = null; },
    async contextLimitTask(taskId) { order.push(`context-limit:${taskId}`); lease = null; },
    async releaseTask(taskId) { order.push(`release:${taskId}`); lease = null; }
  };
}

test('RUNNING recovery validates persisted lease before opening only the exact recorded Project and continuing safely', async () => {
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
    async runRound({ hooks }) {
      order.push('round');
      await hooks.onPromptSent();
      await hooks.onResponseReady('<TASK_STATUS>DONE</TASK_STATUS>');
      return { contextLimit: false, assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] };
    },
    async deleteTaskProject({ project }) { order.push(`delete:${project.project_name}`); return { ok: true }; }
  };
  const heartbeat = { start(taskId) { order.push(`heartbeat-start:${taskId}`); }, stop() { order.push('heartbeat-stop'); } };
  const runner = new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch, heartbeat });
  const result = await runner.recoverOnce();
  assert.equal(result.status, 'completed');
  assert.deepEqual(order.slice(0, 5), [
    'restore:recover-1',
    'heartbeat:recover-1',
    'prepare:vetatool2026081318-recover-1:session-r1',
    'heartbeat-start:recover-1',
    'progress:TASK_RECOVERED_RUNNING'
  ]);
  assert.ok(order.indexOf('round') > order.indexOf('progress:TASK_RECOVERED_RUNNING'));
  assert.ok(order.includes('heartbeat-stop'));
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

test('terminal API failure keeps the Project active in durable TERMINAL_PENDING for safe retry', async () => {
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
  assert.equal(durable.task_project.status, 'active');
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

test('RUNNING recovery resumes an in-flight generating round and completes without resending or creating a Project', async () => {
  const order = [];
  const store = memoryStore();
  const state = recoveryState('recover-inflight');
  state.initialization_completed = true;
  state.in_flight_round = { round_number: 4, prompt: 'continue safely', stage: 'PROMPT_SENT', assistant_text: null };
  await store.save(state);
  const api = recoveryApi(order);
  const page = {
    async prepareExistingTask(task) { order.push(`prepare:${task.chatgpt_project_name}`); },
    async createTaskProject() { throw new Error('must not create'); },
    async runRound() { throw new Error('must not resend'); },
    async recoverRound({ checkpoint, hooks }) {
      order.push(`recover-round:${checkpoint.stage}`);
      await hooks.onResponseReady('<TASK_STATUS>DONE</TASK_STATUS>');
      return { contextLimit: false, assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] };
    },
    async deleteTaskProject({ project }) { order.push(`delete:${project.project_name}`); return { ok: true }; }
  };
  const heartbeat = { start(taskId) { order.push(`heartbeat-start:${taskId}`); }, stop() {} };
  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch, heartbeat }).recoverOnce();
  assert.equal(result.status, 'completed');
  assert.ok(order.includes('recover-round:PROMPT_SENT'));
  assert.equal(order.some(item => item === 'create'), false);
  assert.equal(await store.load(), null);
});

test('RUNNING recovery safely starts the next round when previous round is fully committed and no checkpoint is active', async () => {
  const order = [];
  const store = memoryStore();
  const state = recoveryState('recover-between-rounds');
  state.initialization_completed = true;
  state.in_flight_round = null;
  state.last_task_status = 'CONTINUE';
  await store.save(state);
  const api = recoveryApi(order);
  const page = {
    async prepareExistingTask() { order.push('prepare'); },
    async runRound({ prompt, hooks }) {
      order.push(`prompt:${prompt}`);
      await hooks.onPromptSent();
      await hooks.onResponseReady('<TASK_STATUS>DONE</TASK_STATUS>');
      return { contextLimit: false, assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] };
    },
    async recoverRound() { throw new Error('there is no in-flight round'); },
    async deleteTaskProject() { order.push('delete'); return { ok: true }; }
  };
  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch }).recoverOnce();
  assert.equal(result.status, 'completed');
  assert.ok(order.some(item => item.startsWith('prompt:继续当前任务')));
});

test('RUNNING recovery blocks legacy state that has no in-flight checkpoint capability instead of guessing', async () => {
  const order = [];
  const store = memoryStore();
  const state = recoveryState('recover-legacy');
  state.initialization_completed = true;
  delete state.in_flight_round;
  await store.save(state);
  const api = recoveryApi(order);
  const page = {
    async prepareExistingTask() { order.push('prepare'); },
    async runRound() { order.push('round'); },
    async recoverRound() { order.push('recover-round'); }
  };
  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch }).recoverOnce();
  assert.equal(result.status, 'recovery_blocked');
  assert.equal(order.includes('round'), false);
  assert.equal(order.includes('recover-round'), false);
});



test('RUNNING recovery with incomplete initialization restarts a fresh workspace instead of blocking on the abandoned chat', async () => {
  const order = [];
  const store = memoryStore();
  const state = recoveryState('recover-init-restart');
  state.task_snapshot = {
    ...state.task_snapshot,
    resource: { url: 'https://assets.example.com/source.zip' },
    initialization_prompt: 'analyze',
    browser_execution_bootstrap: {
      patchsync: { base_url: 'https://patchsync.example', access_token: 'cap' },
      recovery_policy: { version: 1, rules: [{ id: 'gpt-response-stalled', signal: 'GPT_RESPONSE_STALLED', observation_timeout_seconds: 60, actions: [] }] }
    }
  };
  state.browser_execution_bootstrap = structuredClone(state.task_snapshot.browser_execution_bootstrap);
  state.initialization_completed = false;
  state.initialization_attempt = 0;
  state.initialization_base_project_name = state.task_project.project_name;
  state.source_preparation = {
    status: 'succeeded', export_id: 'exp-recover', patch_session_id: 'session-r1',
    source: { filename: 'source.zip', download_url: '/source.zip' },
    rules: { filename: 'LLM_RULES.md', text: 'rules' }
  };
  await store.save(state);
  const api = recoveryApi(order);
  const page = {
    async prepareExistingTask() { throw new Error('must abandon incomplete initialization instead of reopening it'); },
    async deleteTaskProject({ project }) {
      order.push(`delete:${project.project_name}`);
      if (project.project_name === 'vetatool2026081318-recover-1') throw new RunnerError(ERROR_CODES.PROJECT_NOT_FOUND, 'already gone');
      return { ok: true };
    },
    async createTaskProject({ preferredProjectName, state: current }) {
      order.push(`create:${preferredProjectName}`);
      return { projectName: preferredProjectName, browserWorkspaceId: 'assignment-1', patchSessionId: current.source_preparation.patch_session_id };
    },
    async initializeTask({ resource }) { order.push(`initialize:${resource.filename}`); return { contextLimit: false, assistantText: 'initialized' }; },
    async runRound({ hooks }) {
      order.push('round');
      await hooks.onPromptSent();
      await hooks.onResponseReady('<TASK_STATUS>DONE</TASK_STATUS>');
      return { contextLimit: false, assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] };
    }
  };
  const patchsyncClient = { async downloadSource() { order.push('source:download'); return { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }; } };

  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch, patchSyncClientFactory: () => patchsyncClient }).recoverOnce();

  assert.equal(result.status, 'completed');
  assert.ok(order.includes('delete:vetatool2026081318-recover-1'));
  assert.ok(order.includes('create:vetatool2026081318-recover-1-r1'));
  assert.ok(order.includes('source:download'));
  assert.ok(order.includes('initialize:source.zip'));
  assert.ok(order.includes('round'));
});
test('RUNNING recovery processes a response-ready checkpoint exactly once including Patch persistence', async () => {
  const order = [];
  const store = memoryStore();
  const state = recoveryState('recover-response-ready');
  state.initialization_completed = true;
  state.in_flight_round = {
    round_number: 4,
    prompt: 'continue safely',
    stage: 'RESPONSE_READY',
    assistant_text: '<TASK_STATUS>DONE</TASK_STATUS>'
  };
  await store.save(state);
  const api = recoveryApi(order);
  api.reportArtifact = async (_taskId, artifact) => { order.push(`artifact:${artifact.filename}`); };
  const page = {
    async prepareExistingTask() { order.push('prepare'); },
    async recoverRound({ checkpoint }) {
      assert.equal(checkpoint.stage, 'RESPONSE_READY');
      return {
        contextLimit: false,
        assistantText: checkpoint.assistant_text,
        patches: [{ filename: 'patch-session-r1-003.patch' }]
      };
    },
    async runRound() { throw new Error('must not resend response-ready round'); },
    async deleteTaskProject() { order.push('delete'); return { ok: true }; }
  };
  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch }).recoverOnce();
  assert.equal(result.status, 'completed');
  assert.equal(result.state.task_round_count, 4);
  assert.equal(result.state.task_patch_count, 3);
  assert.ok(order.includes('artifact:patch-session-r1-003.patch'));
});

test('recovery preserves the newest durable checkpoint when page verification blocks after checkpoint advancement', async () => {
  const order = [];
  const store = memoryStore();
  const state = recoveryState('recover-advance-block');
  state.initialization_completed = true;
  state.in_flight_round = { round_number: 4, prompt: 'continue safely', stage: 'READY_TO_SEND', assistant_text: null };
  await store.save(state);
  const api = recoveryApi(order);
  const page = {
    async prepareExistingTask() {},
    async recoverRound({ hooks }) {
      await hooks.onPromptSent();
      throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, 'page became ambiguous after send');
    }
  };
  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch }).recoverOnce();
  assert.equal(result.status, 'recovery_blocked');
  const durable = await store.load();
  assert.equal(durable.in_flight_round.stage, 'PROMPT_SENT');
  assert.match(durable.recovery_error.message, /ambiguous/);
});

test('context limit terminal failure checkpoints CONTEXT_LIMIT action with exact payload', async () => {
  const api = new MockTaskApi([{ task_id: 't-context-pending', project_id: 'vetatool', task_prompt: 'fix' }]);
  api.contextLimitTask = async () => { throw new Error('context-limit response lost'); };
  const store = memoryStore();
  const page = scriptedPage([{ contextLimit: true, assistantText: '', patches: [] }]);
  const first = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch }).runOnce();
  assert.equal(first.status, 'terminal_pending');
  const durable = await store.load();
  assert.equal(durable.phase, 'TERMINAL_PENDING');
  assert.equal(durable.terminal_action, 'CONTEXT_LIMIT');
  assert.equal(durable.terminal_payload.terminal_status, 'context_limit');
  assert.equal(durable.terminal_payload.code, ERROR_CODES.CHAT_LENGTH_LIMIT);
});

test('CONTEXT_LIMIT terminal checkpoint recovery retries the dedicated endpoint without reopening Project', async () => {
  const order = [];
  const store = memoryStore();
  const state = recoveryState('recover-context', 'TERMINAL_PENDING', ERROR_CODES.CHAT_LENGTH_LIMIT);
  state.task_project.status = 'deleted';
  state.terminal_action = 'CONTEXT_LIMIT';
  state.terminal_payload = {
    task_patch_count: 2,
    task_round_count: 3,
    session_id: 'session-r1',
    project_name: 'vetatool2026081318-recover-1',
    patch_goal: null,
    terminal_status: 'context_limit',
    code: ERROR_CODES.CHAT_LENGTH_LIMIT,
    message: 'context exhausted'
  };
  await store.save(state);
  const api = recoveryApi(order);
  const result = await new TaskRunner({ taskApi: api, taskStore: store, page: {
    async prepareExistingTask() { order.push('prepare'); },
    async deleteTaskProject() { order.push('delete'); }
  }, processPatch: durablePatch }).recoverOnce();
  assert.equal(result.status, 'context_limit');
  assert.deepEqual(order, ['restore:recover-context', 'heartbeat:recover-context', 'context-limit:recover-context']);
  assert.equal(await store.load(), null);
});

test('legacy FAIL context-limit terminal checkpoint keeps retrying the original fail endpoint', async () => {
  const order = [];
  const store = memoryStore();
  const state = recoveryState('recover-legacy-context', 'TERMINAL_PENDING', ERROR_CODES.CHAT_LENGTH_LIMIT);
  state.task_project.status = 'deleted';
  state.terminal_action = 'FAIL';
  state.terminal_payload = {
    task_patch_count: 2,
    task_round_count: 3,
    session_id: 'session-r1',
    project_name: 'vetatool2026081318-recover-1',
    patch_goal: null,
    terminal_status: 'context_limit',
    code: ERROR_CODES.CHAT_LENGTH_LIMIT,
    message: 'legacy checkpoint'
  };
  await store.save(state);
  const api = recoveryApi(order);
  const result = await new TaskRunner({ taskApi: api, taskStore: store, page: {
    async prepareExistingTask() { order.push('prepare'); },
    async deleteTaskProject() { order.push('delete'); }
  }, processPatch: durablePatch }).recoverOnce();
  assert.equal(result.status, 'context_limit');
  assert.deepEqual(order, ['restore:recover-legacy-context', 'heartbeat:recover-legacy-context', 'fail:recover-legacy-context']);
  assert.equal(await store.load(), null);
});

test('remote E2E observer sees transfer, successful artifact report, cleanup and COMPLETE terminal', async () => {
  const events = [];
  const api = new MockTaskApi([{ task_id: 't-e2e-observer', project_id: 'vetatool', task_prompt: 'fix' }]);
  const originalReportArtifact = api.reportArtifact.bind(api);
  api.reportArtifact = async (taskId, artifact) => {
    events.push('api-report');
    return originalReportArtifact(taskId, artifact);
  };
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename: 'patch-s1-001.patch' }] }], { order: events });
  const artifactTransfer = {
    async transfer(artifact) {
      return { mode: 'remote', artifact, receipt: { artifact_id: 'a1', filename: artifact.filename, size_bytes: 12 } };
    }
  };
  const observer = {
    onRemoteTransfer() { events.push('observe-transfer'); },
    onArtifactReported() { events.push('observe-report'); },
    onCleanupCompleted() { events.push('observe-cleanup'); },
    onTerminalSucceeded({ action, status }) { events.push(`observe-terminal:${action}:${status}`); }
  };

  const result = await new TaskRunner({
    taskApi: api,
    taskStore: memoryStore(),
    page,
    processPatch: durablePatch,
    artifactTransfer,
    observer
  }).runOnce();

  assert.equal(result.status, 'completed');
  assert.ok(events.indexOf('observe-transfer') >= 0);
  assert.ok(events.indexOf('observe-report') > events.indexOf('api-report'));
  assert.ok(events.indexOf('observe-cleanup') > events.indexOf('delete:vetatool2026081315-t-e2e-observer'));
  assert.ok(events.indexOf('observe-terminal:COMPLETE:completed') > events.indexOf('observe-cleanup'));
});

test('observer failure is isolated and failed artifact report is never observed as reported', async () => {
  const api = new MockTaskApi([{ task_id: 't-e2e-observer-fail', project_id: 'vetatool', task_prompt: 'fix' }]);
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename: 'patch-s1-001.patch' }] }]);
  const artifactTransfer = {
    async transfer(artifact) {
      return { mode: 'remote', artifact, receipt: { artifact_id: 'a1', filename: artifact.filename, size_bytes: 12 } };
    }
  };
  let reportObserved = 0;
  api.reportArtifact = async () => { throw new Error('report failed'); };
  const observer = {
    onRemoteTransfer() { throw new Error('observer transfer failed'); },
    onArtifactReported() { reportObserved += 1; },
    onCleanupCompleted() { throw new Error('observer cleanup failed'); },
    onTerminalSucceeded() { throw new Error('observer terminal failed'); }
  };

  const result = await new TaskRunner({
    taskApi: api,
    taskStore: memoryStore(),
    page,
    processPatch: durablePatch,
    artifactTransfer,
    observer
  }).runOnce();

  assert.equal(result.status, 'failed');
  assert.equal(reportObserved, 0);
});

function patchsyncBootstrapTask(taskId = 't-source-prep') {
  return {
    task_id: taskId,
    project_id: 'vetatool',
    task_prompt: 'fix',
    browser_execution_bootstrap: {
      patchsync: {
        base_url: 'https://patchsync.example',
        access_token: 'v1.payload.signature',
        permissions: ['export:create', 'export:read', 'patch:upload']
      }
    }
  };
}

function preparedManifest(exportId = 'exp-1') {
  return {
    export_id: exportId,
    project_id: 'vetatool',
    status: 'succeeded',
    patch_session_id: 'ps-20260817-abc123',
    source: {
      filename: 'vetatool--ps-20260817-abc123--source.zip',
      download_url: '/exports/vetatool/ps-20260817-abc123/source.zip',
      sha256: 'abc123',
      size_bytes: 1234
    },
    rules: {
      filename: 'LLM_RULES.md',
      download_url: '/exports/vetatool/ps-20260817-abc123/LLM_RULES.md',
      text: 'authoritative patch rules'
    }
  };
}



test('initialization timeout abandons the old workspace and retries in fresh -r1/-r2 Projects without re-exporting source', async () => {
  const task = {
    ...patchsyncBootstrapTask('t-init-restart'),
    agent_control: { agent_id: 'agent-1', assignment_id: 'assignment-1', execution_id: 'execution-1' },
    browser_execution_bootstrap: {
      ...patchsyncBootstrapTask('t-init-restart').browser_execution_bootstrap,
      recovery_policy: {
        version: 1,
        rules: [{ id: 'gpt-response-stalled', signal: 'GPT_RESPONSE_STALLED', observation_timeout_seconds: 60, actions: [] }]
      }
    }
  };
  const api = new MockTaskApi([task]);
  api.completionCheckTask = async () => exactPatchPreview('vetatool--ps-20260817-abc123--001-fix-login.patch', { directive: 'READY_TO_FINALIZE', status: 'success', isTerminal: true, terminalKind: 'success', nextAction: 'next_sequence', successful: 1, pending: 0 });
  const calls = [];
  let initializationAttempts = 0;
  let deleteAttempts = 0;
  const page = {
    async createTaskProject({ state, preferredProjectName = null }) {
      const projectName = preferredProjectName ?? 'vetatool2026082111';
      calls.push(`create:${projectName}:${state.source_preparation.patch_session_id}`);
      return { projectName, browserWorkspaceId: 'assignment-1', patchSessionId: state.source_preparation.patch_session_id };
    },
    async initializeTask({ resource, observationTimeoutMs }) {
      initializationAttempts += 1;
      calls.push(`initialize:${initializationAttempts}:${resource.filename}:${observationTimeoutMs}`);
      if (initializationAttempts < 3) throw new RunnerError(ERROR_CODES.MODEL_RESPONSE_TIMEOUT, 'stalled initialization');
      return { contextLimit: false, assistantText: 'initialized' };
    },
    async deleteTaskProject({ project }) {
      deleteAttempts += 1;
      calls.push(`delete:${project.project_name}`);
      if (deleteAttempts <= 2) throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'old Project delete failed');
      return { ok: true };
    },
    async runRound({ hooks = {} }) {
      await hooks.onPromptSent?.();
      await hooks.onResponseReady?.('<TASK_STATUS>DONE</TASK_STATUS>');
      return { contextLimit: false, assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] };
    }
  };
  let exportCreates = 0;
  let sourceDownloads = 0;
  const patchsyncClient = {
    async createExport() { exportCreates += 1; return { export_id: 'exp-init-restart' }; },
    async waitForExport() { return preparedManifest('exp-init-restart'); },
    async downloadSource() { sourceDownloads += 1; return { filename: 'vetatool--ps-20260817-abc123--source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }; }
  };

  const result = await new TaskRunner({
    taskApi: api,
    taskStore: memoryStore(),
    page,
    processPatch: durablePatch,
    patchSyncClientFactory: () => patchsyncClient
  }).runOnce();

  assert.equal(result.status, 'completed');
  assert.equal(exportCreates, 1);
  assert.equal(sourceDownloads, 1);
  assert.equal(initializationAttempts, 3);
  assert.deepEqual(calls.filter(item => item.startsWith('create:')), [
    'create:vetatool2026082111:ps-20260817-abc123',
    'create:vetatool2026082111-r1:ps-20260817-abc123',
    'create:vetatool2026082111-r2:ps-20260817-abc123'
  ]);
  assert.ok(calls.includes('delete:vetatool2026082111'));
  assert.ok(calls.includes('delete:vetatool2026082111-r1'));
});


test('initialization protocol mismatch is restartable in a fresh workspace before the formal Task prompt is sent', async () => {
  const task = {
    task_id: 't-init-protocol', project_id: 'vetatool', task_prompt: '执行正式 SEO Task',
    resource: { url: 'https://assets.example.com/source.zip' },
    browser_execution_bootstrap: {
      recovery_policy: { version: 1, rules: [{ id: 'gpt-response-stalled', signal: 'GPT_RESPONSE_STALLED', observation_timeout_seconds: 60, actions: [] }] }
    }
  };
  const api = new MockTaskApi([task]);
  const created = [];
  const roundPrompts = [];
  let attempts = 0;
  const page = {
    async createTaskProject({ preferredProjectName = null }) {
      const projectName = preferredProjectName ?? 'vetatool2026082113';
      created.push(projectName);
      return { projectName, sessionId: 's1' };
    },
    async initializeTask() {
      attempts += 1;
      if (attempts === 1) throw new RunnerError(ERROR_CODES.INITIALIZATION_PROTOCOL_MISSING, 'missing init marker');
      return { contextLimit: false, assistantText: '<INIT_STATUS>READY</INIT_STATUS>' };
    },
    async deleteTaskProject() { return { ok: true }; },
    async runRound({ prompt, hooks = {} }) {
      roundPrompts.push(prompt);
      await hooks.onPromptSent?.();
      await hooks.onResponseReady?.('<TASK_STATUS>DONE</TASK_STATUS>');
      return { contextLimit: false, assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] };
    }
  };

  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();

  assert.equal(result.status, 'completed');
  assert.deepEqual(created, ['vetatool2026082113', 'vetatool2026082113-r1']);
  assert.deepEqual(roundPrompts, ['执行正式 SEO Task']);
});



test('initialization recovery uses five replacement workspaces by default and preserves the final failed Project', async () => {
  const task = {
    task_id: 't-init-exhausted', project_id: 'vetatool', task_prompt: 'fix',
    resource: { url: 'https://assets.example.com/source.zip' },
    initialization_prompt: 'analyze',
    browser_execution_bootstrap: {
      recovery_policy: { version: 1, rules: [{ id: 'gpt-response-stalled', signal: 'GPT_RESPONSE_STALLED', observation_timeout_seconds: 60, actions: [] }] }
    }
  };
  const api = new MockTaskApi([task]);
  const created = [];
  const deleted = [];
  const page = {
    async createTaskProject({ preferredProjectName = null }) {
      const projectName = preferredProjectName ?? 'vetatool2026082111';
      created.push(projectName);
      return { projectName, sessionId: 's1' };
    },
    async initializeTask() { throw new RunnerError(ERROR_CODES.COMPOSER_STALLED, 'send stayed disabled'); },
    async reloadPage() { return { id: 7 }; },
    async prepareExistingTask() { return { projectName: created.at(-1) }; },
    async reopenWorkspace() { return { projectName: created.at(-1) }; },
    async deleteTaskProject({ project }) { deleted.push(project.project_name); return { ok: true }; }
  };

  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, ERROR_CODES.INITIALIZATION_RECOVERY_EXHAUSTED);
  assert.deepEqual(created, [
    'vetatool2026082111',
    'vetatool2026082111-r1',
    'vetatool2026082111-r2',
    'vetatool2026082111-r3',
    'vetatool2026082111-r4',
    'vetatool2026082111-r5'
  ]);
  assert.deepEqual(deleted, created.slice(0, -1));
  assert.equal(result.state.task_project.project_name, 'vetatool2026082111-r5');
  assert.equal(result.state.task_project.status, 'active');
  assert.equal(result.state.workspace_retry_count, 5);
  assert.equal(result.state.workspace_max_retries, 5);
});
test('terminal failure is reported before best-effort Project cleanup so cleanup errors do not retain server capacity', async () => {
  const api = new MockTaskApi([{ task_id: 't-fail-before-cleanup', project_id: 'vetatool', task_prompt: 'fix' }]);
  const order = [];
  const originalFail = api.failTask.bind(api);
  api.failTask = async (taskId, payload) => { order.push('fail-server'); return originalFail(taskId, payload); };
  const page = {
    async createTaskProject() { return { projectName: 'vetatool2026082111', sessionId: 's1' }; },
    async runRound() { throw new RunnerError(ERROR_CODES.MODEL_RESPONSE_TIMEOUT, 'round failed'); },
    async deleteTaskProject() { order.push('delete'); throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'delete failed'); }
  };
  const store = memoryStore();

  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch }).runOnce();

  assert.equal(result.status, 'cleanup_pending');
  assert.equal(api.getSnapshot().tasks['t-fail-before-cleanup'].status, 'failed');
  assert.deepEqual(order, ['fail-server', 'delete']);
  const durable = await store.load();
  assert.equal(durable.phase, 'CLEANUP');
  assert.equal(durable.terminal_reported, true);
  assert.equal(durable.cleanup_error.code, ERROR_CODES.UI_SELECTOR_INCOMPATIBLE);
});
test('PatchSync authoritative session bootstraps one workspace, signed source download, and Patch processing', async () => {
  const task = {
    ...patchsyncBootstrapTask('t-authoritative'),
    agent_control: { agent_id: 'agent-1', assignment_id: 'assignment-1', execution_id: 'execution-1' },
    browser_execution_bootstrap: {
      ...patchsyncBootstrapTask('t-authoritative').browser_execution_bootstrap,
      project: { project_id: 'vetatool', name: 'VetaTool', description: '海外工具站', goal: '稳定增长' },
      task: { task_id: 't-authoritative', title: '修复登录', goal: '让登录稳定', instructions: ['保持架构'], acceptance: {} }
    }
  };
  const api = new MockTaskApi([task]);
  api.completionCheckTask = async () => exactPatchPreview('vetatool--ps-20260817-abc123--001-fix-login.patch', { directive: 'READY_TO_FINALIZE', status: 'success', isTerminal: true, terminalKind: 'success', nextAction: 'next_sequence', successful: 1, pending: 0 });
  const calls = [];
  const page = {
    async createTaskProject({ state }) {
      calls.push('project:create');
      assert.equal(state.source_preparation.patch_session_id, 'ps-20260817-abc123');
      return { projectName: 'vetatool2026081719', browserWorkspaceId: 'assignment-1', patchSessionId: 'ps-20260817-abc123' };
    },
    async initializeTask({ resource, task: initializedTask }) {
      calls.push('project:initialize');
      assert.equal(resource.filename, 'vetatool--ps-20260817-abc123--source.zip');
      assert.equal(resource.base64, 'AQID');
      assert.doesNotMatch(initializedTask.initialization_prompt, /seo/i);
      return { contextLimit: false, assistantText: 'initialized' };
    },
    async runRound({ hooks = {} }) {
      await hooks.onPromptSent?.();
      await hooks.onResponseReady?.('<TASK_STATUS>DONE</TASK_STATUS>');
      return { assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename: 'vetatool--ps-20260817-abc123--001-fix-login.patch' }] };
    },
    async deleteTaskProject() { return { ok: true };
    }
  };
  const patchsyncClient = {
    async createExport() { return { export_id: 'exp-1' }; },
    async waitForExport() { const manifest = preparedManifest(); return { ...manifest, rules: { ...manifest.rules, text: null } }; },
    async downloadRules() { calls.push('rules:download'); return { filename: 'LLM_RULES.md', text: '# PATCH_SESSION_ID=ps-20260817-abc123' }; },
    async downloadSource() { calls.push('source:download'); return { filename: 'vetatool--ps-20260817-abc123--source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }; }
  };
  const processed = [];
  const result = await new TaskRunner({
    taskApi: api, taskStore: memoryStore(), page,
    patchSyncClientFactory: () => patchsyncClient,
    processPatch: async (candidate, context) => {
      processed.push(context);
      return { filename: candidate.filename, patch_key: candidate.filename, session_id: context.sessionId };
    }
  }).runOnce();
  assert.equal(result.status, 'completed');
  assert.equal(result.state.browser_workspace_id, 'assignment-1');
  assert.equal(result.state.patch_session_id, 'ps-20260817-abc123');
  assert.equal(result.state.session_id, 'ps-20260817-abc123');
  assert.equal(processed[0].sessionId, 'ps-20260817-abc123');
  assert.ok(calls.indexOf('rules:download') < calls.indexOf('project:create'));
  assert.ok(calls.indexOf('source:download') < calls.indexOf('project:create'));
  assert.ok(calls.indexOf('source:download') < calls.indexOf('project:initialize'));
  assert.equal(calls.filter(x => x === 'project:create').length, 1);
});
test('PatchSync source export completes and is durably checkpointed before ChatGPT Project creation', async () => {
  const order = [];
  const api = new MockTaskApi([patchsyncBootstrapTask()]);
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] }], { order });
  const originalCreate = page.createTaskProject.bind(page);
  page.createTaskProject = async args => { order.push('project:create'); return originalCreate(args); };
  const patchsyncClient = {
    async createExport(projectId) { order.push(`export:create:${projectId}`); return { export_id: 'exp-1' }; },
    async waitForExport(exportId) { order.push(`export:wait:${exportId}`); return preparedManifest(exportId); },
    async downloadSource() { order.push('source:download'); return { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }; }
  };
  const store = memoryStore();
  const runner = new TaskRunner({
    taskApi: api,
    taskStore: store,
    page,
    processPatch: durablePatch,
    patchSyncClientFactory: bootstrap => {
      assert.equal(bootstrap.base_url, 'https://patchsync.example');
      assert.equal(bootstrap.access_token, 'v1.payload.signature');
      return patchsyncClient;
    }
  });
  const result = await runner.runOnce();
  assert.equal(result.status, 'completed');
  assert.ok(order.indexOf('export:create:vetatool') < order.indexOf('project:create'));
  assert.ok(order.indexOf('export:wait:exp-1') < order.indexOf('project:create'));
  assert.equal(result.state.source_preparation.export_id, 'exp-1');
  assert.equal(result.state.source_preparation.patch_session_id, 'ps-20260817-abc123');
  assert.equal(result.state.source_preparation.source.sha256, 'abc123');
  assert.equal(result.state.source_preparation.rules.text, 'authoritative patch rules');
});

test('PatchSync host permission wait keeps the claimed Task and durable source preparation for same-execution recovery', async () => {
  const task = patchsyncBootstrapTask('t-source-permission');
  const api = new MockTaskApi([task]);
  const page = scriptedPage([]);
  const store = memoryStore();
  const runner = new TaskRunner({
    taskApi: api,
    taskStore: store,
    page,
    processPatch: durablePatch,
    patchSyncClientFactory: () => ({
      async createExport() { return { export_id: 'exp-permission' }; },
      async waitForExport() {
        throw new RunnerError(ERROR_CODES.RESOURCE_HOST_PERMISSION_REQUIRED, 'Task resource host permission is required', {
          reason: 'not_granted',
          originPattern: 'https://patchsync.example/*'
        });
      }
    })
  });

  const result = await runner.runOnce();
  assert.equal(result.status, 'waiting_human');
  assert.equal(result.state.phase, 'PREPARING_SOURCE');
  assert.equal(result.state.source_preparation.export_id, 'exp-permission');
  assert.equal(page.calls.some(call => call.type === 'create'), false);

  const snapshot = api.getSnapshot().tasks['t-source-permission'];
  assert.equal(snapshot.status, 'locked');
  assert.equal(snapshot.events.some(event => event.type === 'RELEASED'), false);
  const waiting = snapshot.events.find(event => event.type === 'WAITING_HUMAN');
  assert.equal(waiting.result.reason, ERROR_CODES.RESOURCE_HOST_PERMISSION_REQUIRED);
  assert.equal(waiting.result.origin_pattern, 'https://patchsync.example/*');

  const durable = await store.load();
  assert.equal(durable.phase, 'PREPARING_SOURCE');
  assert.equal(durable.source_preparation.export_id, 'exp-permission');
  assert.equal(durable.recovery_error.code, ERROR_CODES.RESOURCE_HOST_PERMISSION_REQUIRED);
});


test('transient PatchSync source preparation failure keeps the same claimed execution and schedules recovery', async () => {
  const task = patchsyncBootstrapTask('t-source-transient');
  const api = new MockTaskApi([task]);
  const page = scriptedPage([]);
  const store = memoryStore();
  const now = new Date('2026-08-23T12:00:00.000Z');
  const runner = new TaskRunner({
    taskApi: api,
    taskStore: store,
    page,
    processPatch: durablePatch,
    now: () => now,
    patchSyncClientFactory: () => ({
      async createExport() { return { export_id: 'exp-transient' }; },
      async waitForExport() {
        throw new RunnerError(ERROR_CODES.RESOURCE_DOWNLOAD_FAILED, 'PatchSync request failed', { cause: 'Failed to fetch' });
      }
    })
  });

  const result = await runner.runOnce();
  assert.equal(result.status, 'source_retry_pending');
  assert.equal(result.state.phase, 'PREPARING_SOURCE');
  assert.equal(result.state.source_preparation.export_id, 'exp-transient');
  assert.equal(result.state.source_retry.attempts, 1);
  assert.equal(result.state.next_recovery_at, '2026-08-23T12:00:05.000Z');
  assert.equal(page.calls.some(call => call.type === 'create'), false);
  const snapshot = api.getSnapshot().tasks['t-source-transient'];
  assert.equal(snapshot.status, 'locked');
  assert.equal(snapshot.events.some(event => event.type === 'RELEASED'), false);
  assert.ok(snapshot.events.some(event => event.type === 'SOURCE_PREPARE_RETRY_SCHEDULED'));
});

test('PREPARING_SOURCE retry reuses the persisted export and clears retry state after network recovery', async () => {
  const order = [];
  const task = patchsyncBootstrapTask('t-source-transient-recover');
  const api = recoveryApi(order);
  const store = memoryStore();
  await store.save({
    task_id: task.task_id,
    project_id: task.project_id,
    task_snapshot: task,
    lease: { token: 'lease-old', ttl_ms: 90000 },
    phase: 'PREPARING_SOURCE',
    source_preparation: { status: 'waiting', export_id: 'exp-existing' },
    source_retry: {
      attempts: 2,
      next_retry_at: '2026-08-23T12:00:10.000Z',
      last_error: { code: ERROR_CODES.RESOURCE_DOWNLOAD_FAILED, message: 'PatchSync request failed' }
    },
    next_recovery_at: '2026-08-23T12:00:10.000Z',
    task_round_count: 0,
    task_patch_count: 0,
    downloaded_patch_keys: [],
    initialization_completed: true,
    in_flight_round: null,
    fallback_count: 0,
    task_project: null
  });
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] }], { order });
  const patchsyncClient = {
    async createExport() { order.push('export:create:unexpected'); return { export_id: 'exp-new' }; },
    async waitForExport(exportId) { order.push(`export:wait:${exportId}`); return preparedManifest(exportId); },
    async downloadSource() { order.push('source:download'); return { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }; }
  };
  const runner = new TaskRunner({
    taskApi: api,
    taskStore: store,
    page,
    processPatch: durablePatch,
    patchSyncClientFactory: () => patchsyncClient
  });

  const result = await runner.recoverOnce();
  assert.equal(result.status, 'completed');
  assert.equal(order.includes('export:create:unexpected'), false);
  assert.ok(order.includes('export:wait:exp-existing'));
  assert.equal(result.state.source_retry, null);
  assert.equal(result.state.next_recovery_at, null);
});

test('transient prepared source download failure also stays on the same execution instead of releasing it', async () => {
  const task = patchsyncBootstrapTask('t-source-download-transient');
  const api = new MockTaskApi([task]);
  const page = scriptedPage([]);
  const store = memoryStore();
  const now = new Date('2026-08-23T12:00:00.000Z');
  const runner = new TaskRunner({
    taskApi: api,
    taskStore: store,
    page,
    processPatch: durablePatch,
    now: () => now,
    patchSyncClientFactory: () => ({
      async createExport() { return { export_id: 'exp-download' }; },
      async waitForExport(exportId) { return preparedManifest(exportId); },
      async downloadSource() {
        throw new RunnerError(ERROR_CODES.RESOURCE_DOWNLOAD_FAILED, 'PatchSync source body could not be read', { cause: 'network changed' });
      }
    })
  });

  const result = await runner.runOnce();
  assert.equal(result.status, 'source_retry_pending');
  assert.equal(result.state.phase, 'PREPARING_SOURCE');
  assert.equal(result.state.source_retry.attempts, 1);
  assert.equal(api.getSnapshot().tasks['t-source-download-transient'].events.some(event => event.type === 'RELEASED'), false);
  assert.equal(page.calls.some(call => call.type === 'create'), false);
});

test('PatchSync export failure releases Task before any ChatGPT Project is created', async () => {
  const api = new MockTaskApi([patchsyncBootstrapTask('t-export-fail')]);
  const page = scriptedPage([]);
  const store = memoryStore();
  const runner = new TaskRunner({
    taskApi: api,
    taskStore: store,
    page,
    processPatch: durablePatch,
    patchSyncClientFactory: () => ({
      async createExport() { return { export_id: 'exp-fail' }; },
      async waitForExport() { throw new Error('make export failed'); }
    })
  });
  const result = await runner.runOnce();
  assert.equal(result.status, 'released');
  assert.equal(page.calls.some(call => call.type === 'create'), false);
  assert.equal(api.getSnapshot().tasks['t-export-fail'].status, 'ready');
});

test('PREPARING_SOURCE recovery reuses persisted export_id and does not create a second Patch Session', async () => {
  const order = [];
  const task = patchsyncBootstrapTask('t-source-recover');
  const api = recoveryApi(order);
  const store = memoryStore();
  await store.save({
    task_id: task.task_id,
    project_id: task.project_id,
    task_snapshot: task,
    lease: { token: 'lease-old', ttl_ms: 90000 },
    phase: 'PREPARING_SOURCE',
    source_preparation: { status: 'waiting', export_id: 'exp-existing' },
    task_round_count: 0,
    task_patch_count: 0,
    downloaded_patch_keys: [],
    initialization_completed: true,
    in_flight_round: null,
    fallback_count: 0,
    task_project: null
  });
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] }], { order });
  const patchsyncClient = {
    async createExport() { order.push('export:create:unexpected'); return { export_id: 'exp-new' }; },
    async waitForExport(exportId) { order.push(`export:wait:${exportId}`); return preparedManifest(exportId); },
    async downloadSource() { order.push('source:download'); return { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }; }
  };
  const runner = new TaskRunner({
    taskApi: api,
    taskStore: store,
    page,
    processPatch: durablePatch,
    patchSyncClientFactory: () => patchsyncClient
  });
  const result = await runner.recoverOnce();
  assert.equal(result.status, 'completed');
  assert.equal(order.includes('export:create:unexpected'), false);
  assert.ok(order.includes('export:wait:exp-existing'));
  assert.equal(result.state.source_preparation.export_id, 'exp-existing');
  assert.equal(page.calls.filter(call => call.type === 'create').length, 1);
});

test('server CONTINUE after model DONE reuses the same Project and sends the server continuation summary', async () => {
  const api = new MockTaskApi([{ task_id: 't-server-continue', project_id: 'vetatool', task_prompt: 'fix' }]);
  const directives = [
    { directive: 'CONTINUE', status: 'unmet', summary: '还需要完成登录回归测试', unmet_criteria: ['require_analysis'] },
    { directive: 'READY_TO_FINALIZE', status: 'satisfied', summary: 'Ready to finalize', unmet_criteria: [] }
  ];
  api.completionCheckTask = async () => directives.shift();
  const page = scriptedPage([
    { assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] },
    { assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] }
  ]);

  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();

  assert.equal(result.status, 'completed');
  assert.equal(page.calls.filter(call => call.type === 'create').length, 1);
  const prompts = page.calls.filter(call => call.type === 'round').map(call => call.prompt);
  assert.equal(prompts[0], 'fix');
  assert.match(prompts[1], /还需要完成登录回归测试/);
});

test('server WAIT_EXTERNAL after model DONE keeps the Assignment execution and Project alive without another prompt', async () => {
  const api = new MockTaskApi([{ task_id: 't-wait-external', project_id: 'vetatool', task_prompt: 'fix' }]);
  api.completionCheckTask = async () => ({
    directive: 'WAIT_EXTERNAL', status: 'waiting_external', summary: 'Waiting for PatchSync verification', unmet_criteria: ['require_ci_success']
  });
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] }]);
  const store = memoryStore();

  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch }).runOnce();

  assert.equal(result.status, 'waiting_external');
  assert.equal(result.state.phase, 'WAITING_EXTERNAL');
  assert.equal(result.state.task_project.status, 'active');
  assert.equal(page.calls.filter(call => call.type === 'round').length, 1);
  assert.equal(page.calls.some(call => call.type === 'delete'), false);
  assert.equal(api.getSnapshot().tasks['t-wait-external'].status, 'locked');
  assert.equal((await store.load()).phase, 'WAITING_EXTERNAL');
});

test('server WAIT_HUMAN after model DONE keeps the Project for manual continuation', async () => {
  const api = new MockTaskApi([{ task_id: 't-wait-human', project_id: 'vetatool', task_prompt: 'fix' }]);
  api.completionCheckTask = async () => ({ directive: 'WAIT_HUMAN', status: 'waiting_human', summary: 'Manual approval required' });
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] }]);
  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();
  assert.equal(result.status, 'waiting_human');
  assert.equal(result.state.phase, 'WAITING_HUMAN');
  assert.equal(result.state.task_project.status, 'active');
  assert.equal(page.calls.some(call => call.type === 'delete'), false);
});

test('PatchSync-submitted Patch receipt is durably counted and reported as the artifact evidence source', async () => {
  const task = patchsyncBootstrapTask('t-patch-submit');
  const api = new MockTaskApi([task]);
  api.completionCheckTask = async () => exactPatchPreview('vetatool--ps-20260817-abc123--001-submit.patch', { directive: 'READY_TO_FINALIZE', status: 'success', isTerminal: true, terminalKind: 'success', nextAction: 'next_sequence', successful: 1, pending: 0 });
  const reported = [];
  const originalReport = api.reportArtifact.bind(api);
  api.reportArtifact = async (taskId, artifact) => { reported.push(structuredClone(artifact)); return originalReport(taskId, artifact); };
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename: 'vetatool--ps-20260817-abc123--001-submit.patch' }] }]);
  const patchsyncClient = {
    async createExport() { return { export_id: 'exp-1' }; },
    async waitForExport() { return preparedManifest(); },
    async downloadSource() { return { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }; }
  };
  const artifactTransfer = {
    async transfer(artifact, context) {
      assert.equal(context.patchSyncClient, patchsyncClient);
      assert.equal(context.projectId, 'vetatool');
      assert.equal(context.patchSessionId, 'ps-20260817-abc123');
      return {
        mode: 'patchsync', artifact,
        receipt: {
          accepted: true, duplicate: false, project_id: 'vetatool', session_id: 'ps-20260817-abc123',
          sequence: 1, parent_sequence: 0, filename: artifact.filename, sha256: 'b'.repeat(64), state: 'queued'
        }
      };
    }
  };
  const result = await new TaskRunner({
    taskApi: api, taskStore: memoryStore(), page, artifactTransfer,
    patchSyncClientFactory: () => patchsyncClient,
    processPatch: async (candidate, context) => ({
      task_id: context.taskId, session_id: context.sessionId, filename: candidate.filename,
      patch_key: 'vetatool--ps-20260817-abc123--001', local_path: '/tmp/001.patch', download_id: 1
    })
  }).runOnce();

  assert.equal(result.status, 'completed');
  assert.equal(result.state.task_patch_count, 1);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].transfer_mode, 'patchsync');
  assert.equal(reported[0].transfer_receipt.state, 'queued');
  assert.equal(reported[0].transfer_receipt.sequence, 1);
});

test('TaskRunner applies frozen server GPT recovery policy and keeps one Project across reload/reopen recovery', async () => {
  const calls = [];
  const task = {
    task_id: 't-recovery-policy', project_id: 'vetatool', task_prompt: 'fix',
    browser_execution_bootstrap: {
      recovery_policy: {
        version: 1,
        rules: [{
          id: 'gpt-response-stalled', signal: 'GPT_RESPONSE_STALLED', observation_timeout_seconds: 30,
          actions: [
            { type: 'HEALTH_CHECK' },
            { type: 'RELOAD_PAGE', max_attempts: 2, observation_timeout_seconds: 30 },
            { type: 'REOPEN_WORKSPACE', max_attempts: 1, observation_timeout_seconds: 30 },
            { type: 'ESCALATE' }
          ]
        }]
      }
    }
  };
  const api = new MockTaskApi([task]);
  let waits = 0;
  const page = {
    async createTaskProject() { calls.push('create'); return { projectName: 'p1', browserWorkspaceId: 'w1', patchSessionId: 's1' }; },
    async runRound({ hooks, observationTimeoutMs }) {
      calls.push(`run:${observationTimeoutMs}`);
      await hooks.onPromptSent?.();
      throw new RunnerError(ERROR_CODES.MODEL_RESPONSE_TIMEOUT, 'stalled');
    },
    async recoverRound({ hooks, observationTimeoutMs }) {
      calls.push(`recover:${observationTimeoutMs}`);
      waits += 1;
      if (waits < 3) throw new RunnerError(ERROR_CODES.MODEL_RESPONSE_TIMEOUT, 'stalled');
      await hooks.onMeaningfulProgress?.('response_ready');
      await hooks.onResponseReady?.('<TASK_STATUS>DONE</TASK_STATUS>');
      return { assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] };
    },
    async healthCheck() { calls.push('health'); return { state: 'GENERATING' }; },
    async reloadPage() { calls.push('reload'); },
    async reopenWorkspace() { calls.push('reopen'); },
    async deleteTaskProject() { calls.push('delete'); return { ok: true }; }
  };
  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, [
    'create', 'run:30000', 'health', 'reload', 'recover:30000', 'reload', 'recover:30000', 'reopen', 'recover:30000', 'delete'
  ]);
  assert.equal(result.state.recovery_state, null);
  assert.equal(calls.filter(call => call === 'create').length, 1);
});

function controlledRecoveryTask(taskId, phase, recoveryPolicy) {
  const task = {
    task_id: taskId,
    project_id: 'vetatool',
    task_prompt: 'fix',
    agent_control: { agent_id: 'agent-1', assignment_id: 'a1', execution_id: 'e1' },
    browser_execution_bootstrap: { recovery_policy: recoveryPolicy }
  };
  return {
    ...recoveryState(taskId, phase),
    task_snapshot: task,
    agent_id: 'agent-1', assignment_id: 'a1', execution_id: 'e1',
    lease: { token: 'lease-old', ttl_ms: 900000, assignment_id: 'a1', execution_id: 'e1', agent_id: 'agent-1' },
    browser_execution_bootstrap: structuredClone(task.browser_execution_bootstrap),
    browser_workspace_id: 'a1', patch_session_id: 'ps-1', session_id: 'ps-1',
    task_project: { project_name: 'owned-project', browser_workspace_id: 'a1', status: 'active' }
  };
}

const externalPolicy = {
  version: 1,
  rules: [{
    id: 'wait-external-stalled', signal: 'WAIT_EXTERNAL_STALLED', poll_interval_seconds: 120, stall_timeout_seconds: 1800,
    actions: [{ type: 'RESYNC_EXTERNAL_STATE' }, { type: 'ESCALATE' }]
  }]
};

test('WAIT_EXTERNAL polls at most every ten seconds even when the control-plane recovery policy is slower', async () => {
  const order = [];
  const store = memoryStore();
  const state = controlledRecoveryTask('wait-1', 'WAITING_EXTERNAL', externalPolicy);
  state.external_wait = {
    started_at: '2026-08-17T10:00:00.000Z', last_checked_at: null, next_check_at: '2026-08-17T10:02:00.000Z',
    summary: 'CI pending', resync_count: 0, last_resync_at: null, escalated_at: null
  };
  await store.save(state);
  const api = recoveryApi(order, { refreshedLease: { token: 'lease-new', ttl_ms: 900000, assignment_id: 'a1', execution_id: 'e1', agent_id: 'agent-1' } });
  api.completionCheckTask = async taskId => { order.push(`completion-check:${taskId}`); return { directive: 'WAIT_EXTERNAL', summary: 'CI still pending' }; };
  api.waitingExternalTask = async (_taskId, payload) => { order.push(`waiting-external:${payload.reason}`); };
  const page = {
    async prepareExistingTask() { order.push('prepare'); },
    async runRound() { order.push('round'); },
    async reloadPage() { order.push('reload'); },
    async reopenWorkspace() { order.push('reopen'); },
    async deleteTaskProject() { order.push('delete'); }
  };
  const runner = new TaskRunner({
    taskApi: api, taskStore: store, page, processPatch: durablePatch,
    now: () => new Date('2026-08-17T10:02:00.000Z')
  });
  const result = await runner.recoverOnce();
  assert.equal(result.status, 'waiting_external');
  assert.equal(result.state.phase, 'WAITING_EXTERNAL');
  assert.equal(result.state.external_wait.last_checked_at, '2026-08-17T10:02:00.000Z');
  assert.equal(result.state.external_wait.next_check_at, '2026-08-17T10:02:10.000Z');
  assert.equal(result.state.external_wait.query_count, 1);
  assert.equal(result.state.external_wait.last_query_at, '2026-08-17T10:02:00.000Z');
  assert.equal(result.state.external_wait.last_result, 'completion:WAIT_EXTERNAL');
  assert.equal(result.state.external_wait.last_completion_check_at, '2026-08-17T10:02:00.000Z');
  assert.equal(result.state.next_recovery_at, '2026-08-17T10:02:10.000Z');
  assert.ok(order.includes('completion-check:wait-1'));
  assert.equal(order.some(item => ['prepare', 'round', 'reload', 'reopen', 'delete'].includes(item)), false);
});

test('WAIT_EXTERNAL rescans the existing ChatGPT response and captures a late Patch before finalization', async () => {
  const order = [];
  const store = memoryStore();
  const state = controlledRecoveryTask('wait-late-patch', 'WAITING_EXTERNAL', externalPolicy);
  state.task_round_count = 1;
  state.task_patch_count = 0;
  state.downloaded_patch_keys = [];
  state.last_task_status = 'DONE';
  state.external_wait = {
    started_at: '2026-08-17T10:00:00.000Z', last_checked_at: null, next_check_at: '2026-08-17T10:02:00.000Z',
    summary: 'Waiting for external completion', resync_count: 0, last_resync_at: null, escalated_at: null
  };
  await store.save(state);

  let artifactReported = false;
  const api = recoveryApi(order, { refreshedLease: { token: 'lease-new', ttl_ms: 900000, assignment_id: 'a1', execution_id: 'e1', agent_id: 'agent-1' } });
  api.reportArtifact = async (_taskId, artifact) => { artifactReported = true; order.push(`artifact:${artifact.filename}`); };
  api.completionCheckTask = async taskId => { order.push(`completion-check:${taskId}`); return { directive: 'READY_TO_FINALIZE', status: 'satisfied', summary: 'Ready' }; };
  api.completeTask = async taskId => {
    order.push(`complete:${taskId}:${artifactReported ? 'with-patch' : 'without-patch'}`);
    return artifactReported
      ? { task: { task_id: taskId, status: 'completed' }, acceptance_evaluation: { status: 'satisfied' } }
      : { task: { task_id: taskId, status: 'waiting_external' }, acceptance_evaluation: { status: 'waiting_external', summary: 'Patch artifact is missing' } };
  };

  const page = {
    async prepareExistingTask(task) { order.push(`prepare:${task.chatgpt_project_name}`); },
    async discoverPatches() {
      order.push('discover-late-patch');
      return [{ filename: 'browserplguin--ps-1--001-late.patch', url: 'blob:late', clickToken: 'late-1', tabId: 7 }];
    },
    async deleteTaskProject({ project }) { order.push(`delete:${project.project_name}`); return { ok: true }; }
  };

  const result = await new TaskRunner({
    taskApi: api, taskStore: store, page, processPatch: durablePatch,
    now: () => new Date('2026-08-17T10:02:00.000Z')
  }).recoverOnce();

  assert.equal(result.status, 'completed');
  assert.equal(result.state.task_patch_count, 1);
  assert.ok(order.indexOf('discover-late-patch') < order.indexOf('completion-check:wait-late-patch'));
  assert.ok(order.includes('artifact:browserplguin--ps-1--001-late.patch'));
  assert.ok(order.includes('complete:wait-late-patch:with-patch'));
});

test('READY_TO_FINALIZE reconciles a missing late Patch even when durable model DONE status was lost', async () => {
  const order = [];
  const store = memoryStore();
  const state = controlledRecoveryTask('wait-ready-late-patch', 'WAITING_EXTERNAL', externalPolicy);
  state.task_round_count = 1;
  state.task_patch_count = 0;
  state.downloaded_patch_keys = [];
  state.last_task_status = null;
  state.external_wait = {
    started_at: '2026-08-17T10:00:00.000Z', last_checked_at: null, next_check_at: '2026-08-17T10:02:00.000Z',
    summary: 'Waiting for external completion', resync_count: 0, last_resync_at: null, escalated_at: null
  };
  await store.save(state);

  let artifactReported = false;
  const api = recoveryApi(order, { refreshedLease: { token: 'lease-new', ttl_ms: 900000, assignment_id: 'a1', execution_id: 'e1', agent_id: 'agent-1' } });
  api.reportArtifact = async (_taskId, artifact) => { artifactReported = true; order.push(`artifact:${artifact.filename}`); };
  api.completionCheckTask = async taskId => { order.push(`completion-check:${taskId}`); return { directive: 'READY_TO_FINALIZE', status: 'satisfied', summary: 'Ready' }; };
  api.completeTask = async taskId => {
    order.push(`complete:${taskId}:${artifactReported ? 'with-patch' : 'without-patch'}`);
    return artifactReported
      ? { task: { task_id: taskId, status: 'completed' }, acceptance_evaluation: { status: 'satisfied' } }
      : { task: { task_id: taskId, status: 'waiting_external' }, acceptance_evaluation: { status: 'waiting_external', summary: 'Patch artifact is missing' } };
  };

  const page = {
    async prepareExistingTask(task) { order.push(`prepare:${task.chatgpt_project_name}`); },
    async discoverPatches() {
      order.push('discover-ready-late-patch');
      return [{ filename: 'browserplguin--ps-1--001-ready-late.patch', url: 'blob:late', clickToken: 'late-ready-1', tabId: 7 }];
    },
    async deleteTaskProject({ project }) { order.push(`delete:${project.project_name}`); return { ok: true }; }
  };

  const result = await new TaskRunner({
    taskApi: api, taskStore: store, page, processPatch: durablePatch,
    now: () => new Date('2026-08-17T10:02:00.000Z')
  }).recoverOnce();

  assert.equal(result.status, 'completed');
  assert.equal(result.state.task_patch_count, 1);
  assert.ok(order.indexOf('completion-check:wait-ready-late-patch') < order.indexOf('discover-ready-late-patch'));
  assert.ok(order.indexOf('discover-ready-late-patch') < order.indexOf('complete:wait-ready-late-patch:with-patch'));
  assert.equal(order.includes('complete:wait-ready-late-patch:without-patch'), false);
  assert.ok(order.includes('artifact:browserplguin--ps-1--001-ready-late.patch'));
});

test('WAIT_EXTERNAL with an exact Patch target polls terminal status every five seconds', async () => {
  const order = [];
  const store = memoryStore();
  const state = controlledRecoveryTask('wait-exact-fast-poll', 'WAITING_EXTERNAL', externalPolicy);
  const filename = 'vetatool--ps-fast--001-fast.patch';
  state.patch_session_id = 'ps-fast';
  state.session_id = 'ps-fast';
  state.patch_status_target = { filename, session_id: 'ps-fast', sequence: 1 };
  state.external_wait = {
    started_at: '2026-08-17T10:00:00.000Z', last_checked_at: null, next_check_at: '2026-08-17T10:02:00.000Z',
    query_count: 0, last_query_at: null, last_result: null, last_patch_reconcile_at: null, last_completion_check_at: null,
    summary: 'waiting for exact Patch', resync_count: 0, last_resync_at: null, escalated_at: null
  };
  await store.save(state);
  const api = recoveryApi(order, { refreshedLease: { token: 'lease-new', ttl_ms: 900000, assignment_id: 'a1', execution_id: 'e1', agent_id: 'agent-1' } });
  api.completionCheckTask = async taskId => {
    order.push(`completion-check:${taskId}`);
    return exactPatchPreview(filename, {
      directive: 'WAIT_EXTERNAL', status: 'local_testing', isTerminal: false, terminalKind: null, nextAction: 'wait'
    });
  };

  const result = await new TaskRunner({
    taskApi: api, taskStore: store, page: {}, processPatch: durablePatch,
    now: () => new Date('2026-08-17T10:02:00.000Z')
  }).recoverOnce();

  assert.equal(result.status, 'waiting_external');
  assert.equal(result.state.external_wait.next_check_at, '2026-08-17T10:02:05.000Z');
  assert.equal(result.state.next_recovery_at, '2026-08-17T10:02:05.000Z');
  assert.equal(result.state.external_wait.last_result, 'completion:WAIT_EXTERNAL:local_testing');
  assert.ok(order.includes('completion-check:wait-exact-fast-poll'));
});

test('transient exact Patch status errors back off from ten to sixty seconds and reset after a successful query', async () => {
  const order = [];
  const store = memoryStore();
  const state = controlledRecoveryTask('wait-exact-backoff', 'WAITING_EXTERNAL', externalPolicy);
  const filename = 'vetatool--ps-backoff--001-backoff.patch';
  state.patch_session_id = 'ps-backoff';
  state.session_id = 'ps-backoff';
  state.patch_status_target = { filename, session_id: 'ps-backoff', sequence: 1 };
  state.external_wait = {
    started_at: '2026-08-17T10:00:00.000Z', last_checked_at: null, next_check_at: '2026-08-17T10:02:00.000Z',
    query_count: 0, consecutive_query_errors: 0, last_query_at: null, last_result: null, last_patch_reconcile_at: null, last_completion_check_at: null,
    summary: 'waiting for exact Patch', resync_count: 0, last_resync_at: null, escalated_at: null
  };
  await store.save(state);
  const api = recoveryApi(order, { refreshedLease: { token: 'lease-new', ttl_ms: 900000, assignment_id: 'a1', execution_id: 'e1', agent_id: 'agent-1' } });
  let fail = true;
  api.completionCheckTask = async () => {
    if (fail) throw new TypeError('Failed to fetch');
    return exactPatchPreview(filename, {
      directive: 'WAIT_EXTERNAL', status: 'local_testing', isTerminal: false, terminalKind: null, nextAction: 'wait'
    });
  };
  let now = '2026-08-17T10:02:00.000Z';
  const run = () => new TaskRunner({
    taskApi: api, taskStore: store, page: {}, processPatch: durablePatch,
    now: () => new Date(now)
  }).recoverOnce();

  let result = await run();
  assert.equal(result.state.external_wait.consecutive_query_errors, 1);
  assert.equal(result.state.external_wait.next_check_at, '2026-08-17T10:02:10.000Z');

  now = '2026-08-17T10:02:10.000Z';
  result = await run();
  assert.equal(result.state.external_wait.consecutive_query_errors, 2);
  assert.equal(result.state.external_wait.next_check_at, '2026-08-17T10:02:30.000Z');

  now = '2026-08-17T10:02:30.000Z';
  result = await run();
  assert.equal(result.state.external_wait.consecutive_query_errors, 3);
  assert.equal(result.state.external_wait.next_check_at, '2026-08-17T10:03:00.000Z');

  now = '2026-08-17T10:03:00.000Z';
  result = await run();
  assert.equal(result.state.external_wait.consecutive_query_errors, 4);
  assert.equal(result.state.external_wait.next_check_at, '2026-08-17T10:04:00.000Z');

  fail = false;
  now = '2026-08-17T10:04:00.000Z';
  result = await run();
  assert.equal(result.state.external_wait.consecutive_query_errors, 0);
  assert.equal(result.state.external_wait.next_check_at, '2026-08-17T10:04:05.000Z');
});

test('WAIT_EXTERNAL records Patch Session reconcile and completion_check observability in the same recovery cycle', async () => {
  const order = [];
  const store = memoryStore();
  const state = controlledRecoveryTask('wait-observe-queries', 'WAITING_EXTERNAL', externalPolicy);
  state.patch_session_id = 'ps-observe';
  state.session_id = 'ps-observe';
  state.patch_status_target = null;
  state.external_wait = {
    started_at: '2026-08-17T10:00:00.000Z', last_checked_at: null, next_check_at: '2026-08-17T10:02:00.000Z',
    query_count: 0, last_query_at: null, last_result: null, last_patch_reconcile_at: null, last_completion_check_at: null,
    summary: 'waiting', resync_count: 0, last_resync_at: null, escalated_at: null
  };
  await store.save(state);
  const api = recoveryApi(order, { refreshedLease: { token: 'lease-new', ttl_ms: 900000, assignment_id: 'a1', execution_id: 'e1', agent_id: 'agent-1' } });
  api.reconcilePatchSession = async (taskId, sessionId) => {
    order.push(`reconcile:${taskId}:${sessionId}`);
    return { reconciliation: { discovered_patches: [] }, acceptance: { directive: 'WAIT_EXTERNAL' } };
  };
  api.completionCheckTask = async taskId => { order.push(`completion-check:${taskId}`); return { directive: 'WAIT_EXTERNAL', summary: 'still waiting' }; };

  const result = await new TaskRunner({
    taskApi: api, taskStore: store, page: {}, processPatch: durablePatch,
    now: () => new Date('2026-08-17T10:02:00.000Z')
  }).recoverOnce();

  assert.equal(result.status, 'waiting_external');
  assert.equal(result.state.external_wait.query_count, 2);
  assert.equal(result.state.external_wait.last_query_at, '2026-08-17T10:02:00.000Z');
  assert.equal(result.state.external_wait.last_result, 'completion:WAIT_EXTERNAL');
  assert.equal(result.state.external_wait.last_patch_reconcile_at, '2026-08-17T10:02:00.000Z');
  assert.equal(result.state.external_wait.last_completion_check_at, '2026-08-17T10:02:00.000Z');
  assert.ok(order.includes('reconcile:wait-observe-queries:ps-observe'));
  assert.ok(order.includes('completion-check:wait-observe-queries'));
});

test('stalled WAIT_EXTERNAL performs one resync then escalates to waiting_human without reloading ChatGPT', async () => {
  const order = [];
  const store = memoryStore();
  const state = controlledRecoveryTask('wait-stall', 'WAITING_EXTERNAL', externalPolicy);
  state.external_wait = {
    started_at: '2026-08-17T10:00:00.000Z', last_checked_at: '2026-08-17T10:28:00.000Z', next_check_at: '2026-08-17T10:30:00.000Z',
    summary: 'deploy pending', resync_count: 0, last_resync_at: null, escalated_at: null
  };
  await store.save(state);
  const api = recoveryApi(order, { refreshedLease: { token: 'lease-new', ttl_ms: 900000, assignment_id: 'a1', execution_id: 'e1', agent_id: 'agent-1' } });
  api.completionCheckTask = async taskId => { order.push(`completion-check:${taskId}`); return { directive: 'WAIT_EXTERNAL', summary: 'deploy still pending' }; };
  api.waitingExternalTask = async (_taskId, payload) => { order.push(`waiting-external:${payload.reason}`); };
  api.waitingHumanTask = async (_taskId, payload) => { order.push(`waiting-human:${payload.reason}`); };
  const page = {
    async prepareExistingTask() { order.push('prepare'); }, async runRound() { order.push('round'); },
    async reloadPage() { order.push('reload'); }, async reopenWorkspace() { order.push('reopen'); },
    async deleteTaskProject() { order.push('delete'); }
  };
  let now = '2026-08-17T10:30:00.000Z';
  let runner = new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch, now: () => new Date(now) });
  const resynced = await runner.recoverOnce();
  assert.equal(resynced.status, 'waiting_external');
  assert.equal(resynced.state.external_wait.resync_count, 1);
  assert.ok(order.includes('waiting-external:RESYNC_EXTERNAL_STATE'));
  assert.equal(order.includes('reload'), false);
  assert.equal(order.includes('reopen'), false);

  now = '2026-08-17T10:32:00.000Z';
  runner = new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch, now: () => new Date(now) });
  const escalated = await runner.recoverOnce();
  assert.equal(escalated.status, 'waiting_human');
  assert.equal(escalated.state.phase, 'WAITING_HUMAN');
  assert.equal(escalated.state.external_wait.escalated_at, '2026-08-17T10:32:00.000Z');
  assert.ok(order.includes('waiting-human:WAIT_EXTERNAL_STALLED'));
  assert.equal(order.includes('reload'), false);
  assert.equal(order.includes('reopen'), false);
});

test('confirmed lease loss freezes browser work, preserves the owned Project, and waits for authoritative control state', async () => {
  const order = [];
  const store = memoryStore();
  await store.save(controlledRecoveryTask('lease-lost', 'RUNNING', externalPolicy));
  const leaseError = Object.assign(new Error('lease expired'), { code: 'assignment_lease_expired', status: 409 });
  const api = recoveryApi(order, { heartbeatError: leaseError });
  api.getCurrentTask = async () => { order.push('current'); return { assignment: null, task: null, execution: null }; };
  const page = {
    async prepareExistingTask() { order.push('prepare'); },
    async deleteTaskProject({ project }) { order.push(`delete:${project.project_name}`); return { ok: true }; }
  };
  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch }).recoverOnce();
  assert.equal(result.status, 'lease_lost');
  assert.deepEqual(order, ['restore:lease-lost', 'heartbeat:lease-lost', 'current']);
  assert.equal(result.state.phase, 'LEASE_LOST');
  assert.equal(result.state.task_project.status, 'active');
  assert.equal(result.state.lease_loss.control_state, 'detached');
  const durable = await store.load();
  assert.equal(durable.phase, 'LEASE_LOST');
  assert.equal(durable.task_project.project_name, 'owned-project');
});

test('lease loss keeps the durable execution and retries control reconciliation after a transient control-plane error', async () => {
  const order = [];
  const store = memoryStore();
  await store.save(controlledRecoveryTask('lease-lost-wait', 'RUNNING', externalPolicy));
  const leaseError = Object.assign(new Error('lease inactive'), { code: 'assignment_lease_inactive', status: 409 });
  const api = recoveryApi(order, { heartbeatError: leaseError });
  api.getCurrentTask = async () => { order.push('current'); throw Object.assign(new Error('network down'), { code: 'NETWORK_ERROR' }); };
  const page = { async deleteTaskProject() { order.push('delete'); return { ok: true }; } };
  const now = new Date('2026-08-22T01:00:00.000Z');
  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch, now: () => now }).recoverOnce();
  assert.equal(result.status, 'lease_lost');
  assert.deepEqual(order, ['restore:lease-lost-wait', 'heartbeat:lease-lost-wait', 'current']);
  assert.equal(result.state.phase, 'LEASE_LOST');
  assert.equal(result.state.lease_loss.control_state, 'pending');
  assert.ok(Date.parse(result.state.next_recovery_at) > now.getTime());
  assert.equal((await store.load()).task_project.project_name, 'owned-project');
});

test('completed Task cleanup retry does not require a live lease and never re-sends completion', async () => {
  const order = [];
  const store = memoryStore();
  const state = controlledRecoveryTask('cleanup-completed', 'CLEANUP', externalPolicy);
  state.business_completed = true;
  state.terminal_reason = 'SUCCESS';
  state.terminal_action = 'COMPLETE';
  state.cleanup_error = { code: 'UI_SELECTOR_INCOMPATIBLE', message: 'try again' };
  state.lease = null;
  state.lease_token = null;
  await store.save(state);
  const api = {
    restoreLease() { order.push('restore'); throw new Error('must not require lease'); },
    async completeTask() { order.push('complete'); throw new Error('must not complete twice'); }
  };
  const page = {
    async deleteTaskProject({ project }) { order.push(`delete:${project.project_name}`); return { ok: true }; }
  };
  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch }).recoverOnce();
  assert.equal(result.status, 'completed');
  assert.deepEqual(order, ['delete:owned-project']);
  assert.equal(await store.load(), null);
});



test('failed Task cleanup retry does not require a live lease and never re-sends failure', async () => {
  const order = [];
  const store = memoryStore();
  const state = recoveryState('cleanup-failed-terminal', 'CLEANUP', ERROR_CODES.MODEL_RESPONSE_TIMEOUT);
  state.lease = null;
  state.terminal_action = 'FAIL';
  state.terminal_reported = true;
  state.terminal_payload = {
    task_patch_count: 0,
    task_round_count: 0,
    session_id: 'session-r1',
    project_name: state.task_project.project_name,
    patch_goal: null,
    terminal_status: 'failed',
    code: ERROR_CODES.MODEL_RESPONSE_TIMEOUT,
    message: 'initialization timed out'
  };
  await store.save(state);
  const api = {
    restoreLease() { throw new Error('terminal cleanup must not restore lease'); },
    async heartbeatTask() { throw new Error('terminal cleanup must not heartbeat'); },
    async failTask() { order.push('fail-server'); }
  };
  const page = {
    async deleteTaskProject({ project }) { order.push(`delete:${project.project_name}`); return { ok: true }; }
  };

  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch }).recoverOnce();

  assert.equal(result.status, 'failed');
  assert.deepEqual(order, [`delete:${state.task_project.project_name}`]);
  assert.equal(await store.load(), null);
});
test('WAIT_HUMAN recovery renews ownership without opening ChatGPT and schedules lease-safe wake', async () => {
  const order = [];
  const store = memoryStore();
  await store.save(controlledRecoveryTask('human-1', 'WAITING_HUMAN', externalPolicy));
  const api = recoveryApi(order, { refreshedLease: { token: 'lease-new', ttl_ms: 90000, assignment_id: 'a1', execution_id: 'e1', agent_id: 'agent-1' } });
  api.completionCheckTask = async taskId => { order.push(`completion-check:${taskId}`); return { directive: 'WAIT_HUMAN', summary: 'manual review still required' }; };
  const page = {
    async prepareExistingTask() { order.push('prepare'); }, async runRound() { order.push('round'); }, async deleteTaskProject() { order.push('delete'); }
  };
  const result = await new TaskRunner({
    taskApi: api, taskStore: store, page, processPatch: durablePatch,
    now: () => new Date('2026-08-17T10:00:00.000Z')
  }).recoverOnce();
  assert.equal(result.status, 'waiting_human');
  assert.equal(result.state.next_recovery_at, '2026-08-17T10:00:30.000Z');
  assert.deepEqual(order, ['restore:human-1', 'heartbeat:human-1', 'completion-check:human-1']);
});

test('named Patch download timeout links expected Patch and waits for server PatchSync evidence instead of failing the Task', async () => {
  const api = new MockTaskApi([{ task_id: 't-patch-timeout-wait', project_id: 'vetatool', task_prompt: 'fix' }]);
  const prepared = [];
  api.preparePatchArtifact = async (taskId, artifact) => {
    prepared.push({ taskId, artifact: structuredClone(artifact) });
    return { deliverable: { deliverable_id: 'deliverable-timeout', deliverable_key: artifact.patch_key, deliverable_type: 'patch' }, created: true };
  };
  api.completionCheckTask = async () => ({
    directive: 'WAIT_EXTERNAL', status: 'waiting_external', summary: 'Waiting for PatchSync verification',
    counts: { successful_patches: 0, pending_patches: 1 }, unmet_criteria: ['min_successful_patches']
  });
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename: 'vetatool--s1--001-fix.patch' }] }]);
  const store = memoryStore();
  const processPatch = async () => { throw new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_FAILED, 'Patch download timed out after 600000ms'); };

  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch }).runOnce();

  assert.equal(result.status, 'waiting_external');
  assert.equal(result.state.phase, 'WAITING_EXTERNAL');
  assert.equal(result.state.task_round_count, 1);
  assert.equal(result.state.last_task_status, 'DONE');
  assert.equal(result.state.task_patch_count, 0);
  assert.equal(result.state.task_project.status, 'active');
  assert.equal(result.state.downloaded_patch_keys.includes('vetatool--s1--001-fix.patch'), true);
  assert.deepEqual(prepared, [{
    taskId: 't-patch-timeout-wait',
    artifact: {
      filename: 'vetatool--s1--001-fix.patch',
      patch_key: 'vetatool--s1--001-fix.patch',
      patch_session_id: 's1',
      sequence: 1
    }
  }]);
  assert.equal(page.calls.some(call => call.type === 'delete'), false);
  assert.equal(api.getSnapshot().tasks['t-patch-timeout-wait'].events.some(event => event.type === 'FAILED'), false);
});

test('named Patch download timeout adopts already successful server Patch evidence and finalizes without local Patch count', async () => {
  const api = new MockTaskApi([{ task_id: 't-patch-timeout-ready', project_id: 'vetatool', task_prompt: 'fix' }]);
  api.preparePatchArtifact = async (_taskId, artifact) => ({
    deliverable: { deliverable_id: 'deliverable-ready', deliverable_key: artifact.patch_key, deliverable_type: 'patch' }, created: true
  });
  api.completionCheckTask = async () => exactPatchPreview('vetatool--s1--001-fix.patch', { directive: 'READY_TO_FINALIZE', status: 'success', isTerminal: true, terminalKind: 'success', nextAction: 'next_sequence', successful: 1, pending: 0 });
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename: 'vetatool--s1--001-fix.patch' }] }]);
  const processPatch = async () => { throw new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_FAILED, 'Patch download timed out after 600000ms'); };

  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch }).runOnce();

  assert.equal(result.status, 'completed');
  assert.equal(result.state.task_patch_count, 0);
  assert.equal(result.state.server_successful_patch_count, 1);
  assert.equal(result.state.business_completed, true);
  assert.equal(result.state.task_project.status, 'deleted');
  assert.equal(api.getSnapshot().tasks['t-patch-timeout-ready'].status, 'completed');
  assert.equal(api.getSnapshot().tasks['t-patch-timeout-ready'].events.some(event => event.type === 'FAILED'), false);
});

test('click-only Patch timeout uses observed Chrome filename to finalize from successful server evidence', async () => {
  const api = new MockTaskApi([{ task_id: 't-click-timeout-ready', project_id: 'vetatool', task_prompt: 'fix' }]);
  const prepared = [];
  api.preparePatchArtifact = async (taskId, artifact) => {
    prepared.push({ taskId, artifact: structuredClone(artifact) });
    return { deliverable: { deliverable_id: 'deliverable-click-ready', deliverable_key: artifact.patch_key, deliverable_type: 'patch' }, created: true };
  };
  api.completionCheckTask = async () => exactPatchPreview('vetatool--s1--001-fix.patch', { directive: 'READY_TO_FINALIZE', status: 'success', isTerminal: true, terminalKind: 'success', nextAction: 'next_sequence', successful: 1, pending: 0 });
  const page = scriptedPage([{
    assistantText: '<TASK_STATUS>DONE</TASK_STATUS>',
    patches: [{ filename: null, control_key: 's1:control:download-patch', clickToken: 'click-only' }]
  }]);
  const processPatch = async () => {
    throw new RunnerError(
      ERROR_CODES.PATCH_DOWNLOAD_FAILED,
      'Patch download timed out after 600000ms',
      { filename: 'vetatool--s1--001-fix.patch', downloadId: 256, correlation: 'completed_download_history' }
    );
  };

  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch }).runOnce();

  assert.equal(result.status, 'completed');
  assert.equal(result.state.server_successful_patch_count, 1);
  assert.equal(result.state.business_completed, true);
  assert.deepEqual(prepared, [{
    taskId: 't-click-timeout-ready',
    artifact: {
      filename: 'vetatool--s1--001-fix.patch',
      patch_key: 'vetatool--s1--001-fix.patch',
      patch_session_id: 's1',
      sequence: 1
    }
  }]);
  assert.equal(api.getSnapshot().tasks['t-click-timeout-ready'].events.some(event => event.type === 'FAILED'), false);
});

test('operator termination abort is propagated without releasing or failing the cancelled Task again', async () => {
  const api = new MockTaskApi([{ task_id: 't-terminate', project_id: 'vetatool', task_prompt: 'fix' }]);
  const abortController = new AbortController();
  const page = {
    async createTaskProject() {
      abortController.abort();
      const error = new Error('Task execution terminated by operator');
      error.code = 'TASK_TERMINATED';
      throw error;
    }
  };
  const runner = new TaskRunner({
    taskApi: api,
    taskStore: memoryStore(),
    page,
    processPatch: durablePatch,
    abortSignal: abortController.signal
  });
  await assert.rejects(runner.runOnce(), error => error?.code === 'TASK_TERMINATED');
  assert.notEqual(api.getSnapshot().tasks['t-terminate'].status, 'ready');
  assert.notEqual(api.getSnapshot().tasks['t-terminate'].status, 'failed');
});

test('PatchSync auto-import race reconciles server evidence when Native reader loses the downloaded file', async () => {
  const task = patchsyncBootstrapTask('t-patch-import-race');
  const api = new MockTaskApi([task]);
  const prepared = [];
  api.preparePatchArtifact = async (taskId, artifact) => {
    prepared.push({ taskId, artifact: structuredClone(artifact) });
    return { deliverable: { deliverable_id: 'deliverable-race', deliverable_key: artifact.patch_key, deliverable_type: 'patch' }, created: true };
  };
  api.completionCheckTask = async () => exactPatchPreview('vetatool--ps-20260817-abc123--001-submit.patch', { directive: 'READY_TO_FINALIZE', status: 'success', isTerminal: true, terminalKind: 'success', nextAction: 'next_sequence', successful: 1, pending: 0 });
  const filename = 'vetatool--ps-20260817-abc123--001-submit.patch';
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename }] }]);
  const patchsyncClient = {
    async createExport() { return { export_id: 'exp-1' }; },
    async waitForExport() { return preparedManifest(); },
    async downloadSource() { return { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }; }
  };
  const artifactTransfer = {
    async transfer(artifact, context) {
      assert.equal(context.patchSyncClient, patchsyncClient);
      assert.equal(artifact.filename, filename);
      throw new RunnerError(
        ERROR_CODES.REMOTE_ARTIFACT_READ_FAILED,
        'Native Patch file reader rejected the file',
        { filename, native_code: 'PATCH_FILE_NOT_FOUND' }
      );
    }
  };

  const result = await new TaskRunner({
    taskApi: api,
    taskStore: memoryStore(),
    page,
    artifactTransfer,
    patchSyncClientFactory: () => patchsyncClient,
    processPatch: async (candidate, context) => ({
      task_id: context.taskId,
      session_id: context.sessionId,
      filename: candidate.filename,
      patch_key: candidate.filename,
      local_path: `/Users/test/Downloads/${candidate.filename}`,
      download_id: 256
    })
  }).runOnce();

  assert.equal(result.status, 'completed');
  assert.equal(result.state.task_patch_count, 0);
  assert.equal(result.state.server_successful_patch_count, 1);
  assert.equal(result.state.business_completed, true);
  assert.deepEqual(prepared, [{
    taskId: 't-patch-import-race',
    artifact: {
      filename,
      patch_key: filename,
      patch_session_id: 'ps-20260817-abc123',
      sequence: 1
    }
  }]);
  assert.equal(api.getSnapshot().tasks['t-patch-import-race'].events.some(event => event.type === 'FAILED'), false);
});

function exactPatchPreview(filename, {
  directive = 'WAIT_EXTERNAL',
  status = 'ci_testing',
  isTerminal = false,
  terminalKind = null,
  nextAction = 'wait',
  suggestedSequence = null,
  decisionReason = null,
  errorSummary = null,
  errorExcerpt = null,
  failedJob = null,
  failedStep = null,
  suggestion = null,
  successful = 0,
  pending = 1
} = {}) {
  const identity = filename.match(/^.+?--(.+?)--(\d{3})-/i);
  const sessionId = identity?.[1] ?? 'ps-20260817-abc123';
  const sequence = Number(identity?.[2] ?? 1);
  return {
    directive,
    status: directive === 'READY_TO_FINALIZE' ? 'satisfied' : directive === 'WAIT_EXTERNAL' ? 'waiting_external' : 'unmet',
    summary: directive === 'WAIT_EXTERNAL' ? 'Waiting for exact PatchSync status' : 'Continue from exact PatchSync decision',
    counts: { successful_patches: successful, pending_patches: pending },
    unmet_criteria: directive === 'READY_TO_FINALIZE' ? [] : ['require_ci_success'],
    latest_patch: {
      project_id: 'vetatool',
      session_id: sessionId,
      sequence,
      patch_filename: filename,
      status,
      is_terminal: isTerminal,
      terminal_kind: terminalKind,
      next_action: nextAction,
      ...(Number.isInteger(suggestedSequence) ? { suggested_sequence: suggestedSequence } : {}),
      ...(decisionReason ? { decision_reason: decisionReason } : {}),
      ...(errorSummary ? { error_summary: errorSummary } : {}),
      ...(errorExcerpt ? { error_excerpt: errorExcerpt } : {}),
      ...(failedJob ? { failed_job: failedJob } : {}),
      ...(failedStep ? { failed_step: failedStep } : {}),
      ...(suggestion ? { suggestion } : {})
    }
  };
}


test('PatchSync-backed task starts exact Patch status monitoring before a pending local download settles and feeds terminal failure back to the same Project', async () => {
  const task = patchsyncBootstrapTask('t-patch-remote-preempts-download');
  const api = new MockTaskApi([task]);
  const store = memoryStore();
  const filename = 'vetatool--ps-20260817-abc123--001-failing.patch';
  const retryFilename = 'vetatool--ps-20260817-abc123--001-failing-r2.patch';
  const prompts = [];
  const page = scriptedPage([
    { assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename }] },
    { assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename: retryFilename }] }
  ]);
  const originalRunRound = page.runRound.bind(page);
  page.runRound = async input => {
    prompts.push(input.prompt);
    return originalRunRound(input);
  };
  const patchsyncClient = {
    async createExport() { return { export_id: 'exp-1' }; },
    async waitForExport() { return preparedManifest(); },
    async downloadSource() { return { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }; }
  };
  const prepared = [];
  api.preparePatchArtifact = async (_taskId, artifact) => {
    prepared.push(artifact.filename);
    return { deliverable: { deliverable_id: `d-${prepared.length}` }, created: true };
  };
  const previews = [
    exactPatchPreview(filename, {
      directive: 'CONTINUE', status: 'local_test_failed', isTerminal: true, terminalKind: 'failure', nextAction: 'retry_same_sequence',
      decisionReason: 'local verification failed', errorSummary: 'homepage test failed', errorExcerpt: 'Unable to find accessible link', failedStep: 'verify', suggestion: 'fix the homepage link'
    }),
    exactPatchPreview(retryFilename, { directive: 'READY_TO_FINALIZE', status: 'success', isTerminal: true, terminalKind: 'success', nextAction: 'next_sequence', successful: 1, pending: 0 })
  ];
  api.completionCheckTask = async () => previews.shift() ?? exactPatchPreview(retryFilename, { directive: 'READY_TO_FINALIZE', status: 'success', isTerminal: true, terminalKind: 'success', nextAction: 'next_sequence', successful: 1, pending: 0 });

  let firstDownloadStarted = false;
  const processPatch = async (candidate, context) => {
    if (candidate.filename === filename) {
      firstDownloadStarted = true;
      return new Promise(() => {});
    }
    return { filename: candidate.filename, patch_key: candidate.filename, task_id: context.taskId, session_id: context.sessionId };
  };

  const result = await new TaskRunner({
    taskApi: api,
    taskStore: store,
    page,
    processPatch,
    patchSyncClientFactory: () => patchsyncClient,
    patchStatusPollMs: 1
  }).runOnce();

  assert.equal(firstDownloadStarted, true);
  assert.equal(result.status, 'completed');
  assert.deepEqual(prepared.slice(0, 2), [filename, retryFilename]);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /retry_same_sequence/);
  assert.match(prompts[1], /homepage test failed/);
  assert.equal(api.getSnapshot().tasks[task.task_id].events.some(event => event.type === 'RELEASED'), false);
  assert.equal(api.getSnapshot().tasks[task.task_id].events.some(event => event.type === 'FAILED'), false);
});

test('known exact Patch download failure stays attached to the current Task and waits for remote status instead of releasing it', async () => {
  const task = patchsyncBootstrapTask('t-known-patch-download-failure');
  const api = new MockTaskApi([task]);
  const store = memoryStore();
  const filename = 'vetatool--ps-20260817-abc123--001-download-failed.patch';
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename }] }]);
  const patchsyncClient = {
    async createExport() { return { export_id: 'exp-1' }; },
    async waitForExport() { return preparedManifest(); },
    async downloadSource() { return { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }; }
  };
  api.preparePatchArtifact = async () => ({ deliverable: { deliverable_id: 'd1' }, created: true });
  api.completionCheckTask = async () => ({
    directive: 'WAIT_EXTERNAL', status: 'waiting_external', summary: 'Patch record not visible yet',
    counts: { successful_patches: 0, pending_patches: 0 }, unmet_criteria: ['patch_pending'], latest_patch: null
  });

  const result = await new TaskRunner({
    taskApi: api,
    taskStore: store,
    page,
    processPatch: async () => { throw new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_FAILED, 'Patch download was interrupted'); },
    patchSyncClientFactory: () => patchsyncClient,
    patchStatusPollMs: 1
  }).runOnce();

  assert.equal(result.status, 'waiting_external');
  assert.equal(result.state.patch_status_target.filename, filename);
  assert.equal((await store.load()).task_id, task.task_id);
  assert.equal(api.getSnapshot().tasks[task.task_id].events.some(event => event.type === 'RELEASED'), false);
  assert.equal(api.getSnapshot().tasks[task.task_id].events.some(event => event.type === 'FAILED'), false);
});

test('PatchSync-backed task durably checkpoints the exact Patch filename before artifact transfer can fail', async () => {
  const task = patchsyncBootstrapTask('t-patch-target-before-transfer');
  const api = new MockTaskApi([task]);
  const store = memoryStore();
  const filename = 'vetatool--ps-20260817-abc123--001-before-transfer.patch';
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename }] }]);
  const patchsyncClient = {
    async createExport() { return { export_id: 'exp-1' }; },
    async waitForExport() { return preparedManifest(); },
    async downloadSource() { return { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }; }
  };
  let transferSawDurableTarget = false;
  const artifactTransfer = {
    async transfer() {
      const durable = await store.load();
      transferSawDurableTarget = durable.patch_status_target?.filename === filename
        && durable.patch_status_target?.session_id === 'ps-20260817-abc123'
        && durable.patch_status_target?.sequence === 1;
      throw new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_FAILED, 'simulated network loss after browser download');
    }
  };

  const result = await new TaskRunner({
    taskApi: api,
    taskStore: store,
    page,
    artifactTransfer,
    patchSyncClientFactory: () => patchsyncClient,
    processPatch: async (candidate, context) => ({
      task_id: context.taskId,
      session_id: context.sessionId,
      filename: candidate.filename,
      patch_key: candidate.filename,
      local_path: `/Downloads/${candidate.filename}`,
      download_id: 777
    })
  }).runOnce();

  assert.equal(result.status, 'waiting_external');
  assert.equal(transferSawDurableTarget, true);
  assert.equal(result.state.patch_session_id, 'ps-20260817-abc123');
  assert.equal((await store.load()).task_id, task.task_id);
});

test('PatchSync-backed task keeps the exact Patch filename durable before artifact reporting can lose the network', async () => {
  const task = patchsyncBootstrapTask('t-patch-target-before-report');
  const api = new MockTaskApi([task]);
  const store = memoryStore();
  const filename = 'vetatool--ps-20260817-abc123--001-before-report.patch';
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename }] }]);
  const patchsyncClient = {
    async createExport() { return { export_id: 'exp-1' }; },
    async waitForExport() { return preparedManifest(); },
    async downloadSource() { return { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }; }
  };
  let reportSawDurableTarget = false;
  api.reportArtifact = async () => {
    const durable = await store.load();
    reportSawDurableTarget = durable.patch_status_target?.filename === filename
      && durable.patch_status_target?.sequence === 1;
    throw new Error('simulated control-plane outage');
  };

  const result = await new TaskRunner({
    taskApi: api,
    taskStore: store,
    page,
    patchSyncClientFactory: () => patchsyncClient,
    processPatch: async (candidate, context) => ({
      task_id: context.taskId,
      session_id: context.sessionId,
      filename: candidate.filename,
      patch_key: candidate.filename,
      local_path: `/Downloads/${candidate.filename}`,
      download_id: 778
    })
  }).runOnce();

  assert.equal(result.status, 'waiting_external');
  assert.equal(reportSawDurableTarget, true);
  assert.equal(result.state.patch_session_id, 'ps-20260817-abc123');
  assert.equal((await store.load()).task_id, task.task_id);
});

test('PatchSync-backed task treats every generated Patch as a remote-status barrier even when the model says CONTINUE', async () => {
  const task = patchsyncBootstrapTask('t-patch-barrier-continue');
  const api = new MockTaskApi([task]);
  const filename = 'vetatool--ps-20260817-abc123--001-first.patch';
  api.completionCheckTask = async () => exactPatchPreview(filename);
  const page = scriptedPage([
    { assistantText: '<TASK_STATUS>CONTINUE</TASK_STATUS>', patches: [{ filename }] },
    { assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename: 'vetatool--ps-20260817-abc123--002-must-not-run-yet.patch' }] }
  ]);
  const patchsyncClient = {
    async createExport() { return { export_id: 'exp-1' }; },
    async waitForExport() { return preparedManifest(); },
    async downloadSource() { return { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }; }
  };

  const result = await new TaskRunner({
    taskApi: api,
    taskStore: memoryStore(),
    page,
    processPatch: durablePatch,
    patchSyncClientFactory: () => patchsyncClient
  }).runOnce();

  assert.equal(result.status, 'waiting_external');
  assert.equal(result.state.task_round_count, 1);
  assert.equal(result.state.patch_status_target.filename, filename);
  assert.equal(page.calls.filter(call => call.type === 'round').length, 1);
  assert.equal(page.calls.some(call => call.type === 'delete'), false);
});

test('WAIT_EXTERNAL exact Patch retry_same_sequence resumes the same Project and feeds remote failure details back to the model', async () => {
  const filename = 'vetatool--ps-20260817-abc123--001-first.patch';
  const retryFilename = 'vetatool--ps-20260817-abc123--001-first-r2.patch';
  const task = {
    ...patchsyncBootstrapTask('t-patch-retry-same'),
    browser_execution_bootstrap: {
      ...patchsyncBootstrapTask('t-patch-retry-same').browser_execution_bootstrap,
      recovery_policy: externalPolicy
    },
    agent_control: { agent_id: 'agent-1', assignment_id: 'a1', execution_id: 'e1' }
  };
  const store = memoryStore();
  const state = controlledRecoveryTask('t-patch-retry-same', 'WAITING_EXTERNAL', externalPolicy);
  state.task_snapshot = structuredClone(task);
  state.browser_execution_bootstrap = structuredClone(task.browser_execution_bootstrap);
  state.patch_session_id = 'ps-20260817-abc123';
  state.session_id = 'ps-20260817-abc123';
  state.patch_status_target = { filename, session_id: 'ps-20260817-abc123', sequence: 1 };
  state.external_wait = {
    started_at: '2026-08-21T10:00:00.000Z', last_checked_at: null, next_check_at: '2026-08-21T10:02:00.000Z',
    summary: 'waiting', resync_count: 0, last_resync_at: null, escalated_at: null
  };
  await store.save(state);
  const order = [];
  const api = recoveryApi(order, { refreshedLease: { token: 'lease-new', ttl_ms: 900000, assignment_id: 'a1', execution_id: 'e1', agent_id: 'agent-1' } });
  const previews = [
    exactPatchPreview(filename, {
      directive: 'CONTINUE', status: 'local_test_failed', isTerminal: true, terminalKind: 'failure', nextAction: 'retry_same_sequence',
      decisionReason: 'local verification failed', errorSummary: 'tests failed', errorExcerpt: 'expected 1 got 2', failedJob: 'local', failedStep: 'verify', suggestion: 'fix the test'
    }),
    exactPatchPreview(retryFilename, {
      directive: 'READY_TO_FINALIZE', status: 'success', isTerminal: true, terminalKind: 'success', nextAction: 'next_sequence', successful: 1, pending: 0
    })
  ];
  api.completionCheckTask = async () => previews.shift();
  api.preparePatchArtifact = async () => ({ deliverable: { deliverable_id: 'd1' }, created: true });
  api.reportArtifact = async () => ({ artifact: true });
  const prompts = [];
  const page = {
    async prepareExistingTask(taskInput) { order.push(`prepare:${taskInput.chatgpt_project_name}`); },
    async runRound({ prompt, hooks }) {
      prompts.push(prompt);
      await hooks.onPromptSent?.();
      await hooks.onResponseReady?.('<TASK_STATUS>DONE</TASK_STATUS>');
      return { assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename: retryFilename }] };
    },
    async deleteTaskProject({ project }) { order.push(`delete:${project.project_name}`); return { ok: true }; }
  };
  const patchsyncClient = {};
  const result = await new TaskRunner({
    taskApi: api,
    taskStore: store,
    page,
    processPatch: durablePatch,
    patchSyncClientFactory: () => patchsyncClient,
    now: () => new Date('2026-08-21T10:02:00.000Z')
  }).recoverOnce();

  assert.equal(result.status, 'completed');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /retry_same_sequence/);
  assert.match(prompts[0], /001-first\.patch/);
  assert.match(prompts[0], /local_test_failed/);
  assert.match(prompts[0], /expected 1 got 2/);
  assert.match(prompts[0], /同一序号|same sequence|SEQUENCE=1/i);
  assert.ok(order.some(item => item.startsWith('prepare:owned-project')));
});

test('retry_same_sequence keeps the first Patch deliverable key while the physical retry filename changes', async () => {
  const firstFilename = 'vetatool--ps-20260817-abc123--001-homepage.patch';
  const retryFilename = 'vetatool--ps-20260817-abc123--001-homepage-r2.patch';
  const task = {
    ...patchsyncBootstrapTask('t-stable-retry-deliverable'),
    browser_execution_bootstrap: {
      ...patchsyncBootstrapTask('t-stable-retry-deliverable').browser_execution_bootstrap,
      recovery_policy: externalPolicy
    },
    agent_control: { agent_id: 'agent-1', assignment_id: 'a1', execution_id: 'e1' }
  };
  const store = memoryStore();
  const state = controlledRecoveryTask('t-stable-retry-deliverable', 'WAITING_EXTERNAL', externalPolicy);
  state.task_snapshot = structuredClone(task);
  state.browser_execution_bootstrap = structuredClone(task.browser_execution_bootstrap);
  state.patch_session_id = 'ps-20260817-abc123';
  state.session_id = 'ps-20260817-abc123';
  state.patch_status_target = { filename: firstFilename, session_id: 'ps-20260817-abc123', sequence: 1 };
  state.downloaded_patch_keys = [firstFilename];
  state.external_wait = {
    started_at: '2026-08-21T10:00:00.000Z', last_checked_at: null, next_check_at: '2026-08-21T10:02:00.000Z',
    summary: 'waiting', resync_count: 0, last_resync_at: null, escalated_at: null
  };
  await store.save(state);

  const order = [];
  const api = recoveryApi(order, { refreshedLease: { token: 'lease-new', ttl_ms: 900000, assignment_id: 'a1', execution_id: 'e1', agent_id: 'agent-1' } });
  const stableKeys = new Map();
  const observed = [];
  const logicalKey = artifact => artifact?.deliverable_key ?? artifact?.patch_key ?? artifact?.filename;
  const identityKey = artifact => {
    const sessionId = artifact?.patch_session_id ?? artifact?.transfer_receipt?.session_id ?? artifact?.session_id;
    const sequence = artifact?.sequence ?? artifact?.transfer_receipt?.sequence;
    return `${sessionId}:${sequence}`;
  };
  const assertStable = artifact => {
    const identity = identityKey(artifact);
    const key = logicalKey(artifact);
    const existing = stableKeys.get(identity);
    if (existing && existing !== key) {
      const error = new Error('Patch identity is already linked to another deliverable_key');
      error.code = 'patch_link_conflict';
      error.status = 409;
      throw error;
    }
    stableKeys.set(identity, key);
    observed.push({ identity, key, filename: artifact.filename, deliverableFilename: artifact.deliverable_filename ?? null });
    return key;
  };
  api.preparePatchArtifact = async (_taskId, artifact) => {
    const key = assertStable(artifact);
    return { deliverable: { deliverable_id: 'd1', deliverable_key: key }, created: false };
  };
  api.reportArtifact = async (_taskId, artifact) => { assertStable(artifact); return { artifact: true }; };
  api.completionCheckTask = async () => previews.shift();
  const previews = [
    exactPatchPreview(firstFilename, {
      directive: 'CONTINUE', status: 'local_test_failed', isTerminal: true, terminalKind: 'failure', nextAction: 'retry_same_sequence',
      decisionReason: 'local verification failed', errorSummary: 'tests failed'
    }),
    exactPatchPreview(retryFilename, {
      directive: 'READY_TO_FINALIZE', status: 'success', isTerminal: true, terminalKind: 'success', nextAction: 'next_sequence', successful: 1, pending: 0
    })
  ];
  const page = {
    async prepareExistingTask(taskInput) { order.push(`prepare:${taskInput.chatgpt_project_name}`); },
    async runRound({ hooks }) {
      await hooks.onPromptSent?.();
      await hooks.onResponseReady?.('<TASK_STATUS>DONE</TASK_STATUS>');
      return { assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename: retryFilename }] };
    },
    async deleteTaskProject({ project }) { order.push(`delete:${project.project_name}`); return { ok: true }; }
  };

  const result = await new TaskRunner({
    taskApi: api, taskStore: store, page, processPatch: durablePatch, patchSyncClientFactory: () => ({}),
    now: () => new Date('2026-08-21T10:02:00.000Z')
  }).recoverOnce();

  assert.equal(result.status, 'completed');
  assert.ok(observed.some(item => item.filename === retryFilename));
  assert.ok(observed.filter(item => item.identity === 'ps-20260817-abc123:1').every(item => item.key === firstFilename));
  assert.ok(observed.filter(item => item.filename === retryFilename).every(item => item.deliverableFilename === firstFilename));
});

test('legacy RUNNING recovery reuses the first same-sequence Patch key after a retry filename already changed', async () => {
  const firstFilename = 'vetatool--ps-20260817-abc123--001-homepage.patch';
  const retryFilename = 'vetatool--ps-20260817-abc123--001-homepage-r2.patch';
  const task = {
    ...patchsyncBootstrapTask('t-legacy-retry-link'),
    browser_execution_bootstrap: {
      ...patchsyncBootstrapTask('t-legacy-retry-link').browser_execution_bootstrap,
      recovery_policy: externalPolicy
    },
    agent_control: { agent_id: 'agent-1', assignment_id: 'a1', execution_id: 'e1' }
  };
  const store = memoryStore();
  const state = controlledRecoveryTask('t-legacy-retry-link', 'RUNNING', externalPolicy);
  state.task_snapshot = structuredClone(task);
  state.browser_execution_bootstrap = structuredClone(task.browser_execution_bootstrap);
  state.patch_session_id = 'ps-20260817-abc123';
  state.session_id = 'ps-20260817-abc123';
  state.patch_status_target = { filename: retryFilename, session_id: 'ps-20260817-abc123', sequence: 1 };
  state.downloaded_patch_keys = [firstFilename];
  state.last_task_status = 'DONE';
  state.completion_preview = exactPatchPreview(firstFilename, {
    directive: 'CONTINUE', status: 'local_test_failed', isTerminal: true, terminalKind: 'failure', nextAction: 'retry_same_sequence'
  });
  await store.save(state);

  const order = [];
  const api = recoveryApi(order, { refreshedLease: { token: 'lease-new', ttl_ms: 900000, assignment_id: 'a1', execution_id: 'e1', agent_id: 'agent-1' } });
  const prepared = [];
  api.preparePatchArtifact = async (_taskId, artifact) => {
    prepared.push(structuredClone(artifact));
    return { deliverable: { deliverable_id: 'd1', deliverable_key: artifact.deliverable_key ?? artifact.patch_key }, created: false };
  };
  api.completionCheckTask = async () => exactPatchPreview(retryFilename, {
    directive: 'READY_TO_FINALIZE', status: 'success', isTerminal: true, terminalKind: 'success', nextAction: 'next_sequence', successful: 1, pending: 0
  });
  const page = {
    async prepareExistingTask() { order.push('prepare'); },
    async runRound() { throw new Error('no new round should be sent while retry Patch is already targeted'); },
    async deleteTaskProject({ project }) { order.push(`delete:${project.project_name}`); return { ok: true }; }
  };

  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch }).recoverOnce();

  assert.equal(result.status, 'completed');
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].filename, retryFilename);
  assert.equal(prepared[0].deliverable_key, firstFilename);
  assert.equal(prepared[0].deliverable_filename, firstFilename);
});

test('terminal next_sequence failure continues the same Project with the suggested next sequence instead of creating a new Task', async () => {
  const filename = 'vetatool--ps-20260817-abc123--001-first.patch';
  const task = patchsyncBootstrapTask('t-patch-next-sequence');
  const api = new MockTaskApi([task]);
  const previews = [
    exactPatchPreview(filename, {
      directive: 'CONTINUE', status: 'ci_test_failed', isTerminal: true, terminalKind: 'failure', nextAction: 'next_sequence', suggestedSequence: 2,
      decisionReason: 'CI failed after push', errorSummary: 'workflow failed', failedJob: 'tests', failedStep: 'npm test'
    }),
    { directive: 'READY_TO_FINALIZE', status: 'satisfied', summary: 'done', counts: { successful_patches: 1, pending_patches: 0 }, latest_patch: null }
  ];
  api.completionCheckTask = async () => previews.shift();
  const prompts = [];
  const page = scriptedPage([
    { assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename }] },
    { assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] }
  ]);
  const originalRunRound = page.runRound.bind(page);
  page.runRound = async args => { prompts.push(args.prompt); return originalRunRound(args); };
  const patchsyncClient = {
    async createExport() { return { export_id: 'exp-1' }; }, async waitForExport() { return preparedManifest(); },
    async downloadSource() { return { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }; }
  };
  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch, patchSyncClientFactory: () => patchsyncClient }).runOnce();
  assert.equal(result.status, 'completed');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /next_sequence/);
  assert.match(prompts[1], /002|SEQUENCE=2/);
  assert.match(prompts[1], /CI failed after push/);
  assert.equal(page.calls.filter(call => call.type === 'create').length, 1);
});

test('exact Patch identity mismatch or no record waits and never advances or deletes the Project', async () => {
  for (const latestPatch of [null, exactPatchPreview('vetatool--ps-20260817-abc123--002-other.patch').latest_patch]) {
    const task = patchsyncBootstrapTask(`t-patch-no-record-${latestPatch ? 'mismatch' : 'none'}`);
    const api = new MockTaskApi([task]);
    const filename = 'vetatool--ps-20260817-abc123--001-first.patch';
    api.completionCheckTask = async () => ({
      directive: 'CONTINUE', status: 'unmet', summary: 'generic continue', counts: { successful_patches: 0, pending_patches: 1 }, latest_patch: latestPatch
    });
    const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename }] }]);
    const patchsyncClient = {
      async createExport() { return { export_id: 'exp-1' }; }, async waitForExport() { return preparedManifest(); },
      async downloadSource() { return { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }; }
    };
    const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch, patchSyncClientFactory: () => patchsyncClient }).runOnce();
    assert.equal(result.status, 'waiting_external');
    assert.equal(result.state.task_round_count, 1);
    assert.equal(page.calls.filter(call => call.type === 'round').length, 1);
    assert.equal(page.calls.some(call => call.type === 'delete'), false);
  }
});

test('transient completion status query failure waits instead of failing the Patch or Task', async () => {
  const task = patchsyncBootstrapTask('t-patch-query-unavailable');
  const api = new MockTaskApi([task]);
  api.completionCheckTask = async () => { throw new TypeError('Failed to fetch'); };
  const filename = 'vetatool--ps-20260817-abc123--001-first.patch';
  const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename }] }]);
  const patchsyncClient = {
    async createExport() { return { export_id: 'exp-1' }; }, async waitForExport() { return preparedManifest(); },
    async downloadSource() { return { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }; }
  };
  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch, patchSyncClientFactory: () => patchsyncClient }).runOnce();
  assert.equal(result.status, 'waiting_external');
  assert.equal(result.state.phase, 'WAITING_EXTERNAL');
  assert.equal(api.getSnapshot().tasks['t-patch-query-unavailable'].events.some(event => event.type === 'FAILED'), false);
  assert.equal(page.calls.some(call => call.type === 'delete'), false);
});

test('exact Patch stop or legacy terminal response never guesses a sequence and waits for human inspection', async () => {
  const filename = 'vetatool--ps-20260817-abc123--001-first.patch';
  const cases = [
    exactPatchPreview(filename, { directive: 'CONTINUE', status: 'blocked', isTerminal: true, terminalKind: 'failure', nextAction: 'stop', decisionReason: 'manual inspection required' }),
    {
      directive: 'CONTINUE', status: 'unmet', summary: 'legacy response', counts: { successful_patches: 0, pending_patches: 0 },
      latest_patch: { project_id: 'vetatool', session_id: 'ps-20260817-abc123', sequence: 1, patch_filename: filename, status: 'ci_test_failed' }
    }
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const task = patchsyncBootstrapTask(`t-patch-stop-${index}`);
    const api = new MockTaskApi([task]);
    api.completionCheckTask = async () => cases[index];
    const page = scriptedPage([{ assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [{ filename }] }]);
    const patchsyncClient = {
      async createExport() { return { export_id: 'exp-1' }; }, async waitForExport() { return preparedManifest(); },
      async downloadSource() { return { filename: 'source.zip', mimeType: 'application/zip', size: 3, base64: 'AQID' }; }
    };
    const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch, patchSyncClientFactory: () => patchsyncClient }).runOnce();
    assert.equal(result.status, 'waiting_human');
    assert.equal(result.state.phase, 'WAITING_HUMAN');
    assert.equal(page.calls.filter(call => call.type === 'round').length, 1);
    assert.equal(page.calls.some(call => call.type === 'delete'), false);
  }
});

test('model confirmation or technical-choice question is answered autonomously in the same Task instead of waiting for a human', async () => {
  const api = new MockTaskApi([{ task_id: 't-auto-question', project_id: 'vetatool', task_prompt: '执行当前任务' }]);
  const page = scriptedPage([
    { assistantText: '我可以采用方案 A，也可以采用方案 B。你希望我选择哪一个？', patches: [] },
    { assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] }
  ]);

  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();

  assert.equal(result.status, 'completed');
  const prompts = page.calls.filter(call => call.type === 'round').map(call => call.prompt);
  assert.equal(prompts[0], '执行当前任务');
  assert.match(prompts[1], /专业经验/);
  assert.match(prompts[1], /不需要等待人工确认/);
  assert.match(prompts[1], /不得.*(?:密钥|Token|密码|验证码)/);
});

test('initialization explicit response failure is restartable in a fresh workspace after bounded native Retry', async () => {
  const task = {
    task_id: 't-init-response-failed', project_id: 'vetatool', task_prompt: '执行正式 Task',
    resource: { url: 'https://assets.example.com/source.zip' },
    browser_execution_bootstrap: {
      recovery_policy: { version: 1, rules: [{ id: 'gpt-response-stalled', signal: 'GPT_RESPONSE_STALLED', observation_timeout_seconds: 60, actions: [] }] }
    }
  };
  const api = new MockTaskApi([task]);
  const created = [];
  let attempts = 0;
  const page = {
    async createTaskProject({ preferredProjectName = null }) {
      const projectName = preferredProjectName ?? 'vetatool2026082117';
      created.push(projectName);
      return { projectName, sessionId: 's1' };
    },
    async initializeTask() {
      attempts += 1;
      if (attempts === 1) throw new RunnerError(ERROR_CODES.MODEL_RESPONSE_FAILED, 'native retry exhausted');
      return { contextLimit: false, assistantText: '<INIT_STATUS>READY</INIT_STATUS>' };
    },
    async deleteTaskProject() { return { ok: true }; },
    async runRound({ hooks = {} }) {
      await hooks.onPromptSent?.();
      await hooks.onResponseReady?.('<TASK_STATUS>DONE</TASK_STATUS>');
      return { contextLimit: false, assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] };
    }
  };

  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();

  assert.equal(result.status, 'completed');
  assert.deepEqual(created, ['vetatool2026082117', 'vetatool2026082117-r1']);
});


test('Project instructions setup failure recovers the same created Project before any replacement workspace is consumed', async () => {
  const task = {
    task_id: 't-project-settings-recovery', project_id: 'vetatool', task_prompt: 'fix',
    resource: { url: 'https://assets.example.com/source.zip' },
    browser_execution_bootstrap: {
      recovery_policy: { version: 1, rules: [{ id: 'gpt-response-stalled', signal: 'GPT_RESPONSE_STALLED', observation_timeout_seconds: 60, actions: [] }] }
    }
  };
  const api = new MockTaskApi([task]);
  const calls = [];
  let configureAttempts = 0;
  const page = {
    async createTaskProject({ preferredProjectName = null }) {
      const projectName = preferredProjectName ?? 'vetatool2026082200';
      calls.push(`create:${projectName}`);
      return { projectName, sessionId: 's1' };
    },
    async configureTaskProject({ state }) {
      configureAttempts += 1;
      calls.push(`configure:${configureAttempts}:${state.task_project.project_name}`);
      if (configureAttempts <= 2) throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Project settings save completion did not appear before timeout');
      return { saved: true };
    },
    async initializeTask() { calls.push('initialize'); return { contextLimit: false, assistantText: '<INIT_STATUS>READY</INIT_STATUS>' }; },
    async reloadPage() { calls.push('reload'); return { id: 7 }; },
    async prepareExistingTask({ chatgpt_project_name }) { calls.push(`prepare:${chatgpt_project_name}`); return {}; },
    async reopenWorkspace({ state }) { calls.push(`reopen:${state.task_project.project_name}`); return {}; },
    async deleteTaskProject({ project }) { calls.push(`delete:${project.project_name}`); return { ok: true }; },
    async runRound({ hooks = {} }) {
      await hooks.onPromptSent?.();
      await hooks.onResponseReady?.('<TASK_STATUS>DONE</TASK_STATUS>');
      return { contextLimit: false, assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] };
    }
  };

  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls.filter(value => value.startsWith('create:')), ['create:vetatool2026082200']);
  assert.deepEqual(calls.filter(value => value.startsWith('configure:')), [
    'configure:1:vetatool2026082200',
    'configure:2:vetatool2026082200',
    'configure:3:vetatool2026082200'
  ]);
  assert.ok(calls.includes('reload'));
  assert.ok(calls.includes('reopen:vetatool2026082200'));
  assert.equal(result.state.workspace_retry_count, 0);
});

test('initialization composer stall recovers the same Project with reload and reopen before consuming a workspace retry', async () => {
  const task = {
    task_id: 't-init-local-recovery', project_id: 'vetatool', task_prompt: 'fix',
    resource: { url: 'https://assets.example.com/source.zip' },
    browser_execution_bootstrap: {
      recovery_policy: { version: 1, rules: [{ id: 'gpt-response-stalled', signal: 'GPT_RESPONSE_STALLED', observation_timeout_seconds: 60, actions: [] }] }
    }
  };
  const api = new MockTaskApi([task]);
  const calls = [];
  let attempts = 0;
  const page = {
    async createTaskProject({ preferredProjectName = null }) {
      const projectName = preferredProjectName ?? 'vetatool2026082117';
      calls.push(`create:${projectName}`);
      return { projectName, sessionId: 's1' };
    },
    async initializeTask() {
      attempts += 1;
      calls.push(`initialize:${attempts}`);
      if (attempts <= 2) throw new RunnerError(ERROR_CODES.COMPOSER_STALLED, 'send stayed disabled');
      return { contextLimit: false, assistantText: '<INIT_STATUS>READY</INIT_STATUS>' };
    },
    async reloadPage() { calls.push('reload'); return { id: 7 }; },
    async prepareExistingTask({ chatgpt_project_name }) { calls.push(`prepare:${chatgpt_project_name}`); return {}; },
    async reopenWorkspace({ state }) { calls.push(`reopen:${state.task_project.project_name}`); return {}; },
    async deleteTaskProject({ project }) { calls.push(`delete:${project.project_name}`); return { ok: true }; },
    async runRound({ hooks = {} }) {
      await hooks.onPromptSent?.();
      await hooks.onResponseReady?.('<TASK_STATUS>DONE</TASK_STATUS>');
      return { contextLimit: false, assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] };
    }
  };

  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls.filter(value => value.startsWith('create:')), ['create:vetatool2026082117']);
  assert.ok(calls.includes('reload'));
  assert.ok(calls.includes('prepare:vetatool2026082117'));
  assert.ok(calls.includes('reopen:vetatool2026082117'));
  assert.equal(result.state.workspace_retry_count, 0);
});

test('a failed same-Project reload does not terminate the Task before reopen or workspace retry can run', async () => {
  const task = {
    task_id: 't-init-reload-fails', project_id: 'vetatool', task_prompt: 'fix',
    resource: { url: 'https://assets.example.com/source.zip' },
    browser_execution_bootstrap: {
      recovery_policy: { version: 1, rules: [{ id: 'gpt-response-stalled', signal: 'GPT_RESPONSE_STALLED', observation_timeout_seconds: 60, actions: [] }] }
    }
  };
  const api = new MockTaskApi([task]);
  let attempts = 0;
  const calls = [];
  const page = {
    async createTaskProject({ preferredProjectName = null }) {
      const projectName = preferredProjectName ?? 'vetatool2026082118';
      calls.push(`create:${projectName}`);
      return { projectName, sessionId: 's1' };
    },
    async initializeTask() {
      attempts += 1;
      if (attempts <= 2) throw new RunnerError(ERROR_CODES.COMPOSER_STALLED, 'composer stalled');
      return { contextLimit: false, assistantText: '<INIT_STATUS>READY</INIT_STATUS>' };
    },
    async reloadPage() { calls.push('reload'); throw new Error('tab reload transient failure'); },
    async prepareExistingTask() { calls.push('prepare'); return {}; },
    async reopenWorkspace() { calls.push('reopen'); return {}; },
    async deleteTaskProject({ project }) { calls.push(`delete:${project.project_name}`); return { ok: true }; },
    async runRound({ hooks = {} }) {
      await hooks.onPromptSent?.();
      await hooks.onResponseReady?.('<TASK_STATUS>DONE</TASK_STATUS>');
      return { contextLimit: false, assistantText: '<TASK_STATUS>DONE</TASK_STATUS>', patches: [] };
    }
  };

  const result = await new TaskRunner({ taskApi: api, taskStore: memoryStore(), page, processPatch: durablePatch }).runOnce();

  assert.equal(result.status, 'completed');
  assert.ok(calls.includes('reload'));
  assert.ok(calls.includes('reopen'));
  assert.deepEqual(calls.filter(value => value.startsWith('create:')), ['create:vetatool2026082118']);
});

test('WAIT_EXTERNAL recovers a lost local Patch target from the authoritative Patch Session and finalizes the existing Task', async () => {
  const order = [];
  const store = memoryStore();
  const state = controlledRecoveryTask('wait-session-reconcile', 'WAITING_EXTERNAL', externalPolicy);
  state.patch_session_id = 'ps-20260821-recover';
  state.session_id = 'ps-20260821-recover';
  state.patch_status_target = null;
  state.task_patch_count = 0;
  state.external_wait = {
    started_at: '2026-08-21T10:00:00.000Z', last_checked_at: null, next_check_at: '2026-08-21T10:02:00.000Z',
    summary: 'Patch identity was lost during disconnect', resync_count: 0, last_resync_at: null, escalated_at: null
  };
  await store.save(state);
  const api = recoveryApi(order, { refreshedLease: { token: 'lease-new', ttl_ms: 900000, assignment_id: 'a1', execution_id: 'e1', agent_id: 'agent-1' } });
  const filename = 'vetatool--ps-20260821-recover--001-recovered.patch';
  api.reconcilePatchSession = async (taskId, sessionId) => {
    order.push(`reconcile:${taskId}:${sessionId}`);
    return {
      reconciliation: {
        patch_session_id: sessionId,
        created_links: 1,
        bridged_patches: 1,
        discovered_patches: [{ project_id: 'vetatool', session_id: sessionId, sequence: 1, patch_filename: filename, status: 'success', is_terminal: true, terminal_kind: 'success', next_action: 'next_sequence' }]
      },
      acceptance: exactPatchPreview(filename, { directive: 'READY_TO_FINALIZE', status: 'success', isTerminal: true, terminalKind: 'success', nextAction: 'next_sequence', successful: 1, pending: 0 })
    };
  };
  api.completionCheckTask = async () => { throw new Error('reconcile result should be sufficient'); };
  const page = { async deleteTaskProject({ project }) { order.push(`delete:${project.project_name}`); return { ok: true }; } };

  const result = await new TaskRunner({
    taskApi: api,
    taskStore: store,
    page,
    processPatch: durablePatch,
    now: () => new Date('2026-08-21T10:02:00.000Z')
  }).recoverOnce();

  assert.equal(result.status, 'completed');
  assert.equal(result.state.task_patch_count, 1);
  assert.ok(order.includes('reconcile:wait-session-reconcile:ps-20260821-recover'));
  assert.ok(order.includes('delete:owned-project'));
  assert.equal((await store.load()), null);
});
