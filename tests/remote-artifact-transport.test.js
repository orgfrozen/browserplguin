import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteArtifactTransport } from '../src/background/remote-artifact-transport.js';
import { ERROR_CODES } from '../src/shared/errors.js';

function artifact(overrides = {}) {
  return {
    task_id: 't1',
    session_id: 's1',
    filename: 'patch-s1-001.patch',
    patch_key: 'patch-s1-001.patch',
    content_type: 'text/x-diff',
    content_base64: 'aGVsbG8=',
    size_bytes: 5,
    ...overrides
  };
}

function taskApiUpload(sequence) {
  const calls = [];
  const queue = [...sequence];
  return {
    calls,
    async uploadArtifactContent(taskId, payload) {
      calls.push({ taskId, payload: structuredClone(payload) });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return structuredClone(next);
    }
  };
}

test('remote transport uploads validated Patch bytes and returns a safe receipt', async () => {
  const api = taskApiUpload([{
    artifact_id: 'remote-a1',
    filename: 'patch-s1-001.patch',
    size_bytes: 5,
    sha256: 'a'.repeat(64),
    remote_url: 'https://artifacts.example.com/a1?token=secret#frag'
  }]);
  const transport = new RemoteArtifactTransport({ taskApi: api, sleep: async () => {} });

  const receipt = await transport.upload(artifact());

  assert.deepEqual(api.calls, [{ taskId: 't1', payload: {
    session_id: 's1',
    filename: 'patch-s1-001.patch',
    patch_key: 'patch-s1-001.patch',
    content_type: 'text/x-diff',
    content_base64: 'aGVsbG8=',
    size_bytes: 5
  } }]);
  assert.deepEqual(receipt, {
    artifact_id: 'remote-a1',
    filename: 'patch-s1-001.patch',
    size_bytes: 5,
    sha256: 'a'.repeat(64)
  });
  assert.equal('content_base64' in receipt, false);
  assert.equal('remote_url' in receipt, false);
});

test('remote transport fails closed for missing or malformed Patch bytes and size mismatch', async () => {
  const api = taskApiUpload([]);
  const transport = new RemoteArtifactTransport({ taskApi: api, sleep: async () => {} });

  for (const bad of [
    artifact({ content_base64: null }),
    artifact({ content_base64: '%%%not-base64%%%' }),
    artifact({ size_bytes: 6 })
  ]) {
    await assert.rejects(
      () => transport.upload(bad),
      error => error.code === ERROR_CODES.REMOTE_ARTIFACT_UPLOAD_FAILED
    );
  }
  assert.equal(api.calls.length, 0);
});

test('remote transport retries network 429 and 5xx failures with the exact same payload', async () => {
  const network = new TypeError('network down');
  const throttled = Object.assign(new Error('429'), { status: 429 });
  const server = Object.assign(new Error('503'), { status: 503 });
  const api = taskApiUpload([
    network,
    throttled,
    server,
    { artifact_id: 'remote-a1', filename: 'patch-s1-001.patch', size_bytes: 5 }
  ]);
  const delays = [];
  const transport = new RemoteArtifactTransport({
    taskApi: api,
    maxAttempts: 4,
    baseDelayMs: 10,
    sleep: async ms => delays.push(ms)
  });

  const receipt = await transport.upload(artifact());

  assert.equal(receipt.artifact_id, 'remote-a1');
  assert.equal(api.calls.length, 4);
  assert.deepEqual(api.calls.map(call => call.payload), [api.calls[0].payload, api.calls[0].payload, api.calls[0].payload, api.calls[0].payload]);
  assert.deepEqual(delays, [10, 20, 40]);
});

test('remote transport does not retry non-transient HTTP failure', async () => {
  const badRequest = Object.assign(new Error('400'), { status: 400 });
  const api = taskApiUpload([badRequest]);
  const transport = new RemoteArtifactTransport({ taskApi: api, maxAttempts: 3, sleep: async () => {} });

  await assert.rejects(
    () => transport.upload(artifact()),
    error => error.code === ERROR_CODES.REMOTE_ARTIFACT_UPLOAD_FAILED && error.details?.attempts === 1
  );
  assert.equal(api.calls.length, 1);
});

test('remote transport rejects malformed or mismatched server receipt without retrying', async () => {
  for (const receipt of [
    {},
    { artifact_id: 'a1', filename: 'wrong.patch', size_bytes: 5 },
    { artifact_id: 'a1', filename: 'patch-s1-001.patch', size_bytes: 4 },
    { artifact_id: 'a1', filename: 'patch-s1-001.patch', size_bytes: 5, sha256: 'bad' }
  ]) {
    const api = taskApiUpload([receipt]);
    const transport = new RemoteArtifactTransport({ taskApi: api, maxAttempts: 3, sleep: async () => {} });
    await assert.rejects(
      () => transport.upload(artifact()),
      error => error.code === ERROR_CODES.REMOTE_ARTIFACT_UPLOAD_FAILED
    );
    assert.equal(api.calls.length, 1);
  }
});
