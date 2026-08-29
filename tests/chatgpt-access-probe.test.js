import test from 'node:test';
import assert from 'node:assert/strict';
import { probeChatGptAccessTabs } from '../src/background/chatgpt-access-probe.js';

test('access probe reports healthy when any existing ChatGPT tab is READY even if another tab is limited', async () => {
  const tabs = {
    async query() { return [{ id: 11 }, { id: 12 }]; },
    async sendMessage(tabId) {
      return tabId === 11
        ? { status: 'USAGE_LIMITED', reason: 'usage_limit_dialog' }
        : { status: 'READY', reason: 'chat_ui' };
    }
  };

  assert.deepEqual(await probeChatGptAccessTabs(tabs), {
    status: 'healthy',
    checked_tabs: 2,
    ready_tabs: 1,
    limited_tabs: 1,
    unavailable_tabs: 0
  });
});

test('access probe only confirms limited when no READY tab exists and at least one tab reports USAGE_LIMITED', async () => {
  const tabs = {
    async query() { return [{ id: 21 }, { id: 22 }]; },
    async sendMessage(tabId) {
      if (tabId === 21) return { status: 'USAGE_LIMITED' };
      throw new Error('Receiving end does not exist');
    }
  };

  assert.deepEqual(await probeChatGptAccessTabs(tabs), {
    status: 'limited',
    checked_tabs: 2,
    ready_tabs: 0,
    limited_tabs: 1,
    unavailable_tabs: 1
  });
});
