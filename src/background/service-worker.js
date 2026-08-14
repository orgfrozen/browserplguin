import { RuntimeController } from './runtime-controller.js';
import { MockTaskApi } from './mock-task-api.js';
import { HttpTaskApi } from './task-api.js';
import { TaskStore, chromeStorageAdapter } from './task-store.js';
import { MockPageDriver } from './mock-page-driver.js';
import { BrowserPageDriver } from './browser-page-driver.js';
import { TabManager } from './tab-manager.js';
import { TaskRunner } from './task-runner.js';
import { HeartbeatManager } from './heartbeat-manager.js';
import { ChromePatchProcessor } from './chrome-patch-processor.js';
import { inspectChatGptUi } from './ui-diagnostics.js';
import { runLiveCalibration } from './live-calibration.js';
import { CalibrationEvidenceLedger } from './calibration-evidence-ledger.js';
import { buildCalibrationCoverage } from '../shared/calibration-coverage.js';
import { ResourceLoader } from './resource-loader.js';
import { ArtifactTransferManager } from './artifact-transfer-manager.js';
import { RemoteArtifactTransport } from './remote-artifact-transport.js';
import { NativePatchFileReader } from './native-patch-file-reader.js';
import { checkNativeHelperReadiness, getNativeHelperReadiness } from './native-helper-readiness.js';
import { UiCompatibilityTelemetry } from './ui-compatibility-telemetry.js';
import { runRemoteE2ePreflight, getRemoteE2ePreflight } from './remote-e2e-preflight.js';
import { enableRemoteE2eTestMode, disableRemoteE2eTestMode, assertRemoteE2eTestModeReady, buildSafeSettingsUpdate } from './remote-e2e-test-mode.js';
import { RemoteE2eEvidenceLedger, RemoteE2eRunTracker } from './remote-e2e-evidence.js';
import { ResourceE2eEvidenceLedger, ResourceE2eRunTracker } from './resource-e2e-evidence.js';
import { buildRemoteProductionStatus, enableRemoteProductionMode, disableRemoteProductionMode, assertRemoteProductionReady } from './remote-production-mode.js';

const DEFAULT_SETTINGS = Object.freeze({
  mode: 'mock',
  taskApiBaseUrl: 'http://127.0.0.1:43127',
  taskApiToken: '',
  heartbeatIntervalMs: 30000,
  fallbackLimit: 2,
  maxTaskRounds: 100,
  patchDownloadTimeoutMs: 60000,
  patchTransferMode: 'local',
  remoteE2eTestMode: false,
  remoteProductionMode: false
});

const storage = chromeStorageAdapter(chrome.storage.local);
const calibrationEvidence = new CalibrationEvidenceLedger({ storage });
const remoteE2eEvidence = new RemoteE2eEvidenceLedger({ storage });
const resourceE2eEvidence = new ResourceE2eEvidenceLedger({ storage });

async function ensureSettings() {
  const existing = await storage.get('settings');
  if (!existing) await storage.set('settings', DEFAULT_SETTINGS);
}

async function loadMockTasks() {
  const response = await fetch(chrome.runtime.getURL('mock/tasks.json'));
  if (!response.ok) throw new Error(`mock tasks load failed: ${response.status}`);
  return response.json();
}

function createMockRunner(task) {
  const api = new MockTaskApi([task]);
  const taskStore = new TaskStore(storage);
  return new TaskRunner({
    taskApi: api,
    taskStore,
    page: new MockPageDriver(),
    processPatch: async (candidate, context) => ({
      task_id: context.taskId,
      session_id: context.sessionId,
      filename: candidate.filename,
      patch_key: candidate.filename,
      control_key: candidate.control_key ?? null,
      mock: true
    })
  });
}

async function runLiveRemoteE2ePreflight(settings) {
  return runRemoteE2ePreflight({
    settings: { ...DEFAULT_SETTINGS, ...(settings ?? {}) },
    permissions: chrome.permissions,
    manifest: chrome.runtime.getManifest(),
    reader: new NativePatchFileReader({ runtime: chrome.runtime }),
    storage
  });
}

async function prepareRealRun(settings) {
  const effective = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  if (effective.patchTransferMode !== 'remote') return { status: 'not_required' };
  if (effective.remoteProductionMode === true) {
    return assertRemoteProductionReady({
      settings: effective,
      evidenceSummary: await remoteE2eEvidence.getSummary(),
      runPreflight: () => runLiveRemoteE2ePreflight(effective)
    });
  }
  return assertRemoteE2eTestModeReady({
    settings: effective,
    runPreflight: () => runLiveRemoteE2ePreflight(effective)
  });
}

