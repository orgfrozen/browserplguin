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
      observedPatchFilename: null,
      status: 'pending'
    };
    this.intents.push(intent);

    if (candidate.url) {
      const options = { url: candidate.url, conflictAction: 'uniquify', saveAs: false };
      if (candidate.filename) options.filename = candidate.filename;
      try {
        intent.downloadId = await this.downloads.download(options);
        intent.status = 'downloading';
        return structuredClone(intent);
      } catch (cause) {
        intent.status = 'failed';
        const error = new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_FAILED, 'Chrome could not start the Patch download', {
          reason: 'download_start_failed',
          taskId,
          sessionId,
          chromeError: cause?.message ?? String(cause)
        });
        this.onError(error);
        throw error;
      }
    }

    if (!this.triggerPageDownload) {
      const error = new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_FAILED, 'No page download trigger is configured', { intent });
      this.onError(error);
      throw error;
    }

    try {
      const result = await this.triggerPageDownload({ tabId, clickToken: candidate.clickToken, filename: candidate.filename });
      if (result?.ok === false) {
        const reason = result.error === 'CLICK_TARGET_NOT_FOUND' ? 'click_target_not_found' : 'page_download_trigger_failed';
        throw new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_FAILED, 'ChatGPT Patch download control could not be triggered', {
          reason, taskId, sessionId
        });
      }
      return structuredClone(intent);
    } catch (cause) {
      intent.status = 'failed';
      const error = cause instanceof RunnerError ? cause : new RunnerError(
        ERROR_CODES.PATCH_DOWNLOAD_FAILED,
        'ChatGPT Patch download control could not be triggered',
        { reason: 'page_download_trigger_failed', taskId, sessionId }
      );
      this.onError(error);
      throw error;
    }
  }

  #matchingPendingIntents(item, { taskId = null, sessionId = null } = {}) {
    const startedAt = item.startTime ? Date.parse(item.startTime) : this.now();
    const filename = basename(item.filename || item.url);
    return this.intents.filter(intent => {
      if (intent.downloadId != null || intent.status !== 'pending') return false;
      if (taskId != null && intent.taskId !== taskId) return false;
      if (sessionId != null && intent.sessionId !== sessionId) return false;
      if (item.tabId != null && intent.tabId != null && item.tabId !== intent.tabId) return false;
      if (Math.abs(startedAt - intent.triggeredAt) > this.correlationWindowMs) return false;
      if (!isCurrentSessionPatch(filename, intent.sessionId)) return false;
      return !intent.expectedPatchHint || basename(intent.expectedPatchHint) === filename;
    });
  }

  #correlateDownload(item) {
    const filename = basename(item.filename || item.url);
    const matches = this.#matchingPendingIntents(item);
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
    matches[0].observedPatchFilename = filename;
    matches[0].status = 'downloading';
    return matches[0];
  }

  async handleDownloadCreated(item) {
    const intent = this.#correlateDownload(item);
    return intent ? structuredClone(intent) : null;
  }

  async handleDownloadChanged(delta) {
    let intent = this.intents.find(x => x.downloadId === delta.id);
    if (!intent && (delta.filename?.current || delta.state?.current === 'complete' || delta.state?.current === 'interrupted')) {
      const [item] = await this.downloads.search({ id: delta.id });
      if (item) {
        intent = this.#correlateDownload({
          ...item,
          filename: delta.filename?.current ?? item.filename
        });
      }
    }
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
    const filename = basename(item?.filename || delta.filename?.current || intent.observedPatchFilename || intent.expectedPatchHint);
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

  async findCompletedPatchForPending({ taskId, sessionId }) {
    const matches = [];
    const activeIntents = this.intents.filter(intent => intent.taskId === taskId && intent.sessionId === sessionId && intent.status !== 'complete');
    for (const intent of activeIntents.filter(intent => intent.downloadId != null)) {
      const [item] = await this.downloads.search({ id: intent.downloadId });
      const filename = basename(item?.filename || intent.observedPatchFilename || intent.expectedPatchHint);
      if (item?.state !== 'complete' || !isCurrentSessionPatch(filename, sessionId)) continue;
      if (intent.expectedPatchHint && basename(intent.expectedPatchHint) !== filename) continue;
      matches.push({ downloadId: item.id, filename, startTime: item.startTime ?? null });
    }

    const items = await this.downloads.search({ state: 'complete', orderBy: ['-startTime'], limit: 50 });
    for (const item of items ?? []) {
      if (matches.some(match => match.downloadId === item.id)) continue;
      const intents = this.#matchingPendingIntents(item, { taskId, sessionId });
      if (intents.length !== 1) continue;
      matches.push({
        downloadId: item.id,
        filename: basename(item.filename || item.url),
        startTime: item.startTime ?? null
      });
    }
    return matches.length === 1 ? matches[0] : null;
  }


  expirePending({ taskId = null, sessionId = null, reason = 'expired' } = {}) {
    let expired = 0;
    for (const intent of this.intents) {
      if (intent.status !== 'pending' && intent.status !== 'downloading') continue;
      if (taskId != null && intent.taskId !== taskId) continue;
      if (sessionId != null && intent.sessionId !== sessionId) continue;
      intent.status = 'failed';
      intent.failureReason = reason;
      expired += 1;
    }
    return expired;
  }

  recoverPending(intents = []) {
    this.intents = intents.map(x => ({ ...x }));
  }

  snapshotPending() {
    return this.intents.filter(x => x.status === 'pending' || x.status === 'downloading').map(x => structuredClone(x));
  }
}
