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
import { ResourceLoader } from './resource-loader.js';
import { ArtifactTransferManager } from './artifact-transfer-manager.js';
import { RemoteArtifactTransport } from './remote-artifact-transport.js';
import { NativePatchFileReader } from './native-patch-file-reader.js';
import { checkNativeHelperReadiness, getNativeHelperReadiness } from './native-helper-readiness.js';
import { UiCompatibilityTelemetry } from './ui-compatibility-telemetry.js';

const DEFAULT_SETTINGS = Object.freeze({
  mode: 'mock',
  taskApiBaseUrl: 'http://127.0.0.1:43127',
  taskApiToken: '',
  heartbeatIntervalMs: 30000,
  fallbackLimit: 2,
  maxTaskRounds: 100,
  patchDownloadTimeoutMs: 60000,
  patchTransferMode: 'local'
});

const storage = chromeStorageAdapter(chrome.storage.local);

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

async function createRealRunner(settings) {
  if (!settings.taskApiBaseUrl) throw new Error('taskApiBaseUrl is required for real mode');
  const taskApi = new HttpTaskApi({ baseUrl: settings.taskApiBaseUrl, token: settings.taskApiToken ?? '' });
  const taskStore = new TaskStore(storage);
  const tabManager = new TabManager(chrome.tabs);
  const compatibilityTelemetry = new UiCompatibilityTelemetry({ storage });
  const page = new BrowserPageDriver({ tabManager, resourceLoader: new ResourceLoader(), compatibilityTelemetry });
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
  const runner = new TaskRunner({
    taskApi,
    taskStore,
    page,
    heartbeat,
    artifactTransfer,
    fallbackLimit: Number(settings.fallbackLimit) || DEFAULT_SETTINGS.fallbackLimit,
    maxTaskRounds: Number(settings.maxTaskRounds) || DEFAULT_SETTINGS.maxTaskRounds,
    processPatch: (candidate, context) => patchProcessor.process(candidate, context)
  });
  const executeRunner = async method => {
    try {
      return await runner[method]();
    } finally {
      patchProcessor.dispose();
    }
  };
  return {
    runOnce: () => executeRunner('runOnce'),
    recoverOnce: () => executeRunner('recoverOnce')
  };
}

const controller = new RuntimeController({ storage, loadMockTasks, createMockRunner, createRealRunner });
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
      case 'CHECK_NATIVE_HELPER':
        return checkNativeHelperReadiness({
          reader: new NativePatchFileReader({ runtime: chrome.runtime }),
          storage
        });
      case 'GET_NATIVE_HELPER_STATUS':
        return getNativeHelperReadiness(storage);
      case 'GET_SETTINGS':
        return { ...DEFAULT_SETTINGS, ...((await storage.get('settings')) ?? {}) };
      case 'SAVE_SETTINGS': {
        const next = { ...DEFAULT_SETTINGS, ...(message.settings ?? {}) };
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
