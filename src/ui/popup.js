import { selectRuntimePanelSource } from './runtime-panel.js';

const actionResultEl = document.getElementById('actionResult');
let latestRunnerStatus = null;

const TRACE_LABELS = Object.freeze({
  assignment: 'Assignment',
  claim: 'Claim',
  execution: 'Execution start',
  bootstrap: 'Bootstrap',
  export: 'PatchSync export',
  source: 'Source package',
  project: 'Create Project',
  upload: 'Upload source',
  prompt: 'Initialization prompt',
  patch: 'Patch',
  completion: 'completion_check'
});

const TRACE_ICONS = Object.freeze({ passed: '✓', failed: '✗', pending: '·' });

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

function renderExecutionTrace(trace) {
  const container = document.getElementById('executionTrace');
  container.replaceChildren();
  const items = Array.isArray(trace) ? trace : [];
  if (items.length === 0) {
    container.textContent = '-';
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = `trace-item trace-status-${item.status ?? 'pending'}`;
    const icon = document.createElement('span');
    icon.textContent = TRACE_ICONS[item.status] ?? '·';
    const label = document.createElement('span');
    label.textContent = TRACE_LABELS[item.id] ?? item.id ?? 'stage';
    const status = document.createElement('span');
    status.textContent = item.status ?? 'pending';
    row.append(icon, label, status);
    container.append(row);
  }
}

function renderLatestRunError(error) {
  const el = document.getElementById('latestRunError');
  if (!error) { el.textContent = '-'; return; }
  const lines = [
    [error.code, error.message].filter(Boolean).join(' · ') || 'UNEXPECTED',
    error.details && Object.keys(error.details).length > 0 ? JSON.stringify(error.details, null, 2) : null
  ].filter(Boolean);
  el.textContent = lines.join('\n');
}

function safeDiagnostic(status) {
  return {
    runner: {
      running: status?.running === true,
      paused: status?.paused === true,
      mode: status?.settings?.mode ?? null,
      activeExecution: status?.activeExecution ?? null
    },
    lastRun: status?.lastRun ?? null,
    lastRecovery: status?.lastRecovery ?? null,
    uiCompatibility: status?.ui_compatibility ?? null
  };
}

function renderRunnerStatus(status) {
  latestRunnerStatus = status ?? null;
  const active = status?.activeExecution ?? null;
  const paused = status?.paused === true;
  const pauseButton = document.getElementById('togglePause');
  const toggleAutoRunButton = document.getElementById('toggleAutoRun');
  const runRealButton = document.getElementById('runReal');
  const terminateButton = document.getElementById('terminateTask');
  const autoRunEnabled = status?.auto_run_enabled === true;
  pauseButton.textContent = paused ? '继续' : '暂停';
  toggleAutoRunButton.textContent = autoRunEnabled ? '关闭自动运行' : '启用自动运行';
  runRealButton.disabled = paused || autoRunEnabled;
  terminateButton.disabled = !active;
  setText('runnerMode', status?.settings?.mode ?? '-');
  setText('runnerState', paused ? 'paused' : status?.running ? 'running' : active ? 'active / waiting' : 'idle');
  setText('autoRunnerState', autoRunEnabled ? 'enabled' : 'disabled');
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
  const panelSource = selectRuntimePanelSource(status);
  setText('runtimePanelMode', panelSource.label);
  renderExecutionTrace(panelSource.trace);
  renderLatestRunError(panelSource.error);
}


const CALIBRATION_IDS = ['access','composer','model_state','latest_assistant','patch_candidates','context_limit','project_create','project_settings','project_delete','resource_input'];
const CALIBRATION_REVIEW_IDS = ['context_limit','patch_candidates','project_create','project_settings','resource_input','project_delete'];
const CALIBRATION_CAMPAIGN_IDS = ['project_create','project_settings','resource_input','patch_candidates','context_limit','project_delete'];
const CALIBRATION_CAMPAIGN_LABELS = Object.freeze({
  project_create: 'Project create',
  project_settings: 'Project settings',
  resource_input: 'Resource input',
  patch_candidates: 'Patch candidates',
  context_limit: 'Context limit',
  project_delete: 'Project delete'
});
const CALIBRATION_CAMPAIGN_INSTRUCTIONS = Object.freeze({
  SHOW_PROJECT_CREATE_CONTROL: '手动显示 New project / 新建项目入口，然后 Capture。',
  OPEN_PROJECT_SETTINGS_CONTROL: '进入真实 Project，并手动打开 Project settings 菜单/入口，然后 Capture。',
  SHOW_RESOURCE_INPUT_CONTROL: '打开可发送消息的 ChatGPT 页面，让附件输入控件存在；不要上传文件，然后 Capture。',
  SHOW_ASSISTANT_PATCH_CONTROL: '打开一条包含 Patch 下载卡片/按钮的 Assistant 回复，然后 Capture。',
  SHOW_CONTEXT_LIMIT_STATE: '打开已经出现 Context Limit 的真实对话状态，然后 Capture。',
  OPEN_PROJECT_DELETE_CONTROL: '手动打开目标 Project 的删除菜单/删除 action；不要确认删除，然后 Capture。'
});

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

