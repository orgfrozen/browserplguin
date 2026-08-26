import test from 'node:test';
import assert from 'node:assert/strict';
import { TabManager } from '../src/background/tab-manager.js';
import { RunnerError, ERROR_CODES } from '../src/shared/errors.js';

test('findChatGptTab reports login required when only auth.openai.com is open', async () => {
  const queries = [];
  const tabs = {
    async query(filter) {
      queries.push(filter);
      if (filter.url === 'https://chatgpt.com/*') return [];
      if (filter.url === 'https://auth.openai.com/*') return [{ id: 9, url: 'https://auth.openai.com/log-in' }];
      return [];
    }
  };
  const manager = new TabManager(tabs);
  await assert.rejects(
    manager.findChatGptTab(),
    error => error instanceof RunnerError && error.code === ERROR_CODES.LOGIN_OR_CHALLENGE_REQUIRED
  );
  assert.deepEqual(queries, [{ url: 'https://chatgpt.com/*' }, { url: 'https://auth.openai.com/*' }]);
});

test('findChatGptTab still returns an existing ChatGPT tab without auth probing', async () => {
  const queries = [];
  const tabs = {
    async query(filter) {
      queries.push(filter);
      if (filter.url === 'https://chatgpt.com/*') return [{ id: 3, active: true, url: 'https://chatgpt.com/' }];
      return [];
    }
  };
  const manager = new TabManager(tabs);
  assert.equal((await manager.findChatGptTab()).id, 3);
  assert.deepEqual(queries, [{ url: 'https://chatgpt.com/*' }]);
});

test('reloadTab reloads the existing ChatGPT tab without creating a new tab', async () => {
  const calls = [];
  const manager = new TabManager({
    async reload(tabId) { calls.push(['reload', tabId]); return undefined; },
    async get(tabId) { calls.push(['get', tabId]); return { id: tabId, status: 'complete', url: 'https://chatgpt.com/c/1' }; }
  });
  const tab = await manager.reloadTab(7, { sleep: async () => {}, pollMs: 1, timeoutMs: 10 });
  assert.equal(tab.id, 7);
  assert.deepEqual(calls, [['reload', 7], ['get', 7]]);
});

test('navigateTab reuses the same tab for workspace reopen', async () => {
  const calls = [];
  const manager = new TabManager({
    async update(tabId, update) { calls.push(['update', tabId, update]); return { id: tabId, status: 'complete', url: update.url }; },
    async get(tabId) { calls.push(['get', tabId]); return { id: tabId, status: 'complete', url: 'https://chatgpt.com/' }; }
  });
  const tab = await manager.navigateTab(9, 'https://chatgpt.com/', { sleep: async () => {}, pollMs: 1, timeoutMs: 10 });
  assert.equal(tab.id, 9);
  assert.equal(tab.url, 'https://chatgpt.com/');
  assert.deepEqual(calls[0], ['update', 9, { url: 'https://chatgpt.com/' }]);
});

test('send reloads ChatGPT once and retries when extension reload removed the content-script receiver', async () => {
  const calls = [];
  let sends = 0;
  const manager = new TabManager({
    async sendMessage(tabId, message) {
      calls.push(['send', tabId, message.type]);
      sends += 1;
      if (sends === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { ok: true, state: 'READY' };
    },
    async reload(tabId) { calls.push(['reload', tabId]); },
    async get(tabId) { calls.push(['get', tabId]); return { id: tabId, status: 'complete', url: 'https://chatgpt.com/' }; }
  });

  const result = await manager.send(11, { type: 'CHATGPT_STATE' }, { sleep: async () => {}, pollMs: 1, timeoutMs: 10 });
  assert.deepEqual(result, { ok: true, state: 'READY' });
  assert.deepEqual(calls, [
    ['send', 11, 'CHATGPT_STATE'],
    ['reload', 11],
    ['get', 11],
    ['send', 11, 'CHATGPT_STATE']
  ]);
});

test('createChatGptTab opens a dedicated active ChatGPT tab and waits for it to load', async () => {
  const calls = [];
  const manager = new TabManager({
    async create(createProperties) {
      calls.push(['create', createProperties]);
      return { id: 17, status: 'loading', url: createProperties.url };
    },
    async get(tabId) {
      calls.push(['get', tabId]);
      return { id: tabId, status: 'complete', url: 'https://chatgpt.com/' };
    }
  });

  const tab = await manager.createChatGptTab({ sleep: async () => {}, pollMs: 1, timeoutMs: 10 });

  assert.equal(tab.id, 17);
  assert.deepEqual(calls, [
    ['create', { url: 'https://chatgpt.com/', active: true }],
    ['get', 17]
  ]);
});

test('activateTab focuses the exact owned task tab instead of querying the active tab', async () => {
  const calls = [];
  const manager = new TabManager({
    async update(tabId, updateProperties) {
      calls.push(['update', tabId, updateProperties]);
      return { id: tabId, active: true, url: 'https://chatgpt.com/c/owned' };
    }
  });

  const tab = await manager.activateTab(17);

  assert.equal(tab.id, 17);
  assert.deepEqual(calls, [['update', 17, { active: true }]]);
});
