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
