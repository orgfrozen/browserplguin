import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('service worker bootstraps settings then automatic recovery before handling messages', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /const startupRecovery\s*=\s*\(async\s*\(\)\s*=>/);
  assert.match(source, /await ensureSettings\(\)[\s\S]*controller\.recoverRealIfNeeded\(\)/);
  assert.match(source, /chrome\.runtime\.onMessage\.addListener[\s\S]*await startupRecovery/);
});
