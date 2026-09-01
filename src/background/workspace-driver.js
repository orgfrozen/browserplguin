import { WORKSPACE_MODES, resolveWorkspaceMode } from '../shared/workspace-mode.js';
import { RunnerError, ERROR_CODES } from '../shared/errors.js';
import { CHAT_INITIALIZATION_PROMPT } from '../shared/task-schema.js';

export class WorkspaceDriver {
  constructor({ page }) {
    this.page = page;
  }

  mode(state) {
    return resolveWorkspaceMode(state);
  }

  async create(input) {
    if (this.mode(input.state) === WORKSPACE_MODES.PROJECT) {
      return this.page.createTaskProject(input);
    }
    if (typeof this.page.createTaskChat !== 'function') {
      throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Chat workspace creation is unavailable');
    }
    return this.page.createTaskChat(input);
  }

  async configure(input) {
    if (this.mode(input.state) !== WORKSPACE_MODES.PROJECT) {
      return { saved: true, mode: WORKSPACE_MODES.CHAT };
    }
    if (typeof this.page.configureTaskProject !== 'function') {
      return { saved: true, mode: WORKSPACE_MODES.PROJECT, skipped: true };
    }
    return this.page.configureTaskProject(input);
  }

  async initialize(input) {
    if (this.mode(input.state) === WORKSPACE_MODES.PROJECT) {
      return this.page.initializeTask({ ...input, resource: input.artifacts?.source ?? input.resource ?? null });
    }
    const rules = input.artifacts?.rules ?? null;
    const source = input.artifacts?.source ?? input.resource ?? null;
    if (!rules || !source) {
      throw new RunnerError(ERROR_CODES.RESOURCE_DOWNLOAD_FAILED, 'Chat initialization requires both LLM_RULES.md and the source ZIP');
    }
    if (typeof this.page.currentConversationIdentity !== 'function') {
      throw new RunnerError(ERROR_CODES.CHAT_IDENTITY_MISSING, 'Chat conversation identity capture is unavailable');
    }
    const outerHooks = input.hooks ?? {};
    let promptConversationIdentity = null;
    const initialized = await this.page.initializeTask({
      ...input,
      resource: null,
      resources: [rules, source],
      initializationPrompt: CHAT_INITIALIZATION_PROMPT,
      hooks: {
        ...outerHooks,
        onPromptSent: async (...args) => {
          const identity = await this.page.currentConversationIdentity();
          if (!identity?.conversationUrl || !identity?.conversationId) {
            throw new RunnerError(
              ERROR_CODES.CHAT_IDENTITY_MISSING,
              'ChatGPT did not expose a stable conversation identity immediately after initialization Prompt submission'
            );
          }
          promptConversationIdentity = identity;
          await outerHooks.onConversationIdentity?.(identity);
          await outerHooks.onPromptSent?.(...args);
        }
      }
    });
    if (initialized?.contextLimit) return initialized;
    const conversationIdentity = await this.page.currentConversationIdentity();
    if (!conversationIdentity?.conversationUrl || !conversationIdentity?.conversationId) {
      throw new RunnerError(ERROR_CODES.CHAT_IDENTITY_MISSING, 'ChatGPT did not expose a stable conversation identity after initialization');
    }
    if (promptConversationIdentity && (
      promptConversationIdentity.conversationId !== conversationIdentity.conversationId
      || promptConversationIdentity.conversationUrl !== conversationIdentity.conversationUrl
    )) {
      throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, 'ChatGPT conversation identity changed during initialization');
    }
    return { ...initialized, conversationIdentity };
  }

  async prepareExisting(input) {
    if (this.mode(input.state) === WORKSPACE_MODES.CHAT) {
      if (typeof this.page.prepareExistingChat !== 'function') {
        throw new RunnerError(ERROR_CODES.CHAT_NOT_FOUND, 'Exact Chat workspace preparation is unavailable');
      }
      return this.page.prepareExistingChat(input);
    }
    if (typeof this.page.prepareExistingTask !== 'function') {
      throw new RunnerError(ERROR_CODES.CHAT_NOT_FOUND, 'Existing ChatGPT workspace preparation is unavailable');
    }
    return this.page.prepareExistingTask(input);
  }

  async reopen(input) {
    if (this.mode(input.state) === WORKSPACE_MODES.CHAT) {
      if (typeof this.page.reopenChatWorkspace !== 'function') {
        throw new RunnerError(ERROR_CODES.CHAT_NOT_FOUND, 'Exact Chat workspace reopen is unavailable');
      }
      return this.page.reopenChatWorkspace(input);
    }
    if (typeof this.page.reopenWorkspace !== 'function') {
      throw new RunnerError(ERROR_CODES.CHAT_NOT_FOUND, 'ChatGPT workspace reopen is unavailable');
    }
    return this.page.reopenWorkspace(input);
  }

  async cleanup(input) {
    if (this.mode(input.state) === WORKSPACE_MODES.PROJECT) {
      return this.page.deleteTaskProject({ ...input, project: input.project ?? input.state?.task_project });
    }
    if (typeof this.page.deleteTaskChat !== 'function') {
      throw new RunnerError(ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, 'Exact Chat workspace cleanup is unavailable');
    }
    return this.page.deleteTaskChat(input);
  }
}
