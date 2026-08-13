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
  const page = new BrowserPageDriver({ tabManager, resourceLoader: new ResourceLoader() });
  const heartbeat = new HeartbeatManager({
    taskApi,
    intervalMs: Number(settings.heartbeatIntervalMs) || DEFAULT_SETTINGS.heartbeatIntervalMs
  });
  const patchProcessor = new ChromePatchProcessor({
    downloads: chrome.downloads,
    timeoutMs: Number(settings.patchDownloadTimeoutMs) || DEFAULT_SETTINGS.patchDownloadTimeoutMs,
    triggerPageDownload: ({ tabId, clickToken }) => tabManager.send(tabId, { type: 'CHATGPT_CLICK_PATCH', clickToken })
  });
  const runner = new TaskRunner({
    taskApi,
    taskStore,
    page,
    heartbeat,
    fallbackLimit: Number(settings.fallbackLimit) || DEFAULT_SETTINGS.fallbackLimit,
    maxTaskRounds: Number(settings.maxTaskRounds) || DEFAULT_SETTINGS.maxTaskRounds,
    processPatch: (candidate, context) => patchProcessor.process(candidate, context)
  });
  return {
    async runOnce() {
      try {
        return await runner.runOnce();
      } finally {
        patchProcessor.dispose();
      }
    }
  };
}

const controller = new RuntimeController({ storage, loadMockTasks, createMockRunner, createRealRunner });
ensureSettings().catch(error => console.error('[ChatGPT Web Task Runner] settings init failed', error));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'GET_RUNNER_STATUS':
        return controller.getStatus();
      case 'RUN_MOCK_ONCE':
        return controller.runMock(message.taskId ?? null);
      case 'RUN_REAL_ONCE':
        return controller.runReal();
      case 'INSPECT_CHATGPT_UI':
        return inspectChatGptUi(new TabManager(chrome.tabs));
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
