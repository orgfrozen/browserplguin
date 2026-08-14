import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRemoteProductionStatus,
  enableRemoteProductionMode,
  disableRemoteProductionMode,
  assertRemoteProductionReady
} from '../src/background/remote-production-mode.js';

function memoryStorage(seed = {}) {
  const values = structuredClone(seed);
  return {
    values,
    async set(key, value) { values[key] = structuredClone(value); }
  };
}

const baseSettings = Object.freeze({
  mode: 'real',
  taskApiBaseUrl: 'https://tasks.example.test/api',
  taskApiToken: 'secret-token',
  patchTransferMode: 'local',
  remoteE2eTestMode: false,
  remoteProductionMode: false
});

const ready = () => ({
  status: 'ready',
  ready_for_remote_e2e: true,
  blockers: [],
  checked_at: '2026-08-14T04:00:00.000Z'
});

test('production status is eligible only after at least one passed real E2E evidence run', () => {
  assert.deepEqual(buildRemoteProductionStatus({ settings: baseSettings, evidenceSummary: { total_runs: 3, passed_runs: 0 } }), {
    enabled: false,
    eligible_evidence: false,
    passed_runs: 0,
    patch_transfer_mode: 'local'
  });
  assert.deepEqual(buildRemoteProductionStatus({ settings: baseSettings, evidenceSummary: { total_runs: 3, passed_runs: 1 } }), {
    enabled: false,
    eligible_evidence: true,
    passed_runs: 1,
    patch_transfer_mode: 'local'
  });
});

test('explicit production promotion requires evidence plus a fresh ready preflight and makes flags mutually exclusive', async () => {
  const storage = memoryStorage({ settings: baseSettings });
  let preflightCalls = 0;
  const result = await enableRemoteProductionMode({
    settings: { ...baseSettings, remoteE2eTestMode: true, patchTransferMode: 'remote' },
    evidenceSummary: { total_runs: 2, passed_runs: 1 },
    storage,
    runPreflight: async () => { preflightCalls += 1; return ready(); }
  });
  assert.equal(preflightCalls, 1);
  assert.deepEqual(result, {
    status: 'enabled', enabled: true, eligible_evidence: true, passed_runs: 1,
    patch_transfer_mode: 'remote', preflight: ready()
  });
  assert.equal(storage.values.settings.remoteProductionMode, true);
  assert.equal(storage.values.settings.remoteE2eTestMode, false);
  assert.equal(storage.values.settings.patchTransferMode, 'remote');
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal(serialized.includes('tasks.example.test'), false);
});

test('promotion is blocked without passed evidence and does not run preflight or mutate settings', async () => {
  const storage = memoryStorage({ settings: baseSettings });
  let preflightCalls = 0;
  const result = await enableRemoteProductionMode({
    settings: baseSettings,
    evidenceSummary: { total_runs: 4, passed_runs: 0 },
    storage,
    runPreflight: async () => { preflightCalls += 1; return ready(); }
  });
  assert.equal(preflightCalls, 0);
  assert.deepEqual(result, {
    status: 'blocked', enabled: false, eligible_evidence: false, passed_runs: 0,
    patch_transfer_mode: 'local', blockers: ['REMOTE_E2E_EVIDENCE_REQUIRED']
  });
  assert.deepEqual(storage.values.settings, baseSettings);
});

test('promotion is blocked by live preflight without mutating settings', async () => {
  const storage = memoryStorage({ settings: baseSettings });
  const result = await enableRemoteProductionMode({
    settings: baseSettings,
    evidenceSummary: { total_runs: 2, passed_runs: 1 },
    storage,
    runPreflight: async () => ({ status: 'blocked', ready_for_remote_e2e: false, blockers: ['NATIVE_HELPER_UNAVAILABLE'], checked_at: '2026-08-14T04:01:00.000Z' })
  });
  assert.deepEqual(result, {
    status: 'blocked', enabled: false, eligible_evidence: true, passed_runs: 1,
    patch_transfer_mode: 'local', blockers: ['NATIVE_HELPER_UNAVAILABLE']
  });
  assert.deepEqual(storage.values.settings, baseSettings);
});

test('production demotion atomically returns both remote flags to local', async () => {
  const storage = memoryStorage();
  const settings = { ...baseSettings, remoteProductionMode: true, patchTransferMode: 'remote' };
  const result = await disableRemoteProductionMode({ settings, storage });
  assert.deepEqual(result, { status: 'disabled', enabled: false, patch_transfer_mode: 'local' });
  assert.equal(storage.values.settings.remoteProductionMode, false);
  assert.equal(storage.values.settings.remoteE2eTestMode, false);
  assert.equal(storage.values.settings.patchTransferMode, 'local');
});

test('production pre-claim guard requires evidence to still exist before running preflight', async () => {
  let calls = 0;
  await assert.rejects(
    assertRemoteProductionReady({
      settings: { ...baseSettings, remoteProductionMode: true, patchTransferMode: 'remote' },
      evidenceSummary: { total_runs: 0, passed_runs: 0 },
      runPreflight: async () => { calls += 1; return ready(); }
    }),
    error => error.code === 'REMOTE_PRODUCTION_EVIDENCE_REQUIRED'
  );
  assert.equal(calls, 0);
});

test('production pre-claim guard reruns live preflight and rejects conflicting test flag', async () => {
  await assert.rejects(
    assertRemoteProductionReady({
      settings: { ...baseSettings, remoteProductionMode: true, remoteE2eTestMode: true, patchTransferMode: 'remote' },
      evidenceSummary: { passed_runs: 1 },
      runPreflight: async () => ready()
    }),
    error => error.code === 'REMOTE_MODE_CONFLICT'
  );

  let calls = 0;
  await assert.rejects(
    assertRemoteProductionReady({
      settings: { ...baseSettings, remoteProductionMode: true, patchTransferMode: 'remote' },
      evidenceSummary: { passed_runs: 2 },
      runPreflight: async () => {
        calls += 1;
        return { status: 'blocked', ready_for_remote_e2e: false, blockers: ['TASK_API_PERMISSION_MISSING'], checked_at: '2026-08-14T04:02:00.000Z' };
      }
    }),
    error => error.code === 'REMOTE_PRODUCTION_PREFLIGHT_BLOCKED' && error.blockers[0] === 'TASK_API_PERMISSION_MISSING'
  );
  assert.equal(calls, 1);
});
