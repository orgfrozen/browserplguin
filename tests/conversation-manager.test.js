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
