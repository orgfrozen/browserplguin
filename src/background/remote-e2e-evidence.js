const DEFAULT_KEY = 'remoteE2eEvidence';
const DEFAULT_MAX_RECENT_RUNS = 20;
const RESULTS = new Set(['passed', 'failed', 'incomplete']);
const FAILURE_STAGES = new Set(['remote_transfer', 'artifact_report', 'cleanup', 'terminal', 'task_result', 'recovery', 'none']);
const TERMINAL_ACTIONS = new Set(['COMPLETE', 'CONTEXT_LIMIT', 'FAIL', 'RELEASE']);
const TERMINAL_STATUSES = new Set(['completed', 'context_limit', 'failed', 'released', 'terminal_pending', 'cleanup_pending', 'recovery_blocked', 'unknown']);
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
    failure_stage: safeEnum(value?.failure_stage, FAILURE_STAGES, 'task_result'),
    remote_transfer_count: safeCount(value?.remote_transfer_count),
    artifact_report_count: safeCount(value?.artifact_report_count),
    cleanup_completed: value?.cleanup_completed === true,
    terminal_action: TERMINAL_ACTIONS.has(value?.terminal_action) ? value.terminal_action : null,
    terminal_status: value?.terminal_status == null ? null : safeEnum(value.terminal_status, TERMINAL_STATUSES, 'unknown'),
    runner_status: safeEnum(value?.runner_status, RUNNER_STATUSES, 'unknown')
  };
}

function emptySummary() {
  return { version: 1, total_runs: 0, passed_runs: 0, failed_runs: 0, recent_runs: [], last_run: null };
}

function cloneSummary(value) {
  const source = value?.version === 1 ? value : emptySummary();
  return {
    version: 1,
    total_runs: safeCount(source.total_runs),
    passed_runs: safeCount(source.passed_runs),
    failed_runs: safeCount(source.failed_runs),
    recent_runs: Array.isArray(source.recent_runs) ? structuredClone(source.recent_runs) : [],
    last_run: source.last_run ? structuredClone(source.last_run) : null
  };
}

export class RemoteE2eRunTracker {
  constructor({ enabled = false } = {}) {
    this.enabled = enabled === true;
    this.remoteTransferCount = 0;
    this.artifactReportCount = 0;
    this.cleanupCompleted = false;
    this.terminalAction = null;
    this.terminalStatus = null;
  }

  onRemoteTransfer() {
    if (this.enabled) this.remoteTransferCount += 1;
  }

  onArtifactReported() {
    if (this.enabled) this.artifactReportCount += 1;
  }

  onCleanupCompleted() {
    if (this.enabled) this.cleanupCompleted = true;
  }

  onTerminalSucceeded({ action, status } = {}) {
    if (!this.enabled) return;
    this.terminalAction = TERMINAL_ACTIONS.has(action) ? action : null;
    this.terminalStatus = safeEnum(status, TERMINAL_STATUSES, 'unknown');
  }

  finish({ runnerStatus = 'unknown', recovered = false } = {}) {
    if (!this.enabled) return null;
    const safeRunnerStatus = safeEnum(runnerStatus, RUNNER_STATUSES, 'unknown');
    const passed = this.remoteTransferCount >= 1
      && this.artifactReportCount >= 1
      && this.cleanupCompleted
      && this.terminalAction === 'COMPLETE'
      && this.terminalStatus === 'completed'
      && safeRunnerStatus === 'completed';

    let result = passed ? 'passed' : 'failed';
    let failureStage = 'none';
    if (!passed) {
      const recoveryMissingHistory = recovered === true
        && (this.remoteTransferCount < 1 || this.artifactReportCount < 1)
        && this.cleanupCompleted
        && this.terminalAction !== null;
      if (recoveryMissingHistory) {
        result = 'incomplete';
        failureStage = 'recovery';
      } else if (this.remoteTransferCount < 1) failureStage = 'remote_transfer';
      else if (this.artifactReportCount < 1) failureStage = 'artifact_report';
      else if (!this.cleanupCompleted) failureStage = 'cleanup';
      else if (this.terminalAction !== 'COMPLETE' || this.terminalStatus !== 'completed') failureStage = 'terminal';
      else failureStage = 'task_result';
    }

    return {
      result,
      failure_stage: failureStage,
      remote_transfer_count: this.remoteTransferCount,
      artifact_report_count: this.artifactReportCount,
      cleanup_completed: this.cleanupCompleted,
      terminal_action: this.terminalAction,
      terminal_status: this.terminalStatus,
      runner_status: safeRunnerStatus
    };
  }
}

export class RemoteE2eEvidenceLedger {
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
