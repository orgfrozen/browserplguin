const SLOT_EXECUTION_KEYS = new Set(['activeExecution', 'lastRun', 'lastRecovery', 'parkedExternalWaits', 'schedulerTelemetry', 'agentControlTelemetry']);
const RECOVERY_CIRCUIT_WINDOW_MS = 10 * 60 * 1000;
const RECOVERY_DEGRADED_THRESHOLD = 3;
const RECOVERY_OPEN_THRESHOLD = 5;

function clearedRecoveryCircuitFields() {
  return {
    recovery_attempts: [],
    recovery_window_count: 0,
    recovery_circuit_state: 'closed',
    recovery_degraded_at: null,
    recovery_circuit_opened_at: null
  };
}

function recoveryCircuitFields(current, recoveredAtValue) {
  const nowMs = Date.parse(recoveredAtValue);
  const attempts = Array.isArray(current?.recovery_attempts) ? current.recovery_attempts : [];
  const recent = attempts.filter(value => {
    const time = Date.parse(value);
    return Number.isFinite(time) && Number.isFinite(nowMs) && nowMs - time <= RECOVERY_CIRCUIT_WINDOW_MS && nowMs - time >= 0;
  });
  recent.push(recoveredAtValue);
  const count = recent.length;
  const state = count >= RECOVERY_OPEN_THRESHOLD ? 'open' : count >= RECOVERY_DEGRADED_THRESHOLD ? 'degraded' : 'closed';
  return {
    recovery_attempts: recent,
    recovery_window_count: count,
    recovery_circuit_state: state,
    recovery_degraded_at: state === 'degraded' ? (current?.recovery_degraded_at ?? recoveredAtValue) : state === 'open' ? (current?.recovery_degraded_at ?? recoveredAtValue) : null,
    recovery_circuit_opened_at: state === 'open' ? (current?.recovery_circuit_opened_at ?? recoveredAtValue) : null
  };
}

export function createSlotStorageView(storage, slotId = 'chatgpt-1') {
  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
    throw new TypeError('storage is required');
  }
  if (typeof slotId !== 'string' || !slotId) throw new TypeError('slotId is required');
  if (slotId === 'chatgpt-1') return storage;

  const stateKey = `slotExecutionState:${slotId}`;
  let mutationTail = Promise.resolve();
  const mutate = operation => {
    const run = mutationTail.then(operation);
    mutationTail = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    async get(key) {
      if (!SLOT_EXECUTION_KEYS.has(key)) return storage.get(key);
      const state = await storage.get(stateKey);
      return state && typeof state === 'object' ? structuredClone(state[key]) : undefined;
    },
    async set(key, value) {
      if (!SLOT_EXECUTION_KEYS.has(key)) return storage.set(key, value);
      return mutate(async () => {
        const state = await storage.get(stateKey);
        const next = state && typeof state === 'object' ? structuredClone(state) : {};
        next[key] = structuredClone(value);
        await storage.set(stateKey, next);
      });
    },
    async remove(key) {
      if (!SLOT_EXECUTION_KEYS.has(key)) return storage.remove(key);
      return mutate(async () => {
        const state = await storage.get(stateKey);
        if (!state || typeof state !== 'object' || !Object.hasOwn(state, key)) return;
        const next = structuredClone(state);
        delete next[key];
        if (Object.keys(next).length === 0) await storage.remove(stateKey);
        else await storage.set(stateKey, next);
      });
    }
  };
}

export class TaskStore {
  constructor(storage, key = 'activeExecution') {
    this.storage = storage;
    this.key = key;
  }
  async load() { return (await this.storage.get(this.key)) ?? null; }
  async save(state) {
    const terminatedTaskIds = await this.storage.get('terminatedTaskIds');
    if (state?.task_id && Array.isArray(terminatedTaskIds) && terminatedTaskIds.includes(state.task_id)) return false;
    await this.storage.set(this.key, structuredClone(state));
    return true;
  }
  async clear() { await this.storage.remove(this.key); }
  async updateLease(taskId, lease) {
    const state = await this.load();
    if (!state || state.task_id !== taskId) return false;
    await this.save({ ...state, lease_token: lease?.token ?? state.lease_token ?? null, lease: structuredClone(lease) });
    return true;
  }
}

export function chromeStorageAdapter(area = chrome.storage.local) {
  return {
    async get(key) { const value = await area.get(key); return value[key]; },
    async set(key, value) { await area.set({ [key]: value }); },
    async remove(key) { await area.remove(key); }
  };
}


