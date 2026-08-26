export const UI_ACTION_PRIORITIES = Object.freeze({
  RECOVERY: 0,
  PATCH: 10,
  RESPONSE: 20,
  INITIALIZATION: 30,
  HOUSEKEEPING: 40
});

export class StaleUiActionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'StaleUiActionError';
    this.code = 'STALE_UI_ACTION';
    this.details = details;
  }
}

function makeDedupeKey(item) {
  if (item.dedupeKey) return String(item.dedupeKey);
  return [item.slotId ?? 'slot', item.generation ?? 'generation', item.actionType ?? 'action'].join(':');
}

export class UiActionQueue {
  constructor({ tabs, slotStore = null } = {}) {
    if (!tabs || typeof tabs.update !== 'function') throw new TypeError('tabs.update is required');
    this.tabs = tabs;
    this.slotStore = slotStore;
    this.pending = [];
    this.inFlight = new Map();
    this.sequence = 0;
    this.draining = false;
    this.originalActiveTabId = null;
    this.idleWaiters = [];
    this.lastServedSlotId = null;
  }

  enqueue(item = {}) {
    if (typeof item.run !== 'function') throw new TypeError('run is required');
    if (!Number.isInteger(Number(item.tabId))) throw new TypeError('tabId must be an integer');
    const dedupeKey = makeDedupeKey(item);
    const existing = this.inFlight.get(dedupeKey);
    if (existing) return existing.promise;

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const queued = {
      ...item,
      tabId: Number(item.tabId),
      priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : UI_ACTION_PRIORITIES.RESPONSE,
      sequence: this.sequence++,
      dedupeKey,
      resolve,
      reject,
      promise
    };
    this.pending.push(queued);
    this.inFlight.set(dedupeKey, queued);
    this.#ensureDrain();
    return promise;
  }

  whenIdle() {
    if (!this.draining && this.pending.length === 0) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  getStats() {
    return {
      pending: this.pending.length,
      in_flight: this.inFlight.size,
      draining: this.draining
    };
  }

  #ensureDrain() {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      this.#drain().catch(error => {
        for (const item of this.pending.splice(0)) {
          this.inFlight.delete(item.dedupeKey);
          item.reject(error);
        }
      }).finally(() => {
        this.draining = false;
        if (this.pending.length > 0) {
          this.#ensureDrain();
          return;
        }
        const waiters = this.idleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      });
    });
  }


  #nextPendingItem() {
    if (this.pending.length === 0) return null;
    const bySlot = new Map();
    for (const item of this.pending) {
      const slotId = item.slotId ?? '__default__';
      if (!bySlot.has(slotId)) bySlot.set(slotId, []);
      bySlot.get(slotId).push(item);
    }
    const slotIds = [...bySlot.keys()].sort((left, right) => String(left).localeCompare(String(right), undefined, { numeric: true }));
    let selectedSlotId = null;
    if (this.lastServedSlotId && slotIds.length > 1) {
      selectedSlotId = slotIds.find(slotId => String(slotId).localeCompare(String(this.lastServedSlotId), undefined, { numeric: true }) > 0) ?? slotIds[0];
      if (selectedSlotId === this.lastServedSlotId) selectedSlotId = slotIds.find(slotId => slotId !== this.lastServedSlotId) ?? selectedSlotId;
    }
    if (!selectedSlotId) {
      const first = [...this.pending].sort((left, right) => left.priority - right.priority || left.sequence - right.sequence)[0];
      selectedSlotId = first.slotId ?? '__default__';
    }
    const candidates = bySlot.get(selectedSlotId);
    candidates.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
    const selected = candidates[0];
    const index = this.pending.indexOf(selected);
    if (index >= 0) this.pending.splice(index, 1);
    this.lastServedSlotId = selected.slotId ?? '__default__';
    return selected;
  }

  async #captureOriginalActiveTab() {
    if (this.originalActiveTabId !== null || typeof this.tabs.query !== 'function') return;
    try {
      const activeTabs = await this.tabs.query({ active: true, currentWindow: true });
      const activeTabId = Number(activeTabs?.[0]?.id);
      if (Number.isInteger(activeTabId)) this.originalActiveTabId = activeTabId;
    } catch {
      this.originalActiveTabId = null;
    }
  }

  async #assertCurrent(item) {
    if (!this.slotStore || !item.slotId || !Number.isInteger(Number(item.generation))) return;
    const current = await this.slotStore.load(item.slotId);
    const currentGeneration = Number(current?.generation);
    const currentTabId = Number(current?.tab_id);
    const stale = !current
      || currentGeneration !== Number(item.generation)
      || currentTabId !== Number(item.tabId)
      || (item.taskId && current.task_id !== item.taskId);
    if (!stale) return;
    throw new StaleUiActionError('Browser UI action belongs to a stale slot generation', {
      slot_id: item.slotId,
      requested_generation: Number(item.generation),
      current_generation: Number.isInteger(currentGeneration) ? currentGeneration : null,
      requested_task_id: item.taskId ?? null,
      current_task_id: current?.task_id ?? null,
      requested_tab_id: Number(item.tabId),
      current_tab_id: Number.isInteger(currentTabId) ? currentTabId : null
    });
  }

  async #restoreOriginalActiveTab() {
    const tabId = this.originalActiveTabId;
    this.originalActiveTabId = null;
    if (!Number.isInteger(tabId)) return;
    try {
      if (typeof this.tabs.get === 'function') await this.tabs.get(tabId);
      await this.tabs.update(tabId, { active: true });
    } catch {
      // The user may have closed the previously active tab while the queue was working.
    }
  }

  async #drain() {
    await this.#captureOriginalActiveTab();
    while (this.pending.length > 0) {
      const item = this.#nextPendingItem();
      try {
        await this.#assertCurrent(item);
        await this.tabs.update(item.tabId, { active: true });
        const result = await item.run();
        if (this.slotStore && typeof this.slotStore.recordUiAction === 'function') {
          try {
            await this.slotStore.recordUiAction({
              slotId: item.slotId,
              tabId: item.tabId,
              generation: item.generation,
              actionType: item.actionType
            });
          } catch {
            // Progress telemetry must never turn a successful browser action into a failed action.
          }
        }
        item.resolve(result);
      } catch (error) {
        item.reject(error);
      } finally {
        this.inFlight.delete(item.dedupeKey);
      }
    }
    await this.#restoreOriginalActiveTab();
  }
}
