import { buildRunnerStatusView } from '../shared/runner-status.js';

const SAFE_ERROR_DETAIL_KEYS = new Set(['stage', 'status', 'matches', 'reason', 'operation', 'originPattern']);

function serializeError(error) {
  if (!error) return null;
  const details = {};
  for (const [key, value] of Object.entries(error.details ?? {})) {
    if (SAFE_ERROR_DETAIL_KEYS.has(key) && ['string', 'number', 'boolean'].includes(typeof value)) details[key] = value;
  }
  return {
    safe: true,
    name: typeof error.name === 'string' ? error.name : 'Error',
    code: typeof error.code === 'string' ? error.code : 'UNEXPECTED',
    message: typeof error.message === 'string' ? error.message : String(error),
    ...(Object.keys(details).length > 0 ? { details } : {})
  };
}

function safeRunState(state) {
  if (!state || typeof state !== 'object') return state ?? null;
  const source = state.source_preparation ?? null;
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

export class RuntimeController {
  constructor({ storage, loadMockTasks, createMockRunner, createRealRunner, prepareRealRun = async () => null, scheduleRecoveryAt = null, cancelRecovery = null }) {
    this.storage = storage;
    this.loadMockTasks = loadMockTasks;
    this.createMockRunner = createMockRunner;
    this.createRealRunner = createRealRunner;
    this.prepareRealRun = prepareRealRun;
    this.scheduleRecoveryAt = scheduleRecoveryAt;
    this.cancelRecovery = cancelRecovery;
    this.running = false;
  }

  async getStatus() {
    return buildRunnerStatusView({
      running: this.running,
      activeExecution: (await this.storage.get('activeExecution')) ?? null,
      lastRun: (await this.storage.get('lastRun')) ?? null,
      lastRecovery: (await this.storage.get('lastRecovery')) ?? null,
      settings: (await this.storage.get('settings')) ?? null,
      uiCompatibilityTelemetry: (await this.storage.get('uiCompatibilityTelemetry')) ?? null
    });
  }

  async #run(factory, execute, resultKey) {
    if (this.running) throw new Error('runner already running');
    this.running = true;
    try {
      const runner = await factory();
      const result = await execute(runner);
      const persistedResult = safeRunResult(result);
      await this.storage.set(resultKey, persistedResult);
      const nextRecoveryAt = result?.state?.next_recovery_at ?? null;
      if (nextRecoveryAt && this.scheduleRecoveryAt) await this.scheduleRecoveryAt(nextRecoveryAt);
      else if (this.cancelRecovery && !['waiting_external', 'waiting_human', 'cleanup_pending'].includes(result?.status)) await this.cancelRecovery();
      return persistedResult;
    } finally {
      this.running = false;
    }
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
    const activeExecution = await this.storage.get('activeExecution');
    if (activeExecution) {
      const error = new Error(`Active execution ${activeExecution.task_id ?? '(unknown)'} requires recovery before claiming another Task`);
      error.code = 'ACTIVE_EXECUTION_PRESENT';
      throw error;
    }
    const settings = (await this.storage.get('settings')) ?? {};
    return this.#run(
      async () => {
        await this.prepareRealRun(settings);
        return this.createRealRunner(settings);
      },
      runner => runner.runOnce(),
      'lastRun'
    );
  }

  async recoverReal() {
    return this.#run(
      async () => this.createRealRunner((await this.storage.get('settings')) ?? {}),
      runner => runner.recoverOnce(),
      'lastRecovery'
    );
  }


  async recoverRealIfNeeded() {
    const activeExecution = await this.storage.get('activeExecution');
    if (!activeExecution) return { status: 'no_recovery_needed', reason: 'no_active_execution' };

    const settings = (await this.storage.get('settings')) ?? {};
    if (settings.mode !== 'real') return { status: 'no_recovery_needed', reason: 'mode_not_real' };

    return this.recoverReal();
  }
}
