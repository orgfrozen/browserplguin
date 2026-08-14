const actionResultEl = document.getElementById('actionResult');

function setText(id, value) {
  document.getElementById(id).textContent = value === null || value === undefined || value === '' ? '-' : String(value);
}

function formatLease(lease) {
  if (!lease?.present) return '-';
  if (Number.isFinite(lease.ttl_ms)) return `${Math.round(lease.ttl_ms / 1000)}s TTL`;
  return 'active';
}


function formatUiCompatibilityLast(event) {
  if (!event) return '-';
  return [event.operation, event.error_code, event.page_category].filter(Boolean).join(' · ') || '-';
}

function formatResult(result) {
  if (!result) return '-';
  return [result.status, result.taskId, result.error_code].filter(Boolean).join(' · ') || '-';
}

function renderRunnerStatus(status) {
  const active = status?.activeExecution ?? null;
  setText('runnerMode', status?.settings?.mode ?? '-');
  setText('runnerState', status?.running ? 'running' : active ? 'active / waiting' : 'idle');
  setText('patchTransferMode', status?.settings?.patch_transfer_mode ?? 'local');
  setText('remoteE2eTestMode', status?.settings?.remote_e2e_test_mode ? 'enabled (test only)' : 'disabled');
  setText('remoteProductionMode', status?.settings?.remote_production_mode ? 'enabled' : 'disabled');
  setText('activeTask', active ? [active.task_id, active.project_id].filter(Boolean).join(' · ') : '-');
  setText('activePhase', active?.phase ?? '-');
  setText('activeRound', active?.task_round_count ?? '-');
  setText('activePatchCount', active?.task_patch_count ?? '-');
  setText('activePatchGoal', active?.patch_goal_minimum ?? '-');
  setText('activeProject', active?.project_name ?? '-');
  setText('activeSession', active?.session_id ?? '-');
  setText('activeRoundStage', active?.in_flight_stage ?? '-');
  setText('activeLease', formatLease(active?.lease));
  setText('lastRun', formatResult(status?.lastRun));
  setText('lastRecovery', formatResult(status?.lastRecovery));
  const uiCompatibility = status?.ui_compatibility ?? null;
  setText('uiCompatibilityCount', uiCompatibility?.total_events ?? 0);
  setText('uiCompatibilityLast', formatUiCompatibilityLast(uiCompatibility?.last_event));
}


const CALIBRATION_IDS = ['access','composer','model_state','latest_assistant','patch_candidates','context_limit','project_create','project_settings','project_delete','resource_input'];
const CALIBRATION_REVIEW_IDS = ['context_limit','patch_candidates','project_create','project_settings','resource_input','project_delete'];

function renderCalibrationMatrix(matrix) {
  const summary = matrix?.summary ?? {};
  setText('calibrationSummary', `pass ${summary.pass ?? 0} · unavailable ${summary.unavailable ?? 0} · incompatible ${summary.incompatible ?? 0}`);
  const byId = new Map((matrix?.checks ?? []).map(check => [check.id, check]));
  for (const id of CALIBRATION_IDS) {
    const check = byId.get(id);
    setText(`cal-${id}`, check?.status ?? '-');
  }
}


function renderCalibrationEvidence(summary) {
  setText('calibrationEvidenceRuns', summary?.total_runs ?? 0);
  const surfaces = summary?.surfaces ?? {};
  for (const id of CALIBRATION_IDS) {
    const evidence = surfaces[id];
    if (!evidence) {
      setText(`evidence-${id}`, '-');
      continue;
    }
    setText(`evidence-${id}`, `${evidence.latest_status ?? '-'} · pass ${evidence.pass_count ?? 0}/${evidence.total_runs ?? 0}`);
  }
}

async function refreshCalibrationEvidence() {
  const summary = await send({ type: 'GET_CALIBRATION_EVIDENCE' });
  renderCalibrationEvidence(summary);
  return summary;
}

