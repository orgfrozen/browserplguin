import test from 'node:test';
import assert from 'node:assert/strict';
import { installContentScript } from '../src/content/content-script.js';

function node({ tagName = 'DIV', text = '', attrs = {}, children = [], onClick = null } = {}) {
  const value = {
    tagName,
    textContent: text,
    hidden: false,
    children,
    parentElement: null,
    clicked: 0,
    getAttribute(name) { return attrs[name] ?? null; },
    getBoundingClientRect() { return { width: 30, height: 30 }; },
    click() { this.clicked += 1; onClick?.(); },
    querySelectorAll(selector) {
      const descendants = [];
      const visit = current => {
        for (const child of current.children ?? []) {
          descendants.push(child);
          visit(child);
        }
      };
      visit(this);
      if (selector.includes('button') || selector.includes('[role="button"]')) {
        return descendants.filter(item => item.tagName === 'BUTTON' || item.getAttribute?.('role') === 'button');
      }
      return descendants;
    }
  };
  for (const child of children) child.parentElement = value;
  return value;
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

function promoFixture() {
  let dialogs = [];
  const close = node({ tagName: 'BUTTON', attrs: { 'aria-label': '关闭' }, onClick: () => { dialogs = []; } });
  const download = node({ tagName: 'BUTTON', text: '下载应用' });
  const dialog = node({
    text: '在 ChatGPT 应用中，体验更佳 使用 ChatGPT 应用，结合你的本地文件。 下载应用',
    attrs: { role: 'dialog' },
    children: [close, download]
  });
  const root = {
    documentElement: { nodeName: 'HTML' },
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]' || selector === 'dialog[open]') return dialogs;
      if (selector.includes('button') || selector.includes('[role="button"]')) return dialogs.length ? [close, download] : [];
      if (selector.includes('[data-sidebar-item="true"]')) return [];
      if (selector.includes('a[href]') || selector.includes('[role="link"]')) return [];
      return [];
    },
    showPromotion() { dialogs = [dialog]; }
  };
  return { root, close, download };
}

test('content automation dismisses a known ChatGPT promotion before a UI command', async () => {
  const fixture = promoFixture();
  fixture.root.showPromotion();
  const harness = runtimeHarness();
  installContentScript({
    runtime: harness.runtime,
    root: fixture.root,
    location: { hostname: 'chatgpt.com', pathname: '/', href: 'https://chatgpt.com/' },
    title: 'ChatGPT'
  });

  const result = await harness.send({ type: 'CHATGPT_LIST_PROJECTS' });

  assert.deepEqual(result, []);
  assert.equal(fixture.close.clicked, 1);
  assert.equal(fixture.download.clicked, 0);
});

test('content automation observer dismisses the promotion when it appears while waiting', () => {
  const fixture = promoFixture();
  let callback = null;
  class FakeMutationObserver {
    constructor(fn) { callback = fn; }
    observe() {}
    disconnect() {}
  }
  const harness = runtimeHarness();
  installContentScript({
    runtime: harness.runtime,
    root: fixture.root,
    location: { hostname: 'chatgpt.com', pathname: '/', href: 'https://chatgpt.com/' },
    title: 'ChatGPT',
    MutationObserverCtor: FakeMutationObserver
  });

  fixture.root.showPromotion();
  callback?.([]);

  assert.equal(fixture.close.clicked, 1);
  assert.equal(fixture.download.clicked, 0);
});
