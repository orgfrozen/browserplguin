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
  assert.match(source, /controller\.recoverReal\(message\.slotId \?\? null\)/);
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

test('service worker rearms durable recovery after a recovery bootstrap failure', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /async function rearmStoredRecoveryIfNeeded/);
  assert.match(source, /recordRecoveryBootstrapFailure[\s\S]*rearmStoredRecoveryIfNeeded/);
  assert.match(source, /activeExecution\?\.next_recovery_at/);
  assert.match(source, /chrome\.alarms\.create\(RECOVERY_ALARM_NAME/);
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
  assert.match(source, /import \{ AgentHeartbeatManager, AGENT_HEARTBEAT_ALARM_NAME, buildAgentCapacityDiagnostics \} from '\.\/agent-heartbeat-manager\.js';/);
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
  assert.match(source, /case 'TERMINATE_TASK':\s*return controller\.terminateTask\(message\.slotId \?\? null\);/);
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

test('startup proactively allows ChatGPT automatic multi-file downloads', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /chrome\.contentSettings\.automaticDownloads\.set/);
  assert.match(source, /primaryPattern:\s*['"]https:\/\/chatgpt\.com\/\*['"]/);
  assert.match(source, /setting:\s*['"]allow['"]/);
  assert.match(source, /await ensureChatGptAutomaticDownloadsAllowed\(\)/);
});


test('service worker exposes a dedicated legacy cleanup toggle without resetting unrelated settings', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /case 'SET_CLEANUP_LEGACY_PROJECTS'/);
  assert.match(source, /cleanupLegacyProjects:\s*enabled === true/);
  assert.match(source, /setCleanupLegacyProjects\(message\.enabled === true\)/);
  assert.match(source, /await storage\.set\('settings', next\)/);
});

test('real BrowserPageDriver receives the opt-in legacy project cleanup setting', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /cleanupLegacyProjects:\s*settings\.cleanupLegacyProjects === true/);
  assert.match(source, /cleanupLegacyProjects:\s*false/);
});

test('real runner wires persistent browser tab slots into the ChatGPT page driver', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /BrowserTabSlotStore/);
  assert.match(source, /new BrowserTabSlotStore\(storage\)/);
  assert.match(source, /new BrowserPageDriver\(\{[\s\S]*tabSlotStore/);
});

test('operator Task termination releases the persistent worker tab slot after owned Project cleanup succeeds', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  const match = source.match(/async function terminateRealTask[\s\S]*?(?=\nasync function prepareRealRun)/);
  assert.ok(match);
  assert.match(match[0], /await page\.deleteTaskProject\([\s\S]*await page\.releaseTaskTab\(\{\s*state:\s*activeExecution\s*\}\)/);
});

test('service worker wires durable tab observation heartbeat and a shared UI action queue for future multi-slot scheduling', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ UiActionQueue \} from '\.\/ui-action-queue\.js';/);
  assert.match(source, /import \{ TabSlotHeartbeatManager, TAB_SLOT_HEARTBEAT_ALARM_NAME \} from '\.\/tab-slot-heartbeat-manager\.js';/);
  assert.match(source, /const browserTabSlotStore = new BrowserTabSlotStore\(storage\);/);
  assert.match(source, /const uiActionQueue = new UiActionQueue\(\{ tabs: chrome\.tabs, slotStore: browserTabSlotStore \}\);/);
  assert.match(source, /uiActionQueue,/);
  assert.match(source, /message\?\.type === 'CHATGPT_SLOT_STATE'/);
  assert.match(source, /message\?\.type === 'CHATGPT_SLOT_HEARTBEAT'/);
  assert.match(source, /TAB_SLOT_HEARTBEAT_ALARM_NAME/);
});

test('content tab observations bypass startup readiness and popup commands do not wait for long recovery', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  const listenerAt = source.indexOf('chrome.runtime.onMessage.addListener');
  const fastPathAt = source.indexOf("message?.type === 'CHATGPT_SLOT_STATE'", listenerAt);
  const startupReadyAt = source.indexOf('await startupReady', listenerAt);
  assert.ok(listenerAt >= 0 && fastPathAt > listenerAt && startupReadyAt > listenerAt);
  assert.ok(fastPathAt < startupReadyAt);
  const listener = source.slice(listenerAt);
  assert.equal(listener.includes('await startupRecovery'), false);
});

