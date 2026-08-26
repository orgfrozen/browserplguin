import { RunnerError, ERROR_CODES } from '../shared/errors.js';
import { isUiCompatibilityErrorCode } from './ui-compatibility-telemetry.js';
import { makeAvailableProjectName, buildProjectInstructions } from '../shared/project-naming.js';
import { INITIALIZATION_PROMPT, INITIALIZATION_READY_MARKER } from '../shared/task-schema.js';


function responseMayContainPatch(text) {
  return /(?:下载|download)\s*patch\b|\.patch\b/i.test(String(text ?? ''));
}

function normalizeConversationUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.origin !== 'https://chatgpt.com') return null;
    if (!/(?:^|\/)c\/[^/]+/.test(url.pathname)) return null;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

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
    nativeRetryLimit = 2,
    recoveryNativeRetryLimit = 1,
    composerPollMs = 2000,
    composerStallTimeoutMs = 180000,
    patchDiscoverySettlePollMs = 400,
    patchDiscoverySettleAttempts = 10,
    now = () => new Date(),
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    resourceLoader = null,
    compatibilityTelemetry = null,
    tabSlotStore = null,
    cleanupLegacyProjects = false,
    onLegacyProjectCleanupWarning = null,
    abortSignal = null
  }) {
    this.tabManager = tabManager;
    this.sleep = sleep;
    this.pollMs = pollMs;
    this.generationStartTimeoutMs = generationStartTimeoutMs;
    this.stableReadsRequired = stableReadsRequired;
    this.nativeRetryLimit = nativeRetryLimit;
    this.recoveryNativeRetryLimit = recoveryNativeRetryLimit;
    this.composerPollMs = composerPollMs;
    this.composerStallTimeoutMs = composerStallTimeoutMs;
    this.patchDiscoverySettlePollMs = Number.isFinite(Number(patchDiscoverySettlePollMs)) && Number(patchDiscoverySettlePollMs) > 0
      ? Number(patchDiscoverySettlePollMs) : 400;
    this.patchDiscoverySettleAttempts = Number.isInteger(Number(patchDiscoverySettleAttempts)) && Number(patchDiscoverySettleAttempts) > 0
      ? Number(patchDiscoverySettleAttempts) : 10;
    this.now = now;
    this.timeZone = timeZone;
    this.resourceLoader = resourceLoader;
    this.compatibilityTelemetry = compatibilityTelemetry;
    this.tabSlotStore = tabSlotStore;
    this.cleanupLegacyProjects = cleanupLegacyProjects === true;
    this.onLegacyProjectCleanupWarning = typeof onLegacyProjectCleanupWarning === 'function' ? onLegacyProjectCleanupWarning : null;
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

  async #activateOwnedTab() {
    if (!Number.isInteger(Number(this.tabId)) || typeof this.tabManager.activateTab !== 'function') return;
    await this.tabManager.activateTab(Number(this.tabId));
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
    if (this.compatibilityTelemetry?.recordSuccess) {
      try { await this.compatibilityTelemetry.recordSuccess({ operation: message.type }); } catch {}
    }
    return response;
  }

  #composerWaitOptions() {
    return { pollMs: this.composerPollMs, stallTimeoutMs: this.composerStallTimeoutMs };
  }

  async #cleanupLegacyProjectWorkspaces(task, state, preferredProjectName, visibleProjects) {
    if (!this.cleanupLegacyProjects || preferredProjectName || state?.task_project?.project_name || state?.chatgpt_project_name) return;
    const prefix = `${task.project_id}_ewan_`;
    for (const project of visibleProjects ?? []) {
      const projectName = String(project?.name ?? '').trim();
      if (!projectName.startsWith(prefix)) continue;
      try {
        await this.#send({ type: 'CHATGPT_DELETE_PROJECT', projectName });
      } catch (error) {
        this.onLegacyProjectCleanupWarning?.({
          project_id: task.project_id,
          project_name: projectName,
          code: error?.code ?? 'LEGACY_PROJECT_CLEANUP_FAILED',
          message: error?.message ?? String(error)
        });
      }
    }
  }

  async createTaskProject({ task, state = {}, preferredProjectName = null }) {
    let tab = null;
    let slot = null;
    if (this.tabSlotStore) {
      slot = await this.tabSlotStore.load();
      if (Number.isInteger(slot?.tab_id) && typeof this.tabManager.getTab === 'function') {
        try { tab = await this.tabManager.getTab(slot.tab_id); } catch { tab = null; }
      }
    }
    if (!tab) {
      tab = typeof this.tabManager.createChatGptTab === 'function'
        ? await this.tabManager.createChatGptTab({ sleep: this.sleep, pollMs: this.pollMs })
        : await this.tabManager.findChatGptTab();
    }
    this.tabId = tab.id;
    if (typeof this.tabManager.activateTab === 'function') await this.tabManager.activateTab(this.tabId);
    if (slot && typeof this.tabManager.navigateTab === 'function') {
      await this.tabManager.navigateTab(this.tabId, 'https://chatgpt.com/', { sleep: this.sleep, pollMs: this.pollMs });
    }
    if (this.tabSlotStore) slot = await this.tabSlotStore.assign({ taskId: task.task_id, tabId: this.tabId });
    const visible = await this.#send({ type: 'CHATGPT_LIST_PROJECTS' });
    await this.#cleanupLegacyProjectWorkspaces(task, state, preferredProjectName, visible);
    const visibleNames = (visible ?? []).map(item => item?.name).filter(Boolean);
    const projectName = makeAvailablePreferredProjectName(preferredProjectName, visibleNames)
      ?? makeAvailableProjectName(task.project_id, visibleNames, this.now(), this.timeZone);
    const patchSessionId = state.patch_session_id ?? state.source_preparation?.patch_session_id ?? task.patch_session_id ?? task.session_id ?? null;
    const browserWorkspaceId = state.assignment_id ?? task.agent_control?.assignment_id ?? projectName;
    await this.#send({ type: 'CHATGPT_CREATE_PROJECT', projectName });
    await this.#wait(this.pollMs);
    return {
      projectName, browserWorkspaceId, patchSessionId, tabId: this.tabId,
      ...(slot ? { slotId: slot.slot_id, slotGeneration: slot.generation } : {})
    };
  }

  async configureTaskProject({ task, state = {} }) {
    const projectName = state.task_project?.project_name ?? state.chatgpt_project_name ?? null;
    if (!projectName) {
      throw new RunnerError(ERROR_CODES.PROJECT_NOT_FOUND, 'Project setup requires the exact created ChatGPT Project name');
    }
    if (this.tabId == null) {
      const ownedTabId = Number(state.chatgpt_tab_id ?? state.task_project?.chatgpt_tab_id);
      if (Number.isInteger(ownedTabId) && typeof this.tabManager.getTab === 'function') {
        const tab = await this.tabManager.getTab(ownedTabId);
        this.tabId = tab.id;
      } else {
        const tab = await this.tabManager.findChatGptTab();
        this.tabId = tab.id;
      }
    }
    await this.#activateOwnedTab();
    const bootstrap = state.browser_execution_bootstrap ?? task.browser_execution_bootstrap ?? {};
    const instructions = buildProjectInstructions({
      project: bootstrap.project ?? { project_id: task.project_id },
      task: bootstrap.task ?? task,
      llmRules: state.source_preparation?.rules?.text ?? '',
      projectConstraints: task.project_constraints ?? ''
    });
    await this.#send({ type: 'CHATGPT_SET_PROJECT_INSTRUCTIONS', text: instructions, projectName });
    await this.#wait(this.pollMs);
    await this.#send({ type: 'CHATGPT_RESOLVE_CHAT' });
    return { saved: true, projectName };
  }

  async deleteTaskProject({ project }) {
    if (!project?.project_name) {
      throw new RunnerError(ERROR_CODES.PROJECT_NOT_FOUND, 'Task cleanup requires the exact owned ChatGPT Project name');
    }
    if (this.tabId == null) {
      const ownedTabId = Number(project.chatgpt_tab_id);
      if (Number.isInteger(ownedTabId) && typeof this.tabManager.getTab === 'function') {
        const tab = await this.tabManager.getTab(ownedTabId);
        this.tabId = tab.id;
      } else {
        const tab = await this.tabManager.findChatGptTab();
        this.tabId = tab.id;
      }
    }
    await this.#activateOwnedTab();
    return this.#send({ type: 'CHATGPT_DELETE_PROJECT', projectName: project.project_name });
  }

  async releaseTaskTab({ state }) {
    const slotId = state?.browser_slot_id ?? state?.task_project?.browser_slot_id ?? 'chatgpt-1';
    const ownedTabId = Number(state?.chatgpt_tab_id ?? state?.task_project?.chatgpt_tab_id ?? this.tabId);
    let reusableTabId = Number.isInteger(ownedTabId) ? ownedTabId : null;
    if (reusableTabId !== null && typeof this.tabManager.getTab === 'function') {
      try {
        await this.tabManager.getTab(reusableTabId);
        if (typeof this.tabManager.navigateTab === 'function') {
          await this.tabManager.navigateTab(reusableTabId, 'https://chatgpt.com/', { sleep: this.sleep, pollMs: this.pollMs });
        }
      } catch {
        reusableTabId = null;
      }
    }
    if (!this.tabSlotStore) return { slot_id: slotId, tab_id: reusableTabId, task_id: null, generation: state?.browser_slot_generation ?? 0, status: 'idle' };
    return this.tabSlotStore.release({ taskId: state?.task_id ?? null, tabId: reusableTabId, slotId });
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

    let tab = null;
    let recreatedOwnedTab = false;
    let slot = null;
    const ownedTabId = Number(task.chatgpt_tab_id);
    if (Number.isInteger(ownedTabId)) {
      try {
        tab = typeof this.tabManager.getTab === 'function'
          ? await this.tabManager.getTab(ownedTabId)
          : null;
      } catch {
        tab = null;
      }
      if (!tab && typeof this.tabManager.createChatGptTab === 'function') {
        tab = await this.tabManager.createChatGptTab({ sleep: this.sleep, pollMs: this.pollMs });
        recreatedOwnedTab = true;
      }
    }
    if (!tab) tab = await this.tabManager.findChatGptTab();
    this.tabId = tab.id;
    await this.#activateOwnedTab();
    if (recreatedOwnedTab && this.tabSlotStore) {
      slot = await this.tabSlotStore.assign({
        taskId: task.task_id,
        tabId: this.tabId,
        slotId: task.browser_slot_id ?? 'chatgpt-1'
      });
    }
    const conversationUrl = normalizeConversationUrl(task.chatgpt_conversation_url);
    if (conversationUrl && typeof this.tabManager.navigateTab === 'function') {
      await this.tabManager.navigateTab(this.tabId, conversationUrl, { sleep: this.sleep, pollMs: this.pollMs });
    } else {
      await this.#send({ type: 'CHATGPT_OPEN_PROJECT', projectName });
      await this.#wait(this.pollMs);
    }
    await this.#send({ type: 'CHATGPT_RESOLVE_CHAT' });
    const slotId = slot?.slot_id ?? task.browser_slot_id ?? null;
    const slotGeneration = slot?.generation ?? task.browser_slot_generation ?? null;
    return {
      projectName,
      browserWorkspaceId,
      patchSessionId,
      tabId: this.tabId,
      conversationUrl,
      ...(slotId ? { slotId } : {}),
      ...(Number.isInteger(Number(slotGeneration)) ? { slotGeneration: Number(slotGeneration) } : {})
    };
  }

  async currentConversationUrl() {
    if (this.tabId == null) {
      const tab = await this.tabManager.findChatGptTab();
      this.tabId = tab.id;
    }
    const tab = typeof this.tabManager.getTab === 'function'
      ? await this.tabManager.getTab(this.tabId)
      : await this.tabManager.findChatGptTab();
    return normalizeConversationUrl(tab?.url);
  }

  async discoverCurrentPatches({ state, settle = false, hooks = {} } = {}) {
    const ownedTabId = Number(state?.chatgpt_tab_id ?? state?.task_project?.chatgpt_tab_id);
    if (Number.isInteger(ownedTabId) && typeof this.tabManager.getTab === 'function') {
      try {
        const tab = await this.tabManager.getTab(ownedTabId);
        this.tabId = tab.id;
        if (typeof this.tabManager.activateTab === 'function') await this.tabManager.activateTab(this.tabId);
      } catch (error) {
        throw new RunnerError(ERROR_CODES.CHAT_NOT_FOUND, `Owned ChatGPT tab ${ownedTabId} is no longer available`, {
          tab_id: ownedTabId,
          cause: error?.message ?? String(error)
        });
      }
    } else {
      const tab = await this.tabManager.findChatGptTab();
      this.tabId = tab.id;
    }
    return this.discoverPatches({ state, settle, hooks });
  }

  async healthCheck() {
    if (this.tabId == null) {
      const tab = await this.tabManager.findChatGptTab();
      this.tabId = tab.id;
    }
    return this.#send({ type: 'CHATGPT_STATE' });
  }

  async reloadPage({ state = {} } = {}) {
    if (this.tabId == null) {
      const ownedTabId = Number(state.chatgpt_tab_id ?? state.task_project?.chatgpt_tab_id);
      if (Number.isInteger(ownedTabId) && typeof this.tabManager.getTab === 'function') {
        const tab = await this.tabManager.getTab(ownedTabId);
        this.tabId = tab.id;
      } else {
        const tab = await this.tabManager.findChatGptTab();
        this.tabId = tab.id;
      }
    }
    await this.#activateOwnedTab();
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
      const ownedTabId = Number(state?.chatgpt_tab_id ?? state?.task_project?.chatgpt_tab_id);
      if (Number.isInteger(ownedTabId) && typeof this.tabManager.getTab === 'function') {
        const ownedTab = await this.tabManager.getTab(ownedTabId);
        this.tabId = ownedTab.id;
      } else {
        const activeTab = await this.tabManager.findChatGptTab();
        this.tabId = activeTab.id;
      }
    }
    await this.#activateOwnedTab();
    const tab = await this.tabManager.navigateTab(this.tabId, 'https://chatgpt.com/', { sleep: this.sleep, pollMs: this.pollMs });
    this.tabId = tab.id;
    await this.#wait(this.pollMs);
    await this.#send({ type: 'CHATGPT_OPEN_PROJECT', projectName });
    await this.#wait(this.pollMs);
    await this.#send({ type: 'CHATGPT_RESOLVE_CHAT' });
    return { projectName, tabId: this.tabId };
  }

  async #retryExplicitResponseFailure(status, retryState, hooks = {}) {
    if (!status?.responseFailure?.failed) return false;
    if (!status.responseFailure.retryAvailable || retryState.attempts >= retryState.limit) {
      throw new RunnerError(ERROR_CODES.MODEL_RESPONSE_FAILED, 'ChatGPT reported an explicit response failure after native Retry recovery was exhausted', {
        retry_attempts: retryState.attempts,
        retry_limit: retryState.limit,
        retry_available: Boolean(status.responseFailure.retryAvailable)
      });
    }
    const result = await this.#send({ type: 'CHATGPT_RETRY_RESPONSE' });
    if (result?.retried !== true) {
      throw new RunnerError(ERROR_CODES.MODEL_RESPONSE_FAILED, 'ChatGPT explicit response failure could not be retried in place', {
        retry_attempts: retryState.attempts,
        retry_limit: retryState.limit,
        retry_reason: result?.reason ?? 'unknown'
      });
    }
    retryState.attempts += 1;
    await hooks.onMeaningfulProgress?.('model_response_retry');
    await this.#wait(this.pollMs);
    return true;
  }

  async #waitForGeneratingOrContextLimit(hooks = {}, retryState = { attempts: 0, limit: this.nativeRetryLimit }) {
    const deadlineAt = this.#nowMs() + this.generationStartTimeoutMs;
    while (this.#nowMs() <= deadlineAt) {
      const status = await this.#send({ type: 'CHATGPT_STATE' });
      if (status?.contextLimit) return 'CONTEXT_LIMIT';
      if (await this.#retryExplicitResponseFailure(status, retryState, hooks)) continue;
      if (status?.state === 'GENERATING') return 'GENERATING';
      if (this.#nowMs() >= deadlineAt) break;
      await this.#wait(this.pollMs);
    }
    throw new RunnerError(ERROR_CODES.MODEL_DID_NOT_START, 'ChatGPT did not enter generating state after prompt submission');
  }

  async #waitForReadyOrContextLimit(observationTimeoutMs = null, hooks = {}, retryState = { attempts: 0, limit: this.nativeRetryLimit }) {
    const bounded = Number.isFinite(observationTimeoutMs) && observationTimeoutMs > 0;
    let deadlineAt = bounded ? this.#nowMs() + observationTimeoutMs : null;
    let previousState = null;
    let previousTextLength = 0;

    while (deadlineAt === null || this.#nowMs() <= deadlineAt) {
      const status = await this.#send({ type: 'CHATGPT_STATE' });
      if (status?.contextLimit) return 'CONTEXT_LIMIT';
      if (await this.#retryExplicitResponseFailure(status, retryState, hooks)) continue;
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

  async #waitForExistingPromptResponse(hooks = {}, observationTimeoutMs = null, retryState = { attempts: 0, limit: this.nativeRetryLimit }) {
    if (await this.#waitForReadyOrContextLimit(observationTimeoutMs, hooks, retryState) === 'CONTEXT_LIMIT') {
      return { contextLimit: true, assistantText: '' };
    }
    const assistantText = await this.#readStableAssistantText(hooks);
    await hooks.onMeaningfulProgress?.('response_ready');
    await hooks.onResponseReady?.(assistantText);
    return { contextLimit: false, assistantText };
  }

  async #sendPromptAndWait(prompt, hooks = {}, observationTimeoutMs = null) {
    if (this.tabId == null) throw new RunnerError(ERROR_CODES.CHAT_NOT_FOUND, 'ChatGPT tab is not prepared');
    await this.#send({ type: 'CHATGPT_SEND_PROMPT', text: prompt, options: this.#composerWaitOptions() });
    await hooks.onPromptSent?.();
    const retryState = { attempts: 0, limit: this.nativeRetryLimit };
    if (await this.#waitForGeneratingOrContextLimit(hooks, retryState) === 'CONTEXT_LIMIT') {
      return { contextLimit: true, assistantText: '' };
    }
    return this.#waitForExistingPromptResponse(hooks, observationTimeoutMs, retryState);
  }

  async #discoverPatchesOnce(state, hooks = {}) {
    const patches = await this.#send({
      type: 'CHATGPT_DISCOVER_PATCHES',
      sessionId: state.patch_session_id ?? state.source_preparation?.patch_session_id ?? state.session_id,
      downloadedKeys: state.downloaded_patch_keys ?? []
    });
    if ((patches ?? []).length > 0) await hooks.onMeaningfulProgress?.('patch_discovered');
    return (patches ?? []).map(candidate => ({ ...candidate, tabId: this.tabId }));
  }

  async discoverPatches({ state, settle = false, hooks = {} } = {}) {
    if (this.tabId == null) throw new RunnerError(ERROR_CODES.CHAT_NOT_FOUND, 'ChatGPT tab is not prepared');
    let patches = await this.#discoverPatchesOnce(state ?? {}, hooks);
    if (!settle || patches.length > 0) return patches;
    for (let attempt = 1; attempt < this.patchDiscoverySettleAttempts; attempt++) {
      await this.#wait(this.patchDiscoverySettlePollMs);
      patches = await this.#discoverPatchesOnce(state ?? {}, hooks);
      if (patches.length > 0) return patches;
    }
    return [];
  }

  async #resumeInitializationIfAlreadySent(hooks = {}, observationTimeoutMs = null) {
    const snapshot = await this.#send({ type: 'CHATGPT_ROUND_SNAPSHOT' });
    if (String(snapshot?.latestUserText ?? '').trim() !== INITIALIZATION_PROMPT.trim()) return null;
    await hooks.onMeaningfulProgress?.('initialization_prompt_already_sent');
    if (snapshot?.contextLimit) return { contextLimit: true, assistantText: '' };

    const retryState = { attempts: 0, limit: this.recoveryNativeRetryLimit };
    if (snapshot?.state === 'READY' && snapshot?.latestRole === 'assistant') {
      return this.#waitForExistingPromptResponse(hooks, observationTimeoutMs, retryState);
    }
    if (snapshot?.state === 'GENERATING') {
      return this.#waitForExistingPromptResponse(hooks, observationTimeoutMs, retryState);
    }
    if (await this.#waitForGeneratingOrContextLimit(hooks, retryState) === 'CONTEXT_LIMIT') {
      return { contextLimit: true, assistantText: '' };
    }
    return this.#waitForExistingPromptResponse(hooks, observationTimeoutMs, retryState);
  }

  #assertInitializationProtocol(result) {
    if (!result?.contextLimit && String(result?.assistantText ?? '').trim() !== INITIALIZATION_READY_MARKER) {
      throw new RunnerError(
        ERROR_CODES.INITIALIZATION_PROTOCOL_MISSING,
        'Initialization response did not include the required READY marker'
      );
    }
    return result;
  }

  async initializeTask({ task, resource = null, hooks = {}, observationTimeoutMs = null }) {
    await this.#activateOwnedTab();
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
    const resumed = await this.#resumeInitializationIfAlreadySent(hooks, observationTimeoutMs);
    if (resumed) {
      await hooks.onResourceDownloaded?.();
      await hooks.onResourceAttached?.();
      return this.#assertInitializationProtocol(resumed);
    }
    await hooks.onResourceDownloaded?.();
    await this.#send({ type: 'CHATGPT_ATTACH_RESOURCE', resource: preparedResource, options: this.#composerWaitOptions() });
    await hooks.onResourceAttached?.();
    return this.#assertInitializationProtocol(await this.#sendPromptAndWait(INITIALIZATION_PROMPT, hooks, observationTimeoutMs));
  }

  async runRound({ state, prompt, hooks = {}, observationTimeoutMs = null }) {
    await this.#activateOwnedTab();
    const response = await this.#sendPromptAndWait(prompt, hooks, observationTimeoutMs);
    if (response.contextLimit) return { ...response, patches: [] };
    return { ...response, patches: await this.discoverPatches({ state, settle: responseMayContainPatch(response.assistantText), hooks }) };
  }

  async recoverRound({ state, checkpoint, hooks = {}, observationTimeoutMs = null }) {
    if (this.tabId == null) throw new RunnerError(ERROR_CODES.CHAT_NOT_FOUND, 'ChatGPT tab is not prepared');
    await this.#activateOwnedTab();
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
      return { contextLimit: false, assistantText: checkpoint.assistant_text ?? '', patches: await this.discoverPatches({ state, settle: responseMayContainPatch(checkpoint.assistant_text), hooks }) };
    }

    if (checkpoint?.stage === 'PROMPT_SENT') {
      if (!samePrompt) {
        throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, 'Persisted sent Prompt is not the latest ChatGPT user message');
      }
      let response;
      if (snapshot?.state === 'GENERATING') {
        response = await this.#waitForExistingPromptResponse(hooks, observationTimeoutMs, { attempts: 0, limit: this.recoveryNativeRetryLimit });
      } else if (snapshot?.state === 'READY' && snapshot?.latestRole === 'assistant') {
        const retryState = { attempts: 0, limit: this.recoveryNativeRetryLimit };
        const status = await this.#send({ type: 'CHATGPT_STATE' });
        if (await this.#retryExplicitResponseFailure(status, retryState, hooks)) {
          if (await this.#waitForGeneratingOrContextLimit(hooks, retryState) === 'CONTEXT_LIMIT') {
            response = { contextLimit: true, assistantText: '' };
          } else {
            response = await this.#waitForExistingPromptResponse(hooks, observationTimeoutMs, retryState);
          }
        } else {
          const assistantText = await this.#readStableAssistantText(hooks);
          await hooks.onMeaningfulProgress?.('response_ready');
          await hooks.onResponseReady?.(assistantText);
          response = { contextLimit: false, assistantText };
        }
      } else {
        throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, 'Sent Prompt recovery state is ambiguous');
      }
      if (response.contextLimit) return { ...response, patches: [] };
      return { ...response, patches: await this.discoverPatches({ state, settle: responseMayContainPatch(response.assistantText), hooks }) };
    }

    if (checkpoint?.stage === 'READY_TO_SEND') {
      if (samePrompt) {
        if (snapshot?.state === 'GENERATING') {
          await hooks.onPromptSent?.();
          const response = await this.#waitForExistingPromptResponse(hooks, observationTimeoutMs, { attempts: 0, limit: this.recoveryNativeRetryLimit });
          if (response.contextLimit) return { ...response, patches: [] };
          return { ...response, patches: await this.discoverPatches({ state, settle: responseMayContainPatch(response.assistantText), hooks }) };
        }
        if (snapshot?.state === 'READY' && snapshot?.latestRole === 'assistant') {
          await hooks.onPromptSent?.();
          const retryState = { attempts: 0, limit: this.recoveryNativeRetryLimit };
          const status = await this.#send({ type: 'CHATGPT_STATE' });
          if (await this.#retryExplicitResponseFailure(status, retryState, hooks)) {
            if (await this.#waitForGeneratingOrContextLimit(hooks, retryState) === 'CONTEXT_LIMIT') {
              return { contextLimit: true, assistantText: '', patches: [] };
            }
            const response = await this.#waitForExistingPromptResponse(hooks, observationTimeoutMs, retryState);
            if (response.contextLimit) return { ...response, patches: [] };
            return { ...response, patches: await this.discoverPatches({ state, settle: responseMayContainPatch(response.assistantText), hooks }) };
          }
          const assistantText = await this.#readStableAssistantText(hooks);
          await hooks.onMeaningfulProgress?.('response_ready');
          await hooks.onResponseReady?.(assistantText);
          return { contextLimit: false, assistantText, patches: await this.discoverPatches({ state, settle: responseMayContainPatch(assistantText), hooks }) };
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
