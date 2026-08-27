import { createSlotStorageView } from './task-store.js';

const MAX_PARALLEL_TASKS = 5;
const ADAPTIVE_BACKPRESSURE_STATE_KEY = 'adaptiveBackpressureState';
const PROJECT_CREATE_CIRCUIT_STATE_KEY = 'projectCreateCircuitState';
export const PROJECT_CREATE_CIRCUIT_WINDOW_MS = 10 * 60 * 1000;
export const PROJECT_CREATE_CIRCUIT_OPEN_MS = 5 * 60 * 1000;
export const PROJECT_CREATE_CIRCUIT_THRESHOLD = 2;
export const ADAPTIVE_BACKPRESSURE_WINDOW_MS = 10 * 60 * 1000;
export const ADAPTIVE_BACKPRESSURE_STEP_DOWN_COOLDOWN_MS = 2 * 60 * 1000;
export const ADAPTIVE_BACKPRESSURE_HEALTHY_STEP_MS = 10 * 60 * 1000;
export const ADAPTIVE_BACKPRESSURE_UI_PENDING_THRESHOLD = 3;
export const SLOT_WATCHDOG_STALL_MS = 20 * 60 * 1000;
const WATCHDOG_PHASES = new Set(['RUNNING', 'RECOVERING']);
const TERMINAL_REFILL_STATUSES = new Set(['completed', 'released', 'failed', 'context_limit', 'lease_lost', 'terminated']);

export function normalizeMaxParallelTasks(value, fallback = 1) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return fallback;
  return Math.min(MAX_PARALLEL_TASKS, Math.max(1, numeric));
}

function slotIdFor(index) {
  return `chatgpt-${index}`;
}