test('service worker wires multi-slot runtime capacity and fixed-slot real runners', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ MultiSlotRuntimeController/);
  assert.match(source, /maxParallelTasks:\s*1/);
  assert.match(source, /claimMode:\s*'next_only'/);
  assert.match(source, /new BrowserPageDriver\(\{[\s\S]*slotId,/);
  assert.match(source, /new MultiSlotRuntimeController\(\{/);
  assert.match(source, /createController:/);
  assert.match(source, /SET_MAX_PARALLEL_TASKS/);
});

test('service worker routes closed and discarded owned tabs to slot recovery', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /chrome\.tabs\.onRemoved\.addListener/);
  assert.match(source, /controller\.handleTabRemoved\(tabId,\s*'removed'\)/);
  assert.match(source, /chrome\.tabs\.onUpdated\.addListener/);
  assert.match(source, /changeInfo\?\.discarded !== true/);
  assert.match(source, /controller\.handleTabRemoved\(tabId,\s*'discarded'\)/);
});

test('service worker gives each slot a distinct durable recovery alarm', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /function recoveryAlarmName\(slotId/);
  assert.match(source, /function slotIdFromRecoveryAlarm\(name/);
  assert.match(source, /controller\.recoverReal\(slotId,\s*\{\s*automatic:\s*true\s*\}\)/);
});

test('tab slot heartbeat alarm runs the slot watchdog after passive observations are refreshed', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /alarm\?\.name === TAB_SLOT_HEARTBEAT_ALARM_NAME[\s\S]*tabSlotHeartbeat\.runOnce\(\)[\s\S]*controller\.runWatchdogOnce\(\)/);
});

test('service worker delegates dynamic capacity and graceful drain commands to the multi-slot controller', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /case 'SET_MAX_PARALLEL_TASKS':[\s\S]*controller\.setMaxParallelTasks\(message\.maxParallelTasks\)/);
  assert.match(source, /case 'SET_MAX_PARALLEL_TASKS':[\s\S]*agentHeartbeat\.configure\(\)/);
  assert.match(source, /case 'SET_DRAIN_MODE':[\s\S]*controller\.setDrainEnabled\(message\.enabled === true\)/);
});

test('service worker routes targeted terminate and recovery commands to the requested slot', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /case 'TERMINATE_TASK':\s*return controller\.terminateTask\(message\.slotId \?\? null\);/);
  assert.match(source, /case 'RECOVER_REAL_TASK':\s*return controller\.recoverReal\(message\.slotId \?\? null\);/);
});

test('service worker wires browser recovery circuit escalation and keeps scheduled recovery automatic', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /openRecoveryCircuit:\s*openBrowserRecoveryCircuit/);
  assert.match(source, /waitingHumanTask\(.*browser_recovery_circuit_open/s);
  assert.match(source, /controller\.recoverReal\(slotId,\s*\{\s*automatic:\s*true\s*\}\)/);
  assert.match(source, /case 'RECOVER_REAL_TASK':\s*return controller\.recoverReal\(message\.slotId \?\? null\);/);
});

test('service worker feeds UI queue pressure into adaptive multi-slot backpressure', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /pressureProvider:\s*\(\)\s*=>\s*uiActionQueue\.getStats\(\)/);
});

test('service worker parks exact Patch external waits by releasing the owned tab without deleting the Project', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /async function parkExternalWait/);
  const match = source.match(/async function parkExternalWait[\s\S]*?(?=\nasync function prepareRealRun)/);
  assert.ok(match);
  assert.match(match[0], /page\.releaseTaskTab\(\{\s*state:\s*activeExecution\s*\}\)/);
  assert.doesNotMatch(match[0], /deleteTaskProject/);
  assert.match(source, /parkExternalWait:\s*parkSlotExternalWait/);
});

test('service worker records successful Assignment heartbeats into the owning Browser slot liveness', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /new HeartbeatManager\(\{[\s\S]*onHeartbeatSuccess:[\s\S]*browserTabSlotStore\.recordExecutionHeartbeat/);
});
