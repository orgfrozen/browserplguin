import { RuntimeController } from './runtime-controller.js';
import { MockTaskApi } from './mock-task-api.js';
import { AgentControlTaskApi } from './agent-control-task-api.js';
import { TaskStore, BrowserTabSlotStore, createSlotStorageView, chromeStorageAdapter } from './task-store.js';
import { MultiSlotRuntimeController, normalizeMaxParallelTasks } from './multi-slot-runtime-controller.js';
import { MockPageDriver } from './mock-page-driver.js';
import { BrowserPageDriver } from './browser-page-driver.js';
import { TabManager } from './tab-manager.js';
import { TaskRunner } from './task-runner.js';
import { HeartbeatManager } from './heartbeat-manager.js';
import { AgentHeartbeatManager, AGENT_HEARTBEAT_ALARM_NAME, buildAgentCapacityDiagnostics, buildAgentInfrastructureDiagnostics } from './agent-heartbeat-manager.js';
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
import { nextRecoveryAlarmWhen } from './recovery-alarm-scheduler.js';
import { normalizeControlPlaneUrl } from '../shared/control-plane-url.js';
import { UiActionQueue } from './ui-action-queue.js';
import { TabSlotHeartbeatManager, TAB_SLOT_HEARTBEAT_ALARM_NAME } from './tab-slot-heartbeat-manager.js';

const RECOVERY_ALARM_NAME = 'browser-task-recovery';
const CLEANUP_RETRY_ALARM_PREFIX = 'browser-task-cleanup-retry';
const AUTO_RUN_ALARM_NAME = 'browser-task-auto-run';
const AUTO_RUN_PERIOD_MINUTES = 0.5;
const RECOVERY_BOOTSTRAP_RETRY_MS = 2000;

function recoveryAlarmName(slotId = 'chatgpt-1') {
  return slotId === 'chatgpt-1' ? RECOVERY_ALARM_NAME : `${RECOVERY_ALARM_NAME}:${slotId}`;
}

function cleanupRetryAlarmName(slotId = 'chatgpt-1') {
  return `${CLEANUP_RETRY_ALARM_PREFIX}:${slotId}`;
}

function slotIdFromCleanupRetryAlarm(name) {
  const prefix = `${CLEANUP_RETRY_ALARM_PREFIX}:`;
  if (typeof name !== 'string' || !name.startsWith(prefix)) return null;
  const slotId = name.slice(prefix.length);
  return /^chatgpt-[1-5]$/.test(slotId) ? slotId : null;
}

function slotIdFromRecoveryAlarm(name) {
  if (name === RECOVERY_ALARM_NAME) return 'chatgpt-1';
  const prefix = `${RECOVERY_ALARM_NAME}:`;
  if (typeof name !== 'string' || !name.startsWith(prefix)) return null;
  const slotId = name.slice(prefix.length);
  return /^chatgpt-[1-5]$/.test(slotId) ? slotId : null;
}

const DEFAULT_SETTINGS = Object.freeze({
  mode: 'mock',
  taskApiBaseUrl: 'http://127.0.0.1:43127',
  taskApiToken: '',
  agentId: '',
  heartbeatIntervalMs: 30000,
  fallbackLimit: 2,
  maxTaskRounds: 100,
  maxParallelTasks: 1,
  composerPollIntervalMs: 2000,
  composerStallTimeoutMs: 180000,
  workspaceMaxRetries: 5,
  cleanupLegacyProjects: false,
  patchDownloadTimeoutMs: 600000,
  patchTransferMode: 'local',
  remoteE2eTestMode: false,
  remoteProductionMode: false
});

const storage = chromeStorageAdapter(chrome.storage.local);
const browserTabSlotStore = new BrowserTabSlotStore(storage);
const uiActionQueue = new UiActionQueue({ tabs: chrome.tabs, slotStore: browserTabSlotStore });
const tabSlotHeartbeat = new TabSlotHeartbeatManager({
  alarms: chrome.alarms,
  tabManager: new TabManager(chrome.tabs),
  slotStore: browserTabSlotStore
});
const calibrationEvidence = new CalibrationEvidenceLedger({ storage });
const remoteE2eEvidence = new RemoteE2eEvidenceLedger({ storage });
const resourceE2eEvidence = new ResourceE2eEvidenceLedger({ storage });

