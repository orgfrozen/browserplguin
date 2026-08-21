import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('real runner wires configured ArtifactTransferManager into TaskRunner', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ ArtifactTransferManager \} from '\.\/artifact-transfer-manager\.js';/);
  assert.match(source, /import \{ PatchSyncArtifactTransport \} from '\.\/patchsync-artifact-transport\.js';/);
  assert.match(source, /new PatchSyncArtifactTransport\(\{ fileReader: nativePatchFileReader \}\)/);
  assert.match(source, /new ArtifactTransferManager\(\{ mode: settings\.patchTransferMode, remoteTransport, remoteFileReader, patchSyncTransport \}\)/);
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
  assert.match(source, /async function createRealRunner\(settings, \{ signal = null \} = \{\}\)/);
  assert.match(source, /new BrowserPageDriver\(\{[\s\S]*tabManager,[\s\S]*resourceLoader: new ResourceLoader\(\{ permissions: chrome\.permissions \}\),[\s\S]*compatibilityTelemetry,[\s\S]*abortSignal: signal/);
  assert.match(source, /abortSignal: signal/);
});

test('real runner wires RemoteArtifactTransport to Task API while keeping remote selection explicit', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ RemoteArtifactTransport \} from '\.\/remote-artifact-transport\.js';/);
  assert.match(source, /settings\.patchTransferMode === 'remote'/);
  assert.match(source, /new RemoteArtifactTransport\(\{ taskApi \}\)/);
  assert.match(source, /new PatchSyncArtifactTransport\(\{ fileReader: nativePatchFileReader \}\)/);
  assert.match(source, /new ArtifactTransferManager\(\{ mode: settings\.patchTransferMode, remoteTransport, remoteFileReader, patchSyncTransport \}\)/);
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

test('service worker exposes a side-effect-free live Task API connection command', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /TEST_TASK_API_CONNECTION/);
  assert.match(source, /testTaskApiConnection/);
  assert.match(source, /new AgentControlTaskApi\(\{/);
  assert.match(source, /\.testConnection\(\)/);
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
  assert.match(source, /observer,/);
  assert.match(source, /onRemoteTransfer:\s*\(\.\.\.args\)\s*=>\s*remoteE2eTracker\.onRemoteTransfer/);
  assert.match(source, /onArtifactReported:\s*\(\.\.\.args\)\s*=>\s*remoteE2eTracker\.onArtifactReported/);
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

test('service worker gates production remote promotion on passed evidence and fresh preflight', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /remote-production-mode\.js/);
  assert.match(source, /case 'GET_REMOTE_PRODUCTION_STATUS':/);
  assert.match(source, /case 'PROMOTE_REMOTE_PRODUCTION':/);
  assert.match(source, /case 'DISABLE_REMOTE_PRODUCTION':/);
  assert.match(source, /remoteE2eEvidence\.getSummary\(\)/);
  assert.match(source, /assertRemoteProductionReady/);
  assert.match(source, /enableRemoteProductionMode/);
});

test('production remote guard is pre-claim only while recovery stays ungated', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /async function prepareRealRun\(settings\)[\s\S]*remoteProductionMode/);
  assert.match(source, /new RuntimeController\(\{[\s\S]*storage,[\s\S]*loadMockTasks,[\s\S]*createMockRunner,[\s\S]*createRealRunner,[\s\S]*prepareRealRun,[\s\S]*scheduleRecoveryAt[\s\S]*cancelRecovery[\s\S]*\}\)/);
  const runtime = await fs.readFile(new URL('../src/background/runtime-controller.js', import.meta.url), 'utf8');
  assert.match(runtime, /runReal\(\)[\s\S]*prepareRealRun\(settings\)[\s\S]*runner\.runOnce\(\)/);
  assert.doesNotMatch(runtime, /recoverReal\(\)[\s\S]{0,350}prepareRealRun/);
});

test('real runner wires privacy-safe Resource E2E evidence tracker and ledger', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /ResourceE2eEvidenceLedger/);
  assert.match(source, /ResourceE2eRunTracker/);
  assert.match(source, /new ResourceE2eEvidenceLedger\(\{ storage \}\)/);
  assert.match(source, /new ResourceE2eRunTracker\(\)/);
  for (const method of ['onResourceInitializationStarted','onResourceDownloaded','onResourceAttached','onResourceInitializationResponseReady','onResourceInitializationCompleted']) {
    assert.match(source, new RegExp(`${method}`));
  }
  assert.match(source, /resourceE2eEvidence\.record/);
  assert.match(source, /result\?\.error\?\.code/);
});

test('service worker exposes Resource E2E evidence read and clear commands', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /case 'GET_RESOURCE_E2E_EVIDENCE':/);
  assert.match(source, /case 'CLEAR_RESOURCE_E2E_EVIDENCE':/);
  assert.match(source, /resourceE2eEvidence\.getSummary\(\)/);
  assert.match(source, /resourceE2eEvidence\.clear\(\)/);
});

test('service worker builds release readiness from fresh local evidence and a live remote preflight', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ buildReleaseReadiness \} from '\.\.\/shared\/release-readiness\.js';/);
  assert.match(source, /async function buildLiveReleaseReadiness\(\)/);
  assert.match(source, /buildCalibrationCoverage\(await calibrationEvidence\.getSummary\(\)\)/);
  assert.match(source, /resourceE2eEvidence\.getSummary\(\)/);
  assert.match(source, /remoteE2eEvidence\.getSummary\(\)/);
  assert.match(source, /buildRemoteProductionStatus/);
  assert.match(source, /runLiveRemoteE2ePreflight\(settings\)/);
  assert.match(source, /buildReleaseReadiness\(/);
  assert.match(source, /case 'GET_RELEASE_READINESS':\s*return buildLiveReleaseReadiness\(\);/);
});