function renderCalibrationCampaign(campaign) {
  const complete = campaign?.complete === true;
  setText('calibrationCampaignSummary', `${complete ? 'complete' : 'in progress'} · ${campaign?.completed_count ?? 0}/${campaign?.required_count ?? CALIBRATION_CAMPAIGN_IDS.length}`);
  const stages = new Map((Array.isArray(campaign?.stages) ? campaign.stages : []).map(stage => [stage?.id, stage]));
  const current = stages.get(campaign?.current_stage_id) ?? null;
  setText('calibrationCampaignTarget', complete ? 'campaign complete' : CALIBRATION_CAMPAIGN_LABELS[current?.id] ?? 'pending stage');
  setText('calibrationCampaignInstruction', complete ? '六项 live selector 均已有可复核 pass 证据。' : CALIBRATION_CAMPAIGN_INSTRUCTIONS[current?.instruction_code] ?? '按当前目标准备真实 ChatGPT UI 状态后 Capture。');
  for (const id of CALIBRATION_CAMPAIGN_IDS) {
    const stage = stages.get(id);
    setText(`campaign-${id}`, stage ? `${stage.status ?? 'pending'} · pass ${stage.pass_count ?? 0}/${stage.total_runs ?? 0}` : 'pending');
  }
}

async function refreshCalibrationCampaign() {
  const campaign = await send({ type: 'GET_CALIBRATION_CAMPAIGN' });
  renderCalibrationCampaign(campaign);
  return campaign;
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

function downloadValidationHandoffBundle(bundle) {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const stamp = String(bundle?.generated_at ?? new Date().toISOString()).replace(/[:.]/g, '-');
  anchor.href = url;
  anchor.download = `validation-handoff-${stamp}.json`;
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

async function refreshRunnerStatus() {
  const status = await send({ type: 'GET_RUNNER_STATUS' });
  renderRunnerStatus(status);
  return status;
}

async function refresh() {
  return refreshRunnerStatus();
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
document.getElementById('toggleAutoRun').addEventListener('click', async () => {
  try {
    const enabled = latestRunnerStatus?.auto_run_enabled !== true;
    showAction(await send({ type: 'SET_AUTO_RUN', enabled }));
    await refresh();
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
document.getElementById('togglePause').addEventListener('click', async () => {
  try {
    const paused = latestRunnerStatus?.paused === true;
    showAction(await send({ type: paused ? 'RESUME_RUNNER' : 'PAUSE_RUNNER' }));
    await refresh();
  } catch (error) {
    showAction({ ok: false, error: error.message });
  }
});
document.getElementById('terminateTask').addEventListener('click', async () => {
  try {
    const active = latestRunnerStatus?.activeExecution ?? null;
    if (!active) return;
    if (!confirm(`确定终止当前 Task ${active.task_id ?? ''} 吗？终止后服务端不会再次调度这个 Task。`)) return;
    showAction(await send({ type: 'TERMINATE_TASK' }));
    await refresh();
  } catch (error) {
    showAction({ ok: false, error: error.message });
  }
});
document.getElementById('runCalibration').addEventListener('click', async () => {
  try {
    renderCalibrationMatrix(await send({ type: 'RUN_CHATGPT_CALIBRATION' }));
    await Promise.all([refreshCalibrationEvidence(), refreshCalibrationCoverage(), refreshCalibrationCampaign(), refreshReleaseReadiness()]);
  } catch (error) {
    showAction({ ok: false, error: error.message });
  }
});
document.getElementById('captureCalibrationCampaign').addEventListener('click', async () => {
  try {
    renderCalibrationMatrix(await send({ type: 'RUN_CHATGPT_CALIBRATION' }));
    await Promise.all([refreshCalibrationEvidence(), refreshCalibrationCoverage(), refreshCalibrationCampaign(), refreshReleaseReadiness()]);
  } catch (error) {
    showAction({ ok: false, error: error.message });
  }
});
document.getElementById('clearCalibrationEvidence').addEventListener('click', async () => {
  try {
    renderCalibrationEvidence(await send({ type: 'CLEAR_CALIBRATION_EVIDENCE' }));
    await Promise.all([refreshCalibrationCoverage(), refreshCalibrationCampaign(), refreshReleaseReadiness()]);
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
document.getElementById('downloadValidationHandoff').addEventListener('click', async () => {
  try {
    const bundle = await send({ type: 'GET_VALIDATION_HANDOFF_BUNDLE' });
    downloadValidationHandoffBundle(bundle);
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
document.getElementById('copySafeDiagnostic').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(safeDiagnostic(latestRunnerStatus), null, 2));
    document.getElementById('copySafeDiagnostic').textContent = '已复制';
  } catch (error) {
    showAction({ ok: false, error: error.message });
  }
});

document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
const runnerRefreshTimer = setInterval(() => { refreshRunnerStatus().catch(() => {}); }, 1000);
window.addEventListener('unload', () => clearInterval(runnerRefreshTimer), { once: true });
Promise.all([refresh(), refreshCalibrationEvidence(), refreshCalibrationCoverage(), refreshCalibrationCampaign(), refreshResourceE2eEvidence(), refreshRemoteE2eEvidence(), refreshReleaseReadiness()]).catch(error => showAction({ ok: false, error: error.message }));
