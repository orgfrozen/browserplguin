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
