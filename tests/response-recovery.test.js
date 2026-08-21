import test from 'node:test';
import assert from 'node:assert/strict';
import { ResponseRecovery } from '../src/content/response-recovery.js';

function element({ tagName = 'DIV', text = '', attrs = {}, children = [], visible = true } = {}) {
  const node = {
    tagName,
    textContent: text,
    hidden: !visible,
    children,
    parentElement: null,
    clicked: 0,
    getAttribute(name) { return attrs[name] ?? null; },
    getBoundingClientRect() { return visible ? { width: 120, height: 32 } : { width: 0, height: 0 }; },
    click() { this.clicked += 1; },
    querySelectorAll(selector) {
      const descendants = [];
      const visit = current => {
        for (const child of current.children ?? []) {
          descendants.push(child);
          visit(child);
        }
      };
      visit(this);
      if (selector.includes('button') || selector.includes('[role="button"]') || selector.includes('[data-testid]')) {
        return descendants.filter(child => child.tagName === 'BUTTON' || child.getAttribute?.('role') === 'button' || child.getAttribute?.('data-testid'));
      }
      if (selector.includes('[role="alert"]') || selector.includes('[data-testid*="error"]')) {
        return descendants.filter(child => child.getAttribute?.('role') === 'alert' || String(child.getAttribute?.('data-testid') ?? '').includes('error'));
      }
      return descendants;
    }
  };
  for (const child of children) child.parentElement = node;
  return node;
}

function rootWithTurn(turn) {
  return {
    body: turn,
    querySelectorAll(selector) {
      if (selector.includes('[data-message-author-role="assistant"]')) return [turn];
      return turn.querySelectorAll(selector);
    }
  };
}

test('detects an explicit failed assistant turn and clicks the semantic Retry action', () => {
  const error = element({ text: '生成回复时出现错误，请重试。', attrs: { role: 'alert' } });
  const retry = element({ tagName: 'BUTTON', attrs: { 'aria-label': '重试', 'data-testid': 'retry-turn-action-button' } });
  const turn = element({
    text: '生成回复时出现错误，请重试。',
    attrs: { 'data-message-author-role': 'assistant' },
    children: [error, retry]
  });
  const recovery = new ResponseRecovery(rootWithTurn(turn));

  assert.deepEqual(recovery.getFailureState(), { failed: true, retryAvailable: true });
  assert.deepEqual(recovery.retryLatestResponse(), { retried: true });
  assert.equal(retry.clicked, 1);
});

test('does not treat the normal regenerate action on a successful response as an error', () => {
  const retry = element({ tagName: 'BUTTON', attrs: { 'aria-label': '重新生成', 'data-testid': 'regenerate-turn-action-button' } });
  const turn = element({
    text: '修改完成。<TASK_STATUS>DONE</TASK_STATUS>',
    attrs: { 'data-message-author-role': 'assistant' },
    children: [retry]
  });
  const recovery = new ResponseRecovery(rootWithTurn(turn));

  assert.deepEqual(recovery.getFailureState(), { failed: false, retryAvailable: false });
  assert.deepEqual(recovery.retryLatestResponse(), { retried: false, reason: 'response_not_failed' });
  assert.equal(retry.clicked, 0);
});

test('reports explicit failure without retry control without clicking unrelated actions', () => {
  const copy = element({ tagName: 'BUTTON', attrs: { 'aria-label': '复制回复', 'data-testid': 'copy-turn-action-button' } });
  const error = element({ text: 'Something went wrong while generating the response.', attrs: { role: 'alert' } });
  const turn = element({
    text: 'Something went wrong while generating the response.',
    attrs: { 'data-message-author-role': 'assistant' },
    children: [error, copy]
  });
  const recovery = new ResponseRecovery(rootWithTurn(turn));

  assert.deepEqual(recovery.getFailureState(), { failed: true, retryAvailable: false });
  assert.deepEqual(recovery.retryLatestResponse(), { retried: false, reason: 'retry_not_found' });
  assert.equal(copy.clicked, 0);
});

test('detects a short explicit failure turn even when ChatGPT does not expose role=alert semantics', () => {
  const retry = element({ tagName: 'BUTTON', attrs: { 'aria-label': '重试' } });
  const turn = element({
    text: '出了点问题。请稍后重试。',
    attrs: { 'data-message-author-role': 'assistant' },
    children: [retry]
  });
  const recovery = new ResponseRecovery(rootWithTurn(turn));

  assert.deepEqual(recovery.getFailureState(), { failed: true, retryAvailable: true });
});
