import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceE2eEvidenceLedger, ResourceE2eRunTracker } from '../src/background/resource-e2e-evidence.js';

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(structuredClone(seed)));
  return {
    data,
    async get(key) { return structuredClone(data.get(key)); },
    async set(key, value) { data.set(key, structuredClone(value)); },
    async remove(key) { data.delete(key); }
  };
}

function completedTracker() {
  const tracker = new ResourceE2eRunTracker();
  tracker.onResourceInitializationStarted();
  tracker.onResourceDownloaded();
  tracker.onResourceAttached();
  tracker.onResourceInitializationResponseReady();
  tracker.onResourceInitializationCompleted();
  return tracker;
}

test('resource E2E tracker passes only after every initialization milestone is witnessed', () => {
  const tracker = completedTracker();
  assert.deepEqual(tracker.finish({ runnerStatus: 'failed', errorCode: 'LATER_TASK_FAILURE' }), {
    result: 'passed',
    failure_stage: 'none',
    started: true,
    downloaded: true,
    attached: true,
    response_ready: true,
    initialization_completed: true,
    runner_status: 'failed'
  });
});

test('resource E2E tracker classifies permission, download, attachment, prompt and persistence failures', () => {
  const permission = new ResourceE2eRunTracker();
  permission.onResourceInitializationStarted();
  assert.equal(permission.finish({ runnerStatus: 'failed', errorCode: 'RESOURCE_HOST_PERMISSION_REQUIRED' }).failure_stage, 'permission');

  const download = new ResourceE2eRunTracker();
  download.onResourceInitializationStarted();
  assert.equal(download.finish({ runnerStatus: 'failed', errorCode: 'RESOURCE_DOWNLOAD_FAILED' }).failure_stage, 'download');

  const attachment = new ResourceE2eRunTracker();
  attachment.onResourceInitializationStarted();
  attachment.onResourceDownloaded();
  assert.equal(attachment.finish({ runnerStatus: 'failed', errorCode: 'RESOURCE_UPLOAD_FAILED' }).failure_stage, 'attachment');

  const prompt = new ResourceE2eRunTracker();
  prompt.onResourceInitializationStarted();
  prompt.onResourceDownloaded();
  prompt.onResourceAttached();
  assert.equal(prompt.finish({ runnerStatus: 'context_limit', errorCode: 'CHAT_LENGTH_LIMIT' }).failure_stage, 'initialization_prompt');

  const persist = new ResourceE2eRunTracker();
  persist.onResourceInitializationStarted();
  persist.onResourceDownloaded();
  persist.onResourceAttached();
  persist.onResourceInitializationResponseReady();
  assert.equal(persist.finish({ runnerStatus: 'failed', errorCode: 'UNEXPECTED' }).failure_stage, 'initialization_persist');
});

test('resource E2E tracker emits no evidence for non-resource tasks and never infers recovery history', () => {
  const none = new ResourceE2eRunTracker();
  assert.equal(none.finish({ runnerStatus: 'completed' }), null);

  const recovered = new ResourceE2eRunTracker();
  recovered.onResourceInitializationStarted();
  recovered.onResourceDownloaded();
  assert.deepEqual(recovered.finish({ runnerStatus: 'recovery_blocked', recovered: true }), {
    result: 'incomplete',
    failure_stage: 'recovery',
    started: true,
    downloaded: true,
    attached: false,
    response_ready: false,
    initialization_completed: false,
    runner_status: 'recovery_blocked'
  });
});

test('resource E2E ledger stores only fixed safe fields, bounds recent runs and clears only its own key', async () => {
  const storage = memoryStorage({ keepMe: { ok: true } });
  let tick = 0;
  const ledger = new ResourceE2eEvidenceLedger({
    storage,
    maxRecentRuns: 2,
    now: () => new Date(`2026-08-14T01:00:0${tick++}.000Z`)
  });

  await ledger.record({
    ...completedTracker().finish({ runnerStatus: 'completed' }),
    task_id: 'secret-task',
    project_name: 'secret-project',
    resource_url: 'https://secret.example/source.zip',
    filename: 'secret.zip',
    base64: 'secret-bytes',
    token: 'secret-token',
    error_message: 'secret error text'
  });
  await ledger.record({
    result: 'failed', failure_stage: 'attachment', started: true, downloaded: true, attached: false,
    response_ready: false, initialization_completed: false, runner_status: 'failed'
  });
  await ledger.record({
    result: 'incomplete', failure_stage: 'recovery', started: true, downloaded: false, attached: false,
    response_ready: false, initialization_completed: false, runner_status: 'recovery_blocked'
  });

  const summary = await ledger.getSummary();
  assert.equal(summary.total_runs, 3);
  assert.equal(summary.passed_runs, 1);
  assert.equal(summary.failed_runs, 1);
  assert.equal(summary.incomplete_runs, 1);
  assert.equal(summary.recent_runs.length, 2);
  assert.deepEqual(Object.keys(summary.last_run).sort(), [
    'at','attached','downloaded','failure_stage','initialization_completed','response_ready','result','runner_status','started'
  ].sort());
  const serialized = JSON.stringify(summary);
  for (const forbidden of ['secret-task','secret-project','secret.example','secret.zip','secret-bytes','secret-token','secret error text']) {
    assert.equal(serialized.includes(forbidden), false);
  }

  await ledger.clear();
  assert.equal(await storage.get('resourceE2eEvidence'), undefined);
  assert.deepEqual(await storage.get('keepMe'), { ok: true });
});
