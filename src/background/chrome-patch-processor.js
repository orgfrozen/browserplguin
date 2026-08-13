import { PatchDownloadManager } from './patch-download-manager.js';
import { RunnerError, ERROR_CODES } from '../shared/errors.js';

export class ChromePatchProcessor {
  constructor({ downloads = chrome.downloads, triggerPageDownload, timeoutMs = 60000 }) {
    this.downloads = downloads;
    this.timeoutMs = timeoutMs;
    this.pending = null;
    this.onCreated = item => this.manager.handleDownloadCreated(item).catch(error => this.#reject(error));
    this.onChanged = delta => this.manager.handleDownloadChanged(delta).catch(error => this.#reject(error));
    this.manager = new PatchDownloadManager({
      downloads,
      triggerPageDownload,
      onCompletedPatch: artifact => this.#resolve(artifact),
      onError: error => this.#reject(error)
    });
    downloads.onCreated.addListener(this.onCreated);
    downloads.onChanged.addListener(this.onChanged);
  }

  async process(candidate, { taskId, sessionId }) {
    if (this.pending) {
      throw new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_AMBIGUOUS, 'Only one Patch download may be processed at a time');
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending) return;
        const error = new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_FAILED, `Patch download timed out after ${this.timeoutMs}ms`, {
          filename: candidate.filename ?? null,
          taskId,
          sessionId
        });
        this.#reject(error);
      }, this.timeoutMs);

      this.pending = { resolve, reject, timer };
      this.manager.triggerPatch({
        taskId,
        sessionId,
        tabId: candidate.tabId,
        candidate
      }).catch(error => this.#reject(error));
    });
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
    const { reject, timer } = this.pending;
    clearTimeout(timer);
    this.pending = null;
    reject(error);
  }

  dispose() {
    this.downloads.onCreated.removeListener(this.onCreated);
    this.downloads.onChanged.removeListener(this.onChanged);
    if (this.pending) {
      const error = new RunnerError(ERROR_CODES.PATCH_DOWNLOAD_FAILED, 'Patch processor disposed while download was pending');
      this.#reject(error);
    }
  }
}
