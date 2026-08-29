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

test('page access classifies an explicit ChatGPT usage-limit dialog as USAGE_LIMITED', () => {
  const result = classifyChatGptPageAccess({
    root: root([
      node({ tagName: 'DIV', text: "You've reached your usage limit for GPT-5. Try again later.", attrs: { role: 'dialog' } }),
      node({ tagName: 'TEXTAREA', attrs: { placeholder: 'Message ChatGPT' } })
    ]),
    location: loc('/c/abc'),
    title: 'ChatGPT'
  });
  assert.deepEqual(result, { status: 'USAGE_LIMITED', reason: 'usage_limit_dialog' });
  assert.throws(
    () => assertChatGptPageAccessible({
      root: root([node({ tagName: 'DIV', text: '您已达到 GPT-5 的使用上限，请稍后再试。', attrs: { role: 'alert' } })]),
      location: loc('/c/abc'),
      title: 'ChatGPT'
    }),
    error => error instanceof RunnerError
      && error.code === 'CHATGPT_ACCESS_LIMITED'
      && error.details?.accessStatus === 'USAGE_LIMITED'
      && !JSON.stringify(error.details).includes('GPT-5')
  );
});

test('page access classifies ChatGPT conversation-history request-frequency dialog as USAGE_LIMITED', () => {
  const result = classifyChatGptPageAccess({
    root: root([
      node({
        tagName: 'DIV',
        text: '请求过于频繁 你的请求过于频繁。为保障数据安全，我们已暂时限制你访问对话记录。请稍等几分钟后再重试。 明白了',
        attrs: { role: 'dialog' }
      }),
      node({ tagName: 'TEXTAREA', attrs: { placeholder: 'Message ChatGPT' } })
    ]),
    location: loc('/c/abc'),
    title: 'ChatGPT'
  });
  assert.deepEqual(result, { status: 'USAGE_LIMITED', reason: 'request_frequency_dialog' });
  assert.throws(
    () => assertChatGptPageAccessible({
      root: root([node({
        tagName: 'DIV',
        text: '请求过于频繁 你的请求过于频繁。为保障数据安全，我们已暂时限制你访问对话记录。请稍等几分钟后再重试。',
        attrs: { role: 'dialog' }
      })]),
      location: loc('/c/abc'),
      title: 'ChatGPT'
    }),
    error => error instanceof RunnerError
      && error.code === ERROR_CODES.CHATGPT_ACCESS_LIMITED
      && error.details?.reason === 'request_frequency_dialog'
      && !JSON.stringify(error.details).includes('对话记录')
  );
});

test('page access ignores usage-limit wording in ordinary conversation content', () => {
  const result = classifyChatGptPageAccess({
    root: root([
      node({ tagName: 'DIV', text: "The user says: you've reached your usage limit and should try again later." }),
      node({ tagName: 'TEXTAREA', attrs: { placeholder: 'Message ChatGPT' } })
    ]),
    location: loc('/c/abc'),
    title: 'ChatGPT'
  });
  assert.equal(result.status, 'READY');
});