export class BrowserTabSlotStore {
  constructor(storage, { key = 'browserTabSlots', defaultSlotId = 'chatgpt-1' } = {}) {
    this.storage = storage;
    this.key = key;
    this.defaultSlotId = defaultSlotId;
    this.mutationTail = Promise.resolve();
  }

  async #readAll() {
    const value = await this.storage.get(this.key);
    return value && typeof value === 'object' ? structuredClone(value) : {};
  }

  async #writeAll(slots) {
    await this.storage.set(this.key, structuredClone(slots));
  }

  async #mutate(operation) {
    const run = this.mutationTail.then(operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async load(slotId = this.defaultSlotId) {
    const slots = await this.#readAll();
    const slot = slots[slotId];
    return slot && typeof slot === 'object' ? structuredClone(slot) : null;
  }

  async list() {
    const slots = await this.#readAll();
    return Object.values(slots)
      .filter(slot => slot && typeof slot === 'object')
      .map(slot => structuredClone(slot))
      .sort((left, right) => String(left.slot_id ?? '').localeCompare(String(right.slot_id ?? '')));
  }

  async findByTabId(tabId) {
    const numericTabId = Number(tabId);
    if (!Number.isInteger(numericTabId)) return null;
    const slots = await this.list();
    return slots.find(slot => Number(slot.tab_id) === numericTabId) ?? null;
  }

  async recordTabAlive({ slotId = this.defaultSlotId, tabId, generation, observedAt }) {
    return this.#mutate(async () => {
      const slots = await this.#readAll();
      const current = slots[slotId];
      if (!current || Number(current.tab_id) !== Number(tabId) || Number(current.generation) !== Number(generation)) {
        return current && typeof current === 'object' ? structuredClone(current) : null;
      }
      const next = { ...current, last_tab_alive_at: observedAt ?? new Date().toISOString() };
      slots[slotId] = next;
      await this.#writeAll(slots);
      return structuredClone(next);
    });
  }

  async recordExecutionHeartbeat({ slotId = this.defaultSlotId, taskId, heartbeatAt }) {
    return this.#mutate(async () => {
      const slots = await this.#readAll();
      const current = slots[slotId];
      if (!current || current.status !== 'assigned' || !taskId || current.task_id !== taskId) {
        return current && typeof current === 'object' ? structuredClone(current) : null;
      }
      const next = { ...current, last_execution_heartbeat_at: heartbeatAt ?? new Date().toISOString() };
      slots[slotId] = next;
      await this.#writeAll(slots);
      return structuredClone(next);
    });
  }

  async recordObservation({ slotId = this.defaultSlotId, tabId, generation, state, source, observedAt, contextLimit = false, responseFailure = null, error = null }) {
    return this.#mutate(async () => {
      const slots = await this.#readAll();
      const current = slots[slotId];
      if (!current || Number(current.tab_id) !== Number(tabId) || Number(current.generation) !== Number(generation)) {
        return current && typeof current === 'object' ? structuredClone(current) : null;
      }
      const observedState = typeof state === 'string' && state ? state : 'UNKNOWN';
      const observedAtValue = observedAt ?? new Date().toISOString();
      const observedFailure = responseFailure ? structuredClone(responseFailure) : null;
      const observedError = error ? String(error) : null;
      const changed = current.last_observed_state !== observedState
        || current.last_context_limit !== (contextLimit === true)
        || JSON.stringify(current.last_response_failure ?? null) !== JSON.stringify(observedFailure)
        || (current.last_observation_error ?? null) !== observedError;
      const liveDom = !observedError && observedState !== 'UNAVAILABLE';
      const next = {
        ...current,
        last_observed_state: observedState,
        last_observed_at: observedAtValue,
        last_observation_source: source ?? 'unknown',
        last_context_limit: contextLimit === true,
        last_response_failure: observedFailure,
        last_observation_error: observedError,
        ...(liveDom ? { last_tab_alive_at: observedAtValue, last_dom_alive_at: observedAtValue } : {}),
        ...(changed ? { last_progress_at: observedAtValue, ...clearedRecoveryCircuitFields() } : {}),
        ...((source ?? '').includes('heartbeat') ? { last_heartbeat_at: observedAtValue } : {})
      };
      slots[slotId] = next;
      await this.#writeAll(slots);
      return structuredClone(next);
    });
  }

  async recordUiAction({ slotId = this.defaultSlotId, tabId, generation, actionType, actedAt }) {
    return this.#mutate(async () => {
      const slots = await this.#readAll();
      const current = slots[slotId];
      if (!current || Number(current.tab_id) !== Number(tabId) || Number(current.generation) !== Number(generation)) {
        return current && typeof current === 'object' ? structuredClone(current) : null;
      }
      const actedAtValue = actedAt ?? new Date().toISOString();
      const next = {
        ...current,
        last_ui_action_at: actedAtValue,
        last_ui_action_type: typeof actionType === 'string' && actionType ? actionType : 'UNKNOWN',
        last_progress_at: actedAtValue,
        ...clearedRecoveryCircuitFields()
      };
      slots[slotId] = next;
      await this.#writeAll(slots);
      return structuredClone(next);
    });
  }

  async recordRecovery({ slotId = this.defaultSlotId, tabId = null, generation = null, reason, recoveredAt }) {
    return this.#mutate(async () => {
      const slots = await this.#readAll();
      const current = slots[slotId];
      if (!current) return null;
      if (tabId !== null && Number.isInteger(Number(tabId)) && Number(current.tab_id) !== Number(tabId)) return structuredClone(current);
      if (generation !== null && Number.isInteger(Number(generation)) && Number(current.generation) !== Number(generation)) return structuredClone(current);
      const recoveredAtValue = recoveredAt ?? new Date().toISOString();
      const next = {
        ...current,
        recovery_count: Math.max(0, Number(current.recovery_count) || 0) + 1,
        last_recovery_at: recoveredAtValue,
        last_recovery_reason: typeof reason === 'string' && reason ? reason : 'unknown',
        last_progress_at: recoveredAtValue,
        ...recoveryCircuitFields(current, recoveredAtValue)
      };
      slots[slotId] = next;
      await this.#writeAll(slots);
      return structuredClone(next);
    });
  }


  async resetRecoveryCircuit(slotId = this.defaultSlotId) {
    return this.#mutate(async () => {
      const slots = await this.#readAll();
      const current = slots[slotId];
      if (!current) return null;
      const next = { ...current, ...clearedRecoveryCircuitFields() };
      slots[slotId] = next;
      await this.#writeAll(slots);
      return structuredClone(next);
    });
  }

  async assign({ taskId, tabId, slotId = this.defaultSlotId, assignedAt = null, managedTab = null }) {
    if (typeof taskId !== 'string' || !taskId) throw new TypeError('taskId is required');
    if (!Number.isInteger(tabId)) throw new TypeError('tabId must be an integer');
    return this.#mutate(async () => {
      const slots = await this.#readAll();
      const current = slots[slotId] ?? {};
      const preservedAssignedAt = current.task_id === taskId && typeof current.assigned_at === 'string' && current.assigned_at
        ? current.assigned_at
        : (typeof assignedAt === 'string' && assignedAt ? assignedAt : null);
      const managed = typeof managedTab === 'boolean'
        ? managedTab
        : (typeof current.managed_tab === 'boolean' ? current.managed_tab : null);
      const next = {
        slot_id: slotId,
        tab_id: tabId,
        task_id: taskId,
        generation: Number.isInteger(current.generation) ? current.generation + 1 : 1,
        status: 'assigned',
        ...(preservedAssignedAt ? { assigned_at: preservedAssignedAt } : {}),
        ...(typeof managed === 'boolean' ? { managed_tab: managed } : {})
      };
      slots[slotId] = next;
      await this.#writeAll(slots);
      return structuredClone(next);
    });
  }

  async release({ taskId, tabId = null, slotId = this.defaultSlotId }) {
    return this.#mutate(async () => {
      const slots = await this.#readAll();
      const current = slots[slotId] ?? { slot_id: slotId, generation: 0 };
      if (current.task_id && taskId && current.task_id !== taskId) return structuredClone(current);
      const next = {
        slot_id: slotId,
        tab_id: Number.isInteger(tabId) ? tabId : null,
        task_id: null,
        generation: Number.isInteger(current.generation) ? current.generation : 0,
        status: 'idle',
        ...(typeof current.managed_tab === 'boolean' ? { managed_tab: current.managed_tab } : {})
      };
      slots[slotId] = next;
      await this.#writeAll(slots);
      return structuredClone(next);
    });
  }
}
