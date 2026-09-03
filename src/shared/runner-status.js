import { getActiveSelectorProfileMetadata } from './selector-registry.js';
import { normalizeWorkspaceMode, resolveWorkspaceMode } from './workspace-mode.js';
import { DEFAULT_INTERACTION_PACING_MS, normalizeInteractionPacingMs } from './interaction-pacing.js';

function errorCodeFrom(value) {
  return value?.error?.code
    ?? value?.recovery_error?.code
    ?? value?.cleanup_error?.code
    ?? value?.terminal_error?.code
    ?? null;
}

function compactError(error) {
  if (!error || error.safe !== true) return null;
  return {
    name: typeof error.name === 'string' ? error.name : 'Error',
    code: typeof error.code === 'string' ? error.code : 'UNEXPECTED',
    message: typeof error.message === 'string' ? error.message : null,
    details: error.details && typeof error.details === 'object' ? { ...error.details } : null
  };
}

function stageStatus(done, failed = false) {
  if (failed) return 'failed';
  return done ? 'passed' : 'pending';
}

function successfulPatchCount(state) {
  const local = Number.isInteger(state?.task_patch_count) ? state.task_patch_count : 0;
  const server = Number.isInteger(state?.server_successful_patch_count) ? state.server_successful_patch_count : 0;
  return Math.max(local, server);
}

function buildExecutionTrace(value) {
  const state = value?.state ?? null;
  if (!state) return [];
  const hasTraceState = Boolean(
    state.task_id || state.assignment_id || state.execution_id || state.source_preparation ||
    state.patch_session_id || state.browser_workspace_id || state.chatgpt_project_name ||
    state.initialization_completed === true || successfulPatchCount(state) > 0 || state.business_completed === true
  );
  if (!hasTraceState) return [];
  const errorCode = errorCodeFrom(value) ?? errorCodeFrom(state) ?? null;
  const source = state.source_preparation ?? null;
  const sourceReady = source?.status === 'succeeded';
  const patchSyncError = typeof errorCode === 'string' && errorCode.startsWith('PATCHSYNC_');
  const exportFailed = source?.status === 'failed' || (Boolean(source?.export_id) && patchSyncError);
  const projectReady = Boolean(state.chatgpt_project_name || state.browser_workspace_id);
  const projectFailed = sourceReady && !projectReady && Boolean(errorCode);
  const initReady = state.initialization_completed === true;
  return [
    { id: 'assignment', status: stageStatus(Boolean(state.assignment_id)) },
    { id: 'claim', status: stageStatus(Boolean(state.assignment_id && state.execution_id)) },
    { id: 'execution', status: stageStatus(Boolean(state.execution_id)) },
    { id: 'bootstrap', status: stageStatus(Boolean(source || state.patch_session_id)) },
    { id: 'export', status: stageStatus(Boolean(source?.export_id), exportFailed) },
    { id: 'source', status: stageStatus(sourceReady, errorCode === 'RESOURCE_DOWNLOAD_FAILED') },
    { id: 'project', status: stageStatus(projectReady, projectFailed) },
    { id: 'upload', status: stageStatus(initReady, errorCode === 'RESOURCE_UPLOAD_FAILED') },
    { id: 'prompt', status: stageStatus(initReady) },
    { id: 'patch', status: stageStatus(successfulPatchCount(state) > 0) },
    { id: 'completion', status: stageStatus(state.business_completed === true) }
  ];
}

function compactResult(value) {
  if (!value) return null;
  const error = compactError(value.error);
  const trace = buildExecutionTrace(value);
  return {
    status: value.status ?? null,
    taskId: value.taskId ?? value.task_id ?? value.state?.task_id ?? null,
    error_code: errorCodeFrom(value) ?? errorCodeFrom(value.state),
    ...(error ? { error } : {}),
    ...(trace.length > 0 ? { trace } : {})
  };
}


function compactUiCompatibility(value) {
  const totalEvents = Math.max(0, Number(value?.total_events) || 0);
  const event = value?.last_event ?? null;
  if (!event) return { total_events: totalEvents, last_event: null };
  const profile = event.selector_profile ?? null;
  return {
    total_events: totalEvents,
    last_event: {
      selector_profile: profile ? {
        id: typeof profile.id === 'string' ? profile.id : 'unknown',
        version: Number.isInteger(profile.version) ? profile.version : null
      } : { id: 'unknown', version: null },
      operation: typeof event.operation === 'string' ? event.operation : 'UNKNOWN_OPERATION',
      error_code: typeof event.error_code === 'string' ? event.error_code : 'UNEXPECTED',
      access_status: typeof event.access_status === 'string' ? event.access_status : 'UNKNOWN',
      page_category: typeof event.page_category === 'string' ? event.page_category : 'unknown',
      at: typeof event.at === 'string' ? event.at : null
    }
  };
}

