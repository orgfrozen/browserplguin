import { RunnerError, ERROR_CODES } from '../shared/errors.js';
import { isUiCompatibilityErrorCode } from './ui-compatibility-telemetry.js';
import { makeAvailableProjectName, buildProjectInstructions } from '../shared/project-naming.js';
import { INITIALIZATION_PROMPT, INITIALIZATION_READY_MARKER } from '../shared/task-schema.js';


function makeAvailablePreferredProjectName(preferredProjectName, visibleNames = []) {
  const preferred = String(preferredProjectName ?? '').trim();
  if (!preferred) return null;
  const names = new Set((visibleNames ?? []).map(value => String(value).trim()));
  if (!names.has(preferred)) return preferred;
  for (let collisionIndex = 2; collisionIndex <= 99; collisionIndex++) {
    const candidate = `${preferred}-${String(collisionIndex).padStart(2, '0')}`;
    if (!names.has(candidate)) return candidate;
  }
  throw new RangeError('unable to allocate a unique preferred project name within 99 collisions');
}

export class BrowserPageDriver {
  constructor({
    tabManager,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    pollMs = 300,
    generationStartTimeoutMs = 15000,
    stableReadsRequired = 3,
    now = () => new Date(),
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    resourceLoader = null,
    compatibilityTelemetry = null,
    abortSignal = null
  }) {
    this.tabManager = tabManager;
    this.sleep = sleep;
    this.pollMs = pollMs;
    this.generationStartTimeoutMs = generationStartTimeoutMs;
    this.stableReadsRequired = stableReadsRequired;
    this.now = now;
    this.timeZone = timeZone;
    this.resourceLoader = resourceLoader;
    this.compatibilityTelemetry = compatibilityTelemetry;
    this.abortSignal = abortSignal;
    this.tabId = null;
  }

