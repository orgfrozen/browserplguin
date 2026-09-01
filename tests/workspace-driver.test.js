import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceDriver } from '../src/background/workspace-driver.js';
import { CHAT_INITIALIZATION_PROMPT } from '../src/shared/task-schema.js';
import { ERROR_CODES } from '../src/shared/errors.js';

test('Chat WorkspaceDriver creates normal Chat, initializes rules before source, and captures stable identity', async () => {
  const calls = [];
  const page = {
    async createTaskChat() { calls.push('create-chat'); return { projectName: null, browserWorkspaceId: 'a1', patchSessionId: 'ps1', tabId: 7 }; },
    async initializeTask(input) {
      calls.push(`resources:${input.resources.map(resource => resource.filename).join(',')}`);
      assert.equal(input.initializationPrompt, CHAT_INITIALIZATION_PROMPT);
      return { contextLimit: false, assistantText: '<INIT_STATUS>READY</INIT_STATUS>' };
    },
    async currentConversationIdentity() { calls.push('identity'); return { conversationUrl: 'https://chatgpt.com/c/conv-1', conversationId: 'conv-1' }; }
  };
  const driver = new WorkspaceDriver({ page });
  const state = { workspace_mode: 'chat' };

  await driver.create({ state });
  const initialized = await driver.initialize({
    state,
    task: { task_id: 't1' },
    artifacts: { rules: { filename: 'LLM_RULES.md' }, source: { filename: 'source.zip' } }
  });

  assert.equal(initialized.conversationIdentity.conversationId, 'conv-1');
  assert.deepEqual(calls, ['create-chat', 'resources:LLM_RULES.md,source.zip', 'identity']);
});

test('Chat WorkspaceDriver fails closed when stable conversation identity is unavailable after READY', async () => {
  const page = {
    async initializeTask() { return { contextLimit: false, assistantText: '<INIT_STATUS>READY</INIT_STATUS>' }; },
    async currentConversationIdentity() { return null; }
  };
  const driver = new WorkspaceDriver({ page });

  await assert.rejects(
    driver.initialize({
      state: { workspace_mode: 'chat' },
      task: { task_id: 't1' },
      artifacts: { rules: { filename: 'LLM_RULES.md' }, source: { filename: 'source.zip' } }
    }),
    error => error?.code === ERROR_CODES.CHAT_IDENTITY_MISSING
  );
});

test('WorkspaceDriver routes Chat prepare and reopen through exact-conversation methods only', async () => {
  const calls = [];
  const page = {
    async prepareExistingTask() { throw new Error('project prepare must not run'); },
    async reopenWorkspace() { throw new Error('project reopen must not run'); },
    async prepareExistingChat(input) { calls.push(`prepare:${input.chatgpt_conversation_id}`); return { conversationId: input.chatgpt_conversation_id }; },
    async reopenChatWorkspace({ state }) { calls.push(`reopen:${state.chatgpt_conversation_id}`); return { conversationId: state.chatgpt_conversation_id }; }
  };
  const driver = new WorkspaceDriver({ page });
  const state = { workspace_mode: 'chat', chatgpt_conversation_id: 'conv-1' };

  await driver.prepareExisting({ state, chatgpt_conversation_id: 'conv-1' });
  await driver.reopen({ state });

  assert.deepEqual(calls, ['prepare:conv-1', 'reopen:conv-1']);
});

test('Chat WorkspaceDriver captures exact conversation identity before exposing initialization PROMPT_SENT', async () => {
  const order = [];
  const page = {
    async initializeTask({ hooks = {} }) {
      order.push('page-send');
      await hooks.onPromptSent?.();
      order.push('page-wait-ready');
      return { contextLimit: false, assistantText: '<INIT_STATUS>READY</INIT_STATUS>' };
    },
    async currentConversationIdentity() {
      order.push('identity');
      return { conversationUrl: 'https://chatgpt.com/c/conv-before-sent', conversationId: 'conv-before-sent' };
    }
  };
  const driver = new WorkspaceDriver({ page });
  let captured = null;
  await driver.initialize({
    state: { workspace_mode: 'chat' },
    task: { task_id: 't1' },
    artifacts: { rules: { filename: 'LLM_RULES.md' }, source: { filename: 'source.zip' } },
    hooks: {
      async onConversationIdentity(identity) { order.push('persist-identity'); captured = identity; },
      async onPromptSent() { order.push('persist-prompt-sent'); assert.equal(captured?.conversationId, 'conv-before-sent'); }
    }
  });

  assert.deepEqual(order.slice(0, 5), ['page-send', 'identity', 'persist-identity', 'persist-prompt-sent', 'page-wait-ready']);
});

