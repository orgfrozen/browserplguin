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
