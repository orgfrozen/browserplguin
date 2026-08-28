import { buildRunnerStatusView } from '../shared/runner-status.js';

const SAFE_ERROR_DETAIL_KEYS = new Set(['stage', 'status', 'matches', 'reason', 'operation', 'originPattern']);
const PATCHSYNC_SAFE_ERROR_DETAIL_KEYS = new Set(['origin', 'operation', 'project_id', 'export_id', 'stage', 'status', 'server_reason', 'cause']);

function serializeError(error) {
  if (!error) return null;
  const details = {};
  const allowed = String(error?.code ?? '').startsWith('PATCHSYNC_')
    ? PATCHSYNC_SAFE_ERROR_DETAIL_KEYS
    : SAFE_ERROR_DETAIL_KEYS;
  for (const [key, value] of Object.entries(error.details ?? {})) {
    if (allowed.has(key) && ['string', 'number', 'boolean'].includes(typeof value)) details[key] = value;
  }
  return {
    safe: true,
    name: typeof error.name === 'string' ? error.name : 'Error',
    code: typeof error.code === 'string' ? error.code : 'UNEXPECTED',
    message: typeof error.message === 'string' ? error.message : String(error),
    ...(Object.keys(details).length > 0 ? { details } : {})
  };
}


function resultTaskId(value) {
  return value?.taskId ?? value?.task_id ?? value?.state?.task_id ?? null;
}

function safeRunState(state) {
  if (!state || typeof state !== 'object') return state ?? null;
  const source = state.source_preparation ?? null;
  const previewSuccessfulPatches = Number(state.completion_preview?.counts?.successful_patches);
  const serverSuccessfulPatches = Math.max(
    Number.isInteger(state.server_successful_patch_count) ? state.server_successful_patch_count : 0,
    Number.isInteger(previewSuccessfulPatches) && previewSuccessfulPatches >= 0 ? previewSuccessfulPatches : 0
  );
  const patchTransferMode = state.browser_execution_bootstrap?.patchsync
    ? 'patchsync'
    : ['local', 'remote', 'patchsync'].includes(state.patch_transfer_mode) ? state.patch_transfer_mode : null;
  return {
    task_id: state.task_id ?? null,
    project_id: state.project_id ?? null,
    assignment_id: state.assignment_id ?? null,
    execution_id: state.execution_id ?? null,
    phase: state.phase ?? null,
    patch_session_id: state.patch_session_id ?? source?.patch_session_id ?? null,
    session_id: state.session_id ?? null,
    browser_workspace_id: state.browser_workspace_id ?? null,
    chatgpt_project_name: state.chatgpt_project_name ?? null,
    task_round_count: Number.isInteger(state.task_round_count) ? state.task_round_count : 0,
    task_patch_count: Number.isInteger(state.task_patch_count) ? state.task_patch_count : 0,
    ...(serverSuccessfulPatches > 0 ? { server_successful_patch_count: serverSuccessfulPatches } : {}),
    ...(patchTransferMode ? { patch_transfer_mode: patchTransferMode } : {}),
    initialization_completed: state.initialization_completed === true,
    business_completed: state.business_completed === true,
    next_recovery_at: state.next_recovery_at ?? null,
    source_preparation: source ? {
      status: source.status ?? null,
      export_id: source.export_id ?? null,
      patch_session_id: source.patch_session_id ?? null,
      source_ready: Boolean(source.source),
      rules_ready: Boolean(source.rules)
    } : null
  };
}

function safeRunResult(result) {
  if (!result || typeof result !== 'object') return result;
  return {
    ...result,
    ...(Object.hasOwn(result, 'error') ? { error: serializeError(result.error) } : {}),
    ...(Object.hasOwn(result, 'state') ? { state: safeRunState(result.state) } : {})
  };
}


