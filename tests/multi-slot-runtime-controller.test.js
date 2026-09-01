import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiSlotRuntimeController, ADAPTIVE_BACKPRESSURE_HEALTHY_STEP_MS, ADAPTIVE_BACKPRESSURE_STEP_DOWN_COOLDOWN_MS, ADAPTIVE_BACKPRESSURE_WINDOW_MS } from '../src/background/multi-slot-runtime-controller.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
  return {
    async get(key) { return data.get(key); },
    async set(key, value) { data.set(key, structuredClone(value)); },
    async remove(key) { data.delete(key); }
  };
}

function makeStatusController({ slotId, storage, runReal, runAutoOnce, recoverRealIfNeeded, recoverReal, interruptAndRecover, terminateTask, detachDuplicateExecution, deferActiveRecovery }) {
  return {
    async getStatus() {
      return {
        running: false,
        paused: (await storage.get('manualPaused')) === true,
        auto_run_enabled: (await storage.get('autoRunEnabled')) === true,
        activeExecution: (await storage.get('activeExecution')) ?? null,
        activeTrace: [],
        lastRun: (await storage.get('lastRun')) ?? null,
        lastRecovery: (await storage.get('lastRecovery')) ?? null,
        settings: { mode: 'real' }
      };
    },
    runReal: runReal ?? (async () => ({ status: 'idle', state: null })),
    runAutoOnce: runAutoOnce ?? (async () => ({ status: 'idle', state: null })),
    recoverRealIfNeeded: recoverRealIfNeeded ?? (async () => ({ status: 'no_recovery', state: null })),
    recoverReal: recoverReal ?? (async () => ({ status: 'no_recovery', state: null })),
    interruptAndRecover: interruptAndRecover ?? (async () => ({ status: 'no_recovery', state: null })),
    async pause() { await storage.set('manualPaused', true); return { status: 'paused' }; },
    async resume() { await storage.set('manualPaused', false); return { status: 'resumed' }; },
    terminateTask: terminateTask ?? (async () => ({ status: 'no_active_task', slotId })),
    deferActiveRecovery: deferActiveRecovery ?? (async () => ({ status: 'unsupported' })),
    detachDuplicateExecution: detachDuplicateExecution ?? (async expected => {
      const active = await storage.get('activeExecution');
      if (active?.task_id === expected?.taskId && active?.assignment_id === expected?.assignmentId && active?.execution_id === expected?.executionId) {
        await storage.remove('activeExecution');
        return { status: 'duplicate_execution_detached', taskId: active.task_id };
      }
      return { status: 'duplicate_execution_detach_skipped' };
    })
  };
}

async function waitFor(predicate, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('condition not reached');
}

test('manual Run Real Once starts at most one new ChatGPT execution per launch window', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 3 } });
  const started = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runReal: async () => {
        started.push(slotId);
        const state = { task_id: `task-${slotId}`, project_id: `project-${slotId}`, phase: 'RUNNING' };
        await storage.set('activeExecution', state);
        return { status: 'active', state };
      }
    })
  });

  const result = await scheduler.runReal();

  assert.deepEqual(started, ['chatgpt-1']);
  assert.equal(result.results[0].status, 'active');
  assert.equal(result.results[1].status, 'launch_throttled');
  assert.equal(result.results[2].status, 'launch_throttled');
  assert.equal((await scheduler.getStatus()).active_task_count, 1);
});

test('manual scheduler stops probing empty capacity after a successful claim starts ChatGPT UI work', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 3 } });
  const available = ['task-only'];
  const claimAttempts = [];
  const createdTabs = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runReal: async () => {
        claimAttempts.push(slotId);
        const taskId = available.shift();
        if (!taskId) return { status: 'idle', state: null };
        createdTabs.push(slotId);
        const state = { task_id: taskId, phase: 'WAITING_EXTERNAL' };
        await storage.set('activeExecution', state);
        return { status: 'waiting_external', state };
      }
    })
  });

  await scheduler.runReal();

  assert.equal(claimAttempts.length, 1);
  assert.deepEqual(createdTabs, ['chatgpt-1']);
  assert.equal((await scheduler.getStatus()).active_task_count, 1);
});

test('auto scheduler defers replacement until a later tick after terminal completion', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 1 }, autoRunEnabled: true });
  let nowMs = Date.parse('2026-08-29T03:00:00.000Z');
  const outcomes = ['completed', 'waiting_external'];
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => {
        const status = outcomes.shift() ?? 'idle';
        calls.push(status);
        if (status === 'completed') {
          await storage.remove('activeExecution');
          return { status: 'completed', taskId: 'task-a' };
        }
        if (status === 'waiting_external') {
          const state = { task_id: 'task-b', phase: 'WAITING_EXTERNAL' };
          await storage.set('activeExecution', state);
          return { status, state };
        }
        return { status: 'idle', state: null };
      }
    })
  });

  const first = await scheduler.runAutoOnce();
  assert.deepEqual(calls, ['completed']);
  assert.equal(first.results[0].status, 'completed');
  assert.equal((await scheduler.getStatus()).active_task_count, 0);

  nowMs += 16_000;
  const second = await scheduler.runAutoOnce();
  assert.deepEqual(calls, ['completed', 'waiting_external']);
  assert.equal(second.results[0].status, 'waiting_external');
  assert.equal((await scheduler.getStatus()).activeExecution.task_id, 'task-b');
});

test('auto scheduler safely reconciles current work after three consecutive idle claim ticks', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 1 }, autoRunEnabled: true });
  let nowMs = Date.parse('2026-08-28T14:30:00.000Z');
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => { calls.push('next'); return { status: 'idle', state: null }; },
      recoverRealIfNeeded: async () => {
        calls.push('current');
        const state = { task_id: 'task-current', project_id: 'zeroparse', phase: 'PREPARING_SOURCE' };
        await storage.set('activeExecution', state);
        return { status: 'waiting_external', state };
      }
    })
  });

  await scheduler.runAutoOnce();
  nowMs += 30_000;
  await scheduler.runAutoOnce();
  assert.deepEqual(calls, ['next', 'next']);
  assert.equal((await scheduler.getStatus()).active_task_count, 0);

  nowMs += 30_000;
  await scheduler.runAutoOnce();

  assert.deepEqual(calls, ['next', 'next', 'next', 'current']);
  const status = await scheduler.getStatus();
  assert.equal(status.activeExecution?.task_id, 'task-current');
  assert.equal(status.scheduler_diagnostics.idle_claim_self_heal.last_result, 'recovered_current');
  assert.equal(status.scheduler_diagnostics.idle_claim_self_heal.last_recovered_task_id, 'task-current');
});

test('idle claim self-heal does not repeatedly reconcile a genuinely empty queue', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 1 }, autoRunEnabled: true });
  let nowMs = Date.parse('2026-08-28T15:00:00.000Z');
  let currentChecks = 0;
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => ({ status: 'idle', state: null }),
      recoverRealIfNeeded: async () => { currentChecks += 1; return { status: 'no_recovery', state: null }; }
    })
  });

  for (let tick = 0; tick < 3; tick += 1) {
    await scheduler.runAutoOnce();
    nowMs += 30_000;
  }
  assert.equal(currentChecks, 1);

  for (let tick = 0; tick < 4; tick += 1) {
    await scheduler.runAutoOnce();
    nowMs += 30_000;
  }
  assert.equal(currentChecks, 1);
});

test('idle claim self-heal never preempts a slot that already has durable recovery work', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 1 },
    autoRunEnabled: true,
    activeExecution: {
      task_id: 'task-recovery',
      phase: 'LEASE_LOST',
      next_recovery_at: '2026-08-28T16:05:00.000Z',
      lease_loss: { code: 'assignment_lease_inactive', control_state: 'still_assigned' }
    }
  });
  let currentChecks = 0;
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => ({ status: 'auto_run_active_execution', taskId: 'task-recovery' }),
      recoverRealIfNeeded: async () => { currentChecks += 1; return { status: 'unexpected_recovery' }; }
    })
  });

  await scheduler.runAutoOnce();
  await scheduler.runAutoOnce();
  await scheduler.runAutoOnce();

  assert.equal(currentChecks, 0);
  assert.equal((await scheduler.getStatus()).activeExecution?.task_id, 'task-recovery');
});

test('startup recovery restores only slots with durable execution state and does not resume current into another slot', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 3 },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-b', phase: 'RUNNING' } }
  });
  const recovered = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      recoverRealIfNeeded: async () => { recovered.push(slotId); return { status: 'recovered', taskId: (await storage.get('activeExecution'))?.task_id ?? null }; }
    })
  });

  const result = await scheduler.recoverRealIfNeeded();

  assert.deepEqual(recovered, ['chatgpt-2']);
  assert.equal(result.results[0].taskId, 'task-b');
});

test('startup recovery restores all durable slots before any replacement claim and defers refill behind launch pacing', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 3 },
    autoRunEnabled: true,
    activeExecution: { task_id: 'task-a', phase: 'RUNNING' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-b', phase: 'RUNNING' } }
  });
  let nowMs = Date.parse('2026-08-29T03:10:00.000Z');
  const events = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      recoverRealIfNeeded: async () => {
        events.push(`recover:${slotId}`);
        if (slotId === 'chatgpt-1') {
          await storage.remove('activeExecution');
          return { status: 'completed', taskId: 'task-a' };
        }
        return { status: 'waiting_external', state: await storage.get('activeExecution') };
      },
      runAutoOnce: async () => {
        events.push(`claim:${slotId}`);
        if (slotId === 'chatgpt-1') {
          const state = { task_id: 'task-c', phase: 'RUNNING' };
          await storage.set('activeExecution', state);
          return { status: 'waiting_external', state };
        }
        return { status: 'idle', state: null };
      }
    })
  });

  const recovered = await scheduler.recoverRealIfNeeded();
  assert.deepEqual(events, ['recover:chatgpt-1']);
  assert.equal(recovered.results.find(item => item.slotId === 'chatgpt-2').status, 'recovery_throttled');
  assert.equal(events.some(value => value.startsWith('claim:')), false);
  assert.equal(recovered.refill.some(item => item.status === 'launch_throttled' || item.status === 'slot_cooldown'), true);
  assert.equal((await scheduler.getStatus()).active_task_count, 1);

  nowMs += 5_000;
  await scheduler.recoverRealIfNeeded();
  assert.deepEqual(events.slice(0, 2), ['recover:chatgpt-1', 'recover:chatgpt-2']);

  nowMs += 11_000;
  await scheduler.runAutoOnce();
  assert.ok(events.indexOf('claim:chatgpt-1') > events.indexOf('recover:chatgpt-2'));
  assert.equal((await scheduler.getStatus()).active_task_count, 2);
});

test('startup recovery isolates one slot failure and restores the other durable slot on its staggered retry', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 2 },
    activeExecution: { task_id: 'task-a', phase: 'RUNNING' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-b', phase: 'RUNNING' } }
  });
  let nowMs = Date.parse('2026-08-29T09:30:00.000Z');
  const recovered = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      recoverRealIfNeeded: async () => {
        recovered.push(slotId);
        if (slotId === 'chatgpt-1') {
          const error = new Error('slot one recovery failed');
          error.code = 'RECOVERY_FAILED';
          throw error;
        }
        return { status: 'waiting_external', state: await storage.get('activeExecution') };
      }
    })
  });

  const first = await scheduler.recoverRealIfNeeded();
  assert.deepEqual(recovered, ['chatgpt-1']);
  assert.equal(first.results.find(item => item.slotId === 'chatgpt-1').status, 'recovery_failed');
  assert.equal(first.results.find(item => item.slotId === 'chatgpt-2').status, 'recovery_throttled');

  nowMs += 5_000;
  const second = await scheduler.recoverRealIfNeeded();
  assert.deepEqual(recovered, ['chatgpt-1', 'chatgpt-2']);
  assert.equal(second.results.find(item => item.slotId === 'chatgpt-1').status, 'recovery_throttled');
  assert.equal(second.results.find(item => item.slotId === 'chatgpt-2').status, 'waiting_external');
});

