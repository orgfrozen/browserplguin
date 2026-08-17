import test from 'node:test';
import assert from 'node:assert/strict';
import { PatchSyncArtifactTransport } from '../src/background/patchsync-artifact-transport.js';

function downloadedPatch() {
  return {
    task_id: 'task-1',
    session_id: 'ps-20260817-abc123',
    filename: 'vetatool--ps-20260817-abc123--004-submit.patch',
    patch_key: 'vetatool--ps-20260817-abc123--004',
    local_path: '/tmp/patch.patch',
    download_id: 41,
    source_url: 'blob:https://chatgpt.com/patch'
  };
}

test('PatchSyncArtifactTransport reads the completed Chrome file then submits it with the active PatchSync client', async () => {
  const calls = [];
  const transport = new PatchSyncArtifactTransport({
    fileReader: {
      async read(artifact) {
        calls.push(['read', artifact.local_path]);
        return { ...artifact, content_base64: 'aGVsbG8=', size_bytes: 5, sha256: 'a'.repeat(64) };
      }
    }
  });
  const client = {
    async uploadPatch(artifact) {
      calls.push(['upload', artifact.filename, artifact.content_base64]);
      return {
        accepted: true, duplicate: false, project_id: 'vetatool', session_id: 'ps-20260817-abc123',
        sequence: 4, parent_sequence: 3, filename: artifact.filename, sha256: artifact.sha256, state: 'queued'
      };
    }
  };

  const result = await transport.upload(downloadedPatch(), {
    client,
    projectId: 'vetatool',
    patchSessionId: 'ps-20260817-abc123'
  });

  assert.deepEqual(calls, [
    ['read', '/tmp/patch.patch'],
    ['upload', 'vetatool--ps-20260817-abc123--004-submit.patch', 'aGVsbG8=']
  ]);
  assert.equal(result.receipt.state, 'queued');
  assert.equal(result.receipt.sequence, 4);
  assert.equal(result.artifact.filename, downloadedPatch().filename);
  assert.equal('content_base64' in result.artifact, false);
});

test('PatchSyncArtifactTransport rejects a receipt for another project or Patch Session', async () => {
  const transport = new PatchSyncArtifactTransport({
    fileReader: { async read(artifact) { return { ...artifact, content_base64: 'aGVsbG8=', size_bytes: 5, sha256: 'a'.repeat(64) }; } }
  });
  const client = {
    async uploadPatch(artifact) {
      return { accepted: true, project_id: 'other', session_id: 'ps-other', filename: artifact.filename, sha256: artifact.sha256, state: 'queued' };
    }
  };
  await assert.rejects(
    () => transport.upload(downloadedPatch(), { client, projectId: 'vetatool', patchSessionId: 'ps-20260817-abc123' }),
    /project/i
  );
});
