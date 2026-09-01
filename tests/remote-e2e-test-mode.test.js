import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enableRemoteE2eTestMode,
  disableRemoteE2eTestMode,
  assertRemoteE2eTestModeReady,
  buildSafeSettingsUpdate
} from '../src/background/remote-e2e-test-mode.js';

function memoryStorage(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(key) { return values[key]; },
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

function readyPreflight() {
  return {
    status: 'ready',
    ready_for_remote_e2e: true,
    checks: { mode_real: true, task_api_url_valid: true },
    blockers: [],
    checked_at: '2026-08-14T03:00:00.000Z'
  };
}

test('enableRemoteE2eTestMode requires a fresh ready preflight then atomically selects remote', async () => {
  const storage = memoryStorage({ settings: baseSettings });
  let calls = 0;
  const result = await enableRemoteE2eTestMode({
    settings: baseSettings,
    storage,
    runPreflight: async () => { calls += 1; return readyPreflight(); }
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, {
    status: 'enabled',
    enabled: true,
    patch_transfer_mode: 'remote',
    preflight: { status: 'ready', ready_for_remote_e2e: true, blockers: [], checked_at: '2026-08-14T03:00:00.000Z' }
  });
  assert.equal(storage.values.settings.remoteE2eTestMode, true);
  assert.equal(storage.values.settings.remoteProductionMode, false);
  assert.equal(storage.values.settings.patchTransferMode, 'remote');
  assert.equal(storage.values.settings.taskApiToken, 'secret-token');
  assert.equal(JSON.stringify(result).includes('secret-token'), false);
  assert.equal(JSON.stringify(result).includes('tasks.example.test'), false);
});

test('enableRemoteE2eTestMode stays local when live preflight is blocked', async () => {
  const storage = memoryStorage({ settings: baseSettings });
  const result = await enableRemoteE2eTestMode({
    settings: baseSettings,
    storage,
    runPreflight: async () => ({ status: 'blocked', ready_for_remote_e2e: false, blockers: ['NATIVE_HELPER_UNAVAILABLE'], checked_at: '2026-08-14T03:01:00.000Z' })
  });

  assert.deepEqual(result, {
    status: 'blocked',
    enabled: false,
    patch_transfer_mode: 'local',
    preflight: {
      status: 'blocked',
      ready_for_remote_e2e: false,
      blockers: ['NATIVE_HELPER_UNAVAILABLE'],
      checked_at: '2026-08-14T03:01:00.000Z'
    }
  });
  assert.equal(storage.values.settings.patchTransferMode, 'local');
  assert.equal(storage.values.settings.remoteE2eTestMode, false);
});

test('disableRemoteE2eTestMode atomically returns transfer mode to local', async () => {
  const storage = memoryStorage();
  const settings = { ...baseSettings, remoteE2eTestMode: true, patchTransferMode: 'remote' };
  const result = await disableRemoteE2eTestMode({ settings, storage });
  assert.deepEqual(result, { status: 'disabled', enabled: false, patch_transfer_mode: 'local' });
  assert.equal(storage.values.settings.remoteE2eTestMode, false);
  assert.equal(storage.values.settings.remoteProductionMode, false);
  assert.equal(storage.values.settings.patchTransferMode, 'local');
});

test('buildSafeSettingsUpdate prevents SAVE_SETTINGS from becoming an alternate remote enable path', () => {
  const current = { ...baseSettings, remoteE2eTestMode: false, remoteProductionMode: true, patchTransferMode: 'remote' };
  const next = buildSafeSettingsUpdate({
    defaults: { mode: 'mock', patchTransferMode: 'local', remoteE2eTestMode: false },
    current,
    incoming: { mode: 'real', patchTransferMode: 'remote', remoteE2eTestMode: true, remoteProductionMode: true, taskApiBaseUrl: 'https://new.example.test' }
  });
  assert.equal(next.remoteE2eTestMode, false);
  assert.equal(next.remoteProductionMode, false);
  assert.equal(next.patchTransferMode, 'local');
  assert.equal(next.taskApiBaseUrl, 'https://new.example.test');
});

test('assertRemoteE2eTestModeReady is a no-op for local transfer', async () => {
  let calls = 0;
  const result = await assertRemoteE2eTestModeReady({
    settings: baseSettings,
    runPreflight: async () => { calls += 1; return readyPreflight(); }
  });
  assert.deepEqual(result, { status: 'not_required' });
  assert.equal(calls, 0);
});

test('assertRemoteE2eTestModeReady refuses remote transfer without explicit test mode', async () => {
  await assert.rejects(
    assertRemoteE2eTestModeReady({
      settings: { ...baseSettings, patchTransferMode: 'remote', remoteE2eTestMode: false },
      runPreflight: async () => readyPreflight()
    }),
    error => {
      assert.equal(error.code, 'REMOTE_E2E_TEST_MODE_REQUIRED');
      return true;
    }
  );
});

test('assertRemoteE2eTestModeReady reruns live preflight and blocks stale remote readiness', async () => {
  let calls = 0;
  await assert.rejects(
    assertRemoteE2eTestModeReady({
      settings: { ...baseSettings, patchTransferMode: 'remote', remoteE2eTestMode: true },
      runPreflight: async () => {
        calls += 1;
        return { status: 'blocked', ready_for_remote_e2e: false, blockers: ['TASK_API_PERMISSION_MISSING'], checked_at: '2026-08-14T03:02:00.000Z' };
      }
    }),
    error => {
      assert.equal(error.code, 'REMOTE_E2E_PREFLIGHT_BLOCKED');
      assert.deepEqual(error.blockers, ['TASK_API_PERMISSION_MISSING']);
      assert.equal(error.message.includes('tasks.example.test'), false);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test('buildSafeSettingsUpdate normalizes maxParallelTasks into the supported 1..5 range', () => {
  const defaults = { maxParallelTasks: 1 };
  assert.equal(buildSafeSettingsUpdate({ defaults, incoming: { maxParallelTasks: 3 } }).maxParallelTasks, 3);
  assert.equal(buildSafeSettingsUpdate({ defaults, incoming: { maxParallelTasks: 0 } }).maxParallelTasks, 1);
  assert.equal(buildSafeSettingsUpdate({ defaults, incoming: { maxParallelTasks: 9 } }).maxParallelTasks, 5);
  assert.equal(buildSafeSettingsUpdate({ defaults, incoming: { maxParallelTasks: 'invalid' } }).maxParallelTasks, 1);
});

test('buildSafeSettingsUpdate normalizes interaction pacing and preserves zero as disabled', () => {
  const defaults = { maxParallelTasks: 1, interactionPacingMs: 350 };
  assert.equal(buildSafeSettingsUpdate({ defaults, incoming: { interactionPacingMs: 0 } }).interactionPacingMs, 0);
  assert.equal(buildSafeSettingsUpdate({ defaults, incoming: { interactionPacingMs: 600 } }).interactionPacingMs, 600);
  assert.equal(buildSafeSettingsUpdate({ defaults, incoming: { interactionPacingMs: -20 } }).interactionPacingMs, 0);
  assert.equal(buildSafeSettingsUpdate({ defaults, incoming: { interactionPacingMs: 99999 } }).interactionPacingMs, 5000);
  assert.equal(buildSafeSettingsUpdate({ defaults, incoming: { interactionPacingMs: 'bad' } }).interactionPacingMs, 350);
});
