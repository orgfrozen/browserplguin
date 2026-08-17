export class TaskStore {
  constructor(storage, key = 'activeExecution') {
    this.storage = storage;
    this.key = key;
  }
  async load() { return (await this.storage.get(this.key)) ?? null; }
  async save(state) { await this.storage.set(this.key, structuredClone(state)); }
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
