import test from 'node:test';
import assert from 'node:assert/strict';
import { PatchSyncClient } from '../src/background/patchsync-client.js';
import { ERROR_CODES } from '../src/shared/errors.js';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return name.toLowerCase() === 'content-type' ? 'application/json' : null; } },
    async json() { return structuredClone(body); },
    async text() { return JSON.stringify(body); }
  };
}

function binaryResponse({ body = 'zip-bytes', filename = 'source.zip', contentType = 'application/zip' } = {}) {
  const bytes = new TextEncoder().encode(body);
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        const key = name.toLowerCase();
        if (key === 'content-type') return contentType;
        if (key === 'content-length') return String(bytes.length);
        if (key === 'content-disposition') return `attachment; filename="${filename}"`;
        return null;
      }
    },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    async text() { return body; }
  };
}

function grantedPermission() {
  const checked = [];
  return {
    checked,
    async assertGranted(url) { checked.push(url); return { originPattern: 'https://patchsync.example/*' }; }
  };
}


test('default PatchSync fetch keeps the WorkerGlobalScope receiver', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (url, init = {}) {
    assert.equal(this, globalThis);
    assert.equal(url, 'https://patchsync.example/v1/exports');
    assert.equal(init.headers.Authorization, 'PatchSync cap');
    return jsonResponse(202, { export_id: 'exp-default', project_id: 'vetatool', status: 'queued' });
  };
  try {
    const client = new PatchSyncClient({
      baseUrl: 'https://patchsync.example',
      accessToken: 'cap',
      permissionManager: grantedPermission()
    });
    const result = await client.createExport('vetatool');
    assert.equal(result.export_id, 'exp-default');
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('PatchSyncClient ensures project worker readiness before export', async () => {
  const calls = [];
  const client = new PatchSyncClient({
    baseUrl: 'https://patchsync.example',
    accessToken: 'cap',
    permissionManager: { async assertGranted(url) { calls.push({ permission: url }); } },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      return jsonResponse(200, {
        ready: true,
        project_id: 'vetatool',
        runtime_status: 'current',
        worker_status: 'running',
        worker_started: true,
        queue_paused: false
      });
    }
  });
  const result = await client.ensureReady('vetatool');
  assert.equal(result.ready, true);
  assert.equal(calls.at(-1).url, 'https://patchsync.example/v1/projects/vetatool/ensure-ready');
  assert.equal(calls.at(-1).init.method, 'POST');
  assert.equal(calls.at(-1).init.headers.Authorization, 'PatchSync cap');
});

test('PatchSyncClient classifies an operator-fixable readiness conflict separately', async () => {
  const client = new PatchSyncClient({
    baseUrl: 'https://patchsync.example',
    accessToken: 'cap',
    permissionManager: { async assertGranted() {} },
    fetchImpl: async () => jsonResponse(409, { error: 'project runtime is outdated: vetatool; run make install vetatool' })
  });
  await assert.rejects(
    () => client.ensureReady('vetatool'),
    error => error?.code === ERROR_CODES.PATCHSYNC_PROJECT_NOT_READY && error?.details?.status === 409
  );
});

test('PatchSyncClient classifies an explicit manual-stop readiness conflict separately', async () => {
  const client = new PatchSyncClient({
    baseUrl: 'https://patchsync.example',
    accessToken: 'cap',
    permissionManager: { async assertGranted() {} },
    fetchImpl: async () => jsonResponse(409, { error: 'project runtime was manually stopped: vetatool; run make start vetatool' })
  });
  await assert.rejects(
    () => client.ensureReady('vetatool'),
    error => error?.code === 'PATCHSYNC_MANUALLY_STOPPED'
      && error?.details?.status === 409
      && error?.details?.project_id === 'vetatool'
      && error?.details?.server_reason === 'project runtime was manually stopped: vetatool; run make start vetatool'
  );
});

test('PatchSyncClient leaves project-operation busy readiness conflicts retryable', async () => {
  const client = new PatchSyncClient({
    baseUrl: 'https://patchsync.example',
    accessToken: 'cap',
    permissionManager: { async assertGranted() {} },
    fetchImpl: async () => jsonResponse(409, { error: 'project operation is busy: vetatool' })
  });
  await assert.rejects(
    () => client.ensureReady('vetatool'),
    error => error?.code === ERROR_CODES.PATCHSYNC_HTTP_ERROR
      && error?.details?.status === 409
      && error?.details?.operation === 'ensure_ready'
      && error?.details?.server_reason === 'project operation is busy: vetatool'
  );
});

test('PatchSyncClient creates export with capability authorization and project id', async () => {
  const calls = [];
  const permissionManager = grantedPermission();
  const client = new PatchSyncClient({
    baseUrl: 'https://patchsync.example/',
    accessToken: 'v1.payload.signature',
    permissionManager,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(202, { export_id: 'exp-1', project_id: 'vetatool', status: 'queued' });
    }
  });

  const result = await client.createExport('vetatool');
  assert.equal(result.export_id, 'exp-1');
  assert.equal(calls[0].url, 'https://patchsync.example/v1/exports');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'PatchSync v1.payload.signature');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { project_id: 'vetatool' });
  assert.deepEqual(permissionManager.checked, ['https://patchsync.example/v1/exports']);
});

