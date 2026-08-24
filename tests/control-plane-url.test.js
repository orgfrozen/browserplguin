import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeControlPlaneUrl, CANONICAL_CONTROL_PLANE_URL } from '../src/shared/control-plane-url.js';

test('control-plane URL migrates the retired workers.dev hostname', () => {
  assert.equal(CANONICAL_CONTROL_PLANE_URL, 'https://patchsyncstatus.zyhfronzen.com');
  assert.equal(normalizeControlPlaneUrl('https://patchsync-status.zyhfrozen.workers.dev'), CANONICAL_CONTROL_PLANE_URL);
  assert.equal(normalizeControlPlaneUrl('https://patchsync-status.zyhfrozen.workers.dev/'), CANONICAL_CONTROL_PLANE_URL);
  assert.equal(normalizeControlPlaneUrl('https://other.example.test/api'), 'https://other.example.test/api');
});
