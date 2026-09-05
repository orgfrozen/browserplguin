import { WORKSPACE_MODES, normalizeWorkspaceMode, resolveWorkspaceMode } from './workspace-mode.js';

export function createExecutionState(task, { lease = null, localStartedAt = null, workspaceMode = WORKSPACE_MODES.PROJECT } = {}) {
  const control = task.agent_control ?? {};
  return {
    task_id: task.task_id,
    project_id: task.project_id,
    task_snapshot: structuredClone(task),
    agent_id: control.agent_id ?? lease?.agent_id ?? null,
    assignment_id: control.assignment_id ?? lease?.assignment_id ?? null,
    execution_id: control.execution_id ?? lease?.execution_id ?? null,
    execution_epoch: control.execution_epoch ?? lease?.execution_epoch ?? null,
    lease_token: lease?.token ?? null,
    browser_execution_bootstrap: task.browser_execution_bootstrap ? structuredClone(task.browser_execution_bootstrap) : null,
    source_preparation: null,
    source_retry: null,
    lease: lease ? structuredClone(lease) : null,
    phase: 'IDLE',
    local_started_at: localStartedAt,
    workspace_mode: normalizeWorkspaceMode(workspaceMode),
    task_workspace: null,
    browser_workspace_id: null,
    patch_session_id: null,
    session_id: null,
    chatgpt_project_name: null,
    chatgpt_conversation_url: null,
    chatgpt_conversation_id: null,
    chatgpt_tab_id: null,
    browser_slot_id: null,
    browser_slot_generation: null,
    task_round_count: 0,
    task_patch_count: 0,
    server_successful_patch_count: 0,
    initialization_completed: !task.resource,
    project_setup_completed: false,
    initialization_attempt: 0,
    initialization_local_recovery_count: 0,
    workspace_retry_count: 0,
    workspace_max_retries: null,
    preserve_workspace_on_terminal_failure: false,
    initialization_base_project_name: null,
    initialization_started_at: null,
    initialization_deadline_at: null,
    initialization_prompt_checkpoint: null,
    initialization_orphans: [],
    in_flight_round: null,
    downloaded_patch_keys: [],
    patch_delivery: null,
    task_project: null,
    last_task_status: null,
    analysis_completed_reported: false,
    analysis_completed_at: null,
    completion_preview: null,
    server_continuation_summary: null,
    server_continuation_prompt: null,
    patch_status_target: null,
    fallback_count: 0,
    terminal_reason: null,
    terminal_action: null,
    terminal_payload: null,
    terminal_error: null,
    cleanup_error: null,
    recovery_error: null,
    recovery_block: null,
    recovery_state: null,
    external_wait: null,
    next_recovery_at: null,
    lease_loss: null,
    business_completed: false,
    last_meaningful_progress_at: null
  };
}

