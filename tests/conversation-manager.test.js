import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationManager } from '../src/content/conversation-manager.js';

function message(role, text) {
  return {
    textContent: text,
    getAttribute(name) { return name === 'data-message-author-role' ? role : null; }
  };
}

test('round snapshot reports exact latest user text, assistant text, and DOM message role ordering', () => {
  const nodes = [
    message('user', 'first prompt'),
    message('assistant', 'first answer'),
    message('user', 'second prompt'),
    message('assistant', 'second answer')
  ];
  const root = { querySelectorAll() { return nodes; } };
  const snapshot = new ConversationManager(root).getRoundSnapshot();
  assert.deepEqual(snapshot, {
    latestRole: 'assistant',
    latestUserText: 'second prompt',
    latestAssistantText: 'second answer'
  });
});


function semanticControl(label) {
  return {
    clicked: false,
    textContent: '',
    hidden: false,
    getAttribute(name) { return name === 'aria-label' ? label : null; },
    click() { this.clicked = true; }
  };
}

test('prepareNewChat clicks the unique semantic New Chat control and requires the primary composer', () => {
  const newChat = semanticControl('New chat');
  const root = {
    querySelectorAll(selector) {
      if (selector.includes('button') || selector.includes('a[href]')) return [newChat];
      return [];
    },
    querySelector(selector) {
      if (selector === 'textarea, [contenteditable="true"]') return { tagName: 'TEXTAREA' };
      return null;
    }
  };

  const result = new ConversationManager(root).prepareNewChat();

  assert.equal(newChat.clicked, true);
  assert.deepEqual(result, { composerPresent: true });
});

test('currentConversationIdentity normalizes only exact ChatGPT conversation URLs', () => {
  const manager = new ConversationManager({});
  assert.deepEqual(manager.currentConversationIdentity('https://chatgpt.com/c/abc123?x=1#y'), {
    conversationUrl: 'https://chatgpt.com/c/abc123',
    conversationId: 'abc123'
  });
  assert.equal(manager.currentConversationIdentity('https://chatgpt.com/'), null);
  assert.equal(manager.currentConversationIdentity('https://example.com/c/abc123'), null);
  assert.equal(manager.currentConversationIdentity('https://chatgpt.com/c/abc123/extra'), null);
});

function cleanupNode({ tagName = 'DIV', text = '', attrs = {}, onClick = null } = {}) {
  return {
    tagName,
    textContent: text,
    hidden: false,
    parentElement: null,
    clicked: false,
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    querySelectorAll() { return []; },
    click() { this.clicked = true; onClick?.(); },
    dispatchEvent() {}
  };
}

function conversationCleanupFixture({ ambiguousDelete = false } = {}) {
  let currentAnchors = [];
  let menuOpen = false;
  let dialogOpen = false;
  const newChat = cleanupNode({ tagName: 'BUTTON', attrs: { 'aria-label': 'New chat' } });
  const confirm = cleanupNode({ tagName: 'BUTTON', text: 'Delete', attrs: { 'aria-label': 'Delete' }, onClick: () => {
    currentAnchors = currentAnchors.filter(anchor => anchor !== anchorB);
    dialogOpen = false;
  } });
  const dialog = cleanupNode({ tagName: 'DIV', attrs: { role: 'dialog' } });
  dialog.querySelectorAll = selector => selector.includes('button') ? [confirm] : [];
  const deleteA = cleanupNode({ tagName: 'DIV', text: 'Delete', attrs: { role: 'menuitem' }, onClick: () => { dialogOpen = true; } });
  const deleteB = cleanupNode({ tagName: 'DIV', text: 'Delete', attrs: { role: 'menuitem' }, onClick: () => { dialogOpen = true; } });
  const menuA = cleanupNode({ tagName: 'BUTTON', attrs: { 'aria-label': 'Chat options' }, onClick: () => { menuOpen = 'a'; } });
  const menuB = cleanupNode({ tagName: 'BUTTON', attrs: { 'aria-label': 'Chat options' }, onClick: () => { menuOpen = 'b'; } });
  const rowA = cleanupNode();
  const rowB = cleanupNode();
  rowA.querySelectorAll = selector => selector.includes('button') ? [menuA] : [];
  rowB.querySelectorAll = selector => selector.includes('button') ? [menuB] : [];
  const anchorA = cleanupNode({ tagName: 'A', text: 'Same visible title', attrs: { href: '/c/conv-a' } });
  const anchorB = cleanupNode({ tagName: 'A', text: 'Same visible title', attrs: { href: 'https://chatgpt.com/c/conv-b?utm_source=sidebar' } });
  anchorA.parentElement = rowA;
  anchorB.parentElement = rowB;
  currentAnchors = [anchorA, anchorB];
  const root = {
    querySelectorAll(selector) {
      if (selector === 'a[href]') return currentAnchors;
      if (selector === '[role="dialog"]' || selector === 'dialog[open]') return dialogOpen ? [dialog] : [];
      if (selector.includes('[role="menuitem"]')) {
        if (menuOpen === 'b') return ambiguousDelete ? [deleteA, deleteB] : [deleteB];
        if (menuOpen === 'a') return [deleteA];
        return [];
      }
      if (selector.includes('a[href]') || selector.includes('button')) return [newChat, ...currentAnchors, menuA, menuB];
      return [];
    },
    querySelector() { return null; }
  };
  return { root, anchorA, anchorB, menuA, menuB, confirm, getAnchors: () => currentAnchors };
}

test('deleteConversationById opens only the exact href row menu even when visible titles are identical', async () => {
  const fixture = conversationCleanupFixture();
  const manager = new ConversationManager(fixture.root, { sleep: async () => {}, pollMs: 1, timeoutMs: 10 });

  const result = await manager.deleteConversationById('conv-b');

  assert.deepEqual(result, { deleted: true, alreadyMissing: false, conversationId: 'conv-b' });
  assert.equal(fixture.menuA.clicked, false);
  assert.equal(fixture.menuB.clicked, true);
  assert.equal(fixture.confirm.clicked, true);
  assert.deepEqual(fixture.getAnchors().map(anchor => anchor.getAttribute('href')), ['/c/conv-a']);
});

test('deleteConversationById is idempotent when the exact owned conversation is already absent', async () => {
  const fixture = conversationCleanupFixture();
  const manager = new ConversationManager(fixture.root, { sleep: async () => {}, pollMs: 1, timeoutMs: 10 });

  const result = await manager.deleteConversationById('conv-missing');

  assert.deepEqual(result, { deleted: false, alreadyMissing: true, conversationId: 'conv-missing' });
  assert.equal(fixture.menuA.clicked, false);
  assert.equal(fixture.menuB.clicked, false);
});

test('deleteConversationById fails closed when exact row delete semantics are ambiguous', async () => {
  const fixture = conversationCleanupFixture({ ambiguousDelete: true });
  const manager = new ConversationManager(fixture.root, { sleep: async () => {}, pollMs: 1, timeoutMs: 10 });

  await assert.rejects(
    manager.deleteConversationById('conv-b'),
    error => error?.code === 'UI_SELECTOR_INCOMPATIBLE'
  );

  assert.equal(fixture.menuA.clicked, false);
  assert.equal(fixture.menuB.clicked, true);
  assert.equal(fixture.confirm.clicked, false);
  assert.equal(fixture.getAnchors().length, 2);
});
