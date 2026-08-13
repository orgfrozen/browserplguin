import test from 'node:test';
import assert from 'node:assert/strict';
import { installContentScript } from '../src/content/content-script.js';

function uiNode({ tagName = 'BUTTON', attrs = {}, text = '' } = {}) {
  return {
    tagName,
    textContent: text,
    hidden: false,
    getAttribute(name) { return attrs[name] ?? null; },
    getBoundingClientRect() { return { width: 10, height: 10 }; }
  };
}

function runtimeHarness() {
  let listener = null;
  return {
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    async send(message) {
      return new Promise((resolve, reject) => {
        const keep = listener(message, {}, resolve);
        if (keep !== true) reject(new Error('listener must keep async channel open'));
      });
    }
  };
}

test('content diagnostics command exposes UI metadata but not conversation text', async () => {
  const button = uiNode({ attrs: { 'aria-label': 'New project', 'data-testid': 'new-project-button' }, text: 'New project' });
  const message = uiNode({ tagName: 'DIV', text: 'secret assistant response' });
  const root = {
    querySelectorAll(selector) {
      if (selector.includes('button')) return [button, message];
      return [];
    }
  };
  const harness = runtimeHarness();
  installContentScript({ runtime: harness.runtime, root });
  const result = await harness.send({ type: 'CHATGPT_UI_DIAGNOSTICS' });
  assert.deepEqual(result.selectorProfile, { id: 'chatgpt-semantic-v1', version: 1 });
  assert.equal(result.controls.length, 1);
  assert.equal(result.controls[0].ariaLabel, 'New project');
  assert.equal(JSON.stringify(result).includes('secret assistant response'), false);
  assert.equal(JSON.stringify(result).includes('new project\\b'), false);
});

import { inspectChatGptUi } from '../src/background/ui-diagnostics.js';

test('background diagnostics targets the open ChatGPT tab', async () => {
  const messages = [];
  const tabManager = {
    async findChatGptTab() { return { id: 42, url: 'https://chatgpt.com/' }; },
    async send(tabId, message) { messages.push({ tabId, message }); return { selectorProfile: { id: 'chatgpt-semantic-v1', version: 1 }, controls: [{ tag: 'button', ariaLabel: 'New project' }] }; }
  };
  const result = await inspectChatGptUi(tabManager);
  assert.equal(result.tabId, 42);
  assert.equal(result.count, 1);
  assert.deepEqual(result.selectorProfile, { id: 'chatgpt-semantic-v1', version: 1 });
  assert.deepEqual(messages, [{ tabId: 42, message: { type: 'CHATGPT_UI_DIAGNOSTICS' } }]);
});

test('content script blocks automation on logged-out page while keeping access diagnostics available', async () => {
  const login = uiNode({ tagName: 'A', attrs: { href: '/auth/login' }, text: 'Log in' });
  const root = {
    querySelectorAll(selector) {
      if (selector.includes('button') || selector.includes('a[href]') || selector.includes('input') || selector.includes('textarea')) return [login];
      return [];
    }
  };
  const harness = runtimeHarness();
  installContentScript({
    runtime: harness.runtime,
    root,
    location: { hostname: 'chatgpt.com', pathname: '/', href: 'https://chatgpt.com/' },
    title: 'ChatGPT'
  });

  const access = await harness.send({ type: 'CHATGPT_ACCESS_STATE' });
  assert.deepEqual(access, { status: 'LOGIN_REQUIRED', reason: 'login_control' });

  const blocked = await harness.send({ type: 'CHATGPT_LIST_PROJECTS' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'LOGIN_OR_CHALLENGE_REQUIRED');

  const diagnostics = await harness.send({ type: 'CHATGPT_UI_DIAGNOSTICS' });
  assert.deepEqual(diagnostics.selectorProfile, { id: 'chatgpt-semantic-v1', version: 1 });
  assert.equal(Array.isArray(diagnostics.controls), true);
});
