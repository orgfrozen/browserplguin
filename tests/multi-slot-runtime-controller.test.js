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

function makeStatusController({ slotId, storage, runReal, runAutoOnce, recoverRealIfNeeded, recoverReal, interruptAndRecover, terminateTask }) {
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
    terminateTask: terminateTask ?? (async () => ({ status: 'no_active_task', slotId }))
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

test('startup recovery restores all durable slots before any replacement claim and then fills remaining capacity', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 3 },
    autoRunEnabled: true,
    activeExecution: { task_id: 'task-a', phase: 'RUNNING' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-b', phase: 'RUNNING' } }
  });
  const events = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
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

  const result = await scheduler.recoverRealIfNeeded();

  assert.ok(events.indexOf('recover:chatgpt-2') >= 0);
  assert.ok(events.indexOf('claim:chatgpt-1') > events.indexOf('recover:chatgpt-2'));
  assert.deepEqual(events.slice(0, 2).sort(), ['recover:chatgpt-1', 'recover:chatgpt-2']);
  assert.equal(result.refill.some(item => item.slotId === 'chatgpt-1' && item.status === 'waiting_external'), true);
  assert.equal((await scheduler.getStatus()).active_task_count, 2);
});

test('startup recovery isolates one slot failure and still restores the other durable slots', async () => {
  const shared = memoryStorage({
    settings: { mode: 'real', maxParallelTasks: 2 },
    activeExecution: { task_id: 'task-a', phase: 'RUNNING' },
    'slotExecutionState:chatgpt-2': { activeExecution: { task_id: 'task-b', phase: 'RUNNING' } }
  });
  const recovered = [];
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
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

  const result = await scheduler.recoverRealIfNeeded();

  assert.deepEqual(recovered.sort(), ['chatgpt-1', 'chatgpt-2']);
  assert.equal(result.results.find(item => item.slotId === 'chatgpt-1').status, 'recovery_failed');
  assert.equal(result.results.find(item => item.slotId === 'chatgpt-1').error.code, 'RECOVERY_FAILED');
  assert.equal(result.results.find(item => item.slotId === 'chatgpt-2').status, 'waiting_external');
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

test('adaptive backpressure reduces effective claim capacity by one step on UI queue pressure without changing configured max', async () => {
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
        return { status: 'waiting_external', state };
      }
    })
  });

  await scheduler.runAutoOnce();
  const status = await scheduler.getStatus();

  assert.deepEqual(calls, ['chatgpt-1', 'chatgpt-2', 'chatgpt-3', 'chatgpt-4']);
  assert.equal(status.max_parallel_tasks, 5);
  assert.equal(status.effective_parallel_tasks, 4);
  assert.equal(status.adaptive_backpressure.state, 'throttled');
  assert.deepEqual(status.adaptive_backpressure.reasons, ['ui_queue_backlog']);
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

test('adaptive backpressure restores one capacity step after each ninety second healthy window', async () => {
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

  now = new Date('2026-08-26T12:02:29.000Z');
  await scheduler.runAutoOnce();
  assert.equal((await scheduler.getStatus()).effective_parallel_tasks, 3);

  now = new Date('2026-08-26T12:02:31.000Z');
  await scheduler.runAutoOnce();
  assert.equal((await scheduler.getStatus()).effective_parallel_tasks, 4);

  now = new Date('2026-08-26T12:04:02.000Z');
  await scheduler.runAutoOnce();
  assert.equal((await scheduler.getStatus()).effective_parallel_tasks, 5);
  assert.equal(ADAPTIVE_BACKPRESSURE_HEALTHY_STEP_MS, 90 * 1000);
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
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    slotStore: new BrowserTabSlotStore(shared),
    now: () => new Date('2026-08-27T10:00:00.000Z'),
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

test('direct configured max increase from Options immediately expands a normal backpressure state', async () => {
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
    now: () => new Date('2026-08-26T12:00:00.000Z'),
    pressureProvider: () => ({ pending: 0 }),
    createController: ({ slotId, storage }) => makeStatusController({
      slotId, storage,
      runAutoOnce: async () => { calls.push(slotId); return { status: 'idle', state: null }; }
    })
  });

  await scheduler.runAutoOnce();
  assert.deepEqual(calls, ['chatgpt-1', 'chatgpt-2', 'chatgpt-3', 'chatgpt-4', 'chatgpt-5']);
  assert.equal((await scheduler.getStatus()).effective_parallel_tasks, 5);
});

test('project create selector circuit opens after two consecutive failures and stops draining the Task queue', async () => {
  const shared = memoryStorage({ settings: { mode: 'real', maxParallelTasks: 2 }, autoRunEnabled: true });
  let nowMs = Date.parse('2026-08-27T04:40:00.000Z');
  let calls = 0;
  const scheduler = new MultiSlotRuntimeController({
    storage: shared,
    now: () => new Date(nowMs),
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

  const first = await scheduler.runAutoOnce();
  const status = await scheduler.getStatus();

  assert.equal(calls, 2);
  assert.equal(status.project_create_circuit.state, 'open');
  assert.equal(status.project_create_circuit.project_id, 'vetatool');
  assert.ok(first.results.some(result => result.status === 'project_create_circuit_open'));

  await scheduler.runAutoOnce();
  assert.equal(calls, 2);

  nowMs += 5 * 60 * 1000 + 1;
  const halfOpen = await scheduler.getStatus();
  assert.equal(halfOpen.project_create_circuit.state, 'half_open');
});

test('project create selector circuit closes automatically after one successful half-open Project creation', async () => {
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