function slotIndex(slotId) {
  const match = /^chatgpt-(\d+)$/.exec(String(slotId ?? ''));
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function taskIdFromResult(result) {
  return result?.taskId ?? result?.task_id ?? result?.state?.task_id ?? null;
}

export class MultiSlotRuntimeController {
  constructor({ storage, createController, slotStore = null, closeIdleSlot = null, openRecoveryCircuit = null, pressureProvider = null, now = () => new Date(), watchdogStallMs = SLOT_WATCHDOG_STALL_MS } = {}) {
    if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') throw new TypeError('storage is required');
    if (typeof createController !== 'function') throw new TypeError('createController is required');
    this.storage = storage;
    this.createController = createController;
    this.slotStore = slotStore;
    this.closeIdleSlot = typeof closeIdleSlot === 'function' ? closeIdleSlot : null;
    this.openRecoveryCircuit = typeof openRecoveryCircuit === 'function' ? openRecoveryCircuit : null;
    this.pressureProvider = typeof pressureProvider === 'function' ? pressureProvider : null;
    this.controllers = new Map();
    this.slotStorages = new Map();
    this.now = now;
    this.watchdogStallMs = Math.max(60000, Number(watchdogStallMs) || SLOT_WATCHDOG_STALL_MS);
    this.watchdogRunning = false;
    this.projectCreateCircuitUpdate = Promise.resolve();
  }

  #slotStorage(slotId) {
    if (!this.slotStorages.has(slotId)) this.slotStorages.set(slotId, createSlotStorageView(this.storage, slotId));
    return this.slotStorages.get(slotId);
  }

  #controller(slotId) {
    if (!this.controllers.has(slotId)) {
      this.controllers.set(slotId, this.createController({ slotId, storage: this.#slotStorage(slotId) }));
    }
    return this.controllers.get(slotId);
  }

  #defaultProjectCreateCircuitState() {
    return {
      state: 'closed',
      project_id: null,
      failures: [],
      opened_at: null,
      retry_at: null
    };
  }

  async #readProjectCreateCircuitState() {
    const stored = await this.storage.get(PROJECT_CREATE_CIRCUIT_STATE_KEY);
    const current = stored && typeof stored === 'object'
      ? { ...this.#defaultProjectCreateCircuitState(), ...structuredClone(stored) }
      : this.#defaultProjectCreateCircuitState();
    current.failures = Array.isArray(current.failures) ? current.failures.filter(item => item && typeof item === 'object') : [];
    if (current.state === 'open') {
      const retryAt = Date.parse(current.retry_at ?? '');
      if (Number.isFinite(retryAt) && this.now().getTime() >= retryAt) {
        const halfOpen = { ...current, state: 'half_open' };
        await this.storage.set(PROJECT_CREATE_CIRCUIT_STATE_KEY, halfOpen);
        return halfOpen;
      }
    }
    return current;
  }

  #isProjectCreateFailure(result) {
    if (result?.status !== 'released' || result?.error?.code !== 'UI_SELECTOR_INCOMPATIBLE') return false;
    return /Projects section|Project creation dialog|Project name input|Created Project .* did not appear before timeout|create action/i.test(String(result?.error?.message ?? ''));
  }

  async #recordProjectCreateOutcome(result) {
    const update = async () => {
      let current = await this.#readProjectCreateCircuitState();
      const now = this.now();
      const nowMs = now.getTime();
      const nowIso = now.toISOString();
      if (this.#isProjectCreateFailure(result)) {
        const projectId = result?.state?.project_id ?? current.project_id ?? null;
        const failures = current.failures.filter(item => {
          const time = Date.parse(item.at ?? '');
          return item.project_id === projectId && Number.isFinite(time) && nowMs - time >= 0 && nowMs - time <= PROJECT_CREATE_CIRCUIT_WINDOW_MS;
        });
        failures.push({
          at: nowIso,
          project_id: projectId,
          task_id: taskIdFromResult(result),
          message: String(result?.error?.message ?? '')
        });
        if (current.state === 'half_open' || failures.length >= PROJECT_CREATE_CIRCUIT_THRESHOLD) {
          current = {
            state: 'open',
            project_id: projectId,
            failures,
            opened_at: nowIso,
            retry_at: new Date(nowMs + PROJECT_CREATE_CIRCUIT_OPEN_MS).toISOString()
          };
        } else {
          current = { ...current, state: 'closed', project_id: projectId, failures };
        }
        await this.storage.set(PROJECT_CREATE_CIRCUIT_STATE_KEY, current);
        return current;
      }
      if (current.state === 'half_open' && result?.state?.chatgpt_project_name) {
        current = this.#defaultProjectCreateCircuitState();
        await this.storage.set(PROJECT_CREATE_CIRCUIT_STATE_KEY, current);
      } else if (current.state === 'closed' && result?.state?.chatgpt_project_name && current.failures.length > 0) {
        current = this.#defaultProjectCreateCircuitState();
        await this.storage.set(PROJECT_CREATE_CIRCUIT_STATE_KEY, current);
      }
      return current;
    };
    const pending = this.projectCreateCircuitUpdate.then(update, update);
    this.projectCreateCircuitUpdate = pending.catch(() => {});
    return pending;
  }

  async #maxParallelTasks() {
    const settings = (await this.storage.get('settings')) ?? {};
    return normalizeMaxParallelTasks(settings.maxParallelTasks, 1);
  }

  async #drainEnabled() {
    return (await this.storage.get('drainEnabled')) === true;
  }

  #defaultBackpressureState(configuredMax) {
    return {
      effective_parallel_tasks: configuredMax,
      state: 'normal',
      reasons: [],
      last_pressure_at: null,
      last_adjustment_at: null,
      healthy_since: null,
      metrics: { ui_queue_pending: 0, recovering_slots: 0, failing_slots: 0 }
    };
  }

  async #readBackpressureState(configuredMax) {
    const stored = await this.storage.get(ADAPTIVE_BACKPRESSURE_STATE_KEY);
    if (!stored || typeof stored !== 'object') return this.#defaultBackpressureState(configuredMax);
    const effective = Math.min(configuredMax, normalizeMaxParallelTasks(stored.effective_parallel_tasks, configuredMax));
    return {
      ...this.#defaultBackpressureState(configuredMax),
      ...structuredClone(stored),
      effective_parallel_tasks: effective,
      reasons: Array.isArray(stored.reasons) ? stored.reasons.filter(value => typeof value === 'string') : [],
      metrics: stored.metrics && typeof stored.metrics === 'object'
        ? { ...this.#defaultBackpressureState(configuredMax).metrics, ...structuredClone(stored.metrics) }
        : this.#defaultBackpressureState(configuredMax).metrics
    };
  }

  async #collectBackpressureSignals() {
    const nowMs = this.now().getTime();
    const reasons = [];
    let queuePending = 0;
    if (this.pressureProvider) {
      try {
        const stats = await this.pressureProvider();
        queuePending = Math.max(0, Number(stats?.pending) || 0);
      } catch {
        queuePending = 0;
      }
    }
    if (queuePending >= ADAPTIVE_BACKPRESSURE_UI_PENDING_THRESHOLD) reasons.push('ui_queue_backlog');

    let recoveringSlots = 0;
    let failingSlots = 0;
    if (this.slotStore && typeof this.slotStore.list === 'function') {
      const slots = await this.slotStore.list();
      for (const slot of slots) {
        if (slot?.status !== 'assigned' || !slot?.task_id) continue;
        const hasRecentRecovery = Array.isArray(slot.recovery_attempts) && slot.recovery_attempts.some(value => {
          const time = Date.parse(value);
          return Number.isFinite(time) && nowMs - time >= 0 && nowMs - time <= ADAPTIVE_BACKPRESSURE_WINDOW_MS;
        });
        if (hasRecentRecovery) recoveringSlots += 1;
        const observedAt = Date.parse(slot.last_observed_at ?? '');
        const recentObservation = Number.isFinite(observedAt) && nowMs - observedAt >= 0 && nowMs - observedAt <= ADAPTIVE_BACKPRESSURE_WINDOW_MS;
        if (recentObservation && (slot.last_response_failure || slot.last_observation_error)) failingSlots += 1;
      }
    }
    if (recoveringSlots >= 2) reasons.push('multi_slot_recovery');
    if (failingSlots >= 2) reasons.push('multi_slot_page_failure');
    return {
      pressure: reasons.length > 0,
      reasons,
      metrics: {
        ui_queue_pending: queuePending,
        recovering_slots: recoveringSlots,
        failing_slots: failingSlots
      }
    };
  }

  async #evaluateBackpressure(configuredMax) {
    const now = this.now();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const current = await this.#readBackpressureState(configuredMax);
    const signals = await this.#collectBackpressureSignals();
    let effective = Math.min(configuredMax, normalizeMaxParallelTasks(current.effective_parallel_tasks, configuredMax));
    let lastAdjustmentAt = current.last_adjustment_at ?? null;
    let healthySince = current.healthy_since ?? null;
    let state;

    if (signals.pressure) {
      const lastAdjustmentMs = Date.parse(lastAdjustmentAt ?? '');
      if (effective > 1 && (!Number.isFinite(lastAdjustmentMs) || nowMs - lastAdjustmentMs >= ADAPTIVE_BACKPRESSURE_STEP_DOWN_COOLDOWN_MS)) {
        effective -= 1;
        lastAdjustmentAt = nowIso;
      }
      healthySince = null;
      state = 'throttled';
    } else if (effective < configuredMax && current.state === 'normal') {
      effective = configuredMax;
      healthySince = null;
      state = 'normal';
    } else if (effective < configuredMax) {
      if (!healthySince) healthySince = nowIso;
      const healthySinceMs = Date.parse(healthySince);
      const lastAdjustmentMs = Date.parse(lastAdjustmentAt ?? '');
      const healthyLongEnough = Number.isFinite(healthySinceMs) && nowMs - healthySinceMs >= ADAPTIVE_BACKPRESSURE_HEALTHY_STEP_MS;
      const adjustmentLongEnough = !Number.isFinite(lastAdjustmentMs) || nowMs - lastAdjustmentMs >= ADAPTIVE_BACKPRESSURE_HEALTHY_STEP_MS;
      if (healthyLongEnough && adjustmentLongEnough) {
        effective += 1;
        lastAdjustmentAt = nowIso;
        healthySince = effective < configuredMax ? nowIso : null;
      }
      state = effective < configuredMax ? 'recovering' : 'normal';
    } else {
      effective = configuredMax;
      healthySince = null;
      state = 'normal';
    }

    const next = {
      effective_parallel_tasks: effective,
      state,
      reasons: signals.pressure ? signals.reasons : [],
      last_pressure_at: signals.pressure ? nowIso : current.last_pressure_at ?? null,
      last_adjustment_at: lastAdjustmentAt,
      healthy_since: healthySince,
      metrics: signals.metrics
    };
    await this.storage.set(ADAPTIVE_BACKPRESSURE_STATE_KEY, next);
    return next;
  }

  async #syncBackpressureConfiguredMax(previousMax, configuredMax) {
    const current = await this.#readBackpressureState(previousMax);
    let effective = Math.min(configuredMax, current.effective_parallel_tasks);
    if (configuredMax > previousMax && current.state === 'normal') effective = configuredMax;
    const next = {
      ...current,
      effective_parallel_tasks: effective,
      state: effective < configuredMax ? (current.state === 'throttled' ? 'throttled' : 'recovering') : current.state === 'throttled' ? 'throttled' : 'normal',
      ...(effective >= configuredMax && current.state !== 'throttled' ? { healthy_since: null } : {})
    };
    await this.storage.set(ADAPTIVE_BACKPRESSURE_STATE_KEY, next);
    return next;
  }

  async #activeSlotIds() {
    const active = [];
    for (let index = 1; index <= MAX_PARALLEL_TASKS; index += 1) {
      const slotId = slotIdFor(index);
      const state = await this.#slotStorage(slotId).get('activeExecution');
      if (state?.task_id) active.push(slotId);
    }
    return active;
  }

  async #statusSlotIds(maxParallelTasks) {
    const ids = new Set();
    for (let index = 1; index <= maxParallelTasks; index += 1) ids.add(slotIdFor(index));
    for (const slotId of await this.#activeSlotIds()) ids.add(slotId);
    return [...ids].sort((left, right) => slotIndex(left) - slotIndex(right));
  }

  async getStatus() {
    const maxParallelTasks = await this.#maxParallelTasks();
    const backpressure = await this.#readBackpressureState(maxParallelTasks);
    const projectCreateCircuit = await this.#readProjectCreateCircuitState();
    const slotIds = await this.#statusSlotIds(maxParallelTasks);
    const statuses = await Promise.all(slotIds.map(async slotId => ({
      slotId,
      status: await this.#controller(slotId).getStatus()
    })));
    const active = statuses.filter(item => item.status?.activeExecution);
    const primary = active[0]?.status ?? statuses[0]?.status ?? {};
    const lastRunStatus = statuses.find(item => item.status?.lastRun)?.status ?? primary;
    const lastRecoveryStatus = statuses.find(item => item.status?.lastRecovery)?.status ?? primary;
    return {
      ...primary,
      running: statuses.some(item => item.status?.running === true),
      paused: (await this.storage.get('manualPaused')) === true,
      auto_run_enabled: (await this.storage.get('autoRunEnabled')) === true,
      drain_enabled: await this.#drainEnabled(),
      active_slot_id: active[0]?.slotId ?? null,
      activeExecution: active[0]?.status?.activeExecution ?? null,
      activeTrace: active[0]?.status?.activeTrace ?? [],
      lastRun: lastRunStatus?.lastRun ?? null,
      lastRecovery: lastRecoveryStatus?.lastRecovery ?? null,
      settings: {
        ...(primary?.settings ?? {}),
        max_parallel_tasks: maxParallelTasks
      },
      active_task_count: active.length,
      max_parallel_tasks: maxParallelTasks,
      effective_parallel_tasks: backpressure.effective_parallel_tasks,
      adaptive_backpressure: backpressure,
      project_create_circuit: projectCreateCircuit,
      slots: statuses.map(({ slotId, status }) => ({
        slot_id: slotId,
        running: status?.running === true,
        activeExecution: status?.activeExecution ?? null,
        lastRun: status?.lastRun ?? null,
        lastRecovery: status?.lastRecovery ?? null
      }))
    };
  }

  async #openRecoveryCircuit(slot, recordedSlot, reason) {
    const storage = this.#slotStorage(slot.slot_id);
    const activeExecution = await storage.get('activeExecution');
    if (activeExecution?.task_id === slot.task_id) {
      await storage.set('activeExecution', {
        ...activeExecution,
        phase: 'WAITING_HUMAN',
        next_recovery_at: null,
        browser_recovery_circuit: {
          state: 'open',
          reason,
          recovery_count: recordedSlot?.recovery_window_count ?? 0,
          opened_at: recordedSlot?.recovery_circuit_opened_at ?? this.now().toISOString()
        }
      });
    }
    const info = {
      slotId: slot.slot_id,
      taskId: slot.task_id,
      reason,
      recoveryCount: recordedSlot?.recovery_window_count ?? 0,
      openedAt: recordedSlot?.recovery_circuit_opened_at ?? this.now().toISOString()
    };
    if (this.openRecoveryCircuit) {
      try { await this.openRecoveryCircuit(structuredClone(info)); } catch { /* local circuit remains authoritative */ }
    }
    return { status: 'recovery_circuit_open', slot_id: slot.slot_id, task_id: slot.task_id, ...info };
  }

  async #recordAutomaticRecovery(slot, reason, recoveredAt) {
    if (!this.slotStore || typeof this.slotStore.recordRecovery !== 'function') return { open: false, slot };
    const recorded = await this.slotStore.recordRecovery({
      slotId: slot.slot_id,
      tabId: slot.tab_id,
      generation: slot.generation,
      reason,
      recoveredAt
    });
    if (recorded?.recovery_circuit_state === 'open') {
      return { open: true, result: await this.#openRecoveryCircuit(slot, recorded, reason), slot: recorded };
    }
    return { open: false, slot: recorded ?? slot };
  }

  async #closeIdleTabIfPresent(slotId) {
    if (!this.slotStore || !this.closeIdleSlot) return false;
    const slot = await this.slotStore.load(slotId);
    if (!slot || slot.status !== 'idle' || slot.task_id || !Number.isInteger(Number(slot.tab_id))) return false;
    await this.closeIdleSlot(structuredClone(slot));
    return true;
  }

  async #runSlotOnce(slotId, method) {
    const controller = this.#controller(slotId);
    const result = await controller[method]();
    if (result?.status === 'idle') await this.#closeIdleTabIfPresent(slotId);
    return result;
  }

  async runMock(taskId = null) {
    return this.#controller('chatgpt-1').runMock(taskId);
  }

  async runReal() {
    const settings = (await this.storage.get('settings')) ?? {};
    if (settings.mode !== 'real') return { status: 'mode_not_real', results: [] };
    if ((await this.storage.get('manualPaused')) === true) return { status: 'paused', results: [] };
    if (await this.#drainEnabled()) return { status: 'draining', results: [] };
    const maxParallelTasks = await this.#maxParallelTasks();
    const backpressure = await this.#evaluateBackpressure(maxParallelTasks);
    const effectiveParallelTasks = backpressure.effective_parallel_tasks;
    const results = await Promise.all(
      Array.from({ length: effectiveParallelTasks }, async (_, index) => {
        const slotId = slotIdFor(index + 1);
        const activeExecution = await this.#slotStorage(slotId).get('activeExecution');
        if (activeExecution?.task_id) return { status: 'active', taskId: activeExecution.task_id, state: activeExecution };
        return this.#runSlotOnce(slotId, 'runReal');
      })
    );
    return { status: 'scheduled', results };
  }

  async #runAutoSlot(slotId, { allowRefill = true } = {}) {
    const storage = this.#slotStorage(slotId);
    let result = await this.#controller(slotId).runAutoOnce();
    let circuit = await this.#recordProjectCreateOutcome(result);
    if (this.#isProjectCreateFailure(result)) {
      if (circuit.state === 'open') {
        return { status: 'project_create_circuit_open', taskId: taskIdFromResult(result), circuit, lastResult: result };
      }
      return result;
    }
    while (allowRefill && TERMINAL_REFILL_STATUSES.has(result?.status) && !(await storage.get('activeExecution'))?.task_id) {
      circuit = await this.#readProjectCreateCircuitState();
      if (circuit.state !== 'closed') break;
      result = await this.#controller(slotId).runAutoOnce();
      circuit = await this.#recordProjectCreateOutcome(result);
      if (this.#isProjectCreateFailure(result)) {
        if (circuit.state === 'open') return { status: 'project_create_circuit_open', taskId: taskIdFromResult(result), circuit, lastResult: result };
        break;
      }
    }
    if (result?.status === 'idle' || (!allowRefill && TERMINAL_REFILL_STATUSES.has(result?.status) && !(await storage.get('activeExecution'))?.task_id)) {
      await this.#closeIdleTabIfPresent(slotId);
    }
    return result;
  }

  async #fillIdleCapacity(maxParallelTasks = null, excludedSlotIds = new Set()) {
    const limit = maxParallelTasks === null ? await this.#maxParallelTasks() : maxParallelTasks;
    const results = [];
    for (let index = 1; index <= limit; index += 1) {
      const slotId = slotIdFor(index);
      if (excludedSlotIds.has(slotId)) continue;
      if ((await this.#slotStorage(slotId).get('activeExecution'))?.task_id) continue;
      results.push({ slotId, ...(await this.#runAutoSlot(slotId, { allowRefill: true })) });
    }
    return results;
  }

  async runAutoOnce() {
    if ((await this.storage.get('autoRunEnabled')) !== true) return { status: 'auto_run_disabled', results: [] };
    if ((await this.storage.get('manualPaused')) === true) return { status: 'auto_run_paused', results: [] };
    const settings = (await this.storage.get('settings')) ?? {};
    if (settings.mode !== 'real') return { status: 'auto_run_mode_not_real', results: [] };
    const maxParallelTasks = await this.#maxParallelTasks();
    const backpressure = await this.#evaluateBackpressure(maxParallelTasks);
    const effectiveParallelTasks = backpressure.effective_parallel_tasks;
    const drainEnabled = await this.#drainEnabled();
    const circuit = await this.#readProjectCreateCircuitState();
    const activeSlotIds = await this.#activeSlotIds();
    const slotIds = new Set(activeSlotIds);
    if (!drainEnabled && circuit.state === 'closed') {
      for (let index = 1; index <= effectiveParallelTasks; index += 1) slotIds.add(slotIdFor(index));
    } else if (!drainEnabled && circuit.state === 'half_open' && activeSlotIds.length === 0) {
      slotIds.add('chatgpt-1');
    }
    if (slotIds.size === 0 && circuit.state === 'open') {
      return { status: 'auto_run_project_create_circuit_open', circuit, results: [] };
    }
    const results = await Promise.all([...slotIds]
      .sort((left, right) => slotIndex(left) - slotIndex(right))
      .map(async slotId => {
        const hasActiveTask = Boolean((await this.#slotStorage(slotId).get('activeExecution'))?.task_id);
        const withinCapacity = slotIndex(slotId) <= effectiveParallelTasks;
        const allowHalfOpenClaim = circuit.state === 'half_open' && activeSlotIds.length === 0 && slotId === 'chatgpt-1';
        const claimBlocked = circuit.state === 'open' || (circuit.state === 'half_open' && !allowHalfOpenClaim);
        if (!hasActiveTask && (drainEnabled || !withinCapacity || claimBlocked)) {
          return { slotId, status: claimBlocked ? 'project_create_circuit_open' : 'draining' };
        }
        return {
          slotId,
          ...(await this.#runAutoSlot(slotId, { allowRefill: !drainEnabled && !claimBlocked && circuit.state === 'closed' && withinCapacity }))
        };
      }));
    return {
      status: circuit.state === 'open' ? 'auto_run_project_create_circuit_open' : drainEnabled ? 'auto_run_draining' : 'auto_run_scheduled',
      circuit: circuit.state === 'closed' ? undefined : circuit,
      results
    };
  }

  async #afterRecovery(slotId, result) {
    const activeExecution = await this.#slotStorage(slotId).get('activeExecution');
    if (!TERMINAL_REFILL_STATUSES.has(result?.status) || activeExecution?.task_id) return result;
    const settings = (await this.storage.get('settings')) ?? {};
    const canRefill = settings.mode === 'real'
      && (await this.storage.get('autoRunEnabled')) === true
      && (await this.storage.get('manualPaused')) !== true
      && !(await this.#drainEnabled())
      && slotIndex(slotId) <= (await this.#evaluateBackpressure(await this.#maxParallelTasks())).effective_parallel_tasks;
    if (canRefill) return { ...result, refill: await this.#runAutoSlot(slotId) };
    await this.#closeIdleTabIfPresent(slotId);
    return result;
  }

  async recoverRealIfNeeded() {
    const activeSlotIds = await this.#activeSlotIds();
    const hasDurableSlots = activeSlotIds.length > 0;
    const slotIds = hasDurableSlots ? activeSlotIds : ['chatgpt-1'];
    const rawResults = await Promise.all(slotIds.map(async slotId => {
      const hasDurableExecution = Boolean((await this.#slotStorage(slotId).get('activeExecution'))?.task_id);
      if (!hasDurableExecution && hasDurableSlots) return null;
      const slot = this.slotStore && typeof this.slotStore.load === 'function' ? await this.slotStore.load(slotId) : null;
      if (slot?.recovery_circuit_state === 'open') return { slotId, status: 'recovery_circuit_open', taskId: slot.task_id ?? null };
      try {
        return { slotId, ...(await this.#controller(slotId).recoverRealIfNeeded()) };
      } catch (error) {
        const failure = {
          status: 'recovery_failed',
          error: {
            code: typeof error?.code === 'string' ? error.code : 'UNEXPECTED',
            message: typeof error?.message === 'string' ? error.message : String(error)
          }
        };
        try { await this.#slotStorage(slotId).set('lastRecovery', failure); } catch { /* recovery status is best-effort */ }
        return { slotId, ...failure };
      }
    }));
    const results = rawResults.filter(Boolean).filter(result => (
      result?.status !== 'no_recovery' || result?.state || taskIdFromResult(result) || hasDurableSlots
    ));

    const settings = (await this.storage.get('settings')) ?? {};
    const canRefill = settings.mode === 'real'
      && (await this.storage.get('autoRunEnabled')) === true
      && (await this.storage.get('manualPaused')) !== true
      && !(await this.#drainEnabled());
    const failedSlotIds = new Set(results.filter(result => ['recovery_failed', 'recovery_circuit_open'].includes(result?.status)).map(result => result.slotId));
    const effectiveParallelTasks = canRefill ? (await this.#evaluateBackpressure(await this.#maxParallelTasks())).effective_parallel_tasks : 0;
    const refill = canRefill ? await this.#fillIdleCapacity(effectiveParallelTasks, failedSlotIds) : [];

    for (const result of results) {
      if (result?.status === 'recovery_failed' || !TERMINAL_REFILL_STATUSES.has(result?.status)) continue;
      if (!(await this.#slotStorage(result.slotId).get('activeExecution'))?.task_id) await this.#closeIdleTabIfPresent(result.slotId);
    }

    return { status: results.length > 0 ? 'recovery_checked' : 'no_recovery', results, refill };
  }

  async recoverReal(slotId = null, { automatic = false } = {}) {
    const slotIds = slotId ? [slotId] : await this.#activeSlotIds();
    if (slotIds.length === 0) return { status: 'no_recovery', results: [] };
    const results = await Promise.all(slotIds.map(async id => {
      const slot = this.slotStore && typeof this.slotStore.load === 'function' ? await this.slotStore.load(id) : null;
      if (automatic && slot?.recovery_circuit_state === 'open') return { slotId: id, status: 'recovery_circuit_open', taskId: slot.task_id ?? null };
      if (!automatic && this.slotStore && typeof this.slotStore.resetRecoveryCircuit === 'function') await this.slotStore.resetRecoveryCircuit(id);
      return { slotId: id, ...(await this.#afterRecovery(id, await this.#controller(id).recoverReal())) };
    }));
    return { status: 'recovery_checked', results };
  }

  async runWatchdogOnce() {
    if ((await this.storage.get('manualPaused')) === true) return { status: 'paused', checked: 0, recovered: 0, results: [] };
    if (this.watchdogRunning) return { status: 'busy', checked: 0, recovered: 0, results: [] };
    if (!this.slotStore || typeof this.slotStore.list !== 'function') return { status: 'unavailable', checked: 0, recovered: 0, results: [] };
    const settings = (await this.storage.get('settings')) ?? {};
    if (settings.mode !== 'real') return { status: 'mode_not_real', checked: 0, recovered: 0, results: [] };

    this.watchdogRunning = true;
    try {
      const now = this.now();
      const nowMs = now.getTime();
      const nowIso = now.toISOString();
      const slots = (await this.slotStore.list()).filter(slot => slot?.status === 'assigned' && slot?.task_id);
      const results = [];
      let recovered = 0;
      for (const slot of slots) {
        const activeExecution = await this.#slotStorage(slot.slot_id).get('activeExecution');
        if (!activeExecution?.task_id || activeExecution.task_id !== slot.task_id || !WATCHDOG_PHASES.has(activeExecution.phase)) continue;
        const lastProgressMs = Date.parse(slot.last_progress_at ?? '');
        if (!Number.isFinite(lastProgressMs) || nowMs - lastProgressMs < this.watchdogStallMs) continue;
        const reason = 'slot_progress_stalled';
        const attempt = await this.#recordAutomaticRecovery(slot, reason, nowIso);
        if (attempt.open) {
          results.push({ slot_id: slot.slot_id, task_id: slot.task_id, reason, stalled_ms: nowMs - lastProgressMs, recovery: attempt.result });
          continue;
        }
        try {
          const recovery = await this.#afterRecovery(
            slot.slot_id,
            await this.#controller(slot.slot_id).interruptAndRecover({
              type: 'slot_watchdog',
              reason,
              slotId: slot.slot_id,
              taskId: slot.task_id,
              stalledMs: nowMs - lastProgressMs
            })
          );
          recovered += 1;
          results.push({ slot_id: slot.slot_id, task_id: slot.task_id, reason, stalled_ms: nowMs - lastProgressMs, recovery });
        } catch (error) {
          results.push({
            slot_id: slot.slot_id,
            task_id: slot.task_id,
            reason,
            stalled_ms: nowMs - lastProgressMs,
            error: { code: error?.code ?? 'UNEXPECTED', message: error?.message ?? String(error) }
          });
        }
      }
      return { status: 'checked', checked: slots.length, recovered, results };
    } finally {
      this.watchdogRunning = false;
    this.projectCreateCircuitUpdate = Promise.resolve();
    }
  }


  async setMaxParallelTasks(value) {
    const current = (await this.storage.get('settings')) ?? {};
    const previous = normalizeMaxParallelTasks(current.maxParallelTasks, 1);
    const maxParallelTasks = normalizeMaxParallelTasks(value, previous);
    await this.storage.set('settings', { ...current, maxParallelTasks });
    await this.#syncBackpressureConfiguredMax(previous, maxParallelTasks);
    const backpressure = await this.#evaluateBackpressure(maxParallelTasks);
    let refill = [];
    if (
      maxParallelTasks > previous
      && (await this.storage.get('autoRunEnabled')) === true
      && (await this.storage.get('manualPaused')) !== true
      && !(await this.#drainEnabled())
      && current.mode === 'real'
    ) {
      refill = await this.#fillIdleCapacity(backpressure.effective_parallel_tasks);
    }
    return {
      status: 'max_parallel_tasks_updated',
      max_parallel_tasks: maxParallelTasks,
      effective_parallel_tasks: backpressure.effective_parallel_tasks,
      previous_max_parallel_tasks: previous,
      active_task_count: (await this.#activeSlotIds()).length,
      refill
    };
  }

  async setDrainEnabled(enabled) {
    const value = enabled === true;
    await this.storage.set('drainEnabled', value);
    const settings = (await this.storage.get('settings')) ?? {};
    let refill = [];
    if (
      !value
      && (await this.storage.get('autoRunEnabled')) === true
      && (await this.storage.get('manualPaused')) !== true
      && settings.mode === 'real'
    ) {
      const maxParallelTasks = await this.#maxParallelTasks();
      refill = await this.#fillIdleCapacity((await this.#evaluateBackpressure(maxParallelTasks)).effective_parallel_tasks);
    }
    return {
      status: value ? 'drain_enabled' : 'drain_disabled',
      enabled: value,
      active_task_count: (await this.#activeSlotIds()).length,
      refill
    };
  }

  async setAutoRunEnabled(enabled) {
    const value = enabled === true;
    const wasPaused = (await this.storage.get('manualPaused')) === true;
    await this.storage.set('autoRunEnabled', value);
    if (value && wasPaused) await this.storage.set('manualPaused', false);
    const recovery = value && wasPaused ? await this.recoverRealIfNeeded() : null;
    return {
      status: value ? 'auto_run_enabled' : 'auto_run_disabled',
      enabled: value,
      resumed: value && wasPaused,
      ...(recovery ? { recovery } : {})
    };
  }

  async pause() {
    await this.storage.set('manualPaused', true);
    const slotIds = await this.#statusSlotIds(await this.#maxParallelTasks());
    await Promise.all(slotIds.map(slotId => this.#controller(slotId).pause()));
    return { status: 'paused' };
  }

  async resume() {
    await this.storage.set('manualPaused', false);
    return { status: 'resumed', recovery: await this.recoverRealIfNeeded() };
  }

  async terminateTask(slotId = null) {
    let targetSlotId = slotId;
    if (!targetSlotId) targetSlotId = (await this.#activeSlotIds())[0] ?? null;
    if (!targetSlotId) return { status: 'no_active_task' };
    const controller = this.#controller(targetSlotId);
    try {
      return { slot_id: targetSlotId, ...(await controller.terminateTask()) };
    } catch (error) {
      try { await controller.recoverRealIfNeeded(); } catch { /* keep the original termination error */ }
      throw error;
    }
  }

  async handleTabRemoved(tabId, reason = 'removed') {
    if (!this.slotStore) return { status: 'ignored', reason: 'slot_store_unavailable' };
    const slot = await this.slotStore.findByTabId(tabId);
    if (!slot?.task_id || slot.status !== 'assigned') return { status: 'ignored', reason: 'idle_or_unowned_tab' };
    const recoveryReason = `worker_tab_${reason}`;
    const attempt = await this.#recordAutomaticRecovery(slot, recoveryReason, this.now().toISOString());
    if (attempt.open) return attempt.result;
    const result = await this.#afterRecovery(
      slot.slot_id,
      await this.#controller(slot.slot_id).interruptAndRecover({ type: 'worker_tab_lost', reason, tabId })
    );
    return { status: 'recovery_triggered', slot_id: slot.slot_id, task_id: slot.task_id, recovery: result };
  }
}
