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

test('runtime controller checks for a server-claimed Task when no durable active execution exists', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real' });
  let created = 0;
  let resumeCalls = 0;
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => {
      created += 1;
      return {
        async resumeCurrentOnce() {
          resumeCalls += 1;
          return { status: 'no_recovery', state: null };
        }
      };
    }
  });
  const result = await controller.recoverRealIfNeeded();
  assert.deepEqual(result, { status: 'no_recovery', state: null });
  assert.equal(created, 1);
  assert.equal(resumeCalls, 1);
});

test('runtime controller automatically resumes a server-claimed Task that has no local activeExecution', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real' });
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => ({
      async resumeCurrentOnce() {
        return { status: 'running', state: { task_id: 'task-half-claimed', phase: 'RUNNING' } };
      }
    })
  });

  const result = await controller.recoverRealIfNeeded();

  assert.equal(result.status, 'running');
  assert.equal(result.state.task_id, 'task-half-claimed');
  assert.equal((await store.get('lastRecovery')).state.task_id, 'task-half-claimed');
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

test('runtime controller loads UI compatibility telemetry into privacy-safe status', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real' });
  await store.set('uiCompatibilityTelemetry', {
    version: 1,
    total_events: 3,
    buckets: [{ controls: ['secret'] }],
    last_event: {
      selector_profile: { id: 'chatgpt-semantic-v1', version: 1 },
      operation: 'CHATGPT_DELETE_PROJECT',
      error_code: 'UI_SELECTOR_INCOMPATIBLE',
      access_status: 'READY',
      page_category: 'chat',
      at: '2026-08-13T19:31:00.000Z'
    }
  });
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => { throw new Error('not used'); }
  });
  const status = await controller.getStatus();
  assert.equal(status.ui_compatibility.total_events, 3);
  assert.equal(status.ui_compatibility.last_event.operation, 'CHATGPT_DELETE_PROJECT');
  assert.equal(JSON.stringify(status).includes('secret'), false);
});

test('runtime controller executes real-run preflight guard under runner lock before creating runner', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real', patchTransferMode: 'remote', remoteE2eTestMode: true });
  const order = [];
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    prepareRealRun: async settings => {
      order.push(`prepare:${settings.patchTransferMode}`);
      assert.equal((await controller.getStatus()).running, true);
    },
    createRealRunner: async () => {
      order.push('create');
      return { runOnce: async () => { order.push('run'); return { status: 'completed' }; } };
    }
  });

  await controller.runReal();
  assert.deepEqual(order, ['prepare:remote', 'create', 'run']);
});

test('runtime controller blocked real-run preflight never creates the real runner', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real', patchTransferMode: 'remote', remoteE2eTestMode: true });
  let created = 0;
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    prepareRealRun: async () => {
      const error = new Error('remote preflight blocked');
      error.code = 'REMOTE_E2E_PREFLIGHT_BLOCKED';
      throw error;
    },
    createRealRunner: async () => {
      created += 1;
      return { runOnce: async () => ({ status: 'completed' }) };
    }
  });

  await assert.rejects(controller.runReal(), error => {
    assert.equal(error.code, 'REMOTE_E2E_PREFLIGHT_BLOCKED');
    return true;
  });
  assert.equal(created, 0);
  assert.equal((await controller.getStatus()).running, false);
});

test('runtime controller schedules durable waiting recovery and cancels it after terminal completion', async () => {
  const store = storage();
  const scheduled = [];
  let cancelled = 0;
  const results = [
    { status: 'waiting_external', state: { task_id: 'task-1', phase: 'WAITING_EXTERNAL', next_recovery_at: '2026-08-17T10:02:00.000Z' } },
    { status: 'completed', state: { task_id: 'task-1', phase: 'COMPLETED' } }
  ];
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => ({ async recoverOnce() { return results.shift(); } }),
    scheduleRecoveryAt(at) { scheduled.push(at); },
    cancelRecovery() { cancelled += 1; }
  });

  await controller.recoverReal();
  assert.deepEqual(scheduled, ['2026-08-17T10:02:00.000Z']);
  await controller.recoverReal();
  assert.equal(cancelled, 1);
});

