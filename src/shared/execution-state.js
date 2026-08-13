export function createExecutionState(task, { lease = null } = {}) {
  return {
    task_id: task.task_id,
    project_id: task.project_id,
    task_snapshot: structuredClone(task),
    lease: lease ? structuredClone(lease) : null,
    phase: 'IDLE',
    session_id: null,
    chatgpt_project_name: null,
    task_round_count: 0,
    task_patch_count: 0,
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
