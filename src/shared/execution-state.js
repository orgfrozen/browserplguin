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
    session_id: null,
    chatgpt_project_name: null,
    task_round_count: 0,
    task_patch_count: 0,
    initialization_completed: !task.resource,
    in_flight_round: null,
    downloaded_patch_keys: [],
    task_project: null,
    last_task_status: null,
    fallback_count: 0,
    terminal_reason: null,
    terminal_action: null,
    terminal_payload: null,
    terminal_error: null,
    cleanup_error: null,
    recovery_error: null
  };
}

export function recordCreatedWorkspace(state, { projectName, sessionId }) {
  return {
    ...state,
    session_id: sessionId,
    chatgpt_project_name: projectName,
    task_project: {
      project_name: projectName,
      session_id: sessionId,
      status: 'active'
    }
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
    }
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
