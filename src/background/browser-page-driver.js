import { RunnerError, ERROR_CODES } from '../shared/errors.js';
import { makeAvailableProjectName, makeSessionId, buildProjectInstructions } from '../shared/project-naming.js';

export class BrowserPageDriver {
  constructor({
    tabManager,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    pollMs = 300,
    generationStartTimeoutMs = 15000,
    responseTimeoutMs = 20 * 60 * 1000,
    stableReadsRequired = 3,
    now = () => new Date(),
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    sessionIdFactory = () => makeSessionId(),
    resourceLoader = null
  }) {
    this.tabManager = tabManager;
    this.sleep = sleep;
    this.pollMs = pollMs;
    this.generationStartTimeoutMs = generationStartTimeoutMs;
    this.responseTimeoutMs = responseTimeoutMs;
    this.stableReadsRequired = stableReadsRequired;
    this.now = now;
    this.timeZone = timeZone;
    this.sessionIdFactory = sessionIdFactory;
    this.resourceLoader = resourceLoader;
    this.tabId = null;
  }

  async #send(message) {
    const response = await this.tabManager.send(this.tabId, message);
    if (response?.ok === false && response?.error) {
      const error = typeof response.error === 'object' ? response.error : { message: String(response.error) };
      throw new RunnerError(error.code ?? ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, error.message ?? 'ChatGPT content command failed', error);
    }
    return response;
  }

  async createTaskProject({ task }) {
    const tab = await this.tabManager.findChatGptTab();
    this.tabId = tab.id;
    const visible = await this.#send({ type: 'CHATGPT_LIST_PROJECTS' });
    const visibleNames = (visible ?? []).map(item => item?.name).filter(Boolean);
    const projectName = makeAvailableProjectName(task.project_id, visibleNames, this.now(), this.timeZone);
    const sessionId = this.sessionIdFactory();
    await this.#send({ type: 'CHATGPT_CREATE_PROJECT', projectName });
    await this.sleep(this.pollMs);
    const instructions = buildProjectInstructions({ sessionId, projectConstraints: task.project_constraints ?? '' });
    await this.#send({ type: 'CHATGPT_SET_PROJECT_INSTRUCTIONS', text: instructions });
    await this.sleep(this.pollMs);
    await this.#send({ type: 'CHATGPT_RESOLVE_CHAT' });
    return { projectName, sessionId, tabId: this.tabId };
  }

  async deleteTaskProject({ project }) {
    if (!project?.project_name) {
      throw new RunnerError(ERROR_CODES.PROJECT_NOT_FOUND, 'Task cleanup requires the exact owned ChatGPT Project name');
    }
    if (this.tabId == null) {
      const tab = await this.tabManager.findChatGptTab();
      this.tabId = tab.id;
    }
    return this.#send({ type: 'CHATGPT_DELETE_PROJECT', projectName: project.project_name });
  }

  async prepareExistingTask(task) {
    const projectName = task.chatgpt_project_name;
    const sessionId = task.session_id;
    if (!projectName || !sessionId) {
      throw new RunnerError(
        ERROR_CODES.PROJECT_NOT_FOUND,
        'Crash recovery requires persisted chatgpt_project_name and session_id mapping',
        { project_id: task.project_id }
      );
    }

    const tab = await this.tabManager.findChatGptTab();
    this.tabId = tab.id;
    await this.#send({ type: 'CHATGPT_OPEN_PROJECT', projectName });
    await this.sleep(this.pollMs);
    await this.#send({ type: 'CHATGPT_RESOLVE_CHAT' });
    return { projectName, sessionId, tabId: this.tabId };
  }

  async #waitForGeneratingOrContextLimit() {
    const maxPolls = Math.max(1, Math.ceil(this.generationStartTimeoutMs / this.pollMs));
    for (let i = 0; i < maxPolls; i++) {
      const status = await this.#send({ type: 'CHATGPT_STATE' });
      if (status?.contextLimit) return 'CONTEXT_LIMIT';
      if (status?.state === 'GENERATING') return 'GENERATING';
      await this.sleep(this.pollMs);
    }
    throw new RunnerError(ERROR_CODES.MODEL_DID_NOT_START, 'ChatGPT did not enter generating state after prompt submission');
  }

  async #waitForReadyOrContextLimit() {
    const maxPolls = Math.max(1, Math.ceil(this.responseTimeoutMs / this.pollMs));
    for (let i = 0; i < maxPolls; i++) {
      const status = await this.#send({ type: 'CHATGPT_STATE' });
      if (status?.contextLimit) return 'CONTEXT_LIMIT';
      if (status?.state === 'READY') return 'READY';
      await this.sleep(this.pollMs);
    }
    throw new RunnerError(ERROR_CODES.MODEL_RESPONSE_TIMEOUT, 'ChatGPT response did not return to ready state before timeout');
  }

  async #readStableAssistantText() {
    let last = null;
    let sameReads = 0;
    const maxPolls = Math.max(this.stableReadsRequired, Math.ceil(5000 / this.pollMs));
    for (let i = 0; i < maxPolls; i++) {
      const snapshot = await this.#send({ type: 'CHATGPT_LATEST_RESPONSE' });
      const current = snapshot?.text ?? '';
      if (current && current === last) {
        sameReads += 1;
        if (sameReads >= this.stableReadsRequired - 1) return current;
      } else {
        last = current;
        sameReads = current ? 1 : 0;
      }
      await this.sleep(this.pollMs);
    }
    throw new RunnerError(ERROR_CODES.MODEL_RESPONSE_TIMEOUT, 'Latest assistant message did not stabilize');
  }

  async #sendPromptAndWait(prompt) {
    if (this.tabId == null) throw new RunnerError(ERROR_CODES.CHAT_NOT_FOUND, 'ChatGPT tab is not prepared');
    await this.#send({ type: 'CHATGPT_SEND_PROMPT', text: prompt });
    if (await this.#waitForGeneratingOrContextLimit() === 'CONTEXT_LIMIT') {
      return { contextLimit: true, assistantText: '' };
    }
    if (await this.#waitForReadyOrContextLimit() === 'CONTEXT_LIMIT') {
      return { contextLimit: true, assistantText: '' };
    }
    return { contextLimit: false, assistantText: await this.#readStableAssistantText() };
  }

  async initializeTask({ task }) {
    if (!task?.resource) return { contextLimit: false, assistantText: '' };
    if (!this.resourceLoader) {
      throw new RunnerError(ERROR_CODES.RESOURCE_DOWNLOAD_FAILED, 'Task resource loader is not configured');
    }
    const resource = await this.resourceLoader.load(task.resource);
    await this.#send({ type: 'CHATGPT_ATTACH_RESOURCE', resource });
    return this.#sendPromptAndWait(task.initialization_prompt);
  }

  async runRound({ state, prompt }) {
    const response = await this.#sendPromptAndWait(prompt);
    if (response.contextLimit) return { ...response, patches: [] };
    const patches = await this.#send({
      type: 'CHATGPT_DISCOVER_PATCHES',
      sessionId: state.session_id,
      downloadedKeys: state.downloaded_patch_keys ?? []
    });
    return {
      ...response,
      patches: (patches ?? []).map(candidate => ({ ...candidate, tabId: this.tabId }))
    };
  }
}
