import { RuntimeController } from './runtime-controller.js';
import { MockTaskApi } from './mock-task-api.js';
import { AgentControlTaskApi } from './agent-control-task-api.js';
import { TaskStore, chromeStorageAdapter } from './task-store.js';
import { MockPageDriver } from './mock-page-driver.js';
import { BrowserPageDriver } from './browser-page-driver.js';
import { TabManager } from './tab-manager.js';
import { TaskRunner } from './task-runner.js';
import { HeartbeatManager } from './heartbeat-manager.js';
import { AgentHeartbeatManager, AGENT_HEARTBEAT_ALARM_NAME } from './agent-heartbeat-manager.js';
import { ChromePatchProcessor } from './chrome-patch-processor.js';
import { inspectChatGptUi } from './ui-diagnostics.js';
import { runLiveCalibration } from './live-calibration.js';
import { CalibrationEvidenceLedger } from './calibration-evidence-ledger.js';
import { buildCalibrationCoverage } from '../shared/calibration-coverage.js';
import { buildCalibrationCampaign } from '../shared/calibration-campaign.js';
import { buildReleaseReadiness } from '../shared/release-readiness.js';
import { buildValidationHandoffBundle } from '../shared/validation-handoff.js';
import { buildDiagnosticScreenshotPolicy } from '../shared/diagnostic-screenshot-policy.js';
import { ResourceLoader } from './resource-loader.js';
import { PatchSyncClient } from './patchsync-client.js';
import { PatchSyncArtifactTransport } from './patchsync-artifact-transport.js';
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

const RECOVERY_ALARM_NAME = 'browser-task-recovery';
const AUTO_RUN_ALARM_NAME = 'browser-task-auto-run';
const AUTO_RUN_PERIOD_MINUTES = 0.5;

const DEFAULT_SETTINGS = Object.freeze({
  mode: 'mock',
  taskApiBaseUrl: 'http://127.0.0.1:43127',
  taskApiToken: '',
  agentId: '',
  heartbeatIntervalMs: 30000,
  fallbackLimit: 2,
  maxTaskRounds: 100,
  composerPollIntervalMs: 2000,
  composerStallTimeoutMs: 180000,
  workspaceMaxRetries: 5,
  patchDownloadTimeoutMs: 600000,
  patchTransferMode: 'local',
  remoteE2eTestMode: false,
  remoteProductionMode: false
});

const storage = chromeStorageAdapter(chrome.storage.local);
const calibrationEvidence = new CalibrationEvidenceLedger({ storage });
const remoteE2eEvidence = new RemoteE2eEvidenceLedger({ storage });
const resourceE2eEvidence = new ResourceE2eEvidenceLedger({ storage });

function createAgentControlTaskApi(settings) {
  return new AgentControlTaskApi({
    baseUrl: settings.taskApiBaseUrl,
    token: settings.taskApiToken ?? '',
    agentId: settings.agentId,
    executorRef: chrome.runtime.id
  });
}

async function loadEffectiveSettings() {
  return { ...DEFAULT_SETTINGS, ...((await storage.get('settings')) ?? {}) };
}

const agentHeartbeat = new AgentHeartbeatManager({
  alarms: chrome.alarms,
  createTaskApi: createAgentControlTaskApi,
  loadSettings: loadEffectiveSettings
});

async function ensureChatGptAutomaticDownloadsAllowed() {
  await chrome.contentSettings.automaticDownloads.set({
    primaryPattern: 'https://chatgpt.com/*',
    setting: 'allow'
  });
}

