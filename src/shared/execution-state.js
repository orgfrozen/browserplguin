export function createExecutionState(task, { lease = null } = {}) {
  const control = task.agent_control ?? {};
  return {
    task_id: task.task_id,
    project_id: task.project_id,
    task_snapshot: structuredClone(task),
    agent_id: control.agent_id ?? lease?.agent_id ?? null,
    assignment_id: control.assignment_id ?? lease?.assignment_id ?? null,
    execution_id: control.execution_id ?? lease?.execution_id ?? null,
    lease_token: lease?.token ?? null,
    browser_execution_bootstrap: task.browser_execution_bootstrap ? structuredClone(task.browser_execution_bootstrap) : null,
    source_preparation: null,
    lease: lease ? structuredClone(lease) : null,
    phase: 'IDLE',
    browser_workspace_id: null,
    patch_session_id: null,
    session_id: null,
    chatgpt_project_name: null,
    task_round_count: 0,
    task_patch_count: 0,
    server_successful_patch_count: 0,
    initialization_completed: !task.resource,
    in_flight_round: null,
    downloaded_patch_keys: [],
    task_project: null,
    last_task_status: null,
    completion_preview: null,
    server_continuation_summary: null,
    fallback_count: 0,
    terminal_reason: null,
    terminal_action: null,
    terminal_payload: null,
    terminal_error: null,
    cleanup_error: null,
    recovery_error: null,
    recovery_state: null,
    external_wait: null,
    next_recovery_at: null,
    lease_loss: null,
    business_completed: false,
    last_meaningful_progress_at: null
  };
}

export function recordCreatedWorkspace(state, { projectName, browserWorkspaceId = null, sessionId = null }) {
  const patchSessionId = state.patch_session_id ?? state.source_preparation?.patch_session_id ?? sessionId ?? null;
  const workspaceId = browserWorkspaceId ?? state.browser_workspace_id ?? state.assignment_id ?? sessionId ?? projectName;
  const taskProject = browserWorkspaceId
    ? { project_name: projectName, browser_workspace_id: workspaceId, status: 'active' }
    : { project_name: projectName, session_id: patchSessionId, status: 'active' };
  return {
    ...state,
    browser_workspace_id: workspaceId,
    patch_session_id: patchSessionId,
    session_id: patchSessionId,
    chatgpt_project_name: projectName,
    task_project: taskProject
  };
}

export function recordRound(state) {
  return {
    ...state,
    task_round_count: state.task_round_count + 1
  };
}

export function recordCompletedPatch(state, patchKey, aliases = []) {
  if (state.downloaded_patch_keys.includes(patchKey)) return state;
  const keys = [...new Set([...state.downloaded_patch_keys, patchKey, ...aliases.filter(Boolean)])];
  return {
    ...state,
    task_patch_count: state.task_patch_count + 1,
    downloaded_patch_keys: keys
  };
}

export function markWorkspaceDeleted(state) {
  if (!state.task_project) return state;
  return {
    ...state,
    task_project: { ...state.task_project, status: 'deleted' }
  };
}


function requireRoundCheckpoint(state) {
  if (!state.in_flight_round) throw new Error('in_flight_round checkpoint is required');
  return state.in_flight_round;
}

export function checkpointRoundIntent(state, prompt) {
  return {
    ...state,
    in_flight_round: {
      round_number: state.task_round_count + 1,
      prompt: String(prompt),
      stage: 'READY_TO_SEND',
      assistant_text: null
    },
    server_continuation_summary: null
  };
}

export function markRoundPromptSent(state) {
  const checkpoint = requireRoundCheckpoint(state);
  return {
    ...state,
    in_flight_round: { ...checkpoint, stage: 'PROMPT_SENT' }
  };
}

export function markRoundResponseReady(state, assistantText) {
  const checkpoint = requireRoundCheckpoint(state);
  return {
    ...state,
    in_flight_round: {
      ...checkpoint,
      stage: 'RESPONSE_READY',
      assistant_text: String(assistantText ?? '')
    }
  };
}

export function completeRound(state, { status, fallbackCount }) {
  const checkpoint = requireRoundCheckpoint(state);
  if (checkpoint.round_number !== state.task_round_count + 1) {
    throw new Error('in_flight_round round_number does not match the next task round');
  }
  if (checkpoint.stage !== 'RESPONSE_READY') {
    throw new Error('in_flight_round must be RESPONSE_READY before committing the Task round');
  }
  return {
    ...state,
    task_round_count: state.task_round_count + 1,
    last_task_status: status,
    fallback_count: fallbackCount,
    in_flight_round: null
  };
}

export function markInitializationCompleted(state) {
  return { ...state, initialization_completed: true };
}


export function beginSourcePreparation(state) {
  return {
    ...state,
    phase: 'PREPARING_SOURCE',
    initialization_completed: false,
    source_preparation: state.source_preparation ?? {
      status: 'preparing',
      export_id: null,
      patch_session_id: null,
      source: null,
      rules: null
    }
  };
}

