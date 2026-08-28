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

test('failed automation attaches privacy-safe DOM diagnostics on login guard errors', async () => {
  const login = uiNode({ tagName: 'A', attrs: { href: '/auth/login?return=secret-project', 'aria-label': 'Log in to Secret Client' }, text: 'Log in Secret Client' });
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
    location: { hostname: 'chatgpt.com', pathname: '/auth/login', href: 'https://chatgpt.com/auth/login?return=secret-project#token' },
    title: 'Welcome Secret Client'
  });

  const blocked = await harness.send({ type: 'CHATGPT_LIST_PROJECTS' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'LOGIN_OR_CHALLENGE_REQUIRED');
  assert.deepEqual(blocked.error.diagnostics.selector_profile, { id: 'chatgpt-semantic-v1', version: 1 });
  assert.deepEqual(blocked.error.diagnostics.access_state, { status: 'LOGIN_REQUIRED', reason: 'login_url' });
  assert.equal(blocked.error.diagnostics.page.pathname, '/auth/login');
  const serialized = JSON.stringify(blocked.error.diagnostics).toLowerCase();
  assert.equal(serialized.includes('secret client'), false);
  assert.equal(serialized.includes('secret-project'), false);
  assert.equal(serialized.includes('#token'), false);
});

test('selector failures attach structural diagnostics without leaking page or project text', async () => {
  const composer = uiNode({ tagName: 'TEXTAREA', attrs: { placeholder: 'Message Secret Alpha', name: 'prompt-textarea' } });
  const duplicateProjectA = uiNode({ tagName: 'A', attrs: { href: '/g/private-project-a' }, text: 'Secret Project Name' });
  const duplicateProjectB = uiNode({ tagName: 'A', attrs: { href: '/g/private-project-b' }, text: 'Secret Project Name' });
  const root = {
    querySelectorAll(selector) {
      if (selector === '[data-sidebar-item="true"][role="button"][aria-controls]') return [];
      if (selector === 'a[href], [role="link"]') return [duplicateProjectA, duplicateProjectB];
      if (selector.includes('textarea') || selector.includes('a[href]')) return [composer, duplicateProjectA, duplicateProjectB];
      return [];
    }
  };
  const harness = runtimeHarness();
  installContentScript({
    runtime: harness.runtime,
    root,
    location: { hostname: 'chatgpt.com', pathname: '/c/private-chat-123', href: 'https://chatgpt.com/c/private-chat-123?x=secret' },
    title: 'Secret Alpha - ChatGPT'
  });

  const blocked = await harness.send({ type: 'CHATGPT_RESOLVE_PROJECT', projectName: 'Secret Project Name' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'UI_SELECTOR_INCOMPATIBLE');
  assert.equal(blocked.error.diagnostics.error_code, 'UI_SELECTOR_INCOMPATIBLE');
  assert.equal(blocked.error.diagnostics.page.title_category, 'chat');
  assert.equal(blocked.error.diagnostics.page.pathname, '/c/:segment');
  const serialized = JSON.stringify(blocked.error.diagnostics).toLowerCase();
  for (const secret of ['secret alpha', 'secret project name', 'private-chat-123', 'private-project-a', 'private-project-b', 'x=secret']) {
    assert.equal(serialized.includes(secret), false, `diagnostics leaked ${secret}`);
  }
});