test('targeted termination affects only the requested slot and preserves shared runner state', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 2 },
    autoRunEnabled: true,
    manualPaused: false,
    activeExecution: { task_id: 'task-a', phase: 'RUNNING' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-b', phase: 'RUNNING' } }
  });
  const terminated = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      terminateTask: async () => {
        terminated.push(slotId);
        const current = await storage.get('activeExecution');
        await storage.remove('activeExecution');
        return { status: 'terminated', taskId: current?.task_id ?? null };
      }
    })
  });

  const result = await scheduler.terminateTask('chatgpt-2');

  assert.deepEqual(terminated, ['chatgpt-2']);
  assert.equal(result.slot_id, 'chatgpt-2');
  assert.equal(result.taskId, 'task-b');
  assert.equal((await scheduler.getStatus()).activeExecution.task_id, 'task-a');
  assert.equal(await shared.get('manualPaused'), false);
  assert.equal(await shared.get('autoRunEnabled'), true);
});

test('auto scheduler preserves a reusable idle slot tab inside configured capacity when no replacement Task is available', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 1 }, autoRunEnabled: true });
  const closed = [];
  const slotStore = {
    async load(slotId) { return { slot_id: slotId, tab_id: 17, task_id: null, generation: 3, status: 'idle', managed_tab: true }; }
  };
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore,
    closeIdleSlot: async slot => closed.push({ slot_id: slot.slot_id, tab_id: slot.tab_id }),
    createController: ({ slotId, storage }) => makeStatusController({ slotId, storage })
  });

  await scheduler.runAutoOnce();

  assert.deepEqual(closed, []);
});

test('orphan tab reconciliation closes only extension-managed idle tabs with no durable execution', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 1 },
    autoRunEnabled: true,
    'slotExecutionState:chatgpt-3': { activeExecution: { task_id: 'task-waiting', phase: 'WAITING_EXTERNAL' } }
  });
  const slots = new Map([
    ['chatgpt-2', { slot_id: 'chatgpt-2', tab_id: 18, task_id: null, generation: 2, status: 'idle', managed_tab: true }],
    ['chatgpt-3', { slot_id: 'chatgpt-3', tab_id: 19, task_id: null, generation: 4, status: 'idle', managed_tab: true }],
    ['chatgpt-4', { slot_id: 'chatgpt-4', tab_id: 20, task_id: null, generation: 1, status: 'idle' }]
  ]);
  const closed = [];
  const detached = [];
  const slotStore = {
    async list() { return [...slots.values()].map(slot => structuredClone(slot)); },
    async load(slotId) { return structuredClone(slots.get(slotId) ?? null); },
    async release({ slotId, tabId }) {
      const current = slots.get(slotId);
      const next = { ...current, tab_id: tabId, task_id: null, status: 'idle' };
      slots.set(slotId, next);
      detached.push({ slot_id: slotId, tab_id: tabId });
      return structuredClone(next);
    }
  };
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore,
    closeIdleSlot: async slot => { closed.push({ slot_id: slot.slot_id, tab_id: slot.tab_id }); await slotStore.release({ slotId: slot.slot_id, tabId: null }); },
    createController: ({ slotId, storage }) => makeStatusController({ slotId, storage })
  });

  const result = await scheduler.reconcileIdleTabs();

  assert.deepEqual(closed, [{ slot_id: 'chatgpt-2', tab_id: 18 }]);
  assert.deepEqual(detached, [
    { slot_id: 'chatgpt-2', tab_id: null },
    { slot_id: 'chatgpt-4', tab_id: null }
  ]);
  assert.equal(result.closed, 1);
  assert.equal(result.detached, 1);
  assert.equal(result.skipped_active, 1);
});

test('multi-slot page pressure never closes a managed tab that still has a durable active execution', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 5 },
    autoRunEnabled: true,
    activeExecution: { task_id: 'task-a', phase: 'RUNNING' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-b', phase: 'RUNNING' } }
  });
  const closed = [];
  const slots = [
    { slot_id: 'chatgpt-1', tab_id: 31, task_id: null, status: 'idle', managed_tab: true, last_progress_at: '2026-08-29T00:00:00.000Z', recovery_attempts: ['2026-08-29T00:01:00.000Z'] },
    { slot_id: 'chatgpt-2', tab_id: 32, task_id: null, status: 'idle', managed_tab: true, last_progress_at: '2026-08-29T00:00:00.000Z', recovery_attempts: ['2026-08-29T00:01:00.000Z'] }
  ];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore: { async list() { return structuredClone(slots); }, async load(slotId) { return structuredClone(slots.find(slot => slot.slot_id === slotId)); } },
    closeIdleSlot: async slot => { closed.push(slot.tab_id); },
    now: () => new Date('2026-08-29T00:02:00.000Z'),
    createController: ({ slotId, storage }) => makeStatusController({ slotId, storage })
  });

  await scheduler.runAutoOnce();

  assert.deepEqual(closed, []);
  const status = await scheduler.getStatus();
  assert.equal(status.active_task_count, 2);
});

test('auto scheduler reconciles managed orphan tabs outside the current effective capacity', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 1 }, autoRunEnabled: true });
  const closed = [];
  const slots = new Map([
    ['chatgpt-2', { slot_id: 'chatgpt-2', tab_id: 22, task_id: null, generation: 3, status: 'idle', managed_tab: true }]
  ]);
  const slotStore = {
    async list() { return [...slots.values()].map(slot => structuredClone(slot)); },
    async load(slotId) { return structuredClone(slots.get(slotId) ?? null); },
    async release({ slotId, tabId }) {
      const current = slots.get(slotId);
      const next = { ...current, tab_id: tabId, task_id: null, status: 'idle' };
      slots.set(slotId, next);
      return structuredClone(next);
    }
  };
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore,
    closeIdleSlot: async slot => { closed.push(slot.tab_id); await slotStore.release({ slotId: slot.slot_id, tabId: null }); },
    createController: ({ slotId, storage }) => makeStatusController({ slotId, storage })
  });

  await scheduler.runAutoOnce();

  assert.deepEqual(closed, [22]);
});

test('tab loss recovers only the owning assigned slot while idle tab removal is ignored', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 3 } });
  const interrupted = [];
  const slotsByTab = new Map([
    [17, { slot_id: 'chatgpt-1', tab_id: 17, task_id: null, generation: 2, status: 'idle' }],
    [22, { slot_id: 'chatgpt-2', tab_id: 22, task_id: 'task-b', generation: 4, status: 'assigned' }]
  ]);
  const slotStore = { async findByTabId(tabId) { return slotsByTab.get(tabId) ?? null; } };
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore,
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      interruptAndRecover: async reason => { interrupted.push({ slotId, reason }); return { status: 'waiting_external', taskId: 'task-b' }; }
    })
  });

  const idle = await scheduler.handleTabRemoved(17);
  const active = await scheduler.handleTabRemoved(22, 'discarded');

  assert.equal(idle.status, 'ignored');
  assert.equal(active.status, 'recovery_triggered');
  assert.equal(active.slot_id, 'chatgpt-2');
  assert.deepEqual(interrupted.map(item => item.slotId), ['chatgpt-2']);
  assert.equal(interrupted[0].reason.reason, 'discarded');
});

test('manual scheduler skips already-active slots and claims only idle capacity', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 2 },
    activeExecution: { task_id: 'task-a', phase: 'WAITING_EXTERNAL' }
  });
  const runCalls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runReal: async () => {
        runCalls.push(slotId);
        const state = { task_id: `new-${slotId}`, phase: 'WAITING_EXTERNAL' };
        await storage.set('activeExecution', state);
        return { status: 'waiting_external', state };
      }
    })
  });

  const result = await scheduler.runReal();

  assert.deepEqual(runCalls, ['chatgpt-2']);
  assert.equal(result.results[0].status, 'active');
  assert.equal(result.results[0].taskId, 'task-a');
  assert.equal(result.results[1].status, 'waiting_external');
});

test('terminal recovery releases the slot and waits before replacement refill', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 1 },
    autoRunEnabled: true,
    activeExecution: { task_id: 'task-a', phase: 'WAITING_EXTERNAL' }
  });
  let nowMs = Date.parse('2026-08-29T03:20:00.000Z');
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      recoverReal: async () => {
        calls.push('recover');
        await storage.remove('activeExecution');
        return { status: 'completed', taskId: 'task-a' };
      },
      runAutoOnce: async () => {
        calls.push('refill');
        const state = { task_id: 'task-b', phase: 'WAITING_EXTERNAL' };
        await storage.set('activeExecution', state);
        return { status: 'waiting_external', state };
      }
    })
  });

  await scheduler.recoverReal('chatgpt-1');
  assert.deepEqual(calls, ['recover']);
  assert.equal((await scheduler.getStatus()).active_task_count, 0);

  nowMs += 16_000;
  await scheduler.runAutoOnce();
  assert.deepEqual(calls, ['recover', 'refill']);
  assert.equal((await scheduler.getStatus()).activeExecution.task_id, 'task-b');
});

test('maxParallelTasks=5 reaches the supported slot ceiling without creating a sixth slot', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 5 } });
  const started = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runReal: async () => { started.push(slotId); return { status: 'idle', state: null }; }
    })
  });

  await scheduler.runReal();

  assert.deepEqual(started, ['chatgpt-1', 'chatgpt-2', 'chatgpt-3', 'chatgpt-4', 'chatgpt-5']);
});

test('slot watchdog recovers only stale page-driven slots and leaves waiting or fresh slots alone', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 3 },
    browserTabSlots: {
      'chatgpt-1': { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 1, status: 'assigned', last_progress_at: '2026-08-26T08:00:00.000Z' },
      'chatgpt-2': { slot_id: 'chatgpt-2', tab_id: 18, task_id: 'task-b', generation: 1, status: 'assigned', last_progress_at: '2026-08-26T08:00:00.000Z' },
      'chatgpt-3': { slot_id: 'chatgpt-3', tab_id: 19, task_id: 'task-c', generation: 1, status: 'assigned', last_progress_at: '2026-08-26T08:29:00.000Z' }
    },
    activeExecution: { task_id: 'task-a', phase: 'RUNNING' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-b', phase: 'WAITING_EXTERNAL' } },
    'slotExecutionState:chatgpt-3': { activeExecution: { task_id: 'task-c', phase: 'RUNNING' } }
  });
  const { BrowserTabSlotStore } = await import('../src/background/task-store.js');
  const recovered = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore: new BrowserTabSlotStore(shared),
    now: () => new Date('2026-08-26T08:30:00.000Z'),
    watchdogStallMs: 20 * 60 * 1000,
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      interruptAndRecover: async reason => { recovered.push([slotId, reason]); return { status: 'waiting_external', state: await storage.get('activeExecution') }; }
    })
  });

  const result = await scheduler.runWatchdogOnce();

  assert.deepEqual(recovered.map(([slotId]) => slotId), ['chatgpt-1']);
  assert.equal(result.checked, 3);
  assert.equal(result.recovered, 1);
  assert.equal(result.results[0].slot_id, 'chatgpt-1');
  assert.equal(result.results[0].reason, 'slot_progress_stalled');
  const slot1 = await scheduler.slotStore.load('chatgpt-1');
  assert.equal(slot1.recovery_count, 1);
  assert.equal(slot1.last_recovery_reason, 'slot_progress_stalled');
  assert.equal(slot1.last_progress_at, '2026-08-26T08:30:00.000Z');
});

test('slot watchdog is disabled while the shared runner is manually paused', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 1 },
    manualPaused: true,
    browserTabSlots: {
      'chatgpt-1': { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 1, status: 'assigned', last_progress_at: '2026-08-26T08:00:00.000Z' }
    },
    activeExecution: { task_id: 'task-a', phase: 'RUNNING' }
  });
  const { BrowserTabSlotStore } = await import('../src/background/task-store.js');
  let recoveries = 0;
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore: new BrowserTabSlotStore(shared),
    now: () => new Date('2026-08-26T09:00:00.000Z'),
    watchdogStallMs: 20 * 60 * 1000,
    createController: ({ slotId, storage }) => makeStatusController({ slotId, storage, interruptAndRecover: async () => { recoveries += 1; return { status: 'recovered' }; } })
  });

  assert.deepEqual(await scheduler.runWatchdogOnce(), { status: 'paused', checked: 0, recovered: 0, results: [] });
  assert.equal(recoveries, 0);
});

