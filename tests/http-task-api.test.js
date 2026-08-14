import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpTaskApi } from '../src/background/task-api.js';

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return structuredClone(body); },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); }
  };
}

function fetchRecorder(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init: structuredClone(init) });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return next;
  };
  return { calls, fetchImpl };
}

const task = { task_id: 't1', project_id: 'vetatool', task_prompt: 'fix' };
const lease = { token: 'lease-abc', ttl_ms: 90000, expires_at: '2026-08-13T10:00:00Z' };

test('claim requires task plus lease and stores lease metadata for the claimed task', async () => {
  const http = fetchRecorder([jsonResponse(200, { task, lease })]);
  const api = new HttpTaskApi({ baseUrl: 'https://tasks.example.com/', token: 'runner-token', fetchImpl: http.fetchImpl });

  assert.deepEqual(await api.claimTask(), task);
  assert.deepEqual(api.getLease('t1'), lease);
  assert.equal(http.calls[0].url, 'https://tasks.example.com/tasks/claim');
  assert.equal(http.calls[0].init.headers.Authorization, 'Bearer runner-token');
  assert.equal(http.calls[0].init.headers['X-Task-Protocol-Version'], '1');
});

test('claim rejects a successful response without a usable lease token and ttl', async () => {
  const missingToken = fetchRecorder([jsonResponse(200, { task, lease: { ttl_ms: 90000 } })]);
  const api1 = new HttpTaskApi({ baseUrl: 'https://tasks.example.com', fetchImpl: missingToken.fetchImpl });
  await assert.rejects(() => api1.claimTask(), /lease\.token/);

  const invalidTtl = fetchRecorder([jsonResponse(200, { task, lease: { token: 'lease-abc', ttl_ms: 0 } })]);
  const api2 = new HttpTaskApi({ baseUrl: 'https://tasks.example.com', fetchImpl: invalidTtl.fetchImpl });
  await assert.rejects(() => api2.claimTask(), /lease\.ttl_ms/);
});

test('task-scoped writes carry lease token and stable idempotency keys', async () => {
  const http = fetchRecorder([
    jsonResponse(200, { task, lease }),
    jsonResponse(204, null),
    jsonResponse(204, null)
  ]);
  const api = new HttpTaskApi({ baseUrl: 'https://tasks.example.com', fetchImpl: http.fetchImpl });
  await api.claimTask();

  const event = { type: 'ROUND_COMPLETED', task_round_count: 1 };
  await api.reportProgress('t1', event);
  await api.reportProgress('t1', event);

  const first = http.calls[1].init.headers;
  const second = http.calls[2].init.headers;
  assert.equal(first['X-Task-Lease-Token'], 'lease-abc');
  assert.equal(first['Idempotency-Key'], second['Idempotency-Key']);
  assert.match(first['Idempotency-Key'], /^browserplguin:t1:/);
});


test('idempotency key is stable for semantically identical payloads with different key order', async () => {
  const http = fetchRecorder([
    jsonResponse(200, { task, lease }),
    jsonResponse(204, null),
    jsonResponse(204, null)
  ]);
  const api = new HttpTaskApi({ baseUrl: 'https://tasks.example.com', fetchImpl: http.fetchImpl });
  await api.claimTask();

  await api.reportProgress('t1', { type: 'ROUND_COMPLETED', task_round_count: 1, task_patch_count: 2 });
  await api.reportProgress('t1', { task_patch_count: 2, task_round_count: 1, type: 'ROUND_COMPLETED' });

  assert.equal(http.calls[1].init.headers['Idempotency-Key'], http.calls[2].init.headers['Idempotency-Key']);
});

test('heartbeat refreshes lease metadata and terminal success clears the lease', async () => {
  const refreshed = { token: 'lease-def', ttl_ms: 60000, expires_at: '2026-08-13T10:01:00Z' };
  const http = fetchRecorder([
    jsonResponse(200, { task, lease }),
    jsonResponse(200, { lease: refreshed }),
    jsonResponse(204, null)
  ]);
  const api = new HttpTaskApi({ baseUrl: 'https://tasks.example.com', fetchImpl: http.fetchImpl });
  await api.claimTask();

  await api.heartbeatTask('t1');
  assert.deepEqual(api.getLease('t1'), refreshed);
  assert.equal(http.calls[1].init.headers['X-Task-Lease-Token'], 'lease-abc');

  await api.completeTask('t1', { terminal_status: 'success' });
  assert.equal(api.getLease('t1'), null);
  assert.equal(http.calls[2].init.headers['X-Task-Lease-Token'], 'lease-def');
});

test('claim returns null on 204 without creating a lease', async () => {
  const http = fetchRecorder([jsonResponse(204, null)]);
  const api = new HttpTaskApi({ baseUrl: 'https://tasks.example.com', fetchImpl: http.fetchImpl });
  assert.equal(await api.claimTask(), null);
});