test('PatchSyncClient waits for the same export until succeeded without creating another export', async () => {
  const calls = [];
  const manifests = [
    { export_id: 'exp-1', project_id: 'vetatool', status: 'running', stage: 'exporting' },
    {
      export_id: 'exp-1', project_id: 'vetatool', status: 'succeeded', patch_session_id: 'ps-20260817-abc123',
      source: { filename: 'vetatool--ps-20260817-abc123--source.zip', download_url: '/exports/vetatool/ps-20260817-abc123/source.zip', sha256: 'abc', size_bytes: 123 },
      rules: { filename: 'LLM_RULES.md', download_url: '/exports/vetatool/ps-20260817-abc123/LLM_RULES.md', text: 'rules' }
    }
  ];
  const client = new PatchSyncClient({
    baseUrl: 'https://patchsync.example', accessToken: 'cap', permissionManager: grantedPermission(),
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, manifests.shift());
    }
  });

  const manifest = await client.waitForExport('exp-1', { pollIntervalMs: 1 });
  assert.equal(manifest.status, 'succeeded');
  assert.equal(manifest.patch_session_id, 'ps-20260817-abc123');
  assert.deepEqual(calls.map(call => call.url), [
    'https://patchsync.example/v1/exports/exp-1',
    'https://patchsync.example/v1/exports/exp-1'
  ]);
  assert.ok(calls.every(call => call.init.headers.Authorization === 'PatchSync cap'));
});

test('PatchSyncClient fails closed when export manifest reaches a terminal failure', async () => {
  const client = new PatchSyncClient({
    baseUrl: 'https://patchsync.example', accessToken: 'cap', permissionManager: grantedPermission(),
    fetchImpl: async () => jsonResponse(200, { export_id: 'exp-1', project_id: 'vetatool', status: 'failed', stage: 'exporting', error: 'make export failed' })
  });
  await assert.rejects(() => client.waitForExport('exp-1', { pollIntervalMs: 0 }), /make export failed/);
});

test('PatchSyncClient downloads source with capability auth and resolves relative manifest URL', async () => {
  const calls = [];
  const client = new PatchSyncClient({
    baseUrl: 'https://patchsync.example', accessToken: 'cap', permissionManager: grantedPermission(),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return binaryResponse({ filename: 'vetatool--source.zip' });
    }
  });
  const resource = await client.downloadSource({
    source: { filename: 'vetatool--source.zip', download_url: '/exports/vetatool/ps-a/vetatool--source.zip' }
  });
  assert.equal(resource.filename, 'vetatool--source.zip');
  assert.equal(resource.mimeType, 'application/zip');
  assert.equal(resource.sourceUrl, 'https://patchsync.example/exports/vetatool/ps-a/vetatool--source.zip');
  assert.equal(typeof resource.base64, 'string');
  assert.equal(calls[0].init.headers.Authorization, 'PatchSync cap');
});