test('lowering max parallel Tasks keeps active slots above capacity running but does not refill them', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 5 },
    autoRunEnabled: true,
    activeExecution: { task_id: 'task-1', phase: 'RUNNING' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-2', phase: 'RUNNING' } },
    'slotExecutionState:chatgpt-3': { activeExecution: { task_id: 'task-3', phase: 'RUNNING' } },
    'slotExecutionState:chatgpt-4': { activeExecution: { task_id: 'task-4', phase: 'RUNNING' } },
    'slotExecutionState:chatgpt-5': { activeExecution: { task_id: 'task-5', phase: 'RUNNING' } }
  });
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => {
        calls.push(slotId);
        const current = await storage.get('activeExecution');
        if (slotId === 'chatgpt-3') {
          await storage.remove('activeExecution');
          return { status: 'completed', taskId: current?.task_id ?? null };
        }
        return { status: 'waiting_external', state: current };
      }
    })
  });

  const update = await scheduler.setMaxParallelTasks(2);
  assert.equal(update.max_parallel_tasks, 2);
  assert.equal((await shared.get('settings')).maxParallelTasks, 2);
  assert.equal((await scheduler.getStatus()).active_task_count, 5);

  await scheduler.runAutoOnce();

  assert.deepEqual(calls, ['chatgpt-1', 'chatgpt-2', 'chatgpt-3', 'chatgpt-4', 'chatgpt-5']);
  const status = await scheduler.getStatus();
  assert.equal(status.max_parallel_tasks, 2);
  assert.equal(status.active_task_count, 4);
  assert.equal(status.slots.some(slot => slot.slot_id === 'chatgpt-3' && slot.activeExecution), false);
});

test('drain mode keeps active Tasks progressing while preventing claims and terminal refills', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 2 },
    autoRunEnabled: true,
    activeExecution: { task_id: 'task-a', phase: 'RUNNING' }
  });
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => {
        calls.push(slotId);
        if ((await storage.get('activeExecution'))?.task_id) {
          await storage.remove('activeExecution');
          return { status: 'completed', taskId: 'task-a' };
        }
        const state = { task_id: `claimed-${slotId}`, phase: 'RUNNING' };
        await storage.set('activeExecution', state);
        return { status: 'waiting_external', state };
      }
    })
  });

  assert.equal((await scheduler.setDrainEnabled(true)).enabled, true);
  const result = await scheduler.runAutoOnce();

  assert.deepEqual(calls, ['chatgpt-1']);
  assert.equal(result.status, 'auto_run_draining');
  assert.equal((await scheduler.getStatus()).active_task_count, 0);
  assert.equal((await scheduler.getStatus()).drain_enabled, true);
});

test('disabling drain opens capacity but staggers replacement launches', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 3 },
    autoRunEnabled: true,
    drainEnabled: true
  });
  let nowMs = Date.parse('2026-08-29T03:30:00.000Z');
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => {
        const active = await storage.get('activeExecution');
        if (active?.task_id) return { status: 'active', state: active };
        calls.push(slotId);
        const state = { task_id: `task-${slotId}`, phase: 'RUNNING' };
        await storage.set('activeExecution', state);
        return { status: 'active', state };
      }
    })
  });

  const result = await scheduler.setDrainEnabled(false);
  assert.equal(result.enabled, false);
  assert.deepEqual(calls, ['chatgpt-1']);
  assert.equal((await scheduler.getStatus()).active_task_count, 1);

  nowMs += 16_000;
  await scheduler.runAutoOnce();
  assert.deepEqual(calls, ['chatgpt-1', 'chatgpt-2']);

  nowMs += 16_000;
  await scheduler.runAutoOnce();
  assert.deepEqual(calls, ['chatgpt-1', 'chatgpt-2', 'chatgpt-3']);
  assert.equal((await scheduler.getStatus()).active_task_count, 3);
});

test('increasing max parallel Tasks staggers newly available capacity instead of bursting all launches', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 2 },
    autoRunEnabled: true,
    activeExecution: { task_id: 'task-1', phase: 'RUNNING' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-2', phase: 'RUNNING' } }
  });
  let nowMs = Date.parse('2026-08-29T03:40:00.000Z');
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => {
        const active = await storage.get('activeExecution');
        if (active?.task_id) return { status: 'active', state: active };
        calls.push(slotId);
        const state = { task_id: `task-${slotId}`, phase: 'RUNNING' };
        await storage.set('activeExecution', state);
        return { status: 'active', state };
      }
    })
  });

  const result = await scheduler.setMaxParallelTasks(5);
  assert.equal(result.max_parallel_tasks, 5);
  assert.deepEqual(calls, ['chatgpt-3']);
  assert.equal((await scheduler.getStatus()).active_task_count, 3);

  nowMs += 16_000;
  await scheduler.runAutoOnce();
  assert.deepEqual(calls, ['chatgpt-3', 'chatgpt-4']);

  nowMs += 16_000;
  await scheduler.runAutoOnce();
  assert.deepEqual(calls, ['chatgpt-3', 'chatgpt-4', 'chatgpt-5']);
  assert.equal((await scheduler.getStatus()).active_task_count, 5);
});

test('automatic tab-loss recovery opens only the failing slot circuit on the fifth attempt and does not interrupt it again', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 2 },
    browserTabSlots: {
      'chatgpt-1': { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 1, status: 'assigned', recovery_attempts: [
        '2026-08-26T10:00:00.000Z','2026-08-26T10:01:00.000Z','2026-08-26T10:02:00.000Z','2026-08-26T10:03:00.000Z'
      ], recovery_window_count: 4, recovery_circuit_state: 'degraded' },
      'chatgpt-2': { slot_id: 'chatgpt-2', tab_id: 18, task_id: 'task-b', generation: 1, status: 'assigned' }
    },
    activeExecution: { task_id: 'task-a', phase: 'RUNNING' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-b', phase: 'RUNNING' } }
  });
  const { BrowserTabSlotStore } = await import('../src/background/task-store.js');
  const interrupted = [];
  const escalated = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore: new BrowserTabSlotStore(shared),
    now: () => new Date('2026-08-26T10:04:00.000Z'),
    openRecoveryCircuit: async info => escalated.push(info),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId, storage,
      interruptAndRecover: async () => { interrupted.push(slotId); return { status: 'recovered' }; }
    })
  });
  const result = await scheduler.handleTabRemoved(17, 'removed');
  assert.equal(result.status, 'recovery_circuit_open');
  assert.deepEqual(interrupted, []);
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0].slotId, 'chatgpt-1');
  assert.equal((await shared.get('activeExecution')).phase, 'WAITING_HUMAN');
  assert.equal((await shared.get('slotExecutionState:chatgpt-2')).activeExecution.phase, 'RUNNING');
});

test('automatic startup recovery repairs the legacy FINALIZING recovery circuit and retries completion', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 1 }, autoRunEnabled: true,
    browserTabSlots: {
      'chatgpt-1': { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-finalizing', generation: 1, status: 'assigned', recovery_circuit_state: 'open', recovery_window_count: 5 }
    },
    activeExecution: {
      task_id: 'task-finalizing',
      phase: 'WAITING_HUMAN',
      terminal_reason: 'SUCCESS',
      terminal_action: 'COMPLETE',
      recovery_error: { code: 'TASK_RECOVERY_BLOCKED', message: 'Recovery is not enabled for phase=FINALIZING' },
      browser_recovery_circuit: { state: 'open', reason: 'TASK_RECOVERY_BLOCKED', recovery_count: 5 }
    }
  });
  const { BrowserTabSlotStore } = await import('../src/background/task-store.js');
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore: new BrowserTabSlotStore(shared),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId, storage,
      recoverRealIfNeeded: async () => {
        calls.push('auto');
        const active = await storage.get('activeExecution');
        assert.equal(active.phase, 'FINALIZING');
        assert.equal(active.recovery_error, null);
        await storage.remove('activeExecution');
        return { status: 'completed', taskId: active.task_id };
      }
    })
  });

  const automatic = await scheduler.recoverRealIfNeeded();

  assert.equal(automatic.results[0].status, 'completed');
  assert.deepEqual(calls, ['auto']);
  assert.equal((await scheduler.slotStore.load('chatgpt-1')).recovery_circuit_state, 'closed');
  assert.equal(await shared.get('activeExecution'), undefined);
});

test('automatic startup recovery skips an open circuit while targeted manual recovery clears the circuit and retries', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 1 }, autoRunEnabled: true,
    browserTabSlots: {
      'chatgpt-1': { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 1, status: 'assigned', recovery_circuit_state: 'open', recovery_window_count: 5 }
    },
    activeExecution: { task_id: 'task-a', phase: 'WAITING_HUMAN' }
  });
  const { BrowserTabSlotStore } = await import('../src/background/task-store.js');
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore: new BrowserTabSlotStore(shared),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId, storage,
      recoverRealIfNeeded: async () => { calls.push('auto'); return { status: 'recovered' }; },
      recoverReal: async () => { calls.push('manual'); return { status: 'waiting_external', state: await storage.get('activeExecution') }; }
    })
  });
  const automatic = await scheduler.recoverRealIfNeeded();
  assert.equal(automatic.results[0].status, 'recovery_circuit_open');
  assert.deepEqual(calls, []);
  await scheduler.recoverReal('chatgpt-1');
  assert.deepEqual(calls, ['manual']);
  assert.equal((await scheduler.slotStore.load('chatgpt-1')).recovery_circuit_state, 'closed');
});


test('PatchSync outage opens a shared infrastructure circuit and prevents additional idle claims', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 3 }, autoRunEnabled: true });
  let nowMs = Date.parse('2026-08-29T04:00:00.000Z');
  const attempts = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => {
        attempts.push(slotId);
        if (slotId !== 'chatgpt-1') return { status: 'idle', state: null };
        const state = {
          task_id: 'task-patchsync-down',
          project_id: 'vetatool',
          phase: 'PREPARING_SOURCE',
          next_recovery_at: '2026-08-29T04:00:05.000Z',
          infrastructure_wait: {
            service: 'patchsync',
            operation: 'ensure_ready',
            next_retry_at: '2026-08-29T04:00:05.000Z'
          }
        };
        await storage.set('activeExecution', state);
        return {
          status: 'source_retry_pending',
          state,
          error: { code: 'PATCHSYNC_UNREACHABLE', message: 'PatchSync API is unreachable', details: { operation: 'ensure_ready' } }
        };
      }
    })
  });

  const result = await scheduler.runAutoOnce();
  const status = await scheduler.getStatus();

  assert.deepEqual(attempts, ['chatgpt-1']);
  assert.equal(result.results[0].status, 'source_retry_pending');
  assert.equal(result.results[1].status, 'infra_retry_wait');
  assert.equal(result.results[2].status, 'infra_retry_wait');
  assert.equal(status.infrastructure_circuit.state, 'open');
  assert.equal(status.infrastructure_circuit.service, 'patchsync');
  assert.equal(status.infrastructure_circuit.last_operation, 'ensure_ready');
  assert.equal(status.infrastructure_circuit.retry_at, '2026-08-29T04:00:05.000Z');
  assert.equal(status.claimable_task_count, 0);
});

test('Control Plane network outage is contained to one idle launch probe', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 3 }, autoRunEnabled: true });
  let nowMs = Date.parse('2026-08-29T04:10:00.000Z');
  const attempts = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => {
        attempts.push(slotId);
        throw new TypeError('Failed to fetch');
      }
    })
  });

  const result = await scheduler.runAutoOnce();
  const status = await scheduler.getStatus();

  assert.deepEqual(attempts, ['chatgpt-1']);
  assert.equal(result.results[0].status, 'infra_retry_wait');
  assert.equal(result.results[0].error.code, 'CONTROL_PLANE_UNREACHABLE');
  assert.equal(result.results[1].status, 'infra_retry_wait');
  assert.equal(result.results[2].status, 'infra_retry_wait');
  assert.equal(status.infrastructure_circuit.state, 'open');
  assert.equal(status.infrastructure_circuit.service, 'control_plane');
  assert.equal(status.claimable_task_count, 0);
});

