export class RuntimeController {
  constructor({ storage, loadMockTasks, createMockRunner, createRealRunner }) {
    this.storage = storage;
    this.loadMockTasks = loadMockTasks;
    this.createMockRunner = createMockRunner;
    this.createRealRunner = createRealRunner;
    this.running = false;
  }

  async getStatus() {
    return {
      running: this.running,
      activeExecution: (await this.storage.get('activeExecution')) ?? null,
      lastRun: (await this.storage.get('lastRun')) ?? null,
      lastRecovery: (await this.storage.get('lastRecovery')) ?? null,
      settings: (await this.storage.get('settings')) ?? null
    };
  }

  async #run(factory, execute, resultKey) {
    if (this.running) throw new Error('runner already running');
    this.running = true;
    try {
      const runner = await factory();
      const result = await execute(runner);
      await this.storage.set(resultKey, result);
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
    return this.#run(
      async () => this.createRealRunner((await this.storage.get('settings')) ?? {}),
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
}
