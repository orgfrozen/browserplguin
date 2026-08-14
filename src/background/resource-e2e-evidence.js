const DEFAULT_KEY = 'resourceE2eEvidence';
const DEFAULT_MAX_RECENT_RUNS = 20;
const RESULTS = new Set(['passed', 'failed', 'incomplete']);
const FAILURE_STAGES = new Set(['permission', 'download', 'attachment', 'initialization_prompt', 'initialization_persist', 'recovery', 'none']);
const RUNNER_STATUSES = new Set(['completed', 'context_limit', 'failed', 'released', 'terminal_pending', 'cleanup_pending', 'recovery_blocked', 'idle', 'unknown', 'threw']);

function safeCount(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function safeEnum(value, allowed, fallback) {
  const text = typeof value === 'string' ? value : '';
  return allowed.has(text) ? text : fallback;
}

function sanitizeRun(value, at) {
  return {
    at,
    result: safeEnum(value?.result, RESULTS, 'failed'),
    failure_stage: safeEnum(value?.failure_stage, FAILURE_STAGES, 'initialization_prompt'),
    started: value?.started === true,
    downloaded: value?.downloaded === true,
    attached: value?.attached === true,
    response_ready: value?.response_ready === true,
    initialization_completed: value?.initialization_completed === true,
    runner_status: safeEnum(value?.runner_status, RUNNER_STATUSES, 'unknown')
  };
}

function emptySummary() {
  return { version: 1, total_runs: 0, passed_runs: 0, failed_runs: 0, incomplete_runs: 0, recent_runs: [], last_run: null };
}

function cloneSummary(value) {
  const source = value?.version === 1 ? value : emptySummary();
  return {
    version: 1,
    total_runs: safeCount(source.total_runs),
    passed_runs: safeCount(source.passed_runs),
    failed_runs: safeCount(source.failed_runs),
    incomplete_runs: safeCount(source.incomplete_runs),
    recent_runs: Array.isArray(source.recent_runs) ? structuredClone(source.recent_runs) : [],
    last_run: source.last_run ? structuredClone(source.last_run) : null
  };
}

export class ResourceE2eRunTracker {
  constructor() {
    this.started = false;
    this.downloaded = false;
    this.attached = false;
    this.responseReady = false;
    this.initializationCompleted = false;
  }

  onResourceInitializationStarted() { this.started = true; }
  onResourceDownloaded() { if (this.started) this.downloaded = true; }
  onResourceAttached() { if (this.started) this.attached = true; }
  onResourceInitializationResponseReady() { if (this.started) this.responseReady = true; }
  onResourceInitializationCompleted() { if (this.started) this.initializationCompleted = true; }

  finish({ runnerStatus = 'unknown', errorCode = null, recovered = false } = {}) {
    if (!this.started) return null;
    const safeRunnerStatus = safeEnum(runnerStatus, RUNNER_STATUSES, 'unknown');

    let result = this.initializationCompleted ? 'passed' : 'failed';
    let failureStage = this.initializationCompleted ? 'none' : 'initialization_prompt';

    if (!this.initializationCompleted) {
      if (recovered === true) {
        result = 'incomplete';
        failureStage = 'recovery';
      } else if (!this.downloaded) {
        failureStage = errorCode === 'RESOURCE_HOST_PERMISSION_REQUIRED' ? 'permission' : 'download';
      } else if (!this.attached) {
        failureStage = 'attachment';
      } else if (!this.responseReady) {
        failureStage = 'initialization_prompt';
      } else {
        failureStage = 'initialization_persist';
      }
    }

    return {
      result,
      failure_stage: failureStage,
      started: this.started,
      downloaded: this.downloaded,
      attached: this.attached,
      response_ready: this.responseReady,
      initialization_completed: this.initializationCompleted,
      runner_status: safeRunnerStatus
    };
  }
}

export class ResourceE2eEvidenceLedger {
  constructor({ storage, key = DEFAULT_KEY, maxRecentRuns = DEFAULT_MAX_RECENT_RUNS, now = () => new Date() } = {}) {
    this.storage = storage;
    this.key = key;
    this.maxRecentRuns = Math.max(1, safeCount(maxRecentRuns) || DEFAULT_MAX_RECENT_RUNS);
    this.now = now;
    this.writeChain = Promise.resolve();
  }

  async record(value) {
    if (!value) return this.getSummary();
    const write = async () => {
      const current = cloneSummary(await this.storage.get(this.key));
      const run = sanitizeRun(value, this.now().toISOString());
      current.total_runs += 1;
      if (run.result === 'passed') current.passed_runs += 1;
      else if (run.result === 'incomplete') current.incomplete_runs += 1;
      else current.failed_runs += 1;
      current.recent_runs.push(run);
      while (current.recent_runs.length > this.maxRecentRuns) current.recent_runs.shift();
      current.last_run = run;
      await this.storage.set(this.key, current);
      return cloneSummary(current);
    };
    const result = this.writeChain.then(write, write);
    this.writeChain = result.catch(() => {});
    return result;
  }

  async getSummary() {
    return cloneSummary(await this.storage.get(this.key));
  }

  async clear() {
    await this.storage.remove(this.key);
  }
}
