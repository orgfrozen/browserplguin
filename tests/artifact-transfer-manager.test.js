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