test('runtime controller persists RunnerError fields and strips sensitive execution state from lastRun', async () => {
  const store = storage();
  const error = new Error('Project create receiver missing');
  error.name = 'RunnerError';
  error.code = 'PROJECT_CREATE_FAILED';
  error.details = { stage: 'project_create', access_token: 'secret-capability', status: 500, cause: 'secret-cause-must-not-leak' };
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [{ task_id: 'safe-error' }],
    createMockRunner: () => ({
      async runOnce() {
        return {
          status: 'released',
          error,
          state: {
            task_id: 'task-safe-error',
            project_id: 'browserplguin',
            assignment_id: 'assignment-safe',
            execution_id: 'execution-safe',
            phase: 'PREPARING_SOURCE',
            lease_token: 'lease-secret',
            browser_execution_bootstrap: { patchsync: { access_token: 'cap-secret' } },
            source_preparation: { status: 'succeeded', export_id: 'exp-safe', patch_session_id: 'ps-safe', source: { download_url: 'secret-url' } }
          }
        };
      }
    }),
    createRealRunner: async () => { throw new Error('not used'); }
  });

  const result = await controller.runMock('safe-error');
  assert.equal(result.error.code, 'PROJECT_CREATE_FAILED');
  assert.equal(result.error.message, 'Project create receiver missing');
  assert.equal(result.error.details.stage, 'project_create');
  assert.equal(result.state.source_preparation.export_id, 'exp-safe');
  const serialized = JSON.stringify(await store.get('lastRun'));
  assert.equal(serialized.includes('lease-secret'), false);
  assert.equal(serialized.includes('cap-secret'), false);
  assert.equal(serialized.includes('secret-capability'), false);
  assert.equal(serialized.includes('secret-url'), false);
  assert.equal(serialized.includes('secret-cause-must-not-leak'), false);
});

test('runtime controller manual pause persists, cancels recovery, and blocks automatic durable recovery', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real' });
  await store.set('activeExecution', { task_id: 'task-paused', phase: 'CLEANUP', next_recovery_at: '2026-08-20T03:00:00.000Z' });
  let created = 0;
  let cancelled = 0;
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => { created += 1; return { recoverOnce: async () => ({ status: 'cleanup_pending' }) }; },
    cancelRecovery: async () => { cancelled += 1; }
  });

  const paused = await controller.pause();
  assert.deepEqual(paused, { status: 'paused' });
  assert.equal(cancelled, 1);
  assert.equal((await controller.getStatus()).paused, true);

  const recovery = await controller.recoverRealIfNeeded();
  assert.deepEqual(recovery, { status: 'no_recovery_needed', reason: 'manual_paused' });
  assert.equal(created, 0);
});

test('runtime controller blocks new real runs while manually paused', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real' });
  await store.set('manualPaused', true);
  let created = 0;
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => { created += 1; return { runOnce: async () => ({ status: 'completed' }) }; }
  });

  await assert.rejects(controller.runReal(), error => {
    assert.equal(error.code, 'MANUAL_PAUSED');
    return true;
  });
  assert.equal(created, 0);
});

test('runtime controller resume clears pause and immediately recovers the preserved active execution', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real' });
  await store.set('manualPaused', true);
  await store.set('activeExecution', { task_id: 'task-resume', phase: 'CLEANUP' });
  let recoverCalls = 0;
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => ({
      async recoverOnce() {
        recoverCalls += 1;
        return { status: 'cleanup_pending', state: { task_id: 'task-resume', phase: 'CLEANUP' } };
      }
    })
  });

  const result = await controller.resume();
  assert.equal(result.status, 'resumed');
  assert.equal(result.recovery.status, 'cleanup_pending');
  assert.equal(recoverCalls, 1);
  assert.equal((await controller.getStatus()).paused, false);
});

