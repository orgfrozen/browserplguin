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
  setText('activeTask', active ? [active.task_id, active.project_id].filter(Boolean).join(' · ') : '-');
  setText('activePhase', active?.phase ?? '-');
  setText('activeRound', active?.task_round_count ?? '-');
  setText('activePatchCount', active?.task_patch_count ?? '-');
  setText('activePatchGoal', active?.patch_goal_minimum ?? '-');
  setText('activeProject', active?.project_name ?? '-');
  setText('activeSession', active?.session_id ?? '-');
  setText('activeRoundStage', active?.in_flight_stage ?? '-');
  setText('activeLease', formatLease(active?.lease));
  setText('lastRecovery', formatResult(status?.lastRecovery));
  const uiCompatibility = status?.ui_compatibility ?? null;
  setText('uiCompatibilityCount', uiCompatibility?.total_events ?? 0);
  setText('uiCompatibilityLast', formatUiCompatibilityLast(uiCompatibility?.last_event));
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
document.getElementById('inspectUi').addEventListener('click', async () => {
  try {
    showAction(await send({ type: 'INSPECT_CHATGPT_UI' }));
  } catch (error) {
    showAction({ ok: false, error: error.message });
  }
});
document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
refresh().catch(error => showAction({ ok: false, error: error.message }));
