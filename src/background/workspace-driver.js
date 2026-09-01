import { WORKSPACE_MODES, resolveWorkspaceMode } from '../shared/workspace-mode.js';
import { RunnerError, ERROR_CODES } from '../shared/errors.js';

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
    throw new RunnerError(
      ERROR_CODES.UI_SELECTOR_INCOMPATIBLE,
      'Chat workspace mode is not enabled in this build'
    );
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
    return this.page.initializeTask(input);
  }

  async prepareExisting(input) {
    if (typeof this.page.prepareExistingTask !== 'function') {
      throw new RunnerError(ERROR_CODES.CHAT_NOT_FOUND, 'Existing ChatGPT workspace preparation is unavailable');
    }
    return this.page.prepareExistingTask(input);
  }

  async reopen(input) {
    if (typeof this.page.reopenWorkspace !== 'function') {
      throw new RunnerError(ERROR_CODES.CHAT_NOT_FOUND, 'ChatGPT workspace reopen is unavailable');
    }
    return this.page.reopenWorkspace(input);
  }

  async cleanup(input) {
    if (this.mode(input.state) === WORKSPACE_MODES.PROJECT) {
      return this.page.deleteTaskProject({ ...input, project: input.project ?? input.state?.task_project });
    }
    throw new RunnerError(
      ERROR_CODES.UI_SELECTOR_INCOMPATIBLE,
      'Chat workspace cleanup is not enabled in this build'
    );
  }
}