test('PatchSyncClient uses manifest rules text without a second download and can fetch rules when text is absent', async () => {
  let fetchCount = 0;
  const client = new PatchSyncClient({
    baseUrl: 'https://patchsync.example', accessToken: 'cap', permissionManager: grantedPermission(),
    fetchImpl: async (_url, init) => {
      fetchCount += 1;
      assert.equal(init.headers.Authorization, 'PatchSync cap');
      return { ok: true, status: 200, async text() { return 'downloaded rules'; }, headers: { get() { return 'text/markdown'; } } };
    }
  });
  assert.deepEqual(await client.downloadRules({ rules: { filename: 'LLM_RULES.md', text: 'inline rules' } }), {
    filename: 'LLM_RULES.md', text: 'inline rules', sourceUrl: null
  });
  assert.equal(fetchCount, 0);
  const fetched = await client.downloadRules({ rules: { filename: 'LLM_RULES.md', download_url: '/exports/vetatool/ps-a/LLM_RULES.md' } });
  assert.equal(fetched.text, 'downloaded rules');
  assert.equal(fetched.sourceUrl, 'https://patchsync.example/exports/vetatool/ps-a/LLM_RULES.md');
  assert.equal(fetchCount, 1);
});


test('PatchSyncClient uploads Patch bytes as one multipart file with capability authorization', async () => {
  const calls = [];
  const client = new PatchSyncClient({
    baseUrl: 'https://patchsync.example', accessToken: 'cap', permissionManager: grantedPermission(),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(202, {
        accepted: true,
        duplicate: false,
        project_id: 'vetatool',
        session_id: 'ps-20260817-abc123',
        sequence: 4,
        parent_sequence: 3,
        filename: 'vetatool--ps-20260817-abc123--004-submit.patch',
        sha256: 'a'.repeat(64),
        state: 'queued'
      });
    }
  });

  const receipt = await client.uploadPatch({
    filename: 'vetatool--ps-20260817-abc123--004-submit.patch',
    content_base64: 'aGVsbG8=',
    size_bytes: 5,
    sha256: 'a'.repeat(64)
  });

  assert.equal(calls[0].url, 'https://patchsync.example/v1/patches');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'PatchSync cap');
  assert.equal(calls[0].init.headers['Content-Type'], undefined);
  assert.ok(calls[0].init.body instanceof FormData);
  const file = calls[0].init.body.get('file');
  assert.equal(file.name, 'vetatool--ps-20260817-abc123--004-submit.patch');
  assert.equal(await file.text(), 'hello');
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.sequence, 4);
  assert.equal(receipt.session_id, 'ps-20260817-abc123');
});

test('PatchSyncClient classifies unreachable API without leaking capability tokens', async () => {
  const client = new PatchSyncClient({
    baseUrl: 'http://127.0.0.1:8790',
    accessToken: 'secret-capability-token',
    permissionManager: { async assertGranted() {} },
    fetchImpl: async () => { throw new TypeError('Failed to fetch secret-capability-token'); }
  });

  await assert.rejects(
    () => client.ensureReady('vetatool'),
    error => {
      assert.equal(error?.code, ERROR_CODES.PATCHSYNC_UNREACHABLE);
      assert.equal(error?.details?.origin, 'http://127.0.0.1:8790');
      assert.equal(error?.details?.operation, 'ensure_ready');
      assert.match(error?.details?.cause ?? '', /\[redacted\]/);
      assert.equal(JSON.stringify(error).includes('secret-capability-token'), false);
      return true;
    }
  );
});

