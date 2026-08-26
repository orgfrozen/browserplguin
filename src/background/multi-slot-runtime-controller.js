import { createSlotStorageView } from './task-store.js';

const MAX_PARALLEL_TASKS = 5;
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
  constructor({ storage, createController, slotStore = null, closeIdleSlot = null } = {}) {
    if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') throw new TypeError('storage is required');
    if (typeof createController !== 'function') throw new TypeError('createController is required');
    this.storage = storage;
    this.createController = createController;
    this.slotStore = slotStore;
    this.closeIdleSlot = typeof closeIdleSlot === 'function' ? closeIdleSlot : null;
    this.controllers = new Map();
    this.slotStorages = new Map();
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

  async #maxParallelTasks() {
    const settings = (await this.storage.get('settings')) ?? {};
    return normalizeMaxParallelTasks(settings.maxParallelTasks, 1);
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
      slots: statuses.map(({ slotId, status }) => ({
        slot_id: slotId,
        running: status?.running === true,
        activeExecution: status?.activeExecution ?? null,
        lastRun: status?.lastRun ?? null,
        lastRecovery: status?.lastRecovery ?? null
      }))
    };
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
    const maxParallelTasks = await this.#maxParallelTasks();
    const results = await Promise.all(
      Array.from({ length: maxParallelTasks }, async (_, index) => {
        const slotId = slotIdFor(index + 1);
        const activeExecution = await this.#slotStorage(slotId).get('activeExecution');
        if (activeExecution?.task_id) return { status: 'active', taskId: activeExecution.task_id, state: activeExecution };
        return this.#runSlotOnce(slotId, 'runReal');
      })
    );
    return { status: 'scheduled', results };
  }

  async #runAutoSlot(slotId) {
    const storage = this.#slotStorage(slotId);
    let result = await this.#controller(slotId).runAutoOnce();
    while (TERMINAL_REFILL_STATUSES.has(result?.status) && !(await storage.get('activeExecution'))?.task_id) {
      result = await this.#controller(slotId).runAutoOnce();
    }
    if (result?.status === 'idle') await this.#closeIdleTabIfPresent(slotId);
    return result;
  }

  async runAutoOnce() {
    if ((await this.storage.get('autoRunEnabled')) !== true) return { status: 'auto_run_disabled', results: [] };
    if ((await this.storage.get('manualPaused')) === true) return { status: 'auto_run_paused', results: [] };
    const settings = (await this.storage.get('settings')) ?? {};
    if (settings.mode !== 'real') return { status: 'auto_run_mode_not_real', results: [] };
    const maxParallelTasks = await this.#maxParallelTasks();
    const results = await Promise.all(
      Array.from({ length: maxParallelTasks }, (_, index) => this.#runAutoSlot(slotIdFor(index + 1)))
    );
    return { status: 'auto_run_scheduled', results };
  }

  async #afterRecovery(slotId, result) {
    const activeExecution = await this.#slotStorage(slotId).get('activeExecution');
    if (!TERMINAL_REFILL_STATUSES.has(result?.status) || activeExecution?.task_id) return result;
    const settings = (await this.storage.get('settings')) ?? {};
    const canRefill = settings.mode === 'real'
      && (await this.storage.get('autoRunEnabled')) === true
      && (await this.storage.get('manualPaused')) !== true
      && slotIndex(slotId) <= await this.#maxParallelTasks();
    if (canRefill) return { ...result, refill: await this.#runAutoSlot(slotId) };
    await this.#closeIdleTabIfPresent(slotId);
    return result;
  }

  async recoverRealIfNeeded() {
    const activeSlotIds = await this.#activeSlotIds();
    const slotIds = activeSlotIds.length > 0 ? activeSlotIds : ['chatgpt-1'];
    const results = [];
    for (const slotId of slotIds) {
      const hasDurableExecution = Boolean((await this.#slotStorage(slotId).get('activeExecution'))?.task_id);
      if (!hasDurableExecution && activeSlotIds.length > 0) continue;
      const result = await this.#afterRecovery(slotId, await this.#controller(slotId).recoverRealIfNeeded());
      if (result?.status !== 'no_recovery' || result?.state || taskIdFromResult(result)) results.push({ slotId, ...result });
      else if (activeSlotIds.length > 0) results.push({ slotId, ...result });
    }
    return { status: results.length > 0 ? 'recovery_checked' : 'no_recovery', results };
  }

  async recoverReal(slotId = null) {
    const slotIds = slotId ? [slotId] : await this.#activeSlotIds();
    if (slotIds.length === 0) return { status: 'no_recovery', results: [] };
    const results = await Promise.all(slotIds.map(async id => ({
      slotId: id,
      ...(await this.#afterRecovery(id, await this.#controller(id).recoverReal()))
    })));
    return { status: 'recovery_checked', results };
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
      return await controller.terminateTask();
    } catch (error) {
      try { await controller.recoverRealIfNeeded(); } catch { /* keep the original termination error */ }
      throw error;
    }
  }

  async handleTabRemoved(tabId, reason = 'removed') {
    if (!this.slotStore) return { status: 'ignored', reason: 'slot_store_unavailable' };
    const slot = await this.slotStore.findByTabId(tabId);
    if (!slot?.task_id || slot.status !== 'assigned') return { status: 'ignored', reason: 'idle_or_unowned_tab' };
    const result = await this.#afterRecovery(
      slot.slot_id,
      await this.#controller(slot.slot_id).interruptAndRecover({ type: 'worker_tab_lost', reason, tabId })
    );
    return { status: 'recovery_triggered', slot_id: slot.slot_id, task_id: slot.task_id, recovery: result };
  }
}
