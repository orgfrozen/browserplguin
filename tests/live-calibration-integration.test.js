import test from 'node:test';
import assert from 'node:assert/strict';
import { installContentScript } from '../src/content/content-script.js';
import { runLiveCalibration } from '../src/background/live-calibration.js';

function uiNode({ tagName = 'A', attrs = {}, text = '' } = {}) {
  return {
    tagName,
    textContent: text,
    hidden: false,
    getAttribute(name) { return attrs[name] ?? null; },
    getBoundingClientRect() { return { width: 10, height: 10 }; },
    querySelectorAll() { return []; }
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

test('calibration command remains available on login pages and does not invoke automation guard', async () => {
  const login = uiNode({ attrs: { href: '/auth/login', 'aria-label': 'Log in' }, text: 'Log in' });
  const root = {
    body: { innerText: '' },
    documentElement: { innerText: '' },
    querySelectorAll(selector) {
      if (selector.includes('a[href]') || selector.includes('button') || selector.includes('input') || selector.includes('textarea')) return [login];
      return [];
    }
  };
  const harness = runtimeHarness();
  installContentScript({
    runtime: harness.runtime,
    root,
    location: { hostname: 'chatgpt.com', pathname: '/auth/login', href: 'https://chatgpt.com/auth/login?secret=1' },
    title: 'Secret Login Page'
  });
  const result = await harness.send({ type: 'CHATGPT_CALIBRATION_MATRIX' });
  assert.equal(result.page.access_status, 'LOGIN_REQUIRED');
  assert.equal(result.checks.find(check => check.id === 'access').status, 'unavailable');
  assert.equal(JSON.stringify(result).includes('Secret Login Page'), false);
});

test('background live calibration forwards to the current ChatGPT tab', async () => {
  const messages = [];
  const tabManager = {
    async findChatGptTab() { return { id: 91, url: 'https://chatgpt.com/c/secret' }; },
    async send(tabId, message) {
      messages.push({ tabId, message });
      return { selector_profile: { id: 'chatgpt-semantic-v1', version: 1 }, page: { category: 'chat', access_status: 'READY' }, summary: { pass: 2, unavailable: 8, incompatible: 0 }, checks: [] };
    }
  };
  const result = await runLiveCalibration(tabManager);
  assert.equal(result.page.category, 'chat');
  assert.deepEqual(messages, [{ tabId: 91, message: { type: 'CHATGPT_CALIBRATION_MATRIX' } }]);
  assert.equal(JSON.stringify(result).includes('https://chatgpt.com/c/secret'), false);
});


test('background live calibration records evidence without changing the returned matrix', async () => {
  const expected = {
    selector_profile: { id: 'chatgpt-semantic-v1', version: 1 },
    page: { category: 'project', access_status: 'READY' },
    summary: { pass: 1, unavailable: 9, incompatible: 0 },
    checks: [{ id: 'project_create', status: 'pass', evidence: { candidate_count: 1 } }]
  };
  const recorded = [];
  const tabManager = {
    async findChatGptTab() { return { id: 42 }; },
    async send() { return expected; }
  };
  const result = await runLiveCalibration(tabManager, { async record(matrix) { recorded.push(matrix); } });
  assert.equal(result, expected);
  assert.deepEqual(recorded, [expected]);
});

test('evidence persistence failure never replaces a successful calibration result', async () => {
  const expected = { selector_profile: { id: 'chatgpt-semantic-v1', version: 1 }, page: { category: 'chat', access_status: 'READY' }, summary: { pass: 0, unavailable: 10, incompatible: 0 }, checks: [] };
  const tabManager = { async findChatGptTab() { return { id: 7 }; }, async send() { return expected; } };
  const result = await runLiveCalibration(tabManager, { async record() { throw new Error('secret storage error'); } });
  assert.equal(result, expected);
});
