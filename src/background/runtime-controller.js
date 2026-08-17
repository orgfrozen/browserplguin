import { buildRunnerStatusView } from '../shared/runner-status.js';

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
      await this.storage.set(resultKey, result);
      const nextRecoveryAt = result?.state?.next_recovery_at ?? null;
      if (nextRecoveryAt && this.scheduleRecoveryAt) await this.scheduleRecoveryAt(nextRecoveryAt);
      else if (this.cancelRecovery && !['waiting_external', 'waiting_human', 'cleanup_pending'].includes(result?.status)) await this.cancelRecovery();
      return result;
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