function createAgentControlTaskApi(settings, { claimMode = 'resume_or_next', onCommand = null, commandStorage = storage } = {}) {
  return new AgentControlTaskApi({
    baseUrl: settings.taskApiBaseUrl,
    token: settings.taskApiToken ?? '',
    agentId: settings.agentId,
    executorRef: chrome.runtime.id,
    claimMode,
    onCommand,
    commandStorage
  });
}

async function recordAgentControlTelemetry(storageView, event) {
  if (!event?.operation) return;
  const current = (await storageView.get('agentControlTelemetry')) ?? {};
  await storageView.set('agentControlTelemetry', {
    ...current,
    last_event: structuredClone(event),
    [event.operation]: structuredClone(event)
  });
}

async function loadEffectiveSettings() {
  const settings = { ...DEFAULT_SETTINGS, ...((await storage.get('settings')) ?? {}) };
  return { ...settings, taskApiBaseUrl: normalizeControlPlaneUrl(settings.taskApiBaseUrl) };
}

async function loadAgentHeartbeatDiagnostics() {
  const slots = await browserTabSlotStore.list();
  const active = [];
  for (const slot of slots) {
    if (slot?.status !== 'assigned' || !slot?.task_id) continue;
    const execution = await createSlotStorageView(storage, slot.slot_id).get('activeExecution');
    if (!execution?.task_id || execution.task_id !== slot.task_id) continue;
    active.push({
      slot_id: slot.slot_id,
      project_id: execution.project_id ?? null,
      task_id: execution.task_id,
      phase: execution.phase ?? null,
      started_at: slot.assigned_at ?? execution.initialization_started_at ?? null,
      last_progress_at: slot.last_progress_at ?? null,
      recovery_count: Math.max(0, Number(slot.recovery_count) || 0),
      tab_id: Number.isInteger(Number(slot.tab_id)) ? Number(slot.tab_id) : null
    });
  }
  const runtimeStatus = await controller.getStatus();
  return {
    slots: active,
    ...buildAgentCapacityDiagnostics(runtimeStatus),
    ...buildAgentInfrastructureDiagnostics(runtimeStatus)
  };
}

const agentHeartbeat = new AgentHeartbeatManager({
  alarms: chrome.alarms,
  createTaskApi: createAgentControlTaskApi,
  loadSettings: loadEffectiveSettings,
  loadDiagnostics: loadAgentHeartbeatDiagnostics
});

async function focusTaskTab(slotId) {
  if (!/^chatgpt-[1-5]$/.test(String(slotId ?? ''))) return { status: 'invalid_slot', slot_id: slotId ?? null };
  const slot = await browserTabSlotStore.load(slotId);
  if (slot?.status !== 'assigned' || !slot?.task_id) return { status: 'no_active_task', slot_id: slotId };
  const tabId = Number(slot.tab_id);
  if (!Number.isInteger(tabId)) return { status: 'no_tab', slot_id: slotId };
  await new TabManager(chrome.tabs).activateTab(tabId);
  return { status: 'focused', slot_id: slotId, tab_id: tabId };
}

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
  const migratedTaskApiBaseUrl = normalizeControlPlaneUrl(existing.taskApiBaseUrl);
  const maxParallelTasks = normalizeMaxParallelTasks(existing.maxParallelTasks, DEFAULT_SETTINGS.maxParallelTasks);
  if (
    Number(existing.patchDownloadTimeoutMs) === 60000
    || migratedTaskApiBaseUrl !== existing.taskApiBaseUrl
    || maxParallelTasks !== Number(existing.maxParallelTasks)
  ) {
    await storage.set('settings', {
      ...existing,
      ...(Number(existing.patchDownloadTimeoutMs) === 60000 ? { patchDownloadTimeoutMs: DEFAULT_SETTINGS.patchDownloadTimeoutMs } : {}),
      ...(migratedTaskApiBaseUrl !== existing.taskApiBaseUrl ? { taskApiBaseUrl: migratedTaskApiBaseUrl } : {}),
      ...(maxParallelTasks !== Number(existing.maxParallelTasks) ? { maxParallelTasks } : {})
    });
  }
}