async function createRealRunner(settings) {
  if (!settings.taskApiBaseUrl) throw new Error('taskApiBaseUrl is required for real mode');
  const taskApi = new HttpTaskApi({ baseUrl: settings.taskApiBaseUrl, token: settings.taskApiToken ?? '' });
  const taskStore = new TaskStore(storage);
  const tabManager = new TabManager(chrome.tabs);
  const compatibilityTelemetry = new UiCompatibilityTelemetry({ storage });
  const page = new BrowserPageDriver({ tabManager, resourceLoader: new ResourceLoader({ permissions: chrome.permissions }), compatibilityTelemetry });
  const heartbeat = new HeartbeatManager({
    taskApi,
    intervalMs: Number(settings.heartbeatIntervalMs) || DEFAULT_SETTINGS.heartbeatIntervalMs,
    onLeaseUpdated: (taskId, lease) => taskStore.updateLease(taskId, lease)
  });
  const patchProcessor = new ChromePatchProcessor({
    downloads: chrome.downloads,
    timeoutMs: Number(settings.patchDownloadTimeoutMs) || DEFAULT_SETTINGS.patchDownloadTimeoutMs,
    triggerPageDownload: ({ tabId, clickToken }) => tabManager.send(tabId, { type: 'CHATGPT_CLICK_PATCH', clickToken })
  });
  const remoteTransport = settings.patchTransferMode === 'remote' ? new RemoteArtifactTransport({ taskApi }) : null;
  const remoteFileReader = settings.patchTransferMode === 'remote' ? new NativePatchFileReader({ runtime: chrome.runtime }) : null;
  const artifactTransfer = new ArtifactTransferManager({ mode: settings.patchTransferMode, remoteTransport, remoteFileReader });
  const remoteE2eTracker = new RemoteE2eRunTracker({ enabled: settings.remoteE2eTestMode === true && settings.patchTransferMode === 'remote' });
  const resourceE2eTracker = new ResourceE2eRunTracker();
  const observer = {
    onRemoteTransfer: (...args) => remoteE2eTracker.onRemoteTransfer(...args),
    onArtifactReported: (...args) => remoteE2eTracker.onArtifactReported(...args),
    onCleanupCompleted: (...args) => remoteE2eTracker.onCleanupCompleted(...args),
    onTerminalSucceeded: (...args) => remoteE2eTracker.onTerminalSucceeded(...args),
    onResourceInitializationStarted: (...args) => resourceE2eTracker.onResourceInitializationStarted(...args),
    onResourceDownloaded: (...args) => resourceE2eTracker.onResourceDownloaded(...args),
    onResourceAttached: (...args) => resourceE2eTracker.onResourceAttached(...args),
    onResourceInitializationResponseReady: (...args) => resourceE2eTracker.onResourceInitializationResponseReady(...args),
    onResourceInitializationCompleted: (...args) => resourceE2eTracker.onResourceInitializationCompleted(...args)
  };
  const runner = new TaskRunner({
    taskApi,
    taskStore,
    page,
    heartbeat,
    artifactTransfer,
    observer,
    fallbackLimit: Number(settings.fallbackLimit) || DEFAULT_SETTINGS.fallbackLimit,
    maxTaskRounds: Number(settings.maxTaskRounds) || DEFAULT_SETTINGS.maxTaskRounds,
    processPatch: (candidate, context) => patchProcessor.process(candidate, context)
  });
  const executeRunner = async method => {
    let result = null;
    let thrownError = null;
    try {
      result = await runner[method]();
      return result;
    } catch (error) {
      thrownError = error;
      throw error;
    } finally {
      patchProcessor.dispose();
      if (result && !['idle', 'no_recovery'].includes(result.status)) {
        const evidence = remoteE2eTracker.finish({
          runnerStatus: result.status,
          recovered: method === 'recoverOnce'
        });
        if (evidence) {
          try { await remoteE2eEvidence.record(evidence); } catch { /* evidence is best-effort */ }
        }
      }
      const resourceEvidence = resourceE2eTracker.finish({
        runnerStatus: result?.status ?? (thrownError ? 'threw' : 'unknown'),
        errorCode: result?.error?.code ?? thrownError?.code ?? null,
        recovered: method === 'recoverOnce'
      });
      if (resourceEvidence) {
        try { await resourceE2eEvidence.record(resourceEvidence); } catch { /* evidence is best-effort */ }
      }
    }
  };
  return {
    runOnce: () => executeRunner('runOnce'),
    recoverOnce: () => executeRunner('recoverOnce')
  };
}

