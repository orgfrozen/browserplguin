import { createSlotStorageView } from './task-store.js';
import { ERROR_CODES } from '../shared/errors.js';

const MAX_PARALLEL_TASKS = 5;
const ADAPTIVE_BACKPRESSURE_STATE_KEY = 'adaptiveBackpressureState';
const PROJECT_CREATE_CIRCUIT_STATE_KEY = 'projectCreateCircuitState';
const DUPLICATE_EXECUTION_CONFLICT_STATE_KEY = 'duplicateExecutionConflictState';
const IDLE_CLAIM_SELF_HEAL_STATE_KEY = 'idleClaimSelfHealState';
export const PROJECT_CREATE_CIRCUIT_WINDOW_MS = 10 * 60 * 1000;
export const PROJECT_CREATE_CIRCUIT_OPEN_MS = 5 * 60 * 1000;
export const PROJECT_CREATE_CIRCUIT_THRESHOLD = 2;
export const ADAPTIVE_BACKPRESSURE_WINDOW_MS = 2 * 60 * 1000;
export const ADAPTIVE_BACKPRESSURE_STEP_DOWN_COOLDOWN_MS = 60 * 1000;
export const ADAPTIVE_BACKPRESSURE_HEALTHY_STEP_MS = 5 * 60 * 1000;
export const CHATGPT_LAUNCH_SPACING_MS = 15 * 1000;
export const CHATGPT_FAILURE_COOLDOWN_MIN_MS = 15 * 1000;
export const CHATGPT_FAILURE_COOLDOWN_MAX_MS = 30 * 1000;
const CHATGPT_ACCESS_LIMIT_COOLDOWN_STEPS_MS = [5, 10, 15, 30].map(minutes => minutes * 60 * 1000);
export const ADAPTIVE_BACKPRESSURE_UI_PENDING_THRESHOLD = 3;
export const SLOT_WATCHDOG_STALL_MS = 20 * 60 * 1000;
const IDLE_CLAIM_SELF_HEAL_TICK_THRESHOLD = 3;
const IDLE_CLAIM_SELF_HEAL_COOLDOWN_MS = 5 * 60 * 1000;
const WATCHDOG_PHASES = new Set(['RUNNING', 'RECOVERING']);
const TERMINAL_REFILL_STATUSES = new Set(['completed', 'released', 'failed', 'context_limit', 'lease_lost', 'terminated', 'waiting_external']);

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

function staleTimestamp(value, nowMs, stallMs) {
  const timestampMs = Date.parse(value ?? '');
  if (!Number.isFinite(timestampMs)) return null;
  const ageMs = nowMs - timestampMs;
  return ageMs >= stallMs ? { timestamp_ms: timestampMs, age_ms: ageMs } : null;
}

function classifyWatchdogStall(slot, activeExecution, nowMs, stallMs) {
  const layers = [
    ['tab', 'slot_tab_unavailable', slot.last_tab_alive_at],
    ['dom', 'slot_dom_unresponsive', slot.last_dom_alive_at],
    ['execution_heartbeat', 'slot_execution_heartbeat_stalled', slot.last_execution_heartbeat_at],
    ...(activeExecution?.in_flight_round?.stage === 'PROMPT_SENT'
      ? [['model_progress', 'slot_model_progress_stalled', activeExecution.last_meaningful_progress_at]]
      : []),
    ['legacy_progress', 'slot_progress_stalled', slot.last_progress_at]
  ];
  for (const [layer, reason, timestamp] of layers) {
    const stale = staleTimestamp(timestamp, nowMs, stallMs);
    if (stale) return { layer, reason, last_alive_at: new Date(stale.timestamp_ms).toISOString(), stalled_ms: stale.age_ms };
  }
  return null;
}

export class MultiSlotRuntimeController {
  constructor({ storage, createController, slotStore = null, closeIdleSlot = null, openRecoveryCircuit = null, pressureProvider = null, now = () => new Date(), random = Math.random, watchdogStallMs = SLOT_WATCHDOG_STALL_MS } = {}) {
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
    this.random = typeof random === 'function' ? random : Math.random;
    this.watchdogStallMs = Math.max(60000, Number(watchdogStallMs) || SLOT_WATCHDOG_STALL_MS);
    this.watchdogRunning = false;
    this.projectCreateCircuitUpdate = Promise.resolve();
    this.launchGateUpdate = Promise.resolve();
    this.pressureStateUpdate = Promise.resolve();
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

  #defaultIdleClaimSelfHealState() {
    return {
      idle_tick_count: 0,
      last_attempt_at: null,
      last_result: null,
      last_recovered_task_id: null
    };
  }

