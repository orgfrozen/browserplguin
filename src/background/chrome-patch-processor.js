import { PatchDownloadManager } from './patch-download-manager.js';
import { RunnerError, ERROR_CODES } from '../shared/errors.js';

export class ChromePatchProcessor {
  constructor({ downloads = chrome.downloads, triggerPageDownload, timeoutMs = 600000, abortSignal = null }) {
    this.downloads = downloads;
    this.timeoutMs = timeoutMs;
    this.abortSignal = abortSignal;
    this.pending = null;
    this.onCreated = item => this.manager.handleDownloadCreated(item).catch(error => this.#reject(error));
    this.onChanged = delta => this.manager.handleDownloadChanged(delta).catch(error => this.#reject(error));
    this.onAbort = () => this.#reject(new RunnerError(ERROR_CODES.TASK_TERMINATED, 'Task execution terminated by operator'));
    this.manager = new PatchDownloadManager({
      downloads,
      triggerPageDownload,
      onCompletedPatch: artifact => this.#resolve(artifact),
      onError: error => this.#reject(error)
    });
    downloads.onCreated.addListener(this.onCreated);
    downloads.onChanged.addListener(this.onChanged);
    this.abortSignal?.addEventListener?.('abort', this.onAbort, { once: true });
  }

  async process(candidate, { taskId, sessionId }) {
    if (this.abortSignal?.aborted) {
      throw new RunnerError(ERROR_CODES.TASK_TERMINATED, 'Task execution terminated by operator');
    }
    if (this.pending) {
      throw new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_AMBIGUOUS, 'Only one Patch download may be processed at a time');
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#rejectTimedOutPatch(candidate, { taskId, sessionId }).catch(error => this.#reject(error));
      }, this.timeoutMs);

      this.pending = { resolve, reject, timer, taskId, sessionId };
      this.manager.triggerPatch({
        taskId,
        sessionId,
        tabId: candidate.tabId,
        candidate
      }).catch(error => this.#reject(error));
    });
  }

  async #rejectTimedOutPatch(candidate, { taskId, sessionId }) {
    if (!this.pending) return;
    let observed = null;
    let correlation = 'no_completed_history_match';
    try {
      observed = await this.manager.findCompletedPatchForPending({ taskId, sessionId });
      if (observed) correlation = 'completed_download_history';
    } catch {
      correlation = 'completed_history_unavailable';
    }
    if (!this.pending) return;
    const error = new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_FAILED, `Patch download timed out after ${this.timeoutMs}ms`, {
      filename: observed?.filename ?? candidate.filename ?? null,
      downloadId: observed?.downloadId ?? null,
      correlation,
      pendingIntentCount: this.manager.snapshotPending().length,
      taskId,
      sessionId
    });
    this.#reject(error);
  }

  #resolve(artifact) {
    if (!this.pending) return;
    const { resolve, timer } = this.pending;
    clearTimeout(timer);
    this.pending = null;
    resolve(artifact);
  }

  #reject(error) {
    if (!this.pending) return;
    const { reject, timer, taskId, sessionId } = this.pending;
    this.manager.expirePending({ taskId, sessionId, reason: error?.details?.reason ?? error?.code ?? 'processor_rejected' });
    clearTimeout(timer);
    this.pending = null;
    reject(error);
  }

  dispose() {
    this.downloads.onCreated.removeListener(this.onCreated);
    this.downloads.onChanged.removeListener(this.onChanged);
    this.abortSignal?.removeEventListener?.('abort', this.onAbort);
    if (this.pending) {
      const error = new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_FAILED, 'Patch processor disposed while download was pending');
      this.#reject(error);
    }
  }
}