test('PatchSyncClient classifies auth failures and exposes only the server reason', async () => {
  const client = new PatchSyncClient({
    baseUrl: 'http://127.0.0.1:8790',
    accessToken: 'secret-capability-token',
    permissionManager: { async assertGranted() {} },
    fetchImpl: async () => jsonResponse(401, { error: 'unauthorized', token: 'secret-capability-token' })
  });

  await assert.rejects(
    () => client.createExport('vetatool'),
    error => {
      assert.equal(error?.code, ERROR_CODES.PATCHSYNC_AUTH_FAILED);
      assert.equal(error?.details?.status, 401);
      assert.equal(error?.details?.server_reason, 'unauthorized');
      assert.equal(error?.details?.operation, 'export_create');
      assert.equal(JSON.stringify(error).includes('secret-capability-token'), false);
      return true;
    }
  );
});

test('PatchSyncClient preserves HTTP status and safe server reason for retryable service errors', async () => {
  const client = new PatchSyncClient({
    baseUrl: 'http://127.0.0.1:8790',
    accessToken: 'cap',
    permissionManager: { async assertGranted() {} },
    fetchImpl: async () => jsonResponse(503, { error: 'worker temporarily unavailable' })
  });

  await assert.rejects(
    () => client.createExport('vetatool'),
    error => {
      assert.equal(error?.code, ERROR_CODES.PATCHSYNC_HTTP_ERROR);
      assert.equal(error?.details?.status, 503);
      assert.equal(error?.details?.server_reason, 'worker temporarily unavailable');
      assert.equal(error?.details?.operation, 'export_create');
      return true;
    }
  );
});

test('PatchSyncClient adaptively backs off unchanged export polling and resets after status changes', async () => {
  const manifests = [
    { export_id: 'exp-backoff', project_id: 'vetatool', status: 'running', stage: 'waiting_for_idle' },
    { export_id: 'exp-backoff', project_id: 'vetatool', status: 'running', stage: 'waiting_for_idle' },
    { export_id: 'exp-backoff', project_id: 'vetatool', status: 'running', stage: 'waiting_for_idle' },
    { export_id: 'exp-backoff', project_id: 'vetatool', status: 'running', stage: 'waiting_for_idle' },
    { export_id: 'exp-backoff', project_id: 'vetatool', status: 'running', stage: 'waiting_for_idle' },
    { export_id: 'exp-backoff', project_id: 'vetatool', status: 'running', stage: 'waiting_for_idle' },
    { export_id: 'exp-backoff', project_id: 'vetatool', status: 'running', stage: 'exporting' },
    { export_id: 'exp-backoff', project_id: 'vetatool', status: 'running', stage: 'exporting' },
    {
      export_id: 'exp-backoff', project_id: 'vetatool', status: 'succeeded', stage: 'succeeded', patch_session_id: 'ps-backoff',
      source: { filename: 'source.zip', download_url: '/exports/vetatool/ps-backoff/source.zip' },
      rules: { filename: 'LLM_RULES.md', text: 'rules' }
    }
  ];
  const sleeps = [];
  const observed = [];
  const client = new PatchSyncClient({
    baseUrl: 'https://patchsync.example', accessToken: 'cap', permissionManager: grantedPermission(),
    sleep: async delayMs => { sleeps.push(delayMs); },
    fetchImpl: async () => jsonResponse(200, manifests.shift())
  });

  const manifest = await client.waitForExport('exp-backoff', {
    onStatus: async status => observed.push(status)
  });

  assert.equal(manifest.status, 'succeeded');
  assert.deepEqual(sleeps, [2000, 3000, 5000, 8000, 10000, 10000, 2000, 3000]);
  assert.deepEqual(observed.map(item => [item.status, item.stage]), [
    ['running', 'waiting_for_idle'],
    ['running', 'exporting'],
    ['succeeded', 'succeeded']
  ]);
});

