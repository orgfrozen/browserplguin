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
  }

  async #readAll() {
    const value = await this.storage.get(this.key);
    return value && typeof value === 'object' ? structuredClone(value) : {};
  }

  async #writeAll(slots) {
    await this.storage.set(this.key, structuredClone(slots));
  }

  async load(slotId = this.defaultSlotId) {
    const slots = await this.#readAll();
    const slot = slots[slotId];
    return slot && typeof slot === 'object' ? structuredClone(slot) : null;
  }

  async assign({ taskId, tabId, slotId = this.defaultSlotId }) {
    if (typeof taskId !== 'string' || !taskId) throw new TypeError('taskId is required');
    if (!Number.isInteger(tabId)) throw new TypeError('tabId must be an integer');
    const slots = await this.#readAll();
    const current = slots[slotId] ?? {};
    const next = {
      slot_id: slotId,
      tab_id: tabId,
      task_id: taskId,
      generation: Number.isInteger(current.generation) ? current.generation + 1 : 1,
      status: 'assigned'
    };
    slots[slotId] = next;
    await this.#writeAll(slots);
    return structuredClone(next);
  }

  async release({ taskId, tabId = null, slotId = this.defaultSlotId }) {
    const slots = await this.#readAll();
    const current = slots[slotId] ?? { slot_id: slotId, generation: 0 };
    if (current.task_id && taskId && current.task_id !== taskId) return structuredClone(current);
    const next = {
      slot_id: slotId,
      tab_id: Number.isInteger(tabId) ? tabId : null,
      task_id: null,
      generation: Number.isInteger(current.generation) ? current.generation : 0,
      status: 'idle'
    };
    slots[slotId] = next;
    await this.#writeAll(slots);
    return structuredClone(next);
  }
}
