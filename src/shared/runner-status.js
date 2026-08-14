import { getActiveSelectorProfileMetadata } from './selector-registry.js';

function errorCodeFrom(value) {
  return value?.error?.code
    ?? value?.recovery_error?.code
    ?? value?.cleanup_error?.code
    ?? value?.terminal_error?.code
    ?? null;
}

function compactResult(value) {
  if (!value) return null;
  return {
    status: value.status ?? null,
    taskId: value.taskId ?? value.task_id ?? value.state?.task_id ?? null,
    error_code: errorCodeFrom(value) ?? errorCodeFrom(value.state)
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

function compactActiveExecution(state) {
  if (!state) return null;
  const project = state.task_project ?? null;
  const checkpoint = state.in_flight_round ?? null;
  const lease = state.lease ?? null;
  return {
    task_id: state.task_id ?? null,
    project_id: state.project_id ?? null,
    phase: state.phase ?? null,
    task_round_count: Number.isInteger(state.task_round_count) ? state.task_round_count : 0,
    task_patch_count: Number.isInteger(state.task_patch_count) ? state.task_patch_count : 0,
    patch_goal_minimum: state.task_snapshot?.patch_goal?.minimum ?? null,
    initialization_completed: state.initialization_completed === true,
    project_name: state.chatgpt_project_name ?? project?.project_name ?? null,
    session_id: state.session_id ?? project?.session_id ?? null,
    project_status: project?.status ?? null,
    in_flight_round_number: checkpoint?.round_number ?? null,
    in_flight_stage: checkpoint?.stage ?? null,
    last_task_status: state.last_task_status ?? null,
    terminal_reason: state.terminal_reason ?? null,
    terminal_action: state.terminal_action ?? null,
    terminal_status: state.terminal_action === 'CONTEXT_LIMIT' || state.terminal_reason === 'CHAT_LENGTH_LIMIT' ? 'context_limit' : null,
    lease: lease ? {
      present: true,
      ttl_ms: Number.isFinite(lease.ttl_ms) ? lease.ttl_ms : null,
      expires_at: lease.expires_at ?? null
    } : { present: false, ttl_ms: null, expires_at: null },
    error_code: errorCodeFrom(state)
  };
}

export function buildRunnerStatusView({ running = false, activeExecution = null, lastRun = null, lastRecovery = null, settings = null, uiCompatibilityTelemetry = null } = {}) {
  const config = settings ?? {};
  return {
    running: Boolean(running),
    selector_profile: getActiveSelectorProfileMetadata(),
    ui_compatibility: compactUiCompatibility(uiCompatibilityTelemetry),
    settings: {
      mode: config.mode ?? 'mock',
      task_api_configured: Boolean(config.taskApiBaseUrl),
      patch_transfer_mode: config.patchTransferMode === 'remote' ? 'remote' : 'local',
      remote_e2e_test_mode: config.remoteE2eTestMode === true,
      remote_production_mode: config.remoteProductionMode === true
    },
    activeExecution: compactActiveExecution(activeExecution),
    lastRun: compactResult(lastRun),
    lastRecovery: compactResult(lastRecovery)
  };
}
