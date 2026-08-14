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

function renderCalibrationMatrix(matrix) {
  const summary = matrix?.summary ?? {};
  setText('calibrationSummary', `pass ${summary.pass ?? 0} · unavailable ${summary.unavailable ?? 0} · incompatible ${summary.incompatible ?? 0}`);
  const byId = new Map((matrix?.checks ?? []).map(check => [check.id, check]));
  for (const id of CALIBRATION_IDS) {
    const check = byId.get(id);
    setText(`cal-${id}`, check?.status ?? '-');
  }
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
    await refresh();
  } catch (error) {
    showAction({ ok: false, error: error.message });
  }
});
document.getElementById('runReal').addEventListener('click', async () => {
  try {
    showAction(await send({ type: 'RUN_REAL_ONCE' }));
    await refresh();
  } catch (error) {
    showAction({ ok: false, error: error.message });
  }
});
document.getElementById('runCalibration').addEventListener('click', async () => {
  try {
    renderCalibrationMatrix(await send({ type: 'RUN_CHATGPT_CALIBRATION' }));
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
refresh().catch(error => showAction({ ok: false, error: error.message }));
