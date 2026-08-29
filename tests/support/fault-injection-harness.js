import { MultiSlotRuntimeController } from '../../src/background/multi-slot-runtime-controller.js';
import { createSlotStorageView } from '../../src/background/task-store.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
  return {
    async get(key) { return structuredClone(data.get(key)); },
    async set(key, value) { data.set(key, structuredClone(value)); },
    async remove(key) { data.delete(key); }
  };
}

export function durableExecution(index, overrides = {}) {
  return {
    task_id: `task-${index}`,
    project_id: `project-${index}`,
    assignment_id: `assignment-${index}`,
    execution_id: `execution-${index}`,
    phase: 'RUNNING',
    next_recovery_at: null,
    ...structuredClone(overrides)
  };
}

export function createFaultInjectionHarness({ maxParallelTasks = 5, startAt = '2026-08-29T00:00:00.000Z' } = {}) {
  let nowMs = Date.parse(startAt);
  if (!Number.isFinite(nowMs)) throw new TypeError('startAt must be an ISO timestamp');
  const storage = memoryStorage({
    settings: { mode: 'real', maxParallelTasks },
    autoRunEnabled: true
  });
  const queue = [];
  const claims = [];
  const recoveries = [];
  const prompts = [];
  let duplicateDetachCount = 0;
  let scheduler = null;

  const slotStorage = slotId => createSlotStorageView(storage, slotId);
  const controllerFor = ({ slotId, storage: scopedStorage }) => ({
    async getStatus() {
      return {
        running: false,
        paused: false,
        auto_run_enabled: true,
        activeExecution: (await scopedStorage.get('activeExecution')) ?? null,
        activeTrace: [],
        lastRun: null,
        lastRecovery: null,
        settings: { mode: 'real' }
      };
    },
    async runAutoOnce() {
      const active = await scopedStorage.get('activeExecution');
      if (active?.task_id) return { status: active.phase === 'WAITING_EXTERNAL' ? 'waiting_external' : 'active', taskId: active.task_id, state: active };
      const taskId = queue.shift();
      if (!taskId) return { status: 'idle', state: null };
      const ordinal = claims.length + 1;
      const state = durableExecution(ordinal, {
        task_id: taskId,
        project_id: `project-${taskId}`,
        assignment_id: `assignment-${taskId}`,
        execution_id: `execution-${taskId}`
      });
      claims.push({ slotId, taskId, at: nowMs });
      await scopedStorage.set('activeExecution', state);
      return { status: 'active', taskId, state };
    },
    async runReal() { return this.runAutoOnce(); },
    async recoverRealIfNeeded() {
      const active = await scopedStorage.get('activeExecution');
      if (!active?.task_id) return { status: 'no_recovery', state: null };
      const retryMs = Date.parse(active.next_recovery_at ?? '');
      if (!Number.isFinite(retryMs) || retryMs > nowMs) return { status: 'no_recovery', state: active };
      recoveries.push({ slotId, taskId: active.task_id, at: nowMs });
      const next = { ...active, next_recovery_at: null };
      await scopedStorage.set('activeExecution', next);
      return { status: 'active', taskId: next.task_id, state: next };
    },
    async recoverReal() { return this.recoverRealIfNeeded(); },
    async interruptAndRecover() { return this.recoverRealIfNeeded(); },
    async deferActiveRecovery({ nextRecoveryAt }) {
      const active = await scopedStorage.get('activeExecution');
      if (!active?.task_id) return { status: 'no_active_task' };
      const next = { ...active, next_recovery_at: nextRecoveryAt };
      await scopedStorage.set('activeExecution', next);
      return { status: 'recovery_deferred', taskId: active.task_id, next_recovery_at: nextRecoveryAt };
    },
    async detachDuplicateExecution(expected) {
      const active = await scopedStorage.get('activeExecution');
      if (
        active?.task_id === expected?.taskId
        && active?.assignment_id === expected?.assignmentId
        && active?.execution_id === expected?.executionId
      ) {
        duplicateDetachCount += 1;
        await scopedStorage.remove('activeExecution');
        return { status: 'duplicate_execution_detached', taskId: active.task_id };
      }
      return { status: 'duplicate_execution_detach_skipped' };
    },
    async retryCleanup() { return { status: 'no_cleanup_retry' }; },
    async pause() { return { status: 'paused' }; },
    async resume() { return { status: 'resumed' }; },
    async terminateTask() { return { status: 'no_active_task' }; }
  });

  const restartServiceWorker = async () => {
    scheduler = new MultiSlotRuntimeController({
      storage,
      createController: controllerFor,
      now: () => new Date(nowMs),
      random: () => 0.5
    });
    return scheduler;
  };

  const ensureScheduler = async () => scheduler ?? restartServiceWorker();

  return {
    async restartServiceWorker() { return restartServiceWorker(); },
    async advance(ms) { nowMs += Number(ms) || 0; },
    async advanceToNextRecovery() {
      const candidates = [];
      for (let index = 1; index <= maxParallelTasks; index += 1) {
        const active = await slotStorage(`chatgpt-${index}`).get('activeExecution');
        const retryMs = Date.parse(active?.next_recovery_at ?? '');
        if (Number.isFinite(retryMs) && retryMs > nowMs) candidates.push(retryMs);
      }
      if (candidates.length === 0) throw new Error('no future recovery is scheduled');
      nowMs = Math.min(...candidates);
      return new Date(nowMs).toISOString();
    },
    async queueTasks(taskIds) { queue.push(...taskIds); },
    async seedExecution(slotId, execution) { await slotStorage(slotId).set('activeExecution', execution); },
    async seedInfrastructureCircuit({ service = 'patchsync', retryAt, operation = null }) {
      await storage.set('infrastructureCircuitState', {
        state: 'open',
        service,
        failure_count: 1,
        opened_at: new Date(nowMs).toISOString(),
        retry_at: retryAt,
        last_service: service,
        last_failure_at: new Date(nowMs).toISOString(),
        last_error_code: service === 'patchsync' ? 'PATCHSYNC_UNREACHABLE' : 'CONTROL_PLANE_UNREACHABLE',
        last_operation: operation
      });
    },
    async seedPressureCooldown({ until }) {
      await storage.set('adaptiveBackpressureState', {
        effective_parallel_tasks: 1,
        state: 'cooldown',
        pressure_level: 'cooldown',
        cooldown_until: until,
        reasons: ['chatgpt_access_limit'],
        last_pressure_reasons: ['chatgpt_access_limit'],
        last_pressure_at: new Date(nowMs).toISOString(),
        last_adjustment_at: new Date(nowMs).toISOString(),
        healthy_since: null,
        page_failure_breadth: 0,
        metrics: { ui_queue_pending: 0, recovering_slots: 0, failing_slots: 0 }
      });
    },
    async runAutoTick() { return (await ensureScheduler()).runAutoOnce(); },
    async recoverDue() { return (await ensureScheduler()).recoverRealIfNeeded(); },
    async recoverNextDue() {
      const due = [];
      for (let index = 1; index <= maxParallelTasks; index += 1) {
        const slotId = `chatgpt-${index}`;
        const active = await slotStorage(slotId).get('activeExecution');
        const retryMs = Date.parse(active?.next_recovery_at ?? '');
        if (active?.task_id && Number.isFinite(retryMs) && retryMs <= nowMs) due.push({ slotId, retryMs });
      }
      due.sort((left, right) => left.retryMs - right.retryMs || left.slotId.localeCompare(right.slotId));
      if (due.length === 0) throw new Error('no due recovery is scheduled');
      return (await ensureScheduler()).recoverReal(due[0].slotId, { automatic: true });
    },
    recordPrompt(taskId, roundId) { prompts.push({ taskId, roundId }); },
    claimAttempts() { return structuredClone(claims); },
    claimedTaskIds() { return claims.map(item => item.taskId); },
    recoveryTaskIds() { return recoveries.map(item => item.taskId); },
    promptKeys() { return prompts.map(item => `${item.taskId}:${item.roundId}`); },
    detachedDuplicateCount() { return duplicateDetachCount; },
    hasDuplicateClaims() { return new Set(claims.map(item => item.taskId)).size !== claims.length; },
    hasDuplicateRecoveries() { return new Set(recoveries.map(item => item.taskId)).size !== recoveries.length; },
    hasDuplicatePrompts() { return new Set(prompts.map(item => `${item.taskId}:${item.roundId}`)).size !== prompts.length; },
    minimumRecoverySpacingMs() {
      if (recoveries.length < 2) return Number.POSITIVE_INFINITY;
      const ordered = recoveries.map(item => item.at).sort((left, right) => left - right);
      return Math.min(...ordered.slice(1).map((value, index) => value - ordered[index]));
    },
    async activeTaskIds() {
      const taskIds = [];
      for (let index = 1; index <= maxParallelTasks; index += 1) {
        const active = await slotStorage(`chatgpt-${index}`).get('activeExecution');
        if (active?.task_id) taskIds.push(active.task_id);
      }
      return [...new Set(taskIds)].sort();
    }
  };
}
