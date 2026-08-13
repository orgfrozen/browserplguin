import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('real runner wires configured ArtifactTransferManager into TaskRunner', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ ArtifactTransferManager \} from '\.\/artifact-transfer-manager\.js';/);
  assert.match(source, /new ArtifactTransferManager\(\{ mode: settings\.patchTransferMode \}\)/);
  assert.match(source, /artifactTransfer,/);
});

test('real runner checkpoints rotated lease and exposes explicit recovery command', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /onLeaseUpdated:\s*\(taskId, lease\)\s*=>\s*taskStore\.updateLease\(taskId, lease\)/);
  assert.match(source, /recoverOnce:\s*\(\)\s*=>\s*executeRunner\('recoverOnce'\)/);
  assert.match(source, /case 'RECOVER_REAL_TASK':/);
  assert.match(source, /controller\.recoverReal\(\)/);
});