test('successful source recovery closes the PatchSync infrastructure circuit without replacing recovery flow', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 2 },
    autoRunEnabled: true,
    infrastructureCircuitState: {
      state: 'open', service: 'patchsync', failure_count: 1,
      opened_at: '2026-08-29T04:20:00.000Z', retry_at: '2026-08-29T04:20:05.000Z',
      last_failure_at: '2026-08-29T04:20:00.000Z', last_error_code: 'PATCHSYNC_UNREACHABLE', last_operation: 'ensure_ready'
    },
    activeExecution: {
      task_id: 'task-recover-source', project_id: 'vetatool', phase: 'PREPARING_SOURCE',
      next_recovery_at: '2026-08-29T04:20:05.000Z',
      infrastructure_wait: { service: 'patchsync', operation: 'ensure_ready', next_retry_at: '2026-08-29T04:20:05.000Z' }
    }
  });
  let nowMs = Date.parse('2026-08-29T04:20:06.000Z');
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      recoverReal: async () => {
        const state = { task_id: 'task-recover-source', project_id: 'vetatool', phase: 'RUNNING', infrastructure_wait: null };
        await storage.set('activeExecution', state);
        return { status: 'active', state };
      }
    })
  });

  const result = await scheduler.recoverReal('chatgpt-1', { automatic: true });
  const status = await scheduler.getStatus();

  assert.equal(result.results[0].status, 'active');
  assert.equal(status.infrastructure_circuit.state, 'closed');
  assert.equal(status.infrastructure_circuit.service, null);
});

test('adaptive backpressure reduces effective claim capacity while the launch gate avoids a UI burst', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 5 }, autoRunEnabled: true });
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date('2026-08-26T12:00:00.000Z'),
    pressureProvider: () => ({ pending: 3, in_flight: 1, draining: true }),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId, storage,
      runAutoOnce: async () => {
        calls.push(slotId);
        const state = { task_id: `task-${slotId}`, phase: 'RUNNING' };
        await storage.set('activeExecution', state);
        return { status: 'active', state };
      }
    })
  });

  await scheduler.runAutoOnce();
  const status = await scheduler.getStatus();

  assert.deepEqual(calls, ['chatgpt-1']);
  assert.equal(status.max_parallel_tasks, 5);
  assert.equal(status.effective_parallel_tasks, 4);
  assert.equal(status.adaptive_backpressure.state, 'throttled');
  assert.deepEqual(status.adaptive_backpressure.reasons, ['ui_queue_backlog']);
  assert.equal(status.claimable_task_count, 0);
});

test('adaptive backpressure steps down at most once per minute while systemic pressure persists', async () => {
  let now = new Date('2026-08-26T12:00:59.000Z');
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 5 }, autoRunEnabled: true,
    adaptiveBackpressureState: {
      effective_parallel_tasks: 4,
      state: 'throttled',
      reasons: ['ui_queue_backlog'],
      last_pressure_at: '2026-08-26T12:00:00.000Z',
      last_adjustment_at: '2026-08-26T12:00:00.000Z',
      healthy_since: null
    }
  });
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => now,
    pressureProvider: () => ({ pending: 4 }),
    createController: ({ slotId, storage }) => makeStatusController({ slotId, storage })
  });

  await scheduler.runAutoOnce();
  assert.equal((await scheduler.getStatus()).effective_parallel_tasks, 4);

  now = new Date('2026-08-26T12:00:59.500Z');
  await scheduler.runAutoOnce();
  assert.equal((await scheduler.getStatus()).effective_parallel_tasks, 4);

  now = new Date('2026-08-26T12:01:01.000Z');
  await scheduler.runAutoOnce();
  assert.equal((await scheduler.getStatus()).effective_parallel_tasks, 3);
  assert.equal(ADAPTIVE_BACKPRESSURE_STEP_DOWN_COOLDOWN_MS, 60 * 1000);
});

test('adaptive backpressure treats recovery pressure as global only when multiple slots are affected', async () => {
  const { BrowserTabSlotStore } = await import('../src/background/task-store.js');
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 5 }, autoRunEnabled: true,
    activeExecution: { task_id: 'task-a', phase: 'RUNNING' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-b', phase: 'RUNNING' } },
    browserTabSlots: {
      'chatgpt-1': { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 1, status: 'assigned', recovery_attempts: ['2026-08-26T12:00:00.000Z'] },
      'chatgpt-2': { slot_id: 'chatgpt-2', tab_id: 18, task_id: 'task-b', generation: 1, status: 'assigned', recovery_attempts: ['2026-08-26T12:01:00.000Z'] }
    }
  });
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore: new BrowserTabSlotStore(shared),
    now: () => new Date('2026-08-26T12:02:00.000Z'),
    createController: ({ slotId, storage }) => makeStatusController({ slotId, storage })
  });

  await scheduler.runAutoOnce();
  const status = await scheduler.getStatus();
  assert.equal(status.effective_parallel_tasks, 4);
  assert.ok(status.adaptive_backpressure.reasons.includes('multi_slot_recovery'));
});

test('adaptive backpressure restores only one capacity step after each five minute healthy window', async () => {
  let now = new Date('2026-08-26T12:01:00.000Z');
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 5 }, autoRunEnabled: true,
    adaptiveBackpressureState: {
      effective_parallel_tasks: 3,
      state: 'throttled',
      reasons: ['ui_queue_backlog'],
      last_pressure_at: '2026-08-26T12:00:00.000Z',
      last_adjustment_at: '2026-08-26T12:00:00.000Z',
      healthy_since: null
    }
  });
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => now,
    pressureProvider: () => ({ pending: 0 }),
    createController: ({ slotId, storage }) => makeStatusController({ slotId, storage })
  });

  await scheduler.runAutoOnce();
  assert.equal((await scheduler.getStatus()).effective_parallel_tasks, 3);

  now = new Date('2026-08-26T12:05:59.000Z');
  await scheduler.runAutoOnce();
  assert.equal((await scheduler.getStatus()).effective_parallel_tasks, 3);

  now = new Date('2026-08-26T12:06:01.000Z');
  await scheduler.runAutoOnce();
  assert.equal((await scheduler.getStatus()).effective_parallel_tasks, 4);

  now = new Date('2026-08-26T12:11:02.000Z');
  await scheduler.runAutoOnce();
  assert.equal((await scheduler.getStatus()).effective_parallel_tasks, 5);
  assert.equal(ADAPTIVE_BACKPRESSURE_HEALTHY_STEP_MS, 5 * 60 * 1000);
  assert.equal((await scheduler.getStatus()).adaptive_backpressure.state, 'normal');
});

test('adaptive backpressure keeps active slots above effective capacity progressing while preventing new claims above it', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 5 }, autoRunEnabled: true,
    adaptiveBackpressureState: {
      effective_parallel_tasks: 2,
      state: 'recovering',
      reasons: [],
      last_pressure_at: '2026-08-26T12:00:00.000Z',
      last_adjustment_at: '2026-08-26T12:00:00.000Z',
      healthy_since: '2026-08-26T12:01:00.000Z'
    },
    activeExecution: { task_id: 'task-1', phase: 'RUNNING' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-2', phase: 'RUNNING' } },
    'slotExecutionState:chatgpt-3': { activeExecution: { task_id: 'task-3', phase: 'RUNNING' } },
    'slotExecutionState:chatgpt-4': { activeExecution: { task_id: 'task-4', phase: 'RUNNING' } },
    'slotExecutionState:chatgpt-5': { activeExecution: { task_id: 'task-5', phase: 'RUNNING' } }
  });
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date('2026-08-26T12:02:00.000Z'),
    pressureProvider: () => ({ pending: 0 }),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId, storage,
      runAutoOnce: async () => { calls.push(slotId); return { status: 'waiting_external', state: await storage.get('activeExecution') }; }
    })
  });

  await scheduler.runAutoOnce();
  const status = await scheduler.getStatus();
  assert.deepEqual(calls, ['chatgpt-1', 'chatgpt-2', 'chatgpt-3', 'chatgpt-4', 'chatgpt-5']);
  assert.equal(status.active_task_count, 5);
  assert.equal(status.effective_parallel_tasks, 2);
});

test('increasing configured max while throttled does not bypass adaptive effective capacity', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 2 }, autoRunEnabled: true,
    adaptiveBackpressureState: {
      effective_parallel_tasks: 1,
      state: 'throttled',
      reasons: ['ui_queue_backlog'],
      last_pressure_at: '2026-08-26T12:00:00.000Z',
      last_adjustment_at: '2026-08-26T12:00:00.000Z',
      healthy_since: null
    }
  });
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date('2026-08-26T12:01:00.000Z'),
    pressureProvider: () => ({ pending: 4 }),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId, storage,
      runAutoOnce: async () => { calls.push(slotId); return { status: 'idle', state: null }; }
    })
  });

  const result = await scheduler.setMaxParallelTasks(5);
  assert.equal(result.max_parallel_tasks, 5);
  assert.equal(result.effective_parallel_tasks, 1);
  assert.deepEqual(calls, ['chatgpt-1']);
});

test('one repeatedly recovering slot stays isolated and does not trigger global adaptive backpressure by itself', async () => {
  const { BrowserTabSlotStore } = await import('../src/background/task-store.js');
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 5 }, autoRunEnabled: true,
    browserTabSlots: {
      'chatgpt-1': { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 1, status: 'assigned', recovery_attempts: [
        '2026-08-26T12:00:00.000Z', '2026-08-26T12:01:00.000Z', '2026-08-26T12:02:00.000Z'
      ] }
    }
  });
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore: new BrowserTabSlotStore(shared),
    now: () => new Date('2026-08-26T12:03:00.000Z'),
    createController: ({ slotId, storage }) => makeStatusController({ slotId, storage })
  });

  await scheduler.runAutoOnce();
  const status = await scheduler.getStatus();
  assert.equal(status.effective_parallel_tasks, 5);
  assert.equal(status.adaptive_backpressure.state, 'normal');
});

test('recent page failures on multiple assigned slots trigger adaptive backpressure', async () => {
  const { BrowserTabSlotStore } = await import('../src/background/task-store.js');
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 5 }, autoRunEnabled: true,
    activeExecution: { task_id: 'task-a', phase: 'RUNNING' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-b', phase: 'RUNNING' } },
    browserTabSlots: {
      'chatgpt-1': { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 1, status: 'assigned', last_observed_at: '2026-08-26T12:01:00.000Z', last_response_failure: { code: 'MODEL_FAILED' } },
      'chatgpt-2': { slot_id: 'chatgpt-2', tab_id: 18, task_id: 'task-b', generation: 1, status: 'assigned', last_observed_at: '2026-08-26T12:01:30.000Z', last_observation_error: 'observer unavailable' }
    }
  });
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore: new BrowserTabSlotStore(shared),
    now: () => new Date('2026-08-26T12:02:00.000Z'),
    createController: ({ slotId, storage }) => makeStatusController({ slotId, storage })
  });

  await scheduler.runAutoOnce();
  const status = await scheduler.getStatus();
  assert.equal(status.effective_parallel_tasks, 4);
  assert.ok(status.adaptive_backpressure.reasons.includes('multi_slot_page_failure'));
});

test('persistent page failures on the same slots step down global capacity only once until failure breadth grows', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 5 }, autoRunEnabled: true,
    activeExecution: { task_id: 'task-a', phase: 'RUNNING' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-b', phase: 'RUNNING' } }
  });
  let nowMs = Date.parse('2026-08-26T12:02:00.000Z');
  let slots = [
    { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 1, status: 'assigned', last_observed_at: '2026-08-26T12:01:00.000Z', last_response_failure: { code: 'MODEL_FAILED' } },
    { slot_id: 'chatgpt-2', tab_id: 18, task_id: 'task-b', generation: 1, status: 'assigned', last_observed_at: '2026-08-26T12:01:30.000Z', last_observation_error: 'observer unavailable' }
  ];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore: { async list() { return structuredClone(slots); } },
    now: () => new Date(nowMs),
    createController: ({ slotId, storage }) => makeStatusController({ slotId, storage })
  });

  await scheduler.runAutoOnce();
  let status = await scheduler.getStatus();
  assert.equal(status.effective_parallel_tasks, 4);

  nowMs += ADAPTIVE_BACKPRESSURE_STEP_DOWN_COOLDOWN_MS + 1000;
  slots = slots.map(slot => ({ ...slot, last_observed_at: new Date(nowMs - 30000).toISOString() }));
  await scheduler.runAutoOnce();
  status = await scheduler.getStatus();
  assert.equal(status.effective_parallel_tasks, 4);

  nowMs += ADAPTIVE_BACKPRESSURE_STEP_DOWN_COOLDOWN_MS + 1000;
  await shared.set('slotExecutionState:chatgpt-3', { activeExecution: { task_id: 'task-c', phase: 'RUNNING' } });
  slots.push({ slot_id: 'chatgpt-3', tab_id: 19, task_id: 'task-c', generation: 1, status: 'assigned', last_observed_at: new Date(nowMs - 30000).toISOString(), last_observation_error: 'observer unavailable' });
  slots = slots.map(slot => ({ ...slot, last_observed_at: new Date(nowMs - 30000).toISOString() }));
  await scheduler.runAutoOnce();
  status = await scheduler.getStatus();
  assert.equal(status.effective_parallel_tasks, 3);
});

