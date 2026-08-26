export const TAB_SLOT_HEARTBEAT_ALARM_NAME = 'chatgpt-tab-slot-heartbeat';

function observationState(response) {
  return typeof response?.state === 'string' && response.state ? response.state : 'UNKNOWN';
}

export class TabSlotHeartbeatManager {
  constructor({ alarms, tabManager, slotStore, intervalMs = 30000, now = () => new Date() } = {}) {
    if (!alarms || typeof alarms.create !== 'function' || typeof alarms.clear !== 'function') {
      throw new TypeError('alarms.create and alarms.clear are required');
    }
    if (!slotStore || typeof slotStore.list !== 'function' || typeof slotStore.recordObservation !== 'function') {
      throw new TypeError('slotStore.list and slotStore.recordObservation are required');
    }
    this.alarms = alarms;
    this.tabManager = tabManager;
    this.slotStore = slotStore;
    this.intervalMs = Math.max(30000, Number(intervalMs) || 30000);
    this.now = now;
  }

  async configure() {
    await this.alarms.clear(TAB_SLOT_HEARTBEAT_ALARM_NAME);
    this.alarms.create(TAB_SLOT_HEARTBEAT_ALARM_NAME, { periodInMinutes: this.intervalMs / 60000 });
  }

  async #recordUnavailable(slot, reason) {
    return this.slotStore.recordObservation({
      slotId: slot.slot_id,
      tabId: slot.tab_id,
      generation: slot.generation,
      state: 'UNAVAILABLE',
      source: 'background_heartbeat',
      observedAt: this.now().toISOString(),
      error: reason
    });
  }

  async runOnce() {
    const slots = await this.slotStore.list();
    let checked = 0;
    for (const slot of slots) {
      if (slot?.status !== 'assigned' || !slot?.task_id || !Number.isInteger(Number(slot?.tab_id))) continue;
      checked += 1;
      try {
        const tab = await this.tabManager.getTab(Number(slot.tab_id));
        if (tab?.discarded === true) {
          await this.#recordUnavailable(slot, 'tab_discarded');
          continue;
        }
        const response = await this.tabManager.sendPassive(Number(slot.tab_id), { type: 'CHATGPT_STATE' });
        await this.slotStore.recordObservation({
          slotId: slot.slot_id,
          tabId: Number(slot.tab_id),
          generation: slot.generation,
          state: observationState(response),
          contextLimit: response?.contextLimit === true,
          responseFailure: response?.responseFailure ?? null,
          source: 'background_heartbeat',
          observedAt: this.now().toISOString()
        });
      } catch (error) {
        await this.#recordUnavailable(slot, error?.message ?? String(error));
      }
    }
    return { checked };
  }
}