export function recordCreatedWorkspace(state, {
  mode = resolveWorkspaceMode(state),
  projectName = null,
  browserWorkspaceId = null,
  sessionId = null,
  chatgptTabId = null,
  browserSlotId = null,
  browserSlotGeneration = null,
  conversationUrl = null,
  conversationId = null
} = {}) {
  const workspaceMode = normalizeWorkspaceMode(mode);
  const patchSessionId = state.patch_session_id ?? state.source_preparation?.patch_session_id ?? sessionId ?? null;
  const workspaceId = browserWorkspaceId ?? state.browser_workspace_id ?? state.assignment_id ?? sessionId ?? projectName ?? null;
  const ownership = {
    ...(Number.isInteger(chatgptTabId) ? { chatgpt_tab_id: chatgptTabId } : {}),
    ...(typeof browserSlotId === 'string' && browserSlotId ? { browser_slot_id: browserSlotId } : {}),
    ...(Number.isInteger(browserSlotGeneration) ? { browser_slot_generation: browserSlotGeneration } : {})
  };
  const conversation = {
    ...(typeof conversationUrl === 'string' && conversationUrl ? { conversation_url: conversationUrl } : {}),
    ...(typeof conversationId === 'string' && conversationId ? { conversation_id: conversationId } : {})
  };
  const taskWorkspace = {
    mode: workspaceMode,
    project_name: workspaceMode === WORKSPACE_MODES.PROJECT ? projectName : null,
    ...(workspaceId ? { browser_workspace_id: workspaceId } : patchSessionId ? { session_id: patchSessionId } : {}),
    status: 'active',
    ...ownership,
    ...conversation
  };
  const taskProject = workspaceMode === WORKSPACE_MODES.PROJECT
    ? browserWorkspaceId
      ? { project_name: projectName, browser_workspace_id: workspaceId, status: 'active', ...ownership }
      : { project_name: projectName, session_id: patchSessionId, status: 'active', ...ownership }
    : state.task_project ?? null;
  return {
    ...state,
    workspace_mode: workspaceMode,
    task_workspace: taskWorkspace,
    browser_workspace_id: workspaceId,
    patch_session_id: patchSessionId,
    session_id: patchSessionId,
    chatgpt_project_name: workspaceMode === WORKSPACE_MODES.PROJECT ? projectName : null,
    chatgpt_conversation_url: typeof conversationUrl === 'string' && conversationUrl
      ? conversationUrl
      : workspaceMode === WORKSPACE_MODES.CHAT ? null : state.chatgpt_conversation_url ?? null,
    chatgpt_conversation_id: typeof conversationId === 'string' && conversationId
      ? conversationId
      : workspaceMode === WORKSPACE_MODES.CHAT ? null : state.chatgpt_conversation_id ?? null,
    chatgpt_tab_id: Number.isInteger(chatgptTabId) ? chatgptTabId : state.chatgpt_tab_id ?? null,
    browser_slot_id: typeof browserSlotId === 'string' && browserSlotId ? browserSlotId : state.browser_slot_id ?? null,
    browser_slot_generation: Number.isInteger(browserSlotGeneration) ? browserSlotGeneration : state.browser_slot_generation ?? null,
    task_project: taskProject,
    project_setup_completed: false
  };
}


