import test from 'node:test';
import assert from 'node:assert/strict';
import { TabSlotHeartbeatManager, TAB_SLOT_HEARTBEAT_ALARM_NAME } from '../src/background/tab-slot-heartbeat-manager.js';

function makeSlotStore() {
  const observations = [];
  return {
    observations,
    async list() {
      return [
        { slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 3, status: 'assigned' },
        { slot_id: 'chatgpt-2', tab_id: 18, task_id: null, generation: 1, status: 'idle' }
      ];
    },
    async recordObservation(observation) { observations.push(structuredClone(observation)); return observation; }
  };
}

test('tab slot heartbeat passively checks assigned tabs without activating them', async () => {
  const slots = makeSlotStore();
  const sends = [];
  const manager = new TabSlotHeartbeatManager({
    alarms: { async clear() {}, create() {} },
    slotStore: slots,
    tabManager: {
      async getTab(tabId) { return { id: tabId, discarded: false }; },
      async sendPassive(tabId, message) { sends.push([tabId, message]); return { state: 'GENERATING', contextLimit: false }; }
    },
    now: () => new Date('2026-08-26T03:00:00.000Z')
  });

  const result = await manager.runOnce();
  assert.equal(result.checked, 1);
  assert.deepEqual(sends, [[17, { type: 'CHATGPT_STATE' }]]);
  assert.equal(slots.observations.length, 1);
  assert.equal(slots.observations[0].slotId, 'chatgpt-1');
  assert.equal(slots.observations[0].state, 'GENERATING');
  assert.equal(slots.observations[0].source, 'background_heartbeat');
});

test('tab slot heartbeat configures a low-frequency Chrome alarm', async () => {
  const calls = [];
  const manager = new TabSlotHeartbeatManager({
    alarms: {
      async clear(name) { calls.push(['clear', name]); },
      create(name, options) { calls.push(['create', name, options]); }
    },
    slotStore: makeSlotStore(),
    tabManager: {},
    intervalMs: 30000
  });

  await manager.configure();
  assert.deepEqual(calls, [
    ['clear', TAB_SLOT_HEARTBEAT_ALARM_NAME],
    ['create', TAB_SLOT_HEARTBEAT_ALARM_NAME, { periodInMinutes: 0.5 }]
  ]);
});

test('tab slot heartbeat distinguishes a live tab from an unresponsive content DOM', async () => {
  const tabLiveness = [];
  const observations = [];
  const slotStore = {
    async list() { return [{ slot_id: 'chatgpt-1', tab_id: 17, task_id: 'task-a', generation: 3, status: 'assigned' }]; },
    async recordTabAlive(value) { tabLiveness.push(structuredClone(value)); return value; },
    async recordObservation(value) { observations.push(structuredClone(value)); return value; }
  };
  const manager = new TabSlotHeartbeatManager({
    alarms: { async clear() {}, create() {} },
    slotStore,
    tabManager: {
      async getTab(tabId) { return { id: tabId, discarded: false }; },
      async sendPassive() { throw new Error('Could not establish connection. Receiving end does not exist.'); }
    },
    now: () => new Date('2026-08-26T03:00:00.000Z')
  });

  await manager.runOnce();

  assert.equal(tabLiveness.length, 1);
  assert.equal(tabLiveness[0].observedAt, '2026-08-26T03:00:00.000Z');
  assert.equal(observations.length, 1);
  assert.equal(observations[0].state, 'UNAVAILABLE');
  assert.match(observations[0].error, /Receiving end/);
});
