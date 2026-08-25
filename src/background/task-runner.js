import { normalizeTask } from '../shared/task-schema.js';
import { createExecutionState, recordCreatedWorkspace, recordCompletedPatch, recordPatchStatusTarget, clearPatchStatusTarget, markWorkspaceDeleted, checkpointRoundIntent, markRoundPromptSent, markRoundResponseReady, completeRound, markInitializationCompleted, beginSourcePreparation, recordPatchSyncExport, recordPreparedSource, markMeaningfulProgress, beginExternalWait, recordExternalWaitCheck, recordExternalStatusQuery, recordExternalResync, recordExternalEscalation, clearExternalWait, markLeaseLost } from '../shared/execution-state.js';
import { parseTaskStatus, decideTaskAction } from '../shared/status-protocol.js';
import { RunnerError, ERROR_CODES } from '../shared/errors.js';
import { RecoveryPolicyEngine } from './recovery-policy-engine.js';
import { isConfirmedLeaseLoss } from './heartbeat-manager.js';
import { extractPatchIdentity } from '../shared/patch-identity.js';
import { AUTONOMY_CONTINUATION_PROMPT, classifyAssistantInteraction } from '../shared/model-interaction.js';
import { isRetryableSourceError, sourceRetryDelayMs } from './source-retry-policy.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function continuationPrompt(task, state) {
  if (typeof state.server_continuation_prompt === 'string' && state.server_continuation_prompt.trim()) return state.server_continuation_prompt.trim();
  if (typeof state.server_continuation_summary === 'string' && state.server_continuation_summary.trim()) {
    return `服务端验收尚未通过：${state.server_continuation_summary.trim()}\n继续当前任务，不要重复已经完成的工作。`;
  }
  if (task.patch_goal?.minimum) {
    const remaining = Math.max(0, task.patch_goal.minimum - state.task_patch_count);
    return `继续当前任务。Patch 目标至少 ${task.patch_goal.minimum} 个；当前本 Task 已成功下载 ${state.task_patch_count} 个，还需要至少 ${remaining} 个。不要重复已完成工作。`;
  }
  return '继续当前任务，直到满足任务目标和验收要求。不要重复已经完成的工作。';
}


