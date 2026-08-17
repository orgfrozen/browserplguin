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

test('RUNNING recovery blocks resource task when initialization completion was never durably checkpointed', async () => {
  const order = [];
  const store = memoryStore();
  const state = recoveryState('recover-init-ambiguous');
  state.task_snapshot = { ...state.task_snapshot, resource: { url: 'https://assets.example.com/source.zip' }, initialization_prompt: 'analyze' };
  state.initialization_completed = false;
  state.in_flight_round = null;
  await store.save(state);
  const api = recoveryApi(order);
  const page = { async prepareExistingTask() { order.push('prepare'); }, async runRound() { order.push('round'); } };
  const result = await new TaskRunner({ taskApi: api, taskStore: store, page, processPatch: durablePatch }).recoverOnce();
  assert.equal(result.status, 'recovery_blocked');
  assert.equal(order.includes('round'), false);
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
  api.completionCheckTask = async () => ({ directive: 'READY_TO_FINALIZE', status: 'satisfied', summary: 'Ready' });
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