test('PatchSyncClient reports waiting-for-idle blocker changes without polling on wait-duration changes alone', async () => {
  const manifests = [
    {
      export_id: 'exp-blocked', project_id: 'vetatool', status: 'running', stage: 'waiting_for_idle',
      wait_started_at: '2026-09-05T12:00:00Z', wait_duration: 9,
      blocking_project: 'vetatool', blocking_pid: 4242, blocking_phase: 'repairing session state 37/200 ps-test', blocking_reason: 'worker_busy'
    },
    {
      export_id: 'exp-blocked', project_id: 'vetatool', status: 'running', stage: 'waiting_for_idle',
      wait_started_at: '2026-09-05T12:00:00Z', wait_duration: 10,
      blocking_project: 'vetatool', blocking_pid: 4242, blocking_phase: 'repairing session state 37/200 ps-test', blocking_reason: 'worker_busy'
    },
    {
      export_id: 'exp-blocked', project_id: 'vetatool', status: 'running', stage: 'waiting_for_idle',
      wait_started_at: '2026-09-05T12:00:00Z', wait_duration: 11,
      blocking_project: 'vetatool', blocking_pid: 4242, blocking_phase: 'repairing session state 38/200 ps-next', blocking_reason: 'worker_busy'
    },
    {
      export_id: 'exp-blocked', project_id: 'vetatool', status: 'succeeded', stage: 'succeeded', patch_session_id: 'ps-blocked',
      source: { filename: 'source.zip', download_url: '/exports/vetatool/ps-blocked/source.zip' },
      rules: { filename: 'LLM_RULES.md', text: 'rules' }
    }
  ];
  const observed = [];
  const client = new PatchSyncClient({
    baseUrl: 'https://patchsync.example', accessToken: 'cap', permissionManager: grantedPermission(),
    sleep: async () => {},
    fetchImpl: async () => jsonResponse(200, manifests.shift())
  });

  const manifest = await client.waitForExport('exp-blocked', {
    pollIntervalMs: 0,
    onStatus: async status => observed.push(status)
  });

  assert.equal(manifest.status, 'succeeded');
  assert.equal(observed.length, 3);
  assert.deepEqual(observed[0], {
    export_id: 'exp-blocked', status: 'running', stage: 'waiting_for_idle',
    wait_started_at: '2026-09-05T12:00:00Z', wait_duration: 9,
    blocking_project: 'vetatool', blocking_pid: 4242, blocking_phase: 'repairing session state 37/200 ps-test', blocking_reason: 'worker_busy'
  });
  assert.equal(observed[1].blocking_phase, 'repairing session state 38/200 ps-next');
  assert.deepEqual(observed[2], { export_id: 'exp-blocked', status: 'succeeded', stage: 'succeeded' });
});

test('PatchSyncClient reports export status changes without increasing polling frequency', async () => {
  const manifests = [
    { export_id: 'exp-observe', project_id: 'vetatool', status: 'running', stage: 'waiting_for_idle' },
    { export_id: 'exp-observe', project_id: 'vetatool', status: 'running', stage: 'waiting_for_idle' },
    { export_id: 'exp-observe', project_id: 'vetatool', status: 'running', stage: 'exporting' },
    {
      export_id: 'exp-observe', project_id: 'vetatool', status: 'succeeded', stage: 'succeeded', patch_session_id: 'ps-observe',
      source: { filename: 'source.zip', download_url: '/exports/vetatool/ps-observe/source.zip' },
      rules: { filename: 'LLM_RULES.md', text: 'rules' }
    }
  ];
  const observed = [];
  let sleeps = 0;
  const client = new PatchSyncClient({
    baseUrl: 'https://patchsync.example', accessToken: 'cap', permissionManager: grantedPermission(),
    sleep: async () => { sleeps += 1; },
    fetchImpl: async () => jsonResponse(200, manifests.shift())
  });

  const manifest = await client.waitForExport('exp-observe', {
    pollIntervalMs: 1,
    onStatus: async status => observed.push(status)
  });

  assert.equal(manifest.status, 'succeeded');
  assert.equal(sleeps, 3);
  assert.deepEqual(observed.map(item => [item.status, item.stage]), [
    ['running', 'waiting_for_idle'],
    ['running', 'exporting'],
    ['succeeded', 'succeeded']
  ]);
});
