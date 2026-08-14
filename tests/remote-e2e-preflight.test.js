import test from 'node:test';
import assert from 'node:assert/strict';
import { runRemoteE2ePreflight, getRemoteE2ePreflight, REMOTE_E2E_BLOCKERS } from '../src/background/remote-e2e-preflight.js';

function memoryStorage(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(key) { return values[key]; },
    async set(key, value) { values[key] = structuredClone(value); }
  };
}

function readyReader(overrides = {}) {
  return {
    async checkReady() {
      return {
        status: 'ready',
        host_name: 'com.browserplguin.patch_reader',
        protocol_version: 1,
        capabilities: {
          read_patch_file: true,
          chunked: true,
          max_patch_bytes: 32 * 1024 * 1024
        },
        ...overrides
      };
    }
  };
}

function permissions(granted = true) {
  return {
    calls: [],
    async contains(request) {
      this.calls.push(request);
      return granted;
    }
  };
}

const manifest = { permissions: ['storage', 'nativeMessaging'] };
const realSettings = { mode: 'real', taskApiBaseUrl: 'https://tasks.example.test/api', taskApiToken: 'secret-token' };

test('remote E2E preflight is ready only when every safe prerequisite is satisfied', async () => {
  const storage = memoryStorage();
  const chromePermissions = permissions(true);
  const result = await runRemoteE2ePreflight({
    settings: realSettings,
    permissions: chromePermissions,
    manifest,
    reader: readyReader(),
    storage,
    now: () => '2026-08-14T03:00:00.000Z'
  });

  assert.equal(result.ready_for_remote_e2e, true);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.checks, {
    mode_real: true,
    task_api_url_valid: true,
    task_api_permission: true,
    native_messaging_permission: true,
    native_helper: 'ready',
    helper_read_patch_file: true,
    helper_chunked: true,
    helper_max_patch_bytes_sufficient: true
  });
  assert.deepEqual(chromePermissions.calls, [{ origins: ['https://tasks.example.test/*'] }]);
  assert.deepEqual(await getRemoteE2ePreflight(storage), result);
  const serialized = JSON.stringify(storage.values);
  assert.equal(serialized.includes('tasks.example.test'), false);
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal(serialized.includes('com.browserplguin.patch_reader'), false);
});

test('preflight reports stable blockers for mode, URL, permission and manifest failures in one pass', async () => {
  let helperCalls = 0;
  const result = await runRemoteE2ePreflight({
    settings: { mode: 'mock', taskApiBaseUrl: 'file:///private/tasks?token=secret' },
    permissions: permissions(false),
    manifest: { permissions: ['storage'] },
    reader: { async checkReady() { helperCalls += 1; return readyReader().checkReady(); } },
    storage: memoryStorage(),
    now: () => '2026-08-14T03:01:00.000Z'
  });

  assert.equal(result.ready_for_remote_e2e, false);
  assert.equal(result.status, 'blocked');
  assert.equal(helperCalls, 1);
  assert.deepEqual(result.blockers, [
    REMOTE_E2E_BLOCKERS.MODE_NOT_REAL,
    REMOTE_E2E_BLOCKERS.TASK_API_URL_INVALID,
    REMOTE_E2E_BLOCKERS.TASK_API_PERMISSION_MISSING,
    REMOTE_E2E_BLOCKERS.NATIVE_MESSAGING_PERMISSION_MISSING
  ]);
});

test('preflight reports unavailable helper with a stable code and no native error text', async () => {
  const storage = memoryStorage();
  const reader = {
    async checkReady() {
      const error = new Error('native host missing at /Users/private/host.json');
      error.code = 'NATIVE_HELPER_UNAVAILABLE';
      throw error;
    }
  };
  const result = await runRemoteE2ePreflight({
    settings: realSettings,
    permissions: permissions(true),
    manifest,
    reader,
    storage,
    now: () => '2026-08-14T03:02:00.000Z'
  });

  assert.equal(result.ready_for_remote_e2e, false);
  assert.equal(result.checks.native_helper, 'unavailable');
  assert.deepEqual(result.blockers, [REMOTE_E2E_BLOCKERS.NATIVE_HELPER_UNAVAILABLE]);
  assert.equal(JSON.stringify(storage.values).includes('/Users/private'), false);
  assert.equal(JSON.stringify(storage.values).includes('native host missing'), false);
});

test('preflight blocks helper capability mismatches including max Patch size below 32 MiB', async () => {
  const reader = readyReader({
    capabilities: { read_patch_file: false, chunked: false, max_patch_bytes: 1024 * 1024 }
  });
  const result = await runRemoteE2ePreflight({
    settings: realSettings,
    permissions: permissions(true),
    manifest,
    reader,
    storage: memoryStorage()
  });

  assert.equal(result.ready_for_remote_e2e, false);
  assert.deepEqual(result.blockers, [
    REMOTE_E2E_BLOCKERS.HELPER_READ_PATCH_FILE_MISSING,
    REMOTE_E2E_BLOCKERS.HELPER_CHUNKED_MISSING,
    REMOTE_E2E_BLOCKERS.HELPER_MAX_PATCH_BYTES_INSUFFICIENT
  ]);
});


test('preflight fails closed when permission inspection throws without persisting browser error text', async () => {
  const storage = memoryStorage();
  const result = await runRemoteE2ePreflight({
    settings: realSettings,
    permissions: { async contains() { throw new Error('permission backend leaked secret text'); } },
    manifest,
    reader: readyReader(),
    storage,
    now: () => '2026-08-14T03:03:00.000Z'
  });

  assert.equal(result.ready_for_remote_e2e, false);
  assert.equal(result.checks.task_api_permission, false);
  assert.deepEqual(result.blockers, [REMOTE_E2E_BLOCKERS.TASK_API_PERMISSION_MISSING]);
  assert.equal(JSON.stringify(storage.values).includes('permission backend leaked'), false);
});

test('never checked preflight has an explicit state', async () => {
  assert.deepEqual(await getRemoteE2ePreflight(memoryStorage()), { status: 'never_checked', ready_for_remote_e2e: false, blockers: [] });
});
