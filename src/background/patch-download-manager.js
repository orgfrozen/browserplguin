import { RunnerError, ERROR_CODES } from '../shared/errors.js';
import { isCurrentSessionPatch } from '../shared/patch-identity.js';

function basename(value) {
  return String(value ?? '').split(/[\\/]/).pop();
}

export class PatchDownloadManager {
  constructor({
    downloads,
    now = () => Date.now(),
    correlationWindowMs = 10000,
    triggerPageDownload = null,
    onCompletedPatch = () => {},
    onError = () => {}
  }) {
    this.downloads = downloads;
    this.now = now;
    this.correlationWindowMs = correlationWindowMs;
    this.triggerPageDownload = triggerPageDownload;
    this.onCompletedPatch = onCompletedPatch;
    this.onError = onError;
    this.intents = [];
    this.completedDownloadIds = new Set();
  }

  async triggerPatch({ taskId, sessionId, tabId, candidate }) {
    const intent = {
      taskId,
      sessionId,
      tabId,
      triggeredAt: this.now(),
      expectedPatchHint: candidate.filename ?? null,
      controlKey: candidate.control_key ?? null,
      clickToken: candidate.clickToken ?? null,
      downloadId: null,
      status: 'pending'
    };
    this.intents.push(intent);

    if (candidate.url) {
      const options = { url: candidate.url, conflictAction: 'uniquify', saveAs: false };
      if (candidate.filename) options.filename = candidate.filename;
      intent.downloadId = await this.downloads.download(options);
      intent.status = 'downloading';
      return structuredClone(intent);
    }

    if (!this.triggerPageDownload) {
      const error = new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_FAILED, 'No page download trigger is configured', { intent });
      this.onError(error);
      throw error;
    }

    await this.triggerPageDownload({ tabId, clickToken: candidate.clickToken, filename: candidate.filename });
    return structuredClone(intent);
  }

  async handleDownloadCreated(item) {
    const startedAt = item.startTime ? Date.parse(item.startTime) : this.now();
    const filename = basename(item.filename || item.url);
    const matches = this.intents.filter(intent => {
      if (intent.downloadId != null || intent.status !== 'pending') return false;
      if (item.tabId != null && intent.tabId != null && item.tabId !== intent.tabId) return false;
      if (Math.abs(startedAt - intent.triggeredAt) > this.correlationWindowMs) return false;
      if (!isCurrentSessionPatch(filename, intent.sessionId)) return false;
      return !intent.expectedPatchHint || basename(intent.expectedPatchHint) === filename;
    });

    if (matches.length > 1) {
      const error = new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_AMBIGUOUS, 'Multiple pending Patch intents match one Chrome download', {
        downloadId: item.id,
        filename,
        matchingTaskIds: matches.map(x => x.taskId)
      });
      this.onError(error);
      return null;
    }
    if (matches.length === 0) return null;

    matches[0].downloadId = item.id;
    matches[0].status = 'downloading';
    return structuredClone(matches[0]);
  }

  async handleDownloadChanged(delta) {
    const intent = this.intents.find(x => x.downloadId === delta.id);
    if (!intent) return null;

    const state = delta.state?.current;
    if (state === 'interrupted') {
      intent.status = 'failed';
      const error = new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_FAILED, 'Patch download was interrupted', {
        taskId: intent.taskId,
        sessionId: intent.sessionId,
        downloadId: delta.id,
        chromeError: delta.error?.current ?? null
      });
      this.onError(error);
      return null;
    }

    if (state !== 'complete' || this.completedDownloadIds.has(delta.id)) return null;

    const [item] = await this.downloads.search({ id: delta.id });
    const filename = basename(item?.filename || intent.expectedPatchHint);
    if (!isCurrentSessionPatch(filename, intent.sessionId)) {
      const error = new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_FAILED, 'Completed file does not match current Session Patch identity', {
        taskId: intent.taskId, sessionId: intent.sessionId, downloadId: delta.id, filename
      });
      this.onError(error);
      return null;
    }

    this.completedDownloadIds.add(delta.id);
    intent.status = 'complete';
    const artifact = {
      task_id: intent.taskId,
      session_id: intent.sessionId,
      download_id: delta.id,
      filename,
      local_path: item?.filename ?? null,
      source_url: item?.url ?? null,
      patch_key: filename,
      control_key: intent.controlKey
    };
    await this.onCompletedPatch(artifact);
    return artifact;
  }

  recoverPending(intents = []) {
    this.intents = intents.map(x => ({ ...x }));
  }

  snapshotPending() {
    return this.intents.filter(x => x.status !== 'complete').map(x => structuredClone(x));
  }
}
