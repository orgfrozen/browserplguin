import { buildRunnerStatusView } from '../shared/runner-status.js';

const SAFE_ERROR_DETAIL_KEYS = new Set(['stage', 'status', 'matches', 'reason', 'operation', 'originPattern', 'state_ready', 'latest_role_assistant', 'latest_user_matches', 'source_filename_matches', 'ready_marker_matches']);
const PATCHSYNC_SAFE_ERROR_DETAIL_KEYS = new Set(['origin', 'operation', 'project_id', 'export_id', 'stage', 'status', 'server_reason', 'cause']);
const AUTO_IDLE_TERMINAL_STATUSES = new Set(['completed', 'released', 'failed', 'context_limit', 'terminated']);

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
  constructor({ storage, loadMockTasks, createMockRunner, createRealRunner, prepareRealRun = async () => null, terminateRealTask = null, parkExternalWait = null, parkCleanupRetry = null, scheduleRecoveryAt = null, cancelRecovery = null, scheduleCleanupRetryAt = null, cancelCleanupRetry = null, terminationPausesSharedRunner = true, now = Date.now }) {
    this.storage = storage;
    this.loadMockTasks = loadMockTasks;
    this.createMockRunner = createMockRunner;
    this.createRealRunner = createRealRunner;
    this.prepareRealRun = prepareRealRun;
    this.terminateRealTask = terminateRealTask;
    this.parkExternalWait = typeof parkExternalWait === 'function' ? parkExternalWait : null;
    this.parkCleanupRetry = typeof parkCleanupRetry === 'function' ? parkCleanupRetry : null;
    this.scheduleRecoveryAt = scheduleRecoveryAt;
    this.cancelRecovery = cancelRecovery;
    this.scheduleCleanupRetryAt = typeof scheduleCleanupRetryAt === 'function' ? scheduleCleanupRetryAt : null;
    this.cancelCleanupRetry = typeof cancelCleanupRetry === 'function' ? cancelCleanupRetry : null;
    this.terminationPausesSharedRunner = terminationPausesSharedRunner !== false;
    this.now = typeof now === 'function' ? now : Date.now;
    this.running = false;
    this.activeRun = null;
    this.runSequence = 0;
  }


  async #removeStorageKey(key) {
    if (typeof this.storage.remove === 'function') await this.storage.remove(key);
    else await this.storage.set(key, undefined);
  }

  #schedulerNowIso() {
    const value = Number(this.now());
    return new Date(Number.isFinite(value) ? value : Date.now()).toISOString();
  }

  async #recordScheduler(patch) {
    try {
      const current = (await this.storage.get('schedulerTelemetry')) ?? {};
      const next = { ...current, ...structuredClone(patch) };
      await this.storage.set('schedulerTelemetry', next);
      return next;
    } catch {
      return null;
    }
  }

  async #finishAuto(result, patch = {}) {
    const activeExecution = await this.storage.get('activeExecution');
    const terminalIdle = AUTO_IDLE_TERMINAL_STATUSES.has(result?.status) && !activeExecution?.task_id;
    const terminalState = terminalIdle && (await this.storage.get('manualPaused')) === true ? 'paused' : 'idle';
    await this.#recordScheduler({
      ...patch,
      ...(terminalIdle ? {
        state: terminalState,
        task_id: null,
        next_retry_at: null,
        recovery_error_code: null,
        recovery_control_state: null
      } : {}),
      last_auto_status: result?.status ?? null
    });
    return result;
  }

  async #loadParkedExternalWaits() {
    const value = await this.storage.get('parkedExternalWaits');
    return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && item.task_id) : [];
  }

  async #saveParkedExternalWaits(items) {
    const next = Array.isArray(items) ? items.filter(item => item && typeof item === 'object' && item.task_id) : [];
    if (next.length === 0) await this.#removeStorageKey('parkedExternalWaits');
    else await this.storage.set('parkedExternalWaits', structuredClone(next));
  }

  async #loadParkedCleanupRetries() {
    const value = await this.storage.get('parkedCleanupRetries');
    return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && item.task_id) : [];
  }

  async #saveParkedCleanupRetries(items) {
    const next = Array.isArray(items) ? items.filter(item => item && typeof item === 'object' && item.task_id) : [];
    if (next.length === 0) await this.#removeStorageKey('parkedCleanupRetries');
    else await this.storage.set('parkedCleanupRetries', structuredClone(next));
  }

  #isParkableCleanupRetry(result) {
    return result?.status === 'cleanup_pending'
      && result?.state?.task_id
      && result?.state?.phase === 'CLEANUP'
      && (result.state.business_completed === true || result.state.terminal_reported === true);
  }

  async #enqueueParkedCleanupRetry(state) {
    const current = await this.#loadParkedCleanupRetries();
    const filtered = current.filter(item => item.task_id !== state.task_id || item.execution_id !== state.execution_id);
    filtered.push(structuredClone(state));
    filtered.sort((left, right) => {
      const a = Date.parse(left?.next_recovery_at ?? '') || 0;
      const b = Date.parse(right?.next_recovery_at ?? '') || 0;
      return a - b;
    });
    await this.#saveParkedCleanupRetries(filtered);
  }

  async #scheduleNextCleanupRetry() {
    const current = await this.#loadParkedCleanupRetries();
    const nextAt = current[0]?.next_recovery_at ?? null;
    if (nextAt && this.scheduleCleanupRetryAt) await this.scheduleCleanupRetryAt(nextAt);
    else if (current.length === 0 && this.cancelCleanupRetry) await this.cancelCleanupRetry();
    return nextAt;
  }

  async #parkCleanupPending(result) {
    if (!this.#isParkableCleanupRetry(result)) return false;
    const state = structuredClone(result.state);
    await this.#enqueueParkedCleanupRetry(state);
    try {
      if (this.parkCleanupRetry) await this.parkCleanupRetry({ state: structuredClone(state) });
    } catch {
      // Cleanup is already terminal server-side; local resource-release failures must not pin capacity.
    }
    const active = await this.storage.get('activeExecution');
    if (!active?.task_id || (active.task_id === state.task_id && active.execution_id === state.execution_id)) {
      await this.#removeStorageKey('activeExecution');
      await this.#scheduleNextCleanupRetry();
      return true;
    }
    return false;
  }

  async #restoreParkedCleanupRetry({ force = false } = {}) {
    const current = await this.#loadParkedCleanupRetries();
    if (current.length === 0) return null;
    const index = current.findIndex(item => force || this.#isRecoveryDue(item));
    if (index < 0) {
      await this.#scheduleNextCleanupRetry();
      return null;
    }
    const [state] = current.splice(index, 1);
    await this.#saveParkedCleanupRetries(current);
    await this.storage.set('activeExecution', structuredClone(state));
    return state;
  }

  #isParkableExternalWait(result) {
    return result?.status === 'waiting_external'
      && result?.state?.task_id
      && result?.state?.phase === 'WAITING_EXTERNAL'
      && result?.state?.patch_status_target
      && typeof result.state.patch_status_target === 'object';
  }

  #isRecoveryDue(state, nowMs = Date.now()) {
    const dueAt = Date.parse(state?.next_recovery_at ?? state?.external_wait?.next_check_at ?? '');
    return !Number.isFinite(dueAt) || dueAt <= nowMs;
  }

  async #enqueueParkedExternalWait(state) {
    const current = await this.#loadParkedExternalWaits();
    const filtered = current.filter(item => item.task_id !== state.task_id || item.execution_id !== state.execution_id);
    filtered.push(structuredClone(state));
    filtered.sort((left, right) => {
      const a = Date.parse(left?.next_recovery_at ?? left?.external_wait?.next_check_at ?? '') || 0;
      const b = Date.parse(right?.next_recovery_at ?? right?.external_wait?.next_check_at ?? '') || 0;
      return a - b;
    });
    await this.#saveParkedExternalWaits(filtered);
  }

  async #removeParkedExternalWait(state) {
    const current = await this.#loadParkedExternalWaits();
    await this.#saveParkedExternalWaits(current.filter(item => item.task_id !== state?.task_id || item.execution_id !== state?.execution_id));
  }

  async #parkWaitingExternal(result) {
    // WAIT_EXTERNAL remains part of the Task execution lifecycle. Keep the
    // durable execution and its managed ChatGPT tab until the Task is truly
    // terminal so downstream local/CI/deploy failures can resume in-place.
    // Legacy parkedExternalWaits are still restored by the recovery path for
    // upgrades from older versions, but new waits are never parked here.
    return false;
  }

  async #restoreParkedExternalWait({ force = false } = {}) {
    const current = await this.#loadParkedExternalWaits();
    if (current.length === 0) return null;
    const index = current.findIndex(item => force || this.#isRecoveryDue(item));
    if (index < 0) {
      const nextAt = current[0]?.next_recovery_at ?? current[0]?.external_wait?.next_check_at ?? null;
      if (nextAt && this.scheduleRecoveryAt) await this.scheduleRecoveryAt(nextAt);
      return null;
    }
    const [state] = current.splice(index, 1);
    await this.#saveParkedExternalWaits(current);
    await this.storage.set('activeExecution', structuredClone(state));
    return state;
  }

  async getStatus() {
    const storedLastRun = (await this.storage.get('lastRun')) ?? null;
    const lastRecovery = (await this.storage.get('lastRecovery')) ?? null;
    const recoveryCompletesStoredRun = lastRecovery?.status === 'completed'
      && ['waiting_external', 'cleanup_pending'].includes(storedLastRun?.status)
      && resultTaskId(lastRecovery)
      && resultTaskId(lastRecovery) === resultTaskId(storedLastRun);
    return {
      ...buildRunnerStatusView({
        running: this.running,
        manualPaused: (await this.storage.get('manualPaused')) === true,
        autoRunEnabled: (await this.storage.get('autoRunEnabled')) === true,
        activeExecution: (await this.storage.get('activeExecution')) ?? null,
        lastRun: recoveryCompletesStoredRun ? lastRecovery : storedLastRun,
        lastRecovery,
        settings: (await this.storage.get('settings')) ?? null,
        uiCompatibilityTelemetry: (await this.storage.get('uiCompatibilityTelemetry')) ?? null
      }),
      scheduler: (await this.storage.get('schedulerTelemetry')) ?? null,
      agent_control: (await this.storage.get('agentControlTelemetry')) ?? null
    };
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
      if (resultKey === 'lastRecovery') {
        await this.storage.set('lastRun', persistedResult);
      }
      const manualPaused = (await this.storage.get('manualPaused')) === true;
      const cleanupParked = !manualPaused && await this.#parkCleanupPending(result);
      const nextRecoveryAt = result?.state?.next_recovery_at ?? null;
      if (manualPaused) {
        if (this.cancelRecovery) await this.cancelRecovery();
        if (this.cancelCleanupRetry) await this.cancelCleanupRetry();
      } else if (!cleanupParked && nextRecoveryAt && this.scheduleRecoveryAt) await this.scheduleRecoveryAt(nextRecoveryAt);
      else if (!cleanupParked && this.cancelRecovery && !['waiting_external', 'waiting_human', 'cleanup_pending'].includes(result?.status)) await this.cancelRecovery();
      if (!manualPaused && !cleanupParked) await this.#parkWaitingExternal(result);
      return persistedResult;
    } catch (error) {
      if (runContext.abortController.signal.aborted || this.activeRun !== runContext) {
        if (this.cancelRecovery) await this.cancelRecovery();
        return (await this.storage.get(resultKey)) ?? { status: 'terminated', taskId: runContext.taskId };
      }
      const manualPaused = (await this.storage.get('manualPaused')) === true;
      const durable = await this.storage.get('activeExecution');
      if (!manualPaused && durable?.next_recovery_at && this.scheduleRecoveryAt) {
        try { await this.scheduleRecoveryAt(durable.next_recovery_at); } catch { /* preserve the original execution error */ }
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

  async deferActiveRecovery({ nextRecoveryAt } = {}) {
    const activeExecution = await this.storage.get('activeExecution');
    if (!activeExecution?.task_id) return { status: 'no_active_task' };
    const retryMs = Date.parse(nextRecoveryAt ?? '');
    if (!Number.isFinite(retryMs)) throw new TypeError('nextRecoveryAt must be a valid timestamp');
    const retryAt = new Date(retryMs).toISOString();
    const state = { ...activeExecution, next_recovery_at: retryAt };
    await this.storage.set('activeExecution', state);
    if (this.scheduleRecoveryAt) await this.scheduleRecoveryAt(retryAt);
    await this.#recordScheduler({ state: 'pressure_cooldown_wait', task_id: state.task_id, next_retry_at: retryAt });
    return { status: 'pressure_cooldown_wait', taskId: state.task_id, state };
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
    const tickAt = this.#schedulerNowIso();
    await this.#recordScheduler({ state: 'checking', last_auto_tick_at: tickAt });
    if ((await this.storage.get('autoRunEnabled')) !== true) return this.#finishAuto({ status: 'auto_run_disabled' }, { state: 'disabled' });
    if ((await this.storage.get('manualPaused')) === true) return this.#finishAuto({ status: 'auto_run_paused' }, { state: 'paused' });
    if (this.running) return this.#finishAuto({ status: 'auto_run_busy' }, { state: 'busy' });
    const activeExecution = await this.storage.get('activeExecution');
    if (activeExecution?.task_id) {
      const dueForAutomaticRecovery = activeExecution.phase === 'PREPARING_SOURCE'
        && this.#isRecoveryDue(activeExecution, Number(this.now()));
      if (dueForAutomaticRecovery) {
        await this.#recordScheduler({ state: 'recovering_interrupted_execution', task_id: activeExecution.task_id, next_retry_at: null });
        const recovered = await this.recoverReal();
        return this.#finishAuto(recovered, {
          state: recovered?.status === 'waiting_human' ? 'waiting_human'
            : recovered?.status === 'waiting_external' ? 'waiting_external'
              : 'recovery_complete',
          task_id: resultTaskId(recovered),
          next_retry_at: recovered?.state?.next_recovery_at ?? null,
          recovery_error_code: recovered?.error?.code ?? null
        });
      }
      const reconcilingLease = activeExecution.phase === 'LEASE_LOST';
      return this.#finishAuto(
        { status: 'auto_run_active_execution', taskId: activeExecution.task_id },
        {
          state: reconcilingLease ? 'lease_reconciliation_wait' : 'active_execution',
          task_id: activeExecution.task_id,
          next_retry_at: activeExecution.next_recovery_at ?? null,
          recovery_error_code: activeExecution.lease_loss?.code ?? null,
          recovery_control_state: activeExecution.lease_loss?.control_state ?? null
        }
      );
    }
    const restoredParked = await this.#restoreParkedExternalWait();
    if (restoredParked) {
      await this.#recordScheduler({ state: 'recovering_parked', task_id: restoredParked.task_id, next_retry_at: restoredParked.next_recovery_at ?? null });
      const recovered = await this.recoverReal();
      return this.#finishAuto(recovered, {
        state: recovered?.status === 'lease_lost' ? 'lease_reconciliation' : recovered?.status === 'waiting_external' ? 'parked_external' : 'recovery_complete',
        task_id: resultTaskId(recovered),
        next_retry_at: recovered?.state?.next_recovery_at ?? null,
        recovery_error_code: recovered?.error?.code ?? recovered?.state?.lease_loss?.code ?? null,
        recovery_control_state: recovered?.state?.lease_loss?.control_state ?? null
      });
    }
    const settings = (await this.storage.get('settings')) ?? {};
    if (settings.mode !== 'real') return this.#finishAuto({ status: 'auto_run_mode_not_real' }, { state: 'mode_not_real' });
    const previousLastRun = (await this.storage.get('lastRun')) ?? null;
    await this.#recordScheduler({ state: 'claiming', task_id: null, next_retry_at: null });
    const result = await this.runReal();
    if (result?.status === 'idle' && previousLastRun?.status && previousLastRun.status !== 'idle') {
      await this.storage.set('lastRun', previousLastRun);
    }
    if (result?.status === 'idle') {
      const restoredCleanup = await this.#restoreParkedCleanupRetry();
      if (restoredCleanup) {
        await this.#recordScheduler({ state: 'retrying_cleanup', task_id: restoredCleanup.task_id, next_retry_at: restoredCleanup.next_recovery_at ?? null });
        const recovered = await this.recoverReal();
        return this.#finishAuto(recovered, {
          state: recovered?.status === 'cleanup_pending' ? 'cleanup_retry_parked' : 'cleanup_retry_complete',
          task_id: resultTaskId(recovered),
          next_retry_at: recovered?.state?.next_recovery_at ?? null,
          recovery_error_code: recovered?.error?.code ?? null
        });
      }
    }
    return this.#finishAuto(result, {
      state: result?.status === 'idle' ? 'idle' : 'executing',
      task_id: resultTaskId(result),
      next_retry_at: result?.state?.next_recovery_at ?? null
    });
  }

  async retryCleanup() {
    if ((await this.storage.get('manualPaused')) === true) return { status: 'cleanup_retry_paused' };
    const parked = await this.#loadParkedCleanupRetries();
    if (parked.length === 0) {
      if (this.cancelCleanupRetry) await this.cancelCleanupRetry();
      return { status: 'no_cleanup_retry' };
    }
    if (this.running || (await this.storage.get('activeExecution'))?.task_id) {
      const nowMs = Number(this.now());
      const retryAt = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 30_000).toISOString();
      if (this.scheduleCleanupRetryAt) await this.scheduleCleanupRetryAt(retryAt);
      return { status: 'cleanup_retry_deferred', next_retry_at: retryAt };
    }
    const restored = await this.#restoreParkedCleanupRetry();
    if (!restored) return { status: 'cleanup_retry_not_due' };
    const result = await this.recoverReal();
    await this.#scheduleNextCleanupRetry();
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

  async recoverReal({ operatorInitiated = true } = {}) {
    if ((await this.storage.get('manualPaused')) === true) {
      return { status: 'no_recovery_needed', reason: 'manual_paused' };
    }
    if (!(await this.storage.get('activeExecution'))?.task_id) {
      const restoredCleanup = await this.#restoreParkedCleanupRetry({ force: true });
      if (!restoredCleanup) await this.#restoreParkedExternalWait({ force: true });
    }
    return this.#run(
      async runContext => this.createRealRunner((await this.storage.get('settings')) ?? {}, runContext),
      runner => runner.recoverOnce({ operatorInitiated }),
      'lastRecovery'
    );
  }


  async pause() {
    await this.storage.set('manualPaused', true);
    if (this.cancelRecovery) await this.cancelRecovery();
    if (this.cancelCleanupRetry) await this.cancelCleanupRetry();
    return { status: 'paused' };
  }

  async resume() {
    await this.storage.set('manualPaused', false);
    if (this.running) return { status: 'resumed', recovery: { status: 'deferred', reason: 'runner_running' } };
    return { status: 'resumed', recovery: await this.recoverRealIfNeeded() };
  }

  async detachDuplicateExecution({ taskId, assignmentId, executionId } = {}) {
    const activeExecution = await this.storage.get('activeExecution');
    const matches = activeExecution?.task_id === taskId
      && activeExecution?.assignment_id === assignmentId
      && activeExecution?.execution_id === executionId;
    if (!matches) return { status: 'duplicate_execution_detach_skipped', reason: 'lineage_changed' };

    if (this.cancelRecovery) await this.cancelRecovery();
    const runContext = this.activeRun;
    if (runContext) {
      runContext.taskId = taskId;
      runContext.abortController.abort({
        type: 'duplicate_execution_detach',
        taskId,
        assignmentId,
        executionId
      });
      await runContext.finished;
    }

    const current = await this.storage.get('activeExecution');
    if (
      current?.task_id === taskId
      && current?.assignment_id === assignmentId
      && current?.execution_id === executionId
    ) {
      if (typeof this.storage.remove === 'function') await this.storage.remove('activeExecution');
      else await this.storage.set('activeExecution', undefined);
    }
    return { status: 'duplicate_execution_detached', taskId, assignmentId, executionId };
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
    if (activeExecution) return this.recoverReal({ operatorInitiated: false });

    const parkedCleanup = await this.#loadParkedCleanupRetries();
    if (parkedCleanup.length > 0) {
      const restored = await this.#restoreParkedCleanupRetry();
      if (restored) return this.recoverReal({ operatorInitiated: false });
    }

    const parked = await this.#loadParkedExternalWaits();
    if (parked.length > 0) {
      const restored = await this.#restoreParkedExternalWait();
      if (restored) return this.recoverReal({ operatorInitiated: false });
      return { status: 'no_recovery_needed', reason: 'parked_external_wait_not_due' };
    }

    return this.#run(
      async runContext => this.createRealRunner(settings, runContext),
      runner => runner.resumeCurrentOnce(),
      'lastRecovery'
    );
  }
}
