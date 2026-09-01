import { selectRuntimePanelSource } from './runtime-panel.js';
import { formatLocalRuntime } from './task-runtime.js';

const actionResultEl = document.getElementById('actionResult');
const SELECTED_SLOT_STORAGE_KEY = 'popup.selectedSlotId';
let latestRunnerStatus = null;

function loadSelectedSlotId() {
  try {
    return localStorage.getItem(SELECTED_SLOT_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

function persistSelectedSlotId(slotId) {
  try {
    if (slotId) localStorage.setItem(SELECTED_SLOT_STORAGE_KEY, slotId);
    else localStorage.removeItem(SELECTED_SLOT_STORAGE_KEY);
  } catch {}
}

function setSelectedSlotId(slotId) {
  selectedSlotId = slotId || null;
  persistSelectedSlotId(selectedSlotId);
}

let selectedSlotId = loadSelectedSlotId();

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

function formatPatchCheckpoint(checkpoint) {
  if (!checkpoint) return '-';
  const attempt = Number.isInteger(checkpoint.attempt) && checkpoint.attempt > 0 ? `attempt ${checkpoint.attempt}` : null;
  return [checkpoint.stage, attempt, checkpoint.filename, checkpoint.reason].filter(Boolean).join(' · ') || '-';
}

function fallbackCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand?.('copy') === true;
  textarea.remove();
  return copied;
}

function formatStatusTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatProjectCreateCircuitRetry(circuit) {
  if (circuit?.state === 'half_open') return 'probe allowed';
  if (circuit?.state !== 'open' || !circuit?.retry_at) return '-';
  const retryAt = Date.parse(circuit.retry_at);
  if (!Number.isFinite(retryAt)) return formatStatusTime(circuit.retry_at);
  const remainingSeconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${formatStatusTime(circuit.retry_at)} · ${minutes}m ${seconds}s`;
}

function formatInfrastructureCircuit(circuit) {
  if (!circuit) return '-';
  return [circuit.state ?? 'closed', circuit.service].filter(Boolean).join(' · ');
}

function formatInfrastructureCircuitRetry(circuit) {
  if (circuit?.state !== 'open' || !circuit?.retry_at) return '-';
  const remainingMs = Math.max(0, Number(circuit.retry_remaining_ms) || (Date.parse(circuit.retry_at) - Date.now()));
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${formatStatusTime(circuit.retry_at)} · ${remainingSeconds}s`;
}

function formatInfrastructureCircuitFailure(circuit) {
  if (!circuit?.last_failure_at && !circuit?.last_error_code) return '-';
  return [
    formatStatusTime(circuit.last_failure_at),
    circuit.last_service,
    circuit.last_operation,
    circuit.last_error_code
  ].filter(Boolean).join(' · ');
}

function formatInfrastructureWait(wait) {
  if (!wait?.service) return '-';
  return [
    wait.service,
    wait.operation,
    wait.next_retry_at ? formatStatusTime(wait.next_retry_at) : null
  ].filter(Boolean).join(' · ');
}

function formatBackpressureRecovery(backpressure) {
  if (!backpressure?.next_recovery_at) return '-';
  const remainingMs = Math.max(0, Number(backpressure.next_recovery_in_ms) || (Date.parse(backpressure.next_recovery_at) - Date.now()));
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${formatStatusTime(backpressure.next_recovery_at)} · ${remainingSeconds}s`;
}

function formatBackpressureMetrics(backpressure) {
  const metrics = backpressure?.metrics ?? {};
  return [
    `queue ${Math.max(0, Number(metrics.ui_queue_pending) || 0)}`,
    `recovering ${Math.max(0, Number(metrics.recovering_slots) || 0)}`,
    `failing ${Math.max(0, Number(metrics.failing_slots) || 0)}`
  ].join(' · ');
}

function formatBackpressureLastPressure(backpressure) {
  const reasons = Array.isArray(backpressure?.last_pressure_reasons) ? backpressure.last_pressure_reasons.filter(Boolean) : [];
  if (!backpressure?.last_pressure_at && reasons.length === 0) return '-';
  return [formatStatusTime(backpressure.last_pressure_at), ...reasons].filter(Boolean).join(' · ');
}

function formatPressureDeadline(value, remainingMs = null) {
  if (!value) return '-';
  const parsed = Date.parse(value);
  const remaining = Number.isFinite(Number(remainingMs))
    ? Math.max(0, Number(remainingMs))
    : Number.isFinite(parsed) ? Math.max(0, parsed - Date.now()) : 0;
  const seconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${formatStatusTime(value)} · ${minutes}m ${seconds % 60}s`;
}

function formatSchedulerCommand(event) {
  if (!event) return '-';
  const result = event.phase === 'failed'
    ? [event.phase, event.error_code, event.http_status ? `HTTP ${event.http_status}` : null]
    : [event.phase, event.assignment_found === false ? 'no assignment' : null, event.task_id, event.assignment_id];
  return [formatStatusTime(event.at), event.slot_id, ...result].filter(Boolean).join(' · ');
}

function formatSchedulerReconciliation(scheduler) {
  if (!scheduler || Number(scheduler.reconciliation_wait_count) <= 0) return '-';
  return [
    `${scheduler.reconciliation_wait_count} waiting`,
    scheduler.recovery_error_code,
    scheduler.recovery_control_state,
    scheduler.next_reconciliation_at ? `retry ${formatStatusTime(scheduler.next_reconciliation_at)}` : null
  ].filter(Boolean).join(' · ');
}

function formatProjectCreateCircuitFailure(circuit) {
  const failures = Array.isArray(circuit?.failures) ? circuit.failures : [];
  const latest = failures.at(-1);
  if (!latest) return '-';
  return [formatStatusTime(latest.at), latest.message].filter(Boolean).join(' · ') || '-';
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

function safeDiagnostic(status, selectedSlot) {
  return {
    runner: {
      running: status?.running === true,
      paused: status?.paused === true,
      mode: status?.settings?.mode ?? null,
      slot_id: selectedSlot?.slot_id ?? null,
      activeExecution: selectedSlot?.activeExecution ?? status?.activeExecution ?? null
    },
    lastRun: selectedSlot?.lastRun ?? status?.lastRun ?? null,
    lastRecovery: selectedSlot?.lastRecovery ?? status?.lastRecovery ?? null,
    adaptiveBackpressure: status?.adaptive_backpressure ?? null,
    chatgptRuntimeTelemetry: status?.chatgpt_runtime_telemetry ?? null,
    infrastructureCircuit: status?.infrastructure_circuit ?? null,
    scheduler: status?.scheduler_diagnostics ?? null,
    uiCompatibility: status?.ui_compatibility ?? null
  };
}

function activeTaskSlots(status) {
  return (Array.isArray(status?.slots) ? status.slots : []).filter(slot => slot?.activeExecution?.task_id);
}

function selectedActiveSlot(status) {
  const slots = activeTaskSlots(status);
  let selected = slots.find(slot => slot.slot_id === selectedSlotId) ?? null;
  if (!selected) selected = slots.find(slot => slot.slot_id === status?.active_slot_id) ?? slots[0] ?? null;
  selectedSlotId = selected?.slot_id ?? null;
  persistSelectedSlotId(selectedSlotId);
  return selected;
}

function taskCardButton(label, action, slotId, { danger = false } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.slotAction = action;
  button.dataset.slotId = slotId;
  if (danger) button.className = 'task-card-danger';
  return button;
}

function renderActiveTaskList(status) {
  const container = document.getElementById('activeTaskList');
  container.replaceChildren();
  const slots = activeTaskSlots(status);
  if (slots.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'task-card-empty';
    empty.textContent = '暂无运行中的 Task';
    container.append(empty);
    return;
  }
  for (const slot of slots) {
    const active = slot.activeExecution;
    const card = document.createElement('section');
    card.className = `task-card${slot.slot_id === selectedSlotId ? ' task-card-selected' : ''}`;
    card.dataset.slotId = slot.slot_id;

    const selector = document.createElement('button');
    selector.type = 'button';
    selector.className = 'task-card-select';
    selector.dataset.slotSelect = slot.slot_id;
    selector.setAttribute('aria-pressed', slot.slot_id === selectedSlotId ? 'true' : 'false');
    selector.setAttribute('aria-label', `查看 ${active.project_id ?? active.project_name ?? 'Task'} ${active.task_id ?? ''}`.trim());

    const heading = document.createElement('div');
    heading.className = 'task-card-heading';
    const project = document.createElement('strong');
    project.textContent = active.project_id ?? active.project_name ?? 'Task';
    const phase = document.createElement('span');
    phase.className = 'task-card-phase';
    phase.textContent = active.phase ?? '-';
    heading.append(project, phase);

    const runtime = document.createElement('div');
    runtime.className = 'task-card-runtime';
    runtime.textContent = `运行时长 ${formatLocalRuntime(active.local_started_at)}`;

    const task = document.createElement('div');
    task.className = 'task-card-task';
    task.textContent = active.task_id ?? '-';
    const meta = document.createElement('div');
    meta.className = 'task-card-meta';
    const workspace = active.workspace_mode === 'chat' ? 'Chat' : 'Project';
    meta.textContent = [`Workspace: ${workspace}`, slot.slot_id, Number.isInteger(active.chatgpt_tab_id) ? `tab ${active.chatgpt_tab_id}` : null, active.in_flight_stage].filter(Boolean).join(' · ');

    const alertText = [active.error_code, active.recovery_reason].filter(Boolean).join(' · ');
    const alert = alertText ? document.createElement('div') : null;
    if (alert) {
      alert.className = 'task-card-alert';
      alert.textContent = `⚠ ${alertText}`;
    }

    const actions = document.createElement('div');
    actions.className = 'task-card-actions';
    actions.append(
      taskCardButton('打开 Tab', 'open', slot.slot_id),
      taskCardButton('终止', 'terminate', slot.slot_id, { danger: true })
    );
    selector.append(heading, runtime, task, meta);
    if (alert) selector.append(alert);
    card.append(selector, actions);
    container.append(card);
  }
}

async function terminateSelectedTask(slotId = selectedSlotId) {
  if (!slotId) return null;
  const slot = activeTaskSlots(latestRunnerStatus).find(item => item.slot_id === slotId);
  const active = slot?.activeExecution ?? null;
  if (!active) return null;
  const description = [active.project_id ?? active.project_name, active.task_id, slotId].filter(Boolean).join(' · ');
  if (!confirm(`确定终止这个 Task？\n${description}\n终止后服务端不会再次调度这个 Task。`)) return null;
  const result = await send({ type: 'TERMINATE_TASK', slotId });
  if (selectedSlotId === slotId) setSelectedSlotId(null);
  showAction(result);
  await refresh();
  return result;
}

function renderRunnerStatus(status) {
  latestRunnerStatus = status ?? null;
  const selectedSlot = selectedActiveSlot(status);
  const active = selectedSlot?.activeExecution ?? null;
  const activeSlotId = selectedSlot?.slot_id ?? null;
  renderActiveTaskList(status);
  const paused = status?.paused === true;
  const pauseButton = document.getElementById('togglePause');
  const toggleAutoRunButton = document.getElementById('toggleAutoRun');
  const toggleDrainButton = document.getElementById('toggleDrain');
  const runRealButton = document.getElementById('runReal');
  const terminateButton = document.getElementById('terminateTask');
  const autoRunEnabled = status?.auto_run_enabled === true;
  const drainEnabled = status?.drain_enabled === true;
  pauseButton.textContent = paused ? '继续' : '暂停';
  toggleAutoRunButton.textContent = autoRunEnabled ? '关闭自动运行' : '启用自动运行';
  toggleDrainButton.textContent = drainEnabled ? '恢复领取' : '开始排空';
  runRealButton.disabled = paused || autoRunEnabled || drainEnabled;
  terminateButton.disabled = !active;
  terminateButton.dataset.slotId = activeSlotId ?? '';
  setText('runnerMode', status?.settings?.mode ?? '-');
  setText('runnerState', paused ? 'paused' : status?.running ? 'running' : active ? 'active / waiting' : 'idle');
  setText('autoRunnerState', autoRunEnabled ? (paused ? 'enabled · paused' : 'enabled') : 'disabled');
  setText('drainState', drainEnabled ? 'draining · no new claims' : 'disabled');
  const maxParallelTasks = Number(status?.max_parallel_tasks ?? status?.settings?.max_parallel_tasks ?? 1);
  const effectiveParallelTasks = Number(status?.effective_parallel_tasks ?? maxParallelTasks);
  const maxParallelTasksControl = document.getElementById('maxParallelTasksControl');
  maxParallelTasksControl.value = String(maxParallelTasks);
  const activeTaskCount = Number(status?.active_task_count ?? (active ? 1 : 0));
  setText('parallelTaskState', effectiveParallelTasks < maxParallelTasks
    ? `${activeTaskCount}/${effectiveParallelTasks} effective · max ${maxParallelTasks}`
    : `${activeTaskCount}/${maxParallelTasks}`);
  setText('claimableTaskCount', status?.claimable_task_count ?? 0);
  setText('parkedExternalCount', status?.parked_external_count ?? 0);
  setText('parkedCleanupCount', status?.parked_cleanup_count ?? 0);
  setText('quarantinedSlotCount', status?.quarantined_slot_count ?? 0);
  const backpressure = status?.adaptive_backpressure ?? {};
  const backpressureReasons = Array.isArray(backpressure.reasons) ? backpressure.reasons.filter(Boolean) : [];
  setText('backpressureState', [backpressure.state ?? 'normal', ...backpressureReasons].join(' · '));
  const interactionPacing = status?.interaction_pacing ?? {};
  const pacingConfigured = Number(interactionPacing.configured_ms ?? status?.settings?.interaction_pacing_ms ?? 0);
  setText('interactionPacingState', pacingConfigured <= 0 || interactionPacing.enabled === false
    ? 'off · 0 ms'
    : `${interactionPacing.profile ?? 'custom'} · base ${pacingConfigured} ms · effective ${Number(interactionPacing.effective_base_ms ?? pacingConfigured)} ms · pressure ×${Number(interactionPacing.pressure_multiplier ?? 1).toFixed(2)} · jitter ±${Number(interactionPacing.jitter_percent ?? 20)}%`);
  setText('backpressureMetrics', formatBackpressureMetrics(backpressure));
  setText('backpressureRecovery', formatBackpressureRecovery(backpressure));
  setText('backpressureLastPressure', formatBackpressureLastPressure(backpressure));
  setText('pressureGovernorState', [backpressure.pressure_level ?? 'normal', backpressure.state === 'cooldown' ? 'new launches paused' : null].filter(Boolean).join(' · '));
  setText('pressureGovernorCooldown', backpressure.cooldown_until
    ? formatPressureDeadline(backpressure.cooldown_until, backpressure.cooldown_remaining_ms)
    : '-');
  setText('pressureGovernorLaunch', backpressure.next_launch_at
    ? [formatPressureDeadline(backpressure.next_launch_at, backpressure.next_launch_in_ms), backpressure.last_launch_slot_id].filter(Boolean).join(' · ')
    : '-');
  const infrastructureCircuit = status?.infrastructure_circuit ?? null;
  setText('infrastructureCircuitState', formatInfrastructureCircuit(infrastructureCircuit));
  setText('infrastructureCircuitRetry', formatInfrastructureCircuitRetry(infrastructureCircuit));
  setText('infrastructureCircuitFailure', formatInfrastructureCircuitFailure(infrastructureCircuit));
  const scheduler = status?.scheduler_diagnostics ?? null;
  setText('schedulerState', scheduler?.state ?? '-');
  setText('schedulerLastAuto', scheduler?.last_auto_tick_at
    ? [formatStatusTime(scheduler.last_auto_tick_at), scheduler.last_auto_status].filter(Boolean).join(' · ')
    : '-');
  setText('schedulerLastNext', formatSchedulerCommand(scheduler?.last_next));
  setText('schedulerLastClaim', formatSchedulerCommand(scheduler?.last_claim));
  setText('schedulerReconciliation', formatSchedulerReconciliation(scheduler));
  const projectCreateCircuit = status?.project_create_circuit ?? {};
  setText('projectCreateCircuitState', projectCreateCircuit.state ?? 'closed');
  setText('projectCreateCircuitRetry', formatProjectCreateCircuitRetry(projectCreateCircuit));
  setText('projectCreateCircuitFailure', formatProjectCreateCircuitFailure(projectCreateCircuit));
  const workspaceModeControl = document.getElementById('workspaceModeControl');
  workspaceModeControl.value = status?.settings?.workspace_mode === 'chat' ? 'chat' : 'project';
  const cleanupLegacyProjects = status?.settings?.cleanup_legacy_projects === true;
  const cleanupLegacyProjectsToggle = document.getElementById('cleanupLegacyProjectsToggle');
  cleanupLegacyProjectsToggle.checked = cleanupLegacyProjects;
  setText('cleanupLegacyProjectsState', cleanupLegacyProjects ? '开启' : '关闭');
  setText('patchTransferMode', status?.settings?.patch_transfer_mode ?? 'local');
  setText('remoteE2eTestMode', status?.settings?.remote_e2e_test_mode ? 'enabled (test only)' : 'disabled');
  setText('remoteProductionMode', status?.settings?.remote_production_mode ? 'enabled' : 'disabled');
  setText('activeTask', active ? [active.task_id, active.project_id].filter(Boolean).join(' · ') : '-');
  setText('activePhase', active?.phase ?? '-');
  setText('activeRound', active?.task_round_count ?? '-');
  setText('activePatchCount', active?.task_patch_count ?? '-');
  setText('activePatchGoal', active?.patch_goal_minimum ?? '-');
  setText('activeProject', active ? (active.workspace_mode === 'chat' ? 'Chat' : (active.project_name ?? 'Project')) : '-');
  setText('activeSession', active?.session_id ?? '-');
  setText('activeRoundStage', active?.in_flight_stage ?? '-');
  setText('activeSlotTab', [active?.browser_slot_id, Number.isInteger(active?.chatgpt_tab_id) ? `tab ${active.chatgpt_tab_id}` : null].filter(Boolean).join(' · ') || '-');
  setText('activePatchCheckpoint', formatPatchCheckpoint(active?.patch_delivery));
  setText('activeRecoveryReason', [
    active?.error_code,
    active?.recovery_error?.message ?? active?.recovery_reason,
    active?.source_export?.export_id,
    active?.source_export?.stage
  ].filter(Boolean).join(' · ') || '-');
  setText('activeInfrastructureWait', formatInfrastructureWait(active?.infrastructure_wait));
  setText('activeNextRecovery', formatStatusTime(active?.next_recovery_at));
  setText('activeLease', formatLease(active?.lease));
  setText('lastRun', formatResult(selectedSlot?.lastRun ?? status?.lastRun));
  setText('lastRecovery', formatResult(selectedSlot?.lastRecovery ?? status?.lastRecovery));
  const statusChecks = active?.status_checks ?? null;
  setText('statusQueryCount', statusChecks ? statusChecks.query_count ?? 0 : '-');
  setText('statusLastQuery', formatStatusTime(statusChecks?.last_query_at));
  setText('statusNextQuery', formatStatusTime(statusChecks?.next_query_at));
  setText('statusLastResult', statusChecks?.last_result ?? '-');
  setText('statusLastPatchReconcile', formatStatusTime(statusChecks?.last_patch_reconcile_at));
  setText('statusLastPatchReconcileResult', statusChecks?.last_patch_reconcile_result ?? '-');
  setText('statusLastCompletionCheck', formatStatusTime(statusChecks?.last_completion_check_at));
  const uiCompatibility = status?.ui_compatibility ?? null;
  setText('uiCompatibilityCount', uiCompatibility?.total_events ?? 0);
  setText('uiCompatibilityLast', formatUiCompatibilityLast(uiCompatibility?.last_event));
  const panelSource = selectRuntimePanelSource(selectedSlot ? {
    ...status,
    running: selectedSlot.running === true,
    activeExecution: selectedSlot.activeExecution ?? null,
    activeTrace: selectedSlot.activeTrace ?? [],
    lastRun: selectedSlot.lastRun ?? null,
    lastRecovery: selectedSlot.lastRecovery ?? null
  } : status);
  setText('runtimePanelMode', panelSource.label);
  setText('runtimePanelTask', active ? [active.project_id ?? active.project_name, active.task_id, activeSlotId].filter(Boolean).join(' · ') : '-');
  renderExecutionTrace(panelSource.trace);
  renderLatestRunError(panelSource.error);
}


const CALIBRATION_IDS = ['access','composer','model_state','latest_assistant','patch_candidates','context_limit','project_create','project_settings','project_delete','resource_input','new_chat','conversation_delete'];
const CALIBRATION_REVIEW_IDS = ['context_limit','patch_candidates','new_chat','project_create','project_settings','resource_input','project_delete','conversation_delete'];
const CALIBRATION_CAMPAIGN_IDS = ['new_chat','project_create','project_settings','resource_input','patch_candidates','context_limit','conversation_delete','project_delete'];
const CALIBRATION_CAMPAIGN_LABELS = Object.freeze({
  new_chat: 'New Chat',
  project_create: 'Project create',
  project_settings: 'Project settings',
  resource_input: 'Resource input',
  patch_candidates: 'Patch candidates',
  context_limit: 'Context limit',
  conversation_delete: 'Conversation delete',
  project_delete: 'Project delete'
});
const CALIBRATION_CAMPAIGN_INSTRUCTIONS = Object.freeze({
  SHOW_NEW_CHAT_CONTROL: '手动显示 New chat / 新聊天入口，然后 Capture。',
  SHOW_PROJECT_CREATE_CONTROL: '手动显示 New project / 新建项目入口，然后 Capture。',
  OPEN_PROJECT_SETTINGS_CONTROL: '进入真实 Project，并手动打开 Project settings 菜单/入口，然后 Capture。',
  SHOW_RESOURCE_INPUT_CONTROL: '打开可发送消息的 ChatGPT 页面，让附件输入控件存在；不要上传文件，然后 Capture。',
  SHOW_ASSISTANT_PATCH_CONTROL: '打开一条包含 Patch 下载卡片/按钮的 Assistant 回复，然后 Capture。',
  SHOW_CONTEXT_LIMIT_STATE: '打开已经出现 Context Limit 的真实对话状态，然后 Capture。',
  OPEN_CONVERSATION_DELETE_CONTROL: '手动打开一条真实聊天的更多菜单，让 Delete / 删除 action 可见；不要确认删除，然后 Capture。',
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
  setText('calibrationCampaignInstruction', complete ? '八项 live selector 均已有可复核 pass 证据。' : CALIBRATION_CAMPAIGN_INSTRUCTIONS[current?.instruction_code] ?? '按当前目标准备真实 ChatGPT UI 状态后 Capture。');
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

async function refreshDeferredDiagnostics() {
  await Promise.all([
    refreshCalibrationEvidence(),
    refreshCalibrationCoverage(),
    refreshCalibrationCampaign(),
    refreshResourceE2eEvidence(),
    refreshRemoteE2eEvidence(),
    refreshReleaseReadiness()
  ]);
}

function scheduleDeferredDiagnosticsRefresh() {
  setTimeout(() => {
    refreshDeferredDiagnostics().catch(error => showAction({ ok: false, error: error.message }));
  }, 100);
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
document.getElementById('toggleDrain').addEventListener('click', async () => {
  try {
    const enabled = latestRunnerStatus?.drain_enabled !== true;
    showAction(await send({ type: 'SET_DRAIN_MODE', enabled }));
    await refresh();
  } catch (error) {
    showAction({ ok: false, error: error.message });
  }
});

document.getElementById('maxParallelTasksControl').addEventListener('change', async event => {
  try {
    const maxParallelTasks = Number(event.currentTarget.value);
    showAction(await send({ type: 'SET_MAX_PARALLEL_TASKS', maxParallelTasks }));
    await refresh();
  } catch (error) {
    showAction({ ok: false, error: error.message });
    await refresh().catch(() => {});
  }
});

document.getElementById('workspaceModeControl').addEventListener('change', async event => {
  try {
    showAction(await send({ type: 'SET_WORKSPACE_MODE', workspaceMode: event.currentTarget.value }));
    await refresh();
  } catch (error) {
    showAction({ ok: false, error: error.message });
    await refresh().catch(() => {});
  }
});

document.getElementById('cleanupLegacyProjectsToggle').addEventListener('change', async event => {
  try {
    showAction(await send({ type: 'SET_CLEANUP_LEGACY_PROJECTS', enabled: event.currentTarget.checked }));
    await refresh();
  } catch (error) {
    showAction({ ok: false, error: error.message });
    await refresh().catch(() => {});
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
    await terminateSelectedTask();
  } catch (error) {
    showAction({ ok: false, error: error.message });
  }
});

function selectTaskSlot(slotId) {
  if (!slotId || !activeTaskSlots(latestRunnerStatus).some(slot => slot.slot_id === slotId)) return;
  setSelectedSlotId(slotId);
  renderRunnerStatus(latestRunnerStatus);
}

const activeTaskList = document.getElementById('activeTaskList');
activeTaskList.addEventListener('click', async event => {
  const button = event.target.closest?.('[data-slot-action]');
  if (button) {
    const slotId = button.dataset.slotId;
    const action = button.dataset.slotAction;
    try {
      if (action === 'open') {
        showAction(await send({ type: 'FOCUS_TASK_TAB', slotId }));
        return;
      }
      if (action === 'terminate') await terminateSelectedTask(slotId);
    } catch (error) {
      showAction({ ok: false, error: error.message });
    }
    return;
  }
  const card = event.target.closest?.('[data-slot-select]');
  if (card) selectTaskSlot(card.dataset.slotSelect);
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
  const selectedSlot = activeTaskSlots(latestRunnerStatus).find(slot => slot.slot_id === selectedSlotId) ?? null;
  const diagnostic = safeDiagnostic(latestRunnerStatus, selectedSlot);
  const text = JSON.stringify(diagnostic, null, 2);
  showAction({ safe_diagnostic: diagnostic });
  try {
    await navigator.clipboard.writeText(text);
    document.getElementById('copySafeDiagnostic').textContent = '已复制';
  } catch (error) {
    const copied = fallbackCopyText(text);
    document.getElementById('copySafeDiagnostic').textContent = copied ? '已复制' : '复制失败·已显示';
    if (!copied) showAction({ safe_diagnostic: diagnostic, copy_error: error.message });
  }
});

document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
const runnerRefreshTimer = setInterval(() => { refreshRunnerStatus().catch(() => {}); }, 1000);
window.addEventListener('unload', () => clearInterval(runnerRefreshTimer), { once: true });
refresh().then(() => scheduleDeferredDiagnosticsRefresh()).catch(error => showAction({ ok: false, error: error.message }));