test('WorkspaceDriver routes Chat cleanup to exact conversation deletion', async () => {
  const calls = [];
  const page = {
    async deleteTaskProject() { throw new Error('project cleanup must not run'); },
    async deleteTaskChat({ state }) { calls.push(state.chatgpt_conversation_id); return { deleted: true, conversationId: state.chatgpt_conversation_id }; }
  };
  const driver = new WorkspaceDriver({ page });
  const state = { workspace_mode: 'chat', chatgpt_conversation_id: 'conv-owned' };

  const result = await driver.cleanup({ task: { task_id: 't1' }, state });

  assert.deepEqual(calls, ['conv-owned']);
  assert.equal(result.deleted, true);
});

test('Chat WorkspaceDriver promotes a verified canonical conversation identity after initialization READY', async () => {
  const persisted = [];
  let identityRead = 0;
  const page = {
    async initializeTask({ hooks = {} }) {
      await hooks.onPromptSent?.();
      return { contextLimit: false, assistantText: '<INIT_STATUS>READY</INIT_STATUS>' };
    },
    async currentConversationIdentity() {
      identityRead += 1;
      return identityRead === 1
        ? { conversationUrl: 'https://chatgpt.com/c/provisional-a', conversationId: 'provisional-a' }
        : { conversationUrl: 'https://chatgpt.com/c/canonical-b', conversationId: 'canonical-b' };
    },
    async currentRoundSnapshot() {
      return {
        state: 'READY',
        latestRole: 'assistant',
        latestUserText: CHAT_INITIALIZATION_PROMPT,
        latestAssistantText: '<INIT_STATUS>READY</INIT_STATUS>'
      };
    }
  };
  const driver = new WorkspaceDriver({ page });

  const initialized = await driver.initialize({
    state: { workspace_mode: 'chat' },
    task: { task_id: 't-canonical' },
    artifacts: { rules: { filename: 'LLM_RULES.md' }, source: { filename: 'source.zip' } },
    hooks: {
      async onConversationIdentity(identity) { persisted.push(identity.conversationId); }
    }
  });

  assert.equal(initialized.conversationIdentity.conversationId, 'canonical-b');
  assert.deepEqual(persisted, ['provisional-a', 'canonical-b']);
});

test('Chat WorkspaceDriver blocks an unverified conversation identity transition with diagnostic proof details', async () => {
  let identityRead = 0;
  const page = {
    async initializeTask({ hooks = {} }) {
      await hooks.onPromptSent?.();
      return { contextLimit: false, assistantText: '<INIT_STATUS>READY</INIT_STATUS>' };
    },
    async currentConversationIdentity() {
      identityRead += 1;
      return identityRead === 1
        ? { conversationUrl: 'https://chatgpt.com/c/owned-a', conversationId: 'owned-a' }
        : { conversationUrl: 'https://chatgpt.com/c/other-b', conversationId: 'other-b' };
    },
    async currentRoundSnapshot() {
      return {
        state: 'READY',
        latestRole: 'assistant',
        latestUserText: 'different user prompt',
        latestAssistantText: '<INIT_STATUS>READY</INIT_STATUS>'
      };
    }
  };
  const driver = new WorkspaceDriver({ page });

  await assert.rejects(
    driver.initialize({
      state: { workspace_mode: 'chat' },
      task: { task_id: 't-block' },
      artifacts: { rules: { filename: 'LLM_RULES.md' }, source: { filename: 'source.zip' } }
    }),
    error => {
      assert.equal(error?.code, ERROR_CODES.TASK_RECOVERY_BLOCKED);
      assert.equal(error?.details?.previous_conversation_id, 'owned-a');
      assert.equal(error?.details?.current_conversation_id, 'other-b');
      assert.equal(error?.details?.previous_conversation_url, 'https://chatgpt.com/c/owned-a');
      assert.equal(error?.details?.current_conversation_url, 'https://chatgpt.com/c/other-b');
      assert.equal(error?.details?.latest_user_matches, false);
      assert.equal(error?.details?.ready_marker_matches, true);
      assert.equal(error?.details?.state_ready, true);
      assert.equal(error?.details?.latest_role_assistant, true);
      return true;
    }
  );
});