test('page failures older than two minutes no longer keep global backpressure active', async () => {
  const { BrowserTabSlotStore } = await import('../src/background/task-store.js');
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 3 }, autoRunEnabled: true,
    activeExecution: { task_id: 'task-a', phase: 'RUNNING' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-b', phase: 'RUNNING' } },
    browserTabSlots: {
      'chatgpt-1': { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 1, status: 'assigned', last_observed_at: '2026-08-26T12:00:00.000Z', last_response_failure: { code: 'MODEL_FAILED' } },
      'chatgpt-2': { slot_id: 'chatgpt-2', tab_id: 18, task_id: 'task-b', generation: 1, status: 'assigned', last_observed_at: '2026-08-26T12:00:30.000Z', last_observation_error: 'observer unavailable' }
    }
  });
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore: new BrowserTabSlotStore(shared),
    now: () => new Date('2026-08-26T12:03:00.000Z'),
    createController: ({ slotId, storage }) => makeStatusController({ slotId, storage })
  });

  await scheduler.runAutoOnce();
  const status = await scheduler.getStatus();
  assert.equal(ADAPTIVE_BACKPRESSURE_WINDOW_MS, 2 * 60 * 1000);
  assert.equal(status.adaptive_backpressure.reasons.includes('multi_slot_page_failure'), false);
  assert.equal(status.effective_parallel_tasks, 3);
});

test('status view does not surface another Task history as the current active Task failure', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 2 }, autoRunEnabled: true,
    activeExecution: { task_id: 'task-current', phase: 'RUNNING' },
    lastRun: { status: 'failed', taskId: 'task-old', error: { safe: true, code: 'PATCH_DOWNLOAD_FAILED', message: 'old failure' } },
    lastRecovery: { status: 'recovery_blocked', taskId: 'task-old', error: { safe: true, code: 'TASK_RECOVERY_BLOCKED', message: 'old recovery' } },
    'slotExecutionState:chatgpt-2': {
      lastRun: { status: 'completed', taskId: 'task-current' },
      lastRecovery: { status: 'completed', taskId: 'task-current' }
    }
  });
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    createController: ({ slotId, storage }) => makeStatusController({ slotId, storage })
  });

  const status = await scheduler.getStatus();
  assert.equal(status.activeExecution.task_id, 'task-current');
  assert.equal(status.lastRun?.taskId, 'task-current');
  assert.equal(status.lastRecovery?.taskId, 'task-current');
});

test('stale assigned slot failures from previous Tasks do not throttle current active Tasks', async () => {
  const { BrowserTabSlotStore } = await import('../src/background/task-store.js');
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 2 }, autoRunEnabled: true,
    activeExecution: { task_id: 'task-current', phase: 'RUNNING' },
    browserTabSlots: {
      'chatgpt-1': { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-current', generation: 2, status: 'assigned', last_observed_at: '2026-08-27T10:00:00.000Z' },
      'chatgpt-2': { slot_id: 'chatgpt-2', tab_id: 18, task_id: 'task-old', generation: 1, status: 'assigned', last_observed_at: '2026-08-27T10:00:00.000Z', last_observation_error: 'old task page failed' },
      'chatgpt-3': { slot_id: 'chatgpt-3', tab_id: 19, task_id: 'task-older', generation: 1, status: 'assigned', last_observed_at: '2026-08-27T10:00:00.000Z', last_response_failure: { code: 'PATCH_DOWNLOAD_FAILED' } }
    }
  });
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore: new BrowserTabSlotStore(shared),
    now: () => new Date('2026-08-27T10:01:00.000Z'),
    pressureProvider: () => ({ pending: 0 }),
    createController: ({ slotId, storage }) => makeStatusController({ slotId, storage })
  });

  await scheduler.runAutoOnce();
  const status = await scheduler.getStatus();
  assert.equal(status.adaptive_backpressure.reasons.includes('multi_slot_page_failure'), false);
  assert.equal(status.effective_parallel_tasks, 2);
});

test('automatic claim protocol skew opens the control-plane infrastructure circuit instead of failing the business Task', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', max_parallel_tasks: 1 }, autoRunEnabled: true });
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    createController: ({ slotId, storage }) => makeStatusController({
      slotId, storage,
      runAutoOnce: async () => {
        const error = new Error('Agent Control 400: unsupported command field: command_id');
        error.status = 400;
        error.code = 'invalid_agent_control_command';
        throw error;
      }
    })
  });

  const result = await scheduler.runAutoOnce();

  assert.equal(result.results[0].status, 'infra_retry_wait');
  assert.equal(result.results[0].error.code, 'CONTROL_PLANE_PROTOCOL_MISMATCH');
  const status = await scheduler.getStatus();
  assert.equal(status.infrastructure_circuit.state, 'open');
  assert.equal(status.infrastructure_circuit.service, 'control_plane');
  assert.equal(status.infrastructure_circuit.last_error_code, 'CONTROL_PLANE_PROTOCOL_MISMATCH');
  assert.equal(status.active_task_count, 0);
});

test('automatic reconcile protocol skew uses the infrastructure circuit without escalating the Task to WAITING_HUMAN', async () => {
  const { BrowserTabSlotStore } = await import('../src/background/task-store.js');
  const shared = memoryStorage({
    settings: { mode: 'real', max_parallel_tasks: 1 }, autoRunEnabled: true,
    activeExecution: { task_id: 'task-skew', project_id: 'vetatool', phase: 'RUNNING', lease: { token: 'lease-a', ttl_ms: 900000 } },
    browserTabSlots: {
      'chatgpt-1': { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-skew', generation: 1, status: 'assigned' }
    }
  });
  let nowMs = Date.parse('2026-08-29T10:00:00.000Z');
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore: new BrowserTabSlotStore(shared),
    now: () => new Date(nowMs),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId, storage,
      recoverReal: async () => ({
        status: 'recovery_blocked',
        state: await storage.get('activeExecution'),
        error: {
          status: 400,
          code: 'invalid_agent_control_command',
          message: 'Agent Control 400: unsupported command field: command_id'
        }
      })
    })
  });

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = await scheduler.recoverReal('chatgpt-1', { automatic: true });
    assert.equal(result.results[0].status, 'infra_retry_wait');
    assert.notEqual(result.results[0].status, 'recovery_circuit_open');
    nowMs += 60_000;
  }

  const status = await scheduler.getStatus();
  assert.equal(status.infrastructure_circuit.state, 'open');
  assert.equal(status.infrastructure_circuit.last_error_code, 'CONTROL_PLANE_PROTOCOL_MISMATCH');
  assert.equal((await shared.get('activeExecution')).phase, 'RUNNING');
  assert.notEqual((await scheduler.slotStore.load('chatgpt-1')).recovery_circuit_state, 'open');
});

test('automatic startup recovery repairs legacy command-id protocol skew WAITING_HUMAN state and retries server reconciliation', async () => {
  const { BrowserTabSlotStore } = await import('../src/background/task-store.js');
  const shared = memoryStorage({
    settings: { mode: 'real', max_parallel_tasks: 1 }, autoRunEnabled: true,
    browserTabSlots: {
      'chatgpt-1': { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-skew', generation: 1, status: 'assigned', recovery_circuit_state: 'open', recovery_window_count: 5 }
    },
    activeExecution: {
      task_id: 'task-skew',
      project_id: 'vetatool',
      phase: 'WAITING_HUMAN',
      recovery_error: { code: 'invalid_agent_control_command', message: 'Agent Control 400: unsupported command field: command_id' },
      browser_recovery_circuit: { state: 'open', reason: 'invalid_agent_control_command', recovery_count: 5 }
    }
  });
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore: new BrowserTabSlotStore(shared),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId, storage,
      recoverRealIfNeeded: async () => {
        calls.push('recover');
        const active = await storage.get('activeExecution');
        assert.equal(active.phase, 'RUNNING');
        assert.equal(active.recovery_error, null);
        assert.equal(active.browser_recovery_circuit, null);
        return { status: 'waiting_external', state: active };
      }
    })
  });

  const result = await scheduler.recoverRealIfNeeded();

  assert.equal(result.results[0].status, 'waiting_external');
  assert.deepEqual(calls, ['recover']);
  assert.equal((await scheduler.slotStore.load('chatgpt-1')).recovery_circuit_state, 'closed');
});

test('automatic reconcile network failures use the infrastructure circuit without escalating the Task to WAITING_HUMAN', async () => {
  const { BrowserTabSlotStore } = await import('../src/background/task-store.js');
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 2 }, autoRunEnabled: true,
    activeExecution: { task_id: 'task-network', project_id: 'vetatool', phase: 'RUNNING', lease: { token: 'lease-a', ttl_ms: 900000 } },
    browserTabSlots: {
      'chatgpt-1': { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-network', generation: 1, status: 'assigned' }
    }
  });
  const opened = [];
  let nowMs = Date.parse('2026-08-27T10:00:00.000Z');
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore: new BrowserTabSlotStore(shared),
    now: () => new Date(nowMs),
    openRecoveryCircuit: async info => { opened.push(info); },
    createController: ({ slotId, storage }) => makeStatusController({
      slotId, storage,
      recoverReal: async () => ({
        status: 'recovery_blocked',
        state: await storage.get('activeExecution'),
        error: { message: 'fetch failed while reconciling execution' }
      })
    })
  });

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = await scheduler.recoverReal('chatgpt-1', { automatic: true });
    assert.notEqual(result.results[0].status, 'recovery_circuit_open');
    nowMs += 60_000;
  }

  const status = await scheduler.getStatus();
  assert.equal(status.infrastructure_circuit.state, 'open');
  assert.equal(status.infrastructure_circuit.service, 'control_plane');
  assert.equal((await shared.get('activeExecution')).phase, 'RUNNING');
  assert.equal(opened.length, 0);
});

test('automatic blocked recovery opens the existing circuit before another Task can replace it', async () => {
  const { BrowserTabSlotStore } = await import('../src/background/task-store.js');
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 2 }, autoRunEnabled: true,
    activeExecution: { task_id: 'task-sticky', project_id: 'vetatool', phase: 'RUNNING', lease: { token: 'lease-a', ttl_ms: 900000 } },
    browserTabSlots: {
      'chatgpt-1': { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-sticky', generation: 1, status: 'assigned' }
    }
  });
  const opened = [];
  let nowMs = Date.parse('2026-08-27T10:00:00.000Z');
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore: new BrowserTabSlotStore(shared),
    now: () => new Date(nowMs),
    openRecoveryCircuit: async info => { opened.push(info); },
    createController: ({ slotId, storage }) => makeStatusController({
      slotId, storage,
      recoverReal: async () => ({
        status: 'recovery_blocked',
        state: await storage.get('activeExecution'),
        error: { code: 'TASK_RECOVERY_BLOCKED', message: 'conversation is ambiguous' }
      })
    })
  });

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = await scheduler.recoverReal('chatgpt-1', { automatic: true });
    assert.equal(result.results[0].status, 'recovery_blocked');
    nowMs += 5_000;
  }
  const fifth = await scheduler.recoverReal('chatgpt-1', { automatic: true });
  assert.equal(fifth.results[0].status, 'recovery_circuit_open');
  assert.equal((await shared.get('activeExecution')).task_id, 'task-sticky');
  assert.equal((await shared.get('activeExecution')).phase, 'WAITING_HUMAN');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].taskId, 'task-sticky');
});