test('runtime controller does not re-schedule recovery when pause is requested during an in-flight run', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const scheduled = [];
  let cancelled = 0;
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => ({
      async recoverOnce() {
        await gate;
        return { status: 'cleanup_pending', state: { task_id: 'task-live', phase: 'CLEANUP', next_recovery_at: '2026-08-20T03:00:00.000Z' } };
      }
    }),
    scheduleRecoveryAt: async at => { scheduled.push(at); },
    cancelRecovery: async () => { cancelled += 1; }
  });

  const recovery = controller.recoverReal();
  await new Promise(resolve => setImmediate(resolve));
  await controller.pause();
  release();
  await recovery;

  assert.ok(cancelled >= 1);
  assert.deepEqual(scheduled, []);
  assert.equal((await controller.getStatus()).paused, true);
});

test('runtime controller terminates the active Task server-side, clears durable execution, and returns idle', async () => {
  const store = storage();
  store.remove = async key => { await store.set(key, undefined); };
  await store.set('settings', { mode: 'real', agentId: 'ewan-macbook' });
  await store.set('manualPaused', true);
  await store.set('activeExecution', {
    task_id: 'task-old', project_id: 'browserplguin', phase: 'RUNNING',
    task_project: { project_name: 'browserplguin2026082015', status: 'active' }
  });
  let terminationInput = null;
  let cancelledRecovery = 0;
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => { throw new Error('not used'); },
    terminateRealTask: async input => {
      terminationInput = structuredClone(input);
      return { server_status: 'cancelled', cleanup_status: 'completed' };
    },
    cancelRecovery: async () => { cancelledRecovery += 1; }
  });

  const result = await controller.terminateTask();

  assert.equal(result.status, 'terminated');
  assert.equal(result.taskId, 'task-old');
  assert.equal(result.cleanup_status, 'completed');
  assert.equal(terminationInput.activeExecution.task_id, 'task-old');
  assert.equal((await controller.getStatus()).activeExecution, null);
  assert.equal((await controller.getStatus()).paused, false);
  assert.equal((await controller.getStatus()).lastRun.status, 'terminated');
  assert.ok(cancelledRecovery >= 1);
});

test('runtime controller keeps the active Task paused when server-side termination fails', async () => {
  const store = storage();
  store.remove = async key => { await store.set(key, undefined); };
  await store.set('settings', { mode: 'real' });
  await store.set('activeExecution', { task_id: 'task-old', phase: 'RUNNING' });
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => { throw new Error('not used'); },
    terminateRealTask: async () => { const error = new Error('cancel rejected'); error.code = 'TASK_CANCEL_FAILED'; throw error; },
    cancelRecovery: async () => {}
  });

  await assert.rejects(controller.terminateTask(), /cancel rejected/);
  assert.equal((await controller.getStatus()).activeExecution.task_id, 'task-old');
  assert.equal((await controller.getStatus()).paused, true);
});

test('runtime controller ignores a late in-flight result after that Task has been explicitly terminated', async () => {
  const store = storage();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [{ task_id: 'task-old' }],
    createMockRunner: () => ({
      async runOnce() {
        await gate;
        return { status: 'failed', state: { task_id: 'task-old', phase: 'RUNNING', next_recovery_at: '2026-08-20T16:00:00.000Z' } };
      }
    }),
    createRealRunner: async () => { throw new Error('not used'); },
    cancelRecovery: async () => {}
  });

  const running = controller.runMock('task-old');
  await store.set('lastRun', { status: 'terminated', taskId: 'task-old' });
  await store.set('terminatedTaskIds', ['task-old']);
  release();
  const result = await running;

  assert.deepEqual(result, { status: 'terminated', taskId: 'task-old' });
  assert.deepEqual(await store.get('lastRun'), { status: 'terminated', taskId: 'task-old' });
});

