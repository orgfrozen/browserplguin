import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseExactProjectCandidate } from '../src/content/project-manager.js';
import { RunnerError, ERROR_CODES } from '../src/shared/errors.js';
import { ChatGptAdapter } from '../src/content/chatgpt-adapter.js';

test('exact project identity beats substring matches', () => {
  const candidates = [
    { name: 'vetatool-old', href: '/project/1' },
    { name: 'vetatool', href: '/project/2' },
    { name: 'my-vetatool-test', href: '/project/3' }
  ];
  assert.deepEqual(chooseExactProjectCandidate(candidates, 'vetatool'), { name: 'vetatool', href: '/project/2' });
});

test('uncertain project selection fails closed', () => {
  assert.throws(
    () => chooseExactProjectCandidate([{ name: 'vetatool-old' }, { name: 'vetatool-new' }], 'vetatool'),
    error => error instanceof RunnerError && error.code === ERROR_CODES.PROJECT_NOT_FOUND
  );
});

test('duplicate exact identities are ambiguous and fail closed', () => {
  assert.throws(
    () => chooseExactProjectCandidate([{ name: 'vetatool', href: 'a' }, { name: 'vetatool', href: 'b' }], 'vetatool'),
    error => error instanceof RunnerError && error.code === ERROR_CODES.UI_SELECTOR_INCOMPATIBLE
  );
});


test('project listing includes visible sidebar Project rows whose hover-only menus are hidden', () => {
  const projectManager = {
    listVisibleSidebarProjects() {
      return [
        { name: 'vetatool_ewan_202608291835', href: null },
        { name: 'vetatool_ewan_202608291828', href: null },
        { name: 'vetatool_ewan_202608291211', href: null }
      ];
    },
    listVisibleProjects() {
      return [{ name: 'vetatool_ewan_202608291835', href: null }];
    }
  };
  const adapter = new ChatGptAdapter({ projectManager, root: {} });

  assert.deepEqual(adapter.listProjects(), [
    { name: 'vetatool_ewan_202608291835', href: null },
    { name: 'vetatool_ewan_202608291828', href: null },
    { name: 'vetatool_ewan_202608291211', href: null }
  ]);
});


test('adapter exposes normal Chat preparation and stable conversation identity through ConversationManager', () => {
  const calls = [];
  const conversationManager = {
    prepareNewChat() { calls.push('new-chat'); return { composerPresent: true }; },
    currentConversationIdentity(href) { calls.push(`identity:${href}`); return { conversationUrl: 'https://chatgpt.com/c/conv-1', conversationId: 'conv-1' }; }
  };
  const adapter = new ChatGptAdapter({
    root: {},
    conversationManager,
    projectManager: {},
    composer: {},
    location: { href: 'https://chatgpt.com/c/conv-1?x=1' }
  });

  assert.deepEqual(adapter.prepareNewChat(), { composerPresent: true });
  assert.deepEqual(adapter.currentConversationIdentity(), { conversationUrl: 'https://chatgpt.com/c/conv-1', conversationId: 'conv-1' });
  assert.deepEqual(calls, ['new-chat', 'identity:https://chatgpt.com/c/conv-1?x=1']);
});

test('adapter delegates exact conversation cleanup by id without title fallback', async () => {
  const calls = [];
  const conversationManager = {
    async deleteConversationById(conversationId) {
      calls.push(conversationId);
      return { deleted: true, alreadyMissing: false, conversationId };
    }
  };
  const adapter = new ChatGptAdapter({ root: {}, conversationManager, projectManager: {}, composer: {} });

  const result = await adapter.deleteConversation('conv-owned');

  assert.deepEqual(calls, ['conv-owned']);
  assert.equal(result.conversationId, 'conv-owned');
});
