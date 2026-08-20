import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromePatchProcessor } from '../src/background/chrome-patch-processor.js';

function event() {
  const listeners = new Set();
  return {
    addListener(fn) { listeners.add(fn); },
    removeListener(fn) { listeners.delete(fn); },
    emit(value) { for (const fn of [...listeners]) fn(value); },
    size() { return listeners.size; }
  };
}

function downloadsApi() {
  const onCreated = event();
  const onChanged = event();
  return {
    onCreated, onChanged,
    async download() { return 5; },
    async search({ id }) { return [{ id, filename: '/Downloads/patch-s1-001.patch', url: 'blob:x', state: 'complete', tabId: 7 }]; }
  };
}

test('processor resolves only after Chrome reports completed Patch download', async () => {
  const downloads = downloadsApi();
  const processor = new ChromePatchProcessor({ downloads, timeoutMs: 1000, triggerPageDownload: async () => {} });
  const pending = processor.process({ filename: 'patch-s1-001.patch', url: 'blob:x', tabId: 7 }, { taskId: 't1', sessionId: 's1' });
  await Promise.resolve();
  downloads.onChanged.emit({ id: 5, state: { current: 'complete' } });
  const artifact = await pending;
  assert.equal(artifact.patch_key, 'patch-s1-001.patch');
  processor.dispose();
  assert.equal(downloads.onCreated.size(), 0);
  assert.equal(downloads.onChanged.size(), 0);
});

test('processor defaults the local Patch wait window to ten minutes', () => {
  const downloads = downloadsApi();
  const processor = new ChromePatchProcessor({ downloads, triggerPageDownload: async () => {} });
  assert.equal(processor.timeoutMs, 600000);
  processor.dispose();
});

test('processor aborts a pending Patch wait immediately when the Task is terminated', async () => {
  const downloads = downloadsApi();
  const abortController = new AbortController();
  const processor = new ChromePatchProcessor({
    downloads,
    timeoutMs: 600000,
    triggerPageDownload: async () => {},
    abortSignal: abortController.signal
  });
  const pending = processor.process(
    { filename: 'patch-s1-001.patch', url: 'blob:x', tabId: 7 },
    { taskId: 't1', sessionId: 's1' }
  );
  abortController.abort();
  await assert.rejects(pending, error => error?.code === 'TASK_TERMINATED');
  processor.dispose();
});

test('timeout reports completed Chrome history filename for server reconciliation after missed correlation', async () => {
  const downloads = downloadsApi();
  const startedAt = new Date().toISOString();
  downloads.search = async query => {
    if (query.id != null) return [];
    return [{
      id: 256,
      filename: '/Downloads/patch-s1-001.patch',
      url: 'https://chatgpt.com/backend-api/files/patch',
      state: 'complete',
      startTime: startedAt
    }];
  };
  const processor = new ChromePatchProcessor({ downloads, timeoutMs: 10, triggerPageDownload: async () => {} });
  const pending = processor.process(
    { filename: null, url: null, clickToken: 'click-only', tabId: 7 },
    { taskId: 't1', sessionId: 's1' }
  );

  await assert.rejects(pending, error => {
    assert.equal(error?.code, 'PATCH_DOWNLOAD_FAILED');
    assert.equal(error?.details?.filename, 'patch-s1-001.patch');
    assert.equal(error?.details?.downloadId, 256);
    assert.equal(error?.details?.correlation, 'completed_download_history');
    return true;
  });
  processor.dispose();
});

test('timeout reads completed history for a bound download whose complete event was missed', async () => {
  const downloads = downloadsApi();
  const startedAt = new Date().toISOString();
  downloads.search = async query => {
    if (query.id === 77) return [{
      id: 77,
      filename: '/Downloads/patch-s1-001.patch',
      url: 'https://chatgpt.com/backend-api/files/patch',
      state: 'complete',
      startTime: startedAt
    }];
    return [{
      id: 77,
      filename: '/Downloads/patch-s1-001.patch',
      url: 'https://chatgpt.com/backend-api/files/patch',
      state: 'complete',
      startTime: startedAt
    }];
  };
  const processor = new ChromePatchProcessor({ downloads, timeoutMs: 15, triggerPageDownload: async () => {} });
  const pending = processor.process(
    { filename: null, url: null, clickToken: 'click-only', tabId: 7 },
    { taskId: 't1', sessionId: 's1' }
  );
  await Promise.resolve();
  downloads.onCreated.emit({
    id: 77,
    tabId: undefined,
    filename: '/Downloads/patch-s1-001.patch',
    startTime: startedAt
  });

  await assert.rejects(pending, error => {
    assert.equal(error?.details?.filename, 'patch-s1-001.patch');
    assert.equal(error?.details?.downloadId, 77);
    assert.equal(error?.details?.correlation, 'completed_download_history');
    return true;
  });
  processor.dispose();
});
