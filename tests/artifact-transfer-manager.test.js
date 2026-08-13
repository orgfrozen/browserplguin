import test from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactTransferManager } from '../src/background/artifact-transfer-manager.js';
import { ERROR_CODES } from '../src/shared/errors.js';

function completedArtifact(overrides = {}) {
  return {
    task_id: 't1',
    session_id: 's1',
    download_id: 41,
    filename: 'patch-s1-001.patch',
    local_path: '/Users/test/Downloads/patch-s1-001.patch',
    source_url: 'blob:https://chatgpt.com/example',
    patch_key: 'patch-s1-001.patch',
    control_key: 'control-1',
    ...overrides
  };
}

test('local transfer validates final Chrome metadata and returns a durable receipt', async () => {
  const artifact = completedArtifact();
  const result = await new ArtifactTransferManager({ mode: 'local' }).transfer(artifact);

  assert.equal(result.mode, 'local');
  assert.deepEqual(result.artifact, artifact);
  assert.deepEqual(result.receipt, {
    download_id: 41,
    filename: 'patch-s1-001.patch',
    local_path: '/Users/test/Downloads/patch-s1-001.patch',
    source_url: 'blob:https://chatgpt.com/example'
  });
});

test('local transfer fails closed when the completed download has no final local path', async () => {
  const manager = new ArtifactTransferManager({ mode: 'local' });
  await assert.rejects(
    () => manager.transfer(completedArtifact({ local_path: null })),
    error => error.code === ERROR_CODES.PATCH_DOWNLOAD_FAILED && /local path/i.test(error.message)
  );
});

test('remote transfer strips Patch bytes before artifact metadata reporting', async () => {
  const uploaded = completedArtifact({
    content_base64: 'aGVsbG8=',
    content_bytes: new Uint8Array([1, 2, 3]),
    size_bytes: 5
  });
  const manager = new ArtifactTransferManager({
    mode: 'remote',
    remoteTransport: {
      async upload(artifact) {
        assert.equal(artifact.content_base64, 'aGVsbG8=');
        return { artifact_id: 'remote-a1', filename: artifact.filename, size_bytes: 5 };
      }
    }
  });

  const result = await manager.transfer(uploaded);

  assert.equal(result.mode, 'remote');
  assert.equal(result.receipt.artifact_id, 'remote-a1');
  assert.equal('content_base64' in result.artifact, false);
  assert.equal('content_bytes' in result.artifact, false);
  assert.equal(result.artifact.filename, uploaded.filename);
});

test('remote transfer fails closed when configured transport cannot upload Patch bytes', async () => {
  const manager = new ArtifactTransferManager({ mode: 'remote', remoteTransport: null });
  await assert.rejects(
    () => manager.transfer(completedArtifact()),
    error => error.code === ERROR_CODES.REMOTE_ARTIFACT_UPLOAD_FAILED
  );
});

test('remote transfer reads Patch bytes from the completed local download before upload', async () => {
  const source = completedArtifact();
  const calls = [];
  const manager = new ArtifactTransferManager({
    mode: 'remote',
    remoteFileReader: {
      async read(artifact) {
        calls.push(['read', artifact.local_path]);
        return { ...artifact, content_base64: 'aGVsbG8=', size_bytes: 5, sha256: 'a'.repeat(64) };
      }
    },
    remoteTransport: {
      async upload(artifact) {
        calls.push(['upload', artifact.content_base64, artifact.size_bytes]);
        return { artifact_id: 'remote-a1', filename: artifact.filename, size_bytes: artifact.size_bytes, sha256: artifact.sha256 };
      }
    }
  });

  const result = await manager.transfer(source);

  assert.deepEqual(calls, [
    ['read', source.local_path],
    ['upload', 'aGVsbG8=', 5]
  ]);
  assert.equal('content_base64' in result.artifact, false);
  assert.equal('content_bytes' in result.artifact, false);
  assert.equal(result.receipt.artifact_id, 'remote-a1');
});

test('local transfer never invokes Native Patch file reader', async () => {
  let reads = 0;
  const manager = new ArtifactTransferManager({
    mode: 'local',
    remoteFileReader: { async read() { reads += 1; throw new Error('must not read'); } }
  });

  await manager.transfer(completedArtifact());
  assert.equal(reads, 0);
});
