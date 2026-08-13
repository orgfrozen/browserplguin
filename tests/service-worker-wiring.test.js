import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('real runner wires configured ArtifactTransferManager into TaskRunner', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ ArtifactTransferManager \} from '\.\/artifact-transfer-manager\.js';/);
  assert.match(source, /new ArtifactTransferManager\(\{ mode: settings\.patchTransferMode, remoteTransport, remoteFileReader \}\)/);
  assert.match(source, /artifactTransfer,/);
});

test('real runner checkpoints rotated lease and exposes explicit recovery command', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /onLeaseUpdated:\s*\(taskId, lease\)\s*=>\s*taskStore\.updateLease\(taskId, lease\)/);
  assert.match(source, /recoverOnce:\s*\(\)\s*=>\s*executeRunner\('recoverOnce'\)/);
  assert.match(source, /case 'RECOVER_REAL_TASK':/);
  assert.match(source, /controller\.recoverReal\(\)/);
});

test('real runner wires local UI compatibility telemetry into BrowserPageDriver', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ UiCompatibilityTelemetry \} from '\.\/ui-compatibility-telemetry\.js';/);
  assert.match(source, /new UiCompatibilityTelemetry\(\{ storage \}\)/);
  assert.match(source, /new BrowserPageDriver\(\{ tabManager, resourceLoader: new ResourceLoader\(\), compatibilityTelemetry \}\)/);
});

test('real runner wires RemoteArtifactTransport to Task API while keeping remote selection explicit', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ RemoteArtifactTransport \} from '\.\/remote-artifact-transport\.js';/);
  assert.match(source, /settings\.patchTransferMode === 'remote'/);
  assert.match(source, /new RemoteArtifactTransport\(\{ taskApi \}\)/);
  assert.match(source, /new ArtifactTransferManager\(\{ mode: settings\.patchTransferMode, remoteTransport, remoteFileReader \}\)/);
});

test('real remote runner wires NativePatchFileReader before RemoteArtifactTransport while options remain gated', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const options = await fs.readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  assert.match(source, /import \{ NativePatchFileReader \} from '\.\/native-patch-file-reader\.js';/);
  assert.match(source, /new NativePatchFileReader\(/);
  assert.match(source, /remoteFileReader/);
  assert.ok(manifest.permissions.includes('nativeMessaging'));
  assert.match(options, /<option value="remote" disabled>/);
});