test('semantic progress after a page failure clears that slot from multi-slot page pressure', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 2 }, autoRunEnabled: true,
    adaptiveBackpressureState: {
      effective_parallel_tasks: 1,
      state: 'throttled',
      reasons: ['multi_slot_page_failure'],
      last_pressure_at: '2026-08-26T12:01:30.000Z',
      last_adjustment_at: '2026-08-26T12:01:30.000Z',
      healthy_since: null
    }
  });
  const slotStore = {
    async list() {
      return [
        { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 1, status: 'assigned', last_observed_at: '2026-08-26T12:01:00.000Z', last_response_failure: { code: 'MODEL_FAILED' }, last_progress_at: '2026-08-26T12:02:00.000Z' },
        { slot_id: 'chatgpt-2', tab_id: 18, task_id: 'task-b', generation: 1, status: 'assigned', last_observed_at: '2026-08-26T12:01:30.000Z', last_observation_error: 'observer unavailable', last_progress_at: '2026-08-26T12:02:30.000Z' }
      ];
    }
  };
  let nowMs = Date.parse('2026-08-26T12:03:00.000Z');
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore,
    now: () => new Date(nowMs),
    pressureProvider: () => ({ pending: 0 }),
    createController: ({ slotId, storage }) => makeStatusController({ slotId, storage })
  });

  await scheduler.runAutoOnce();
  let status = await scheduler.getStatus();
  assert.equal(status.adaptive_backpressure.reasons.includes('multi_slot_page_failure'), false);
  assert.equal(status.adaptive_backpressure.state, 'recovering');
  assert.equal(status.effective_parallel_tasks, 1);

  nowMs += ADAPTIVE_BACKPRESSURE_HEALTHY_STEP_MS;
  await scheduler.runAutoOnce();
  status = await scheduler.getStatus();
  assert.equal(status.adaptive_backpressure.state, 'normal');
  assert.equal(status.effective_parallel_tasks, 2);
});

test('a reduced effective capacity recovers gradually instead of jumping straight to configured max', async () => {
  let nowMs = Date.parse('2026-08-26T12:00:00.000Z');
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 5 }, autoRunEnabled: true,
    adaptiveBackpressureState: {
      effective_parallel_tasks: 2,
      state: 'normal',
      reasons: [],
      last_pressure_at: '2026-08-26T10:00:00.000Z',
      last_adjustment_at: '2026-08-26T10:20:00.000Z',
      healthy_since: null
    }
  });
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    pressureProvider: () => ({ pending: 0 }),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId, storage,
      runAutoOnce: async () => { calls.push(slotId); return { status: 'idle', state: null }; }
    })
  });

  await scheduler.runAutoOnce();
  assert.deepEqual(calls, ['chatgpt-1', 'chatgpt-2']);
  assert.equal((await scheduler.getStatus()).effective_parallel_tasks, 2);

  nowMs += 5 * 60 * 1000 + 1;
  await scheduler.runAutoOnce();
  assert.equal((await scheduler.getStatus()).effective_parallel_tasks, 3);
});

test('status exposes claimable capacity, quarantined slots, and the next healthy backpressure recovery step', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 5 },
    autoRunEnabled: true,
    activeExecution: { task_id: 'task-a', phase: 'RUNNING' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-b', phase: 'RUNNING' } },
    adaptiveBackpressureState: {
      effective_parallel_tasks: 4,
      state: 'recovering',
      reasons: [],
      last_pressure_reasons: ['multi_slot_page_failure'],
      last_pressure_at: '2026-08-28T11:59:30.000Z',
      last_adjustment_at: '2026-08-28T12:00:00.000Z',
      healthy_since: '2026-08-28T12:00:30.000Z',
      metrics: { ui_queue_pending: 0, recovering_slots: 0, failing_slots: 0 }
    }
  });
  const slotStore = {
    async list() {
      return [
        { slot_id: 'chatgpt-1', task_id: 'task-a', status: 'assigned', recovery_circuit_state: 'closed' },
        { slot_id: 'chatgpt-2', task_id: 'task-b', status: 'assigned', recovery_circuit_state: 'closed' },
        { slot_id: 'chatgpt-3', task_id: 'task-old', status: 'assigned', recovery_circuit_state: 'open' }
      ];
    }
  };
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore,
    now: () => new Date('2026-08-28T12:01:00.000Z'),
    createController: ({ slotId, storage }) => makeStatusController({ slotId, storage })
  });

  const status = await scheduler.getStatus();

  assert.equal(status.active_task_count, 2);
  assert.equal(status.claimable_task_count, 2);
  assert.equal(status.quarantined_slot_count, 1);
  assert.deepEqual(status.adaptive_backpressure.last_pressure_reasons, ['multi_slot_page_failure']);
  assert.equal(status.adaptive_backpressure.next_recovery_at, '2026-08-28T12:05:30.000Z');
  assert.equal(status.adaptive_backpressure.next_recovery_in_ms, 270 * 1000);
});

test('project create selector circuit opens after two paced consecutive failures and stops draining the Task queue', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 2 }, autoRunEnabled: true });
  let nowMs = Date.parse('2026-08-27T04:40:00.000Z');
  let calls = 0;
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    random: () => 0,
    createController: ({ storage }) => makeStatusController({
      storage,
      runAutoOnce: async () => {
        calls += 1;
        return {
          status: 'released',
          error: { code: 'UI_SELECTOR_INCOMPATIBLE', message: calls === 1 ? 'Projects section was not found while resolving the create action' : 'Project name input was not found uniquely' },
          state: { task_id: `task-${calls}`, project_id: 'vetatool', phase: 'PREPARING_SOURCE' }
        };
      }
    })
  });

  await scheduler.runAutoOnce();
  assert.equal(calls, 1);
  assert.equal((await scheduler.getStatus()).project_create_circuit.state, 'closed');

  nowMs += 16_000;
  const second = await scheduler.runAutoOnce();
  const status = await scheduler.getStatus();
  assert.equal(calls, 2);
  assert.equal(status.project_create_circuit.state, 'open');
  assert.equal(status.project_create_circuit.project_id, 'vetatool');
  assert.ok(second.results.some(result => result.status === 'project_create_circuit_open'));

  await scheduler.runAutoOnce();
  assert.equal(calls, 2);

  nowMs += 5 * 60 * 1000 + 1;
  const halfOpen = await scheduler.getStatus();
  assert.equal(halfOpen.project_create_circuit.state, 'half_open');
});

test('project create selector circuit closes automatically after one successful paced half-open Project creation', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 2 }, autoRunEnabled: true });
  let nowMs = Date.parse('2026-08-27T04:40:00.000Z');
  const outcomes = [
    { status: 'released', error: { code: 'UI_SELECTOR_INCOMPATIBLE', message: 'Projects section was not found while resolving the create action' }, state: { task_id: 'a', project_id: 'vetatool' } },
    { status: 'released', error: { code: 'UI_SELECTOR_INCOMPATIBLE', message: 'Created Project vetatool_x did not appear before timeout' }, state: { task_id: 'b', project_id: 'vetatool' } },
    { status: 'waiting_external', state: { task_id: 'c', project_id: 'vetatool', chatgpt_project_name: 'vetatool_ok', phase: 'WAITING_EXTERNAL' } }
  ];
  let calls = 0;
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    random: () => 0,
    createController: ({ storage }) => makeStatusController({
      storage,
      runAutoOnce: async () => {
        const result = structuredClone(outcomes[Math.min(calls, outcomes.length - 1)]);
        calls += 1;
        if (result.state?.chatgpt_project_name) await storage.set('activeExecution', result.state);
        return result;
      }
    })
  });

  await scheduler.runAutoOnce();
  nowMs += 16_000;
  await scheduler.runAutoOnce();
  assert.equal((await scheduler.getStatus()).project_create_circuit.state, 'open');

  nowMs += 5 * 60 * 1000 + 1;
  await scheduler.runAutoOnce();

  assert.equal(calls, 3);
  assert.equal((await scheduler.getStatus()).project_create_circuit.state, 'closed');
});


test('status exposes per-slot active trace so the popup can switch Task details without cross-slot trace leakage', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 2 } });
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    createController: ({ slotId }) => ({
      async getStatus() {
        const suffix = slotId === 'chatgpt-1' ? 'a' : 'b';
        return {
          running: true,
          activeExecution: { task_id: `task-${suffix}`, project_id: `project-${suffix}` },
          activeTrace: [{ id: 'assignment', status: slotId === 'chatgpt-1' ? 'passed' : 'pending' }],
          lastRun: null,
          lastRecovery: null,
          settings: { mode: 'real' }
        };
      }
    })
  });

  const status = await scheduler.getStatus();
  assert.deepEqual(status.slots.map(slot => ({ slot_id: slot.slot_id, trace: slot.activeTrace })), [
    { slot_id: 'chatgpt-1', trace: [{ id: 'assignment', status: 'passed' }] },
    { slot_id: 'chatgpt-2', trace: [{ id: 'assignment', status: 'pending' }] }
  ]);
});

test('startup duplicate reconciliation keeps one canonical lineage and locally detaches duplicate managed slots without server termination', async () => {
  const execution = { task_id: 'task-dup', assignment_id: 'assignment-dup', execution_id: 'execution-dup', project_id: 'vetatool', phase: 'PREPARING_SOURCE' };
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 3 },
    activeExecution: execution,
    'slotExecutionState:chatgpt-2': { activeExecution: execution }
  });
  const slots = new Map([
    ['chatgpt-1', { slot_id: 'chatgpt-1', tab_id: 41, task_id: 'task-dup', generation: 2, status: 'assigned', managed_tab: true }],
    ['chatgpt-2', { slot_id: 'chatgpt-2', tab_id: 42, task_id: 'task-dup', generation: 3, status: 'assigned', managed_tab: true }]
  ]);
  const detached = [];
  const terminated = [];
  const closed = [];
  const slotStore = {
    async list() { return [...slots.values()].map(slot => structuredClone(slot)); },
    async load(slotId) { return structuredClone(slots.get(slotId) ?? null); },
    async release({ slotId, tabId }) {
      const current = slots.get(slotId);
      slots.set(slotId, { ...current, tab_id: tabId, task_id: null, status: 'idle' });
    }
  };
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore,
    closeIdleSlot: async slot => { closed.push(slot.slot_id); await slotStore.release({ slotId: slot.slot_id, tabId: null }); },
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      detachDuplicateExecution: async expected => {
        detached.push({ slotId, ...expected });
        await storage.remove('activeExecution');
        return { status: 'duplicate_execution_detached' };
      },
      terminateTask: async () => { terminated.push(slotId); return { status: 'terminated' }; }
    })
  });

  const result = await scheduler.reconcileDuplicateExecutions();

  assert.equal(result.detached, 1);
  assert.equal(result.conflicts, 0);
  assert.deepEqual(detached.map(item => item.slotId), ['chatgpt-2']);
  assert.deepEqual(closed, ['chatgpt-2']);
  assert.deepEqual(terminated, []);
  assert.equal((await shared.get('activeExecution')).execution_id, 'execution-dup');
  assert.equal(await shared.get('slotExecutionState:chatgpt-2'), undefined);
});

test('duplicate reconciliation fails safe when the same task id has conflicting Assignment or Execution lineage', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 2 },
    activeExecution: { task_id: 'task-same', assignment_id: 'assignment-a', execution_id: 'execution-a', phase: 'RUNNING' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-same', assignment_id: 'assignment-b', execution_id: 'execution-b', phase: 'RUNNING' } }
  });
  const detached = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      detachDuplicateExecution: async () => { detached.push(slotId); return { status: 'duplicate_execution_detached' }; }
    })
  });

  const result = await scheduler.reconcileDuplicateExecutions();

  assert.equal(result.detached, 0);
  assert.equal(result.conflicts, 1);
  assert.deepEqual(detached, []);
  assert.equal((await shared.get('activeExecution')).execution_id, 'execution-a');
  assert.equal((await shared.get('slotExecutionState:chatgpt-2')).activeExecution.execution_id, 'execution-b');
});


test('auto scheduler retains waiting_external execution and does not claim a replacement', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 1 }, autoRunEnabled: true });
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => {
        calls.push(slotId);
        const current = await storage.get('activeExecution');
        if (current?.task_id) return { status: 'waiting_external', state: current };
        const state = { task_id: 'task-parked', phase: 'WAITING_EXTERNAL', next_recovery_at: '2099-01-01T00:00:00.000Z' };
        await storage.set('activeExecution', state);
        return { status: 'waiting_external', state };
      }
    })
  });

  await scheduler.runAutoOnce();
  assert.equal((await scheduler.getStatus()).active_task_count, 1);
  await scheduler.runAutoOnce();
  assert.equal(calls.length, 2);
  assert.equal((await scheduler.getStatus()).activeExecution.task_id, 'task-parked');
});

