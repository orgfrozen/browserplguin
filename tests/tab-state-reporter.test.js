import test from 'node:test';
import assert from 'node:assert/strict';
import { installTabStateReporter } from '../src/content/tab-state-reporter.js';

test('tab state reporter emits state transitions and heartbeat snapshots without needing tab activation', async () => {
  const messages = [];
  let mutationCallback = null;
  let heartbeatCallback = null;
  let currentState = { state: 'READY', contextLimit: false, responseFailure: { failed: false } };
  class FakeMutationObserver {
    constructor(callback) { mutationCallback = callback; }
    observe() {}
    disconnect() {}
  }
  const reporter = installTabStateReporter({
    runtime: { async sendMessage(message) { messages.push(structuredClone(message)); } },
    root: {},
    readState: () => structuredClone(currentState),
    MutationObserverCtor: FakeMutationObserver,
    setIntervalFn(callback, ms) { heartbeatCallback = callback; assert.equal(ms, 15000); return 1; },
    clearIntervalFn() {},
    now: () => new Date('2026-08-26T03:10:00.000Z')
  });
  await reporter.flush();
  assert.equal(messages[0].type, 'CHATGPT_SLOT_STATE');
  assert.equal(messages[0].state, 'READY');

  currentState = { state: 'GENERATING', contextLimit: false, responseFailure: { failed: false } };
  mutationCallback([]);
  await reporter.flush();
  assert.equal(messages.at(-1).type, 'CHATGPT_SLOT_STATE');
  assert.equal(messages.at(-1).state, 'GENERATING');

  mutationCallback([]);
  await reporter.flush();
  assert.equal(messages.filter(message => message.type === 'CHATGPT_SLOT_STATE').length, 2);

  heartbeatCallback();
  await reporter.flush();
  assert.equal(messages.at(-1).type, 'CHATGPT_SLOT_HEARTBEAT');
  assert.equal(messages.at(-1).state, 'GENERATING');
});
