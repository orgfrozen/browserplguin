import test from 'node:test';
import assert from 'node:assert/strict';
import * as semantics from '../src/content/ui-semantics.js';

function uiNode({ tagName = 'BUTTON', attrs = {}, text = '', visible = true } = {}) {
  return {
    tagName,
    textContent: text,
    hidden: !visible,
    getAttribute(name) { return attrs[name] ?? null; },
    getBoundingClientRect() { return visible ? { width: 10, height: 10 } : { width: 0, height: 0 }; }
  };
}

function rootWith(nodes) {
  return { querySelectorAll() { return nodes; } };
}

test('error DOM diagnostics strip free text and URL secrets while keeping structural fingerprints', () => {
  const collect = semantics.collectErrorDomDiagnostics ?? (() => ({}));
  const nodes = [
    uiNode({ attrs: { 'aria-label': 'Delete Secret Client Project', title: 'Private workspace', 'data-testid': 'project-menu-button', type: 'button' }, text: 'Secret Client Project' }),
    uiNode({ tagName: 'INPUT', attrs: { placeholder: 'Attach payroll-2026.zip', name: 'prompt', type: 'file' } }),
    uiNode({ tagName: 'DIV', text: 'secret assistant response must never be collected' })
  ];
  const result = collect(rootWith(nodes), {
    location: { hostname: 'chatgpt.com', pathname: '/g/g-private123/c/abc123secret', href: 'https://chatgpt.com/g/g-private123/c/abc123secret?token=top-secret#fragment' },
    title: 'Secret Client Project - ChatGPT',
    accessState: { status: 'READY', reason: 'chat_ui' },
    selectorProfile: { id: 'chatgpt-semantic-v1', version: 1 },
    errorCode: 'UI_SELECTOR_INCOMPATIBLE'
  });

  assert.equal(result.error_code, 'UI_SELECTOR_INCOMPATIBLE');
  assert.deepEqual(result.selector_profile, { id: 'chatgpt-semantic-v1', version: 1 });
  assert.deepEqual(result.access_state, { status: 'READY', reason: 'chat_ui' });
  assert.equal(result.page.hostname, 'chatgpt.com');
  assert.equal(result.page.pathname.includes('secret'), false);
  assert.equal(result.page.pathname.includes('?'), false);
  assert.equal(result.page.pathname.includes('#'), false);
  assert.equal(result.page.title_category, 'chat');
  assert.equal(result.control_count, 2);
  assert.equal(Array.isArray(result.controls), true);

  const serialized = JSON.stringify(result);
  for (const secret of [
    'top-secret', 'fragment', 'Secret Client Project', 'secret client project', 'Private workspace',
    'payroll-2026.zip', 'secret assistant response', 'g-private123', 'abc123secret'
  ]) {
    assert.equal(serialized.toLowerCase().includes(secret.toLowerCase()), false, `diagnostics leaked ${secret}`);
  }
  assert.equal(serialized.includes('project-menu-button'), true);
  assert.equal(serialized.includes('input'), true);
  assert.equal(serialized.includes('file'), true);
});

test('error DOM diagnostics use stable title categories and deterministic limits', () => {
  const collect = semantics.collectErrorDomDiagnostics ?? (() => ({}));
  const nodes = Array.from({ length: 5 }, (_, index) => uiNode({ attrs: { 'data-testid': `safe-control-${index}` } }));
  const challenge = collect(rootWith(nodes), {
    location: { hostname: 'chatgpt.com', pathname: '/cdn-cgi/challenge-platform/x', href: 'https://chatgpt.com/cdn-cgi/challenge-platform/x' },
    title: 'Just a moment... private detail',
    accessState: { status: 'CHALLENGE_REQUIRED', reason: 'challenge_url' },
    selectorProfile: { id: 'chatgpt-semantic-v1', version: 1 },
    errorCode: 'LOGIN_OR_CHALLENGE_REQUIRED',
    limit: 2
  });
  assert.equal(challenge.page.title_category, 'challenge');
  assert.equal(challenge.control_count, 5);
  assert.equal(challenge.controls.length, 2);
  assert.equal(JSON.stringify(challenge).includes('private detail'), false);

  const login = collect(rootWith([]), {
    location: { hostname: 'chatgpt.com', pathname: '/auth/login', href: 'https://chatgpt.com/auth/login' },
    title: 'Welcome back ewan@example.com',
    accessState: { status: 'LOGIN_REQUIRED', reason: 'login_url' },
    selectorProfile: { id: 'chatgpt-semantic-v1', version: 1 },
    errorCode: 'LOGIN_OR_CHALLENGE_REQUIRED'
  });
  assert.equal(login.page.title_category, 'login');
  assert.equal(JSON.stringify(login).includes('ewan@example.com'), false);
});