test('waiting_external consumes execution capacity but not interactive pressure capacity', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 3 }, autoRunEnabled: true,
    activeExecution: { task_id: 'task-wait', phase: 'WAITING_EXTERNAL', next_recovery_at: '2099-01-01T00:00:00.000Z' },
    adaptiveBackpressureState: { effective_parallel_tasks: 1, state: 'throttled', reasons: ['ui_queue_backlog'], last_adjustment_at: '2026-08-29T04:00:00.000Z' }
  });
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date('2026-08-29T04:01:00.000Z'),
    pressureProvider: () => ({ pending: 4 }),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId, storage,
      runAutoOnce: async () => {
        calls.push(slotId);
        const current = await storage.get('activeExecution');
        if (current?.task_id) return { status: 'waiting_external', state: current };
        const state = { task_id: 'task-new', phase: 'RUNNING' };
        await storage.set('activeExecution', state);
        return { status: 'active', state };
      }
    })
  });

  await scheduler.runAutoOnce();
  const status = await scheduler.getStatus();
  assert.ok(calls.includes('chatgpt-2'));
  assert.equal(status.active_task_count, 2);
  assert.equal(status.interactive_task_count, 1);
  assert.equal(status.claimable_task_count, 0);
});

test('slot watchdog identifies the stale liveness layer before recovery instead of collapsing all stalls together', async () => {
  const { BrowserTabSlotStore } = await import('../src/background/task-store.js');
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 5 },
    browserTabSlots: {
      'chatgpt-1': { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-tab', generation: 1, status: 'assigned', last_tab_alive_at: '2026-08-26T08:00:00.000Z', last_dom_alive_at: '2026-08-26T08:25:00.000Z', last_execution_heartbeat_at: '2026-08-26T08:29:00.000Z', last_progress_at: '2026-08-26T08:29:00.000Z' },
      'chatgpt-2': { slot_id: 'chatgpt-2', tab_id: 18, task_id: 'task-dom', generation: 1, status: 'assigned', last_tab_alive_at: '2026-08-26T08:29:00.000Z', last_dom_alive_at: '2026-08-26T08:00:00.000Z', last_execution_heartbeat_at: '2026-08-26T08:29:00.000Z', last_progress_at: '2026-08-26T08:29:00.000Z' },
      'chatgpt-3': { slot_id: 'chatgpt-3', tab_id: 19, task_id: 'task-heartbeat', generation: 1, status: 'assigned', last_tab_alive_at: '2026-08-26T08:29:00.000Z', last_dom_alive_at: '2026-08-26T08:29:00.000Z', last_execution_heartbeat_at: '2026-08-26T08:00:00.000Z', last_progress_at: '2026-08-26T08:29:00.000Z' },
      'chatgpt-4': { slot_id: 'chatgpt-4', tab_id: 20, task_id: 'task-model', generation: 1, status: 'assigned', last_tab_alive_at: '2026-08-26T08:29:00.000Z', last_dom_alive_at: '2026-08-26T08:29:00.000Z', last_execution_heartbeat_at: '2026-08-26T08:29:00.000Z', last_progress_at: '2026-08-26T08:29:00.000Z' },
      'chatgpt-5': { slot_id: 'chatgpt-5', tab_id: 21, task_id: 'task-fresh', generation: 1, status: 'assigned', last_tab_alive_at: '2026-08-26T08:29:00.000Z', last_dom_alive_at: '2026-08-26T08:29:00.000Z', last_execution_heartbeat_at: '2026-08-26T08:29:00.000Z', last_progress_at: '2026-08-26T08:29:00.000Z' }
    },
    activeExecution: { task_id: 'task-tab', phase: 'RUNNING', last_meaningful_progress_at: '2026-08-26T08:29:00.000Z' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-dom', phase: 'RUNNING', last_meaningful_progress_at: '2026-08-26T08:29:00.000Z' } },
    'slotExecutionState:chatgpt-3': { activeExecution: { task_id: 'task-heartbeat', phase: 'RUNNING', last_meaningful_progress_at: '2026-08-26T08:29:00.000Z' } },
    'slotExecutionState:chatgpt-4': { activeExecution: { task_id: 'task-model', phase: 'RUNNING', in_flight_round: { stage: 'PROMPT_SENT' }, last_meaningful_progress_at: '2026-08-26T08:00:00.000Z' } },
    'slotExecutionState:chatgpt-5': { activeExecution: { task_id: 'task-fresh', phase: 'RUNNING', last_meaningful_progress_at: '2026-08-26T08:29:00.000Z' } }
  });
  const recovered = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore: new BrowserTabSlotStore(shared),
    now: () => new Date('2026-08-26T08:30:00.000Z'),
    watchdogStallMs: 20 * 60 * 1000,
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      interruptAndRecover: async reason => { recovered.push([slotId, reason]); return { status: 'waiting_external', state: await storage.get('activeExecution') }; }
    })
  });

  const result = await scheduler.runWatchdogOnce();

  assert.deepEqual(result.results.map(item => [item.slot_id, item.reason]), [
    ['chatgpt-1', 'slot_tab_unavailable'],
    ['chatgpt-2', 'slot_dom_unresponsive'],
    ['chatgpt-3', 'slot_execution_heartbeat_stalled'],
    ['chatgpt-4', 'slot_model_progress_stalled']
  ]);
  assert.equal(result.recovered, 4);
  assert.equal(recovered.length, 4);
});

test('status aggregates latest scheduler next claim and lease reconciliation diagnostics across slots', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 2 },
    autoRunEnabled: true,
    schedulerTelemetry: {
      state: 'idle',
      last_auto_tick_at: '2026-08-28T14:24:00.000Z',
      last_auto_status: 'idle'
    },
    agentControlTelemetry: {
      next: { operation: 'next', phase: 'succeeded', at: '2026-08-28T14:24:01.000Z', assignment_found: true, task_id: 'task-a' }
    },
    'slotExecutionState:chatgpt-2': {
      activeExecution: { task_id: 'task-old', phase: 'LEASE_LOST' },
      schedulerTelemetry: {
        state: 'lease_reconciliation_wait',
        task_id: 'task-old',
        next_retry_at: '2026-08-28T14:24:12.000Z',
        last_auto_tick_at: '2026-08-28T14:24:02.000Z',
        last_auto_status: 'auto_run_active_execution',
        recovery_error_code: 'assignment_lease_inactive',
        recovery_control_state: 'still_assigned'
      },
      agentControlTelemetry: {
        claim: { operation: 'claim', phase: 'failed', at: '2026-08-28T14:24:03.000Z', assignment_id: 'a-old', error_code: 'assignment_lease_inactive', http_status: 409 }
      }
    }
  });
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    createController: ({ slotId, storage }) => makeStatusController({ slotId, storage })
  });

  const status = await scheduler.getStatus();

  assert.equal(status.scheduler_diagnostics.state, 'lease_reconciliation_wait');
  assert.equal(status.scheduler_diagnostics.last_auto_tick_at, '2026-08-28T14:24:02.000Z');
  assert.equal(status.scheduler_diagnostics.last_next.task_id, 'task-a');
  assert.equal(status.scheduler_diagnostics.last_claim.error_code, 'assignment_lease_inactive');
  assert.equal(status.scheduler_diagnostics.reconciliation_wait_count, 1);
  assert.equal(status.scheduler_diagnostics.next_reconciliation_at, '2026-08-28T14:24:12.000Z');
});

test('explicit ChatGPT access limit enters global cooldown, drops pressure capacity to one, and blocks immediate refill', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 5 }, autoRunEnabled: true });
  let nowMs = Date.parse('2026-08-29T00:00:00.000Z');
  let calls = 0;
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => {
        calls += 1;
        if (calls === 1) return { status: 'failed', taskId: 'task-limit', error: { code: 'CHATGPT_ACCESS_LIMITED', message: 'limited' } };
        return { status: 'idle', state: null };
      }
    })
  });

  await scheduler.runAutoOnce();
  const limited = await scheduler.getStatus();

  assert.equal(calls, 1);
  assert.equal(limited.effective_parallel_tasks, 1);
  assert.equal(limited.claimable_task_count, 0);
  assert.equal(limited.adaptive_backpressure.state, 'cooldown');
  assert.equal(limited.adaptive_backpressure.pressure_level, 'cooldown');
  assert.equal(limited.adaptive_backpressure.last_pressure_reasons.includes('chatgpt_access_limit'), true);
  assert.equal(limited.adaptive_backpressure.cooldown_until, '2026-08-29T00:05:00.000Z');

  nowMs += 4 * 60 * 1000;
  await scheduler.runAutoOnce();
  assert.equal(calls, 1);
});

test('thrown ChatGPT access-limit errors still trip the global pressure cooldown', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 5 }, autoRunEnabled: true });
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date('2026-08-29T00:30:00.000Z'),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => {
        const error = new Error('limited');
        error.code = 'CHATGPT_ACCESS_LIMITED';
        throw error;
      }
    })
  });

  await assert.rejects(scheduler.runAutoOnce(), error => error?.code === 'CHATGPT_ACCESS_LIMITED');
  const status = await scheduler.getStatus();
  assert.equal(status.adaptive_backpressure.state, 'cooldown');
  assert.equal(status.adaptive_backpressure.cooldown_until, '2026-08-29T00:35:00.000Z');
  assert.equal(status.claimable_task_count, 0);
});

test('access-limit errors from an already-running slot defer recovery until the global cooldown ends', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 5 },
    autoRunEnabled: true,
    activeExecution: { task_id: 'task-active', phase: 'RUNNING' }
  });
  const deferred = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date('2026-08-29T00:40:00.000Z'),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => {
        const error = new Error('limited while active');
        error.code = 'CHATGPT_ACCESS_LIMITED';
        throw error;
      },
      deferActiveRecovery: async options => { deferred.push(options); return { status: 'pressure_cooldown_wait', taskId: 'task-active' }; }
    })
  });

  const result = await scheduler.runAutoOnce();
  const status = await scheduler.getStatus();
  assert.equal(result.results[0].status, 'pressure_cooldown');
  assert.equal(status.adaptive_backpressure.state, 'cooldown');
  assert.equal(status.adaptive_backpressure.cooldown_until, '2026-08-29T00:45:00.000Z');
  assert.deepEqual(deferred, [{ nextRecoveryAt: '2026-08-29T00:45:00.000Z' }]);
});

test('access-limit thrown after a new claim defers the newly durable execution instead of leaving it without recovery', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 1 }, autoRunEnabled: true });
  const deferred = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date('2026-08-29T00:50:00.000Z'),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => {
        await storage.set('activeExecution', { task_id: 'task-newly-claimed', phase: 'RUNNING' });
        const error = new Error('history request limited');
        error.code = 'CHATGPT_ACCESS_LIMITED';
        throw error;
      },
      deferActiveRecovery: async options => { deferred.push(options); return { status: 'pressure_cooldown_wait', taskId: 'task-newly-claimed' }; }
    })
  });

  const result = await scheduler.runAutoOnce();

  assert.equal(result.results[0].status, 'pressure_cooldown');
  assert.equal(result.results[0].taskId, 'task-newly-claimed');
  assert.deepEqual(deferred, [{ nextRecoveryAt: '2026-08-29T00:55:00.000Z' }]);
  assert.equal((await scheduler.getStatus()).claimable_task_count, 0);
});

test('access-limit cooldown resumes cautiously at one slot and requires a healthy window before capacity grows', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 5 },
    autoRunEnabled: true,
    adaptiveBackpressureState: {
      effective_parallel_tasks: 1,
      state: 'cooldown',
      reasons: ['chatgpt_access_limit'],
      last_pressure_reasons: ['chatgpt_access_limit'],
      last_pressure_at: '2026-08-29T00:00:00.000Z',
      last_adjustment_at: '2026-08-29T00:00:00.000Z',
      healthy_since: null,
      cooldown_until: '2026-08-29T00:05:00.000Z',
      pressure_level: 'cooldown',
      access_limit_count: 1,
      page_failure_breadth: 0,
      metrics: { ui_queue_pending: 0, recovering_slots: 0, failing_slots: 0 }
    }
  });
  let nowMs = Date.parse('2026-08-29T00:05:01.000Z');
  const launched = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => {
        if ((await storage.get('activeExecution'))?.task_id) return { status: 'active' };
        launched.push(slotId);
        const state = { task_id: `task-${slotId}`, phase: 'RUNNING' };
        await storage.set('activeExecution', state);
        return { status: 'active', state };
      }
    })
  });

  await scheduler.runAutoOnce();
  let status = await scheduler.getStatus();
  assert.deepEqual(launched, ['chatgpt-1']);
  assert.equal(status.adaptive_backpressure.state, 'recovering');
  assert.equal(status.effective_parallel_tasks, 1);

  nowMs += 2 * 60 * 1000;
  await scheduler.runAutoOnce();
  status = await scheduler.getStatus();
  assert.equal(status.effective_parallel_tasks, 1);

  nowMs += 3 * 60 * 1000 + 1_000;
  await scheduler.runAutoOnce();
  status = await scheduler.getStatus();
  assert.equal(status.effective_parallel_tasks, 2);
});