function leaseLostArchiveEntry(state) {
  if (!state || typeof state !== 'object') return null;
  return {
    task_id: state.task_id ?? null,
    project_id: state.project_id ?? null,
    assignment_id: state.assignment_id ?? null,
    execution_id: state.execution_id ?? null,
    project_name: state.chatgpt_project_name ?? state.task_project?.project_name ?? null,
    patch_session_id: state.patch_session_id ?? state.session_id ?? null,
    patch_filename: state.patch_status_target?.filename ?? null,
    patch_sequence: Number.isInteger(state.patch_status_target?.sequence) ? state.patch_status_target.sequence : null,
    lease_loss: state.lease_loss ? {
      at: state.lease_loss.at ?? null,
      code: state.lease_loss.code ?? null,
      message: state.lease_loss.message ?? null,
      control_state: state.lease_loss.control_state ?? null,
      control_checked_at: state.lease_loss.control_checked_at ?? null
    } : null
  };
}

export class RuntimeController {
  constructor({ storage, loadMockTasks, createMockRunner, createRealRunner, prepareRealRun = async () => null, terminateRealTask = null, scheduleRecoveryAt = null, cancelRecovery = null, terminationPausesSharedRunner = true }) {
    this.storage = storage;
    this.loadMockTasks = loadMockTasks;
    this.createMockRunner = createMockRunner;
    this.createRealRunner = createRealRunner;
    this.prepareRealRun = prepareRealRun;
    this.terminateRealTask = terminateRealTask;
    this.scheduleRecoveryAt = scheduleRecoveryAt;
    this.cancelRecovery = cancelRecovery;
    this.terminationPausesSharedRunner = terminationPausesSharedRunner !== false;
    this.running = false;
    this.activeRun = null;
    this.runSequence = 0;
  }

  async getStatus() {
    const storedLastRun = (await this.storage.get('lastRun')) ?? null;
    const lastRecovery = (await this.storage.get('lastRecovery')) ?? null;
    const recoveryCompletesStoredRun = lastRecovery?.status === 'completed'
      && ['waiting_external', 'cleanup_pending'].includes(storedLastRun?.status)
      && resultTaskId(lastRecovery)
      && resultTaskId(lastRecovery) === resultTaskId(storedLastRun);
    return buildRunnerStatusView({
      running: this.running,
      manualPaused: (await this.storage.get('manualPaused')) === true,
      autoRunEnabled: (await this.storage.get('autoRunEnabled')) === true,
      activeExecution: (await this.storage.get('activeExecution')) ?? null,
      lastRun: recoveryCompletesStoredRun ? lastRecovery : storedLastRun,
      lastRecovery,
      settings: (await this.storage.get('settings')) ?? null,
      uiCompatibilityTelemetry: (await this.storage.get('uiCompatibilityTelemetry')) ?? null
    });
  }

