import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

for (const file of ['src/ui/popup.html','src/ui/popup.js','src/ui/options.html','src/ui/options.js']) {
  test(`${file} exists and is non-empty`, async () => {
    const text = await fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(text.trim().length > 20);
  });
}

test('popup exposes the opt-in pre-create legacy Workspace cleanup switch', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  assert.match(html, /id=["']cleanupLegacyProjectsToggle["'][^>]*type=["']checkbox["']/);
  assert.doesNotMatch(html, /id=["']cleanupLegacyProjectsToggle["'][^>]*checked/);
  assert.match(html, /新 Execution 第一次创建 ChatGPT Project 前清理同项目/);
  assert.match(js, /status\?\.settings\?\.cleanup_legacy_projects/);
  assert.match(js, /SET_CLEANUP_LEGACY_PROJECTS/);
});

test('options exposes opt-in legacy Workspace cleanup and keeps it off unless checked', async () => {
  const html = await fs.readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  assert.match(html, /id=["']cleanupLegacyProjects["'][^>]*type=["']checkbox["']/);
  assert.doesNotMatch(html, /id=["']cleanupLegacyProjects["'][^>]*checked/);
  assert.match(js, /cleanupLegacyProjects/);
  assert.match(js, /\.checked/);
});

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

test('popup keeps execution progress and latest error in a fixed right-side diagnostics panel', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  for (const id of ['runtimePanel','executionTrace','latestRunError','copySafeDiagnostic','actionResult']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /position:\s*fixed/);
  assert.match(html, /overflow:\s*auto/);
  assert.match(js, /renderExecutionTrace/);
  assert.match(js, /renderLatestRunError/);
  assert.match(js, /copySafeDiagnostic/);
  assert.match(js, /navigator\.clipboard\.writeText/);
});

test('popup shows external status polling observability and includes it in safe diagnostics', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  for (const id of ['statusQueryCount','statusLastQuery','statusNextQuery','statusLastResult','statusLastPatchReconcile','statusLastCompletionCheck']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(js, /active\?\.status_checks/);
  assert.match(js, /setText\('statusQueryCount'/);
  assert.match(js, /setText\('statusLastPatchReconcile'/);
  assert.match(js, /setText\('statusLastCompletionCheck'/);
  assert.match(js, /activeExecution:\s*status\?\.activeExecution/);
});

test('popup runtime panel labels current versus previous execution and refreshes automatically while open', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  assert.match(html, /id=["']runtimePanelMode["']/);
  assert.match(html, /<script type=["']module["'] src=["']popup\.js["']/);
  assert.match(js, /selectRuntimePanelSource/);
  assert.match(js, /setInterval\([\s\S]*refreshRunnerStatus\(\)/);
  assert.doesNotMatch(js, /const traceSource = status\?\.lastRun\?\.trace/);
});

test('popup exposes a persistent pause resume control and disables new real runs while paused', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  assert.match(html, /id=["']togglePause["']/);
  assert.match(js, /PAUSE_RUNNER/);
  assert.match(js, /RESUME_RUNNER/);
  assert.match(js, /status\?\.paused/);
  assert.match(js, /pauseButton\.textContent\s*=\s*paused\s*\?\s*['"]继续['"]\s*:\s*['"]暂停['"]/);
  assert.match(js, /runRealButton\.disabled\s*=\s*paused/);
});

test('options explains Patch timeout as a local wait window that defers to server recovery', async () => {
  const html = await fs.readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  assert.match(html, /Patch 本地等待窗口 \(ms\)/);
  assert.match(html, /达到窗口后不会直接判 Task 失败/);
  assert.match(html, /Recovery Policy/);
});

test('popup exposes an explicit terminate Task control only when an active execution exists', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  assert.match(html, /id=["']terminateTask["']/);
  assert.match(html, />终止 Task</);
  assert.match(js, /TERMINATE_TASK/);
  assert.match(js, /terminateButton\.disabled\s*=\s*!active/);
  assert.match(js, /confirm\(/);
});

test('popup exposes an explicit Auto Runner enable switch and keeps Run Real Once as the manual alternative', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  assert.match(html, /id=["']autoRunnerState["']/);
  assert.match(html, /id=["']toggleAutoRun["']/);
  assert.match(js, /status\?\.auto_run_enabled/);
  assert.match(js, /SET_AUTO_RUN/);
  assert.match(js, /toggleAutoRunButton\.textContent\s*=\s*autoRunEnabled\s*\?\s*['"]关闭自动运行['"]\s*:\s*['"]启用自动运行['"]/);
  assert.match(js, /autoRunEnabled\s*\?\s*\(paused\s*\?\s*['"]enabled · paused['"]\s*:\s*['"]enabled['"]\)\s*:\s*['"]disabled['"]/);
  assert.match(js, /runRealButton\.disabled\s*=\s*paused\s*\|\|\s*autoRunEnabled/);
});


test('options exposes bounded ChatGPT local recovery settings', async () => {
  const html = await fs.readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  for (const id of ['composerPollIntervalMs', 'composerStallTimeoutMs', 'workspaceMaxRetries']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
    assert.match(js, new RegExp(`['"]${id}['"]`));
  }
});

test('options and popup expose max parallel Task capacity 1 through 5 and active/max status', async () => {
  const optionsHtml = await fs.readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  const optionsJs = await fs.readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  const popupHtml = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const popupJs = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  assert.match(optionsHtml, /id=["']maxParallelTasks["'][^>]*type=["']number["'][^>]*min=["']1["'][^>]*max=["']5["']/);
  assert.match(optionsJs, /maxParallelTasks/);
  assert.match(popupHtml, /id=["']maxParallelTasksControl["'][^>]*type=["']number["'][^>]*min=["']1["'][^>]*max=["']5["']/);
  assert.match(popupHtml, /id=["']parallelTaskState["']/);
  assert.match(popupJs, /active_task_count/);
  assert.match(popupJs, /max_parallel_tasks/);
  assert.match(popupJs, /SET_MAX_PARALLEL_TASKS/);
});

test('popup exposes graceful drain state and toggle without conflating it with pause or auto-run', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  assert.match(html, /id=["']drainState["']/);
  assert.match(html, /id=["']toggleDrain["']/);
  assert.match(js, /status\?\.drain_enabled/);
  assert.match(js, /SET_DRAIN_MODE/);
  assert.match(js, /toggleDrainButton\.textContent\s*=\s*drainEnabled\s*\?/);
});

test('popup terminates the displayed active slot explicitly instead of relying on controller ordering', async () => {
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  assert.match(js, /activeSlotId\s*=\s*status\?\.active_slot_id/);
  assert.match(js, /send\(\{\s*type:\s*'TERMINATE_TASK',\s*slotId:\s*latestRunnerStatus\?\.active_slot_id\s*\?\?\s*null\s*\}\)/);
});

test('popup shows adaptive effective parallel capacity and backpressure state separately from configured max', async () => {
  const html = await fs.readFile(new URL('../src/ui/popup.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../src/ui/popup.js', import.meta.url), 'utf8');
  assert.match(html, /id=["']backpressureState["']/);
  assert.match(js, /effective_parallel_tasks/);
  assert.match(js, /adaptive_backpressure/);
  assert.match(js, /backpressureState/);
});
