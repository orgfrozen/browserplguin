import { normalizeTask } from '../shared/task-schema.js';
import { createExecutionState, recordCreatedWorkspace, recordRound, recordCompletedPatch, markWorkspaceDeleted } from '../shared/execution-state.js';
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
  constructor({ taskApi, taskStore, page, processPatch, heartbeat = null, fallbackLimit = 2, maxTaskRounds = 100 }) {
    this.taskApi = taskApi;
    this.taskStore = taskStore;
    this.page = page;
    this.processPatch = processPatch;
    this.heartbeat = heartbeat;
    this.fallbackLimit = fallbackLimit;
    this.maxTaskRounds = maxTaskRounds;
  }

  async #finalizeAndCleanup(task, state, terminalReason) {
    state = { ...state, phase: 'FINALIZING', terminal_reason: terminalReason, cleanup_error: null };
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

  async #complete(task, state) {
    const finalized = await this.#finalizeAndCleanup(task, state, 'SUCCESS');
    if (!finalized.ok) return { status: 'cleanup_pending', state: finalized.state, error: finalized.error };
    state = { ...finalized.state, phase: 'COMPLETED' };
    await this.taskStore.save(state);
    await this.taskApi.completeTask(task.task_id, taskResult(task, state, { terminal_status: 'success' }));
    await this.taskStore.clear();
    return { status: 'completed', state };
  }

  async #failTerminal(task, state, { status, code, message }) {
    const finalized = await this.#finalizeAndCleanup(task, state, code);
    if (!finalized.ok) return { status: 'cleanup_pending', state: finalized.state, error: finalized.error };
    state = { ...finalized.state, phase: 'FAILED' };
    await this.taskStore.save(state);
    const payload = taskResult(task, state, { terminal_status: status, code, message });
    await this.taskApi.failTask(task.task_id, payload);
    await this.taskStore.clear();
    return { status, state, error: new RunnerError(code, message, payload) };
  }

  async #release(task, state, { code, message }) {
    const finalized = await this.#finalizeAndCleanup(task, state, code);
    if (!finalized.ok) return { status: 'cleanup_pending', state: finalized.state, error: finalized.error };
    state = { ...finalized.state, phase: 'RELEASED' };
    await this.taskStore.save(state);
    const payload = taskResult(task, state, { code, message });
    await this.taskApi.releaseTask(task.task_id, payload);
    await this.taskStore.clear();
    return { status: 'released', state, error: new RunnerError(code, message, payload) };
  }

  async runOnce() {
    const claimed = await this.taskApi.claimTask();
    if (!claimed) return { status: 'idle', state: null };
    const task = normalizeTask(claimed);
    let state = createExecutionState(task);
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
        await this.taskApi.reportProgress(task.task_id, {
          type: 'TASK_INITIALIZED',
          project_name: state.chatgpt_project_name
        });
      }

      let prompt = task.task_prompt;
      while (state.task_round_count < this.maxTaskRounds) {
        const round = await this.page.runRound({ task, state, prompt });

        if (round?.contextLimit) {
          await this.taskApi.reportProgress(task.task_id, {
            type: 'TASK_CONTEXT_LIMIT',
            task_patch_count: state.task_patch_count,
            task_round_count: state.task_round_count,
            patch_goal: task.patch_goal
          });
          return await this.#failTerminal(task, state, {
            status: 'context_limit',
            code: ERROR_CODES.CHAT_LENGTH_LIMIT,
            message: 'ChatGPT reached the current chat/context length limit before the Task completed'
          });
        }

        state = recordRound(state);
        for (const candidate of round?.patches ?? []) {
          const artifact = await this.processPatch(candidate, { taskId: task.task_id, sessionId: state.session_id, state });
          const key = artifact.patch_key ?? artifact.filename;
          const nextState = recordCompletedPatch(state, key, artifact.control_key ? [artifact.control_key] : []);
          if (nextState !== state) {
            state = nextState;
            await this.taskApi.reportArtifact(task.task_id, artifact);
          }
        }

        const status = parseTaskStatus(round?.assistantText ?? '');
        const fallbackCount = status ? 0 : state.fallback_count + 1;
        state = { ...state, last_task_status: status, fallback_count: fallbackCount };
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

        if (action === 'COMPLETE') return await this.#complete(task, state);

        if (action === 'BLOCK' || action === 'PROTOCOL_ERROR') {
          const code = action === 'BLOCK' ? 'TASK_BLOCKED' : ERROR_CODES.TASK_PROTOCOL_MISSING;
          return await this.#release(task, state, { code, message: `Task stopped with ${action}` });
        }

        prompt = continuationPrompt(task, state);
      }

      return await this.#release(task, state, {
        code: ERROR_CODES.TASK_PROTOCOL_MISSING,
        message: `Task exceeded maxTaskRounds=${this.maxTaskRounds}`
      });
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
