import test from 'node:test';
import assert from 'node:assert/strict';
import { PatchDownloadManager } from '../src/background/patch-download-manager.js';
import { ERROR_CODES } from '../src/shared/errors.js';

function fakeDownloads() {
  const calls = [];
  return {
    calls,
    async download(options) { calls.push(options); return 41; },
    async search(query) { return [{ id: query.id, filename: '/Downloads/patch-s1-001.patch', url: 'blob:x', state: 'complete', tabId: 7 }]; }
  };
}

test('direct URL binds returned download id immediately', async () => {
  const downloads = fakeDownloads();
  const manager = new PatchDownloadManager({ downloads, now: () => 1000 });
  const intent = await manager.triggerPatch({ taskId: 't1', sessionId: 's1', tabId: 7, candidate: { filename: 'patch-s1-001.patch', url: 'blob:x' } });
  assert.equal(intent.downloadId, 41);
  assert.equal(downloads.calls.length, 1);
});

test('click fallback creates unbound intent and asks page trigger to click', async () => {
  const clicks = [];
  const manager = new PatchDownloadManager({ downloads: fakeDownloads(), now: () => 1000, triggerPageDownload: async x => clicks.push(x) });
  const intent = await manager.triggerPatch({ taskId: 't1', sessionId: 's1', tabId: 7, candidate: { filename: 'patch-s1-001.patch', url: null, clickToken: 'c1' } });
  assert.equal(intent.downloadId, null);
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].clickToken, 'c1');
});

test('created download correlates by tab time and current-session patch identity', async () => {
  const manager = new PatchDownloadManager({ downloads: fakeDownloads(), now: () => 1000, correlationWindowMs: 5000, triggerPageDownload: async () => {} });
  await manager.triggerPatch({ taskId: 't1', sessionId: 's1', tabId: 7, candidate: { filename: 'patch-s1-001.patch', url: null, clickToken: 'c1' } });
  const intent = await manager.handleDownloadCreated({ id: 9, tabId: 7, filename: '/Downloads/patch-s1-001.patch', url: 'blob:x', startTime: new Date(1200).toISOString() });
  assert.equal(intent.downloadId, 9);
});

test('ambiguous download correlation reports explicit error', async () => {
  const errors = [];
  const manager = new PatchDownloadManager({ downloads: fakeDownloads(), now: () => 1000, correlationWindowMs: 5000, triggerPageDownload: async () => {}, onError: e => errors.push(e) });
  await manager.triggerPatch({ taskId: 't1', sessionId: 's1', tabId: 7, candidate: { filename: 'patch-s1-001.patch', url: null, clickToken: 'a' } });
  await manager.triggerPatch({ taskId: 't1', sessionId: 's1', tabId: 7, candidate: { filename: 'patch-s1-001.patch', url: null, clickToken: 'b' } });
  await manager.handleDownloadCreated({ id: 10, tabId: 7, filename: '/Downloads/patch-s1-001.patch', startTime: new Date(1200).toISOString() });
  assert.equal(errors[0].code, ERROR_CODES.PATCH_DOWNLOAD_AMBIGUOUS);
});

test('complete event emits artifact once and interrupted emits failure', async () => {
  const completed = [];
  const errors = [];
  const downloads = fakeDownloads();
  const manager = new PatchDownloadManager({ downloads, now: () => 1000, onCompletedPatch: a => completed.push(a), onError: e => errors.push(e) });
  await manager.triggerPatch({ taskId: 't1', sessionId: 's1', tabId: 7, candidate: { filename: 'patch-s1-001.patch', url: 'blob:x' } });
  await manager.handleDownloadChanged({ id: 41, state: { current: 'complete' } });
  await manager.handleDownloadChanged({ id: 41, state: { current: 'complete' } });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].filename, 'patch-s1-001.patch');

  await manager.triggerPatch({ taskId: 't1', sessionId: 's1', tabId: 7, candidate: { filename: 'patch-s1-002.patch', url: 'blob:y' } });
  // fake adapter always returns id 41, so use a separate click-created intent for interruption
  const manager2 = new PatchDownloadManager({ downloads, now: () => 1000, triggerPageDownload: async () => {}, onError: e => errors.push(e) });
  await manager2.triggerPatch({ taskId: 't1', sessionId: 's1', tabId: 7, candidate: { filename: 'patch-s1-003.patch', clickToken: 'c' } });
  await manager2.handleDownloadCreated({ id: 99, tabId: 7, filename: '/Downloads/patch-s1-003.patch', startTime: new Date(1100).toISOString() });
  await manager2.handleDownloadChanged({ id: 99, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
  assert.equal(errors.at(-1).code, ERROR_CODES.PATCH_DOWNLOAD_FAILED);
});

test('click-only Patch control can bind after Chrome reveals the actual session filename', async () => {
  const manager = new PatchDownloadManager({ downloads: fakeDownloads(), now: () => 1000, correlationWindowMs: 5000, triggerPageDownload: async () => {} });
  await manager.triggerPatch({ taskId: 't1', sessionId: 's1', tabId: 7, candidate: { filename: null, label: '下载 Patch', clickToken: 'c9' } });
  const intent = await manager.handleDownloadCreated({ id: 88, tabId: 7, filename: '/Downloads/patch-s1-004.patch', startTime: new Date(1200).toISOString() });
  assert.equal(intent.downloadId, 88);
  assert.equal(intent.expectedPatchHint, null);
});