async function ensureSettings() {
  const existing = await storage.get('settings');
  if (!existing) {
    await storage.set('settings', DEFAULT_SETTINGS);
    return;
  }
  if (Number(existing.patchDownloadTimeoutMs) === 60000) {
    await storage.set('settings', {
      ...existing,
      patchDownloadTimeoutMs: DEFAULT_SETTINGS.patchDownloadTimeoutMs
    });
  }
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

async function testTaskApiConnection(settings) {
  try {
    const result = await createAgentControlTaskApi({
      taskApiBaseUrl: settings?.taskApiBaseUrl,
      taskApiToken: settings?.taskApiToken ?? '',
      agentId: settings?.agentId
    }).testConnection();
    return { connected: true, ...result };
  } catch (error) {
    return {
      connected: false,
      status: Number.isInteger(error?.status) ? error.status : null,
      error_code: error?.code ?? (error instanceof TypeError ? 'invalid_connection_settings' : 'task_api_unreachable'),
      error_message: error?.message ?? String(error)
    };
  }
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

async function buildLiveReleaseReadiness() {
  const settings = { ...DEFAULT_SETTINGS, ...((await storage.get('settings')) ?? {}) };
  const calibration = buildCalibrationCoverage(await calibrationEvidence.getSummary());
  const resourceEvidenceSummary = await resourceE2eEvidence.getSummary();
  const remoteEvidenceSummary = await remoteE2eEvidence.getSummary();
  const remoteProduction = buildRemoteProductionStatus({ settings, evidenceSummary: remoteEvidenceSummary });
  const remotePreflight = await runLiveRemoteE2ePreflight(settings);
  return buildReleaseReadiness({
    calibration,
    resourceEvidence: resourceEvidenceSummary,
    remoteEvidence: remoteEvidenceSummary,
    remoteProduction,
    remotePreflight
  });
}

async function buildLiveValidationHandoffBundle() {
  const settings = { ...DEFAULT_SETTINGS, ...((await storage.get('settings')) ?? {}) };
  const calibration = buildCalibrationCoverage(await calibrationEvidence.getSummary());
  const resourceEvidenceSummary = await resourceE2eEvidence.getSummary();
  const remoteEvidenceSummary = await remoteE2eEvidence.getSummary();
  const remoteProduction = buildRemoteProductionStatus({ settings, evidenceSummary: remoteEvidenceSummary });
  const remotePreflight = await runLiveRemoteE2ePreflight(settings);
  const releaseReadiness = buildReleaseReadiness({
    calibration,
    resourceEvidence: resourceEvidenceSummary,
    remoteEvidence: remoteEvidenceSummary,
    remoteProduction,
    remotePreflight
  });
  return buildValidationHandoffBundle({
    calibration,
    resourceEvidence: resourceEvidenceSummary,
    remoteEvidence: remoteEvidenceSummary,
    remoteProduction,
    remotePreflight,
    releaseReadiness
  });
}

async function terminateRealTask({ activeExecution, settings }) {
  const taskId = activeExecution?.task_id;
  if (!taskId) throw new Error('activeExecution.task_id is required for Task termination');
  const taskApi = createAgentControlTaskApi(settings);
  const cancelled = await taskApi.cancelTask(taskId, { reason: 'Terminated by BrowserPlugin operator' });

  let cleanupStatus = 'not_required';
  let cleanupError = null;
  const projectName = activeExecution?.task_project?.project_name ?? activeExecution?.chatgpt_project_name ?? null;
  if (projectName) {
    const tabManager = new TabManager(chrome.tabs);
    const compatibilityTelemetry = new UiCompatibilityTelemetry({ storage });
    const page = new BrowserPageDriver({ tabManager, resourceLoader: new ResourceLoader({ permissions: chrome.permissions }), compatibilityTelemetry });
    try {
      await page.deleteTaskProject({ project: { ...(activeExecution.task_project ?? {}), project_name: projectName } });
      cleanupStatus = 'completed';
    } catch (error) {
      cleanupStatus = 'failed';
      cleanupError = { safe: true, code: error?.code ?? 'CLEANUP_FAILED', message: error?.message ?? String(error) };
    }
  }

  return {
    server_status: cancelled?.task?.status ?? 'cancelled',
    cleanup_status: cleanupStatus,
    ...(cleanupError ? { cleanup_error: cleanupError } : {})
  };
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

async function createRealRunner(settings, { signal = null } = {}) {
  if (!settings.taskApiBaseUrl) throw new Error('taskApiBaseUrl is required for real mode');
  if (!settings.agentId) throw new Error('agentId is required for real mode');
  const taskApi = createAgentControlTaskApi(settings);
  const taskStore = new TaskStore(storage);
  const tabManager = new TabManager(chrome.tabs);
  const compatibilityTelemetry = new UiCompatibilityTelemetry({ storage });
  const page = new BrowserPageDriver({
    tabManager,
    resourceLoader: new ResourceLoader({ permissions: chrome.permissions }),
    compatibilityTelemetry,
    abortSignal: signal,
    composerPollMs: Number(settings.composerPollIntervalMs) || DEFAULT_SETTINGS.composerPollIntervalMs,
    composerStallTimeoutMs: Number(settings.composerStallTimeoutMs) || DEFAULT_SETTINGS.composerStallTimeoutMs
  });
  const heartbeat = new HeartbeatManager({
    taskApi,
    onLeaseUpdated: (taskId, lease) => taskStore.updateLease(taskId, lease)
  });
  const patchProcessor = new ChromePatchProcessor({
    downloads: chrome.downloads,
    timeoutMs: Number(settings.patchDownloadTimeoutMs) || DEFAULT_SETTINGS.patchDownloadTimeoutMs,
    triggerPageDownload: ({ tabId, clickToken }) => tabManager.send(tabId, { type: 'CHATGPT_CLICK_PATCH', clickToken }),
    abortSignal: signal
  });
  const remoteTransport = settings.patchTransferMode === 'remote' ? new RemoteArtifactTransport({ taskApi }) : null;
  const nativePatchFileReader = new NativePatchFileReader({ runtime: chrome.runtime });
  const remoteFileReader = settings.patchTransferMode === 'remote' ? nativePatchFileReader : null;
  const patchSyncTransport = new PatchSyncArtifactTransport({ fileReader: nativePatchFileReader });
  const artifactTransfer = new ArtifactTransferManager({ mode: settings.patchTransferMode, remoteTransport, remoteFileReader, patchSyncTransport });
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
    patchSyncClientFactory: bootstrap => new PatchSyncClient({
      baseUrl: bootstrap.base_url,
      accessToken: bootstrap.access_token,
      permissions: chrome.permissions
    }),
    fallbackLimit: Number(settings.fallbackLimit) || DEFAULT_SETTINGS.fallbackLimit,
    maxTaskRounds: Number(settings.maxTaskRounds) || DEFAULT_SETTINGS.maxTaskRounds,
    maxWorkspaceRetries: Number.isInteger(Number(settings.workspaceMaxRetries))
      ? Math.max(0, Number(settings.workspaceMaxRetries))
      : DEFAULT_SETTINGS.workspaceMaxRetries,
    abortSignal: signal,
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
    resumeCurrentOnce: () => executeRunner('resumeCurrentOnce'),
    recoverOnce: () => executeRunner('recoverOnce')
  };
}

async function recordRecoveryBootstrapFailure(error, source) {
  const result = {
    status: 'recovery_bootstrap_failed',
    source,
    error: { code: error.code ?? 'UNEXPECTED', message: error.message }
  };
  await storage.set('lastRecovery', result);
  console.error(`[ChatGPT Web Task Runner] ${source} recovery failed`, error);
  return result;
}

const controller = new RuntimeController({
  storage,
  loadMockTasks,
  createMockRunner,
  createRealRunner,
  prepareRealRun,
  terminateRealTask,
  scheduleRecoveryAt: at => {
    const when = Date.parse(at);
    if (!Number.isFinite(when)) throw new Error(`Invalid recovery timestamp: ${at}`);
    chrome.alarms.create(RECOVERY_ALARM_NAME, { when });
  },
  cancelRecovery: () => chrome.alarms.clear(RECOVERY_ALARM_NAME)
});

async function configureAutoRunAlarm(enabled = null) {
  const active = enabled === null ? (await storage.get('autoRunEnabled')) === true : enabled === true;
  await chrome.alarms.clear(AUTO_RUN_ALARM_NAME);
  if (active) {
    chrome.alarms.create(AUTO_RUN_ALARM_NAME, {
      when: Date.now() + 1000,
      periodInMinutes: AUTO_RUN_PERIOD_MINUTES
    });
  }
  return active;
}

const startupRecovery = (async () => {
  await ensureSettings();
  try {
    await ensureChatGptAutomaticDownloadsAllowed();
  } catch (error) {
    console.warn('[ChatGPT Web Task Runner] Automatic downloads permission bootstrap failed', error?.message ?? String(error));
  }
  try {
    await agentHeartbeat.configure();
  } catch (error) {
    console.warn('[ChatGPT Web Task Runner] Agent heartbeat bootstrap failed', error?.message ?? String(error));
  }
  let recovery;
  try {
    recovery = await controller.recoverRealIfNeeded();
  } catch (error) {
    recovery = await recordRecoveryBootstrapFailure(error, 'startup');
  }
  try {
    await configureAutoRunAlarm();
  } catch (error) {
    console.warn('[ChatGPT Web Task Runner] Auto runner alarm bootstrap failed', error?.message ?? String(error));
  }
  return recovery;
})();

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm?.name === AGENT_HEARTBEAT_ALARM_NAME) {
    agentHeartbeat.handleAlarm(alarm).catch(error => {
      console.warn('[ChatGPT Web Task Runner] Agent heartbeat alarm failed', error?.message ?? String(error));
    });
    return;
  }
  if (alarm?.name === AUTO_RUN_ALARM_NAME) {
    (async () => {
      await startupRecovery;
      return controller.runAutoOnce();
    })().catch(error => {
      console.warn('[ChatGPT Web Task Runner] Auto runner alarm failed', error?.message ?? String(error));
    });
    return;
  }
  if (alarm?.name !== RECOVERY_ALARM_NAME) return;
  (async () => {
    await startupRecovery;
    return controller.recoverRealIfNeeded();
  })().catch(error => recordRecoveryBootstrapFailure(error, 'alarm'));
});

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
      case 'SET_AUTO_RUN': {
        const result = await controller.setAutoRunEnabled(message.enabled === true);
        await configureAutoRunAlarm(result.enabled);
        return result;
      }
      case 'PAUSE_RUNNER':
        return controller.pause();
      case 'RESUME_RUNNER':
        return controller.resume();
      case 'TERMINATE_TASK':
        return controller.terminateTask();
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
      case 'GET_CALIBRATION_CAMPAIGN':
        return buildCalibrationCampaign(await calibrationEvidence.getSummary());
      case 'GET_RELEASE_READINESS':
        return buildLiveReleaseReadiness();
      case 'GET_VALIDATION_HANDOFF_BUNDLE':
        return buildLiveValidationHandoffBundle();
      case 'GET_DIAGNOSTIC_SCREENSHOT_POLICY':
        return buildDiagnosticScreenshotPolicy();
      case 'CLEAR_CALIBRATION_EVIDENCE':
        await calibrationEvidence.clear();
        return calibrationEvidence.getSummary();
      case 'TEST_TASK_API_CONNECTION':
        return testTaskApiConnection(message.settings ?? {});
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
        await agentHeartbeat.configure(next);
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