  async #run(factory, execute, resultKey) {
    if (this.running) throw new Error('runner already running');
    let finishRun;
    const runContext = {
      id: ++this.runSequence,
      abortController: new AbortController(),
      taskId: null,
      finished: new Promise(resolve => { finishRun = resolve; })
    };
    this.activeRun = runContext;
    this.running = true;
    try {
      const runner = await factory({ signal: runContext.abortController.signal, runId: runContext.id });
      const result = await execute(runner);
      if (runContext.abortController.signal.aborted || this.activeRun !== runContext) {
        if (this.cancelRecovery) await this.cancelRecovery();
        return (await this.storage.get(resultKey)) ?? { status: 'terminated', taskId: runContext.taskId };
      }
      const resultTaskId = result?.state?.task_id ?? result?.taskId ?? null;
      const terminatedTaskIds = await this.storage.get('terminatedTaskIds');
      if (resultTaskId && Array.isArray(terminatedTaskIds) && terminatedTaskIds.includes(resultTaskId)) {
        if (this.cancelRecovery) await this.cancelRecovery();
        return (await this.storage.get('lastRun')) ?? { status: 'terminated', taskId: resultTaskId };
      }
      if (result?.status === 'lease_lost' && result?.state?.lease_loss?.control_state === 'detached') {
        const entry = leaseLostArchiveEntry(result.state);
        if (entry) {
          const existing = await this.storage.get('leaseLostExecutions');
          const archived = Array.isArray(existing) ? existing.filter(item => item && typeof item === 'object') : [];
          archived.push(entry);
          await this.storage.set('leaseLostExecutions', archived.slice(-20));
        }
        if (typeof this.storage.remove === 'function') await this.storage.remove('activeExecution');
        else await this.storage.set('activeExecution', undefined);
      }
      const persistedResult = safeRunResult(result);
      await this.storage.set(resultKey, persistedResult);
      if (resultKey === 'lastRecovery' && persistedResult?.status === 'completed') {
        await this.storage.set('lastRun', persistedResult);
      }
      const manualPaused = (await this.storage.get('manualPaused')) === true;
      const nextRecoveryAt = result?.state?.next_recovery_at ?? null;
      if (manualPaused) {
        if (this.cancelRecovery) await this.cancelRecovery();
      } else if (nextRecoveryAt && this.scheduleRecoveryAt) await this.scheduleRecoveryAt(nextRecoveryAt);
      else if (this.cancelRecovery && !['waiting_external', 'waiting_human', 'cleanup_pending'].includes(result?.status)) await this.cancelRecovery();
      return persistedResult;
    } catch (error) {
      if (runContext.abortController.signal.aborted || this.activeRun !== runContext) {
        if (this.cancelRecovery) await this.cancelRecovery();
        return (await this.storage.get(resultKey)) ?? { status: 'terminated', taskId: runContext.taskId };
      }
      throw error;
    } finally {
      if (this.activeRun === runContext) {
        this.activeRun = null;
        this.running = false;
      }
      finishRun();
    }
  }

  async interruptAndRecover(reason = { type: 'runtime_interrupted' }) {
    const runContext = this.activeRun;
    if (runContext) {
      runContext.abortController.abort(structuredClone(reason));
      await runContext.finished;
    }
    const activeExecution = await this.storage.get('activeExecution');
    if (!activeExecution?.task_id) return { status: 'no_recovery_needed', reason: 'no_active_execution' };
    return this.recoverReal();
  }


  async setAutoRunEnabled(enabled) {
    const value = enabled === true;
    const wasPaused = (await this.storage.get('manualPaused')) === true;
    await this.storage.set('autoRunEnabled', value);

    let recovery = null;
    if (value && wasPaused) {
      await this.storage.set('manualPaused', false);
      const activeExecution = await this.storage.get('activeExecution');
      if (!this.running && activeExecution?.task_id) recovery = await this.recoverRealIfNeeded();
    }

    return {
      status: value ? 'auto_run_enabled' : 'auto_run_disabled',
      enabled: value,
      resumed: value && wasPaused,
      ...(recovery ? { recovery } : {})
    };
  }

  async runAutoOnce() {
    if ((await this.storage.get('autoRunEnabled')) !== true) return { status: 'auto_run_disabled' };
    if ((await this.storage.get('manualPaused')) === true) return { status: 'auto_run_paused' };
    if (this.running) return { status: 'auto_run_busy' };
    const activeExecution = await this.storage.get('activeExecution');
    if (activeExecution?.task_id) return { status: 'auto_run_active_execution', taskId: activeExecution.task_id };
    const settings = (await this.storage.get('settings')) ?? {};
    if (settings.mode !== 'real') return { status: 'auto_run_mode_not_real' };
    const previousLastRun = (await this.storage.get('lastRun')) ?? null;
    const result = await this.runReal();
    if (result?.status === 'idle' && previousLastRun?.status && previousLastRun.status !== 'idle') {
      await this.storage.set('lastRun', previousLastRun);
    }
    return result;
  }

  async runMock(taskId = null) {
    return this.#run(async () => {
      const tasks = await this.loadMockTasks();
      const task = taskId ? tasks.find(item => item.task_id === taskId) : tasks[0];
      if (!task) throw new Error(`mock task not found: ${taskId ?? '(first)'}`);
      return this.createMockRunner(task);
    }, runner => runner.runOnce(), 'lastRun');
  }

  async runReal() {
    if ((await this.storage.get('manualPaused')) === true) {
      const error = new Error('Runner is manually paused');
      error.code = 'MANUAL_PAUSED';
      throw error;
    }
    const activeExecution = await this.storage.get('activeExecution');
    if (activeExecution) {
      const error = new Error(`Active execution ${activeExecution.task_id ?? '(unknown)'} requires recovery before claiming another Task`);
      error.code = 'ACTIVE_EXECUTION_PRESENT';
      throw error;
    }
    const settings = (await this.storage.get('settings')) ?? {};
    return this.#run(
      async runContext => {
        await this.prepareRealRun(settings);
        if (runContext.signal.aborted) {
          const error = new Error('Task execution terminated by operator');
          error.code = 'TASK_TERMINATED';
          throw error;
        }
        return this.createRealRunner(settings, runContext);
      },
      runner => runner.runOnce(),
      'lastRun'
    );
  }

  async recoverReal() {
    if ((await this.storage.get('manualPaused')) === true) {
      return { status: 'no_recovery_needed', reason: 'manual_paused' };
    }
    return this.#run(
      async runContext => this.createRealRunner((await this.storage.get('settings')) ?? {}, runContext),
      runner => runner.recoverOnce(),
      'lastRecovery'
    );
  }


  async pause() {
    await this.storage.set('manualPaused', true);
    if (this.cancelRecovery) await this.cancelRecovery();
    return { status: 'paused' };
  }

  async resume() {
    await this.storage.set('manualPaused', false);
    if (this.running) return { status: 'resumed', recovery: { status: 'deferred', reason: 'runner_running' } };
    return { status: 'resumed', recovery: await this.recoverRealIfNeeded() };
  }

  async terminateTask() {
    const activeExecution = await this.storage.get('activeExecution');
    if (!activeExecution?.task_id) return { status: 'no_active_task' };
    if (typeof this.terminateRealTask !== 'function') throw new Error('Real Task termination is not configured');

    if (this.terminationPausesSharedRunner) await this.storage.set('manualPaused', true);
    if (this.cancelRecovery) await this.cancelRecovery();
    const runContext = this.activeRun;
    if (runContext) {
      runContext.taskId = activeExecution.task_id;
      runContext.abortController.abort({ type: 'task_terminated', taskId: activeExecution.task_id });
    }
    const settings = (await this.storage.get('settings')) ?? {};
    let termination;
    try {
      termination = await this.terminateRealTask({ activeExecution: structuredClone(activeExecution), settings: structuredClone(settings) });
    } finally {
      if (runContext && this.activeRun === runContext) {
        this.activeRun = null;
        this.running = false;
      }
    }

    const terminatedTaskIds = await this.storage.get('terminatedTaskIds');
    const ids = Array.isArray(terminatedTaskIds) ? terminatedTaskIds.filter(id => typeof id === 'string' && id) : [];
    if (!ids.includes(activeExecution.task_id)) ids.push(activeExecution.task_id);
    await this.storage.set('terminatedTaskIds', ids.slice(-50));
    if (typeof this.storage.remove === 'function') await this.storage.remove('activeExecution');
    else await this.storage.set('activeExecution', undefined);
    if (this.terminationPausesSharedRunner) await this.storage.set('manualPaused', false);
    if (this.cancelRecovery) await this.cancelRecovery();

    const result = {
      status: 'terminated',
      taskId: activeExecution.task_id,
      server_status: termination?.server_status ?? 'cancelled',
      cleanup_status: termination?.cleanup_status ?? 'not_required',
      ...(termination?.cleanup_error ? { error: termination.cleanup_error } : {})
    };
    await this.storage.set('lastRun', safeRunResult(result));
    return safeRunResult(result);
  }

  async recoverRealIfNeeded() {
    if ((await this.storage.get('manualPaused')) === true) return { status: 'no_recovery_needed', reason: 'manual_paused' };
    const settings = (await this.storage.get('settings')) ?? {};
    if (settings.mode !== 'real') return { status: 'no_recovery_needed', reason: 'mode_not_real' };

    const activeExecution = await this.storage.get('activeExecution');
    if (activeExecution) return this.recoverReal();

    return this.#run(
      async runContext => this.createRealRunner(settings, runContext),
      runner => runner.resumeCurrentOnce(),
      'lastRecovery'
    );
  }
}
