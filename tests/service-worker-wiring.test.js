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
  assert.match(source, /new BrowserPageDriver\(\{ tabManager, resourceLoader: new ResourceLoader\(\{ permissions: chrome\.permissions \}\), compatibilityTelemetry \}\)/);
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

test('service worker exposes privacy-safe Native Helper readiness commands without enabling remote mode', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  const options = await fs.readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  assert.match(source, /checkNativeHelperReadiness/);
  assert.match(source, /getNativeHelperReadiness/);
  assert.match(source, /case 'CHECK_NATIVE_HELPER':/);
  assert.match(source, /case 'GET_NATIVE_HELPER_STATUS':/);
  assert.match(options, /<option value="remote" disabled>/);
});

test('service worker exposes side-effect-free remote E2E preflight commands', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /runRemoteE2ePreflight/);
  assert.match(source, /GET_REMOTE_E2E_PREFLIGHT/);
  assert.match(source, /CHECK_REMOTE_E2E_PREFLIGHT/);
  assert.match(source, /chrome\.permissions/);
  assert.match(source, /chrome\.runtime\.getManifest\(\)/);
});

test('service worker wires explicit remote E2E test-mode commands and pre-claim guard', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /remote-e2e-test-mode\.js/);
  assert.match(source, /prepareRealRun/);
  assert.match(source, /assertRemoteE2eTestModeReady/);
  assert.match(source, /case 'ENABLE_REMOTE_E2E_TEST_MODE':/);
  assert.match(source, /case 'DISABLE_REMOTE_E2E_TEST_MODE':/);
  assert.match(source, /buildSafeSettingsUpdate/);
});

test('ordinary SAVE_SETTINGS is not a remote test-mode bypass', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /case 'SAVE_SETTINGS':[\s\S]*buildSafeSettingsUpdate/);
  assert.match(source, /remoteE2eTestMode:\s*false/);
  assert.match(source, /patchTransferMode:\s*'local'/);
});

test('real resource loader receives chrome.permissions so Task resource downloads are permission gated', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /resourceLoader:\s*new ResourceLoader\(\{ permissions:\s*chrome\.permissions \}\)/);
});

test('real remote E2E test runner wires a privacy-safe evidence tracker and ledger', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /RemoteE2eEvidenceLedger/);
  assert.match(source, /RemoteE2eRunTracker/);
  assert.match(source, /new RemoteE2eEvidenceLedger\(\{ storage \}\)/);
  assert.match(source, /remoteE2eTestMode === true && settings\.patchTransferMode === 'remote'/);
  assert.match(source, /observer:\s*remoteE2eTracker/);
  assert.match(source, /remoteE2eEvidence\.record/);
  assert.match(source, /method === 'recoverOnce'/);
});

test('service worker exposes Remote E2E evidence read and clear commands', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /case 'GET_REMOTE_E2E_EVIDENCE':/);
  assert.match(source, /case 'CLEAR_REMOTE_E2E_EVIDENCE':/);
  assert.match(source, /remoteE2eEvidence\.getSummary\(\)/);
  assert.match(source, /remoteE2eEvidence\.clear\(\)/);
});
