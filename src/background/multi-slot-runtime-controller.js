import { createSlotStorageView } from './task-store.js';
import { ERROR_CODES } from '../shared/errors.js';
import { isConfirmedExecutionControlLoss } from './heartbeat-manager.js';
import { CHATGPT_RUNTIME_TELEMETRY_STATE_KEY, buildChatGptRuntimeTelemetrySnapshot } from './chatgpt-runtime-telemetry.js';

const MAX_PARALLEL_TASKS = 5;
const ADAPTIVE_BACKPRESSURE_STATE_KEY = 'adaptiveBackpressureState';
const PROJECT_CREATE_CIRCUIT_STATE_KEY = 'projectCreateCircuitState';
const DUPLICATE_EXECUTION_CONFLICT_STATE_KEY = 'duplicateExecutionConflictState';
const IDLE_CLAIM_SELF_HEAL_STATE_KEY = 'idleClaimSelfHealState';
const INFRASTRUCTURE_CIRCUIT_STATE_KEY = 'infrastructureCircuitState';
const RECOVERY_STORM_STATE_KEY = 'recoveryStormState';
export const PROJECT_CREATE_CIRCUIT_WINDOW_MS = 10 * 60 * 1000;
export const PROJECT_CREATE_CIRCUIT_OPEN_MS = 5 * 60 * 1000;
export const PROJECT_CREATE_CIRCUIT_THRESHOLD = 2;
export const ADAPTIVE_BACKPRESSURE_WINDOW_MS = 2 * 60 * 1000;
export const ADAPTIVE_BACKPRESSURE_STEP_DOWN_COOLDOWN_MS = 60 * 1000;
export const ADAPTIVE_BACKPRESSURE_HEALTHY_STEP_MS = 5 * 60 * 1000;
export const CHATGPT_LAUNCH_SPACING_MS = 15 * 1000;
export const RECOVERY_RESUME_SPACING_MS = 5 * 1000;
export const CHATGPT_FAILURE_COOLDOWN_MIN_MS = 15 * 1000;
export const CHATGPT_FAILURE_COOLDOWN_MAX_MS = 30 * 1000;
const CHATGPT_ACCESS_LIMIT_COOLDOWN_STEPS_MS = [5, 10, 15, 30].map(minutes => minutes * 60 * 1000);
export const ADAPTIVE_BACKPRESSURE_UI_PENDING_THRESHOLD = 3;
export const SLOT_WATCHDOG_STALL_MS = 20 * 60 * 1000;
const IDLE_CLAIM_SELF_HEAL_TICK_THRESHOLD = 3;
const IDLE_CLAIM_SELF_HEAL_COOLDOWN_MS = 5 * 60 * 1000;
const INFRASTRUCTURE_RETRY_BACKOFF_MS = Object.freeze([5000, 10000, 20000, 30000]);
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
  constructor({ storage, createController, slotStore = null, closeIdleSlot = null, openRecoveryCircuit = null, pressureProvider = null, accessProbe = null, now = () => new Date(), random = Math.random, watchdogStallMs = SLOT_WATCHDOG_STALL_MS } = {}) {
    if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') throw new TypeError('storage is required');
    if (typeof createController !== 'function') throw new TypeError('createController is required');
    this.storage = storage;
    this.createController = createController;
    this.slotStore = slotStore;
    this.closeIdleSlot = typeof closeIdleSlot === 'function' ? closeIdleSlot : null;
    this.openRecoveryCircuit = typeof openRecoveryCircuit === 'function' ? openRecoveryCircuit : null;
    this.pressureProvider = typeof pressureProvider === 'function' ? pressureProvider : null;
    this.accessProbe = typeof accessProbe === 'function' ? accessProbe : null;
    this.controllers = new Map();
    this.slotStorages = new Map();
    this.now = now;
    this.random = typeof random === 'function' ? random : Math.random;
    this.watchdogStallMs = Math.max(60000, Number(watchdogStallMs) || SLOT_WATCHDOG_STALL_MS);
    this.watchdogRunning = false;
    this.projectCreateCircuitUpdate = Promise.resolve();
    this.launchGateUpdate = Promise.resolve();
    this.recoveryGateUpdate = Promise.resolve();
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

  #defaultInfrastructureCircuitState() {
    return {
      state: 'closed',
      service: null,
      failure_count: 0,
      opened_at: null,
      retry_at: null,
      last_service: null,
      last_failure_at: null,
      last_error_code: null,
      last_operation: null
    };
  }

  async #readInfrastructureCircuitState() {
    const stored = await this.storage.get(INFRASTRUCTURE_CIRCUIT_STATE_KEY);
    if (!stored || typeof stored !== 'object') return this.#defaultInfrastructureCircuitState();
    return { ...this.#defaultInfrastructureCircuitState(), ...structuredClone(stored) };
  }

  #infrastructureRetryDelayMs(failureCount) {
    const index = Math.min(INFRASTRUCTURE_RETRY_BACKOFF_MS.length - 1, Math.max(0, Number(failureCount) - 1));
    return INFRASTRUCTURE_RETRY_BACKOFF_MS[index];
  }

  async #recordInfrastructureFailure(service, error, { operation = null, retryAt = null } = {}) {
    const current = await this.#readInfrastructureCircuitState();
    const now = this.now();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const sameService = current.state === 'open' && current.service === service;
    const failureCount = sameService ? Math.max(0, Number(current.failure_count) || 0) + 1 : 1;
    const explicitRetryMs = Date.parse(retryAt ?? '');
    const nextRetryAt = Number.isFinite(explicitRetryMs)
      ? new Date(Math.max(nowMs, explicitRetryMs)).toISOString()
      : new Date(nowMs + this.#infrastructureRetryDelayMs(failureCount)).toISOString();
    const next = {
      state: 'open',
      service,
      failure_count: failureCount,
      opened_at: sameService && current.opened_at ? current.opened_at : nowIso,
      retry_at: nextRetryAt,
      last_service: service,
      last_failure_at: nowIso,
      last_error_code: typeof error?.code === 'string' ? error.code : service === 'control_plane' ? ERROR_CODES.CONTROL_PLANE_UNREACHABLE : 'UNEXPECTED',
      last_operation: operation ?? error?.details?.operation ?? null
    };
    await this.storage.set(INFRASTRUCTURE_CIRCUIT_STATE_KEY, next);
    return next;
  }

  async #closeInfrastructureCircuit(service) {
    const current = await this.#readInfrastructureCircuitState();
    if (current.state !== 'open' || current.service !== service) return current;
    const next = {
      ...current,
      state: 'closed',
      service: null,
      failure_count: 0,
      opened_at: null,
      retry_at: null
    };
    await this.storage.set(INFRASTRUCTURE_CIRCUIT_STATE_KEY, next);
    return next;
  }

  #isControlPlaneNetworkError(error) {
    if (error?.code === ERROR_CODES.CONTROL_PLANE_UNREACHABLE) return true;
    if (Number.isInteger(Number(error?.status))) return false;
    return /failed to fetch|network(?:error)?|fetch failed|connection (?:refused|reset)|temporarily unavailable/i.test(String(error?.message ?? error ?? ''));
  }

  #isControlPlaneProtocolMismatch(error) {
    return Number(error?.status) === 400
      && error?.code === 'invalid_agent_control_command'
      && /unsupported command field:\s*command_id\b/i.test(String(error?.message ?? ''));
  }

  #controlPlaneInfrastructureError(error) {
    if (this.#isControlPlaneProtocolMismatch(error)) {
      return {
        code: ERROR_CODES.CONTROL_PLANE_PROTOCOL_MISMATCH,
        message: 'Control Plane Agent Control protocol is older than this browser extension; waiting for a compatible deployment'
      };
    }
    if (this.#isControlPlaneNetworkError(error)) {
      return {
        code: ERROR_CODES.CONTROL_PLANE_UNREACHABLE,
        message: 'Control Plane is temporarily unavailable'
      };
    }
    return null;
  }

  async #hasActiveInfrastructureWait(service) {
    for (const slotId of await this.#activeSlotIds()) {
      const active = await this.#slotStorage(slotId).get('activeExecution');
      if (active?.infrastructure_wait?.service === service) return true;
    }
    return false;
  }

  async #infrastructureLaunchWait() {
    const circuit = await this.#readInfrastructureCircuitState();
    if (circuit.state !== 'open' || !circuit.service) return null;
    if (circuit.service === 'patchsync' && await this.#hasActiveInfrastructureWait('patchsync')) return circuit;
    const retryAtMs = Date.parse(circuit.retry_at ?? '');
    if (Number.isFinite(retryAtMs) && this.now().getTime() < retryAtMs) return circuit;
    return null;
  }

  #infraWaitResult(circuit, error = null) {
    const service = circuit?.service ?? 'control_plane';
    const code = service === 'patchsync' ? ERROR_CODES.PATCHSYNC_UNREACHABLE : ERROR_CODES.CONTROL_PLANE_UNREACHABLE;
    return {
      status: 'infra_retry_wait',
      service,
      retry_at: circuit?.retry_at ?? null,
      error: {
        code: error?.code ?? code,
        message: error?.message ?? (service === 'patchsync' ? 'PatchSync API is temporarily unavailable' : 'Control Plane is temporarily unavailable')
      }
    };
  }

  async #recordInfrastructureResult(result, { activeExecutionBefore = null } = {}) {
    if (result?.error?.code === ERROR_CODES.PATCHSYNC_UNREACHABLE) {
      return this.#recordInfrastructureFailure('patchsync', result.error, {
        operation: result.error?.details?.operation ?? result.state?.infrastructure_wait?.operation ?? null,
        retryAt: result.state?.next_recovery_at ?? result.state?.infrastructure_wait?.next_retry_at ?? null
      });
    }
    if (
      activeExecutionBefore?.infrastructure_wait?.service === 'patchsync'
      && result?.status !== 'source_retry_pending'
      && result?.state?.infrastructure_wait?.service !== 'patchsync'
    ) return this.#closeInfrastructureCircuit('patchsync');
    return null;
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
      last_access_limit_confirmed: null,
      last_access_probe_at: null,
      last_access_probe_status: null,
      last_access_probe_checked_tabs: 0,
      last_access_probe_ready_tabs: 0,
      last_access_probe_limited_tabs: 0,
      last_access_probe_unavailable_tabs: 0,
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

  async #probeChatGptAccess() {
    if (!this.accessProbe) return null;
    const checkedAt = this.now().toISOString();
    try {
      const result = await this.accessProbe();
      return {
        status: ['healthy', 'limited', 'unknown'].includes(result?.status) ? result.status : 'unknown',
        checked_at: checkedAt,
        checked_tabs: Math.max(0, Number(result?.checked_tabs) || 0),
        ready_tabs: Math.max(0, Number(result?.ready_tabs) || 0),
        limited_tabs: Math.max(0, Number(result?.limited_tabs) || 0),
        unavailable_tabs: Math.max(0, Number(result?.unavailable_tabs) || 0)
      };
    } catch {
      return { status: 'unknown', checked_at: checkedAt, checked_tabs: 0, ready_tabs: 0, limited_tabs: 0, unavailable_tabs: 0 };
    }
  }

  #withAccessProbe(current, probe, confirmed) {
    if (!probe) return { ...current, last_access_limit_confirmed: confirmed };
    return {
      ...current,
      last_access_limit_confirmed: confirmed,
      last_access_probe_at: probe.checked_at,
      last_access_probe_status: probe.status,
      last_access_probe_checked_tabs: probe.checked_tabs,
      last_access_probe_ready_tabs: probe.ready_tabs,
      last_access_probe_limited_tabs: probe.limited_tabs,
      last_access_probe_unavailable_tabs: probe.unavailable_tabs
    };
  }

  async #recordPressureOutcome(result) {
    if (result?.error?.code !== ERROR_CODES.CHATGPT_ACCESS_LIMITED) return null;
    const now = this.now();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const probe = await this.#probeChatGptAccess();
    if (probe?.status === 'healthy') {
      return this.#updatePressureState(current => this.#withAccessProbe({
        ...current,
        state: current.state === 'cooldown' ? 'recovering' : current.state,
        reasons: [],
        pressure_level: current.state === 'cooldown' ? 'cautious' : current.pressure_level,
        cooldown_until: null,
        last_access_limit_at: nowIso
      }, probe, false));
    }
    return this.#updatePressureState(current => {
      const previousLimitMs = Date.parse(current.last_access_limit_at ?? '');
      const recent = Number.isFinite(previousLimitMs) && nowMs - previousLimitMs >= 0 && nowMs - previousLimitMs <= 60 * 60 * 1000;
      const accessLimitCount = recent ? Math.max(0, Number(current.access_limit_count) || 0) + 1 : 1;
      const cooldownMs = this.#accessLimitCooldownMs(accessLimitCount);
      return this.#withAccessProbe({
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
      }, probe, true);
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
      const infrastructureWait = await this.#infrastructureLaunchWait();
      if (infrastructureWait) return this.#infraWaitResult(infrastructureWait);
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
          const pressure = await this.#recordPressureOutcome({ status: 'failed', error: { code: error.code, message: error.message, details: error.details ?? null } });
          const activeAfterLimit = await storage.get('activeExecution');
          if (activeAfterLimit?.task_id && pressure?.cooldown_until && typeof this.#controller(slotId).deferActiveRecovery === 'function') {
            await this.#controller(slotId).deferActiveRecovery({ nextRecoveryAt: pressure.cooldown_until });
            return { status: 'pressure_cooldown', taskId: activeAfterLimit.task_id, cooldown_until: pressure.cooldown_until };
          }
        }
        const infrastructureError = this.#controlPlaneInfrastructureError(error);
        if (infrastructureError) {
          const circuit = await this.#recordInfrastructureFailure('control_plane', infrastructureError, { operation: 'claim_or_resume' });
          const activeAfterFailure = await storage.get('activeExecution');
          if (activeAfterFailure?.task_id && circuit.retry_at && typeof this.#controller(slotId).deferActiveRecovery === 'function') {
            await this.#controller(slotId).deferActiveRecovery({ nextRecoveryAt: circuit.retry_at });
          }
          return this.#infraWaitResult(circuit, infrastructureError);
        }
        throw error;
      }
      await this.#closeInfrastructureCircuit('control_plane');
      await this.#recordInfrastructureResult(result);
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

  async #gateAutomaticRecovery(slotId) {
    const attempt = async () => {
      const slotStorage = this.#slotStorage(slotId);
      const activeExecution = await slotStorage.get('activeExecution');
      if (!activeExecution?.task_id) return { allowed: true };

      const now = this.now();
      const nowMs = now.getTime();
      const reservation = await slotStorage.get('recoveryLaunchReservedAt');
      const reservationMs = Date.parse(reservation ?? '');
      const stored = await this.storage.get(RECOVERY_STORM_STATE_KEY);
      const storm = stored && typeof stored === 'object' ? stored : {};
      const lastRecoveryMs = Date.parse(storm.last_recovery_at ?? '');
      const nextRecoveryMs = Date.parse(storm.next_recovery_at ?? '');
      const earliestAfterLast = Number.isFinite(lastRecoveryMs)
        ? lastRecoveryMs + RECOVERY_RESUME_SPACING_MS
        : nowMs;

      if (Number.isFinite(reservationMs)) {
        if (nowMs < reservationMs) {
          await this.#controller(slotId).deferActiveRecovery({ nextRecoveryAt: new Date(reservationMs).toISOString() });
          return { allowed: false, retryAt: new Date(reservationMs).toISOString() };
        }
        if (nowMs < earliestAfterLast) {
          const retryAt = new Date(earliestAfterLast).toISOString();
          await slotStorage.set('recoveryLaunchReservedAt', retryAt);
          await this.#controller(slotId).deferActiveRecovery({ nextRecoveryAt: retryAt });
          await this.storage.set(RECOVERY_STORM_STATE_KEY, {
            ...storm,
            next_recovery_at: new Date(Math.max(Date.parse(storm.next_recovery_at ?? '') || 0, earliestAfterLast + RECOVERY_RESUME_SPACING_MS)).toISOString()
          });
          return { allowed: false, retryAt };
        }
        await slotStorage.remove('recoveryLaunchReservedAt');
        await this.storage.set(RECOVERY_STORM_STATE_KEY, {
          last_recovery_at: now.toISOString(),
          next_recovery_at: new Date(nowMs + RECOVERY_RESUME_SPACING_MS).toISOString(),
          last_slot_id: slotId
        });
        return { allowed: true };
      }

      const allowAtMs = Math.max(
        nowMs,
        Number.isFinite(nextRecoveryMs) ? nextRecoveryMs : nowMs,
        earliestAfterLast
      );
      if (allowAtMs > nowMs) {
        const retryAt = new Date(allowAtMs).toISOString();
        await slotStorage.set('recoveryLaunchReservedAt', retryAt);
        await this.storage.set(RECOVERY_STORM_STATE_KEY, {
          ...storm,
          next_recovery_at: new Date(allowAtMs + RECOVERY_RESUME_SPACING_MS).toISOString()
        });
        await this.#controller(slotId).deferActiveRecovery({ nextRecoveryAt: retryAt });
        return { allowed: false, retryAt };
      }

      await this.storage.set(RECOVERY_STORM_STATE_KEY, {
        last_recovery_at: now.toISOString(),
        next_recovery_at: new Date(nowMs + RECOVERY_RESUME_SPACING_MS).toISOString(),
        last_slot_id: slotId
      });
      return { allowed: true };
    };
    const pending = this.recoveryGateUpdate.then(attempt, attempt);
    this.recoveryGateUpdate = pending.catch(() => {});
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
    let current = await this.#readBackpressureState(configuredMax);
    const currentCooldownMs = Date.parse(current.cooldown_until ?? '');
    if (current.state === 'cooldown' && Number.isFinite(currentCooldownMs) && nowMs < currentCooldownMs) {
      const probe = await this.#probeChatGptAccess();
      if (probe?.status === 'healthy') {
        current = this.#withAccessProbe({
          ...current,
          state: configuredMax > 1 ? 'recovering' : 'normal',
          pressure_level: configuredMax > 1 ? 'cautious' : 'normal',
          reasons: [],
          cooldown_until: null,
          healthy_since: nowIso,
          last_adjustment_at: nowIso
        }, probe, false);
        await this.storage.set(ADAPTIVE_BACKPRESSURE_STATE_KEY, current);
      }
    }
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

  #isInteractiveExecution(state) {
    return Boolean(state?.task_id) && state?.phase !== 'WAITING_EXTERNAL';
  }

  async #activeExecutionEntries() {
    const active = [];
    for (let index = 1; index <= MAX_PARALLEL_TASKS; index += 1) {
      const slotId = slotIdFor(index);
      const state = await this.#slotStorage(slotId).get('activeExecution');
      if (state?.task_id) active.push({ slotId, state });
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
    const infrastructureCircuit = await this.#readInfrastructureCircuitState();
    const projectCreateCircuit = await this.#readProjectCreateCircuitState();
    const slotIds = await this.#statusSlotIds(maxParallelTasks);
    const statuses = await Promise.all(slotIds.map(async slotId => ({
      slotId,
      status: await this.#controller(slotId).getStatus(),
      scheduler: (await this.#slotStorage(slotId).get('schedulerTelemetry')) ?? null,
      agentControl: (await this.#slotStorage(slotId).get('agentControlTelemetry')) ?? null
    })));
    const active = statuses.filter(item => item.status?.activeExecution);
    const interactiveActive = active.filter(item => this.#isInteractiveExecution(item.status?.activeExecution));
    const sharedSettings = (await this.storage.get('settings')) ?? {};
    const paused = (await this.storage.get('manualPaused')) === true;
    const autoRunEnabled = (await this.storage.get('autoRunEnabled')) === true;
    const drainEnabled = await this.#drainEnabled();
    const nowMs = this.now().getTime();
    const pressureCooldownMs = Date.parse(backpressure.cooldown_until ?? '');
    const nextLaunchMs = Date.parse(backpressure.next_launch_at ?? '');
    const launchBlocked = (backpressure.state === 'cooldown' && Number.isFinite(pressureCooldownMs) && nowMs < pressureCooldownMs)
      || (Number.isFinite(nextLaunchMs) && nowMs < nextLaunchMs);
    const infrastructureBlocked = infrastructureCircuit.state === 'open';
    const claimableTaskCount = sharedSettings.mode === 'real' && !paused && autoRunEnabled && !drainEnabled && !launchBlocked && !infrastructureBlocked
      ? Math.max(0, Math.min(
        maxParallelTasks - active.length,
        backpressure.effective_parallel_tasks - interactiveActive.length
      ))
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
    const diagnosticInfrastructureCircuit = structuredClone(infrastructureCircuit);
    const infrastructureRetryMs = Date.parse(infrastructureCircuit.retry_at ?? '');
    if (Number.isFinite(infrastructureRetryMs)) {
      diagnosticInfrastructureCircuit.retry_remaining_ms = Math.max(0, infrastructureRetryMs - nowMs);
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

    const runtimeTelemetry = buildChatGptRuntimeTelemetrySnapshot(
      await this.storage.get(CHATGPT_RUNTIME_TELEMETRY_STATE_KEY),
      this.now
    );
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
      interactive_task_count: interactiveActive.length,
      claimable_task_count: claimableTaskCount,
      quarantined_slot_count: quarantinedSlotCount,
      parked_external_count: (await Promise.all(statuses.map(({ slotId }) => this.#slotStorage(slotId).get('parkedExternalWaits'))))
        .reduce((count, waits) => count + (Array.isArray(waits) ? waits.filter(item => item?.task_id).length : 0), 0),
      parked_cleanup_count: (await Promise.all(statuses.map(({ slotId }) => this.#slotStorage(slotId).get('parkedCleanupRetries'))))
        .reduce((count, retries) => count + (Array.isArray(retries) ? retries.filter(item => item?.task_id).length : 0), 0),
      max_parallel_tasks: maxParallelTasks,
      effective_parallel_tasks: backpressure.effective_parallel_tasks,
      adaptive_backpressure: diagnosticBackpressure,
      infrastructure_circuit: diagnosticInfrastructureCircuit,
      project_create_circuit: projectCreateCircuit,
      scheduler_diagnostics: schedulerDiagnostics,
      chatgpt_runtime_telemetry: runtimeTelemetry,
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

  async #repairLegacyRecoveryCircuit(slotId, slot) {
    if (!slot || slot.recovery_circuit_state !== 'open') return slot;
    const storage = this.#slotStorage(slotId);
    const activeExecution = await storage.get('activeExecution');
    const legacyFinalizingBlock = activeExecution?.task_id === slot.task_id
      && activeExecution.phase === 'WAITING_HUMAN'
      && activeExecution.terminal_reason === 'SUCCESS'
      && activeExecution.terminal_action === 'COMPLETE'
      && activeExecution.recovery_error?.code === ERROR_CODES.TASK_RECOVERY_BLOCKED
      && activeExecution.recovery_error?.message === 'Recovery is not enabled for phase=FINALIZING'
      && activeExecution.browser_recovery_circuit?.state === 'open';
    const legacyProtocolSkewBlock = activeExecution?.task_id === slot.task_id
      && activeExecution.phase === 'WAITING_HUMAN'
      && this.#isControlPlaneProtocolMismatch({
        status: 400,
        code: activeExecution.recovery_error?.code,
        message: activeExecution.recovery_error?.message
      })
      && activeExecution.browser_recovery_circuit?.state === 'open';
    const legacyExecutionControlLoss = activeExecution?.task_id === slot.task_id
      && activeExecution.phase === 'WAITING_HUMAN'
      && isConfirmedExecutionControlLoss({ code: activeExecution.recovery_error?.code })
      && activeExecution.browser_recovery_circuit?.state === 'open';
    if (!legacyFinalizingBlock && !legacyProtocolSkewBlock && !legacyExecutionControlLoss) return slot;

    const repairedAt = this.now().toISOString();
    await storage.set('activeExecution', {
      ...activeExecution,
      phase: legacyFinalizingBlock ? 'FINALIZING' : legacyExecutionControlLoss ? 'LEASE_LOST' : 'RUNNING',
      recovery_error: null,
      next_recovery_at: null,
      browser_recovery_circuit: null,
      ...(legacyExecutionControlLoss ? {
        lease_loss: {
          ...(activeExecution.lease_loss ?? {}),
          at: activeExecution.lease_loss?.at ?? repairedAt,
          code: activeExecution.recovery_error?.code ?? 'EXECUTION_CONTROL_LOST',
          message: activeExecution.recovery_error?.message ?? 'Execution control was lost'
        }
      } : {})
    });
    if (this.slotStore && typeof this.slotStore.resetRecoveryCircuit === 'function') {
      await this.slotStore.resetRecoveryCircuit(slotId);
      return this.slotStore.load(slotId);
    }
    return { ...slot, recovery_circuit_state: 'closed', recovery_window_count: 0 };
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
    const activeExecutionBefore = await storage.get('activeExecution');
    const hadActiveTask = Boolean(activeExecutionBefore?.task_id);
    let result;
    if (hadActiveTask) {
      try {
        result = await this.#controller(slotId).runAutoOnce();
      } catch (error) {
        if (error?.code === ERROR_CODES.CHATGPT_ACCESS_LIMITED) {
          const pressure = await this.#recordPressureOutcome({ status: 'failed', error: { code: error.code, message: error.message, details: error.details ?? null } });
          if (activeExecutionBefore?.task_id && pressure?.cooldown_until && typeof this.#controller(slotId).deferActiveRecovery === 'function') {
            await this.#controller(slotId).deferActiveRecovery({ nextRecoveryAt: pressure.cooldown_until });
            return { status: 'pressure_cooldown', taskId: activeExecutionBefore.task_id, cooldown_until: pressure.cooldown_until };
          }
        }
        const infrastructureError = this.#controlPlaneInfrastructureError(error);
        if (infrastructureError) {
          const circuit = await this.#recordInfrastructureFailure('control_plane', infrastructureError, { operation: 'active_execution' });
          if (this.#isControlPlaneProtocolMismatch(error)) {
            if (activeExecutionBefore?.task_id && circuit.retry_at && typeof this.#controller(slotId).deferActiveRecovery === 'function') {
              await this.#controller(slotId).deferActiveRecovery({ nextRecoveryAt: circuit.retry_at });
            }
            return this.#infraWaitResult(circuit, infrastructureError);
          }
        }
        throw error;
      }
      await this.#recordInfrastructureResult(result, { activeExecutionBefore });
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
    const activeEntries = await this.#activeExecutionEntries();
    const activeSlotIds = activeEntries.map(entry => entry.slotId);
    const interactiveActiveCount = activeEntries.filter(entry => this.#isInteractiveExecution(entry.state)).length;
    const slotIds = new Set(activeSlotIds);
    if (!drainEnabled && circuit.state === 'closed') {
      let launchBudget = Math.max(0, Math.min(
        maxParallelTasks - activeEntries.length,
        effectiveParallelTasks - interactiveActiveCount
      ));
      for (let index = 1; index <= maxParallelTasks && launchBudget > 0; index += 1) {
        const slotId = slotIdFor(index);
        if (slotIds.has(slotId)) continue;
        slotIds.add(slotId);
        launchBudget -= 1;
      }
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
        const withinCapacity = slotIds.has(slotId);
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
      let slot = this.slotStore && typeof this.slotStore.load === 'function' ? await this.slotStore.load(slotId) : null;
      slot = await this.#repairLegacyRecoveryCircuit(slotId, slot);
      if (slot?.recovery_circuit_state === 'open') return { slotId, status: 'recovery_circuit_open', taskId: slot.task_id ?? null };
      const gate = await this.#gateAutomaticRecovery(slotId);
      if (!gate.allowed) return { slotId, status: 'recovery_throttled', taskId: (await slotStorage.get('activeExecution'))?.task_id ?? null, retry_at: gate.retryAt };
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
      if (automatic) slot = await this.#repairLegacyRecoveryCircuit(id, slot);
      if (automatic && slot?.recovery_circuit_state === 'open') return { slotId: id, status: 'recovery_circuit_open', taskId: slot.task_id ?? null };
      if (automatic) {
        const gate = await this.#gateAutomaticRecovery(id);
        if (!gate.allowed) return { slotId: id, status: 'recovery_throttled', taskId: (await this.#slotStorage(id).get('activeExecution'))?.task_id ?? null, retry_at: gate.retryAt };
      }
      if (!automatic && this.slotStore && typeof this.slotStore.resetRecoveryCircuit === 'function') {
        await this.slotStore.resetRecoveryCircuit(id);
        slot = await this.slotStore.load(id);
      }
      const activeExecutionBefore = await this.#slotStorage(id).get('activeExecution');
      let recovered;
      try {
        recovered = await this.#controller(id).recoverReal();
      } catch (error) {
        const infrastructureError = this.#controlPlaneInfrastructureError(error);
        if (infrastructureError) {
          const circuit = await this.#recordInfrastructureFailure('control_plane', infrastructureError, { operation: 'recovery' });
          if (this.#isControlPlaneProtocolMismatch(error)) {
            const activeExecution = await this.#slotStorage(id).get('activeExecution');
            if (activeExecution?.task_id && circuit.retry_at) await this.#controller(id).deferActiveRecovery({ nextRecoveryAt: circuit.retry_at });
            return { slotId: id, taskId: activeExecution?.task_id ?? slot?.task_id ?? null, ...this.#infraWaitResult(circuit, infrastructureError) };
          }
        }
        throw error;
      }
      await this.#recordInfrastructureResult(recovered, { activeExecutionBefore });
      const recoveredInfrastructureError = recovered?.status === 'recovery_blocked'
        ? this.#controlPlaneInfrastructureError(recovered?.error)
        : null;
      if (recoveredInfrastructureError) {
        const circuit = await this.#recordInfrastructureFailure('control_plane', recoveredInfrastructureError, { operation: 'recovery' });
        const activeExecution = await this.#slotStorage(id).get('activeExecution');
        if (activeExecution?.task_id && circuit.retry_at) {
          await this.#controller(id).deferActiveRecovery({ nextRecoveryAt: circuit.retry_at });
        }
        return {
          slotId: id,
          taskId: activeExecution?.task_id ?? slot?.task_id ?? null,
          ...this.#infraWaitResult(circuit, recoveredInfrastructureError)
        };
      }
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
