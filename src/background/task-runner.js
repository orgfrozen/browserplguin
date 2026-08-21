import { normalizeTask } from '../shared/task-schema.js';
import { createExecutionState, recordCreatedWorkspace, recordCompletedPatch, markWorkspaceDeleted, checkpointRoundIntent, markRoundPromptSent, markRoundResponseReady, completeRound, markInitializationCompleted, beginSourcePreparation, recordPatchSyncExport, recordPreparedSource, markMeaningfulProgress, beginExternalWait, recordExternalWaitCheck, recordExternalResync, recordExternalEscalation, clearExternalWait, markLeaseLost } from '../shared/execution-state.js';
import { parseTaskStatus, decideTaskAction } from '../shared/status-protocol.js';
import { RunnerError, ERROR_CODES } from '../shared/errors.js';
import { RecoveryPolicyEngine } from './recovery-policy-engine.js';
import { isConfirmedLeaseLoss } from './heartbeat-manager.js';
import { extractPatchIdentity } from '../shared/patch-identity.js';

function continuationPrompt(task, state) {
  if (typeof state.server_continuation_summary === 'string' && state.server_continuation_summary.trim()) {
    return `服务端验收尚未通过：${state.server_continuation_summary.trim()}\n继续当前任务，不要重复已经完成的工作。`;
  }
  if (task.patch_goal?.minimum) {
    const remaining = Math.max(0, task.patch_goal.minimum - state.task_patch_count);
    return `继续当前任务。Patch 目标至少 ${task.patch_goal.minimum} 个；当前本 Task 已成功下载 ${state.task_patch_count} 个，还需要至少 ${remaining} 个。不要重复已完成工作。`;
  }
  return '继续当前任务，直到满足任务目标和验收要求。不要重复已经完成的工作。';
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
  constructor({ taskApi, taskStore, page, processPatch, artifactTransfer = null, heartbeat = null, observer = null, patchSyncClientFactory = null, recoveryPolicyEngine = null, fallbackLimit = 2, maxTaskRounds = 100, maxInitializationRestarts = 2, now = () => new Date(), abortSignal = null }) {
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
    this.maxInitializationRestarts = maxInitializationRestarts;
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
      ERROR_CODES.CHAT_NOT_FOUND,
      ERROR_CODES.PROJECT_NOT_FOUND
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
    const nextAttempt = Number(state.initialization_attempt ?? 0) + 1;
    if (!baseProjectName || nextAttempt > this.maxInitializationRestarts) {
      const exhausted = new RunnerError(
        ERROR_CODES.INITIALIZATION_RECOVERY_EXHAUSTED,
        `Task initialization recovery exhausted after ${this.maxInitializationRestarts} replacement workspaces`,
        { task_id: task.task_id, attempt: state.initialization_attempt ?? 0 }
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
      initialization_base_project_name: baseProjectName
    };
    await this.taskStore.save(current);
    await this.taskApi.reportProgress(task.task_id, {
      type: 'TASK_PROJECT_STARTED',
      browser_workspace_id: current.browser_workspace_id,
      patch_session_id: current.patch_session_id ?? current.session_id,
      session_id: current.patch_session_id ?? current.session_id,
      project_name: current.chatgpt_project_name,
      initialization_attempt: nextAttempt
    });
    return current;
  }

  async #initializeTaskWorkspace(task, state, preparedResource) {
    let current = state;
    while (true) {
      const observationTimeoutMs = this.#observationTimeoutMs(task, current);
      const startedAt = this.#isoNow();
      current = {
        ...current,
        initialization_attempt: Number(current.initialization_attempt ?? 0),
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
        current = markInitializationCompleted(current);
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
        if (Number(current.initialization_attempt ?? 0) >= this.maxInitializationRestarts) {
          const exhausted = new RunnerError(
            ERROR_CODES.INITIALIZATION_RECOVERY_EXHAUSTED,
            `Task initialization recovery exhausted after ${this.maxInitializationRestarts} replacement workspaces`,
            { task_id: task.task_id, last_error: { code: error.code, message: error.message } }
          );
          exhausted.durableExecutionState = current;
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

  async #reconcileTimedOutPatchDownload(task, state, candidate, patchSessionId, error) {
    if (error?.code !== ERROR_CODES.PATCH_DOWNLOAD_FAILED || !/timed out/i.test(String(error?.message ?? ''))) return null;
    if (typeof this.taskApi.preparePatchArtifact !== 'function') return null;
    const identity = extractPatchIdentity(error?.details?.filename ?? candidate?.filename, patchSessionId);
    if (!identity || !Number.isInteger(identity.sequence)) return null;

    await this.taskApi.preparePatchArtifact(task.task_id, {
      filename: identity.filename,
      patch_key: identity.key,
      patch_session_id: patchSessionId,
      sequence: identity.sequence
    });
    const handledKeys = [...new Set([...(state.downloaded_patch_keys ?? []), identity.key, candidate?.control_key].filter(Boolean))];
    const next = { ...state, downloaded_patch_keys: handledKeys };
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

    await this.taskApi.preparePatchArtifact(task.task_id, {
      filename: identity.filename,
      patch_key: identity.key,
      patch_session_id: patchSessionId,
      sequence: identity.sequence
    });
    const handledKeys = [...new Set([...(state.downloaded_patch_keys ?? []), identity.key, candidate?.control_key].filter(Boolean))];
    const next = { ...state, downloaded_patch_keys: handledKeys };
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

  #assertLeaseActive() {
    this.heartbeat?.assertLeaseActive?.();
  }

  async #enterWaitingExternal(task, state, preview, { preserveStartedAt = true } = {}) {
    const rule = this.#externalWaitRule(task, state);
    let next = { ...state, phase: 'WAITING_EXTERNAL', server_continuation_summary: null };
    if (rule) {
      const pollSeconds = Number(rule.poll_interval_seconds);
      if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) {
        throw new RunnerError(ERROR_CODES.RECOVERY_POLICY_INVALID, 'WAIT_EXTERNAL_STALLED.poll_interval_seconds must be positive');
      }
      const now = this.#isoNow();
      const nextCheckAt = new Date(Date.parse(now) + pollSeconds * 1000).toISOString();
      if (!preserveStartedAt || !next.external_wait) {
        next = beginExternalWait(next, { at: now, nextCheckAt, summary: preview?.summary ?? null });
      } else {
        next = recordExternalWaitCheck(next, { at: now, nextCheckAt, summary: preview?.summary ?? null });
      }
      next = this.#withNextRecovery(next, nextCheckAt);
    } else {
      next = this.#withNextRecovery(next, null);
    }
    await this.taskStore.save(next);
    if (typeof this.taskApi.waitingExternalTask === 'function') {
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
    const preview = await this.taskApi.completionCheckTask(task.task_id, {
      task_patch_count: state.task_patch_count,
      task_round_count: state.task_round_count,
      patch_session_id: state.patch_session_id ?? state.source_preparation?.patch_session_id ?? state.session_id
    });
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
      state = await this.#enterWaitingExternal(task, state, preview, { preserveStartedAt: false });
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
    const payload = taskResult(task, state, { terminal_status: status, code, message });
    state = { ...state, terminal_payload: structuredClone(payload) };
    await this.taskStore.save(state);
    await this.taskApi.reportProgress(task.task_id, {
      type: 'TASK_FINALIZING',
      terminal_reason: code,
      task_patch_count: state.task_patch_count,
      task_round_count: state.task_round_count,
      project_name: state.task_project?.project_name ?? null
    });

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

    for (const candidate of round?.patches ?? []) {
      this.#assertNotAborted();
      const patchSessionId = state.patch_session_id ?? state.source_preparation?.patch_session_id ?? state.session_id;
      let downloadedArtifact;
      try {
        downloadedArtifact = await this.processPatch(candidate, { taskId: task.task_id, sessionId: patchSessionId, patchSessionId, state });
        this.#assertNotAborted();
      } catch (error) {
        const reconciled = await this.#reconcileTimedOutPatchDownload(task, state, candidate, patchSessionId, error);
        if (!reconciled) throw error;
        state = reconciled;
        continue;
      }
      const patchSyncClient = this.#patchSyncBootstrap(task, state) ? this.#patchSyncClient(task, state) : null;
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
        if (!reconciled) throw error;
        state = reconciled;
        continue;
      }
      if (transfer.mode === 'remote') await this.#observe('onRemoteTransfer');
      const artifact = transfer.mode
        ? { ...transfer.artifact, transfer_mode: transfer.mode, transfer_receipt: transfer.receipt ?? transfer.remote ?? null }
        : transfer.artifact;
      const key = artifact.patch_key ?? artifact.filename;
      const nextState = recordCompletedPatch(state, key, artifact.control_key ? [artifact.control_key] : []);
      if (nextState !== state) {
        state = nextState;
        await this.taskStore.save(state);
        await this.taskApi.reportArtifact(task.task_id, artifact);
        if (transfer.mode === 'remote') await this.#observe('onArtifactReported');
      }
    }

    const status = parseTaskStatus(round?.assistantText ?? '');
    const fallbackCount = status ? 0 : state.fallback_count + 1;
    state = completeRound(state, { status, fallbackCount });
    await this.taskStore.save(state);
    await this.taskApi.reportProgress(task.task_id, {
      type: 'ROUND_COMPLETED',
      task_round_count: state.task_round_count,
      task_patch_count: state.task_patch_count,
      task_status: status
    });

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


  async #handleLeaseLoss(task, state, error) {
    let lost = markLeaseLost(state, {
      at: this.#isoNow(),
      code: error?.code ?? 'ASSIGNMENT_LEASE_LOST',
      message: error?.message ?? 'Assignment lease was lost'
    });
    await this.taskStore.save(lost);
    const cleaned = await this.#cleanupProject(task, lost, 'LEASE_LOST', { reportProgress: false });
    if (!cleaned.ok) return { status: 'cleanup_pending', state: cleaned.state, error: cleaned.error };
    await this.#observe('onCleanupCompleted');
    await this.taskStore.clear();
    return { status: 'lease_lost', state: { ...cleaned.state, phase: 'LEASE_LOST' }, error };
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

    const stallSeconds = Number(rule.stall_timeout_seconds);
    const pollSeconds = Number(rule.poll_interval_seconds);
    if (!Number.isFinite(stallSeconds) || stallSeconds <= 0 || !Number.isFinite(pollSeconds) || pollSeconds <= 0) {
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

    const preview = await this.taskApi.completionCheckTask(task.task_id, {
      task_patch_count: current.task_patch_count,
      task_round_count: current.task_round_count,
      patch_session_id: current.patch_session_id ?? current.source_preparation?.patch_session_id ?? current.session_id
    });
    const directive = preview?.directive;
    current = this.#withCompletionPreview(current, preview);
    if (directive === 'CONTINUE') {
      current = { ...clearExternalWait(current), phase: 'RUNNING', server_continuation_summary: preview.summary ?? 'External wait resolved; continue the Task' };
      await this.taskStore.save(current);
      await this.taskApi.reportProgress(task.task_id, { type: 'EXTERNAL_WAIT_RESOLVED', summary: preview.summary ?? null });
      return this.#recoverRunningWorkspace(task, current);
    }
    if (directive === 'READY_TO_FINALIZE') return this.#complete(task, current);
    if (directive === 'WAIT_HUMAN') {
      current = await this.#enterWaitingHuman(task, current, { reason: 'WAIT_HUMAN', summary: preview?.summary ?? null });
      return { status: 'waiting_human', state: current };
    }
    if (directive !== 'WAIT_EXTERNAL') {
      return this.#blockRecovery(current, new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, `Unsupported completion_check directive ${directive ?? 'missing'}`));
    }
    const nextCheckAt = new Date(now.getTime() + pollSeconds * 1000).toISOString();
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

    if (state.phase === 'CLEANUP' && (state.business_completed === true || state.terminal_reason === 'LEASE_LOST')) {
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