const controller = new RuntimeController({ storage, loadMockTasks, createMockRunner, createRealRunner, prepareRealRun });
const startupRecovery = (async () => {
  await ensureSettings();
  try {
    return await controller.recoverRealIfNeeded();
  } catch (error) {
    const result = {
      status: 'recovery_bootstrap_failed',
      error: { code: error.code ?? 'UNEXPECTED', message: error.message }
    };
    await storage.set('lastRecovery', result);
    console.error('[ChatGPT Web Task Runner] startup recovery failed', error);
    return result;
  }
})();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    await startupRecovery;
    switch (message?.type) {
      case 'GET_RUNNER_STATUS':
        return controller.getStatus();
      case 'RUN_MOCK_ONCE':
        return controller.runMock(message.taskId ?? null);
      case 'RUN_REAL_ONCE':
        return controller.runReal();
      case 'RECOVER_REAL_TASK':
        return controller.recoverReal();
      case 'INSPECT_CHATGPT_UI':
        return inspectChatGptUi(new TabManager(chrome.tabs));
      case 'RUN_CHATGPT_CALIBRATION':
        return runLiveCalibration(new TabManager(chrome.tabs), calibrationEvidence);
      case 'GET_CALIBRATION_EVIDENCE':
        return calibrationEvidence.getSummary();
      case 'GET_CALIBRATION_COVERAGE':
        return buildCalibrationCoverage(await calibrationEvidence.getSummary());
      case 'CLEAR_CALIBRATION_EVIDENCE':
        await calibrationEvidence.clear();
        return calibrationEvidence.getSummary();
      case 'CHECK_NATIVE_HELPER':
        return checkNativeHelperReadiness({
          reader: new NativePatchFileReader({ runtime: chrome.runtime }),
          storage
        });
      case 'GET_NATIVE_HELPER_STATUS':
        return getNativeHelperReadiness(storage);
      case 'CHECK_REMOTE_E2E_PREFLIGHT':
        return runLiveRemoteE2ePreflight((await storage.get('settings')) ?? {});
      case 'GET_REMOTE_E2E_PREFLIGHT':
        return getRemoteE2ePreflight(storage);
      case 'GET_REMOTE_E2E_EVIDENCE':
        return remoteE2eEvidence.getSummary();
      case 'CLEAR_REMOTE_E2E_EVIDENCE':
        await remoteE2eEvidence.clear();
        return remoteE2eEvidence.getSummary();
      case 'GET_RESOURCE_E2E_EVIDENCE':
        return resourceE2eEvidence.getSummary();
      case 'CLEAR_RESOURCE_E2E_EVIDENCE':
        await resourceE2eEvidence.clear();
        return resourceE2eEvidence.getSummary();
      case 'GET_REMOTE_PRODUCTION_STATUS': {
        const settings = { ...DEFAULT_SETTINGS, ...((await storage.get('settings')) ?? {}) };
        return buildRemoteProductionStatus({ settings, evidenceSummary: await remoteE2eEvidence.getSummary() });
      }
      case 'PROMOTE_REMOTE_PRODUCTION': {
        const settings = { ...DEFAULT_SETTINGS, ...((await storage.get('settings')) ?? {}) };
        return enableRemoteProductionMode({
          settings,
          evidenceSummary: await remoteE2eEvidence.getSummary(),
          storage,
          runPreflight: () => runLiveRemoteE2ePreflight(settings)
        });
      }
      case 'DISABLE_REMOTE_PRODUCTION': {
        const settings = { ...DEFAULT_SETTINGS, ...((await storage.get('settings')) ?? {}) };
        return disableRemoteProductionMode({ settings, storage });
      }
      case 'ENABLE_REMOTE_E2E_TEST_MODE': {
        const settings = { ...DEFAULT_SETTINGS, ...((await storage.get('settings')) ?? {}) };
        return enableRemoteE2eTestMode({
          settings,
          storage,
          runPreflight: () => runLiveRemoteE2ePreflight(settings)
        });
      }
      case 'DISABLE_REMOTE_E2E_TEST_MODE': {
        const settings = { ...DEFAULT_SETTINGS, ...((await storage.get('settings')) ?? {}) };
        return disableRemoteE2eTestMode({ settings, storage });
      }
      case 'GET_SETTINGS':
        return { ...DEFAULT_SETTINGS, ...((await storage.get('settings')) ?? {}) };
      case 'SAVE_SETTINGS': {
        const current = (await storage.get('settings')) ?? {};
        const next = buildSafeSettingsUpdate({
          defaults: DEFAULT_SETTINGS,
          current,
          incoming: message.settings ?? {}
        });
        await storage.set('settings', next);
        return next;
      }
      default:
        return { ok: false, error: 'UNKNOWN_COMMAND' };
    }
  })().then(sendResponse).catch(error => sendResponse({
    ok: false,
    error: { code: error.code ?? 'UNEXPECTED', message: error.message }
  }));
  return true;
});