  #assertNotAborted() {
    if (!this.abortSignal?.aborted) return;
    throw new RunnerError(ERROR_CODES.TASK_TERMINATED, 'Task execution terminated by operator');
  }

  async #wait(ms) {
    this.#assertNotAborted();
    await this.sleep(ms);
    this.#assertNotAborted();
  }


  #nowMs() {
    const value = this.now();
    return (value instanceof Date ? value : new Date(value)).getTime();
  }

  async #send(message) {
    this.#assertNotAborted();
    const response = await this.tabManager.send(this.tabId, message);
    this.#assertNotAborted();
    if (response?.ok === false && response?.error) {
      const error = typeof response.error === 'object' ? response.error : { message: String(response.error) };
      const runnerError = new RunnerError(error.code ?? ERROR_CODES.UI_SELECTOR_INCOMPATIBLE, error.message ?? 'ChatGPT content command failed', error);
      if (this.compatibilityTelemetry && isUiCompatibilityErrorCode(runnerError.code)) {
        try { await this.compatibilityTelemetry.record({ operation: message.type, error: runnerError }); } catch {}
      }
      throw runnerError;
    }
    return response;
  }

  async createTaskProject({ task, state = {}, preferredProjectName = null }) {
    const tab = await this.tabManager.findChatGptTab();
    this.tabId = tab.id;
    const visible = await this.#send({ type: 'CHATGPT_LIST_PROJECTS' });
    const visibleNames = (visible ?? []).map(item => item?.name).filter(Boolean);
    const projectName = makeAvailablePreferredProjectName(preferredProjectName, visibleNames)
      ?? makeAvailableProjectName(task.project_id, visibleNames, this.now(), this.timeZone);
    const patchSessionId = state.patch_session_id ?? state.source_preparation?.patch_session_id ?? task.patch_session_id ?? task.session_id ?? null;
    const browserWorkspaceId = state.assignment_id ?? task.agent_control?.assignment_id ?? projectName;
    const bootstrap = state.browser_execution_bootstrap ?? task.browser_execution_bootstrap ?? {};
    const instructions = buildProjectInstructions({
      project: bootstrap.project ?? { project_id: task.project_id },
      task: bootstrap.task ?? task,
      llmRules: state.source_preparation?.rules?.text ?? '',
      projectConstraints: task.project_constraints ?? ''
    });
    await this.#send({ type: 'CHATGPT_CREATE_PROJECT', projectName });
    await this.#wait(this.pollMs);
    await this.#send({ type: 'CHATGPT_SET_PROJECT_INSTRUCTIONS', text: instructions, projectName });
    await this.#wait(this.pollMs);
    await this.#send({ type: 'CHATGPT_RESOLVE_CHAT' });
    return { projectName, browserWorkspaceId, patchSessionId, tabId: this.tabId };
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
    const patchSessionId = task.patch_session_id ?? task.session_id;
    const browserWorkspaceId = task.browser_workspace_id ?? task.assignment_id ?? task.session_id;
    if (!projectName || !patchSessionId) {
      throw new RunnerError(
        ERROR_CODES.PROJECT_NOT_FOUND,
        'Crash recovery requires persisted chatgpt_project_name and PatchSync session mapping',
        { project_id: task.project_id }
      );
    }

    const tab = await this.tabManager.findChatGptTab();
    this.tabId = tab.id;
    await this.#send({ type: 'CHATGPT_OPEN_PROJECT', projectName });
    await this.#wait(this.pollMs);
    await this.#send({ type: 'CHATGPT_RESOLVE_CHAT' });
    return { projectName, browserWorkspaceId, patchSessionId, tabId: this.tabId };
  }

  async healthCheck() {
    if (this.tabId == null) {
      const tab = await this.tabManager.findChatGptTab();
      this.tabId = tab.id;
    }
    return this.#send({ type: 'CHATGPT_STATE' });
  }

  async reloadPage() {
    if (this.tabId == null) {
      const tab = await this.tabManager.findChatGptTab();
      this.tabId = tab.id;
    }
    const tab = await this.tabManager.reloadTab(this.tabId, { sleep: this.sleep, pollMs: this.pollMs });
    this.tabId = tab.id;
    await this.#wait(this.pollMs);
    return tab;
  }

  async reopenWorkspace({ state }) {
    const projectName = state?.task_project?.project_name ?? state?.chatgpt_project_name;
    if (!projectName) {
      throw new RunnerError(ERROR_CODES.PROJECT_NOT_FOUND, 'Workspace recovery requires the exact owned ChatGPT Project name');
    }
    if (this.tabId == null) {
      const tab = await this.tabManager.findChatGptTab();
      this.tabId = tab.id;
    }
    const tab = await this.tabManager.navigateTab(this.tabId, 'https://chatgpt.com/', { sleep: this.sleep, pollMs: this.pollMs });
    this.tabId = tab.id;
    await this.#wait(this.pollMs);
    await this.#send({ type: 'CHATGPT_OPEN_PROJECT', projectName });
    await this.#wait(this.pollMs);
    await this.#send({ type: 'CHATGPT_RESOLVE_CHAT' });
    return { projectName, tabId: this.tabId };
  }

  async #waitForGeneratingOrContextLimit() {
    const deadlineAt = this.#nowMs() + this.generationStartTimeoutMs;
    while (this.#nowMs() <= deadlineAt) {
      const status = await this.#send({ type: 'CHATGPT_STATE' });
      if (status?.contextLimit) return 'CONTEXT_LIMIT';
      if (status?.state === 'GENERATING') return 'GENERATING';
      if (this.#nowMs() >= deadlineAt) break;
      await this.#wait(this.pollMs);
    }
    throw new RunnerError(ERROR_CODES.MODEL_DID_NOT_START, 'ChatGPT did not enter generating state after prompt submission');
  }

  async #waitForReadyOrContextLimit(observationTimeoutMs = null, hooks = {}) {
    const bounded = Number.isFinite(observationTimeoutMs) && observationTimeoutMs > 0;
    let deadlineAt = bounded ? this.#nowMs() + observationTimeoutMs : null;
    let previousState = null;
    let previousTextLength = 0;

    while (deadlineAt === null || this.#nowMs() <= deadlineAt) {
      const status = await this.#send({ type: 'CHATGPT_STATE' });
      if (status?.contextLimit) return 'CONTEXT_LIMIT';
      if (status?.state === 'READY') return 'READY';

      let progressed = false;
      if (status?.state && status.state !== previousState) {
        previousState = status.state;
        progressed = true;
        await hooks.onMeaningfulProgress?.('model_state_transition');
      }

      if (status?.state === 'GENERATING') {
        const snapshot = await this.#send({ type: 'CHATGPT_LATEST_RESPONSE' });
        const length = String(snapshot?.text ?? '').length;
        if (length > previousTextLength) {
          previousTextLength = length;
          progressed = true;
          await hooks.onMeaningfulProgress?.('assistant_text_growth');
        }
      }

      if (bounded && progressed) deadlineAt = this.#nowMs() + observationTimeoutMs;
      if (deadlineAt !== null && this.#nowMs() >= deadlineAt) break;
      await this.#wait(this.pollMs);
    }
    throw new RunnerError(ERROR_CODES.MODEL_RESPONSE_TIMEOUT, 'ChatGPT response made no meaningful progress before the server observation timeout');
  }

  async #readStableAssistantText(hooks = {}) {
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
        if (current && current.length > String(last ?? '').length) {
          await hooks.onMeaningfulProgress?.('assistant_text_growth');
        }
        last = current;
        sameReads = current ? 1 : 0;
      }
      await this.#wait(this.pollMs);
    }
    throw new RunnerError(ERROR_CODES.MODEL_RESPONSE_TIMEOUT, 'Latest assistant message did not stabilize');
  }

  async #waitForExistingPromptResponse(hooks = {}, observationTimeoutMs = null) {
    if (await this.#waitForReadyOrContextLimit(observationTimeoutMs, hooks) === 'CONTEXT_LIMIT') {
      return { contextLimit: true, assistantText: '' };
    }
    const assistantText = await this.#readStableAssistantText(hooks);
    await hooks.onMeaningfulProgress?.('response_ready');
    await hooks.onResponseReady?.(assistantText);
    return { contextLimit: false, assistantText };
  }

  async #sendPromptAndWait(prompt, hooks = {}, observationTimeoutMs = null) {
    if (this.tabId == null) throw new RunnerError(ERROR_CODES.CHAT_NOT_FOUND, 'ChatGPT tab is not prepared');
    await this.#send({ type: 'CHATGPT_SEND_PROMPT', text: prompt });
    await hooks.onPromptSent?.();
    if (await this.#waitForGeneratingOrContextLimit() === 'CONTEXT_LIMIT') {
      return { contextLimit: true, assistantText: '' };
    }
    return this.#waitForExistingPromptResponse(hooks, observationTimeoutMs);
  }

  async #discoverRoundPatches(state, hooks = {}) {
    const patches = await this.#send({
      type: 'CHATGPT_DISCOVER_PATCHES',
      sessionId: state.patch_session_id ?? state.source_preparation?.patch_session_id ?? state.session_id,
      downloadedKeys: state.downloaded_patch_keys ?? []
    });
    if ((patches ?? []).length > 0) await hooks.onMeaningfulProgress?.('patch_discovered');
    return (patches ?? []).map(candidate => ({ ...candidate, tabId: this.tabId }));
  }

  async initializeTask({ task, resource = null, hooks = {}, observationTimeoutMs = null }) {
    let preparedResource = resource;
    if (!preparedResource && task?.resource) {
      if (!this.resourceLoader) {
        throw new RunnerError(ERROR_CODES.RESOURCE_DOWNLOAD_FAILED, 'Task resource loader is not configured');
      }
      this.#assertNotAborted();
      preparedResource = await this.resourceLoader.load(task.resource);
      this.#assertNotAborted();
    }
    if (!preparedResource) return { contextLimit: false, assistantText: '' };
    await hooks.onResourceDownloaded?.();
    await this.#send({ type: 'CHATGPT_ATTACH_RESOURCE', resource: preparedResource });
    await hooks.onResourceAttached?.();
    const result = await this.#sendPromptAndWait(INITIALIZATION_PROMPT, hooks, observationTimeoutMs);
    if (!result.contextLimit && String(result.assistantText ?? '').trim() !== INITIALIZATION_READY_MARKER) {
      throw new RunnerError(
        ERROR_CODES.INITIALIZATION_PROTOCOL_MISSING,
        'Initialization response did not include the required READY marker'
      );
    }
    return result;
  }

  async runRound({ state, prompt, hooks = {}, observationTimeoutMs = null }) {
    const response = await this.#sendPromptAndWait(prompt, hooks, observationTimeoutMs);
    if (response.contextLimit) return { ...response, patches: [] };
    return { ...response, patches: await this.#discoverRoundPatches(state, hooks) };
  }

  async recoverRound({ state, checkpoint, hooks = {}, observationTimeoutMs = null }) {
    if (this.tabId == null) throw new RunnerError(ERROR_CODES.CHAT_NOT_FOUND, 'ChatGPT tab is not prepared');
    const snapshot = await this.#send({ type: 'CHATGPT_ROUND_SNAPSHOT' });
    if (snapshot?.contextLimit) return { contextLimit: true, assistantText: '', patches: [] };

    const prompt = String(checkpoint?.prompt ?? '');
    const latestUserText = String(snapshot?.latestUserText ?? '');
    const latestAssistantText = String(snapshot?.latestAssistantText ?? '');
    const samePrompt = latestUserText.trim() === prompt.trim();

    if (checkpoint?.stage === 'RESPONSE_READY') {
      if (snapshot?.state !== 'READY' || !samePrompt || snapshot?.latestRole !== 'assistant' || latestAssistantText !== String(checkpoint.assistant_text ?? '')) {
        throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, 'Response-ready checkpoint does not match the current ChatGPT conversation');
      }
      return { contextLimit: false, assistantText: checkpoint.assistant_text ?? '', patches: await this.#discoverRoundPatches(state, hooks) };
    }

    if (checkpoint?.stage === 'PROMPT_SENT') {
      if (!samePrompt) {
        throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, 'Persisted sent Prompt is not the latest ChatGPT user message');
      }
      let response;
      if (snapshot?.state === 'GENERATING') {
        response = await this.#waitForExistingPromptResponse(hooks, observationTimeoutMs);
      } else if (snapshot?.state === 'READY' && snapshot?.latestRole === 'assistant') {
        const assistantText = await this.#readStableAssistantText(hooks);
        await hooks.onMeaningfulProgress?.('response_ready');
        await hooks.onResponseReady?.(assistantText);
        response = { contextLimit: false, assistantText };
      } else {
        throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, 'Sent Prompt recovery state is ambiguous');
      }
      if (response.contextLimit) return { ...response, patches: [] };
      return { ...response, patches: await this.#discoverRoundPatches(state, hooks) };
    }

    if (checkpoint?.stage === 'READY_TO_SEND') {
      if (samePrompt) {
        if (snapshot?.state === 'GENERATING') {
          await hooks.onPromptSent?.();
          const response = await this.#waitForExistingPromptResponse(hooks, observationTimeoutMs);
          if (response.contextLimit) return { ...response, patches: [] };
          return { ...response, patches: await this.#discoverRoundPatches(state, hooks) };
        }
        if (snapshot?.state === 'READY' && snapshot?.latestRole === 'assistant') {
          await hooks.onPromptSent?.();
          const assistantText = await this.#readStableAssistantText(hooks);
          await hooks.onMeaningfulProgress?.('response_ready');
          await hooks.onResponseReady?.(assistantText);
          return { contextLimit: false, assistantText, patches: await this.#discoverRoundPatches(state, hooks) };
        }
        throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, 'Prompt intent may already have been sent but the current ChatGPT state is ambiguous');
      }
      if (snapshot?.state !== 'READY' || (snapshot?.latestRole && snapshot.latestRole !== 'assistant')) {
        throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, 'ChatGPT does not prove that the durable Prompt intent is still unsent');
      }
      return this.runRound({ state, prompt, hooks, observationTimeoutMs });
    }

    throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, `Unsupported in-flight round checkpoint stage=${checkpoint?.stage ?? 'missing'}`);
  }
}
