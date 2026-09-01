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
