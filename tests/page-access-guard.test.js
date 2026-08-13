import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChatGptPageAccess, assertChatGptPageAccessible } from '../src/content/page-access-guard.js';
import { RunnerError, ERROR_CODES } from '../src/shared/errors.js';

function node({ tagName = 'BUTTON', text = '', attrs = {}, visible = true } = {}) {
  return {
    tagName,
    textContent: text,
    hidden: !visible,
    getAttribute(name) { return attrs[name] ?? null; },
    getBoundingClientRect() { return visible ? { width: 10, height: 10 } : { width: 0, height: 0 }; }
  };
}

function root(nodes = []) {
  return { querySelectorAll() { return nodes; } };
}

function loc(pathname = '/', href = `https://chatgpt.com${pathname}`) {
  return { hostname: 'chatgpt.com', pathname, href };
}

test('page access classifies a normal ChatGPT composer as READY', () => {
  const result = classifyChatGptPageAccess({
    root: root([
      node({ tagName: 'TEXTAREA', attrs: { placeholder: 'Message ChatGPT' } }),
      node({ attrs: { 'aria-label': 'Send prompt' } })
    ]),
    location: loc('/c/abc'),
    title: 'ChatGPT'
  });
  assert.deepEqual(result, { status: 'READY', reason: 'chat_ui' });
});

test('page access classifies ChatGPT auth path as LOGIN_REQUIRED', () => {
  assert.deepEqual(
    classifyChatGptPageAccess({ root: root(), location: loc('/auth/login'), title: 'Log in' }),
    { status: 'LOGIN_REQUIRED', reason: 'login_url' }
  );
});

test('page access classifies visible login control without a composer as LOGIN_REQUIRED', () => {
  const result = classifyChatGptPageAccess({
    root: root([node({ tagName: 'A', text: 'Log in', attrs: { href: '/auth/login' } })]),
    location: loc('/'),
    title: 'ChatGPT'
  });
  assert.deepEqual(result, { status: 'LOGIN_REQUIRED', reason: 'login_control' });
});

test('page access classifies challenge title as CHALLENGE_REQUIRED', () => {
  assert.deepEqual(
    classifyChatGptPageAccess({ root: root(), location: loc('/'), title: 'Just a moment...' }),
    { status: 'CHALLENGE_REQUIRED', reason: 'challenge_title' }
  );
});

test('page access classifies visible challenge iframe/form semantics as CHALLENGE_REQUIRED', () => {
  const result = classifyChatGptPageAccess({
    root: root([
      node({ tagName: 'IFRAME', attrs: { src: '/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2' } }),
      node({ tagName: 'FORM', attrs: { action: '/cdn-cgi/challenge-platform/h/g/flow/ov1' } })
    ]),
    location: loc('/'),
    title: 'ChatGPT'
  });
  assert.deepEqual(result, { status: 'CHALLENGE_REQUIRED', reason: 'challenge_control' });
});

test('page access does not treat a normal Continue button as a security challenge', () => {
  const result = classifyChatGptPageAccess({
    root: root([
      node({ text: 'Continue' }),
      node({ tagName: 'TEXTAREA', attrs: { placeholder: 'Message ChatGPT' } })
    ]),
    location: loc('/c/abc'),
    title: 'ChatGPT'
  });
  assert.equal(result.status, 'READY');
});

test('page access does not scan arbitrary conversation text for login or challenge phrases', () => {
  const result = classifyChatGptPageAccess({
    root: root([
      node({ tagName: 'DIV', text: 'The user asked how to verify you are human and log in.' }),
      node({ tagName: 'TEXTAREA', attrs: { placeholder: 'Message ChatGPT' } })
    ]),
    location: loc('/c/abc'),
    title: 'ChatGPT'
  });
  assert.equal(result.status, 'READY');
});

test('assertChatGptPageAccessible fails closed with LOGIN_OR_CHALLENGE_REQUIRED', () => {
  assert.throws(
    () => assertChatGptPageAccessible({ root: root(), location: loc('/auth/login'), title: 'Log in' }),
    error => error instanceof RunnerError
      && error.code === ERROR_CODES.LOGIN_OR_CHALLENGE_REQUIRED
      && error.details?.accessStatus === 'LOGIN_REQUIRED'
      && !JSON.stringify(error.details).includes('Log in')
  );
});