  async #readIdleClaimSelfHealState() {
    const stored = await this.storage.get(IDLE_CLAIM_SELF_HEAL_STATE_KEY);
    if (!stored || typeof stored !== 'object') return this.#defaultIdleClaimSelfHealState();
    return {
      ...this.#defaultIdleClaimSelfHealState(),
      ...structuredClone(stored),
      idle_tick_count: Math.max(0, Number.isInteger(Number(stored.idle_tick_count)) ? Number(stored.idle_tick_count) : 0)
    };
  }

  async #saveIdleClaimSelfHealState(patch) {
    const current = await this.#readIdleClaimSelfHealState();
    const next = { ...current, ...structuredClone(patch) };
    await this.storage.set(IDLE_CLAIM_SELF_HEAL_STATE_KEY, next);
    return next;
  }

  async #resetIdleClaimObservation() {
    const current = await this.#readIdleClaimSelfHealState();
    if (current.idle_tick_count === 0) return current;
    return this.#saveIdleClaimSelfHealState({ idle_tick_count: 0 });
  }

  async #runIdleClaimSelfHeal() {
    const now = this.now();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const current = await this.#readIdleClaimSelfHealState();
    const lastAttemptMs = Date.parse(current.last_attempt_at ?? '');
    if (Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs < IDLE_CLAIM_SELF_HEAL_COOLDOWN_MS) {
      await this.#saveIdleClaimSelfHealState({ idle_tick_count: 0 });
      return null;
    }

    const idleTickCount = current.idle_tick_count + 1;
    if (idleTickCount < IDLE_CLAIM_SELF_HEAL_TICK_THRESHOLD) {
      await this.#saveIdleClaimSelfHealState({ idle_tick_count: idleTickCount });
      return null;
    }

    const slotId = 'chatgpt-1';
    const storage = this.#slotStorage(slotId);
    if ((await storage.get('activeExecution'))?.task_id) {
      await this.#resetIdleClaimObservation();
      return null;
    }

    let reconciliation;
    try {
      reconciliation = await this.#controller(slotId).recoverRealIfNeeded();
    } catch (error) {
      reconciliation = {
        status: 'recovery_failed',
        error: {
          code: typeof error?.code === 'string' ? error.code : 'UNEXPECTED',
          message: typeof error?.message === 'string' ? error.message : String(error)
        }
      };
    }

    const activeAfterReconciliation = await storage.get('activeExecution');
    const reconciledTaskId = activeAfterReconciliation?.task_id ?? taskIdFromResult(reconciliation) ?? null;
    let refill = null;
    if (!reconciledTaskId && !['recovery_failed', 'recovery_circuit_open'].includes(reconciliation?.status)) {
      refill = await this.#runAutoSlot(slotId, { allowRefill: true });
    }

    const activeExecution = await storage.get('activeExecution');
    const refillTaskId = activeExecution?.task_id ?? taskIdFromResult(refill) ?? null;
    const recoveredTaskId = reconciledTaskId ?? refillTaskId;
    const result = reconciledTaskId
      ? 'recovered_current'
      : refillTaskId ? 'refill_claimed'
        : reconciliation?.status === 'recovery_failed' ? 'reconcile_failed' : 'no_current_assignment';
    const state = await this.#saveIdleClaimSelfHealState({
      idle_tick_count: 0,
      last_attempt_at: nowIso,
      last_result: result,
      last_recovered_task_id: recoveredTaskId
    });
    return {
      status: 'idle_claim_self_heal',
      slot_id: slotId,
      reconciliation,
      refill,
      state
    };
  }

  #defaultBackpressureState(configuredMax) {
    return {
      effective_parallel_tasks: configuredMax,
      state: 'normal',
      reasons: [],
      last_pressure_reasons: [],
      last_pressure_at: null,
      last_adjustment_at: null,
      healthy_since: null,
      page_failure_breadth: 0,
      pressure_level: 'normal',
      cooldown_until: null,
      access_limit_count: 0,
      last_access_limit_at: null,
      next_launch_at: null,
      last_launch_at: null,
      last_launch_slot_id: null,
      launch_spacing_ms: CHATGPT_LAUNCH_SPACING_MS,
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
      last_pressure_reasons: Array.isArray(stored.last_pressure_reasons) ? stored.last_pressure_reasons.filter(value => typeof value === 'string') : [],
      metrics: stored.metrics && typeof stored.metrics === 'object'
        ? { ...this.#defaultBackpressureState(configuredMax).metrics, ...structuredClone(stored.metrics) }
        : this.#defaultBackpressureState(configuredMax).metrics
    };
  }

  async #updatePressureState(mutator) {
    const update = async () => {
      const configuredMax = await this.#maxParallelTasks();
      const current = await this.#readBackpressureState(configuredMax);
      const next = await mutator(structuredClone(current), configuredMax);
      if (!next || typeof next !== 'object') return current;
      await this.storage.set(ADAPTIVE_BACKPRESSURE_STATE_KEY, next);
      return next;
    };
    const pending = this.pressureStateUpdate.then(update, update);
    this.pressureStateUpdate = pending.catch(() => {});
    return pending;
  }

  #accessLimitCooldownMs(count) {
    const index = Math.min(CHATGPT_ACCESS_LIMIT_COOLDOWN_STEPS_MS.length - 1, Math.max(0, Number(count) - 1));
    return CHATGPT_ACCESS_LIMIT_COOLDOWN_STEPS_MS[index];
  }

  async #recordPressureOutcome(result) {
    if (result?.error?.code !== ERROR_CODES.CHATGPT_ACCESS_LIMITED) return null;
    const now = this.now();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    return this.#updatePressureState(current => {
      const previousLimitMs = Date.parse(current.last_access_limit_at ?? '');
      const recent = Number.isFinite(previousLimitMs) && nowMs - previousLimitMs >= 0 && nowMs - previousLimitMs <= 60 * 60 * 1000;
      const accessLimitCount = recent ? Math.max(0, Number(current.access_limit_count) || 0) + 1 : 1;
      const cooldownMs = this.#accessLimitCooldownMs(accessLimitCount);
      return {
        ...current,
        effective_parallel_tasks: 1,
        state: 'cooldown',
        pressure_level: 'cooldown',
        reasons: ['chatgpt_access_limit'],
        last_pressure_reasons: ['chatgpt_access_limit'],
        last_pressure_at: nowIso,
        last_adjustment_at: nowIso,
        healthy_since: null,
        page_failure_breadth: 0,
        cooldown_until: new Date(nowMs + cooldownMs).toISOString(),
        access_limit_count: accessLimitCount,
        last_access_limit_at: nowIso
      };
    });
  }

  async #recordGlobalLaunch(slotId) {
    const now = this.now();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    return this.#updatePressureState(current => ({
      ...current,
      last_launch_at: nowIso,
      last_launch_slot_id: slotId,
      next_launch_at: new Date(nowMs + CHATGPT_LAUNCH_SPACING_MS).toISOString(),
      launch_spacing_ms: CHATGPT_LAUNCH_SPACING_MS
    }));
  }

  #failureCooldownMs() {
    const span = CHATGPT_FAILURE_COOLDOWN_MAX_MS - CHATGPT_FAILURE_COOLDOWN_MIN_MS;
    const sample = Math.min(1, Math.max(0, Number(this.random()) || 0));
    return CHATGPT_FAILURE_COOLDOWN_MIN_MS + Math.floor(span * sample);
  }

  async #deferLaunchAfterTerminal(slotId, result) {
    const storage = this.#slotStorage(slotId);
    if ((await storage.get('activeExecution'))?.task_id) return null;
    if (!taskIdFromResult(result)) return null;
    const terminalLike = TERMINAL_REFILL_STATUSES.has(result?.status) || result?.status === 'cleanup_pending';
    if (!terminalLike) return null;
    const failureLike = Boolean(result?.error)
      || ['failed', 'released', 'context_limit', 'lease_lost', 'terminated', 'cleanup_pending'].includes(result?.status);
    const delayMs = failureLike ? this.#failureCooldownMs() : CHATGPT_LAUNCH_SPACING_MS;
    const nowMs = this.now().getTime();
    const nextAt = new Date(nowMs + delayMs).toISOString();
    await storage.set('nextChatGptLaunchAt', nextAt);
    await this.#updatePressureState(current => {
      const existingMs = Date.parse(current.next_launch_at ?? '');
      return {
        ...current,
        next_launch_at: new Date(Math.max(Number.isFinite(existingMs) ? existingMs : 0, nowMs + delayMs)).toISOString(),
        launch_spacing_ms: CHATGPT_LAUNCH_SPACING_MS
      };
    });
    return nextAt;
  }

  async #runLaunchGatedAttempt(slotId, method = 'runAutoOnce') {
    const attempt = async () => {
      const storage = this.#slotStorage(slotId);
      const active = await storage.get('activeExecution');
      if (active?.task_id) return this.#controller(slotId)[method]();
      const nowMs = this.now().getTime();
      const backpressure = await this.#evaluateBackpressure(await this.#maxParallelTasks());
      const cooldownMs = Date.parse(backpressure.cooldown_until ?? '');
      if (backpressure.state === 'cooldown' && Number.isFinite(cooldownMs) && nowMs < cooldownMs) {
        return { status: 'pressure_cooldown', cooldown_until: backpressure.cooldown_until };
      }
      const slotNext = await storage.get('nextChatGptLaunchAt');
      const slotNextMs = Date.parse(slotNext ?? '');
      if (Number.isFinite(slotNextMs) && nowMs < slotNextMs) {
        return { status: 'slot_cooldown', next_launch_at: slotNext };
      }
      const globalNextMs = Date.parse(backpressure.next_launch_at ?? '');
      if (Number.isFinite(globalNextMs) && nowMs < globalNextMs) {
        return { status: 'launch_throttled', next_launch_at: backpressure.next_launch_at };
      }
      if (Number.isFinite(slotNextMs) && nowMs >= slotNextMs) {
        if (typeof storage.remove === 'function') await storage.remove('nextChatGptLaunchAt');
        else await storage.set('nextChatGptLaunchAt', undefined);
      }
      let result;
      try {
        result = await this.#controller(slotId)[method]();
      } catch (error) {
        if (error?.code === ERROR_CODES.CHATGPT_ACCESS_LIMITED) {
          await this.#recordPressureOutcome({ status: 'failed', error: { code: error.code, message: error.message } });
        }
        throw error;
      }
      const activeAfter = await storage.get('activeExecution');
      const launched = Boolean(activeAfter?.task_id)
        || (Boolean(taskIdFromResult(result)) && !['idle', 'no_active_task', 'no_recovery'].includes(result?.status));
      if (launched) await this.#recordGlobalLaunch(slotId);
      return result;
    };
    const pending = this.launchGateUpdate.then(attempt, attempt);
    this.launchGateUpdate = pending.catch(() => {});
    return pending;
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
        const activeExecution = await this.#slotStorage(slot.slot_id).get('activeExecution');
        if (!activeExecution?.task_id || activeExecution.task_id !== slot.task_id) continue;
        const hasRecentRecovery = Array.isArray(slot.recovery_attempts) && slot.recovery_attempts.some(value => {
          const time = Date.parse(value);
          return Number.isFinite(time) && nowMs - time >= 0 && nowMs - time <= ADAPTIVE_BACKPRESSURE_WINDOW_MS;
        });
        if (hasRecentRecovery) recoveringSlots += 1;
        const observedAt = Date.parse(slot.last_observed_at ?? '');
        const progressAt = Date.parse(slot.last_progress_at ?? '');
        const recentObservation = Number.isFinite(observedAt) && nowMs - observedAt >= 0 && nowMs - observedAt <= ADAPTIVE_BACKPRESSURE_WINDOW_MS;
        const progressedAfterFailure = Number.isFinite(progressAt) && Number.isFinite(observedAt) && progressAt > observedAt;
        if (recentObservation && !progressedAfterFailure && (slot.last_response_failure || slot.last_observation_error)) failingSlots += 1;
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
    let pageFailureBreadth = Math.max(0, Number(current.page_failure_breadth) || 0);
    let cooldownUntil = current.cooldown_until ?? null;
    let pressureLevel = current.pressure_level ?? (current.state === 'throttled' ? 'throttled' : 'normal');
    let state;

    const cooldownUntilMs = Date.parse(cooldownUntil ?? '');
    if (current.state === 'cooldown' && Number.isFinite(cooldownUntilMs) && nowMs < cooldownUntilMs) {
      effective = 1;
      healthySince = null;
      pageFailureBreadth = 0;
      pressureLevel = 'cooldown';
      state = 'cooldown';
    } else if (current.state === 'cooldown') {
      effective = 1;
      cooldownUntil = null;
      healthySince = nowIso;
      lastAdjustmentAt = nowIso;
      pageFailureBreadth = 0;
      pressureLevel = 'cautious';
      state = configuredMax > 1 ? 'recovering' : 'normal';
    } else if (signals.pressure) {
      const lastAdjustmentMs = Date.parse(lastAdjustmentAt ?? '');
      const hasPageFailure = signals.reasons.includes('multi_slot_page_failure');
      const repeatablePressure = signals.reasons.some(reason => reason !== 'multi_slot_page_failure');
      const pageFailureEscalated = hasPageFailure && signals.metrics.failing_slots > pageFailureBreadth;
      const canStepDown = !Number.isFinite(lastAdjustmentMs) || nowMs - lastAdjustmentMs >= ADAPTIVE_BACKPRESSURE_STEP_DOWN_COOLDOWN_MS;
      if (effective > 1 && canStepDown && (repeatablePressure || pageFailureEscalated)) {
        effective -= 1;
        lastAdjustmentAt = nowIso;
        if (hasPageFailure) pageFailureBreadth = Math.max(pageFailureBreadth, signals.metrics.failing_slots);
      }
      if (!hasPageFailure) pageFailureBreadth = 0;
      healthySince = null;
      pressureLevel = effective <= 1 ? 'throttled' : 'cautious';
      state = 'throttled';
    } else if (effective < configuredMax) {
      pageFailureBreadth = 0;
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
      pressureLevel = effective < configuredMax ? 'cautious' : 'normal';
    } else {
      effective = configuredMax;
      healthySince = null;
      pageFailureBreadth = 0;
      state = 'normal';
      pressureLevel = 'normal';
    }

    const next = {
      ...current,
      effective_parallel_tasks: effective,
      state,
      pressure_level: pressureLevel,
      cooldown_until: cooldownUntil,
      reasons: state === 'cooldown'
        ? (current.reasons?.length ? current.reasons : ['chatgpt_access_limit'])
        : signals.pressure ? signals.reasons : [],
      last_pressure_reasons: signals.pressure ? signals.reasons : current.last_pressure_reasons ?? [],
      last_pressure_at: signals.pressure ? nowIso : current.last_pressure_at ?? null,
      last_adjustment_at: lastAdjustmentAt,
      healthy_since: healthySince,
      page_failure_breadth: pageFailureBreadth,
      metrics: signals.metrics,
      ...(state === 'normal' && effective >= configuredMax ? { access_limit_count: 0 } : {})
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


  async #parkedSlotIds() {
    const parked = [];
    for (let index = 1; index <= MAX_PARALLEL_TASKS; index += 1) {
      const slotId = slotIdFor(index);
      const waits = await this.#slotStorage(slotId).get('parkedExternalWaits');
      if (Array.isArray(waits) && waits.some(item => item?.task_id)) parked.push(slotId);
    }
    return parked;
  }

  async #cleanupRetrySlotIds() {
    const parked = [];
    for (let index = 1; index <= MAX_PARALLEL_TASKS; index += 1) {
      const slotId = slotIdFor(index);
      const retries = await this.#slotStorage(slotId).get('parkedCleanupRetries');
      if (Array.isArray(retries) && retries.some(item => item?.task_id)) parked.push(slotId);
    }
    return parked;
  }

  async #statusSlotIds(maxParallelTasks) {
    const ids = new Set();
    for (let index = 1; index <= maxParallelTasks; index += 1) ids.add(slotIdFor(index));
    for (const slotId of await this.#activeSlotIds()) ids.add(slotId);
    for (const slotId of await this.#parkedSlotIds()) ids.add(slotId);
    for (const slotId of await this.#cleanupRetrySlotIds()) ids.add(slotId);
    return [...ids].sort((left, right) => slotIndex(left) - slotIndex(right));
  }

  async getStatus() {
    const maxParallelTasks = await this.#maxParallelTasks();
    const backpressure = await this.#readBackpressureState(maxParallelTasks);
    const projectCreateCircuit = await this.#readProjectCreateCircuitState();
    const slotIds = await this.#statusSlotIds(maxParallelTasks);
    const statuses = await Promise.all(slotIds.map(async slotId => ({
      slotId,
      status: await this.#controller(slotId).getStatus(),
      scheduler: (await this.#slotStorage(slotId).get('schedulerTelemetry')) ?? null,
      agentControl: (await this.#slotStorage(slotId).get('agentControlTelemetry')) ?? null
    })));
    const active = statuses.filter(item => item.status?.activeExecution);
    const sharedSettings = (await this.storage.get('settings')) ?? {};
    const paused = (await this.storage.get('manualPaused')) === true;
    const autoRunEnabled = (await this.storage.get('autoRunEnabled')) === true;
    const drainEnabled = await this.#drainEnabled();
    const nowMs = this.now().getTime();
    const pressureCooldownMs = Date.parse(backpressure.cooldown_until ?? '');
    const nextLaunchMs = Date.parse(backpressure.next_launch_at ?? '');
    const launchBlocked = (backpressure.state === 'cooldown' && Number.isFinite(pressureCooldownMs) && nowMs < pressureCooldownMs)
      || (Number.isFinite(nextLaunchMs) && nowMs < nextLaunchMs);
    const claimableTaskCount = sharedSettings.mode === 'real' && !paused && autoRunEnabled && !drainEnabled && !launchBlocked
      ? Math.max(0, backpressure.effective_parallel_tasks - active.length)
      : 0;
    let quarantinedSlotCount = 0;
    if (this.slotStore && typeof this.slotStore.list === 'function') {
      try {
        const slots = await this.slotStore.list();
        quarantinedSlotCount = slots.filter(slot => slot?.status === 'assigned' && slot?.task_id && slot?.recovery_circuit_state === 'open').length;
      } catch {
        quarantinedSlotCount = 0;
      }
    }
    const diagnosticBackpressure = structuredClone(backpressure);
    if (Number.isFinite(pressureCooldownMs)) diagnosticBackpressure.cooldown_remaining_ms = Math.max(0, pressureCooldownMs - nowMs);
    if (Number.isFinite(nextLaunchMs)) diagnosticBackpressure.next_launch_in_ms = Math.max(0, nextLaunchMs - nowMs);
    if (backpressure.state === 'recovering' && backpressure.effective_parallel_tasks < maxParallelTasks && backpressure.healthy_since) {
      const healthySinceMs = Date.parse(backpressure.healthy_since);
      const lastAdjustmentMs = Date.parse(backpressure.last_adjustment_at ?? '');
      const candidates = [];
      if (Number.isFinite(healthySinceMs)) candidates.push(healthySinceMs + ADAPTIVE_BACKPRESSURE_HEALTHY_STEP_MS);
      if (Number.isFinite(lastAdjustmentMs)) candidates.push(lastAdjustmentMs + ADAPTIVE_BACKPRESSURE_HEALTHY_STEP_MS);
      if (candidates.length > 0) {
        const nextRecoveryMs = Math.max(...candidates);
        diagnosticBackpressure.next_recovery_at = new Date(nextRecoveryMs).toISOString();
        diagnosticBackpressure.next_recovery_in_ms = Math.max(0, nextRecoveryMs - this.now().getTime());
      }
    }
    const timestampMs = value => {
      const parsed = Date.parse(value ?? '');
      return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    };
    const latestBy = (items, getTime) => items.reduce((latest, item) => (
      !latest || timestampMs(getTime(item)) > timestampMs(getTime(latest)) ? item : latest
    ), null);
    const schedulerEntries = statuses.filter(item => item.scheduler);
    const reconciliationEntries = schedulerEntries.filter(item => item.scheduler?.state === 'lease_reconciliation_wait' && item.status?.activeExecution?.phase === 'LEASE_LOST');
    const latestSchedulerEntry = latestBy(schedulerEntries, item => item.scheduler?.last_auto_tick_at);
    const preferredSchedulerEntry = reconciliationEntries.length > 0
      ? latestBy(reconciliationEntries, item => item.scheduler?.last_auto_tick_at)
      : latestSchedulerEntry;
    const commandEntries = statuses.flatMap(item => {
      const telemetry = item.agentControl ?? {};
      return ['next', 'claim'].flatMap(operation => telemetry?.[operation] ? [{ slotId: item.slotId, event: telemetry[operation] }] : []);
    });
    const latestNext = latestBy(commandEntries.filter(item => item.event?.operation === 'next'), item => item.event?.at);
    const latestClaim = latestBy(commandEntries.filter(item => item.event?.operation === 'claim'), item => item.event?.at);
    const reconciliationTimes = reconciliationEntries
      .map(item => item.scheduler?.next_retry_at)
      .filter(value => Number.isFinite(Date.parse(value ?? '')))
      .sort((left, right) => Date.parse(left) - Date.parse(right));
    const idleClaimSelfHeal = await this.#readIdleClaimSelfHealState();
    const schedulerDiagnostics = {
      state: preferredSchedulerEntry?.scheduler?.state ?? 'idle',
      slot_id: preferredSchedulerEntry?.slotId ?? null,
      task_id: preferredSchedulerEntry?.scheduler?.task_id ?? null,
      last_auto_tick_at: latestSchedulerEntry?.scheduler?.last_auto_tick_at ?? null,
      last_auto_status: latestSchedulerEntry?.scheduler?.last_auto_status ?? null,
      reconciliation_wait_count: reconciliationEntries.length,
      next_reconciliation_at: reconciliationTimes[0] ?? null,
      recovery_error_code: preferredSchedulerEntry?.scheduler?.recovery_error_code ?? null,
      recovery_control_state: preferredSchedulerEntry?.scheduler?.recovery_control_state ?? null,
      last_next: latestNext ? { slot_id: latestNext.slotId, ...structuredClone(latestNext.event) } : null,
      last_claim: latestClaim ? { slot_id: latestClaim.slotId, ...structuredClone(latestClaim.event) } : null,
      idle_claim_self_heal: idleClaimSelfHeal
    };

    const primary = active[0]?.status ?? statuses[0]?.status ?? {};
    const primaryTaskId = primary?.activeExecution?.task_id ?? null;
    const lastRunStatus = (primaryTaskId
      ? statuses.find(item => taskIdFromResult(item.status?.lastRun) === primaryTaskId)?.status
      : null) ?? statuses.find(item => item.status?.lastRun)?.status ?? primary;
    const lastRecoveryStatus = (primaryTaskId
      ? statuses.find(item => taskIdFromResult(item.status?.lastRecovery) === primaryTaskId)?.status
      : null) ?? statuses.find(item => item.status?.lastRecovery)?.status ?? primary;
    return {
      ...primary,
      running: statuses.some(item => item.status?.running === true),
      paused,
      auto_run_enabled: autoRunEnabled,
      drain_enabled: drainEnabled,
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
      claimable_task_count: claimableTaskCount,
      quarantined_slot_count: quarantinedSlotCount,
      parked_external_count: (await Promise.all(statuses.map(({ slotId }) => this.#slotStorage(slotId).get('parkedExternalWaits'))))
        .reduce((count, waits) => count + (Array.isArray(waits) ? waits.filter(item => item?.task_id).length : 0), 0),
      parked_cleanup_count: (await Promise.all(statuses.map(({ slotId }) => this.#slotStorage(slotId).get('parkedCleanupRetries'))))
        .reduce((count, retries) => count + (Array.isArray(retries) ? retries.filter(item => item?.task_id).length : 0), 0),
      max_parallel_tasks: maxParallelTasks,
      effective_parallel_tasks: backpressure.effective_parallel_tasks,
      adaptive_backpressure: diagnosticBackpressure,
      project_create_circuit: projectCreateCircuit,
      scheduler_diagnostics: schedulerDiagnostics,
      slots: statuses.map(({ slotId, status, scheduler, agentControl }) => ({
        slot_id: slotId,
        running: status?.running === true,
        activeExecution: status?.activeExecution ?? null,
        activeTrace: status?.activeTrace ?? [],
        lastRun: status?.lastRun ?? null,
        lastRecovery: status?.lastRecovery ?? null,
        scheduler: scheduler ?? status?.scheduler ?? null,
        agent_control: agentControl ?? status?.agent_control ?? null
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

  async #detachDuplicateSlot(slotId, execution) {
    const controller = this.#controller(slotId);
    if (typeof controller.detachDuplicateExecution === 'function') {
      await controller.detachDuplicateExecution({
        taskId: execution.task_id,
        assignmentId: execution.assignment_id,
        executionId: execution.execution_id
      });
    } else {
      const storage = this.#slotStorage(slotId);
      const current = await storage.get('activeExecution');
      if (
        current?.task_id === execution.task_id
        && current?.assignment_id === execution.assignment_id
        && current?.execution_id === execution.execution_id
      ) {
        if (typeof storage.remove === 'function') await storage.remove('activeExecution');
        else await storage.set('activeExecution', undefined);
      }
    }

    if (!this.slotStore || typeof this.slotStore.load !== 'function') return;
    const slot = await this.slotStore.load(slotId);
    if (!slot || slot.task_id !== execution.task_id) return;
    if (slot.managed_tab === true && this.closeIdleSlot) {
      await this.closeIdleSlot(structuredClone(slot));
      return;
    }
    if (typeof this.slotStore.release === 'function') {
      await this.slotStore.release({ taskId: execution.task_id, tabId: null, slotId });
    }
  }

  async reconcileDuplicateExecutions() {
    const entries = [];
    for (let index = 1; index <= MAX_PARALLEL_TASKS; index += 1) {
      const slotId = slotIdFor(index);
      const execution = await this.#slotStorage(slotId).get('activeExecution');
      if (execution?.task_id) entries.push({ slotId, execution });
    }

    const byTask = new Map();
    for (const entry of entries) {
      const group = byTask.get(entry.execution.task_id) ?? [];
      group.push(entry);
      byTask.set(entry.execution.task_id, group);
    }

    const conflicts = [];
    const detached = [];
    for (const [taskId, group] of byTask.entries()) {
      if (group.length < 2) continue;
      group.sort((left, right) => slotIndex(left.slotId) - slotIndex(right.slotId));
      const complete = group.every(({ execution }) => (
        typeof execution.assignment_id === 'string' && execution.assignment_id
        && typeof execution.execution_id === 'string' && execution.execution_id
      ));
      const lineages = new Set(group.map(({ execution }) => `${execution.assignment_id ?? ''}\n${execution.execution_id ?? ''}`));
      if (!complete || lineages.size !== 1) {
        conflicts.push({
          task_id: taskId,
          slots: group.map(({ slotId, execution }) => ({
            slot_id: slotId,
            assignment_id: execution.assignment_id ?? null,
            execution_id: execution.execution_id ?? null
          }))
        });
        continue;
      }

      const canonical = group[0];
      for (const duplicate of group.slice(1)) {
        await this.#detachDuplicateSlot(duplicate.slotId, duplicate.execution);
        detached.push({
          task_id: taskId,
          canonical_slot_id: canonical.slotId,
          detached_slot_id: duplicate.slotId,
          assignment_id: duplicate.execution.assignment_id,
          execution_id: duplicate.execution.execution_id
        });
      }
    }

    if (conflicts.length > 0) {
      await this.storage.set(DUPLICATE_EXECUTION_CONFLICT_STATE_KEY, {
        detected_at: this.now().toISOString(),
        conflicts: structuredClone(conflicts)
      });
    } else if (typeof this.storage.remove === 'function') {
      await this.storage.remove(DUPLICATE_EXECUTION_CONFLICT_STATE_KEY);
    }

    return {
      status: 'reconciled',
      checked: entries.length,
      detached: detached.length,
      conflicts: conflicts.length,
      duplicate_slots: detached,
      lineage_conflicts: conflicts
    };
  }

  async #reconcileIdleSlot(slot) {
    if (!slot || slot.status !== 'idle' || slot.task_id || !Number.isInteger(Number(slot.tab_id))) return 'ignored';
    const activeExecution = await this.#slotStorage(slot.slot_id).get('activeExecution');
    if (activeExecution?.task_id) return 'skipped_active';
    if (slot.managed_tab !== true) {
      if (this.slotStore && typeof this.slotStore.release === 'function') {
        await this.slotStore.release({ taskId: null, tabId: null, slotId: slot.slot_id });
        return 'detached';
      }
      return 'ignored';
    }
    if (!this.closeIdleSlot) return 'ignored';
    await this.closeIdleSlot(structuredClone(slot));
    return 'closed';
  }

  async reconcileIdleTabs() {
    if (!this.slotStore || typeof this.slotStore.list !== 'function') {
      return { status: 'unavailable', checked: 0, closed: 0, detached: 0, skipped_active: 0 };
    }
    const slots = await this.slotStore.list();
    const summary = { status: 'reconciled', checked: 0, closed: 0, detached: 0, skipped_active: 0 };
    for (const slot of slots) {
      if (!slot || slot.status !== 'idle' || slot.task_id || !Number.isInteger(Number(slot.tab_id))) continue;
      summary.checked += 1;
      const result = await this.#reconcileIdleSlot(slot);
      if (result === 'closed') summary.closed += 1;
      else if (result === 'detached') summary.detached += 1;
      else if (result === 'skipped_active') summary.skipped_active += 1;
    }
    return summary;
  }

  async #closeIdleTabIfPresent(slotId) {
    if (!this.slotStore || typeof this.slotStore.load !== 'function') return false;
    const slot = await this.slotStore.load(slotId);
    return (await this.#reconcileIdleSlot(slot)) === 'closed';
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
    const results = [];
    for (let index = 0; index < effectiveParallelTasks; index += 1) {
      const slotId = slotIdFor(index + 1);
      const activeExecution = await this.#slotStorage(slotId).get('activeExecution');
      if (activeExecution?.task_id) {
        results.push({ status: 'active', taskId: activeExecution.task_id, state: activeExecution });
        continue;
      }
      const result = await this.#runLaunchGatedAttempt(slotId, 'runReal');
      await this.#recordProjectCreateOutcome(result);
      await this.#recordPressureOutcome(result);
      await this.#deferLaunchAfterTerminal(slotId, result);
      if (result?.status === 'idle') await this.#closeIdleTabIfPresent(slotId);
      results.push(result);
    }
    return { status: 'scheduled', results };
  }

  async #runAutoSlot(slotId, { allowRefill = true } = {}) {
    const storage = this.#slotStorage(slotId);
    const hadActiveTask = Boolean((await storage.get('activeExecution'))?.task_id);
    let result;
    if (hadActiveTask) {
      try {
        result = await this.#controller(slotId).runAutoOnce();
      } catch (error) {
        if (error?.code === ERROR_CODES.CHATGPT_ACCESS_LIMITED) {
          await this.#recordPressureOutcome({ status: 'failed', error: { code: error.code, message: error.message } });
        }
        throw error;
      }
    } else {
      result = await this.#runLaunchGatedAttempt(slotId);
    }
    const circuit = await this.#recordProjectCreateOutcome(result);
    await this.#recordPressureOutcome(result);
    await this.#deferLaunchAfterTerminal(slotId, result);

    if (this.#isProjectCreateFailure(result)) {
      if (circuit.state === 'open') {
        return { status: 'project_create_circuit_open', taskId: taskIdFromResult(result), circuit, lastResult: result };
      }
      return result;
    }

    // A terminal/released slot intentionally waits for a future scheduler tick.
    // This prevents a failure/completion burst from immediately launching more ChatGPT UI work.
    if (!allowRefill && TERMINAL_REFILL_STATUSES.has(result?.status) && !(await storage.get('activeExecution'))?.task_id) {
      await this.#closeIdleTabIfPresent(slotId);
    } else if (result?.status === 'idle') {
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
    await this.reconcileDuplicateExecutions();
    await this.reconcileIdleTabs();
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
    const activeAfter = await this.#activeSlotIds();
    const parkedAfter = await this.#parkedSlotIds();
    const circuitAfter = await this.#readProjectCreateCircuitState();
    const allIdle = results.length > 0 && results.every(result => result?.status === 'idle');
    let selfHeal = null;
    if (
      !drainEnabled
      && circuitAfter.state === 'closed'
      && activeAfter.length === 0
      && parkedAfter.length === 0
      && effectiveParallelTasks > 0
      && allIdle
    ) selfHeal = await this.#runIdleClaimSelfHeal();
    else await this.#resetIdleClaimObservation();
    return {
      status: circuitAfter.state === 'open' ? 'auto_run_project_create_circuit_open' : drainEnabled ? 'auto_run_draining' : 'auto_run_scheduled',
      circuit: circuitAfter.state === 'closed' ? undefined : circuitAfter,
      results,
      ...(selfHeal ? { self_heal: selfHeal } : {})
    };
  }

  async #afterRecovery(slotId, result) {
    const activeExecution = await this.#slotStorage(slotId).get('activeExecution');
    if (!TERMINAL_REFILL_STATUSES.has(result?.status) || activeExecution?.task_id) return result;
    await this.#deferLaunchAfterTerminal(slotId, result);
    await this.#closeIdleTabIfPresent(slotId);
    return result;
  }

  async recoverRealIfNeeded() {
    await this.reconcileDuplicateExecutions();
    await this.reconcileIdleTabs();
    const activeSlotIds = await this.#activeSlotIds();
    const parkedSlotIds = await this.#parkedSlotIds();
    const cleanupRetrySlotIds = await this.#cleanupRetrySlotIds();
    const durableSlotIds = [...new Set([...activeSlotIds, ...parkedSlotIds, ...cleanupRetrySlotIds])].sort((left, right) => slotIndex(left) - slotIndex(right));
    const hasDurableSlots = durableSlotIds.length > 0;
    const slotIds = hasDurableSlots ? durableSlotIds : ['chatgpt-1'];
    const rawResults = await Promise.all(slotIds.map(async slotId => {
      const slotStorage = this.#slotStorage(slotId);
      const hasDurableExecution = Boolean((await slotStorage.get('activeExecution'))?.task_id)
        || (Array.isArray(await slotStorage.get('parkedExternalWaits')) && (await slotStorage.get('parkedExternalWaits')).some(item => item?.task_id))
        || (Array.isArray(await slotStorage.get('parkedCleanupRetries')) && (await slotStorage.get('parkedCleanupRetries')).some(item => item?.task_id));
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

    for (const result of results) {
      if (!TERMINAL_REFILL_STATUSES.has(result?.status)) continue;
      if (!(await this.#slotStorage(result.slotId).get('activeExecution'))?.task_id) await this.#deferLaunchAfterTerminal(result.slotId, result);
    }

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

  async retryCleanup(slotId = null) {
    const targetSlotId = slotId ?? (await this.#cleanupRetrySlotIds())[0] ?? null;
    if (!targetSlotId) return { status: 'no_cleanup_retry', results: [] };
    return { status: 'cleanup_retry_checked', results: [{ slotId: targetSlotId, ...(await this.#controller(targetSlotId).retryCleanup()) }] };
  }

  async recoverReal(slotId = null, { automatic = false } = {}) {
    const slotIds = slotId ? [slotId] : await this.#activeSlotIds();
    if (slotIds.length === 0) return { status: 'no_recovery', results: [] };
    const results = await Promise.all(slotIds.map(async id => {
      let slot = this.slotStore && typeof this.slotStore.load === 'function' ? await this.slotStore.load(id) : null;
      if (automatic && slot?.recovery_circuit_state === 'open') return { slotId: id, status: 'recovery_circuit_open', taskId: slot.task_id ?? null };
      if (!automatic && this.slotStore && typeof this.slotStore.resetRecoveryCircuit === 'function') {
        await this.slotStore.resetRecoveryCircuit(id);
        slot = await this.slotStore.load(id);
      }
      const recovered = await this.#controller(id).recoverReal();
      if (automatic && recovered?.status === 'recovery_blocked' && slot?.task_id) {
        const activeExecution = await this.#slotStorage(id).get('activeExecution');
        if (activeExecution?.task_id === slot.task_id) {
          const reason = recovered?.error?.code ?? 'TASK_RECOVERY_BLOCKED';
          const attempt = await this.#recordAutomaticRecovery(slot, reason, this.now().toISOString());
          if (attempt.open) return { slotId: id, ...attempt.result };
        }
      }
      return { slotId: id, ...(await this.#afterRecovery(id, recovered)) };
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
        const stall = classifyWatchdogStall(slot, activeExecution, nowMs, this.watchdogStallMs);
        if (!stall) continue;
        const reason = stall.reason;
        const attempt = await this.#recordAutomaticRecovery(slot, reason, nowIso);
        if (attempt.open) {
          results.push({ slot_id: slot.slot_id, task_id: slot.task_id, ...stall, recovery: attempt.result });
          continue;
        }
        try {
          const recovery = await this.#afterRecovery(
            slot.slot_id,
            await this.#controller(slot.slot_id).interruptAndRecover({
              type: 'slot_watchdog',
              reason,
              staleLayer: stall.layer,
              slotId: slot.slot_id,
              taskId: slot.task_id,
              stalledMs: stall.stalled_ms,
              lastAliveAt: stall.last_alive_at
            })
          );
          recovered += 1;
          results.push({ slot_id: slot.slot_id, task_id: slot.task_id, ...stall, recovery });
        } catch (error) {
          results.push({
            slot_id: slot.slot_id,
            task_id: slot.task_id,
            ...stall,
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
    if (value) await this.#resetIdleClaimObservation();
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
    if (!value) await this.#resetIdleClaimObservation();
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
    await this.#resetIdleClaimObservation();
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