async function setCleanupLegacyProjects(enabled) {
  const current = (await storage.get('settings')) ?? {};
  const next = { ...DEFAULT_SETTINGS, ...current, cleanupLegacyProjects: enabled === true };
  await storage.set('settings', next);
  return { status: 'cleanup_legacy_projects_updated', enabled: next.cleanupLegacyProjects };
}

async function loadMockTasks() {
  const response = await fetch(chrome.runtime.getURL('mock/tasks.json'));
  if (!response.ok) throw new Error(`mock tasks load failed: ${response.status}`);
  return response.json();
}

function createMockRunnerForStorage(task, storageView) {
  const api = new MockTaskApi([task]);
  const taskStore = new TaskStore(storageView);
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

function createMockRunner(task) {
  return createMockRunnerForStorage(task, storage);
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

async function terminateRealTask({ activeExecution, settings, slotId = 'chatgpt-1' }) {
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
    const page = new BrowserPageDriver({ tabManager, tabSlotStore: browserTabSlotStore, slotId, uiActionQueue, resourceLoader: new ResourceLoader({ permissions: chrome.permissions }), compatibilityTelemetry });
    try {
      await page.deleteTaskProject({ project: { ...(activeExecution.task_project ?? {}), project_name: projectName } });
      await page.releaseTaskTab({ state: activeExecution });
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

async function parkExternalWait({ activeExecution, slotId = 'chatgpt-1' }) {
  if (!activeExecution?.task_id) throw new Error('activeExecution.task_id is required for external-wait parking');
  const tabManager = new TabManager(chrome.tabs);
  const compatibilityTelemetry = new UiCompatibilityTelemetry({ storage });
  const page = new BrowserPageDriver({
    tabManager,
    tabSlotStore: browserTabSlotStore,
    slotId,
    uiActionQueue,
    resourceLoader: new ResourceLoader({ permissions: chrome.permissions }),
    compatibilityTelemetry
  });
  await page.releaseTaskTab({ state: activeExecution });
  return { status: 'parked' };
}

async function parkCleanupRetry({ activeExecution, slotId = 'chatgpt-1' }) {
  if (!activeExecution?.task_id) throw new Error('activeExecution.task_id is required for cleanup parking');
  const tabManager = new TabManager(chrome.tabs);
  const compatibilityTelemetry = new UiCompatibilityTelemetry({ storage });
  const page = new BrowserPageDriver({
    tabManager,
    tabSlotStore: browserTabSlotStore,
    slotId,
    uiActionQueue,
    resourceLoader: new ResourceLoader({ permissions: chrome.permissions }),
    compatibilityTelemetry
  });
  try {
    await page.releaseTaskTab({ state: activeExecution });
  } catch {
    const slot = await browserTabSlotStore.load(slotId);
    if (slot?.task_id === activeExecution.task_id) {
      await browserTabSlotStore.release({
        taskId: activeExecution.task_id,
        tabId: Number.isInteger(Number(slot.tab_id)) ? Number(slot.tab_id) : null,
        slotId
      });
    }
  }
  return { status: 'cleanup_parked' };
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
  return createRealRunnerForSlot(settings, { signal });
}

async function createRealRunnerForSlot(settings, {
  signal = null,
  slotId = 'chatgpt-1',
  storageView = storage,
  claimMode = 'resume_or_next'
} = {}) {
  if (!settings.taskApiBaseUrl) throw new Error('taskApiBaseUrl is required for real mode');
  if (!settings.agentId) throw new Error('agentId is required for real mode');
  const taskApi = createAgentControlTaskApi(settings, {
    claimMode,
    onCommand: event => recordAgentControlTelemetry(storageView, event),
    commandStorage: storageView
  });
  const taskStore = new TaskStore(storageView);
  const tabManager = new TabManager(chrome.tabs);
  const tabSlotStore = browserTabSlotStore;
  const compatibilityTelemetry = new UiCompatibilityTelemetry({ storage });
  const page = new BrowserPageDriver({
    tabManager,
    tabSlotStore,
    slotId,
    uiActionQueue,
    resourceLoader: new ResourceLoader({ permissions: chrome.permissions }),
    compatibilityTelemetry,
    cleanupLegacyProjects: settings.cleanupLegacyProjects === true,
    onLegacyProjectCleanupWarning: warning => console.warn('[ChatGPT Web Task Runner] Legacy Project cleanup failed', warning?.project_name ?? '', warning?.message ?? ''),
    abortSignal: signal,
    composerPollMs: Number(settings.composerPollIntervalMs) || DEFAULT_SETTINGS.composerPollIntervalMs,
    composerStallTimeoutMs: Number(settings.composerStallTimeoutMs) || DEFAULT_SETTINGS.composerStallTimeoutMs
  });
  const heartbeat = new HeartbeatManager({
    taskApi,
    onLeaseUpdated: (taskId, lease) => taskStore.updateLease(taskId, lease),
    onHeartbeatSuccess: taskId => browserTabSlotStore.recordExecutionHeartbeat({
      slotId,
      taskId,
      heartbeatAt: new Date().toISOString()
    })
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

async function rearmStoredRecoveryIfNeeded(slotId = 'chatgpt-1') {
  if ((await storage.get('manualPaused')) === true) return false;
  const settings = (await storage.get('settings')) ?? {};
  if (settings.mode !== 'real') return false;
  const slotStorage = createSlotStorageView(storage, slotId);
  const activeExecution = await slotStorage.get('activeExecution');
  if (!activeExecution?.next_recovery_at) return false;
  const when = nextRecoveryAlarmWhen({
    activeExecution,
    retryDelayMs: RECOVERY_BOOTSTRAP_RETRY_MS
  });
  if (!Number.isFinite(when)) return false;
  if (slotId === 'chatgpt-1') chrome.alarms.create(RECOVERY_ALARM_NAME, { when });
  else chrome.alarms.create(recoveryAlarmName(slotId), { when });
  return true;
}

async function recordRecoveryBootstrapFailure(error, source, slotId = 'chatgpt-1') {
  const result = {
    status: 'recovery_bootstrap_failed',
    source,
    slot_id: slotId,
    error: { code: error.code ?? 'UNEXPECTED', message: error.message }
  };
  await createSlotStorageView(storage, slotId).set('lastRecovery', result);
  console.error(`[ChatGPT Web Task Runner] ${source} recovery failed`, error);
  try {
    await rearmStoredRecoveryIfNeeded(slotId);
  } catch (rearmError) {
    console.warn('[ChatGPT Web Task Runner] Recovery alarm rearm failed', rearmError?.message ?? String(rearmError));
  }
  return result;
}

async function closeIdleBrowserSlot(slot) {
  const tabId = Number(slot?.tab_id);
  if (Number.isInteger(tabId)) {
    try {
      await new TabManager(chrome.tabs).closeTab(tabId);
    } catch (error) {
      if (!/no tab with id|tab not found/i.test(String(error?.message ?? error))) throw error;
    }
  }
  await browserTabSlotStore.release({
    taskId: null,
    tabId: null,
    slotId: slot?.slot_id ?? 'chatgpt-1'
  });
}

function createSlotRuntimeController({ slotId, storage }) {
  const createMockRunner = task => createMockRunnerForStorage(task, storage);
  const createRealRunner = (settings, context = {}) => createRealRunnerForSlot(settings, {
    ...context,
    slotId,
    storageView: storage,
    claimMode: 'next_only'
  });
  const terminateSlotRealTask = args => terminateRealTask({ ...args, slotId });
  const parkSlotExternalWait = ({ state }) => parkExternalWait({ activeExecution: state, slotId });
  const parkSlotCleanupRetry = ({ state }) => parkCleanupRetry({ activeExecution: state, slotId });
  return new RuntimeController({
    storage,
    loadMockTasks,
    createMockRunner,
    createRealRunner,
    prepareRealRun,
    terminateRealTask: terminateSlotRealTask,
    parkExternalWait: parkSlotExternalWait,
    parkCleanupRetry: parkSlotCleanupRetry,
    terminationPausesSharedRunner: false,
    scheduleRecoveryAt: at => {
      const when = Date.parse(at);
      if (!Number.isFinite(when)) throw new Error(`Invalid recovery timestamp: ${at}`);
      if (slotId === 'chatgpt-1') chrome.alarms.create(RECOVERY_ALARM_NAME, { when });
      else chrome.alarms.create(recoveryAlarmName(slotId), { when });
    },
    cancelRecovery: () => slotId === 'chatgpt-1'
      ? chrome.alarms.clear(RECOVERY_ALARM_NAME)
      : chrome.alarms.clear(recoveryAlarmName(slotId)),
    scheduleCleanupRetryAt: at => {
      const when = Date.parse(at);
      if (!Number.isFinite(when)) throw new Error(`Invalid cleanup retry timestamp: ${at}`);
      chrome.alarms.create(cleanupRetryAlarmName(slotId), { when });
    },
    cancelCleanupRetry: () => chrome.alarms.clear(cleanupRetryAlarmName(slotId))
  });
}

async function openBrowserRecoveryCircuit({ slotId, taskId, reason, recoveryCount, openedAt }) {
  if (slotId === 'chatgpt-1') await chrome.alarms.clear(RECOVERY_ALARM_NAME);
  else await chrome.alarms.clear(recoveryAlarmName(slotId));
  const slotStorage = createSlotStorageView(storage, slotId);
  const activeExecution = await slotStorage.get('activeExecution');
  if (!activeExecution?.task_id || activeExecution.task_id !== taskId || !activeExecution.lease) return false;
  const settings = await loadEffectiveSettings();
  const taskApi = createAgentControlTaskApi(settings, { claimMode: 'next_only', commandStorage: slotStorage });
  taskApi.restoreLease(taskId, activeExecution.lease);
  await taskApi.waitingHumanTask(taskId, {
    reason: 'browser_recovery_circuit_open',
    recovery_reason: reason,
    recovery_count: recoveryCount,
    opened_at: openedAt,
    slot_id: slotId
  });
  return true;
}

const controller = new MultiSlotRuntimeController({
  storage,
  slotStore: browserTabSlotStore,
  closeIdleSlot: closeIdleBrowserSlot,
  openRecoveryCircuit: openBrowserRecoveryCircuit,
  pressureProvider: () => uiActionQueue.getStats(),
  createController: createSlotRuntimeController
});

async function recordTabSlotObservation(message, sender) {
  const tabId = Number(sender?.tab?.id);
  if (!Number.isInteger(tabId)) return { status: 'ignored', reason: 'missing_tab' };
  const slot = await browserTabSlotStore.findByTabId(tabId);
  if (!slot) return { status: 'ignored', reason: 'unowned_tab', tab_id: tabId };
  const observed = await browserTabSlotStore.recordObservation({
    slotId: slot.slot_id,
    tabId,
    generation: slot.generation,
    state: message?.state,
    contextLimit: message?.contextLimit === true,
    responseFailure: message?.responseFailure ?? null,
    source: message?.type === 'CHATGPT_SLOT_HEARTBEAT' ? 'content_heartbeat' : 'content_event',
    observedAt: message?.observedAt ?? new Date().toISOString()
  });
  return {
    status: 'recorded',
    slot_id: observed?.slot_id ?? slot.slot_id,
    generation: observed?.generation ?? slot.generation,
    state: observed?.last_observed_state ?? null
  };
}

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

chrome.tabs.onRemoved.addListener(tabId => {
  controller.handleTabRemoved(tabId, 'removed').catch(error => {
    console.warn('[ChatGPT Web Task Runner] Closed worker tab recovery failed', error?.message ?? String(error));
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo?.discarded !== true) return;
  controller.handleTabRemoved(tabId, 'discarded').catch(error => {
    console.warn('[ChatGPT Web Task Runner] Discarded worker tab recovery failed', error?.message ?? String(error));
  });
});

const startupReady = (async () => {
  await ensureSettings();
  try {
    await ensureChatGptAutomaticDownloadsAllowed();
  } catch (error) {
    console.warn('[ChatGPT Web Task Runner] Automatic downloads permission bootstrap failed', error?.message ?? String(error));
  }
  try {
    await agentHeartbeat.configure(null, { sendImmediately: false });
  } catch (error) {
    console.warn('[ChatGPT Web Task Runner] Agent heartbeat bootstrap failed', error?.message ?? String(error));
  }
  try {
    await tabSlotHeartbeat.configure();
  } catch (error) {
    console.warn('[ChatGPT Web Task Runner] Tab slot heartbeat bootstrap failed', error?.message ?? String(error));
  }
  try {
    await configureAutoRunAlarm();
  } catch (error) {
    console.warn('[ChatGPT Web Task Runner] Auto runner alarm bootstrap failed', error?.message ?? String(error));
  }
  return true;
})();

const startupRecovery = startupReady.then(async () => {
  try {
    return await controller.recoverRealIfNeeded();
  } catch (error) {
    return recordRecoveryBootstrapFailure(error, 'startup');
  }
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm?.name === TAB_SLOT_HEARTBEAT_ALARM_NAME) {
    (async () => {
      await tabSlotHeartbeat.runOnce();
      await controller.runWatchdogOnce();
    })().catch(error => {
      console.warn('[ChatGPT Web Task Runner] Tab slot heartbeat/watchdog failed', error?.message ?? String(error));
    });
    return;
  }
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
  const cleanupSlotId = slotIdFromCleanupRetryAlarm(alarm?.name);
  if (cleanupSlotId) {
    (async () => {
      await startupRecovery;
      return controller.retryCleanup(cleanupSlotId);
    })().catch(error => recordRecoveryBootstrapFailure(error, 'cleanup_alarm', cleanupSlotId));
    return;
  }
  if (alarm?.name !== RECOVERY_ALARM_NAME && !slotIdFromRecoveryAlarm(alarm?.name)) return;
  const slotId = slotIdFromRecoveryAlarm(alarm?.name);
  if (!slotId) return;
  (async () => {
    await startupRecovery;
    return controller.recoverReal(slotId, { automatic: true });
  })().catch(error => recordRecoveryBootstrapFailure(error, 'alarm', slotId));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'CHATGPT_SLOT_STATE' || message?.type === 'CHATGPT_SLOT_HEARTBEAT') {
      return recordTabSlotObservation(message, sender);
    }
    await startupReady;
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
      case 'SET_CLEANUP_LEGACY_PROJECTS':
        return setCleanupLegacyProjects(message.enabled === true);
      case 'SET_MAX_PARALLEL_TASKS': {
        const result = await controller.setMaxParallelTasks(message.maxParallelTasks);
        await agentHeartbeat.configure();
        return result;
      }
      case 'SET_DRAIN_MODE':
        return controller.setDrainEnabled(message.enabled === true);
      case 'PAUSE_RUNNER':
        return controller.pause();
      case 'RESUME_RUNNER':
        return controller.resume();
      case 'TERMINATE_TASK':
        return controller.terminateTask(message.slotId ?? null);
      case 'FOCUS_TASK_TAB':
        return focusTaskTab(message.slotId);
      case 'RECOVER_REAL_TASK':
        return controller.recoverReal(message.slotId ?? null);
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
