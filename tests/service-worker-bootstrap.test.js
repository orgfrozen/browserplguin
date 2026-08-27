import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('service worker keeps popup/control messages responsive while startup recovery continues in background', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /const startupReady\s*=\s*\(async\s*\(\)\s*=>/);
  assert.match(source, /const startupRecovery\s*=\s*startupReady\.then/);
  assert.match(source, /chrome\.runtime\.onMessage\.addListener[\s\S]*await startupReady/);
  const listenerAt = source.indexOf('chrome.runtime.onMessage.addListener');
  const listener = source.slice(listenerAt);
  assert.equal(listener.includes('await startupRecovery'), false, 'popup/control messages must not await long startup recovery');
});

test('Patch local wait defaults to ten minutes and upgrades the legacy 60-second default', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /patchDownloadTimeoutMs:\s*600000/);
  assert.match(source, /Number\(existing\.patchDownloadTimeoutMs\)\s*===\s*60000[\s\S]*patchDownloadTimeoutMs:\s*DEFAULT_SETTINGS\.patchDownloadTimeoutMs/);
});
