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
