import test from 'node:test';
import assert from 'node:assert/strict';
import { PatchSyncClient } from '../src/background/patchsync-client.js';

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
