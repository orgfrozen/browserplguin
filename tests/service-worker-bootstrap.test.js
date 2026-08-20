import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('service worker bootstraps settings then automatic recovery before handling messages', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /const startupRecovery\s*=\s*\(async\s*\(\)\s*=>/);
  assert.match(source, /await ensureSettings\(\)[\s\S]*controller\.recoverRealIfNeeded\(\)/);
  assert.match(source, /chrome\.runtime\.onMessage\.addListener[\s\S]*await startupRecovery/);
});

test('Patch local wait defaults to ten minutes and upgrades the legacy 60-second default', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /patchDownloadTimeoutMs:\s*600000/);
  assert.match(source, /Number\(existing\.patchDownloadTimeoutMs\)\s*===\s*60000[\s\S]*patchDownloadTimeoutMs:\s*DEFAULT_SETTINGS\.patchDownloadTimeoutMs/);
});
