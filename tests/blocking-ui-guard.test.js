import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockingUiGuard } from '../src/content/blocking-ui-guard.js';

function element({ tagName = 'DIV', text = '', attrs = {}, children = [], visible = true, onClick = null } = {}) {
  const el = {
    tagName,
    textContent: text,
    hidden: !visible,
    children,
    parentElement: null,
    clicked: 0,
    getAttribute(name) { return attrs[name] ?? null; },
    getBoundingClientRect() { return visible ? { width: 100, height: 40 } : { width: 0, height: 0 }; },
    click() { this.clicked += 1; onClick?.(); },
    querySelectorAll(selector) {
      const descendants = [];
      const visit = node => {
        for (const child of node.children ?? []) {
          descendants.push(child);
          visit(child);
        }
      };
      visit(this);
      if (selector.includes('button') || selector.includes('[role="button"]')) {
        return descendants.filter(node => node.tagName === 'BUTTON' || node.getAttribute?.('role') === 'button');
      }
      return descendants;
    }
  };
  for (const child of children) child.parentElement = el;
  return el;
}

function rootWithDialogs(dialogs) {
  return {
    documentElement: {},
    querySelectorAll(selector) {
      if (selector.includes('[role="dialog"]') || selector.includes('dialog[open]')) return dialogs;
      return [];
    }
  };
}

test('dismissKnownPromotions closes the ChatGPT desktop-app promotion without clicking its download CTA', () => {
  const close = element({ tagName: 'BUTTON', attrs: { 'aria-label': '关闭' } });
  const download = element({ tagName: 'BUTTON', text: '下载应用' });
  const dialog = element({
    text: '在 ChatGPT 应用中，体验更佳 使用 ChatGPT 应用，结合你的本地文件、文件夹、应用和浏览器页面。 下载应用',
    attrs: { role: 'dialog' },
    children: [close, download]
  });
  const guard = new BlockingUiGuard(rootWithDialogs([dialog]));

  const result = guard.dismissKnownPromotions();

  assert.equal(result.dismissed, 1);
  assert.equal(close.clicked, 1);
  assert.equal(download.clicked, 0);
});

test('dismissKnownPromotions leaves delete confirmations and security dialogs untouched', () => {
  const deleteButton = element({ tagName: 'BUTTON', text: '从“聊天”和“工作”中删除' });
  const cancel = element({ tagName: 'BUTTON', text: '取消' });
  const deleteDialog = element({
    text: '要从“聊天”和“工作”中删除此项目吗？',
    attrs: { role: 'dialog' },
    children: [deleteButton, cancel]
  });
  const verify = element({ tagName: 'BUTTON', text: 'Verify you are human' });
  const securityDialog = element({
    text: 'Security verification Verify you are human',
    attrs: { role: 'dialog' },
    children: [verify]
  });
  const guard = new BlockingUiGuard(rootWithDialogs([deleteDialog, securityDialog]));

  const result = guard.dismissKnownPromotions();

  assert.equal(result.dismissed, 0);
  assert.equal(deleteButton.clicked, 0);
  assert.equal(cancel.clicked, 0);
  assert.equal(verify.clicked, 0);
});

test('observe auto-dismisses a known promotion that appears while the task is waiting', () => {
  let dialogs = [];
  let observerCallback = null;
  let observedTarget = null;
  let disconnected = false;
  class FakeMutationObserver {
    constructor(callback) { observerCallback = callback; }
    observe(target) { observedTarget = target; }
    disconnect() { disconnected = true; }
  }
  const root = {
    documentElement: { nodeName: 'HTML' },
    querySelectorAll(selector) {
      if (selector.includes('[role="dialog"]') || selector.includes('dialog[open]')) return dialogs;
      return [];
    }
  };
  const close = element({ tagName: 'BUTTON', attrs: { title: 'Close' } });
  const download = element({ tagName: 'BUTTON', text: 'Download app' });
  const dialog = element({
    text: 'Get more from ChatGPT with the desktop app. Download app',
    attrs: { role: 'dialog' },
    children: [close, download]
  });
  const guard = new BlockingUiGuard(root, { MutationObserverCtor: FakeMutationObserver });

  const stop = guard.observe();
  dialogs = [dialog];
  observerCallback?.([]);

  assert.equal(observedTarget, root.documentElement);
  assert.equal(close.clicked, 1);
  assert.equal(download.clicked, 0);
  stop();
  assert.equal(disconnected, true);
});
