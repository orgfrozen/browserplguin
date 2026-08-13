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
    lease: lease ? {
      present: true,
      ttl_ms: Number.isFinite(lease.ttl_ms) ? lease.ttl_ms : null,
      expires_at: lease.expires_at ?? null
    } : { present: false, ttl_ms: null, expires_at: null },
    error_code: errorCodeFrom(state)
  };
}

export function buildRunnerStatusView({ running = false, activeExecution = null, lastRun = null, lastRecovery = null, settings = null } = {}) {
  const config = settings ?? {};
  return {
    running: Boolean(running),
    selector_profile: getActiveSelectorProfileMetadata(),
    settings: {
      mode: config.mode ?? 'mock',
      task_api_configured: Boolean(config.taskApiBaseUrl)
    },
    activeExecution: compactActiveExecution(activeExecution),
    lastRun: compactResult(lastRun),
    lastRecovery: compactResult(lastRecovery)
  };
}