test('terminating an in-flight real Task aborts the old run and releases the runner lock before the stale promise settles', async () => {
  const store = storage();
  store.remove = async key => { await store.set(key, undefined); };
  await store.set('settings', { mode: 'real', agentId: 'ewan-macbook' });
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  let firstSignal = null;
  let created = 0;
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async (_settings, context = {}) => {
      created += 1;
      if (created === 1) {
        firstSignal = context.signal ?? null;
        return {
          async runOnce() {
            await firstGate;
            return { status: 'failed', state: { task_id: 'task-old', phase: 'RUNNING' } };
          }
        };
      }
      return { async runOnce() { return { status: 'idle', state: null }; } };
    },
    terminateRealTask: async () => ({ server_status: 'cancelled', cleanup_status: 'completed' }),
    cancelRecovery: async () => {}
  });

  const firstRun = controller.runReal();
  await new Promise(resolve => setImmediate(resolve));
  await store.set('activeExecution', { task_id: 'task-old', project_id: 'browserplguin', phase: 'RUNNING' });
  const terminated = await controller.terminateTask();
  const statusImmediatelyAfterTerminate = await controller.getStatus();
  let secondError = null;
  let secondResult = null;
  try { secondResult = await controller.runReal(); } catch (error) { secondError = error; }

  releaseFirst();
  await firstRun;

  assert.equal(terminated.status, 'terminated');
  assert.equal(firstSignal?.aborted, true);
  assert.equal(statusImmediatelyAfterTerminate.running, false);
  assert.equal(secondError, null);
  assert.equal(secondResult?.status, 'idle');
  assert.equal((await controller.getStatus()).lastRun.status, 'idle');
});

test('completed PatchSync run keeps reconciled Patch evidence and effective transfer mode in the idle popup status', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real', patchTransferMode: 'local' });
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [{ task_id: 'patchsync-completed' }],
    createMockRunner: () => ({
      async runOnce() {
        return {
          status: 'completed',
          state: {
            task_id: 'task-patchsync-completed',
            assignment_id: 'assignment-patchsync-completed',
            execution_id: 'execution-patchsync-completed',
            phase: 'COMPLETED',
            browser_execution_bootstrap: { patchsync: { base_url: 'https://patchsync.example', access_token: 'secret-cap' } },
            source_preparation: { status: 'succeeded', export_id: 'exp-1', patch_session_id: 'ps-1' },
            chatgpt_project_name: 'vetatool20260821',
            initialization_completed: true,
            task_patch_count: 0,
            completion_preview: { counts: { successful_patches: 1 } },
            business_completed: true
          }
        };
      }
    }),
    createRealRunner: async () => { throw new Error('not used'); }
  });

  await controller.runMock('patchsync-completed');
  const status = await controller.getStatus();

  assert.equal(status.settings.patch_transfer_mode, 'patchsync');
  assert.equal(status.lastRun.trace.find(item => item.id === 'patch').status, 'passed');
  assert.equal(status.lastRun.trace.find(item => item.id === 'completion').status, 'passed');
  assert.equal(JSON.stringify(status).includes('secret-cap'), false);
});

test('runtime controller auto runner claims real work only when explicitly enabled and idle', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real' });
  let runCalls = 0;
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => ({
      async runOnce() {
        runCalls += 1;
        return { status: 'completed', state: { task_id: 'task-auto', phase: 'COMPLETED' } };
      }
    })
  });

  assert.deepEqual(await controller.runAutoOnce(), { status: 'auto_run_disabled' });
  assert.equal(runCalls, 0);

  await controller.setAutoRunEnabled(true);
  const result = await controller.runAutoOnce();
  assert.equal(result.status, 'completed');
  assert.equal(runCalls, 1);
  assert.equal((await controller.getStatus()).auto_run_enabled, true);
});

test('enabling Auto Runner resumes a previously paused idle runner while later manual pauses still block claims', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real' });
  await store.set('manualPaused', true);
  let runCalls = 0;
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => ({
      async runOnce() {
        runCalls += 1;
        return { status: 'completed', state: { task_id: 'task-auto-resume', phase: 'COMPLETED' } };
      }
    })
  });

  const enabled = await controller.setAutoRunEnabled(true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.resumed, true);
  assert.equal((await controller.getStatus()).paused, false);

  const result = await controller.runAutoOnce();
  assert.equal(result.status, 'completed');
  assert.equal(runCalls, 1);

  await controller.pause();
  assert.equal((await controller.getStatus()).paused, true);
  assert.deepEqual(await controller.runAutoOnce(), { status: 'auto_run_paused' });
  assert.equal(runCalls, 1);
});