function safeRecoveryReason(error) {
  const message = String(error?.message ?? '');
  if (/Persisted sent Prompt is not the latest ChatGPT user message/.test(message)) return 'persisted_prompt_not_latest';
  if (/Sent Prompt recovery state is ambiguous/.test(message)) return 'sent_prompt_state_ambiguous';
  if (/Response-ready checkpoint does not match/.test(message)) return 'response_checkpoint_mismatch';
  if (/Prompt intent may already have been sent/.test(message)) return 'prompt_intent_ambiguous';
  if (/does not prove that the durable Prompt intent is still unsent/.test(message)) return 'prompt_unsent_not_proven';
  if (/Unsupported in-flight round checkpoint stage/.test(message)) return 'unsupported_round_checkpoint';
  return null;
}


function compactSourceDiagnostic(error) {
  if (!error || typeof error !== 'object' || !String(error.code ?? '').startsWith('PATCHSYNC_')) return null;
  const details = error.details && typeof error.details === 'object' ? error.details : {};
  const safeDetails = {};
  for (const key of ['origin', 'operation', 'project_id', 'export_id', 'stage', 'server_reason', 'cause']) {
    if (typeof details[key] === 'string' && details[key].trim()) safeDetails[key] = details[key].trim().slice(0, 500);
  }
  if (Number.isInteger(Number(details.status))) safeDetails.status = Number(details.status);
  return {
    code: typeof error.code === 'string' ? error.code : 'UNEXPECTED',
    message: typeof error.message === 'string' ? error.message.slice(0, 500) : null,
    ...(Object.keys(safeDetails).length > 0 ? { details: safeDetails } : {})
  };
}

function compactSourceExport(source) {
  if (!source || typeof source !== 'object' || typeof source.export_id !== 'string') return null;
  return {
    export_id: source.export_id,
    status: typeof source.remote_status === 'string' ? source.remote_status : source.status ?? null,
    stage: typeof source.stage === 'string' ? source.stage : null
  };
}

function compactInfrastructureWait(value) {
  if (!value || typeof value !== 'object') return null;
  const service = typeof value.service === 'string' ? value.service : null;
  if (!service) return null;
  return {
    service,
    operation: typeof value.operation === 'string' ? value.operation : null,
    started_at: typeof value.started_at === 'string' ? value.started_at : null,
    next_retry_at: typeof value.next_retry_at === 'string' ? value.next_retry_at : null,
    last_error_code: typeof value.last_error_code === 'string' ? value.last_error_code : null
  };
}


function compactLegacyProjectCleanup(value) {
  if (!value || typeof value !== 'object') return null;
  const status = typeof value.status === 'string' ? value.status : null;
  if (!status) return null;
  return {
    status,
    scanned: Math.max(0, Number(value.scanned) || 0),
    matched: Math.max(0, Number(value.matched) || 0),
    deleted: Math.max(0, Number(value.deleted) || 0),
    failed: Math.max(0, Number(value.failed) || 0)
  };
}
function compactRecoveryBudget(value) {
  if (!value || typeof value !== 'object') return null;
  const attempts = Number(value.attempts);
  const maxAttempts = Number(value.max_attempts);
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isInteger(maxAttempts) || maxAttempts < 1) return null;
  return {
    attempts,
    max_attempts: maxAttempts,
    exhausted: value.exhausted === true,
    first_at: typeof value.first_at === 'string' ? value.first_at : null,
    last_at: typeof value.last_at === 'string' ? value.last_at : null
  };
}

function compactPatchDelivery(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    stage: typeof value.stage === 'string' ? value.stage : null,
    round_number: Number.isInteger(value.round_number) ? value.round_number : null,
    attempt: Number.isInteger(value.attempt) ? value.attempt : 0,
    filename: typeof value.filename === 'string' ? value.filename : null,
    error_code: typeof value.error_code === 'string' ? value.error_code : null,
    reason: typeof value.reason === 'string' ? value.reason : null,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : null
  };
}