test('global launch gate staggers new ChatGPT executions instead of filling all empty slots in one tick', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 3 }, autoRunEnabled: true });
  let nowMs = Date.parse('2026-08-29T01:00:00.000Z');
  const launched = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => {
        const active = await storage.get('activeExecution');
        if (active?.task_id) return { status: 'active', state: active };
        launched.push(slotId);
        const state = { task_id: `task-${slotId}`, phase: 'RUNNING' };
        await storage.set('activeExecution', state);
        return { status: 'active', state };
      }
    })
  });

  await scheduler.runAutoOnce();
  assert.deepEqual(launched, ['chatgpt-1']);
  let status = await scheduler.getStatus();
  assert.equal(status.active_task_count, 1);
  assert.equal(status.adaptive_backpressure.next_launch_at, '2026-08-29T01:00:15.000Z');

  nowMs += 10_000;
  await scheduler.runAutoOnce();
  assert.deepEqual(launched, ['chatgpt-1']);

  nowMs += 6_000;
  await scheduler.runAutoOnce();
  assert.deepEqual(launched, ['chatgpt-1', 'chatgpt-2']);
});

test('manual Run Real Once obeys the same global launch spacing as auto-run', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 3 } });
  let nowMs = Date.parse('2026-08-29T01:30:00.000Z');
  const launched = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runReal: async () => {
        launched.push(slotId);
        const state = { task_id: `task-${slotId}`, phase: 'RUNNING' };
        await storage.set('activeExecution', state);
        return { status: 'active', state };
      }
    })
  });

  await scheduler.runReal();
  assert.deepEqual(launched, ['chatgpt-1']);

  nowMs += 10_000;
  await scheduler.runReal();
  assert.deepEqual(launched, ['chatgpt-1']);

  nowMs += 6_000;
  await scheduler.runReal();
  assert.deepEqual(launched, ['chatgpt-1', 'chatgpt-2']);
});

test('terminal failure releases the slot but defers replacement until the slot cooldown expires', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 1 },
    autoRunEnabled: true,
    activeExecution: { task_id: 'task-old', phase: 'RUNNING' }
  });
  let nowMs = Date.parse('2026-08-29T02:00:00.000Z');
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    random: () => 0,
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => {
        const active = await storage.get('activeExecution');
        calls.push(active?.task_id ?? 'empty');
        if (active?.task_id === 'task-old') {
          await storage.remove('activeExecution');
          return { status: 'failed', taskId: 'task-old', error: { code: 'MODEL_RESPONSE_FAILED', message: 'failed' } };
        }
        const state = { task_id: 'task-new', phase: 'RUNNING' };
        await storage.set('activeExecution', state);
        return { status: 'active', state };
      }
    })
  });

  await scheduler.runAutoOnce();
  assert.deepEqual(calls, ['task-old']);
  assert.equal((await scheduler.getStatus()).active_task_count, 0);

  nowMs += 14_000;
  await scheduler.runAutoOnce();
  assert.deepEqual(calls, ['task-old']);

  nowMs += 2_000;
  await scheduler.runAutoOnce();
  assert.deepEqual(calls, ['task-old', 'empty']);
  assert.equal((await scheduler.getStatus()).activeExecution?.task_id, 'task-new');
});

test('automatic recovery storm protection staggers durable slot recovery instead of reopening every Task at once', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 3 },
    activeExecution: { task_id: 'task-a', phase: 'RECOVERING', next_recovery_at: '2026-08-29T09:00:00.000Z' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-b', phase: 'RECOVERING', next_recovery_at: '2026-08-29T09:00:00.000Z' } },
    'slotExecutionState:chatgpt-3': { activeExecution: { task_id: 'task-c', phase: 'RECOVERING', next_recovery_at: '2026-08-29T09:00:00.000Z' } }
  });
  let nowMs = Date.parse('2026-08-29T09:00:00.000Z');
  const recovered = [];
  const deferred = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      recoverRealIfNeeded: async () => {
        recovered.push(slotId);
        return { status: 'waiting_external', state: await storage.get('activeExecution') };
      },
      recoverReal: async () => {
        recovered.push(slotId);
        return { status: 'waiting_external', state: await storage.get('activeExecution') };
      },
      deferActiveRecovery: async ({ nextRecoveryAt }) => {
        deferred.push({ slotId, nextRecoveryAt });
        const active = await storage.get('activeExecution');
        await storage.set('activeExecution', { ...active, next_recovery_at: nextRecoveryAt });
        return { status: 'recovery_deferred', state: await storage.get('activeExecution') };
      }
    })
  });

  const startup = await scheduler.recoverRealIfNeeded();

  assert.deepEqual(recovered, ['chatgpt-1']);
  assert.equal(deferred.length, 2);
  assert.equal(deferred[0].slotId, 'chatgpt-2');
  assert.equal(deferred[0].nextRecoveryAt, '2026-08-29T09:00:05.000Z');
  assert.equal(deferred[1].slotId, 'chatgpt-3');
  assert.equal(deferred[1].nextRecoveryAt, '2026-08-29T09:00:10.000Z');
  assert.equal(startup.results.find(item => item.slotId === 'chatgpt-2').status, 'recovery_throttled');
  assert.equal(startup.results.find(item => item.slotId === 'chatgpt-3').status, 'recovery_throttled');

  nowMs = Date.parse('2026-08-29T09:00:05.000Z');
  const second = await scheduler.recoverReal('chatgpt-2', { automatic: true });
  assert.equal(second.results[0].status, 'waiting_external');
  assert.deepEqual(recovered, ['chatgpt-1', 'chatgpt-2']);
});

test('coalesced recovery alarms are re-staggered when Chrome wakes after multiple reservations became due', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 3 },
    activeExecution: { task_id: 'task-a', phase: 'RECOVERING', next_recovery_at: '2026-08-29T09:00:00.000Z' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-b', phase: 'RECOVERING', next_recovery_at: '2026-08-29T09:00:00.000Z' } },
    'slotExecutionState:chatgpt-3': { activeExecution: { task_id: 'task-c', phase: 'RECOVERING', next_recovery_at: '2026-08-29T09:00:00.000Z' } }
  });
  let nowMs = Date.parse('2026-08-29T09:00:00.000Z');
  const recovered = [];
  const deferred = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      recoverRealIfNeeded: async () => {
        recovered.push(slotId);
        return { status: 'waiting_external', state: await storage.get('activeExecution') };
      },
      recoverReal: async () => {
        recovered.push(slotId);
        return { status: 'waiting_external', state: await storage.get('activeExecution') };
      },
      deferActiveRecovery: async ({ nextRecoveryAt }) => {
        deferred.push({ slotId, nextRecoveryAt });
        const active = await storage.get('activeExecution');
        await storage.set('activeExecution', { ...active, next_recovery_at: nextRecoveryAt });
        return { status: 'recovery_deferred', state: await storage.get('activeExecution') };
      }
    })
  });

  await scheduler.recoverRealIfNeeded();
  nowMs = Date.parse('2026-08-29T09:00:20.000Z');

  const slot2 = await scheduler.recoverReal('chatgpt-2', { automatic: true });
  const slot3 = await scheduler.recoverReal('chatgpt-3', { automatic: true });

  assert.equal(slot2.results[0].status, 'waiting_external');
  assert.equal(slot3.results[0].status, 'recovery_throttled');
  assert.equal(slot3.results[0].retry_at, '2026-08-29T09:00:25.000Z');
  assert.deepEqual(recovered, ['chatgpt-1', 'chatgpt-2']);
});

test('automatic startup recovery repairs legacy project execution lock WAITING_HUMAN state into LEASE_LOST reconciliation', async () => {
  const { BrowserTabSlotStore } = await import('../src/background/task-store.js');
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 1 }, autoRunEnabled: true,
    browserTabSlots: {
      'chatgpt-1': { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-locked', generation: 1, status: 'assigned', recovery_circuit_state: 'open', recovery_window_count: 5 }
    },
    activeExecution: {
      task_id: 'task-locked',
      project_id: 'vetatool',
      phase: 'WAITING_HUMAN',
      recovery_error: { code: 'project_execution_locked', message: 'Project vetatool is already executing Task task-new' },
      browser_recovery_circuit: { state: 'open', reason: 'project_execution_locked', recovery_count: 5 }
    }
  });
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore: new BrowserTabSlotStore(shared),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId, storage,
      recoverRealIfNeeded: async () => {
        calls.push('recover');
        const active = await storage.get('activeExecution');
        assert.equal(active.phase, 'LEASE_LOST');
        assert.equal(active.lease_loss.code, 'project_execution_locked');
        assert.equal(active.recovery_error, null);
        assert.equal(active.browser_recovery_circuit, null);
        return { status: 'lease_lost', state: active };
      }
    })
  });

  const result = await scheduler.recoverRealIfNeeded();

  assert.equal(result.results[0].status, 'lease_lost');
  assert.deepEqual(calls, ['recover']);
  assert.equal((await scheduler.slotStore.load('chatgpt-1')).recovery_circuit_state, 'closed');
});

test('a healthy independent ChatGPT tab rejects a single-slot access-limit signal instead of opening global cooldown', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 5 }, autoRunEnabled: true });
  const probes = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date('2026-08-29T14:10:00.000Z'),
    accessProbe: async () => {
      probes.push('probe');
      return { status: 'healthy', checked_tabs: 2, ready_tabs: 1, limited_tabs: 1, unavailable_tabs: 0 };
    },
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => ({ status: 'failed', taskId: 'task-local-limit', error: { code: 'CHATGPT_ACCESS_LIMITED', message: 'limited' } })
    })
  });

  await scheduler.runAutoOnce();
  const status = await scheduler.getStatus();

  assert.deepEqual(probes, ['probe']);
  assert.equal(status.adaptive_backpressure.state, 'normal');
  assert.equal(status.adaptive_backpressure.cooldown_until, null);
  assert.equal(status.adaptive_backpressure.last_access_probe_status, 'healthy');
  assert.equal(status.adaptive_backpressure.last_access_probe_ready_tabs, 1);
});

test('stored access-limit cooldown self-heals early when read-only tab probe proves ChatGPT is available', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 3 },
    autoRunEnabled: true,
    adaptiveBackpressureState: {
      effective_parallel_tasks: 1,
      state: 'cooldown',
      reasons: ['chatgpt_access_limit'],
      last_pressure_reasons: ['chatgpt_access_limit'],
      last_pressure_at: '2026-08-29T14:00:00.000Z',
      last_adjustment_at: '2026-08-29T14:00:00.000Z',
      healthy_since: null,
      cooldown_until: '2026-08-29T14:30:00.000Z',
      pressure_level: 'cooldown',
      access_limit_count: 1,
      page_failure_breadth: 0,
      metrics: { ui_queue_pending: 0, recovering_slots: 0, failing_slots: 0 }
    }
  });
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date('2026-08-29T14:12:00.000Z'),
    accessProbe: async () => ({ status: 'healthy', checked_tabs: 1, ready_tabs: 1, limited_tabs: 0, unavailable_tabs: 0 }),
    createController: ({ slotId, storage }) => makeStatusController({ slotId, storage })
  });

  await scheduler.runAutoOnce();
  const status = await scheduler.getStatus();

  assert.notEqual(status.adaptive_backpressure.state, 'cooldown');
  assert.equal(status.adaptive_backpressure.cooldown_until, null);
  assert.equal(status.adaptive_backpressure.last_access_probe_status, 'healthy');
});