test('persisted lease can be restored after service worker restart before heartbeat validation', () => {
  const api = new HttpTaskApi({ baseUrl: 'https://tasks.example.com', fetchImpl: async () => { throw new Error('not used'); } });
  assert.deepEqual(api.restoreLease('t1', lease), lease);
  assert.deepEqual(api.getLease('t1'), lease);
  assert.throws(() => api.restoreLease('t1', { token: '', ttl_ms: 90000 }), /lease\.token/);
});

test('remote artifact content upload carries lease and stable idempotency key', async () => {
  const receipt = { artifact_id: 'artifact-1', filename: 'patch-s1-001.patch', size_bytes: 5 };
  const http = fetchRecorder([
    jsonResponse(200, { task, lease }),
    jsonResponse(200, receipt),
    jsonResponse(200, receipt)
  ]);
  const api = new HttpTaskApi({ baseUrl: 'https://tasks.example.com', fetchImpl: http.fetchImpl });
  await api.claimTask();

  const payloadA = {
    session_id: 's1',
    filename: 'patch-s1-001.patch',
    patch_key: 'patch-s1-001.patch',
    content_type: 'text/x-diff',
    content_base64: 'aGVsbG8=',
    size_bytes: 5
  };
  const payloadB = {
    size_bytes: 5,
    content_base64: 'aGVsbG8=',
    patch_key: 'patch-s1-001.patch',
    filename: 'patch-s1-001.patch',
    session_id: 's1',
    content_type: 'text/x-diff'
  };

  assert.deepEqual(await api.uploadArtifactContent('t1', payloadA), receipt);
  assert.deepEqual(await api.uploadArtifactContent('t1', payloadB), receipt);

  assert.equal(http.calls[1].url, 'https://tasks.example.com/tasks/t1/artifacts/upload');
  assert.equal(http.calls[1].init.headers['X-Task-Lease-Token'], 'lease-abc');
  assert.equal(http.calls[1].init.headers['X-Task-Protocol-Version'], '1');
  assert.equal(http.calls[1].init.headers['Idempotency-Key'], http.calls[2].init.headers['Idempotency-Key']);
});


test('Task API HTTP failures preserve status for remote retry classification', async () => {
  const http = fetchRecorder([
    jsonResponse(200, { task, lease }),
    jsonResponse(503, { error: 'busy' })
  ]);
  const api = new HttpTaskApi({ baseUrl: 'https://tasks.example.com', fetchImpl: http.fetchImpl });
  await api.claimTask();
  await assert.rejects(
    () => api.uploadArtifactContent('t1', {
      session_id: 's1', filename: 'patch-s1-001.patch', patch_key: 'patch-s1-001.patch',
      content_type: 'text/x-diff', content_base64: 'aGVsbG8=', size_bytes: 5
    }),
    error => error.status === 503
  );
});


test('context limit terminal uses a dedicated lease-scoped idempotent endpoint and clears lease only on success', async () => {
  const http = fetchRecorder([
    jsonResponse(200, { task, lease }),
    jsonResponse(204, null)
  ]);
  const api = new HttpTaskApi({ baseUrl: 'https://tasks.example.com', fetchImpl: http.fetchImpl });
  await api.claimTask();
  const payload = {
    terminal_status: 'context_limit',
    code: 'CHAT_LENGTH_LIMIT',
    task_patch_count: 21,
    task_round_count: 18,
    session_id: 's1',
    project_name: 'vetatool-s1',
    patch_goal: { minimum: 30 }
  };

  await api.contextLimitTask('t1', payload);

  assert.equal(http.calls[1].url, 'https://tasks.example.com/tasks/t1/context-limit');
  assert.equal(http.calls[1].init.headers['X-Task-Lease-Token'], 'lease-abc');
  assert.match(http.calls[1].init.headers['Idempotency-Key'], /^browserplguin:t1:/);
  assert.equal(api.getLease('t1'), null);
});


test('context limit terminal failure keeps the lease for exact retry', async () => {
  const http = fetchRecorder([
    jsonResponse(200, { task, lease }),
    jsonResponse(503, { error: 'busy' })
  ]);
  const api = new HttpTaskApi({ baseUrl: 'https://tasks.example.com', fetchImpl: http.fetchImpl });
  await api.claimTask();
  await assert.rejects(() => api.contextLimitTask('t1', {
    terminal_status: 'context_limit', code: 'CHAT_LENGTH_LIMIT', task_patch_count: 0, task_round_count: 0,
    session_id: 's1', project_name: 'vetatool-s1', patch_goal: null
  }), error => error.status === 503);
  assert.deepEqual(api.getLease('t1'), lease);
});
