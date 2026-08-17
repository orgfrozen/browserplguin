import { normalizeTask } from '../shared/task-schema.js';
import { createExecutionState, recordCreatedWorkspace, recordCompletedPatch, markWorkspaceDeleted, checkpointRoundIntent, markRoundPromptSent, markRoundResponseReady, completeRound, markInitializationCompleted, beginSourcePreparation, recordPatchSyncExport, recordPreparedSource } from '../shared/execution-state.js';
import { parseTaskStatus, decideTaskAction } from '../shared/status-protocol.js';
import { RunnerError, ERROR_CODES } from '../shared/errors.js';

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
    task_patch_count: state.task_patch_count,
    task_round_count: state.task_round_count,
    session_id: state.patch_session_id ?? state.source_preparation?.patch_session_id ?? state.session_id,
    project_name: state.chatgpt_project_name,
    patch_goal: task.patch_goal,
    ...extra
  };
}

export class TaskRunner {
  constructor({ taskApi, taskStore, page, processPatch, artifactTransfer = null, heartbeat = null, observer = null, patchSyncClientFactory = null, fallbackLimit = 2, maxTaskRounds = 100 }) {
    this.taskApi = taskApi;
    this.taskStore = taskStore;
    this.page = page;
    this.processPatch = processPatch;
    this.artifactTransfer = artifactTransfer;
    this.heartbeat = heartbeat;
    this.observer = observer;
    this.patchSyncClientFactory = patchSyncClientFactory;
    this.fallbackLimit = fallbackLimit;
    this.maxTaskRounds = maxTaskRounds;
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

  async #prepareSource(task, state) {
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
      exportId = created.export_id;
      prepared = recordPatchSyncExport(prepared, { exportId });
      await this.taskStore.save(prepared);
      await this.taskApi.reportProgress(task.task_id, { type: 'SOURCE_EXPORT_CREATED', export_id: exportId });
    }

    const manifest = await client.waitForExport(exportId);
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
        state = markWorkspaceDeleted(state);
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
          cleanup_error: { code: error.code ?? 'CLEANUP_FAILED', message: error.message }
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

  async #sendTerminal(task, state, { action, payload, successStatus, successPhase }) {
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
    const finalState = { ...state, phase: successPhase, terminal_error: null };
    await this.taskStore.clear();
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