export function recordPatchSyncExport(state, { exportId }) {
  if (typeof exportId !== 'string' || !exportId.trim()) throw new TypeError('exportId is required');
  return {
    ...state,
    phase: 'PREPARING_SOURCE',
    initialization_completed: false,
    source_preparation: {
      ...(state.source_preparation ?? {}),
      status: 'waiting',
      export_id: exportId
    }
  };
}

export function recordPreparedSource(state, { exportId, patchSessionId, source, rules }) {
  if (typeof exportId !== 'string' || !exportId.trim()) throw new TypeError('exportId is required');
  if (typeof patchSessionId !== 'string' || !patchSessionId.trim()) throw new TypeError('patchSessionId is required');
  return {
    ...state,
    patch_session_id: patchSessionId,
    session_id: patchSessionId,
    source_preparation: {
      status: 'succeeded',
      export_id: exportId,
      patch_session_id: patchSessionId,
      source: {
        filename: source?.filename ?? null,
        download_url: source?.downloadUrl ?? source?.download_url ?? null,
        sha256: source?.sha256 ?? null,
        size_bytes: source?.sizeBytes ?? source?.size_bytes ?? null
      },
      rules: {
        filename: rules?.filename ?? null,
        download_url: rules?.downloadUrl ?? rules?.download_url ?? null,
        text: rules?.text ?? null
      }
    }
  };
}


export function beginRecoveryAction(state, { signal, ruleId, action, attempt, observationStartedAt, lastMeaningfulProgressAt = null, nextCheckAt }) {
  return {
    ...state,
    recovery_state: {
      signal,
      rule_id: ruleId,
      action,
      attempt,
      observation_started_at: observationStartedAt,
      last_meaningful_progress_at: lastMeaningfulProgressAt,
      next_check_at: nextCheckAt
    }
  };
}

export function markMeaningfulProgress(state, at) {
  const timestamp = String(at);
  return {
    ...state,
    last_meaningful_progress_at: timestamp,
    recovery_state: state.recovery_state
      ? { ...state.recovery_state, last_meaningful_progress_at: timestamp }
      : null
  };
}

export function clearRecoveryState(state) {
  if (!state.recovery_state) return state;
  return { ...state, recovery_state: null };
}


export function beginExternalWait(state, { at, nextCheckAt, summary = null }) {
  const startedAt = String(at);
  return {
    ...state,
    phase: 'WAITING_EXTERNAL',
    next_recovery_at: String(nextCheckAt),
    external_wait: {
      started_at: state.external_wait?.started_at ?? startedAt,
      last_checked_at: state.external_wait?.last_checked_at ?? null,
      next_check_at: String(nextCheckAt),
      summary: summary == null ? state.external_wait?.summary ?? null : String(summary),
      resync_count: state.external_wait?.resync_count ?? 0,
      last_resync_at: state.external_wait?.last_resync_at ?? null,
      escalated_at: state.external_wait?.escalated_at ?? null
    }
  };
}

export function recordExternalWaitCheck(state, { at, nextCheckAt, summary = null }) {
  if (!state.external_wait) throw new Error('external_wait checkpoint is required');
  return {
    ...state,
    phase: 'WAITING_EXTERNAL',
    next_recovery_at: String(nextCheckAt),
    external_wait: {
      ...state.external_wait,
      last_checked_at: String(at),
      next_check_at: String(nextCheckAt),
      summary: summary == null ? state.external_wait.summary : String(summary)
    }
  };
}

export function recordExternalResync(state, at) {
  if (!state.external_wait) throw new Error('external_wait checkpoint is required');
  return {
    ...state,
    external_wait: {
      ...state.external_wait,
      resync_count: (state.external_wait.resync_count ?? 0) + 1,
      last_resync_at: String(at)
    }
  };
}

export function recordExternalEscalation(state, at) {
  if (!state.external_wait) throw new Error('external_wait checkpoint is required');
  return {
    ...state,
    phase: 'WAITING_HUMAN',
    next_recovery_at: null,
    external_wait: { ...state.external_wait, escalated_at: String(at) }
  };
}

export function clearExternalWait(state) {
  if (!state.external_wait && !state.next_recovery_at) return state;
  return { ...state, external_wait: null, next_recovery_at: null };
}

export function markLeaseLost(state, { at, code, message }) {
  return {
    ...state,
    phase: 'CLEANUP',
    terminal_reason: 'LEASE_LOST',
    terminal_action: null,
    lease: null,
    lease_token: null,
    next_recovery_at: null,
    lease_loss: {
      at: String(at),
      code: String(code || 'ASSIGNMENT_LEASE_LOST'),
      message: String(message || 'Assignment lease was lost')
    }
  };
}