function concise(value, max = 1600) {
  const text = String(value ?? '').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function exactPatchMatches(target, patch) {
  if (!target || !patch || typeof patch !== 'object') return false;
  if (String(patch.session_id ?? '') !== String(target.session_id ?? '')) return false;
  if (Number(patch.sequence) !== Number(target.sequence)) return false;
  if (typeof patch.patch_filename === 'string' && patch.patch_filename.trim()
      && patch.patch_filename.trim() !== target.filename) return false;
  return true;
}

function patchDecisionPrompt(target, patch) {
  const nextAction = String(patch?.next_action ?? 'stop');
  const lines = [
    '这个 Patch 的远程状态已经由服务端判定，请继续当前 Task 和当前 ChatGPT Project，不要创建新 Task。',
    `包名：${target.filename}`,
    `远程状态：${patch?.status ?? 'unknown'}`,
    `服务端 next_action：${nextAction}`
  ];
  if (patch?.decision_reason) lines.push(`原因：${concise(patch.decision_reason, 800)}`);
  if (patch?.failed_job) lines.push(`失败 Job：${concise(patch.failed_job, 300)}`);
  if (patch?.failed_step) lines.push(`失败步骤：${concise(patch.failed_step, 300)}`);
  if (patch?.error_summary) lines.push(`错误摘要：${concise(patch.error_summary, 1200)}`);
  if (patch?.error_excerpt) lines.push(`错误片段：${concise(patch.error_excerpt, 1600)}`);
  if (patch?.suggestion) lines.push(`服务端建议：${concise(patch.suggestion, 800)}`);
  if (nextAction === 'retry_same_sequence') {
    lines.push(
      `请修复上述问题并重新生成同一序号 Patch：SEQUENCE=${Number(target.sequence)}。`,
      'PARENT_SEQUENCE 保持该序号原本的值不变；必须更换英文描述或使用 -r2/-r3 后缀，避免同名缓存。',
      '不要推进到下一个序号。'
    );
  } else if (nextAction === 'next_sequence') {
    const suggested = Number.isInteger(Number(patch?.suggested_sequence))
      ? Number(patch.suggested_sequence)
      : Number(target.sequence) + 1;
    lines.push(
      `上一 Patch 已经合入或服务端要求后续修复；如果当前 Task 仍需继续，请生成下一个 Patch：SEQUENCE=${suggested}。`,
      `PARENT_SEQUENCE=${Number(target.sequence)}，继续处理上述服务端反馈，不要重复已经完成的工作。`
    );
  }
  return lines.join('\n');
}

function completionStatusResult(preview) {
  const directive = String(preview?.directive ?? 'UNKNOWN');
  const patchStatus = typeof preview?.latest_patch?.status === 'string' && preview.latest_patch.status.trim()
    ? preview.latest_patch.status.trim()
    : null;
  return patchStatus ? `completion:${directive}:${patchStatus}` : `completion:${directive}`;
}

function transientStatusQueryError(error) {
  if (!error) return false;
  if (Number.isInteger(error.status)) return error.status >= 500;
  return error instanceof TypeError || /fetch|network|timeout|temporar|unavailable/i.test(String(error.message ?? ''));
}

function taskResult(task, state, extra = {}) {
  return {
    task_patch_count: Math.max(state.task_patch_count ?? 0, state.server_successful_patch_count ?? 0),
    task_round_count: state.task_round_count,
    session_id: state.patch_session_id ?? state.source_preparation?.patch_session_id ?? state.session_id,
    project_name: state.chatgpt_project_name,
    patch_goal: task.patch_goal,
    ...extra
  };
}

export class TaskRunner {
  constructor({ taskApi, taskStore, page, processPatch, artifactTransfer = null, heartbeat = null, observer = null, patchSyncClientFactory = null, recoveryPolicyEngine = null, fallbackLimit = 2, maxTaskRounds = 100, maxWorkspaceRetries = 5, maxInitializationRestarts = null, patchStatusPollMs = 5000, externalStatusPollMs = 10000, now = () => new Date(), abortSignal = null }) {
    this.taskApi = taskApi;
    this.taskStore = taskStore;
    this.page = page;
    this.processPatch = processPatch;
    this.artifactTransfer = artifactTransfer;
    this.heartbeat = heartbeat;
    this.observer = observer;
    this.patchSyncClientFactory = patchSyncClientFactory;
    this.recoveryPolicyEngine = recoveryPolicyEngine ?? new RecoveryPolicyEngine({ page, taskStore });
    this.fallbackLimit = fallbackLimit;
    this.maxTaskRounds = maxTaskRounds;
    const legacyInitializationLimit = maxInitializationRestarts == null ? null : Number(maxInitializationRestarts);
    const configuredWorkspaceLimit = Number(maxWorkspaceRetries);
    this.maxWorkspaceRetries = Number.isInteger(legacyInitializationLimit) && legacyInitializationLimit >= 0
      ? legacyInitializationLimit
      : Number.isInteger(configuredWorkspaceLimit) && configuredWorkspaceLimit >= 0 ? configuredWorkspaceLimit : 5;
    this.maxInitializationRestarts = this.maxWorkspaceRetries;
    const configuredPatchPollMs = Number(patchStatusPollMs);
    this.patchStatusPollMs = Number.isFinite(configuredPatchPollMs) && configuredPatchPollMs > 0 ? configuredPatchPollMs : 5000;
    const configuredExternalStatusPollMs = Number(externalStatusPollMs);
    this.externalStatusPollMs = Number.isFinite(configuredExternalStatusPollMs) && configuredExternalStatusPollMs > 0 ? configuredExternalStatusPollMs : 10000;
    this.preparedPatchTargets = new Set();
    this.now = now;
    this.abortSignal = abortSignal;
  }

  #assertNotAborted() {
    if (!this.abortSignal?.aborted) return;
    throw new RunnerError(ERROR_CODES.TASK_TERMINATED, 'Task execution terminated by operator');
  }

  #isTerminated(error) {
    return this.abortSignal?.aborted === true || error?.code === ERROR_CODES.TASK_TERMINATED;
  }


  #patchSyncBootstrap(task, state) {
    return state.browser_execution_bootstrap?.patchsync ?? task.browser_execution_bootstrap?.patchsync ?? null;
  }

  #patchSyncClient(task, state) {
    const bootstrap = this.#patchSyncBootstrap(task, state);
    if (!bootstrap) return null;
    if (typeof this.patchSyncClientFactory !== 'function') {
      throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, 'PatchSync client factory is required for browser execution bootstrap');
    }
    return this.patchSyncClientFactory(bootstrap);
  }

  #recoveryPolicy(task, state) {
    return state.browser_execution_bootstrap?.recovery_policy ?? task.browser_execution_bootstrap?.recovery_policy ?? null;
  }

  #observationTimeoutMs(task, state) {
    return this.recoveryPolicyEngine.observationTimeoutMs(this.#recoveryPolicy(task, state));
  }


  #initializationRestartable(error) {
    return [
      ERROR_CODES.MODEL_DID_NOT_START,
      ERROR_CODES.MODEL_RESPONSE_TIMEOUT,
      ERROR_CODES.MODEL_RESPONSE_FAILED,
      ERROR_CODES.COMPOSER_STALLED,
      ERROR_CODES.COMPOSER_NOT_FOUND,
      ERROR_CODES.UI_SELECTOR_INCOMPATIBLE,
      ERROR_CODES.CHAT_NOT_FOUND,
      ERROR_CODES.PROJECT_NOT_FOUND,
      ERROR_CODES.INITIALIZATION_PROTOCOL_MISSING
    ].includes(error?.code);
  }

  #initializationDeadlineAt(observationTimeoutMs) {
    if (!Number.isFinite(observationTimeoutMs) || observationTimeoutMs <= 0) return null;
    return new Date(this.#nowDate().getTime() + observationTimeoutMs).toISOString();
  }

  async #loadPreparedResource(task, state) {
    let current = state;
    let resource = null;
    if (current.source_preparation?.status !== 'succeeded') return { state: current, resource };
    const patchSyncClient = this.#patchSyncClient(task, current);
    if (!current.source_preparation.rules?.text) {
      const rules = await patchSyncClient.downloadRules({ rules: current.source_preparation.rules });
      current = {
        ...current,
        source_preparation: {
          ...current.source_preparation,
          rules: { ...current.source_preparation.rules, text: rules.text }
        }
      };
      await this.taskStore.save(current);
    }
    resource = await patchSyncClient.downloadSource({ source: current.source_preparation.source });
    this.#assertNotAborted();
    return { state: current, resource };
  }

  async #restartInitializationWorkspace(task, state, { reason }) {
    const previousProject = state.task_project;
    const baseProjectName = state.initialization_base_project_name ?? previousProject?.project_name ?? state.chatgpt_project_name;
    const nextAttempt = Number(state.workspace_retry_count ?? state.initialization_attempt ?? 0) + 1;
    if (!baseProjectName || nextAttempt > this.maxWorkspaceRetries) {
      const exhausted = new RunnerError(
        ERROR_CODES.INITIALIZATION_RECOVERY_EXHAUSTED,
        `Task local workspace recovery exhausted after ${this.maxWorkspaceRetries} replacement workspaces`,
        { task_id: task.task_id, attempt: state.workspace_retry_count ?? state.initialization_attempt ?? 0 }
      );
      exhausted.durableExecutionState = state;
      throw exhausted;
    }

    let deleteStatus = 'not_found';
    let deleteError = null;
    let orphans = [...(state.initialization_orphans ?? [])];
    if (previousProject?.project_name) {
      try {
        await this.page.deleteTaskProject({ task, state, project: previousProject });
        deleteStatus = 'deleted';
      } catch (error) {
        deleteError = { code: error?.code ?? 'CLEANUP_FAILED', message: error?.message ?? String(error) };
        deleteStatus = error?.code === ERROR_CODES.PROJECT_NOT_FOUND ? 'not_found' : 'failed';
        if (deleteStatus === 'failed' && !orphans.some(item => item?.project_name === previousProject.project_name)) {
          orphans.push({ project_name: previousProject.project_name, error: deleteError });
        }
      }
    }

    let current = {
      ...state,
      initialization_attempt: nextAttempt,
      initialization_local_recovery_count: 0,
      workspace_retry_count: nextAttempt,
      workspace_max_retries: this.maxWorkspaceRetries,
      preserve_workspace_on_terminal_failure: false,
      initialization_base_project_name: baseProjectName,
      initialization_started_at: null,
      initialization_deadline_at: null,
      initialization_orphans: orphans
    };
    await this.taskStore.save(current);
    await this.taskApi.reportProgress(task.task_id, {
      type: 'TASK_INITIALIZATION_RESTARTING',
      reason,
      attempt: nextAttempt,
      workspace_retry_count: nextAttempt,
      workspace_max_retries: this.maxWorkspaceRetries,
      previous_project_name: previousProject?.project_name ?? null,
      delete_status: deleteStatus,
      delete_error: deleteError
    });

    const preferredProjectName = `${baseProjectName}-r${nextAttempt}`;
    const session = await this.page.createTaskProject({ task, state: current, preferredProjectName });
    current = recordCreatedWorkspace(current, {
      browserWorkspaceId: session.browserWorkspaceId,
      sessionId: session.patchSessionId ?? session.sessionId,
      projectName: session.projectName
    });
    current = {
      ...current,
      phase: 'RUNNING',
      initialization_attempt: nextAttempt,
      initialization_local_recovery_count: 0,
      workspace_retry_count: nextAttempt,
      workspace_max_retries: this.maxWorkspaceRetries,
      preserve_workspace_on_terminal_failure: false,
      initialization_base_project_name: baseProjectName
    };
    await this.taskStore.save(current);
    await this.taskApi.reportProgress(task.task_id, {
      type: 'TASK_PROJECT_STARTED',
      browser_workspace_id: current.browser_workspace_id,
      patch_session_id: current.patch_session_id ?? current.session_id,
      session_id: current.patch_session_id ?? current.session_id,
      project_name: current.chatgpt_project_name,
      initialization_attempt: nextAttempt,
      workspace_retry_count: nextAttempt,
      workspace_max_retries: this.maxWorkspaceRetries
    });
    return current;
  }

  async #recoverInitializationInPlace(task, state, { reason }) {
    const currentCount = Number(state.initialization_local_recovery_count ?? 0);
    const nextCount = currentCount + 1;
    const projectName = state.task_project?.project_name ?? state.chatgpt_project_name;
    if (!projectName || nextCount > 2) return null;

    let current = {
      ...state,
      initialization_local_recovery_count: nextCount,
      workspace_retry_count: Number(state.workspace_retry_count ?? state.initialization_attempt ?? 0),
      workspace_max_retries: this.maxWorkspaceRetries
    };
    await this.taskStore.save(current);
    await this.taskApi.reportProgress(task.task_id, {
      type: 'TASK_INITIALIZATION_LOCAL_RECOVERY',
      reason,
      local_recovery_attempt: nextCount,
      workspace_retry_count: current.workspace_retry_count,
      workspace_max_retries: this.maxWorkspaceRetries,
      project_name: projectName,
      action: nextCount === 1 ? 'RELOAD_PAGE' : 'REOPEN_WORKSPACE'
    });

    try {
      if (nextCount === 1) {
        if (typeof this.page.reloadPage !== 'function' || typeof this.page.prepareExistingTask !== 'function') return null;
        await this.page.reloadPage();
        const patchSessionId = current.patch_session_id ?? current.source_preparation?.patch_session_id ?? current.session_id;
        await this.page.prepareExistingTask({
          ...task,
          chatgpt_project_name: projectName,
          browser_workspace_id: current.task_project?.browser_workspace_id ?? current.browser_workspace_id ?? current.task_project?.session_id,
          patch_session_id: patchSessionId,
          session_id: patchSessionId
        });
        return current;
      }

      if (typeof this.page.reopenWorkspace !== 'function') return null;
      await this.page.reopenWorkspace({ state: current });
      return current;
    } catch (recoveryError) {
      await this.taskApi.reportProgress(task.task_id, {
        type: 'TASK_INITIALIZATION_LOCAL_RECOVERY_FAILED',
        reason,
        local_recovery_attempt: nextCount,
        workspace_retry_count: current.workspace_retry_count,
        workspace_max_retries: this.maxWorkspaceRetries,
        project_name: projectName,
        action: nextCount === 1 ? 'RELOAD_PAGE' : 'REOPEN_WORKSPACE',
        error: { code: recoveryError?.code ?? 'LOCAL_RECOVERY_FAILED', message: recoveryError?.message ?? String(recoveryError) }
      });
      return current;
    }
  }

  async #ensureProjectConfigured(task, state) {
    let current = state;
    // States persisted before this checkpoint was introduced could only have reached
    // task_project after Project Instructions had already succeeded. Preserve that
    // recovery contract instead of replaying settings on legacy executions.
    if (!Object.prototype.hasOwnProperty.call(current, 'project_setup_completed')) {
      return { ...current, project_setup_completed: true };
    }
    if (current.project_setup_completed === true) return current;
    if (typeof this.page.configureTaskProject !== 'function') {
      current = { ...current, project_setup_completed: true };
      await this.taskStore.save(current);
      return current;
    }

    while (current.project_setup_completed !== true) {
      try {
        await this.page.configureTaskProject({ task, state: current });
        current = {
          ...current,
          project_setup_completed: true,
          initialization_local_recovery_count: 0,
          preserve_workspace_on_terminal_failure: false
        };
        await this.taskStore.save(current);
        await this.taskApi.reportProgress(task.task_id, {
          type: 'TASK_PROJECT_CONFIGURED',
          project_name: current.task_project?.project_name ?? current.chatgpt_project_name,
          workspace_retry_count: Number(current.workspace_retry_count ?? current.initialization_attempt ?? 0),
          workspace_max_retries: this.maxWorkspaceRetries
        });
        return current;
      } catch (error) {
        if (this.#isTerminated(error) || isConfirmedLeaseLoss(error) || !this.#initializationRestartable(error)) {
          error.durableExecutionState ??= current;
          throw error;
        }
        const recoveredInPlace = await this.#recoverInitializationInPlace(task, current, { reason: error.code ?? 'PROJECT_SETUP_FAILED' });
        if (recoveredInPlace) {
          current = recoveredInPlace;
          continue;
        }
        if (Number(current.workspace_retry_count ?? current.initialization_attempt ?? 0) >= this.maxWorkspaceRetries) {
          const exhaustedState = {
            ...current,
            workspace_retry_count: Number(current.workspace_retry_count ?? current.initialization_attempt ?? 0),
            workspace_max_retries: this.maxWorkspaceRetries,
            preserve_workspace_on_terminal_failure: true
          };
          const exhausted = new RunnerError(
            ERROR_CODES.INITIALIZATION_RECOVERY_EXHAUSTED,
            `Task local workspace recovery exhausted after ${this.maxWorkspaceRetries} replacement workspaces`,
            {
              task_id: task.task_id,
              workspace_retry_count: exhaustedState.workspace_retry_count,
              workspace_max_retries: this.maxWorkspaceRetries,
              project_name: exhaustedState.task_project?.project_name ?? null,
              stage: 'PROJECT_SETUP',
              last_error: { code: error.code, message: error.message }
            }
          );
          exhausted.durableExecutionState = exhaustedState;
          throw exhausted;
        }
        current = await this.#restartInitializationWorkspace(task, current, { reason: error.code ?? 'PROJECT_SETUP_FAILED' });
      }
    }
    return current;
  }

  async #initializeTaskWorkspace(task, state, preparedResource) {
    let current = state;
    while (true) {
      current = await this.#ensureProjectConfigured(task, current);
      const observationTimeoutMs = this.#observationTimeoutMs(task, current);
      const startedAt = this.#isoNow();
      current = {
        ...current,
        initialization_attempt: Number(current.workspace_retry_count ?? current.initialization_attempt ?? 0),
        workspace_retry_count: Number(current.workspace_retry_count ?? current.initialization_attempt ?? 0),
        workspace_max_retries: this.maxWorkspaceRetries,
        initialization_local_recovery_count: Number(current.initialization_local_recovery_count ?? 0),
        initialization_base_project_name: current.initialization_base_project_name ?? current.task_project?.project_name ?? current.chatgpt_project_name,
        initialization_started_at: startedAt,
        initialization_deadline_at: this.#initializationDeadlineAt(observationTimeoutMs)
      };
      await this.taskStore.save(current);
      await this.taskApi.reportProgress(task.task_id, {
        type: 'TASK_INITIALIZING',
        resource_url: current.source_preparation?.source?.download_url ?? task.resource?.url ?? null,
        project_name: current.chatgpt_project_name,
        attempt: current.initialization_attempt,
        workspace_retry_count: current.workspace_retry_count,
        workspace_max_retries: this.maxWorkspaceRetries,
        local_recovery_attempt: current.initialization_local_recovery_count,
        deadline_at: current.initialization_deadline_at
      });
      await this.#observe('onResourceInitializationStarted');
      this.#assertLeaseActive();

      try {
        const initialized = await this.page.initializeTask({
          task,
          state: current,
          resource: preparedResource,
          observationTimeoutMs,
          hooks: {
            onResourceDownloaded: () => this.#observe('onResourceDownloaded'),
            onResourceAttached: () => this.#observe('onResourceAttached')
          }
        });
        this.#assertLeaseActive();
        if (initialized?.contextLimit) return { state: current, contextLimit: true };
        await this.#observe('onResourceInitializationResponseReady');
        current = markInitializationCompleted({ ...current, initialization_local_recovery_count: 0, preserve_workspace_on_terminal_failure: false });
        await this.taskStore.save(current);
        await this.taskApi.reportProgress(task.task_id, {
          type: 'TASK_INITIALIZED',
          project_name: current.chatgpt_project_name,
          attempt: current.initialization_attempt
        });
        await this.#observe('onResourceInitializationCompleted');
        return { state: current, contextLimit: false };
      } catch (error) {
        if (this.#isTerminated(error) || isConfirmedLeaseLoss(error) || !this.#initializationRestartable(error)) {
          error.durableExecutionState ??= current;
          throw error;
        }
        const recoveredInPlace = await this.#recoverInitializationInPlace(task, current, { reason: error.code ?? 'INITIALIZATION_FAILED' });
        if (recoveredInPlace) {
          current = recoveredInPlace;
          continue;
        }
        if (Number(current.workspace_retry_count ?? current.initialization_attempt ?? 0) >= this.maxWorkspaceRetries) {
          const exhaustedState = {
            ...current,
            workspace_retry_count: Number(current.workspace_retry_count ?? current.initialization_attempt ?? 0),
            workspace_max_retries: this.maxWorkspaceRetries,
            preserve_workspace_on_terminal_failure: true,
            initialization_local_recovery_count: Number(current.initialization_local_recovery_count ?? 0)
          };
          const exhausted = new RunnerError(
            ERROR_CODES.INITIALIZATION_RECOVERY_EXHAUSTED,
            `Task local workspace recovery exhausted after ${this.maxWorkspaceRetries} replacement workspaces`,
            {
              task_id: task.task_id,
              workspace_retry_count: exhaustedState.workspace_retry_count,
              workspace_max_retries: this.maxWorkspaceRetries,
              project_name: exhaustedState.task_project?.project_name ?? null,
              last_error: { code: error.code, message: error.message }
            }
          );
          exhausted.durableExecutionState = exhaustedState;
          throw exhausted;
        }
        current = await this.#restartInitializationWorkspace(task, current, { reason: error.code ?? 'INITIALIZATION_FAILED' });
      }
    }
  }

  #withCompletionPreview(state, preview) {
    const successfulPatches = Number(preview?.counts?.successful_patches);
    return {
      ...state,
      completion_preview: structuredClone(preview),
      server_successful_patch_count: Number.isInteger(successfulPatches) && successfulPatches >= 0
        ? Math.max(state.server_successful_patch_count ?? 0, successfulPatches)
        : state.server_successful_patch_count ?? 0
    };
  }

  #completionPayload(state) {
    return {
      task_patch_count: state.task_patch_count,
      task_round_count: state.task_round_count,
      patch_session_id: state.patch_session_id ?? state.source_preparation?.patch_session_id ?? state.session_id
    };
  }

  #patchPollSeconds(task, state) {
    const policySeconds = Number(this.#externalWaitRule(task, state)?.poll_interval_seconds);
    const clientSeconds = (state.patch_status_target ? this.patchStatusPollMs : this.externalStatusPollMs) / 1000;
    return Number.isFinite(policySeconds) && policySeconds > 0 ? Math.min(policySeconds, clientSeconds) : clientSeconds;
  }

  #transientStatusPollSeconds(errorCount) {
    const count = Math.max(1, Number(errorCount) || 1);
    if (count === 1) return 10;
    if (count === 2) return 20;
    if (count === 3) return 30;
    return 60;
  }

  #patchDeliverableKey(state, target) {
    if (!target || !Number.isInteger(Number(target.sequence))) return target?.filename ?? null;
    if (typeof target.deliverable_key === 'string' && target.deliverable_key.trim()) return target.deliverable_key.trim();

    const sessionId = String(target.session_id ?? target.sessionId ?? '');
    const sequence = Number(target.sequence);
    for (const key of state.downloaded_patch_keys ?? []) {
      const identity = extractPatchIdentity(key, sessionId);
      if (identity && Number(identity.sequence) === sequence) return identity.filename;
    }

    const previous = state.completion_preview?.latest_patch;
    if (String(previous?.session_id ?? '') === sessionId && Number(previous?.sequence) === sequence) {
      const previousKey = typeof previous?.deliverable_key === 'string' && previous.deliverable_key.trim()
        ? previous.deliverable_key.trim()
        : typeof previous?.patch_filename === 'string' && previous.patch_filename.trim() ? previous.patch_filename.trim() : null;
      if (previousKey) return previousKey;
    }
    return target.filename ?? null;
  }

  #recordPatchTarget(state, filename, patchSessionId) {
    const identity = extractPatchIdentity(filename, patchSessionId);
    if (!identity || !Number.isInteger(identity.sequence)) return state;
    return recordPatchStatusTarget(state, identity);
  }

  async #persistPatchTarget(state, filename, patchSessionId) {
    const next = this.#recordPatchTarget(state, filename, patchSessionId);
    if (next === state) return state;
    await this.taskStore.save(next);
    return next;
  }

  async #queryCompletionPreview(task, state) {
    try {
      return { preview: await this.taskApi.completionCheckTask(task.task_id, this.#completionPayload(state)), error: null };
    } catch (error) {
      if (isConfirmedLeaseLoss(error) || !transientStatusQueryError(error)) throw error;
      return { preview: null, error };
    }
  }

  async #ensureExactPatchControl(task, state) {
    const target = state.patch_status_target;
    if (!target || typeof this.taskApi.preparePatchArtifact !== 'function') return { ok: true };
    const key = `${target.session_id}:${target.sequence}:${target.filename}`;
    if (this.preparedPatchTargets.has(key)) return { ok: true };
    const deliverableKey = this.#patchDeliverableKey(state, target);
    try {
      await this.taskApi.preparePatchArtifact(task.task_id, {
        filename: target.filename,
        patch_key: target.filename,
        ...(deliverableKey && deliverableKey !== target.filename ? { deliverable_key: deliverableKey, deliverable_filename: deliverableKey } : {}),
        patch_session_id: target.session_id,
        sequence: target.sequence
      });
      this.preparedPatchTargets.add(key);
      return { ok: true };
    } catch (error) {
      if (isConfirmedLeaseLoss(error) || !transientStatusQueryError(error)) throw error;
      return { ok: false, error };
    }
  }

  async #probeExactPatchTerminal(task, state) {
    if (!state.patch_status_target) return null;
    const queried = await this.#queryCompletionPreview(task, state);
    if (queried.error) return null;
    const patch = queried.preview?.latest_patch;
    if (!exactPatchMatches(state.patch_status_target, patch)) return null;
    if (typeof patch.is_terminal !== 'boolean' || typeof patch.next_action !== 'string' || !patch.next_action.trim()) {
      return { preview: queried.preview, preempt: true };
    }
    if (patch.is_terminal && patch.next_action !== 'wait') {
      return { preview: queried.preview, preempt: patch.terminal_kind !== 'success' };
    }
    return null;
  }

  async #raceExactPatchStatus(task, state, localPromise) {
    await this.#ensureExactPatchControl(task, state);
    const settled = Promise.resolve(localPromise).then(
      value => ({ kind: 'local', value }),
      error => ({ kind: 'local_error', error })
    );
    let observedTerminalPreview = null;
    while (true) {
      const observed = await this.#probeExactPatchTerminal(task, state);
      if (observed?.preempt) return { kind: 'remote', preview: observed.preview };
      if (observed?.preview) observedTerminalPreview = observed.preview;
      const winner = await Promise.race([
        settled,
        delay(this.patchStatusPollMs).then(() => ({ kind: 'poll' }))
      ]);
      if (winner.kind !== 'poll') return { ...winner, preview: observedTerminalPreview };
      this.#assertNotAborted();
      this.#assertLeaseActive();
    }
  }


  async #waitForExactPatch(task, state, summary, { preserveStartedAt = true, reportServer = true } = {}) {
    return this.#enterWaitingExternal(task, state, { summary }, { preserveStartedAt, reportServer });
  }

  async #resolveExactPatchPreview(task, state, preview) {
    const target = state.patch_status_target;
    if (!target) return null;
    state = this.#withCompletionPreview(state, preview);
    const patch = preview?.latest_patch;
    if (!exactPatchMatches(target, patch)) {
      const summary = patch
        ? `Waiting for exact PatchSync package ${target.filename}; control plane returned a different Patch identity`
        : `Waiting for exact PatchSync package ${target.filename}; no remote record is available yet`;
      state = await this.#waitForExactPatch(task, state, summary, { preserveStartedAt: Boolean(state.external_wait) });
      return { terminal: { status: 'waiting_external', state } };
    }

    if (typeof patch.is_terminal !== 'boolean' || typeof patch.next_action !== 'string' || !patch.next_action.trim()) {
      state = await this.#enterWaitingHuman(task, state, {
        reason: 'PATCH_STATUS_DECISION_MISSING',
        summary: `Exact Patch ${target.filename} has remote status ${patch.status ?? 'unknown'} but no authoritative is_terminal/next_action decision`
      });
      return { terminal: { status: 'waiting_human', state } };
    }

    if (!patch.is_terminal || patch.next_action === 'wait') {
      state = await this.#waitForExactPatch(task, state, `Patch ${target.filename} is ${patch.status ?? 'pending'}; waiting for terminal server decision`, {
        preserveStartedAt: Boolean(state.external_wait)
      });
      return { terminal: { status: 'waiting_external', state } };
    }

    if (patch.terminal_kind === 'success' && preview?.directive === 'READY_TO_FINALIZE') {
      state = clearPatchStatusTarget(state);
      await this.taskStore.save(state);
      return { terminal: await this.#complete(task, state) };
    }

    if (patch.next_action === 'stop') {
      state = await this.#enterWaitingHuman(task, state, {
        reason: 'PATCH_STATUS_STOP',
        summary: patch.decision_reason ?? patch.suggestion ?? `Patch ${target.filename} requires inspection`
      });
      return { terminal: { status: 'waiting_human', state } };
    }

    if (patch.next_action === 'retry_same_sequence' || patch.next_action === 'next_sequence') {
      const prompt = patchDecisionPrompt(target, patch);
      state = {
        ...clearExternalWait(clearPatchStatusTarget(state)),
        phase: 'RUNNING',
        server_continuation_prompt: prompt,
        server_continuation_summary: patch.decision_reason ?? preview?.summary ?? null
      };
      await this.taskStore.save(state);
      await this.taskApi.reportProgress(task.task_id, {
        type: 'PATCH_REMOTE_DECISION',
        patch_filename: target.filename,
        patch_session_id: target.session_id,
        sequence: target.sequence,
        patch_status: patch.status ?? null,
        next_action: patch.next_action,
        suggested_sequence: patch.suggested_sequence ?? null
      });
      return { state };
    }

    state = clearPatchStatusTarget(state);
    await this.taskStore.save(state);
    const directive = preview?.directive;
    if (directive === 'CONTINUE') {
      state = { ...clearExternalWait(state), phase: 'RUNNING', server_continuation_summary: preview.summary ?? 'Acceptance criteria are not yet satisfied' };
      await this.taskStore.save(state);
      return { state };
    }
    if (directive === 'WAIT_EXTERNAL') {
      state = await this.#enterWaitingExternal(task, state, preview, { preserveStartedAt: false });
      return { terminal: { status: 'waiting_external', state } };
    }
    if (directive === 'WAIT_HUMAN') {
      state = await this.#enterWaitingHuman(task, state, { reason: 'WAIT_HUMAN', summary: preview?.summary ?? null });
      return { terminal: { status: 'waiting_human', state } };
    }
    if (directive === 'READY_TO_FINALIZE') return { terminal: await this.#complete(task, state) };
    throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, `Unsupported completion_check directive ${directive ?? 'missing'}`);
  }

  async #checkExactPatchBarrier(task, state) {
    await this.#ensureExactPatchControl(task, state);
    const queried = await this.#queryCompletionPreview(task, state);
    if (queried.error) {
      const summary = `Patch status query unavailable for ${state.patch_status_target?.filename ?? 'current Patch'}: ${queried.error.message}`;
      state = await this.#waitForExactPatch(task, state, summary, { preserveStartedAt: Boolean(state.external_wait), reportServer: false });
      return { terminal: { status: 'waiting_external', state } };
    }
    return this.#resolveExactPatchPreview(task, state, queried.preview);
  }

  async #reconcileTimedOutPatchDownload(task, state, candidate, patchSessionId, error) {
    if (error?.code !== ERROR_CODES.PATCH_DOWNLOAD_FAILED || !/timed out/i.test(String(error?.message ?? ''))) return null;
    if (typeof this.taskApi.preparePatchArtifact !== 'function') return null;
    const identity = extractPatchIdentity(error?.details?.filename ?? candidate?.filename, patchSessionId);
    if (!identity || !Number.isInteger(identity.sequence)) return null;

    const alreadyTargeted = state.patch_status_target?.filename === identity.filename
      && String(state.patch_status_target?.session_id ?? '') === String(patchSessionId)
      && Number(state.patch_status_target?.sequence) === Number(identity.sequence);
    let next = await this.#persistPatchTarget(state, identity.filename, patchSessionId);
    if (!alreadyTargeted) await this.#ensureExactPatchControl(task, next);
    const handledKeys = [...new Set([...(next.downloaded_patch_keys ?? []), identity.key, candidate?.control_key].filter(Boolean))];
    next = { ...next, downloaded_patch_keys: handledKeys };
    await this.taskStore.save(next);
    await this.taskApi.reportProgress(task.task_id, {
      type: 'PATCH_DOWNLOAD_RECONCILING',
      patch_session_id: patchSessionId,
      sequence: identity.sequence,
      filename: identity.filename
    });
    return next;
  }


  async #reconcilePatchTransferFailure(task, state, candidate, artifact, patchSessionId, error) {
    if (error?.code !== ERROR_CODES.REMOTE_ARTIFACT_READ_FAILED) return null;
    if (typeof this.taskApi.preparePatchArtifact !== 'function') return null;
    const identity = extractPatchIdentity(error?.details?.filename ?? artifact?.filename ?? candidate?.filename, patchSessionId);
    if (!identity || !Number.isInteger(identity.sequence)) return null;

    const alreadyTargeted = state.patch_status_target?.filename === identity.filename
      && String(state.patch_status_target?.session_id ?? '') === String(patchSessionId)
      && Number(state.patch_status_target?.sequence) === Number(identity.sequence);
    let next = await this.#persistPatchTarget(state, identity.filename, patchSessionId);
    if (!alreadyTargeted) await this.#ensureExactPatchControl(task, next);
    const handledKeys = [...new Set([...(next.downloaded_patch_keys ?? []), identity.key, candidate?.control_key].filter(Boolean))];
    next = { ...next, downloaded_patch_keys: handledKeys };
    await this.taskStore.save(next);
    await this.taskApi.reportProgress(task.task_id, {
      type: 'PATCH_TRANSFER_RECONCILING',
      patch_session_id: patchSessionId,
      sequence: identity.sequence,
      filename: identity.filename,
      error_code: error.code
    });
    return next;
  }


  #nowDate() {
    const value = this.now();
    return value instanceof Date ? value : new Date(value);
  }

  #isoNow() { return this.#nowDate().toISOString(); }

  #externalWaitRule(task, state) {
    return this.#recoveryPolicy(task, state)?.rules?.find(rule => rule?.signal === 'WAIT_EXTERNAL_STALLED') ?? null;
  }

  #leaseWakeAt(state) {
    const ttl = Number(state.lease?.ttl_ms);
    if (!Number.isFinite(ttl) || ttl <= 0) return null;
    return new Date(this.#nowDate().getTime() + Math.max(1000, Math.floor(ttl / 3))).toISOString();
  }

  #withNextRecovery(state, preferredAt = null) {
    const leaseAt = this.#leaseWakeAt(state);
    const candidates = [preferredAt, leaseAt].filter(Boolean).map(value => Date.parse(value)).filter(Number.isFinite);
    return { ...state, next_recovery_at: candidates.length ? new Date(Math.min(...candidates)).toISOString() : null };
  }

  #cleanupRetryAt() {
    return new Date(this.#nowDate().getTime() + 60_000).toISOString();
  }

  #leaseLossRetryAt() {
    return new Date(this.#nowDate().getTime() + 30_000).toISOString();
  }

  #assertLeaseActive() {
    this.heartbeat?.assertLeaseActive?.();
  }

  async #enterWaitingExternal(task, state, preview, { preserveStartedAt = true, reportServer = true, completionCheckedAt = null } = {}) {
    const rule = this.#externalWaitRule(task, state);
    let next = { ...state, phase: 'WAITING_EXTERNAL', server_continuation_summary: null };
    if (rule) {
      const policyPollSeconds = Number(rule.poll_interval_seconds);
      if (!Number.isFinite(policyPollSeconds) || policyPollSeconds <= 0) {
        throw new RunnerError(ERROR_CODES.RECOVERY_POLICY_INVALID, 'WAIT_EXTERNAL_STALLED.poll_interval_seconds must be positive');
      }
      const pollSeconds = this.#patchPollSeconds(task, next);
      const now = this.#isoNow();
      const nextCheckAt = new Date(Date.parse(now) + pollSeconds * 1000).toISOString();
      if (!preserveStartedAt || !next.external_wait) {
        next = beginExternalWait(next, { at: now, nextCheckAt, summary: preview?.summary ?? null });
      } else {
        next = recordExternalWaitCheck(next, { at: now, nextCheckAt, summary: preview?.summary ?? null });
      }
      if (completionCheckedAt) {
        next = recordExternalStatusQuery(next, {
          at: completionCheckedAt,
          kind: 'completion_check',
          result: completionStatusResult(preview)
        });
      }
      next = this.#withNextRecovery(next, nextCheckAt);
    } else {
      next = this.#withNextRecovery(next, null);
    }
    await this.taskStore.save(next);
    if (reportServer && typeof this.taskApi.waitingExternalTask === 'function') {
      await this.taskApi.waitingExternalTask(task.task_id, { reason: 'WAIT_EXTERNAL', summary: preview?.summary ?? null });
    }
    return next;
  }

  async #enterWaitingHuman(task, state, { reason = 'WAIT_HUMAN', summary = null } = {}) {
    let next = { ...state, phase: 'WAITING_HUMAN', server_continuation_summary: null };
    next = this.#withNextRecovery(next, null);
    await this.taskStore.save(next);
    if (typeof this.taskApi.waitingHumanTask === 'function') {
      await this.taskApi.waitingHumanTask(task.task_id, { reason, summary });
    }
    return next;
  }

  #sourceRetryAt(attempt) {
    return new Date(this.#nowDate().getTime() + sourceRetryDelayMs(attempt)).toISOString();
  }

  async #scheduleSourceRetry(task, state, error) {
    const durable = await this.taskStore.load();
    const base = durable?.task_id === task.task_id ? durable : state;
    const attempts = Number(base.source_retry?.attempts ?? 0) + 1;
    const nextRetryAt = this.#sourceRetryAt(attempts);
    const next = {
      ...base,
      phase: 'PREPARING_SOURCE',
      source_retry: {
        attempts,
        next_retry_at: nextRetryAt,
        last_error: { code: error?.code ?? ERROR_CODES.RESOURCE_DOWNLOAD_FAILED, message: error?.message ?? String(error) }
      },
      recovery_error: { code: error?.code ?? ERROR_CODES.RESOURCE_DOWNLOAD_FAILED, message: error?.message ?? String(error) },
      next_recovery_at: nextRetryAt
    };
    await this.taskStore.save(next);
    await this.taskApi.reportProgress(task.task_id, {
      type: 'SOURCE_PREPARE_RETRY_SCHEDULED',
      code: error?.code ?? ERROR_CODES.RESOURCE_DOWNLOAD_FAILED,
      message: error?.message ?? String(error),
      attempt: attempts,
      next_retry_at: nextRetryAt,
      export_id: next.source_preparation?.export_id ?? null
    });
    return { status: 'source_retry_pending', state: next, error };
  }

  async #handleSourcePreparationError(task, state, error) {
    if (error?.code === ERROR_CODES.RESOURCE_HOST_PERMISSION_REQUIRED) {
      const durable = await this.taskStore.load();
      const base = durable?.task_id === task.task_id ? durable : state;
      const originPattern = typeof error.details?.originPattern === 'string' ? error.details.originPattern : null;
      const next = this.#withNextRecovery({
        ...base,
        phase: 'PREPARING_SOURCE',
        recovery_error: { code: error.code, message: error.message }
      }, null);
      await this.taskStore.save(next);
      await this.taskApi.reportProgress(task.task_id, {
        type: 'SOURCE_PREPARE_WAITING_HUMAN',
        code: error.code,
        message: error.message,
        origin_pattern: originPattern
      });
      if (typeof this.taskApi.waitingHumanTask === 'function') {
        await this.taskApi.waitingHumanTask(task.task_id, {
          reason: error.code,
          summary: 'Grant BrowserPlugin host access for the PatchSync origin, then recover the same execution.',
          origin_pattern: originPattern
        });
      }
      return { status: 'waiting_human', state: next, error };
    }

    if (isRetryableSourceError(error)) return this.#scheduleSourceRetry(task, state, error);

    await this.taskApi.reportProgress(task.task_id, { type: 'SOURCE_PREPARE_ERROR', code: error.code ?? 'UNEXPECTED', message: error.message });
    await this.taskApi.releaseTask(task.task_id, { code: error.code ?? 'SOURCE_PREPARE_ERROR', message: error.message });
    await this.taskStore.clear();
    return { status: 'released', state, error };
  }

  async #prepareSource(task, state) {
    this.#assertNotAborted();
    const bootstrap = this.#patchSyncBootstrap(task, state);
    if (!bootstrap) return state;

    let prepared = beginSourcePreparation(state);
    await this.taskStore.save(prepared);
    await this.taskApi.reportProgress(task.task_id, {
      type: 'SOURCE_PREPARING',
      export_id: prepared.source_preparation?.export_id ?? null
    });

    const client = this.#patchSyncClient(task, prepared);
    let exportId = prepared.source_preparation?.export_id ?? null;
    if (!exportId) {
      const created = await client.createExport(task.project_id);
      this.#assertNotAborted();
      exportId = created.export_id;
      prepared = recordPatchSyncExport(prepared, { exportId });
      await this.taskStore.save(prepared);
      await this.taskApi.reportProgress(task.task_id, { type: 'SOURCE_EXPORT_CREATED', export_id: exportId });
    }

    const manifest = await client.waitForExport(exportId);
    this.#assertNotAborted();
    if (manifest.project_id && manifest.project_id !== task.project_id) {
      throw new RunnerError(ERROR_CODES.RESOURCE_DOWNLOAD_FAILED, 'PatchSync export project does not match the Task project', {
        task_project_id: task.project_id,
        export_project_id: manifest.project_id,
        export_id: exportId
      });
    }
    prepared = recordPreparedSource(prepared, {
      exportId,
      patchSessionId: manifest.patch_session_id,
      source: manifest.source,
      rules: manifest.rules
    });
    prepared = { ...prepared, source_retry: null, recovery_error: null, next_recovery_at: null };
    await this.taskStore.save(prepared);
    await this.taskApi.reportProgress(task.task_id, {
      type: 'SOURCE_PREPARED',
      export_id: exportId,
      patch_session_id: prepared.source_preparation.patch_session_id,
      source_filename: prepared.source_preparation.source.filename
    });
    return prepared;
  }


  async #observe(method, payload) {
    const fn = this.observer?.[method];
    if (typeof fn !== 'function') return;
    try {
      await fn.call(this.observer, payload);
    } catch {
      // Evidence/telemetry observers are non-authoritative and must never affect Task execution.
    }
  }

  async #cleanupProject(task, state, terminalReason, { reportProgress = true } = {}) {
    const project = state.task_project;
    if (project && project.status !== 'deleted') {
      try {
        await this.page.deleteTaskProject({ task, state, project });
        state = { ...markWorkspaceDeleted(state), cleanup_error: null, next_recovery_at: null };
        await this.taskStore.save(state);
        if (reportProgress) await this.taskApi.reportProgress(task.task_id, {
          type: 'TASK_PROJECT_DELETED',
          project_name: project.project_name,
          browser_workspace_id: project.browser_workspace_id ?? state.browser_workspace_id ?? project.session_id,
          patch_session_id: state.patch_session_id ?? state.source_preparation?.patch_session_id ?? state.session_id,
          session_id: state.patch_session_id ?? state.source_preparation?.patch_session_id ?? state.session_id
        });
      } catch (error) {
        state = {
          ...state,
          phase: 'CLEANUP',
          cleanup_error: { code: error.code ?? 'CLEANUP_FAILED', message: error.message },
          next_recovery_at: this.#cleanupRetryAt()
        };
        await this.taskStore.save(state);
        if (reportProgress) await this.taskApi.reportProgress(task.task_id, {
          type: 'TASK_CLEANUP_PENDING',
          terminal_reason: terminalReason,
          error: state.cleanup_error
        });
        return { ok: false, state, error };
      }
    }
    if (Array.isArray(state.initialization_orphans) && state.initialization_orphans.length > 0) {
      const remaining = [];
      for (const orphan of state.initialization_orphans) {
        if (!orphan?.project_name) continue;
        try {
          await this.page.deleteTaskProject({ task, state, project: { project_name: orphan.project_name, status: 'active' } });
        } catch (error) {
          remaining.push({
            project_name: orphan.project_name,
            error: { code: error?.code ?? 'CLEANUP_FAILED', message: error?.message ?? String(error) }
          });
        }
      }
      state = { ...state, initialization_orphans: remaining };
      await this.taskStore.save(state);
    }
    return { ok: true, state };
  }

  async #finalizeAndCleanup(task, state, terminalReason, terminalAction) {
    state = {
      ...state,
      phase: 'FINALIZING',
      terminal_reason: terminalReason,
      terminal_action: terminalAction,
      cleanup_error: null
    };
    await this.taskStore.save(state);
    await this.taskApi.reportProgress(task.task_id, {
      type: 'TASK_FINALIZING',
      terminal_reason: terminalReason,
      task_patch_count: state.task_patch_count,
      task_round_count: state.task_round_count,
      project_name: state.task_project?.project_name ?? null
    });

    state = { ...state, phase: 'CLEANUP' };
    await this.taskStore.save(state);
    const cleaned = await this.#cleanupProject(task, state, terminalReason);
    if (cleaned.ok) await this.#observe('onCleanupCompleted');
    return cleaned;
  }

  async #sendTerminal(task, state, { action, payload, successStatus, successPhase, clearStore = true }) {
    state = {
      ...state,
      phase: 'TERMINAL_PENDING',
      terminal_action: action,
      terminal_payload: structuredClone(payload),
      terminal_error: null
    };
    await this.taskStore.save(state);
    try {
      if (action === 'COMPLETE') await this.taskApi.completeTask(task.task_id, payload);
      else if (action === 'CONTEXT_LIMIT') await this.taskApi.contextLimitTask(task.task_id, payload);
      else if (action === 'FAIL') await this.taskApi.failTask(task.task_id, payload);
      else if (action === 'RELEASE') await this.taskApi.releaseTask(task.task_id, payload);
      else throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, `Unknown terminal action ${action}`);
    } catch (error) {
      state = {
        ...state,
        terminal_error: { code: error.code ?? 'TERMINAL_API_FAILED', message: error.message }
      };
      await this.taskStore.save(state);
      return { status: 'terminal_pending', state, error };
    }
    await this.#observe('onTerminalSucceeded', { action, status: successStatus });
    const finalState = { ...state, phase: successPhase, terminal_error: null, terminal_reported: true };
    if (clearStore) await this.taskStore.clear();
    else await this.taskStore.save(finalState);
    return { status: successStatus, state: finalState };
  }

  async #complete(task, state) {
    const payload = taskResult(task, state, { terminal_status: 'success' });
    state = {
      ...state,
      phase: 'FINALIZING',
      terminal_reason: 'SUCCESS',
      terminal_action: 'COMPLETE',
      terminal_payload: structuredClone(payload),
      terminal_error: null,
      cleanup_error: null
    };
    await this.taskStore.save(state);
    await this.taskApi.reportProgress(task.task_id, {
      type: 'TASK_FINALIZING',
      terminal_reason: 'SUCCESS',
      task_patch_count: state.task_patch_count,
      task_round_count: state.task_round_count,
      project_name: state.task_project?.project_name ?? null
    });

    let completion;
    try {
      completion = await this.taskApi.completeTask(task.task_id, payload);
    } catch (error) {
      state = { ...state, phase: 'TERMINAL_PENDING', terminal_error: { code: error.code ?? 'TERMINAL_API_FAILED', message: error.message } };
      await this.taskStore.save(state);
      return { status: 'terminal_pending', state, error };
    }

    if (completion?.task?.status && completion.task.status !== 'completed') {
      const acceptanceStatus = completion?.acceptance_evaluation?.status ?? completion.task.status;
      const phase = acceptanceStatus === 'waiting_human' ? 'WAITING_HUMAN' : 'WAITING_EXTERNAL';
      state = { ...state, phase, completion_preview: structuredClone(completion?.acceptance_evaluation ?? null), terminal_error: null };
      await this.taskStore.save(state);
      return { status: phase === 'WAITING_HUMAN' ? 'waiting_human' : 'waiting_external', state };
    }

    state = { ...state, phase: 'CLEANUP', terminal_error: null, business_completed: true };
    await this.taskStore.save(state);
    const cleaned = await this.#cleanupProject(task, state, 'SUCCESS', { reportProgress: false });
    if (!cleaned.ok) return { status: 'cleanup_pending', state: cleaned.state, error: cleaned.error };
    await this.#observe('onCleanupCompleted');
    await this.#observe('onTerminalSucceeded', { action: 'COMPLETE', status: 'completed' });
    const finalState = { ...cleaned.state, phase: 'COMPLETED', terminal_error: null };
    await this.taskStore.clear();
    return { status: 'completed', state: finalState };
  }

  async #checkCompletion(task, state) {
    if (typeof this.taskApi.completionCheckTask !== 'function') {
      throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, 'Task API completion_check support is required when the model reports DONE');
    }
    if (state.patch_status_target) return this.#checkExactPatchBarrier(task, state);
    const preview = await this.taskApi.completionCheckTask(task.task_id, this.#completionPayload(state));
    const directive = preview?.directive;
    if (!['CONTINUE', 'WAIT_EXTERNAL', 'WAIT_HUMAN', 'READY_TO_FINALIZE'].includes(directive)) {
      throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, `Unsupported completion_check directive ${directive ?? 'missing'}`);
    }
    state = this.#withCompletionPreview(state, preview);
    if (directive === 'CONTINUE') {
      state = { ...clearExternalWait(state), phase: 'RUNNING', server_continuation_summary: preview.summary ?? 'Acceptance criteria are not yet satisfied' };
      await this.taskStore.save(state);
      return { state };
    }
    if (directive === 'WAIT_EXTERNAL') {
      state = await this.#enterWaitingExternal(task, state, preview, { preserveStartedAt: false, completionCheckedAt: this.#isoNow() });
      return { terminal: { status: 'waiting_external', state } };
    }
    if (directive === 'WAIT_HUMAN') {
      state = await this.#enterWaitingHuman(task, state, { reason: 'WAIT_HUMAN', summary: preview?.summary ?? null });
      return { terminal: { status: 'waiting_human', state } };
    }
    return { terminal: await this.#complete(task, state) };
  }



  async #contextLimit(task, state, { message }) {
    const code = ERROR_CODES.CHAT_LENGTH_LIMIT;
    const finalized = await this.#finalizeAndCleanup(task, state, code, 'CONTEXT_LIMIT');
    if (!finalized.ok) return { status: 'cleanup_pending', state: finalized.state, error: finalized.error };
    const payload = taskResult(task, finalized.state, { terminal_status: 'context_limit', code, message });
    const result = await this.#sendTerminal(task, finalized.state, {
      action: 'CONTEXT_LIMIT',
      payload,
      successStatus: 'context_limit',
      successPhase: 'CONTEXT_LIMIT'
    });
    if (result.status === 'terminal_pending') return result;
    return { ...result, error: new RunnerError(code, message, payload) };
  }

  async #failTerminal(task, state, { status, code, message }) {
    state = {
      ...state,
      phase: 'FINALIZING',
      terminal_reason: code,
      terminal_action: 'FAIL',
      terminal_error: null,
      cleanup_error: null
    };
    const payload = taskResult(task, state, {
      terminal_status: status,
      code,
      message,
      ...(state.preserve_workspace_on_terminal_failure === true ? {
        workspace_retry_count: Number(state.workspace_retry_count ?? state.initialization_attempt ?? 0),
        workspace_max_retries: Number(state.workspace_max_retries ?? this.maxWorkspaceRetries)
      } : {})
    });
    state = { ...state, terminal_payload: structuredClone(payload) };
    await this.taskStore.save(state);
    await this.taskApi.reportProgress(task.task_id, {
      type: 'TASK_FINALIZING',
      terminal_reason: code,
      task_patch_count: state.task_patch_count,
      task_round_count: state.task_round_count,
      project_name: state.task_project?.project_name ?? null
    });

    const preserveWorkspace = state.preserve_workspace_on_terminal_failure === true;
    if (preserveWorkspace) {
      await this.taskApi.reportProgress(task.task_id, {
        type: 'TASK_FAILED_WORKSPACE_PRESERVED',
        terminal_reason: code,
        project_name: state.task_project?.project_name ?? null,
        workspace_retry_count: Number(state.workspace_retry_count ?? 0),
        workspace_max_retries: Number(state.workspace_max_retries ?? this.maxWorkspaceRetries)
      });
      const terminal = await this.#sendTerminal(task, state, {
        action: 'FAIL',
        payload,
        successStatus: status,
        successPhase: 'FAILED',
        clearStore: true
      });
      if (terminal.status === 'terminal_pending') return terminal;
      return { status, state: terminal.state, error: new RunnerError(code, message, payload) };
    }

    const terminal = await this.#sendTerminal(task, state, {
      action: 'FAIL',
      payload,
      successStatus: status,
      successPhase: 'FAILED',
      clearStore: false
    });

    if (terminal.status === 'terminal_pending') {
      const cleanupState = { ...terminal.state, phase: 'CLEANUP' };
      await this.taskStore.save(cleanupState);
      const cleaned = await this.#cleanupProject(task, cleanupState, code);
      if (!cleaned.ok) return { status: 'cleanup_pending', state: cleaned.state, error: cleaned.error };
      const pending = { ...cleaned.state, phase: 'TERMINAL_PENDING' };
      await this.taskStore.save(pending);
      return { ...terminal, state: pending };
    }

    let cleanupState = { ...terminal.state, phase: 'CLEANUP', terminal_reported: true };
    await this.taskStore.save(cleanupState);
    const cleaned = await this.#cleanupProject(task, cleanupState, code, { reportProgress: false });
    if (!cleaned.ok) return { status: 'cleanup_pending', state: cleaned.state, error: cleaned.error };
    await this.#observe('onCleanupCompleted');
    const finalState = { ...cleaned.state, phase: 'FAILED', terminal_reported: true };
    await this.taskStore.clear();
    return { status, state: finalState, error: new RunnerError(code, message, payload) };
  }

  async #release(task, state, { code, message }) {
    const finalized = await this.#finalizeAndCleanup(task, state, code, 'RELEASE');
    if (!finalized.ok) return { status: 'cleanup_pending', state: finalized.state, error: finalized.error };
    const payload = taskResult(task, finalized.state, { code, message });
    const result = await this.#sendTerminal(task, finalized.state, {
      action: 'RELEASE',
      payload,
      successStatus: 'released',
      successPhase: 'RELEASED'
    });
    if (result.status === 'terminal_pending') return result;
    return { ...result, error: new RunnerError(code, message, payload) };
  }

  async #blockRecovery(state, error) {
    state = {
      ...state,
      recovery_error: {
        code: error.code ?? ERROR_CODES.TASK_RECOVERY_BLOCKED,
        message: error.message
      }
    };
    await this.taskStore.save(state);
    return { status: 'recovery_blocked', state, error };
  }

  async #runCheckpointedRound(task, state, prompt, { recover = false } = {}) {
    this.#assertNotAborted();
    let durableState = state;
    if (!recover) {
      durableState = checkpointRoundIntent(durableState, prompt);
      await this.taskStore.save(durableState);
    }

    const hooks = {
      onPromptSent: async () => {
        durableState = markRoundPromptSent(durableState);
        await this.taskStore.save(durableState);
      },
      onMeaningfulProgress: async () => {
        durableState = markMeaningfulProgress(durableState, new Date().toISOString());
        await this.taskStore.save(durableState);
      },
      onResponseReady: async assistantText => {
        durableState = markRoundResponseReady(durableState, assistantText);
        if (typeof this.page?.currentConversationUrl === 'function') {
          try {
            const conversationUrl = await this.page.currentConversationUrl();
            if (conversationUrl) durableState = { ...durableState, chatgpt_conversation_url: conversationUrl };
          } catch {
            // Conversation location is recovery metadata only; it must not fail a completed model response.
          }
        }
        await this.taskStore.save(durableState);
      }
    };

    const operation = async ({ state: operationState, observationTimeoutMs, recover: policyRecover }) => {
      durableState = operationState;
      try {
        this.#assertLeaseActive();
        const round = (recover || policyRecover)
          ? await this.page.recoverRound({ task, state: durableState, checkpoint: durableState.in_flight_round, hooks, observationTimeoutMs })
          : await this.page.runRound({ task, state: durableState, prompt, hooks, observationTimeoutMs });
        this.#assertLeaseActive();
        return { state: durableState, result: round };
      } catch (error) {
        error.durableExecutionState = durableState;
        throw error;
      }
    };

    try {
      const executed = await this.recoveryPolicyEngine.execute({
        task,
        state: durableState,
        policy: this.#recoveryPolicy(task, durableState),
        operation
      });
      durableState = executed.state;
      return { state: durableState, round: executed.result };
    } catch (error) {
      error.durableExecutionState = error.durableExecutionState ?? durableState;
      throw error;
    }
  }

  async #processPatchCandidates(task, state, patchCandidates) {
    let earlyPatchPreview = null;
    let deferredPatchError = null;

    for (const candidate of patchCandidates) {
      this.#assertNotAborted();
      const patchSessionId = state.patch_session_id ?? state.source_preparation?.patch_session_id ?? state.session_id;
      const patchSyncBacked = Boolean(this.#patchSyncBootstrap(task, state));
      const candidateIdentity = patchSyncBacked ? extractPatchIdentity(candidate?.filename, patchSessionId) : null;

      if (candidateIdentity?.filename) {
        state = await this.#persistPatchTarget(state, candidateIdentity.filename, patchSessionId);
      }

      let downloadedArtifact;
      if (patchSyncBacked && state.patch_status_target) {
        const localPatch = this.processPatch(candidate, {
          taskId: task.task_id,
          sessionId: patchSessionId,
          patchSessionId,
          state
        });
        const raced = await this.#raceExactPatchStatus(task, state, localPatch);
        if (raced.kind === 'remote') {
          earlyPatchPreview = raced.preview;
          break;
        }
        if (raced.kind === 'local_error') {
          const reconciled = await this.#reconcileTimedOutPatchDownload(task, state, candidate, patchSessionId, raced.error);
          if (reconciled) {
            state = reconciled;
          } else {
            deferredPatchError = raced.error;
          }
          break;
        }
        downloadedArtifact = raced.value;
        if (raced.preview) earlyPatchPreview = raced.preview;
      } else {
        try {
          downloadedArtifact = await this.processPatch(candidate, { taskId: task.task_id, sessionId: patchSessionId, patchSessionId, state });
          this.#assertNotAborted();
        } catch (error) {
          const reconciled = await this.#reconcileTimedOutPatchDownload(task, state, candidate, patchSessionId, error);
          if (!reconciled) throw error;
          state = reconciled;
          continue;
        }
      }

      const patchSyncClient = patchSyncBacked ? this.#patchSyncClient(task, state) : null;
      if (patchSyncBacked) {
        state = await this.#persistPatchTarget(state, downloadedArtifact?.filename ?? candidate?.filename, patchSessionId);
      }
      let transfer;
      try {
        transfer = this.artifactTransfer
          ? await this.artifactTransfer.transfer(downloadedArtifact, {
            patchSyncClient,
            projectId: task.project_id,
            patchSessionId
          })
          : { mode: null, artifact: downloadedArtifact, receipt: null };
      } catch (error) {
        const reconciled = await this.#reconcilePatchTransferFailure(task, state, candidate, downloadedArtifact, patchSessionId, error);
        if (!reconciled) {
          if (patchSyncBacked && state.patch_status_target) {
            deferredPatchError = error;
            break;
          }
          throw error;
        }
        state = reconciled;
        continue;
      }
      if (transfer.mode === 'remote') await this.#observe('onRemoteTransfer');
      let artifact = transfer.mode
        ? { ...transfer.artifact, transfer_mode: transfer.mode, transfer_receipt: transfer.receipt ?? transfer.remote ?? null }
        : transfer.artifact;
      if (patchSyncBacked && state.patch_status_target) {
        const deliverableKey = this.#patchDeliverableKey(state, state.patch_status_target);
        const physicalKey = artifact?.patch_key ?? artifact?.filename;
        if (deliverableKey && deliverableKey !== physicalKey) artifact = { ...artifact, deliverable_key: deliverableKey, deliverable_filename: deliverableKey };
      }
      const key = artifact.patch_key ?? artifact.filename;
      const nextState = recordCompletedPatch(state, key, artifact.control_key ? [artifact.control_key] : []);
      if (nextState !== state) {
        state = nextState;
        await this.taskStore.save(state);
        try {
          await this.taskApi.reportArtifact(task.task_id, artifact);
        } catch (error) {
          if (patchSyncBacked && state.patch_status_target) {
            deferredPatchError = error;
            break;
          }
          throw error;
        }
        if (transfer.mode === 'remote') await this.#observe('onArtifactReported');
      }
      if (patchSyncBacked && !state.patch_status_target) {
        state = await this.#persistPatchTarget(state, artifact.filename ?? candidate?.filename, patchSessionId);
      }
    }

    return { state, earlyPatchPreview, deferredPatchError };
  }

  async #resolvePatchProcessingBarrier(task, state, patchCandidates, { earlyPatchPreview = null, deferredPatchError = null } = {}) {
    if (earlyPatchPreview && state.patch_status_target) {
      const resolved = await this.#resolveExactPatchPreview(task, state, earlyPatchPreview);
      if (resolved?.terminal) return { terminal: resolved.terminal };
      if (resolved?.state) {
        state = resolved.state;
        if (state.server_continuation_prompt) return { state };
      }
    }

    if (deferredPatchError && this.#patchSyncBootstrap(task, state) && state.patch_status_target) {
      await this.taskApi.reportProgress(task.task_id, {
        type: 'PATCH_LOCAL_PATH_DEGRADED',
        code: deferredPatchError.code ?? 'PATCH_LOCAL_PATH_FAILED',
        message: deferredPatchError.message,
        patch_filename: state.patch_status_target.filename,
        patch_session_id: state.patch_status_target.session_id,
        sequence: state.patch_status_target.sequence
      });
      const barrier = await this.#checkExactPatchBarrier(task, state);
      if (barrier?.terminal) return { terminal: barrier.terminal };
      if (barrier?.state) {
        state = barrier.state;
        if (state.server_continuation_prompt) return { state };
      }
    }

    if (this.#patchSyncBootstrap(task, state) && patchCandidates.length > 0 && state.patch_status_target) {
      const barrier = await this.#checkExactPatchBarrier(task, state);
      if (barrier?.terminal) return { terminal: barrier.terminal };
      if (barrier?.state) {
        state = barrier.state;
        if (state.server_continuation_prompt) return { state };
      }
    }

    return { state };
  }

  async #processRound(task, state, round) {
    this.#assertNotAborted();
    if (round?.contextLimit) {
      await this.taskApi.reportProgress(task.task_id, {
        type: 'TASK_CONTEXT_LIMIT',
        task_patch_count: state.task_patch_count,
        task_round_count: state.task_round_count,
        patch_goal: task.patch_goal
      });
      return {
        terminal: await this.#contextLimit(task, state, {
          message: 'ChatGPT reached the current chat/context length limit before the Task completed'
        })
      };
    }

    const patchCandidates = round?.patches ?? [];
    let { state: patchState, earlyPatchPreview, deferredPatchError } = await this.#processPatchCandidates(task, state, patchCandidates);
    state = patchState;

    let status = parseTaskStatus(round?.assistantText ?? '');
    const interaction = status ? null : classifyAssistantInteraction(round?.assistantText ?? '');
    if (interaction === 'AUTONOMY_CONTINUE') status = 'CONTINUE';
    const fallbackCount = status ? 0 : state.fallback_count + 1;
    state = completeRound(state, { status, fallbackCount });
    if (interaction === 'AUTONOMY_CONTINUE') {
      state = {
        ...state,
        server_continuation_prompt: AUTONOMY_CONTINUATION_PROMPT,
        server_continuation_summary: 'Model requested routine confirmation or a technical choice; continue autonomously.'
      };
    }
    await this.taskStore.save(state);
    await this.taskApi.reportProgress(task.task_id, {
      type: 'ROUND_COMPLETED',
      task_round_count: state.task_round_count,
      task_patch_count: state.task_patch_count,
      task_status: status
    });
    if (interaction === 'AUTONOMY_CONTINUE') {
      await this.taskApi.reportProgress(task.task_id, { type: 'MODEL_AUTONOMY_CONTINUE' });
    }

    const patchBarrier = await this.#resolvePatchProcessingBarrier(task, state, patchCandidates, { earlyPatchPreview, deferredPatchError });
    if (patchBarrier?.terminal) return { terminal: patchBarrier.terminal };
    if (patchBarrier?.state) {
      state = patchBarrier.state;
      if (state.server_continuation_prompt) return { state };
    }

    const action = decideTaskAction({
      status,
      taskPatchCount: state.task_patch_count,
      patchGoal: task.patch_goal,
      fallbackCount: state.fallback_count,
      fallbackLimit: this.fallbackLimit
    });
    if (action === 'CHECK_COMPLETION') return this.#checkCompletion(task, state);
    if (action === 'BLOCK' || action === 'PROTOCOL_ERROR') {
      const code = action === 'BLOCK' ? 'TASK_BLOCKED' : ERROR_CODES.TASK_PROTOCOL_MISSING;
      return { terminal: await this.#release(task, state, { code, message: `Task stopped with ${action}` }) };
    }
    return { state };
  }

  async #resumeCommittedAction(task, state) {
    if (state.server_continuation_prompt) return null;
    if (state.task_round_count === 0) return null;
    const action = decideTaskAction({
      status: state.last_task_status,
      taskPatchCount: state.task_patch_count,
      patchGoal: task.patch_goal,
      fallbackCount: state.fallback_count,
      fallbackLimit: this.fallbackLimit
    });
    if (action === 'CHECK_COMPLETION') {
      const checked = await this.#checkCompletion(task, state);
      return checked.terminal ?? null;
    }
    if (action === 'BLOCK' || action === 'PROTOCOL_ERROR') {
      const code = action === 'BLOCK' ? 'TASK_BLOCKED' : ERROR_CODES.TASK_PROTOCOL_MISSING;
      return this.#release(task, state, { code, message: `Recovered Task stopped with ${action}` });
    }
    return null;
  }

  async #runTaskLoop(task, state, { recoverCheckpoint = false } = {}) {
    if (!recoverCheckpoint) {
      const terminal = await this.#resumeCommittedAction(task, state);
      if (terminal) return terminal;
    }

    let recover = recoverCheckpoint;
    while (state.task_round_count < this.maxTaskRounds) {
      this.#assertNotAborted();
      const prompt = recover
        ? state.in_flight_round?.prompt
        : state.task_round_count === 0 ? task.task_prompt : continuationPrompt(task, state);
      if (!prompt) {
        throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, 'A durable Prompt is required to continue the Task round');
      }
      const executed = await this.#runCheckpointedRound(task, state, prompt, { recover });
      state = executed.state;
      recover = false;
      const processed = await this.#processRound(task, state, executed.round);
      if (processed.terminal) return processed.terminal;
      state = processed.state;
    }

    return this.#release(task, state, {
      code: ERROR_CODES.TASK_PROTOCOL_MISSING,
      message: `Task exceeded maxTaskRounds=${this.maxTaskRounds}`
    });
  }

  async #finishRecoveredCleanup(task, state) {
    const action = state.terminal_action
      ?? (state.terminal_reason === 'SUCCESS' ? 'COMPLETE' : state.terminal_reason === ERROR_CODES.CHAT_LENGTH_LIMIT ? 'CONTEXT_LIMIT' : null);

    if (!action) {
      return this.#blockRecovery(state, new RunnerError(
        ERROR_CODES.TASK_RECOVERY_BLOCKED,
        `Cannot recover terminal action for ${state.terminal_reason ?? 'unknown reason'}`
      ));
    }

    if (state.terminal_reported === true) {
      const status = action === 'COMPLETE' ? 'completed'
        : action === 'CONTEXT_LIMIT' ? 'context_limit'
          : action === 'FAIL' ? (state.terminal_payload?.terminal_status === 'context_limit' ? 'context_limit' : 'failed')
            : 'released';
      const phase = action === 'COMPLETE' ? 'COMPLETED'
        : action === 'CONTEXT_LIMIT' ? 'CONTEXT_LIMIT'
          : action === 'FAIL' ? 'FAILED' : 'RELEASED';
      const finalState = { ...state, phase };
      await this.taskStore.clear();
      if (action === 'FAIL' || action === 'CONTEXT_LIMIT' || action === 'RELEASE') {
        const code = state.terminal_payload?.code ?? state.terminal_reason ?? 'RECOVERED_TERMINAL';
        const message = state.terminal_payload?.message ?? 'Recovered terminal cleanup completed';
        return { status, state: finalState, error: new RunnerError(code, message, state.terminal_payload) };
      }
      return { status, state: finalState };
    }

    let payload = state.terminal_payload;
    if (!payload) {
      if (action === 'COMPLETE') {
        payload = taskResult(task, state, { terminal_status: 'success' });
      } else if (action === 'CONTEXT_LIMIT') {
        payload = taskResult(task, state, {
          terminal_status: 'context_limit',
          code: ERROR_CODES.CHAT_LENGTH_LIMIT,
          message: 'Recovered Task cleanup completed after a previous Context Limit'
        });
      } else if (action === 'FAIL') {
        const code = state.terminal_reason ?? 'RECOVERED_FAILURE';
        payload = taskResult(task, state, {
          terminal_status: code === ERROR_CODES.CHAT_LENGTH_LIMIT ? 'context_limit' : 'failed',
          code,
          message: 'Recovered Task cleanup completed after a previous terminal failure'
        });
      } else {
        const code = state.terminal_reason ?? 'RECOVERED_RELEASE';
        payload = taskResult(task, state, { code, message: 'Recovered Task cleanup completed before release' });
      }
    }

    const result = await this.#sendTerminal(task, state, {
      action,
      payload,
      successStatus: action === 'COMPLETE' ? 'completed'
        : action === 'CONTEXT_LIMIT' ? 'context_limit'
          : action === 'FAIL' ? (payload.terminal_status === 'context_limit' ? 'context_limit' : 'failed')
            : 'released',
      successPhase: action === 'COMPLETE' ? 'COMPLETED'
        : action === 'CONTEXT_LIMIT' ? 'CONTEXT_LIMIT'
          : action === 'FAIL' ? 'FAILED' : 'RELEASED'
    });
    if (result.status === 'terminal_pending') return result;
    if (action === 'CONTEXT_LIMIT' || action === 'FAIL') return { ...result, error: new RunnerError(payload.code, payload.message, payload) };
    if (action === 'RELEASE') return { ...result, error: new RunnerError(payload.code, payload.message, payload) };
    return result;
  }


  async #runPreparedTask(task, state) {
    this.#assertNotAborted();
    let activeState = state;
    let session;
    let preparedResource = null;
    if (activeState.source_preparation?.status === 'succeeded') {
      try {
        const loaded = await this.#loadPreparedResource(task, activeState);
        activeState = loaded.state;
        preparedResource = loaded.resource;
      } catch (error) {
        if (this.#isTerminated(error)) throw error;
        if (isRetryableSourceError(error)) return this.#scheduleSourceRetry(task, activeState, error);
        await this.taskApi.reportProgress(task.task_id, { type: 'SOURCE_BOOTSTRAP_ERROR', code: error.code ?? 'UNEXPECTED', message: error.message });
        await this.taskApi.releaseTask(task.task_id, { code: error.code ?? 'SOURCE_BOOTSTRAP_ERROR', message: error.message });
        await this.taskStore.clear();
        return { status: 'released', error, state: activeState };
      }
    }
    try {
      this.#assertLeaseActive();
      session = await this.page.createTaskProject({ task, state: activeState });
      this.#assertLeaseActive();
    } catch (error) {
      if (this.#isTerminated(error)) throw error;
      await this.taskApi.reportProgress(task.task_id, { type: 'PROJECT_CREATE_ERROR', code: error.code ?? 'UNEXPECTED', message: error.message });
      await this.taskApi.releaseTask(task.task_id, { code: error.code ?? 'PROJECT_CREATE_ERROR', message: error.message });
      await this.taskStore.clear();
      return { status: 'released', error, state: activeState };
    }

    activeState = recordCreatedWorkspace(activeState, {
      browserWorkspaceId: session.browserWorkspaceId,
      sessionId: session.patchSessionId ?? session.sessionId,
      projectName: session.projectName
    });
    activeState = { ...activeState, phase: 'RUNNING' };
    await this.taskStore.save(activeState);
    await this.taskApi.reportProgress(task.task_id, {
      type: 'TASK_PROJECT_STARTED',
      browser_workspace_id: activeState.browser_workspace_id,
      patch_session_id: activeState.patch_session_id ?? activeState.session_id,
      session_id: activeState.patch_session_id ?? activeState.session_id,
      project_name: activeState.chatgpt_project_name
    });

    try {
      activeState = await this.#ensureProjectConfigured(task, activeState);
      if (task.resource || activeState.source_preparation?.status === 'succeeded') {
        const initialized = await this.#initializeTaskWorkspace(task, activeState, preparedResource);
        activeState = initialized.state;
        if (initialized.contextLimit) {
          await this.taskApi.reportProgress(task.task_id, {
            type: 'TASK_CONTEXT_LIMIT',
            stage: 'initialization',
            task_patch_count: activeState.task_patch_count,
            task_round_count: activeState.task_round_count,
            patch_goal: task.patch_goal
          });
          return await this.#contextLimit(task, activeState, {
            message: 'ChatGPT reached the current chat/context length limit during Task initialization'
          });
        }
      }

      return await this.#runTaskLoop(task, activeState);
    } catch (error) {
      if (this.#isTerminated(error)) throw error;
      if (isConfirmedLeaseLoss(error)) return this.#handleLeaseLoss(task, error.durableExecutionState ?? activeState, error);
      if (activeState.task_project?.status === 'active') {
        return await this.#failTerminal(task, error.durableExecutionState ?? activeState, {
          status: 'failed',
          code: error.code ?? 'UNEXPECTED',
          message: error.message
        });
      }
      throw error;
    }
  }


  async #reconcileLeaseLoss(task, state, error = null) {
    const checkedAt = this.#isoNow();
    if (typeof this.taskApi.getCurrentTask !== 'function') {
      const pending = {
        ...state,
        phase: 'LEASE_LOST',
        next_recovery_at: this.#leaseLossRetryAt(),
        lease_loss: {
          ...(state.lease_loss ?? {}),
          control_state: 'pending',
          control_checked_at: checkedAt,
          control_error: 'current_assignment_query_unavailable'
        }
      };
      await this.taskStore.save(pending);
      return { status: 'lease_lost', state: pending, error };
    }

    let current;
    try {
      current = await this.taskApi.getCurrentTask();
    } catch (controlError) {
      const pending = {
        ...state,
        phase: 'LEASE_LOST',
        next_recovery_at: this.#leaseLossRetryAt(),
        lease_loss: {
          ...(state.lease_loss ?? {}),
          control_state: 'pending',
          control_checked_at: checkedAt,
          control_error: controlError?.code ?? controlError?.message ?? 'control_query_failed'
        }
      };
      await this.taskStore.save(pending);
      return { status: 'lease_lost', state: pending, error: error ?? controlError };
    }

    const stillAssigned = Boolean(current?.assignment && current?.task?.task_id === task.task_id);
    const reconciled = {
      ...state,
      phase: 'LEASE_LOST',
      next_recovery_at: stillAssigned ? this.#leaseLossRetryAt() : null,
      lease_loss: {
        ...(state.lease_loss ?? {}),
        control_state: stillAssigned ? 'still_assigned' : 'detached',
        control_checked_at: checkedAt,
        control_error: null,
        current_task_id: current?.task?.task_id ?? null,
        current_assignment_id: current?.assignment?.assignment_id ?? null
      }
    };
    await this.taskStore.save(reconciled);
    return { status: 'lease_lost', state: reconciled, error };
  }

  async #handleLeaseLoss(task, state, error) {
    const lost = markLeaseLost(state, {
      at: this.#isoNow(),
      code: error?.code ?? 'ASSIGNMENT_LEASE_LOST',
      message: error?.message ?? 'Assignment lease was lost'
    });
    await this.taskStore.save(lost);
    return this.#reconcileLeaseLoss(task, lost, error);
  }

  async #recoverCompletedCleanup(task, state) {
    const cleaned = await this.#cleanupProject(task, state, state.terminal_reason ?? 'SUCCESS', { reportProgress: false });
    if (!cleaned.ok) return { status: 'cleanup_pending', state: cleaned.state, error: cleaned.error };
    await this.#observe('onCleanupCompleted');
    await this.taskStore.clear();
    return { status: state.terminal_reason === 'LEASE_LOST' ? 'lease_lost' : 'completed', state: { ...cleaned.state, phase: state.terminal_reason === 'LEASE_LOST' ? 'LEASE_LOST' : 'COMPLETED' } };
  }

  async #recoverIncompleteInitialization(task, state) {
    let current = state;
    this.heartbeat?.start(task.task_id);
    try {
      const loaded = await this.#loadPreparedResource(task, current);
      current = loaded.state;
      current = await this.#restartInitializationWorkspace(task, current, { reason: 'EXECUTION_RECOVERY' });
      const initialized = await this.#initializeTaskWorkspace(task, current, loaded.resource);
      current = initialized.state;
      if (initialized.contextLimit) {
        await this.taskApi.reportProgress(task.task_id, {
          type: 'TASK_CONTEXT_LIMIT',
          stage: 'initialization',
          task_patch_count: current.task_patch_count,
          task_round_count: current.task_round_count,
          patch_goal: task.patch_goal
        });
        return this.#contextLimit(task, current, {
          message: 'ChatGPT reached the current chat/context length limit during Task initialization'
        });
      }
      return this.#runTaskLoop(task, { ...clearExternalWait(current), phase: 'RUNNING' });
    } catch (error) {
      if (this.#isTerminated(error)) throw error;
      if (isConfirmedLeaseLoss(error)) return this.#handleLeaseLoss(task, error.durableExecutionState ?? current, error);
      return this.#failTerminal(task, error.durableExecutionState ?? current, {
        status: 'failed',
        code: error.code ?? 'UNEXPECTED',
        message: error.message
      });
    } finally {
      this.heartbeat?.stop();
    }
  }

  async #recoverRunningWorkspace(task, state) {
    const project = state.task_project;
    const patchSessionId = state.patch_session_id ?? state.source_preparation?.patch_session_id ?? state.session_id;
    if (!project || project.status !== 'active' || !project.project_name || !patchSessionId) {
      return this.#blockRecovery(state, new RunnerError(
        ERROR_CODES.TASK_RECOVERY_BLOCKED,
        'RUNNING recovery requires the exact active task_project identity and PatchSync session'
      ));
    }
    if (!Object.prototype.hasOwnProperty.call(state, 'in_flight_round') || !Object.prototype.hasOwnProperty.call(state, 'initialization_completed')) {
      return this.#blockRecovery(state, new RunnerError(
        ERROR_CODES.TASK_RECOVERY_BLOCKED,
        'RUNNING state predates durable round checkpoints and cannot be safely auto-resumed'
      ));
    }
    if (!state.initialization_completed) {
      return this.#recoverIncompleteInitialization(task, state);
    }
    if (state.in_flight_round && state.in_flight_round.round_number !== state.task_round_count + 1) {
      return this.#blockRecovery(state, new RunnerError(
        ERROR_CODES.TASK_RECOVERY_BLOCKED,
        'In-flight round checkpoint does not match the next Task round number'
      ));
    }
    try {
      this.#assertLeaseActive();
      await this.page.prepareExistingTask({
        ...task,
        chatgpt_project_name: project.project_name,
        browser_workspace_id: project.browser_workspace_id ?? state.browser_workspace_id ?? project.session_id,
        patch_session_id: patchSessionId,
        session_id: patchSessionId
      });
      this.#assertLeaseActive();
      this.heartbeat?.start(task.task_id);
      await this.taskApi.reportProgress(task.task_id, {
        type: 'TASK_RECOVERED_RUNNING',
        project_name: project.project_name,
        browser_workspace_id: project.browser_workspace_id ?? state.browser_workspace_id ?? project.session_id,
        patch_session_id: patchSessionId,
        session_id: patchSessionId,
        task_round_count: state.task_round_count,
        task_patch_count: state.task_patch_count,
        in_flight_stage: state.in_flight_round?.stage ?? null
      });
      try {
        return await this.#runTaskLoop(task, { ...clearExternalWait(state), phase: 'RUNNING' }, { recoverCheckpoint: Boolean(state.in_flight_round) });
      } finally {
        this.heartbeat?.stop();
      }
    } catch (error) {
      if (this.#isTerminated(error)) throw error;
      if (isConfirmedLeaseLoss(error)) return this.#handleLeaseLoss(task, error.durableExecutionState ?? state, error);
      if (error?.code === ERROR_CODES.TASK_RECOVERY_BLOCKED) return this.#blockRecovery(error.durableExecutionState ?? state, error);
      throw error;
    }
  }

  async #recoverExactPatchWait(task, state) {
    const now = this.#nowDate();
    await this.#ensureExactPatchControl(task, state);
    const queried = await this.#queryCompletionPreview(task, state);
    if (queried.error) {
      const errorCount = (state.external_wait?.consecutive_query_errors ?? 0) + 1;
      const nextCheckAt = new Date(now.getTime() + this.#transientStatusPollSeconds(errorCount) * 1000).toISOString();
      let current = state.external_wait
        ? recordExternalWaitCheck(state, {
          at: now.toISOString(),
          nextCheckAt,
          summary: `Patch status query unavailable for ${state.patch_status_target?.filename ?? 'current Patch'}: ${queried.error.message}`
        })
        : beginExternalWait(state, {
          at: now.toISOString(),
          nextCheckAt,
          summary: `Patch status query unavailable for ${state.patch_status_target?.filename ?? 'current Patch'}: ${queried.error.message}`
        });
      current = recordExternalStatusQuery(current, {
        at: now.toISOString(),
        kind: 'completion_check',
        result: 'completion:error'
      });
      current = this.#withNextRecovery(current, nextCheckAt);
      await this.taskStore.save(current);
      return { status: 'waiting_external', state: current };
    }

    state = recordExternalStatusQuery(state, {
      at: now.toISOString(),
      kind: 'completion_check',
      result: completionStatusResult(queried.preview)
    });
    const resolved = await this.#resolveExactPatchPreview(task, state, queried.preview);
    if (resolved?.terminal) return resolved.terminal;
    if (resolved?.state) {
      const current = resolved.state;
      await this.taskApi.reportProgress(task.task_id, {
        type: 'EXTERNAL_WAIT_RESOLVED',
        summary: current.server_continuation_prompt ?? current.server_continuation_summary ?? queried.preview?.summary ?? null
      });
      return this.#recoverRunningWorkspace(task, current);
    }
    return { status: 'waiting_external', state };
  }

  async #recoverLatePagePatch(task, state, { force = false } = {}) {
    if (state.patch_status_target || (!force && state.last_task_status !== 'DONE')) return { state, found: false };
    if (!state.task_project?.project_name || state.task_project.status !== 'active') return { state, found: false };
    if (typeof this.page?.prepareExistingTask !== 'function' || typeof this.page?.discoverPatches !== 'function') return { state, found: false };

    const patchSessionId = state.patch_session_id ?? state.source_preparation?.patch_session_id ?? state.session_id;
    if (!patchSessionId) return { state, found: false };

    try {
      this.heartbeat?.start(task.task_id);
      let patchCandidates = [];
      if (typeof this.page.discoverCurrentPatches === 'function') {
        try {
          patchCandidates = await this.page.discoverCurrentPatches({ state, settle: true });
        } catch {
          patchCandidates = [];
        }
      }
      if (!Array.isArray(patchCandidates) || patchCandidates.length === 0) {
        await this.page.prepareExistingTask({
          ...task,
          chatgpt_project_name: state.task_project.project_name,
          chatgpt_conversation_url: state.chatgpt_conversation_url ?? null,
          browser_workspace_id: state.task_project.browser_workspace_id ?? state.browser_workspace_id ?? state.task_project.session_id,
          patch_session_id: patchSessionId,
          session_id: patchSessionId
        });
        this.#assertNotAborted();
        patchCandidates = await this.page.discoverPatches({ state, settle: true });
      }
      state = recordExternalStatusQuery(state, {
        at: this.#isoNow(),
        kind: 'patch_reconcile',
        result: Array.isArray(patchCandidates) && patchCandidates.length > 0 ? 'reconcile:page_patch_found' : 'reconcile:page_no_patch'
      });
      await this.taskStore.save(state);
      if (!Array.isArray(patchCandidates) || patchCandidates.length === 0) return { state, found: false };

      await this.taskApi.reportProgress(task.task_id, {
        type: 'PATCH_LATE_DISCOVERED',
        patch_session_id: patchSessionId,
        discovered_count: patchCandidates.length
      });
      const processed = await this.#processPatchCandidates(task, state, patchCandidates);
      const barrier = await this.#resolvePatchProcessingBarrier(task, processed.state, patchCandidates, processed);
      if (barrier?.terminal) return { state: barrier.terminal.state ?? processed.state, found: true, terminal: barrier.terminal };
      return { state: barrier?.state ?? processed.state, found: true };
    } catch (error) {
      if (this.#isTerminated(error) || isConfirmedLeaseLoss(error)) throw error;
      if (state.external_wait) {
        state = recordExternalStatusQuery(state, { at: this.#isoNow(), kind: 'patch_reconcile', result: 'reconcile:page_error' });
        await this.taskStore.save(state);
      }
      await this.taskApi.reportProgress(task.task_id, {
        type: 'PATCH_LATE_DISCOVERY_UNAVAILABLE',
        code: error?.code ?? 'PATCH_LATE_DISCOVERY_UNAVAILABLE',
        message: error?.message ?? String(error)
      });
      return { state, found: false, error };
    } finally {
      this.heartbeat?.stop();
    }
  }

  async #reconcileLostPatchTarget(task, state) {
    const patchSessionId = state.patch_session_id ?? state.source_preparation?.patch_session_id ?? state.session_id;
    if (state.patch_status_target || !patchSessionId || typeof this.taskApi.reconcilePatchSession !== 'function') return null;
    try {
      const result = await this.taskApi.reconcilePatchSession(task.task_id, patchSessionId);
      const patches = Array.isArray(result?.reconciliation?.discovered_patches) ? result.reconciliation.discovered_patches : [];
      state = recordExternalStatusQuery(state, {
        at: this.#isoNow(),
        kind: 'patch_reconcile',
        result: patches.length > 0 ? 'reconcile:patch_found' : 'reconcile:no_patch'
      });
      const latest = result?.acceptance?.latest_patch ?? patches.at(-1) ?? null;
      if (!latest || String(latest.session_id ?? '') !== String(patchSessionId) || !Number.isInteger(Number(latest.sequence)) || typeof latest.patch_filename !== 'string' || !latest.patch_filename.trim()) {
        return { state, preview: result?.acceptance ?? null, reconciled: false };
      }
      let current = recordPatchStatusTarget({
        ...state,
        task_patch_count: Math.max(Number(state.task_patch_count ?? 0), patches.length),
        server_successful_patch_count: Math.max(Number(state.server_successful_patch_count ?? 0), Number(result?.acceptance?.counts?.successful_patches ?? 0))
      }, {
        filename: latest.patch_filename,
        sessionId: latest.session_id,
        sequence: Number(latest.sequence)
      });
      await this.taskStore.save(current);
      await this.taskApi.reportProgress(task.task_id, {
        type: 'PATCH_SESSION_RECONCILED',
        patch_session_id: patchSessionId,
        discovered_patch_count: patches.length,
        created_links: Number(result?.reconciliation?.created_links ?? 0),
        bridged_patches: Number(result?.reconciliation?.bridged_patches ?? 0),
        sequence: Number(latest.sequence),
        filename: latest.patch_filename
      });
      return { state: current, preview: result?.acceptance ?? null, reconciled: true };
    } catch (error) {
      state = recordExternalStatusQuery(state, {
        at: this.#isoNow(),
        kind: 'patch_reconcile',
        result: 'reconcile:error'
      });
      if (transientStatusQueryError(error)) return { state, error, transient: true };
      const current = await this.#enterWaitingHuman(task, state, {
        reason: 'PATCH_SESSION_RECONCILE_CONFLICT',
        summary: error?.message ?? String(error)
      });
      return { terminal: { status: 'waiting_human', state: current } };
    }
  }

  async #recoverWaitingExternal(task, state) {
    const rule = this.#externalWaitRule(task, state);
    if (!rule || !state.external_wait) {
      const next = this.#withNextRecovery(state, state.external_wait?.next_check_at ?? null);
      await this.taskStore.save(next);
      return { status: 'waiting_external', state: next };
    }
    const now = this.#nowDate();
    const dueAt = Date.parse(state.external_wait.next_check_at);
    if (Number.isFinite(dueAt) && now.getTime() < dueAt) {
      const next = this.#withNextRecovery(state, state.external_wait.next_check_at);
      await this.taskStore.save(next);
      return { status: 'waiting_external', state: next };
    }

    if (state.patch_status_target) return this.#recoverExactPatchWait(task, state);

    const persistedFinalizeReady = state.external_wait?.last_result === 'completion:READY_TO_FINALIZE'
      || state.completion_preview?.directive === 'READY_TO_FINALIZE';
    const latePatch = await this.#recoverLatePagePatch(task, state, { force: persistedFinalizeReady });
    if (latePatch?.terminal) return latePatch.terminal;
    if (latePatch?.state) state = latePatch.state;
    if (state.patch_status_target) return this.#recoverExactPatchWait(task, state);

    const reconciled = await this.#reconcileLostPatchTarget(task, state);
    if (reconciled?.terminal) return reconciled.terminal;
    if (reconciled?.transient) {
      state = reconciled.state ?? state;
      const nextCheckAt = new Date(now.getTime() + this.#transientStatusPollSeconds(state.external_wait?.consecutive_query_errors) * 1000).toISOString();
      let current = recordExternalWaitCheck(state, {
        at: now.toISOString(),
        nextCheckAt,
        summary: `Patch Session reconciliation unavailable: ${reconciled.error.message}`
      });
      current = this.#withNextRecovery(current, nextCheckAt);
      await this.taskStore.save(current);
      return { status: 'waiting_external', state: current };
    }
    if (reconciled?.reconciled) {
      const resolved = await this.#resolveExactPatchPreview(task, reconciled.state, reconciled.preview);
      if (resolved?.terminal) return resolved.terminal;
      if (resolved?.state) {
        await this.taskApi.reportProgress(task.task_id, {
          type: 'EXTERNAL_WAIT_RESOLVED',
          summary: resolved.state.server_continuation_prompt ?? resolved.state.server_continuation_summary ?? reconciled.preview?.summary ?? null
        });
        return this.#recoverRunningWorkspace(task, resolved.state);
      }
      state = reconciled.state;
    } else if (reconciled?.state) {
      state = reconciled.state;
    }

    const stallSeconds = Number(rule.stall_timeout_seconds);
    const policyPollSeconds = Number(rule.poll_interval_seconds);
    if (!Number.isFinite(stallSeconds) || stallSeconds <= 0 || !Number.isFinite(policyPollSeconds) || policyPollSeconds <= 0) {
      return this.#blockRecovery(state, new RunnerError(ERROR_CODES.RECOVERY_POLICY_INVALID, 'WAIT_EXTERNAL_STALLED policy requires positive poll/stall timing'));
    }
    const elapsedMs = now.getTime() - Date.parse(state.external_wait.started_at);
    const stalled = Number.isFinite(elapsedMs) && elapsedMs >= stallSeconds * 1000;
    const hasResync = rule.actions?.some(action => action?.type === 'RESYNC_EXTERNAL_STATE');
    const hasEscalate = rule.actions?.some(action => action?.type === 'ESCALATE');
    let current = state;

    if (stalled && hasEscalate && (current.external_wait.resync_count ?? 0) > 0) {
      current = recordExternalEscalation(current, now.toISOString());
      current = this.#withNextRecovery(current, null);
      await this.taskStore.save(current);
      if (typeof this.taskApi.waitingHumanTask === 'function') {
        await this.taskApi.waitingHumanTask(task.task_id, { reason: 'WAIT_EXTERNAL_STALLED', summary: current.external_wait.summary });
      }
      return { status: 'waiting_human', state: current };
    }

    if (stalled && hasResync && (current.external_wait.resync_count ?? 0) === 0) {
      current = recordExternalResync(current, now.toISOString());
      await this.taskStore.save(current);
      if (typeof this.taskApi.waitingExternalTask === 'function') {
        await this.taskApi.waitingExternalTask(task.task_id, { reason: 'RESYNC_EXTERNAL_STATE', summary: current.external_wait.summary });
      }
    }

    let preview;
    try {
      preview = await this.taskApi.completionCheckTask(task.task_id, {
        task_patch_count: current.task_patch_count,
        task_round_count: current.task_round_count,
        patch_session_id: current.patch_session_id ?? current.source_preparation?.patch_session_id ?? current.session_id
      });
    } catch (error) {
      if (!transientStatusQueryError(error)) throw error;
      current = recordExternalStatusQuery(current, {
        at: now.toISOString(),
        kind: 'completion_check',
        result: 'completion:error'
      });
      const nextCheckAt = new Date(now.getTime() + this.#transientStatusPollSeconds(current.external_wait?.consecutive_query_errors) * 1000).toISOString();
      current = recordExternalWaitCheck(current, {
        at: now.toISOString(),
        nextCheckAt,
        summary: `Completion status query unavailable: ${error.message}`
      });
      current = this.#withNextRecovery(current, nextCheckAt);
      await this.taskStore.save(current);
      return { status: 'waiting_external', state: current };
    }
    const directive = preview?.directive;
    current = recordExternalStatusQuery(current, {
      at: now.toISOString(),
      kind: 'completion_check',
      result: completionStatusResult(preview)
    });
    current = this.#withCompletionPreview(current, preview);
    if (directive === 'CONTINUE') {
      current = { ...clearExternalWait(current), phase: 'RUNNING', server_continuation_summary: preview.summary ?? 'External wait resolved; continue the Task' };
      await this.taskStore.save(current);
      await this.taskApi.reportProgress(task.task_id, { type: 'EXTERNAL_WAIT_RESOLVED', summary: preview.summary ?? null });
      return this.#recoverRunningWorkspace(task, current);
    }
    if (directive === 'READY_TO_FINALIZE') {
      const finalPatchReconcile = await this.#recoverLatePagePatch(task, current, { force: true });
      if (finalPatchReconcile?.terminal) return finalPatchReconcile.terminal;
      if (finalPatchReconcile?.state) current = finalPatchReconcile.state;
      if (current.patch_status_target) return this.#recoverExactPatchWait(task, current);
      return this.#complete(task, current);
    }
    if (directive === 'WAIT_HUMAN') {
      current = await this.#enterWaitingHuman(task, current, { reason: 'WAIT_HUMAN', summary: preview?.summary ?? null });
      return { status: 'waiting_human', state: current };
    }
    if (directive !== 'WAIT_EXTERNAL') {
      return this.#blockRecovery(current, new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, `Unsupported completion_check directive ${directive ?? 'missing'}`));
    }
    const nextCheckAt = new Date(now.getTime() + this.#patchPollSeconds(task, current) * 1000).toISOString();
    current = recordExternalWaitCheck(current, { at: now.toISOString(), nextCheckAt, summary: preview?.summary ?? null });
    current = this.#withNextRecovery(current, nextCheckAt);
    await this.taskStore.save(current);
    return { status: 'waiting_external', state: current };
  }

  async #recoverWaitingHuman(task, state) {
    const preview = typeof this.taskApi.completionCheckTask === 'function'
      ? await this.taskApi.completionCheckTask(task.task_id, {
        task_patch_count: state.task_patch_count,
        task_round_count: state.task_round_count,
        patch_session_id: state.patch_session_id ?? state.source_preparation?.patch_session_id ?? state.session_id
      })
      : { directive: 'WAIT_HUMAN' };
    state = this.#withCompletionPreview(state, preview);
    if (preview?.directive === 'CONTINUE') {
      const next = { ...clearExternalWait(state), phase: 'RUNNING', server_continuation_summary: preview.summary ?? 'Human wait resolved; continue the Task' };
      await this.taskStore.save(next);
      await this.taskApi.reportProgress(task.task_id, { type: 'HUMAN_WAIT_RESOLVED', summary: preview.summary ?? null });
      return this.#recoverRunningWorkspace(task, next);
    }
    if (preview?.directive === 'READY_TO_FINALIZE') return this.#complete(task, state);
    if (preview?.directive === 'WAIT_EXTERNAL') {
      const next = await this.#enterWaitingExternal(task, state, preview, { preserveStartedAt: false });
      return { status: 'waiting_external', state: next };
    }
    const next = this.#withNextRecovery({ ...state, phase: 'WAITING_HUMAN', completion_preview: structuredClone(preview) }, null);
    await this.taskStore.save(next);
    return { status: 'waiting_human', state: next };
  }

  async recoverOnce() {
    this.#assertNotAborted();
    let state = await this.taskStore.load();
    if (!state) return { status: 'no_recovery', state: null };

    let task;
    try {
      if (!state.task_snapshot || state.task_snapshot.task_id !== state.task_id) {
        throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, 'Durable Task snapshot is missing or does not match activeExecution.task_id');
      }
      task = normalizeTask(state.task_snapshot);
    } catch (error) {
      return this.#blockRecovery(state, error);
    }

    if (state.phase === 'CLEANUP' && state.terminal_reason === 'LEASE_LOST') {
      state = markLeaseLost(state, {
        at: state.lease_loss?.at ?? this.#isoNow(),
        code: state.lease_loss?.code ?? 'ASSIGNMENT_LEASE_LOST',
        message: state.lease_loss?.message ?? 'Assignment lease was lost'
      });
      await this.taskStore.save(state);
      return this.#reconcileLeaseLoss(task, state);
    }

    if (state.phase === 'LEASE_LOST') {
      return this.#reconcileLeaseLoss(task, state);
    }

    if (state.phase === 'CLEANUP' && state.business_completed === true) {
      return this.#recoverCompletedCleanup(task, state);
    }

    if (state.phase === 'CLEANUP' && state.terminal_reported === true) {
      const cleaned = await this.#cleanupProject(task, state, state.terminal_reason, { reportProgress: false });
      if (!cleaned.ok) return { status: 'cleanup_pending', state: cleaned.state, error: cleaned.error };
      await this.#observe('onCleanupCompleted');
      return this.#finishRecoveredCleanup(task, cleaned.state);
    }

    try {
      if (!state.lease || typeof this.taskApi.restoreLease !== 'function') {
        throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, 'Durable lease is required before recovery');
      }
      this.taskApi.restoreLease(task.task_id, state.lease);
      await this.taskApi.heartbeatTask(task.task_id);
      this.#assertNotAborted();
      const refreshedLease = this.taskApi.getLease?.(task.task_id) ?? state.lease;
      state = { ...state, lease: refreshedLease, lease_token: refreshedLease?.token ?? state.lease_token ?? null, recovery_error: null };
      await this.taskStore.save(state);
    } catch (error) {
      if (this.#isTerminated(error)) throw error;
      if (isConfirmedLeaseLoss(error)) return this.#handleLeaseLoss(task, state, error);
      return this.#blockRecovery(state, error);
    }

    if (state.phase === 'PREPARING_SOURCE') {
      this.heartbeat?.start(task.task_id);
      try {
        try {
          state = await this.#prepareSource(task, state);
        } catch (error) {
          if (isConfirmedLeaseLoss(error)) return this.#handleLeaseLoss(task, state, error);
          return this.#handleSourcePreparationError(task, state, error);
        }
        return await this.#runPreparedTask(task, state);
      } finally {
        this.heartbeat?.stop();
      }
    }

    if (state.phase === 'RUNNING' || state.phase === 'RECOVERING') {
      return this.#recoverRunningWorkspace(task, state);
    }

    if (state.phase === 'WAITING_EXTERNAL') {
      return this.#recoverWaitingExternal(task, state);
    }

    if (state.phase === 'WAITING_HUMAN') {
      return this.#recoverWaitingHuman(task, state);
    }

    if (state.phase === 'CLEANUP' || state.phase === 'CLEANUP_PENDING') {
      const cleaned = await this.#cleanupProject(task, state, state.terminal_reason);
      if (!cleaned.ok) return { status: 'cleanup_pending', state: cleaned.state, error: cleaned.error };
      return this.#finishRecoveredCleanup(task, cleaned.state);
    }

    if (state.phase === 'TERMINAL_PENDING' && state.preserve_workspace_on_terminal_failure === true) {
      const payload = state.terminal_payload ?? taskResult(task, state, {
        terminal_status: 'failed',
        code: state.terminal_reason ?? ERROR_CODES.INITIALIZATION_RECOVERY_EXHAUSTED,
        message: 'Local workspace recovery was exhausted'
      });
      return this.#sendTerminal(task, state, {
        action: state.terminal_action ?? 'FAIL',
        payload,
        successStatus: payload.terminal_status ?? 'failed',
        successPhase: 'FAILED',
        clearStore: true
      });
    }

    if (state.phase === 'TERMINAL_PENDING') {
      if (state.task_project?.status !== 'deleted') {
        return this.#blockRecovery(state, new RunnerError(
          ERROR_CODES.TASK_RECOVERY_BLOCKED,
          'TERMINAL_PENDING recovery requires the Task Project to be already deleted'
        ));
      }
      return this.#finishRecoveredCleanup(task, state);
    }

    return this.#blockRecovery(state, new RunnerError(
      ERROR_CODES.TASK_RECOVERY_BLOCKED,
      `Recovery is not enabled for phase=${state.phase}`
    ));
  }

  async #runClaimedTask(claimed) {
    const task = normalizeTask(claimed);
    let state = createExecutionState(task, { lease: this.taskApi.getLease?.(task.task_id) ?? null });
    await this.taskStore.save(state);
    this.heartbeat?.start(task.task_id);

    try {
      try {
        state = await this.#prepareSource(task, state);
      } catch (error) {
        if (this.#isTerminated(error)) throw error;
        return this.#handleSourcePreparationError(task, state, error);
      }
      return await this.#runPreparedTask(task, state);
    } finally {
      this.heartbeat?.stop();
    }
  }

  async resumeCurrentOnce() {
    this.#assertNotAborted();
    const claimed = await this.taskApi.resumeCurrentTask?.();
    this.#assertNotAborted();
    if (!claimed) return { status: 'no_recovery', state: null };
    return this.#runClaimedTask(claimed);
  }

  async runOnce() {
    this.#assertNotAborted();
    const claimed = await this.taskApi.claimTask();
    this.#assertNotAborted();
    if (!claimed) return { status: 'idle', state: null };
    return this.#runClaimedTask(claimed);
  }}