    state = { ...state, phase: 'CLEANUP', terminal_error: null };
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
    state = { ...state, completion_preview: structuredClone(preview) };
    if (directive === 'CONTINUE') {
      state = { ...state, phase: 'RUNNING', server_continuation_summary: preview.summary ?? 'Acceptance criteria are not yet satisfied' };
      await this.taskStore.save(state);
      return { state };
    }
    if (directive === 'WAIT_EXTERNAL' || directive === 'WAIT_HUMAN') {
      const phase = directive === 'WAIT_EXTERNAL' ? 'WAITING_EXTERNAL' : 'WAITING_HUMAN';
      state = { ...state, phase, server_continuation_summary: null };
      await this.taskStore.save(state);
      return { terminal: { status: phase === 'WAITING_EXTERNAL' ? 'waiting_external' : 'waiting_human', state } };
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
    const finalized = await this.#finalizeAndCleanup(task, state, code, 'FAIL');
    if (!finalized.ok) return { status: 'cleanup_pending', state: finalized.state, error: finalized.error };
    const payload = taskResult(task, finalized.state, { terminal_status: status, code, message });
    const result = await this.#sendTerminal(task, finalized.state, {
      action: 'FAIL',
      payload,
      successStatus: status,
      successPhase: 'FAILED'
    });
    if (result.status === 'terminal_pending') return result;
    return { ...result, error: new RunnerError(code, message, payload) };
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
      onResponseReady: async assistantText => {
        durableState = markRoundResponseReady(durableState, assistantText);
        await this.taskStore.save(durableState);
      }
    };

    try {
      const round = recover
        ? await this.page.recoverRound({ task, state: durableState, checkpoint: durableState.in_flight_round, hooks })
        : await this.page.runRound({ task, state: durableState, prompt, hooks });
      return { state: durableState, round };
    } catch (error) {
      error.durableExecutionState = durableState;
      throw error;
    }
  }

  async #processRound(task, state, round) {
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
      const patchSessionId = state.patch_session_id ?? state.source_preparation?.patch_session_id ?? state.session_id;
      const downloadedArtifact = await this.processPatch(candidate, { taskId: task.task_id, sessionId: patchSessionId, patchSessionId, state });
      const patchSyncClient = this.#patchSyncBootstrap(task, state) ? this.#patchSyncClient(task, state) : null;
      const transfer = this.artifactTransfer
        ? await this.artifactTransfer.transfer(downloadedArtifact, {
          patchSyncClient,
          projectId: task.project_id,
          patchSessionId
        })
        : { mode: null, artifact: downloadedArtifact, receipt: null };
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
    let activeState = state;
    let session;
    let preparedResource = null;
    if (activeState.source_preparation?.status === 'succeeded') {
      try {
        const patchSyncClient = this.#patchSyncClient(task, activeState);
        if (!activeState.source_preparation.rules?.text) {
          const rules = await patchSyncClient.downloadRules({ rules: activeState.source_preparation.rules });
          activeState = {
            ...activeState,
            source_preparation: {
              ...activeState.source_preparation,
              rules: { ...activeState.source_preparation.rules, text: rules.text }
            }
          };
          await this.taskStore.save(activeState);
        }
        preparedResource = await patchSyncClient.downloadSource({ source: activeState.source_preparation.source });
      } catch (error) {
        await this.taskApi.reportProgress(task.task_id, { type: 'SOURCE_BOOTSTRAP_ERROR', code: error.code ?? 'UNEXPECTED', message: error.message });
        await this.taskApi.releaseTask(task.task_id, { code: error.code ?? 'SOURCE_BOOTSTRAP_ERROR', message: error.message });
        await this.taskStore.clear();
        return { status: 'released', error, state: activeState };
      }
    }
    try {
      session = await this.page.createTaskProject({ task, state: activeState });
    } catch (error) {
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
        await this.taskApi.reportProgress(task.task_id, {
          type: 'TASK_INITIALIZING',
          resource_url: activeState.source_preparation?.source?.download_url ?? task.resource?.url ?? null,
          project_name: activeState.chatgpt_project_name
        });
        await this.#observe('onResourceInitializationStarted');
        const initialized = await this.page.initializeTask({
          task,
          state: activeState,
          resource: preparedResource,
          hooks: {
            onResourceDownloaded: () => this.#observe('onResourceDownloaded'),
            onResourceAttached: () => this.#observe('onResourceAttached')
          }
        });
        if (initialized?.contextLimit) {
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
        await this.#observe('onResourceInitializationResponseReady');
        activeState = markInitializationCompleted(activeState);
        await this.taskStore.save(activeState);
        await this.taskApi.reportProgress(task.task_id, {
          type: 'TASK_INITIALIZED',
          project_name: activeState.chatgpt_project_name
        });
        await this.#observe('onResourceInitializationCompleted');
      }

      return await this.#runTaskLoop(task, activeState);
    } catch (error) {
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

  async recoverOnce() {
    let state = await this.taskStore.load();
    if (!state) return { status: 'no_recovery', state: null };

    let task;
    try {
      if (!state.task_snapshot || state.task_snapshot.task_id !== state.task_id) {
        throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, 'Durable Task snapshot is missing or does not match activeExecution.task_id');
      }
      task = normalizeTask(state.task_snapshot);
      if (!state.lease || typeof this.taskApi.restoreLease !== 'function') {
        throw new RunnerError(ERROR_CODES.TASK_RECOVERY_BLOCKED, 'Durable lease is required before recovery');
      }
      this.taskApi.restoreLease(task.task_id, state.lease);
      await this.taskApi.heartbeatTask(task.task_id);
      const refreshedLease = this.taskApi.getLease?.(task.task_id) ?? state.lease;
      state = { ...state, lease: refreshedLease, recovery_error: null };
      await this.taskStore.save(state);
    } catch (error) {
      return this.#blockRecovery(state, error);
    }


    if (state.phase === 'PREPARING_SOURCE') {
      this.heartbeat?.start(task.task_id);
      try {
        try {
          state = await this.#prepareSource(task, state);
        } catch (error) {
          await this.taskApi.reportProgress(task.task_id, { type: 'SOURCE_PREPARE_ERROR', code: error.code ?? 'UNEXPECTED', message: error.message });
          await this.taskApi.releaseTask(task.task_id, { code: error.code ?? 'SOURCE_PREPARE_ERROR', message: error.message });
          await this.taskStore.clear();
          return { status: 'released', state, error };
        }
        return await this.#runPreparedTask(task, state);
      } finally {
        this.heartbeat?.stop();
      }
    }

    if (state.phase === 'RUNNING') {
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
        return this.#blockRecovery(state, new RunnerError(
          ERROR_CODES.TASK_RECOVERY_BLOCKED,
          'Task initialization was not durably completed before the interruption'
        ));
      }
      if (state.in_flight_round && state.in_flight_round.round_number !== state.task_round_count + 1) {
        return this.#blockRecovery(state, new RunnerError(
          ERROR_CODES.TASK_RECOVERY_BLOCKED,
          'In-flight round checkpoint does not match the next Task round number'
        ));
      }
      try {
        await this.page.prepareExistingTask({
          ...task,
          chatgpt_project_name: project.project_name,
          browser_workspace_id: project.browser_workspace_id ?? state.browser_workspace_id ?? project.session_id,
          patch_session_id: patchSessionId,
          session_id: patchSessionId
        });
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
          return await this.#runTaskLoop(task, state, { recoverCheckpoint: Boolean(state.in_flight_round) });
        } finally {
          this.heartbeat?.stop();
        }
      } catch (error) {
        if (error?.code === ERROR_CODES.TASK_RECOVERY_BLOCKED) return this.#blockRecovery(error.durableExecutionState ?? state, error);
        throw error;
      }
    }

    if (state.phase === 'CLEANUP') {
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

  async runOnce() {
    const claimed = await this.taskApi.claimTask();
    if (!claimed) return { status: 'idle', state: null };
    const task = normalizeTask(claimed);
    let state = createExecutionState(task, { lease: this.taskApi.getLease?.(task.task_id) ?? null });
    await this.taskStore.save(state);
    this.heartbeat?.start(task.task_id);

    try {
      try {
        state = await this.#prepareSource(task, state);
      } catch (error) {
        await this.taskApi.reportProgress(task.task_id, { type: 'SOURCE_PREPARE_ERROR', code: error.code ?? 'UNEXPECTED', message: error.message });
        await this.taskApi.releaseTask(task.task_id, { code: error.code ?? 'SOURCE_PREPARE_ERROR', message: error.message });
        await this.taskStore.clear();
        return { status: 'released', state, error };
      }
      return await this.#runPreparedTask(task, state);
    } finally {
      this.heartbeat?.stop();
    }
  }}
