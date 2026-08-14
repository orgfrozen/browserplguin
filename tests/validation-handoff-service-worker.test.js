import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('service worker builds validation handoff from fresh evidence and live preflight', async () => {
  const source = await fs.readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ buildValidationHandoffBundle \} from '\.\.\/shared\/validation-handoff\.js';/);
  assert.match(source, /async function buildLiveValidationHandoffBundle\(\)/);
  assert.match(source, /buildCalibrationCoverage\(await calibrationEvidence\.getSummary\(\)\)/);
  assert.match(source, /await resourceE2eEvidence\.getSummary\(\)/);
  assert.match(source, /await remoteE2eEvidence\.getSummary\(\)/);
  assert.match(source, /buildRemoteProductionStatus\(\{ settings, evidenceSummary: remoteEvidenceSummary \}\)/);
  assert.match(source, /await runLiveRemoteE2ePreflight\(settings\)/);
  assert.match(source, /buildReleaseReadiness\(/);
  assert.match(source, /buildValidationHandoffBundle\(/);
  assert.match(source, /case 'GET_VALIDATION_HANDOFF_BUNDLE':\s*return buildLiveValidationHandoffBundle\(\);/);
});
