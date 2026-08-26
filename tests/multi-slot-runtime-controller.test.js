import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiSlotRuntimeController } from '../src/background/multi-slot-runtime-controller.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
  return {
    async get(key) { return data.get(key); },
    async set(key, value) { data.set(key, structuredClone(value)); },
    async remove(key) { data.delete(key); }
  };
}

function makeStatusController({ slotId, storage, runReal, runAutoOnce, recoverRealIfNeeded, recoverReal, interruptAndRecover }) {
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
    async terminateTask() { return { status: 'no_active_task', slotId }; }
  };
}

async function waitFor(predicate, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('condition not reached');
}

test('maxParallelTasks=3 starts three independent worker slots concurrently', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 3 } });
  const started = [];
  const releases = new Map();
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runReal: async () => {
        started.push(slotId);
        await storage.set('activeExecution', { task_id: `task-${slotId}`, project_id: `project-${slotId}`, phase: 'RUNNING' });
        await new Promise(resolve => releases.set(slotId, resolve));
        return { status: 'waiting_external', state: await storage.get('activeExecution') };
      }
    })
  });

  const run = scheduler.runReal();
  await waitFor(() => started.length === 3);
  assert.deepEqual([...started].sort(), ['chatgpt-1', 'chatgpt-2', 'chatgpt-3']);
  const statusWhileRunning = await scheduler.getStatus();
  assert.equal(statusWhileRunning.active_task_count, 3);
  assert.equal(statusWhileRunning.max_parallel_tasks, 3);
  for (const release of releases.values()) release();
  await run;
});

test('scheduler claims all capacity but only successful claims create task tabs when fewer Tasks are available', async () => {
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

  assert.equal(claimAttempts.length, 3);
  assert.deepEqual(createdTabs, ['chatgpt-1']);
  assert.equal((await scheduler.getStatus()).active_task_count, 1);
});

test('auto scheduler immediately refills the same slot after terminal completion and stops when replacement becomes active', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 1 }, autoRunEnabled: true });
  const outcomes = ['completed', 'waiting_external'];
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
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

  const result = await scheduler.runAutoOnce();

  assert.deepEqual(calls, ['completed', 'waiting_external']);
  assert.equal(result.results[0].status, 'waiting_external');
  assert.equal((await scheduler.getStatus()).activeExecution.task_id, 'task-b');
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

test('auto scheduler closes a reusable idle slot tab after no replacement Task is available', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 1 }, autoRunEnabled: true });
  const closed = [];
  const slotStore = {
    async load(slotId) { return { slot_id: slotId, tab_id: 17, task_id: null, generation: 3, status: 'idle' }; }
  };
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore,
    closeIdleSlot: async slot => closed.push({ slot_id: slot.slot_id, tab_id: slot.tab_id }),
    createController: ({ slotId, storage }) => makeStatusController({ slotId, storage })
  });

  await scheduler.runAutoOnce();

  assert.deepEqual(closed, [{ slot_id: 'chatgpt-1', tab_id: 17 }]);
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

test('terminal recovery immediately refills the same slot when auto run still has capacity', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 1 },
    autoRunEnabled: true,
    activeExecution: { task_id: 'task-a', phase: 'WAITING_EXTERNAL' }
  });
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
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

  const result = await scheduler.recoverReal('chatgpt-1');

  assert.deepEqual(calls, ['recover', 'refill']);
  assert.equal(result.results[0].refill.status, 'waiting_external');
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

test('disabling drain immediately fills idle capacity when auto run is enabled', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 3 },
    autoRunEnabled: true,
    drainEnabled: true
  });
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => {
        calls.push(slotId);
        const state = { task_id: `task-${slotId}`, phase: 'RUNNING' };
        await storage.set('activeExecution', state);
        return { status: 'waiting_external', state };
      }
    })
  });

  const result = await scheduler.setDrainEnabled(false);

  assert.equal(result.enabled, false);
  assert.deepEqual(calls, ['chatgpt-1', 'chatgpt-2', 'chatgpt-3']);
  assert.equal((await scheduler.getStatus()).active_task_count, 3);
});

test('increasing max parallel Tasks immediately fills only newly idle capacity while auto run is enabled', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 2 },
    autoRunEnabled: true,
    activeExecution: { task_id: 'task-1', phase: 'RUNNING' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-2', phase: 'RUNNING' } }
  });
  const calls = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    createController: ({ slotId, storage }) => makeStatusController({
      slotId,
      storage,
      runAutoOnce: async () => {
        calls.push(slotId);
        const state = { task_id: `task-${slotId}`, phase: 'RUNNING' };
        await storage.set('activeExecution', state);
        return { status: 'waiting_external', state };
      }
    })
  });

  const result = await scheduler.setMaxParallelTasks(5);

  assert.equal(result.max_parallel_tasks, 5);
  assert.deepEqual(calls, ['chatgpt-3', 'chatgpt-4', 'chatgpt-5']);
  assert.equal((await scheduler.getStatus()).active_task_count, 5);
});
