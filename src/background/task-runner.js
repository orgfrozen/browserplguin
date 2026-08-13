import { normalizeTask } from '../shared/task-schema.js';
import { createExecutionState, recordCreatedWorkspace, recordCompletedPatch, markWorkspaceDeleted, checkpointRoundIntent, markRoundPromptSent, markRoundResponseReady, completeRound, markInitializationCompleted } from '../shared/execution-state.js';
import { parseTaskStatus, decideTaskAction } from '../shared/status-protocol.js';
import { RunnerError, ERROR_CODES } from '../shared/errors.js';

function continuationPrompt(task, state) {
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
    session_id: state.session_id,
    project_name: state.chatgpt_project_name,
    patch_goal: task.patch_goal,
    ...extra
  };
}

export class TaskRunner {
  constructor({ taskApi, taskStore, page, processPatch, artifactTransfer = null, heartbeat = null, fallbackLimit = 2, maxTaskRounds = 100 }) {
    this.taskApi = taskApi;
    this.taskStore = taskStore;
    this.page = page;
    this.processPatch = processPatch;
    this.artifactTransfer = artifactTransfer;
    this.heartbeat = heartbeat;
    this.fallbackLimit = fallbackLimit;
    this.maxTaskRounds = maxTaskRounds;
  }

  async #cleanupProject(task, state, terminalReason) {
    const project = state.task_project;
    if (project && project.status !== 'deleted') {
      try {
        await this.page.deleteTaskProject({ task, state, project });
        state = markWorkspaceDeleted(state);
        await this.taskStore.save(state);
        await this.taskApi.reportProgress(task.task_id, {
          type: 'TASK_PROJECT_DELETED',
          project_name: project.project_name,
          session_id: project.session_id
        });
      } catch (error) {
        state = {
          ...state,
          phase: 'CLEANUP',
          cleanup_error: { code: error.code ?? 'CLEANUP_FAILED', message: error.message }
        };
        await this.taskStore.save(state);
        await this.taskApi.reportProgress(task.task_id, {
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
    return this.#cleanupProject(task, state, terminalReason);
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
    const finalState = { ...state, phase: successPhase, terminal_error: null };
    await this.taskStore.clear();
    return { status: successStatus, state: finalState };
  }

  async #complete(task, state) {
    const finalized = await this.#finalizeAndCleanup(task, state, 'SUCCESS', 'COMPLETE');
    if (!finalized.ok) return { status: 'cleanup_pending', state: finalized.state, error: finalized.error };
    const payload = taskResult(task, finalized.state, { terminal_status: 'success' });
    return this.#sendTerminal(task, finalized.state, {
      action: 'COMPLETE',
      payload,
      successStatus: 'completed',
      successPhase: 'COMPLETED'
    });
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
        terminal: await this.#failTerminal(task, state, {
          status: 'context_limit',
          code: ERROR_CODES.CHAT_LENGTH_LIMIT,
          message: 'ChatGPT reached the current chat/context length limit before the Task completed'
        })
      };
    }

    for (const candidate of round?.patches ?? []) {
      const downloadedArtifact = await this.processPatch(candidate, { taskId: task.task_id, sessionId: state.session_id, state });
      const transfer = this.artifactTransfer
        ? await this.artifactTransfer.transfer(downloadedArtifact)
        : { mode: null, artifact: downloadedArtifact, receipt: null };
      const artifact = transfer.mode
        ? { ...transfer.artifact, transfer_mode: transfer.mode, transfer_receipt: transfer.receipt ?? transfer.remote ?? null }
        : transfer.artifact;
      const key = artifact.patch_key ?? artifact.filename;
      const nextState = recordCompletedPatch(state, key, artifact.control_key ? [artifact.control_key] : []);
      if (nextState !== state) {
        state = nextState;
        await this.taskStore.save(state);
        await this.taskApi.reportArtifact(task.task_id, artifact);
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
    if (action === 'COMPLETE') return { terminal: await this.#complete(task, state) };
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
    if (action === 'COMPLETE') return this.#complete(task, state);
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
      ?? (state.terminal_reason === 'SUCCESS' ? 'COMPLETE' : state.terminal_reason === ERROR_CODES.CHAT_LENGTH_LIMIT ? 'FAIL' : null);

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
      successStatus: action === 'COMPLETE' ? 'completed' : action === 'FAIL'
        ? (payload.terminal_status === 'context_limit' ? 'context_limit' : 'failed')
        : 'released',
      successPhase: action === 'COMPLETE' ? 'COMPLETED' : action === 'FAIL' ? 'FAILED' : 'RELEASED'
    });
    if (result.status === 'terminal_pending') return result;
    if (action === 'FAIL') return { ...result, error: new RunnerError(payload.code, payload.message, payload) };
    if (action === 'RELEASE') return { ...result, error: new RunnerError(payload.code, payload.message, payload) };
    return result;
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

    if (state.phase === 'RUNNING') {
      const project = state.task_project;
      if (!project || project.status !== 'active' || !project.project_name || !project.session_id) {
        return this.#blockRecovery(state, new RunnerError(
          ERROR_CODES.TASK_RECOVERY_BLOCKED,
          'RUNNING recovery requires the exact active task_project identity and session_id'
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
          session_id: project.session_id
        });
        this.heartbeat?.start(task.task_id);
        await this.taskApi.reportProgress(task.task_id, {
          type: 'TASK_RECOVERED_RUNNING',
          project_name: project.project_name,
          session_id: project.session_id,
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
      let session;
      try {
        session = await this.page.createTaskProject({ task, state });
      } catch (error) {
        await this.taskApi.reportProgress(task.task_id, { type: 'PROJECT_CREATE_ERROR', code: error.code ?? 'UNEXPECTED', message: error.message });
        await this.taskApi.releaseTask(task.task_id, { code: error.code ?? 'PROJECT_CREATE_ERROR', message: error.message });
        await this.taskStore.clear();
        return { status: 'released', error, state };
      }

      state = recordCreatedWorkspace(state, { sessionId: session.sessionId, projectName: session.projectName });
      state = { ...state, phase: 'RUNNING' };
      await this.taskStore.save(state);
      await this.taskApi.reportProgress(task.task_id, {
        type: 'TASK_PROJECT_STARTED',
        session_id: state.session_id,
        project_name: state.chatgpt_project_name
      });

      if (task.resource) {
        await this.taskApi.reportProgress(task.task_id, {
          type: 'TASK_INITIALIZING',
          resource_url: task.resource.url,
          project_name: state.chatgpt_project_name
        });
        const initialized = await this.page.initializeTask({ task, state });
        if (initialized?.contextLimit) {
          await this.taskApi.reportProgress(task.task_id, {
            type: 'TASK_CONTEXT_LIMIT',
            stage: 'initialization',
            task_patch_count: state.task_patch_count,
            task_round_count: state.task_round_count,
            patch_goal: task.patch_goal
          });
          return await this.#failTerminal(task, state, {
            status: 'context_limit',
            code: ERROR_CODES.CHAT_LENGTH_LIMIT,
            message: 'ChatGPT reached the current chat/context length limit during Task initialization'
          });
        }
        state = markInitializationCompleted(state);
        await this.taskStore.save(state);
        await this.taskApi.reportProgress(task.task_id, {
          type: 'TASK_INITIALIZED',
          project_name: state.chatgpt_project_name
        });
      }

      return await this.#runTaskLoop(task, state);
    } catch (error) {
      if (state.task_project?.status === 'active') {
        return await this.#failTerminal(task, state, {
          status: 'failed',
          code: error.code ?? 'UNEXPECTED',
          message: error.message
        });
      }
      await this.taskApi.failTask(task.task_id, { code: error.code ?? 'UNEXPECTED', message: error.message });
      await this.taskStore.clear();
      return { status: 'failed', state, error };
    } finally {
      this.heartbeat?.stop();
    }
  }
}