function renderCalibrationCoverage(report) {
  const ready = report?.ready_for_review === true;
  setText('calibrationCoverageSummary', `${ready ? 'ready for review' : 'evidence incomplete'} · covered ${report?.covered_count ?? 0}/${report?.required_count ?? CALIBRATION_REVIEW_IDS.length}`);
  const surfaces = report?.surfaces ?? {};
  for (const id of CALIBRATION_REVIEW_IDS) {
    const coverage = surfaces[id];
    if (!coverage) {
      setText(`coverage-${id}`, 'missing pass');
      continue;
    }
    const label = coverage.coverage === 'covered' ? 'covered' : coverage.coverage === 'needs_review' ? 'needs review' : 'missing pass';
    setText(`coverage-${id}`, `${label} · pass ${coverage.pass_count ?? 0}/${coverage.total_runs ?? 0}`);
  }
}

async function refreshCalibrationCoverage() {
  const report = await send({ type: 'GET_CALIBRATION_COVERAGE' });
  renderCalibrationCoverage(report);
  return report;
}

function downloadCalibrationReport(report) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const stamp = String(report?.generated_at ?? new Date().toISOString()).replace(/[:.]/g, '-');
  anchor.href = url;
  anchor.download = `calibration-handoff-${stamp}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}



function renderReleaseReadiness(report) {
  const ready = report?.ready_for_release_review === true;
  setText('releaseReadinessSummary', ready ? 'ready for release review' : 'blocked');
  setText('releaseCalibration', report?.calibration?.satisfied ? `ready · ${report.calibration.covered_count ?? 0}/${report.calibration.required_count ?? 0}` : `blocked · ${report?.calibration?.covered_count ?? 0}/${report?.calibration?.required_count ?? 0}`);
  setText('releaseResourceE2e', report?.resource_e2e?.satisfied ? `ready · pass ${report.resource_e2e.passed_runs ?? 0}` : `blocked · pass ${report?.resource_e2e?.passed_runs ?? 0}`);
  setText('releaseRemoteE2e', report?.remote_e2e?.satisfied ? `ready · pass ${report.remote_e2e.passed_runs ?? 0}` : `blocked · pass ${report?.remote_e2e?.passed_runs ?? 0}`);
  setText('releaseRemoteProduction', report?.remote_production?.satisfied ? 'ready · enabled' : 'blocked · disabled');
  setText('releaseRemotePreflight', report?.remote_preflight?.satisfied ? 'ready' : 'blocked');
  setText('releaseReadinessBlockers', Array.isArray(report?.blockers) && report.blockers.length ? report.blockers.join(', ') : 'none');
}

async function refreshReleaseReadiness() {
  const report = await send({ type: 'GET_RELEASE_READINESS' });
  renderReleaseReadiness(report);
  return report;
}

function downloadReleaseReadinessReport(report) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const stamp = String(report?.generated_at ?? new Date().toISOString()).replace(/[:.]/g, '-');
  anchor.href = url;
  anchor.download = `release-readiness-${stamp}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function renderResourceE2eEvidence(summary) {
  setText('resourceE2eEvidenceRuns', summary?.total_runs ?? 0);
  setText('resourceE2eEvidencePassed', summary?.passed_runs ?? 0);
  setText('resourceE2eEvidenceLatest', summary?.last_run?.result ?? '-');
  setText('resourceE2eEvidenceStage', summary?.last_run?.failure_stage ?? '-');
}

async function refreshResourceE2eEvidence() {
  const summary = await send({ type: 'GET_RESOURCE_E2E_EVIDENCE' });
  renderResourceE2eEvidence(summary);
  return summary;
}

function renderRemoteE2eEvidence(summary) {
  setText('remoteE2eEvidenceRuns', summary?.total_runs ?? 0);
  setText('remoteE2eEvidencePassed', summary?.passed_runs ?? 0);
  setText('remoteE2eEvidenceLatest', summary?.last_run?.result ?? '-');
  setText('remoteE2eEvidenceStage', summary?.last_run?.failure_stage ?? '-');
}

