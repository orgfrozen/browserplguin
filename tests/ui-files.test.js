import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

for (const file of ['src/ui/popup.html','src/ui/popup.js','src/ui/options.html','src/ui/options.js']) {
  test(`${file} exists and is non-empty`, async () => {
    const text = await fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(text.trim().length > 20);
  });
}

test('options exposes server and execution safety settings', async () => {
  const html = await fs.readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  for (const id of ['taskApiBaseUrl','taskApiToken','heartbeatIntervalMs','fallbackLimit','maxTaskRounds','patchDownloadTimeoutMs']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test('popup exposes safe ChatGPT UI diagnostics action', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  assert.match(html, /id=["']inspectUi["']/);
  assert.match(js, /INSPECT_CHATGPT_UI/);
});

test('popup renders structured active Task observability instead of raw status JSON', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  for (const id of ['runnerMode','runnerState','activeTask','activePhase','activeRound','activePatchCount','activePatchGoal','activeProject','activeSession','activeRoundStage','activeLease','lastRun','lastRecovery']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(js, /GET_RUNNER_STATUS/);
  assert.match(js, /renderRunnerStatus/);
  assert.match(js, /setText\('lastRun', formatResult\(status\?\.lastRun\)\)/);
  assert.match(js, /const status = await send\(\{ type: 'GET_RUNNER_STATUS' \}\);\s*renderRunnerStatus\(status\)/);
});

test('popup renders compact UI compatibility telemetry fields', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  for (const id of ['uiCompatibilityCount','uiCompatibilityLast']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(js, /status\?\.ui_compatibility/);
  assert.match(js, /uiCompatibilityCount/);
  assert.match(js, /uiCompatibilityLast/);
});

test('options shows extension id and explicit Native Helper readiness check while remote stays gated', async () => {
  const html = await fs.readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  for (const id of ['nativeHelperExtensionId','nativeHelperStatus','checkNativeHelper']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /<option value="remote" disabled>/);
  assert.match(js, /chrome\.runtime\.id/);
  assert.match(js, /CHECK_NATIVE_HELPER/);
  assert.match(js, /GET_NATIVE_HELPER_STATUS/);
});

test('options exposes a live Task API connection check using the current unsaved endpoint credentials', async () => {
  const html = await fs.readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  for (const id of ['taskApiConnectionStatus','testTaskApiConnection']) {
    assert.match(html, new RegExp(`id=[\"']${id}[\"']`));
  }
  assert.match(js, /TEST_TASK_API_CONNECTION/);
  assert.match(js, /taskApiBaseUrl[\s\S]*taskApiToken[\s\S]*agentId/);
  assert.match(js, /requestEndpointPermission/);
});

test('options exposes remote E2E preflight while remote selection remains disabled', async () => {
  const html = await fs.readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  for (const id of ['remoteE2ePreflightStatus','checkRemoteE2ePreflight','remoteE2ePreflightBlockers']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /<option value="remote" disabled>/);
  assert.match(js, /CHECK_REMOTE_E2E_PREFLIGHT/);
  assert.match(js, /GET_REMOTE_E2E_PREFLIGHT/);
  assert.match(js, /ready_for_remote_e2e/);
});

test('options exposes explicit remote E2E test-mode controls while regular remote option stays disabled', async () => {
  const html = await fs.readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  for (const id of ['remoteE2eTestModeStatus','enableRemoteE2eTestMode','disableRemoteE2eTestMode']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /<option value="remote" disabled>/);
  assert.match(js, /ENABLE_REMOTE_E2E_TEST_MODE/);
  assert.match(js, /DISABLE_REMOTE_E2E_TEST_MODE/);
  assert.match(js, /remoteE2eTestMode/);
});

test('popup shows safe transfer/test-mode state', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  for (const id of ['patchTransferMode','remoteE2eTestMode']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(js, /status\?\.settings\?\.patch_transfer_mode/);
  assert.match(js, /status\?\.settings\?\.remote_e2e_test_mode/);
});


test('popup exposes a fixed read-only ChatGPT calibration matrix', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  assert.match(html, /id=["']runCalibration["']/);
  assert.match(html, /id=["']calibrationSummary["']/);
  for (const id of ['access','composer','model_state','latest_assistant','patch_candidates','context_limit','project_create','project_settings','project_delete','resource_input']) {
    assert.match(html, new RegExp(`id=["']cal-${id}["']`));
  }
  assert.match(js, /RUN_CHATGPT_CALIBRATION/);
  assert.match(js, /renderCalibrationMatrix/);
  assert.doesNotMatch(js, /showAction\(await send\(\{ type: 'RUN_CHATGPT_CALIBRATION'/);
});

test('options exposes exact-origin Resource Host Access controls without wildcard runtime grants', async () => {
  const html = await fs.readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  for (const id of ['resourcePermissionUrl','resourcePermissionStatus','checkResourcePermission','grantResourcePermission','revokeResourcePermission']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(js, /chrome\.permissions\.contains/);
  assert.match(js, /chrome\.permissions\.request/);
  assert.match(js, /chrome\.permissions\.remove/);
  assert.match(js, /grantResourcePermission/);
  assert.doesNotMatch(js, /origins:\s*\[\s*['"](?:<all_urls>|\*:\/\/\*\/\*)['"]\s*\]/);
});


test('popup renders and clears privacy-safe calibration evidence coverage', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  assert.match(html, /id=["']calibrationEvidenceRuns["']/);
  assert.match(html, /id=["']clearCalibrationEvidence["']/);
  for (const id of ['access','composer','model_state','latest_assistant','patch_candidates','context_limit','project_create','project_settings','project_delete','resource_input']) {
    assert.match(html, new RegExp(`id=["']evidence-${id}["']`));
  }
  assert.match(js, /GET_CALIBRATION_EVIDENCE/);
  assert.match(js, /CLEAR_CALIBRATION_EVIDENCE/);
  assert.match(js, /renderCalibrationEvidence/);
  assert.match(js, /pass_count/);
  assert.match(js, /total_runs/);
});


test('popup renders calibration review coverage and downloads a privacy-safe handoff report', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  assert.match(html, /id=["']calibrationCoverageSummary["']/);
  assert.match(html, /id=["']downloadCalibrationReport["']/);
  for (const id of ['context_limit','patch_candidates','project_create','project_settings','resource_input','project_delete']) {
    assert.match(html, new RegExp(`id=["']coverage-${id}["']`));
  }
  assert.match(js, /GET_CALIBRATION_COVERAGE/);
  assert.match(js, /renderCalibrationCoverage/);
  assert.match(js, /new Blob\(\[JSON\.stringify\(report, null, 2\)\]/);
  assert.match(js, /URL\.createObjectURL/);
  assert.match(js, /calibration-handoff-/);
  assert.doesNotMatch(js, /recent_runs/);
});

test('popup renders a guided live calibration campaign and captures only through existing read-only calibration', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  for (const id of ['calibrationCampaignSummary','calibrationCampaignTarget','calibrationCampaignInstruction','captureCalibrationCampaign']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  for (const id of ['project_create','project_settings','resource_input','patch_candidates','context_limit','project_delete']) {
    assert.match(html, new RegExp(`id=["']campaign-${id}["']`));
  }
  assert.match(js, /type: 'GET_CALIBRATION_CAMPAIGN'/);
  assert.match(js, /captureCalibrationCampaign/);
  assert.match(js, /type: 'RUN_CHATGPT_CALIBRATION'/);
  assert.match(js, /refreshCalibrationCampaign/);
  for (const code of ['SHOW_PROJECT_CREATE_CONTROL','OPEN_PROJECT_SETTINGS_CONTROL','SHOW_RESOURCE_INPUT_CONTROL','SHOW_ASSISTANT_PATCH_CONTROL','SHOW_CONTEXT_LIMIT_STATE','OPEN_PROJECT_DELETE_CONTROL']) {
    assert.match(js, new RegExp(code));
  }
  assert.doesNotMatch(js, /campaign.*textContent|campaign.*href|campaign.*prompt|campaign.*project_name/i);
});

test('popup renders and clears privacy-safe Remote E2E evidence', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  for (const id of ['remoteE2eEvidenceRuns','remoteE2eEvidencePassed','remoteE2eEvidenceLatest','remoteE2eEvidenceStage','clearRemoteE2eEvidence']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(js, /GET_REMOTE_E2E_EVIDENCE/);
  assert.match(js, /CLEAR_REMOTE_E2E_EVIDENCE/);
  assert.match(js, /renderRemoteE2eEvidence/);
  assert.doesNotMatch(js, /remoteE2eEvidence.*task_id/i);
  assert.doesNotMatch(js, /remoteE2eEvidence.*local_path/i);
});

test('options exposes explicit evidence-gated production remote promotion controls', async () => {
  const html = await fs.readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  for (const id of ['remoteProductionStatus','remoteProductionEvidence','promoteRemoteProduction','disableRemoteProduction']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(js, /GET_REMOTE_PRODUCTION_STATUS/);
  assert.match(js, /PROMOTE_REMOTE_PRODUCTION/);
  assert.match(js, /DISABLE_REMOTE_PRODUCTION/);
  assert.match(js, /remoteProductionMode/);
  assert.match(js, /remoteOption\.disabled\s*=\s*!enabled/);
});

test('popup exposes safe production remote mode state', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  assert.match(html, /id=["']remoteProductionMode["']/);
  assert.match(js, /remote_production_mode/);
});

test('popup renders and clears privacy-safe Resource E2E evidence', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  for (const id of ['resourceE2eEvidenceRuns','resourceE2eEvidencePassed','resourceE2eEvidenceLatest','resourceE2eEvidenceStage','clearResourceE2eEvidence']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(js, /GET_RESOURCE_E2E_EVIDENCE/);
  assert.match(js, /CLEAR_RESOURCE_E2E_EVIDENCE/);
  assert.match(js, /renderResourceE2eEvidence/);
  assert.doesNotMatch(js, /resourceE2eEvidence.*resource_url/i);
  assert.doesNotMatch(js, /resourceE2eEvidence.*filename/i);
  assert.doesNotMatch(js, /resourceE2eEvidence.*base64/i);
});

test('popup renders production readiness gate and downloads only the safe release report', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  for (const id of ['releaseReadinessSummary','releaseCalibration','releaseResourceE2e','releaseRemoteE2e','releaseRemoteProduction','releaseRemotePreflight','releaseReadinessBlockers','downloadReleaseReadinessReport']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(js, /GET_RELEASE_READINESS/);
  assert.match(js, /renderReleaseReadiness/);
  assert.match(js, /refreshReleaseReadiness/);
  assert.match(js, /release-readiness-/);
  assert.match(js, /new Blob\(\[JSON\.stringify\(report, null, 2\)\]/);
  assert.doesNotMatch(js, /releaseReadiness.*recent_runs/i);
  assert.doesNotMatch(js, /releaseReadiness.*task_id/i);
  assert.doesNotMatch(js, /releaseReadiness.*local_path/i);
  assert.doesNotMatch(js, /releaseReadiness.*token/i);
});

test('popup downloads one privacy-safe validation handoff bundle', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  assert.match(html, /id="downloadValidationHandoff"/);
  assert.match(html, /Download validation handoff/);
  assert.match(js, /type: 'GET_VALIDATION_HANDOFF_BUNDLE'/);
  assert.match(js, /validation-handoff-/);
  assert.match(js, /downloadValidationHandoff/);
});

test('options shows screenshot safety policy while capture remains disabled and has no opt-in control', async () => {
  const html = await fs.readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  for (const id of ['diagnosticScreenshotPolicyStatus','diagnosticScreenshotPolicyRules']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(js, /GET_DIAGNOSTIC_SCREENSHOT_POLICY/);
  assert.match(js, /capture_enabled/);
  assert.doesNotMatch(html, /enableDiagnosticScreenshot|diagnosticScreenshotConsent/);
  assert.doesNotMatch(js, /captureVisibleTab|toDataURL|toBlob|OffscreenCanvas|createImageBitmap/i);
});

test('options exposes Agent ID required by agent-control task execution', async () => {
  const html = await fs.readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  assert.match(html, /id="agentId"/);
  assert.match(js, /'agentId'/);
});


test('options labels the configured interval as Agent heartbeat and enforces the alarm-safe minimum', async () => {
  const html = await fs.readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  assert.match(html, /Agent Heartbeat \(ms\)/);
  assert.match(html, /id="heartbeatIntervalMs"[^>]*min="30000"/);
});