test('runtime controller auto runner never claims while paused, busy, or a durable execution exists', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real' });
  await store.set('autoRunEnabled', true);
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

  await store.set('manualPaused', true);
  assert.deepEqual(await controller.runAutoOnce(), { status: 'auto_run_paused' });
  await store.set('manualPaused', false);
  await store.set('activeExecution', { task_id: 'task-waiting', phase: 'WAITING_EXTERNAL' });
  assert.deepEqual(await controller.runAutoOnce(), { status: 'auto_run_active_execution', taskId: 'task-waiting' });
  assert.equal(created, 0);
});


test('runtime controller archives a control-confirmed lease-lost workspace before freeing the active execution slot', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real' });
  await store.set('activeExecution', { task_id: 'task-lease-lost', phase: 'RUNNING' });
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => ({
      async recoverOnce() {
        return {
          status: 'lease_lost',
          state: {
            task_id: 'task-lease-lost', project_id: 'vetatool', assignment_id: 'a-old', execution_id: 'e-old',
            phase: 'LEASE_LOST', patch_session_id: 'ps-old', chatgpt_project_name: 'vetatool-old',
            task_project: { project_name: 'vetatool-old', session_id: 'ps-old', status: 'active' },
            patch_status_target: { filename: 'vetatool--ps-old--001-fix.patch', session_id: 'ps-old', sequence: 1 },
            lease_loss: { at: '2026-08-22T01:00:00.000Z', code: 'assignment_lease_inactive', message: 'inactive', control_state: 'detached' }
          }
        };
      }
    })
  });

  const result = await controller.recoverReal();
  assert.equal(result.status, 'lease_lost');
  assert.equal((await controller.getStatus()).activeExecution, null);
  const archived = await store.get('leaseLostExecutions');
  assert.equal(archived.length, 1);
  assert.equal(archived[0].task_id, 'task-lease-lost');
  assert.equal(archived[0].project_name, 'vetatool-old');
  assert.equal(archived[0].patch_filename, 'vetatool--ps-old--001-fix.patch');
});

test('runtime controller keeps a pending lease-loss execution active so auto runner cannot claim another Task', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real' });
  await store.set('autoRunEnabled', true);
  await store.set('activeExecution', { task_id: 'task-lease-wait', phase: 'LEASE_LOST' });
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => ({
      async recoverOnce() {
        return {
          status: 'lease_lost',
          state: {
            task_id: 'task-lease-wait', phase: 'LEASE_LOST', next_recovery_at: '2026-08-22T01:01:00.000Z',
            lease_loss: { code: 'assignment_lease_inactive', control_state: 'pending' }
          }
        };
      }
    })
  });

  await controller.recoverReal();
  assert.equal((await controller.getStatus()).activeExecution.task_id, 'task-lease-wait');
  assert.deepEqual(await controller.runAutoOnce(), { status: 'auto_run_active_execution', taskId: 'task-lease-wait' });
});

test('terminal recovery promotes completed result to Last Run instead of leaving stale waiting_external', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real' });
  await store.set('lastRun', { status: 'waiting_external', taskId: 'task-final' });
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => ({
      async recoverOnce() {
        return { status: 'completed', state: { task_id: 'task-final', phase: 'COMPLETED', business_completed: true } };
      }
    })
  });

  await controller.recoverReal();
  const status = await controller.getStatus();
  assert.equal(status.lastRun.status, 'completed');
  assert.equal(status.lastRun.taskId, 'task-final');
  assert.equal(status.lastRecovery.status, 'completed');
});

test('auto runner idle poll preserves the most recent completed Last Run', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real' });
  await store.set('autoRunEnabled', true);
  await store.set('lastRun', { status: 'completed', taskId: 'task-previous' });
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => ({ async runOnce() { return { status: 'idle', state: null }; } })
  });

  const result = await controller.runAutoOnce();
  assert.equal(result.status, 'idle');
  const status = await controller.getStatus();
  assert.equal(status.lastRun.status, 'completed');
  assert.equal(status.lastRun.taskId, 'task-previous');
});