async function refreshRemoteE2eEvidence() {
  const summary = await send({ type: 'GET_REMOTE_E2E_EVIDENCE' });
  renderRemoteE2eEvidence(summary);
  return summary;
}

function showAction(value) {
  actionResultEl.textContent = JSON.stringify(value, null, 2);
}

async function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function refresh() {
  const status = await send({ type: 'GET_RUNNER_STATUS' });
  renderRunnerStatus(status);
  return status;
}

document.getElementById('refresh').addEventListener('click', () => refresh().catch(error => showAction({ ok: false, error: error.message })));
document.getElementById('runMock').addEventListener('click', async () => {
  const taskId = document.getElementById('mockTaskId').value.trim() || null;
  try {
    showAction(await send({ type: 'RUN_MOCK_ONCE', taskId }));
    await Promise.all([refresh(), refreshReleaseReadiness()]);
  } catch (error) {
    showAction({ ok: false, error: error.message });
  }
});
document.getElementById('runReal').addEventListener('click', async () => {
  try {
    showAction(await send({ type: 'RUN_REAL_ONCE' }));
    await Promise.all([refresh(), refreshResourceE2eEvidence(), refreshRemoteE2eEvidence(), refreshReleaseReadiness()]);
  } catch (error) {
    showAction({ ok: false, error: error.message });
  }
});
document.getElementById('runCalibration').addEventListener('click', async () => {
  try {
    renderCalibrationMatrix(await send({ type: 'RUN_CHATGPT_CALIBRATION' }));
    await Promise.all([refreshCalibrationEvidence(), refreshCalibrationCoverage(), refreshReleaseReadiness()]);
  } catch (error) {
    showAction({ ok: false, error: error.message });
  }
});
document.getElementById('clearCalibrationEvidence').addEventListener('click', async () => {
  try {
    renderCalibrationEvidence(await send({ type: 'CLEAR_CALIBRATION_EVIDENCE' }));
    await Promise.all([refreshCalibrationCoverage(), refreshReleaseReadiness()]);
  } catch (error) {
    showAction({ ok: false, error: error.message });
  }
});
document.getElementById('downloadCalibrationReport').addEventListener('click', async () => {
  try {
    const report = await refreshCalibrationCoverage();
    downloadCalibrationReport(report);
  } catch (error) {
    showAction({ ok: false, error: error.message });
  }
});
document.getElementById('clearResourceE2eEvidence').addEventListener('click', async () => {
  try {
    renderResourceE2eEvidence(await send({ type: 'CLEAR_RESOURCE_E2E_EVIDENCE' }));
    await refreshReleaseReadiness();
  } catch (error) {
    showAction({ ok: false, error: error.message });
  }
});
document.getElementById('clearRemoteE2eEvidence').addEventListener('click', async () => {
  try {
    renderRemoteE2eEvidence(await send({ type: 'CLEAR_REMOTE_E2E_EVIDENCE' }));
    await refreshReleaseReadiness();
  } catch (error) {
    showAction({ ok: false, error: error.message });
  }
});
document.getElementById('downloadReleaseReadinessReport').addEventListener('click', async () => {
  try {
    const report = await refreshReleaseReadiness();
    downloadReleaseReadinessReport(report);
  } catch (error) {
    showAction({ ok: false, error: error.message });
  }
});
document.getElementById('inspectUi').addEventListener('click', async () => {
  try {
    showAction(await send({ type: 'INSPECT_CHATGPT_UI' }));
  } catch (error) {
    showAction({ ok: false, error: error.message });
  }
});
document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
Promise.all([refresh(), refreshCalibrationEvidence(), refreshCalibrationCoverage(), refreshResourceE2eEvidence(), refreshRemoteE2eEvidence(), refreshReleaseReadiness()]).catch(error => showAction({ ok: false, error: error.message }));
