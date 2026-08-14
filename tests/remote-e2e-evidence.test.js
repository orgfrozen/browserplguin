import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteE2eEvidenceLedger, RemoteE2eRunTracker } from '../src/background/remote-e2e-evidence.js';

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(structuredClone(seed)));
  return {
    data,
    async get(key) { return structuredClone(data.get(key)); },
    async set(key, value) { data.set(key, structuredClone(value)); },
    async remove(key) { data.delete(key); }
  };
}

test('remote E2E tracker passes only after remote transfer, report, cleanup and COMPLETE terminal', () => {
  const tracker = new RemoteE2eRunTracker({ enabled: true });
  tracker.onRemoteTransfer();
  tracker.onArtifactReported();
  tracker.onCleanupCompleted();
  tracker.onTerminalSucceeded({ action: 'COMPLETE', status: 'completed' });
  const result = tracker.finish({ runnerStatus: 'completed', recovered: false });
  assert.deepEqual(result, {
    result: 'passed',
    failure_stage: 'none',
    remote_transfer_count: 1,
    artifact_report_count: 1,
    cleanup_completed: true,
    terminal_action: 'COMPLETE',
    terminal_status: 'completed',
    runner_status: 'completed'
  });
});

test('missing stage fails closed and recovery without witnessed upload/report is incomplete', () => {
  const missingReport = new RemoteE2eRunTracker({ enabled: true });
  missingReport.onRemoteTransfer();
  missingReport.onCleanupCompleted();
  missingReport.onTerminalSucceeded({ action: 'COMPLETE', status: 'completed' });
  assert.equal(missingReport.finish({ runnerStatus: 'completed' }).failure_stage, 'artifact_report');

  const recovered = new RemoteE2eRunTracker({ enabled: true });
  recovered.onCleanupCompleted();
  recovered.onTerminalSucceeded({ action: 'COMPLETE', status: 'completed' });
  assert.deepEqual(recovered.finish({ runnerStatus: 'completed', recovered: true }), {
    result: 'incomplete',
    failure_stage: 'recovery',
    remote_transfer_count: 0,
    artifact_report_count: 0,
    cleanup_completed: true,
    terminal_action: 'COMPLETE',
    terminal_status: 'completed',
    runner_status: 'completed'
  });
});

test('disabled tracker produces no evidence', () => {
  const tracker = new RemoteE2eRunTracker({ enabled: false });
  tracker.onRemoteTransfer();
  assert.equal(tracker.finish({ runnerStatus: 'completed' }), null);
});

test('ledger stores only fixed safe fields, bounds recent runs and clears only its own key', async () => {
  const storage = memoryStorage({ keepMe: { ok: true } });
  let tick = 0;
  const ledger = new RemoteE2eEvidenceLedger({
    storage,
    maxRecentRuns: 2,
    now: () => new Date(`2026-08-14T00:00:0${tick++}.000Z`)
  });

  await ledger.record({
    result: 'passed', failure_stage: 'none', remote_transfer_count: 2, artifact_report_count: 2,
    cleanup_completed: true, terminal_action: 'COMPLETE', terminal_status: 'completed', runner_status: 'completed',
    task_id: 'secret-task', filename: 'secret.patch', local_path: '/secret/path', url: 'https://secret.example/a', token: 'secret'
  });
  await ledger.record({
    result: 'failed', failure_stage: 'terminal', remote_transfer_count: 1, artifact_report_count: 1,
    cleanup_completed: true, terminal_action: 'FAIL', terminal_status: 'failed', runner_status: 'failed'
  });
  await ledger.record({
    result: 'failed', failure_stage: 'remote_transfer', remote_transfer_count: 0, artifact_report_count: 0,
    cleanup_completed: false, terminal_action: null, terminal_status: null, runner_status: 'failed'
  });

  const summary = await ledger.getSummary();
  assert.equal(summary.total_runs, 3);
  assert.equal(summary.passed_runs, 1);
  assert.equal(summary.failed_runs, 2);
  assert.equal(summary.recent_runs.length, 2);
  assert.deepEqual(Object.keys(summary.last_run).sort(), [
    'artifact_report_count','at','cleanup_completed','failure_stage','remote_transfer_count','result','runner_status','terminal_action','terminal_status'
  ].sort());
  const serialized = JSON.stringify(summary);
  for (const forbidden of ['secret-task','secret.patch','/secret/path','secret.example','token']) {
    assert.equal(serialized.includes(forbidden), false);
  }

  await ledger.clear();
  assert.equal(await storage.get('remoteE2eEvidence'), undefined);
  assert.deepEqual(await storage.get('keepMe'), { ok: true });
});

test('recording failure is isolated from the finished run evidence', async () => {
  const tracker = new RemoteE2eRunTracker({ enabled: true });
  tracker.onRemoteTransfer();
  tracker.onArtifactReported();
  tracker.onCleanupCompleted();
  tracker.onTerminalSucceeded({ action: 'COMPLETE', status: 'completed' });
  const run = tracker.finish({ runnerStatus: 'completed' });
  const ledger = new RemoteE2eEvidenceLedger({
    storage: {
      async get() { return undefined; },
      async set() { throw new Error('storage failed'); },
      async remove() {}
    }
  });
  await assert.rejects(() => ledger.record(run), /storage failed/);
  assert.equal(run.result, 'passed');
});