test('status immediately reconciles an existing stale waiting_external Last Run from a completed Last Recovery', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real' });
  await store.set('lastRun', { status: 'waiting_external', taskId: 'task-upgrade' });
  await store.set('lastRecovery', { status: 'completed', taskId: 'task-upgrade', state: { task_id: 'task-upgrade', phase: 'COMPLETED' } });
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => { throw new Error('not used'); }
  });

  const status = await controller.getStatus();
  assert.equal(status.lastRun.status, 'completed');
  assert.equal(status.lastRun.taskId, 'task-upgrade');
});

test('runtime controller interrupts an in-flight run before starting durable recovery', async () => {
  const store = storage();
  await store.set('settings', { mode: 'real' });
  const events = [];
  let createCount = 0;
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async (_settings, { signal } = {}) => {
      createCount += 1;
      if (createCount === 1) {
        return {
          async runOnce() {
            await store.set('activeExecution', { task_id: 'task-a', phase: 'RUNNING' });
            events.push('run-started');
            await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
            events.push('run-aborted');
            return { status: 'terminated', taskId: 'task-a' };
          }
        };
      }
      return {
        async recoverOnce() {
          events.push('recovery-started');
          return { status: 'waiting_external', state: await store.get('activeExecution') };
        }
      };
    }
  });

  const activeRun = controller.runReal();
  await new Promise(resolve => setTimeout(resolve, 0));
  const recovery = await controller.interruptAndRecover({ type: 'worker_tab_lost', tabId: 17 });
  await activeRun;

  assert.equal(recovery.status, 'waiting_external');
  assert.deepEqual(events, ['run-started', 'run-aborted', 'recovery-started']);
  assert.equal(controller.running, false);
});

test('slot-scoped termination can abort one Task without toggling the shared manual pause flag', async () => {
  const store = storage();
  store.remove = async key => { await store.set(key, undefined); };
  await store.set('settings', { mode: 'real' });
  await store.set('manualPaused', false);
  await store.set('activeExecution', { task_id: 'task-slot-2', phase: 'RUNNING' });
  let pausedDuringTermination = null;
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [],
    createMockRunner: () => { throw new Error('not used'); },
    createRealRunner: async () => { throw new Error('not used'); },
    terminateRealTask: async () => {
      pausedDuringTermination = await store.get('manualPaused');
      return { server_status: 'cancelled', cleanup_status: 'completed' };
    },
    cancelRecovery: async () => {},
    terminationPausesSharedRunner: false
  });

  const result = await controller.terminateTask();

  assert.equal(result.status, 'terminated');
  assert.equal(pausedDuringTermination, false);
  assert.equal(await store.get('manualPaused'), false);
});

test('runtime controller keeps only safe structured PatchSync diagnostics in completed results', async () => {
  const store = storage();
  const error = new Error('PatchSync request returned HTTP 503');
  error.name = 'RunnerError';
  error.code = 'PATCHSYNC_HTTP_ERROR';
  error.details = {
    origin: 'http://127.0.0.1:8790', operation: 'export_status', export_id: 'exp-safe', status: 503,
    server_reason: 'temporarily unavailable', access_token: 'secret-capability', authorization: 'PatchSync secret-capability'
  };
  const controller = new RuntimeController({
    storage: store,
    loadMockTasks: async () => [{ task_id: 'patchsync-error' }],
    createMockRunner: () => ({ async runOnce() { return { status: 'released', taskId: 'patchsync-error', error }; } }),
    createRealRunner: async () => { throw new Error('not used'); }
  });

  await controller.runMock('patchsync-error');
  const lastRun = await store.get('lastRun');
  assert.deepEqual(lastRun.error.details, {
    origin: 'http://127.0.0.1:8790', operation: 'export_status', export_id: 'exp-safe', status: 503,
    server_reason: 'temporarily unavailable'
  });
  assert.equal(JSON.stringify(lastRun).includes('secret-capability'), false);
  assert.equal(JSON.stringify(lastRun).includes('authorization'), false);
});