export function recordWorkspaceConversationIdentity(state, { conversationUrl, conversationId } = {}) {
  const url = typeof conversationUrl === 'string' && conversationUrl ? conversationUrl : null;
  const id = typeof conversationId === 'string' && conversationId ? conversationId : null;
  if (!url || !id) return state;
  return {
    ...state,
    task_workspace: state.task_workspace ? {
      ...state.task_workspace,
      conversation_url: url,
      conversation_id: id
    } : state.task_workspace,
    chatgpt_conversation_url: url,
    chatgpt_conversation_id: id
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

function patchCandidateFields(candidate) {
  return {
    filename: typeof candidate?.filename === 'string' && candidate.filename.trim() ? candidate.filename.trim() : null,
    control_key: typeof candidate?.control_key === 'string' && candidate.control_key.trim() ? candidate.control_key.trim() : null
  };
}

export function recordPatchDiscovery(state, candidates = [], { at = null } = {}) {
  const items = Array.isArray(candidates) ? candidates : [];
  const only = items.length === 1 ? patchCandidateFields(items[0]) : { filename: null, control_key: null };
  return {
    ...state,
    patch_delivery: {
      stage: items.length > 0 ? 'PATCH_DISCOVERED' : 'DISCOVERY_EMPTY',
      round_number: state.in_flight_round?.round_number ?? state.task_round_count + 1,
      candidate_count: items.length,
      attempt: 0,
      ...only,
      error_code: null,
      reason: null,
      updated_at: at
    }
  };
}

export function markPatchDownloadStarted(state, candidate, { at = null } = {}) {
  const identity = patchCandidateFields(candidate);
  const previous = state.patch_delivery ?? null;
  const sameCandidate = Boolean(previous)
    && (identity.filename ? previous.filename === identity.filename : identity.control_key ? previous.control_key === identity.control_key : true);
  const attempt = sameCandidate && Number.isInteger(previous?.attempt) ? previous.attempt + 1 : 1;
  return {
    ...state,
    patch_delivery: {
      stage: 'DOWNLOAD_STARTED',
      round_number: state.in_flight_round?.round_number ?? previous?.round_number ?? state.task_round_count + 1,
      candidate_count: previous?.candidate_count ?? 1,
      attempt,
      ...identity,
      error_code: null,
      reason: null,
      updated_at: at
    }
  };
}

export function markPatchDownloadFailed(state, candidate, error, { at = null, reason = null } = {}) {
  const identity = patchCandidateFields(candidate);
  const previous = state.patch_delivery ?? null;
  return {
    ...state,
    patch_delivery: {
      stage: 'DOWNLOAD_FAILED',
      round_number: state.in_flight_round?.round_number ?? previous?.round_number ?? state.task_round_count + 1,
      candidate_count: previous?.candidate_count ?? 1,
      attempt: Number.isInteger(previous?.attempt) && previous.attempt > 0 ? previous.attempt : 1,
      filename: identity.filename ?? previous?.filename ?? null,
      control_key: identity.control_key ?? previous?.control_key ?? null,
      error_code: error?.code ?? 'PATCH_DOWNLOAD_FAILED',
      reason: reason ?? error?.details?.reason ?? null,
      updated_at: at
    }
  };
}

export function markPatchDownloadCompleted(state, candidate, artifact, { at = null } = {}) {
  const identity = patchCandidateFields(candidate);
  const previous = state.patch_delivery ?? null;
  return {
    ...state,
    patch_delivery: {
      stage: 'DOWNLOAD_COMPLETED',
      round_number: state.in_flight_round?.round_number ?? previous?.round_number ?? state.task_round_count + 1,
      candidate_count: previous?.candidate_count ?? 1,
      attempt: Number.isInteger(previous?.attempt) && previous.attempt > 0 ? previous.attempt : 1,
      filename: artifact?.filename ?? identity.filename ?? previous?.filename ?? null,
      control_key: artifact?.control_key ?? identity.control_key ?? previous?.control_key ?? null,
      error_code: null,
      reason: null,
      updated_at: at
    }
  };
}

export function recordPatchStatusTarget(state, { filename, sessionId, sequence }) {
  if (typeof filename !== 'string' || !filename.trim()) throw new TypeError('Patch status filename is required');
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('Patch status sessionId is required');
  if (!Number.isInteger(sequence) || sequence < 0) throw new TypeError('Patch status sequence must be a non-negative integer');
  return {
    ...state,
    patch_status_target: { filename: filename.trim(), session_id: sessionId.trim(), sequence }
  };
}

export function clearPatchStatusTarget(state) {
  if (!state.patch_status_target) return state;
  return { ...state, patch_status_target: null };
}

export function markWorkspaceDeleted(state) {
  if (!state.task_workspace && !state.task_project) return state;
  return {
    ...state,
    task_workspace: state.task_workspace ? { ...state.task_workspace, status: 'deleted' } : state.task_workspace ?? null,
    task_project: state.task_project ? { ...state.task_project, status: 'deleted' } : state.task_project ?? null
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
    server_continuation_summary: null,
    server_continuation_prompt: null
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
    last_assistant_text: checkpoint.assistant_text ?? state.last_assistant_text ?? null,
    fallback_count: fallbackCount,
    in_flight_round: null
  };
}


export function checkpointInitializationPromptIntent(state) {
  return {
    ...state,
    initialization_prompt_checkpoint: { stage: 'READY_TO_SEND' }
  };
}

export function markInitializationPromptSent(state) {
  return {
    ...state,
    initialization_prompt_checkpoint: { stage: 'PROMPT_SENT' }
  };
}

export function markInitializationCompleted(state) {
  return {
    ...state,
    initialization_completed: true,
    initialization_deadline_at: null,
    initialization_prompt_checkpoint: null
  };
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


export function recordPatchSyncExportStatus(state, {
  exportId, status = null, stage = null, waitStartedAt = null, waitDuration = null,
  blockingProject = null, blockingPid = null, blockingPhase = null, blockingReason = null
}) {
  if (typeof exportId !== 'string' || !exportId.trim()) throw new TypeError('exportId is required');
  const nextStage = typeof stage === 'string' && stage ? stage : state.source_preparation?.stage ?? null;
  const sourcePreparation = {
    ...(state.source_preparation ?? {}),
    status: state.source_preparation?.status ?? 'waiting',
    export_id: exportId,
    remote_status: typeof status === 'string' && status ? status : state.source_preparation?.remote_status ?? null,
    stage: nextStage
  };
  for (const key of ['wait_started_at', 'wait_duration', 'blocking_project', 'blocking_pid', 'blocking_phase', 'blocking_reason']) {
    delete sourcePreparation[key];
  }
  if (nextStage === 'waiting_for_idle') {
    const previous = state.source_preparation ?? {};
    const startedAt = typeof waitStartedAt === 'string' && waitStartedAt ? waitStartedAt : previous.wait_started_at;
    const hasDuration = waitDuration !== null && waitDuration !== undefined && waitDuration !== '' && Number.isFinite(Number(waitDuration));
    const duration = hasDuration ? Number(waitDuration) : null;
    const project = typeof blockingProject === 'string' && blockingProject ? blockingProject : previous.blocking_project;
    const hasPid = blockingPid !== null && blockingPid !== undefined && blockingPid !== '' && Number.isInteger(Number(blockingPid));
    const pid = hasPid ? Number(blockingPid) : null;
    const phase = typeof blockingPhase === 'string' && blockingPhase ? blockingPhase : previous.blocking_phase;
    const reason = typeof blockingReason === 'string' && blockingReason ? blockingReason : previous.blocking_reason;
    if (typeof startedAt === 'string' && startedAt) sourcePreparation.wait_started_at = startedAt;
    if (duration !== null && duration >= 0) sourcePreparation.wait_duration = Math.floor(duration);
    else if (Number.isFinite(Number(previous.wait_duration))) sourcePreparation.wait_duration = Math.max(0, Math.floor(Number(previous.wait_duration)));
    if (typeof project === 'string' && project) sourcePreparation.blocking_project = project;
    if (pid !== null && pid >= 0) sourcePreparation.blocking_pid = pid;
    else if (Number.isInteger(Number(previous.blocking_pid)) && Number(previous.blocking_pid) >= 0) sourcePreparation.blocking_pid = Number(previous.blocking_pid);
    if (typeof phase === 'string' && phase) sourcePreparation.blocking_phase = phase;
    if (typeof reason === 'string' && reason) sourcePreparation.blocking_reason = reason;
  }
  return {
    ...state,
    phase: 'PREPARING_SOURCE',
    source_preparation: sourcePreparation
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
      query_count: state.external_wait?.query_count ?? 0,
      consecutive_query_errors: state.external_wait?.consecutive_query_errors ?? 0,
      last_query_at: state.external_wait?.last_query_at ?? null,
      last_result: state.external_wait?.last_result ?? null,
      last_patch_reconcile_at: state.external_wait?.last_patch_reconcile_at ?? null,
      last_patch_reconcile_result: state.external_wait?.last_patch_reconcile_result ?? null,
      last_completion_check_at: state.external_wait?.last_completion_check_at ?? null,
      summary: summary == null ? state.external_wait?.summary ?? null : String(summary),
      resync_count: state.external_wait?.resync_count ?? 0,
      last_resync_at: state.external_wait?.last_resync_at ?? null,
      escalated_at: state.external_wait?.escalated_at ?? null
    }
  };
}

export function recordExternalStatusQuery(state, { at, kind, result = null }) {
  if (!state.external_wait) throw new Error('external_wait checkpoint is required');
  const timestamp = String(at);
  const queryKind = String(kind ?? 'unknown');
  const resultText = result == null ? null : String(result);
  const next = {
    ...state.external_wait,
    query_count: (state.external_wait.query_count ?? 0) + 1,
    consecutive_query_errors: resultText == null
      ? state.external_wait.consecutive_query_errors ?? 0
      : /:error$/.test(resultText) ? (state.external_wait.consecutive_query_errors ?? 0) + 1 : 0,
    last_query_at: timestamp,
    last_result: resultText == null ? state.external_wait.last_result ?? null : resultText
  };
  if (queryKind === 'patch_reconcile') {
    next.last_patch_reconcile_at = timestamp;
    next.last_patch_reconcile_result = resultText;
  }
  if (queryKind === 'completion_check') next.last_completion_check_at = timestamp;
  return { ...state, external_wait: next };
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
    phase: 'LEASE_LOST',
    terminal_reason: 'LEASE_LOST',
    terminal_action: null,
    lease: null,
    lease_token: null,
    next_recovery_at: null,
    lease_loss: {
      at: String(at),
      code: String(code || 'ASSIGNMENT_LEASE_LOST'),
      message: String(message || 'Assignment lease was lost'),
      control_state: 'pending',
      control_checked_at: null,
      control_error: null
    }
  };
}