function compactActiveExecution(state) {
  if (!state) return null;
  const project = state.task_project ?? null;
  const checkpoint = state.in_flight_round ?? null;
  const lease = state.lease ?? null;
  const localPatchCount = Number.isInteger(state.task_patch_count) ? state.task_patch_count : 0;
  const serverPatchCount = Number.isInteger(state.server_successful_patch_count) ? state.server_successful_patch_count : 0;
  const externalWait = state.external_wait ?? null;
  const statusChecks = externalWait ? {
    query_count: Number.isInteger(externalWait.query_count) ? externalWait.query_count : 0,
    last_query_at: externalWait.last_query_at ?? externalWait.last_checked_at ?? null,
    next_query_at: externalWait.next_check_at ?? state.next_recovery_at ?? null,
    last_result: externalWait.last_result ?? null,
    last_patch_reconcile_at: externalWait.last_patch_reconcile_at ?? null,
    last_patch_reconcile_result: externalWait.last_patch_reconcile_result ?? null,
    last_completion_check_at: externalWait.last_completion_check_at ?? null
  } : null;
  return {
    task_id: state.task_id ?? null,
    project_id: state.project_id ?? null,
    phase: state.phase ?? null,
    local_started_at: typeof state.local_started_at === 'string' ? state.local_started_at : null,
    task_round_count: Number.isInteger(state.task_round_count) ? state.task_round_count : 0,
    task_patch_count: Math.max(localPatchCount, serverPatchCount),
    ...(serverPatchCount > 0 ? { local_task_patch_count: localPatchCount, server_successful_patch_count: serverPatchCount } : {}),
    patch_goal_minimum: state.task_snapshot?.patch_goal?.minimum ?? null,
    initialization_completed: state.initialization_completed === true,
    project_name: state.chatgpt_project_name ?? project?.project_name ?? null,
    session_id: state.session_id ?? project?.session_id ?? null,
    project_status: project?.status ?? null,
    workspace_mode: resolveWorkspaceMode(state),
    workspace_status: state.task_workspace?.status ?? project?.status ?? null,
    conversation_identity_present: Boolean(state.task_workspace?.conversation_id ?? state.chatgpt_conversation_id),
    in_flight_round_number: checkpoint?.round_number ?? null,
    in_flight_stage: checkpoint?.stage ?? null,
    last_task_status: state.last_task_status ?? null,
    terminal_reason: state.terminal_reason ?? null,
    terminal_action: state.terminal_action ?? null,
    terminal_status: state.terminal_action === 'CONTEXT_LIMIT' || state.terminal_reason === 'CHAT_LENGTH_LIMIT' ? 'context_limit' : null,
    ...(typeof state.browser_slot_id === 'string' && state.browser_slot_id ? { browser_slot_id: state.browser_slot_id } : {}),
    ...(state.chatgpt_tab_id != null && Number.isInteger(Number(state.chatgpt_tab_id)) ? { chatgpt_tab_id: Number(state.chatgpt_tab_id) } : {}),
    ...(state.next_recovery_at ? { next_recovery_at: state.next_recovery_at } : {}),
    ...(compactInfrastructureWait(state.infrastructure_wait) ? { infrastructure_wait: compactInfrastructureWait(state.infrastructure_wait) } : {}),
    ...(compactSourceExport(state.source_preparation) ? { source_export: compactSourceExport(state.source_preparation) } : {}),
    ...(compactSourceDiagnostic(state.recovery_error) ? { recovery_error: compactSourceDiagnostic(state.recovery_error) } : {}),
    ...(safeRecoveryReason(state.recovery_error) ? { recovery_reason: safeRecoveryReason(state.recovery_error) } : {}),
    ...(compactRecoveryBudget(state.recovery_block) ? { recovery_budget: compactRecoveryBudget(state.recovery_block) } : {}),
    ...(compactPatchDelivery(state.patch_delivery) ? { patch_delivery: compactPatchDelivery(state.patch_delivery) } : {}),
    ...(compactLegacyProjectCleanup(state.legacy_project_cleanup) ? { legacy_project_cleanup: compactLegacyProjectCleanup(state.legacy_project_cleanup) } : {}),
    ...(statusChecks ? { status_checks: statusChecks } : {}),
    lease: lease ? {
      present: true,
      ttl_ms: Number.isFinite(lease.ttl_ms) ? lease.ttl_ms : null,
      expires_at: lease.expires_at ?? null
    } : { present: false, ttl_ms: null, expires_at: null },
    error_code: errorCodeFrom(state)
  };
}

export function buildRunnerStatusView({ running = false, manualPaused = false, autoRunEnabled = false, activeExecution = null, lastRun = null, lastRecovery = null, settings = null, uiCompatibilityTelemetry = null } = {}) {
  const config = settings ?? {};
  const lastRunTransferMode = ['local', 'remote', 'patchsync'].includes(lastRun?.state?.patch_transfer_mode)
    ? lastRun.state.patch_transfer_mode
    : null;
  return {
    running: Boolean(running),
    paused: manualPaused === true,
    auto_run_enabled: autoRunEnabled === true,
    selector_profile: getActiveSelectorProfileMetadata(),
    ui_compatibility: compactUiCompatibility(uiCompatibilityTelemetry),
    settings: {
      mode: config.mode ?? 'mock',
      task_api_configured: Boolean(config.taskApiBaseUrl),
      patch_transfer_mode: activeExecution?.browser_execution_bootstrap?.patchsync
        ? 'patchsync'
        : !activeExecution && lastRunTransferMode
          ? lastRunTransferMode
          : config.patchTransferMode === 'remote' ? 'remote' : 'local',
      remote_e2e_test_mode: config.remoteE2eTestMode === true,
      remote_production_mode: config.remoteProductionMode === true,
      cleanup_legacy_projects: config.cleanupLegacyProjects === true,
      interaction_pacing_ms: normalizeInteractionPacingMs(config.interactionPacingMs, DEFAULT_INTERACTION_PACING_MS),
      workspace_mode: normalizeWorkspaceMode(config.workspaceMode)
    },
    activeExecution: compactActiveExecution(activeExecution),
    activeTrace: activeExecution ? buildExecutionTrace({ state: activeExecution }) : [],
    lastRun: compactResult(lastRun),
    lastRecovery: compactResult(lastRecovery)
  };
}
