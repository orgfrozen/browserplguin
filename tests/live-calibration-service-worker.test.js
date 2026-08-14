import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('service worker exposes live calibration evidence record/read/clear wiring', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ CalibrationEvidenceLedger \} from '\.\/calibration-evidence-ledger\.js';/);
  assert.match(source, /const calibrationEvidence = new CalibrationEvidenceLedger\(\{ storage \}\);/);
  assert.match(source, /case 'RUN_CHATGPT_CALIBRATION':\s*return runLiveCalibration\(new TabManager\(chrome\.tabs\), calibrationEvidence\);/);
  assert.match(source, /case 'GET_CALIBRATION_EVIDENCE':\s*return calibrationEvidence\.getSummary\(\);/);
  assert.match(source, /case 'CLEAR_CALIBRATION_EVIDENCE':\s*await calibrationEvidence\.clear\(\);\s*return calibrationEvidence\.getSummary\(\);/);
});
