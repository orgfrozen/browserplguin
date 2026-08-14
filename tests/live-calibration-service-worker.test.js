import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('service worker exposes the read-only live calibration command', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ runLiveCalibration \} from '\.\/live-calibration\.js';/);
  assert.match(source, /case 'RUN_CHATGPT_CALIBRATION':\s*return runLiveCalibration\(new TabManager\(chrome\.tabs\)\);/);
});