test('service worker exposes read-only diagnostic screenshot safety policy without capture implementation', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /diagnostic-screenshot-policy\.js/);
  assert.match(source, /buildDiagnosticScreenshotPolicy/);
  assert.match(source, /case 'GET_DIAGNOSTIC_SCREENSHOT_POLICY':/);
  assert.doesNotMatch(source, /captureVisibleTab|captureTab|toDataURL|toBlob|OffscreenCanvas|createImageBitmap/i);
});

test('real runner uses AgentControlTaskApi with configured Agent identity instead of legacy task endpoints', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ AgentControlTaskApi \} from '\.\/agent-control-task-api\.js';/);
  assert.match(source, /new AgentControlTaskApi\(\{[\s\S]*baseUrl:\s*settings\.taskApiBaseUrl[\s\S]*token:\s*settings\.taskApiToken[\s\S]*agentId:\s*settings\.agentId/);
  assert.doesNotMatch(source, /new HttpTaskApi\(\{ baseUrl: settings\.taskApiBaseUrl/);
});

test('service worker uses chrome alarms to wake durable WAIT_EXTERNAL and cleanup recovery', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /const RECOVERY_ALARM_NAME = 'browser-task-recovery'/);
  assert.match(source, /scheduleRecoveryAt:[\s\S]*chrome\.alarms\.create\(RECOVERY_ALARM_NAME/);
  assert.match(source, /cancelRecovery:[\s\S]*chrome\.alarms\.clear\(RECOVERY_ALARM_NAME\)/);
  assert.match(source, /chrome\.alarms\.onAlarm\.addListener/);
  assert.match(source, /alarm\?\.name !== RECOVERY_ALARM_NAME/);
  assert.match(source, /controller\.recoverRealIfNeeded\(\)/);
});


test('real service worker keeps Agent presence heartbeat separate from Assignment lease renewal', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ AgentHeartbeatManager, AGENT_HEARTBEAT_ALARM_NAME \} from '\.\/agent-heartbeat-manager\.js';/);
  assert.match(source, /new AgentHeartbeatManager\(\{/);
  assert.match(source, /await agentHeartbeat\.configure\(\)/);
  assert.match(source, /agentHeartbeat\.handleAlarm\(alarm\)/);
  assert.match(source, /case 'SAVE_SETTINGS':[\s\S]*await agentHeartbeat\.configure\(next\)/);
  assert.doesNotMatch(source, /new HeartbeatManager\(\{[\s\S]{0,220}intervalMs:\s*Number\(settings\.heartbeatIntervalMs\)/);
  assert.match(source, /if \(alarm\?\.name === AGENT_HEARTBEAT_ALARM_NAME\)/);
});

test('service worker exposes persistent manual pause and resume controls through the runtime controller', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /case 'PAUSE_RUNNER':\s*return controller\.pause\(\);/);
  assert.match(source, /case 'RESUME_RUNNER':\s*return controller\.resume\(\);/);
  assert.match(source, /controller\.recoverRealIfNeeded\(\)/);
});

test('service worker exposes operator Task termination and performs control-plane cancel before best-effort Project cleanup', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /terminateRealTask/);
  assert.match(source, /taskApi\.cancelTask\(/);
  assert.match(source, /page\.deleteTaskProject\(/);
  assert.match(source, /case 'TERMINATE_TASK':\s*return controller\.terminateTask\(\);/);
});

test('Task termination cleanup uses an independent PageDriver after aborting the active runner', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  const match = source.match(/async function terminateRealTask[\s\S]*?(?=\nasync function prepareRealRun)/);
  assert.ok(match);
  assert.doesNotMatch(match[0], /abortSignal:\s*signal/);
});

test('service worker auto runner polls assigned real work only after the operator enables it', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /const AUTO_RUN_ALARM_NAME = 'browser-task-auto-run'/);
  assert.match(source, /const AUTO_RUN_PERIOD_MINUTES = 0\.5/);
  assert.match(source, /chrome\.alarms\.create\(AUTO_RUN_ALARM_NAME, \{[\s\S]*periodInMinutes:\s*AUTO_RUN_PERIOD_MINUTES/);
  assert.match(source, /alarm\?\.name === AUTO_RUN_ALARM_NAME[\s\S]*controller\.runAutoOnce\(\)/);
  assert.match(source, /case 'SET_AUTO_RUN':[\s\S]*controller\.setAutoRunEnabled\(message\.enabled === true\)/);
  assert.match(source, /controller\.runAutoOnce\(\)/);
});


test('service worker wires progress-aware composer waits and five workspace retries into real runner', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /composerPollIntervalMs:\s*2000/);
  assert.match(source, /composerStallTimeoutMs:\s*180000/);
  assert.match(source, /workspaceMaxRetries:\s*5/);
  assert.match(source, /new BrowserPageDriver\([\s\S]*composerPollMs:[\s\S]*composerStallTimeoutMs:/);
  assert.match(source, /new TaskRunner\([\s\S]*maxWorkspaceRetries:/);
});
