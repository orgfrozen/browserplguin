import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNativeHelperReadiness, getNativeHelperReadiness } from '../src/background/native-helper-readiness.js';
import { ERROR_CODES } from '../src/shared/errors.js';

function memoryStorage(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async get(key) { return values[key]; },
    async set(key, value) { values[key] = structuredClone(value); }
  };
}

test('readiness persists only privacy-safe host capability metadata', async () => {
  const storage = memoryStorage();
  const reader = {
    async checkReady() {
      return {
        status: 'ready',
        host_name: 'com.browserplguin.patch_reader',
        protocol_version: 1,
        capabilities: { read_patch_file: true, chunked: true, max_patch_bytes: 33554432 },
        local_path: '/Users/private/Downloads/secret.patch'
      };
    }
  };

  const result = await checkNativeHelperReadiness({ reader, storage, now: () => '2026-08-13T12:00:00.000Z' });

  assert.deepEqual(result, {
    status: 'ready',
    host_name: 'com.browserplguin.patch_reader',
    protocol_version: 1,
    capabilities: { read_patch_file: true, chunked: true, max_patch_bytes: 33554432 },
    checked_at: '2026-08-13T12:00:00.000Z'
  });
  assert.equal(JSON.stringify(storage.values).includes('/Users/private'), false);
});

test('readiness stores stable unavailable code without native error text or paths', async () => {
  const storage = memoryStorage();
  const reader = {
    async checkReady() {
      const error = new Error('Specified native messaging host not found at /Users/private/host.json');
      error.code = ERROR_CODES.NATIVE_HELPER_UNAVAILABLE;
      error.details = { native_error: 'secret local path' };
      throw error;
    }
  };

  const result = await checkNativeHelperReadiness({ reader, storage, now: () => '2026-08-13T12:01:00.000Z' });
  assert.deepEqual(result, {
    status: 'unavailable',
    error_code: ERROR_CODES.NATIVE_HELPER_UNAVAILABLE,
    checked_at: '2026-08-13T12:01:00.000Z'
  });
  assert.equal(JSON.stringify(storage.values).includes('Specified native'), false);
  assert.equal(JSON.stringify(storage.values).includes('/Users/private'), false);
  assert.deepEqual(await getNativeHelperReadiness(storage), result);
});

test('never checked readiness has an explicit non-error state', async () => {
  assert.deepEqual(await getNativeHelperReadiness(memoryStorage()), { status: 'never_checked' });
});
