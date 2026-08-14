import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceHostPermissionManager, resourceOriginPattern } from '../src/background/resource-host-permission.js';
import { RunnerError, ERROR_CODES } from '../src/shared/errors.js';

test('resource origin pattern keeps only exact http(s) scheme and host', () => {
  assert.equal(resourceOriginPattern('https://assets.example.com/build/source.zip?sig=secret#part'), 'https://assets.example.com/*');
  assert.equal(resourceOriginPattern('http://localhost:8080/a.zip'), 'http://localhost:8080/*');
});

test('resource origin pattern rejects unsupported schemes and embedded credentials', () => {
  for (const url of [
    'ftp://assets.example.com/source.zip',
    'file:///tmp/source.zip',
    'https://user:pass@assets.example.com/source.zip',
    'not-a-url'
  ]) {
    assert.throws(() => resourceOriginPattern(url), error => error instanceof RunnerError && error.code === ERROR_CODES.RESOURCE_HOST_PERMISSION_REQUIRED);
  }
});

test('permission manager checks only the normalized origin pattern', async () => {
  const calls = [];
  const manager = new ResourceHostPermissionManager({
    permissions: { async contains(value) { calls.push(value); return true; } }
  });
  const result = await manager.assertGranted('https://assets.example.com/private/source.zip?token=secret');
  assert.deepEqual(result, { originPattern: 'https://assets.example.com/*' });
  assert.deepEqual(calls, [{ origins: ['https://assets.example.com/*'] }]);
});

test('missing or failed permission check fails closed without leaking resource URL or raw error', async () => {
  const secretUrl = 'https://assets.example.com/private/source.zip?token=super-secret';
  for (const permissions of [
    { async contains() { return false; } },
    { async contains() { throw new Error('browser backend leaked-token-123'); } },
    null
  ]) {
    const manager = new ResourceHostPermissionManager({ permissions });
    await assert.rejects(manager.assertGranted(secretUrl), error => {
      assert.ok(error instanceof RunnerError);
      assert.equal(error.code, ERROR_CODES.RESOURCE_HOST_PERMISSION_REQUIRED);
      assert.equal(error.details?.originPattern, 'https://assets.example.com/*');
      const serialized = JSON.stringify(error).toLowerCase();
      assert.equal(serialized.includes('super-secret'), false);
      assert.equal(serialized.includes('leaked-token-123'), false);
      assert.equal(serialized.includes('/private/source.zip'), false);
      return true;
    });
  }
});
