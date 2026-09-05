import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionState, recordRound, recordCompletedPatch, recordCreatedWorkspace, markWorkspaceDeleted, checkpointRoundIntent, markRoundPromptSent, markRoundResponseReady, completeRound, checkpointInitializationPromptIntent, markInitializationPromptSent, markInitializationCompleted, beginSourcePreparation, recordPatchSyncExport, recordPatchSyncExportStatus, recordPreparedSource, recordExternalStatusQuery } from '../src/shared/execution-state.js';
import { WORKSPACE_MODES, normalizeWorkspaceMode, resolveWorkspaceMode } from '../src/shared/workspace-mode.js';

const task = { task_id: 't1', project_id: 'vetatool', task_prompt: 'fix' };


test('workspace mode normalization defaults legacy and invalid values to Project', () => {
  assert.equal(normalizeWorkspaceMode(undefined), WORKSPACE_MODES.PROJECT);
  assert.equal(normalizeWorkspaceMode('project'), WORKSPACE_MODES.PROJECT);
  assert.equal(normalizeWorkspaceMode('chat'), WORKSPACE_MODES.CHAT);
  assert.equal(normalizeWorkspaceMode('invalid'), WORKSPACE_MODES.PROJECT);
  assert.equal(resolveWorkspaceMode({ task_project: { project_name: 'legacy-project', status: 'active' } }), WORKSPACE_MODES.PROJECT);
});

test('execution state captures workspace mode once and records Chat identity without a fake Project', () => {
  let state = createExecutionState(task, { workspaceMode: 'chat' });
  assert.equal(state.workspace_mode, WORKSPACE_MODES.CHAT);
  assert.equal(state.task_workspace, null);
  assert.equal(state.chatgpt_conversation_url, null);
  assert.equal(state.chatgpt_conversation_id, null);

  state = recordCreatedWorkspace(state, {
    mode: 'chat',
    browserWorkspaceId: 'assignment-1',
    sessionId: 'ps-1',
    chatgptTabId: 10,
    conversationUrl: 'https://chatgpt.com/c/conv-1',
    conversationId: 'conv-1'
  });

  assert.deepEqual(state.task_workspace, {
    mode: 'chat',
    project_name: null,
    browser_workspace_id: 'assignment-1',
    status: 'active',
    chatgpt_tab_id: 10,
    conversation_url: 'https://chatgpt.com/c/conv-1',
    conversation_id: 'conv-1'
  });
  assert.equal(state.task_project, null);
  assert.equal(state.chatgpt_project_name, null);
  assert.equal(state.chatgpt_conversation_url, 'https://chatgpt.com/c/conv-1');
  assert.equal(state.chatgpt_conversation_id, 'conv-1');

  state = markWorkspaceDeleted(state);
  assert.equal(state.task_workspace.status, 'deleted');
  assert.equal(state.task_project, null);
});

test('execution state separates browser workspace identity from authoritative PatchSync session', () => {
  let state = createExecutionState({ ...task, agent_control: { assignment_id: 'assignment-1' } });
  state = recordPreparedSource(state, {
    exportId: 'exp-1', patchSessionId: 'ps-20260817-abc123',
    source: { filename: 'source.zip', downloadUrl: 'https://patchsync.example/source.zip' },
    rules: { filename: 'LLM_RULES.md', text: 'rules' }
  });
  state = recordCreatedWorkspace(state, { projectName: 'vetatool2026081315-t1', browserWorkspaceId: 'assignment-1' });
  assert.deepEqual(state.task_project, {
    project_name: 'vetatool2026081315-t1',
    browser_workspace_id: 'assignment-1',
    status: 'active'
  });
  assert.equal(state.chatgpt_project_name, 'vetatool2026081315-t1');
  assert.equal(state.browser_workspace_id, 'assignment-1');
  assert.equal(state.patch_session_id, 'ps-20260817-abc123');
  assert.equal(state.session_id, 'ps-20260817-abc123');
});

test('duplicate patch key does not increment task count twice', () => {
  let state = recordCreatedWorkspace(createExecutionState(task), { sessionId: 's1', projectName: 'p' });
  state = recordCompletedPatch(state, 'patch-s1-001.patch');
  state = recordCompletedPatch(state, 'patch-s1-001.patch');
  assert.equal(state.task_patch_count, 1);
});

test('rounds are tracked only at task scope', () => {
  let state = recordCreatedWorkspace(createExecutionState(task), { sessionId: 's1', projectName: 'p' });
  state = recordRound(recordRound(state));
  assert.equal(state.task_round_count, 2);
  assert.equal('session_round_count' in state, false);
});

test('completed patch can persist discovery aliases without incrementing twice', () => {
  let state = recordCreatedWorkspace(createExecutionState(task), { sessionId: 's1', projectName: 'p' });
  state = recordCompletedPatch(state, 'patch-s1-001.patch', ['s1:control:0:下载 Patch']);
  assert.equal(state.task_patch_count, 1);
  assert.ok(state.downloaded_patch_keys.includes('patch-s1-001.patch'));
  assert.ok(state.downloaded_patch_keys.includes('s1:control:0:下载 Patch'));
  const again = recordCompletedPatch(state, 'patch-s1-001.patch', ['s1:control:0:下载 Patch']);
  assert.equal(again.task_patch_count, 1);
});

test('marking the single task project deleted preserves its identity', () => {
  let state = recordCreatedWorkspace(createExecutionState(task), { projectName: 'p1', sessionId: 's1' });
  state = markWorkspaceDeleted(state);
  assert.deepEqual(state.task_project, { project_name: 'p1', session_id: 's1', status: 'deleted' });
  assert.equal(state.chatgpt_project_name, 'p1');
  assert.equal(state.session_id, 's1');
});

test('execution state durably records the local Task runtime start timestamp', () => {
  const state = createExecutionState(task, { localStartedAt: '2026-08-29T04:12:34.000Z' });
  assert.equal(state.local_started_at, '2026-08-29T04:12:34.000Z');
});


test('execution state checkpoints normalized task snapshot and current lease for recovery', () => {
  const lease = { token: 'lease-a', ttl_ms: 90000 };
  const state = createExecutionState(task, { lease });
  assert.deepEqual(state.task_snapshot, task);
  assert.deepEqual(state.lease, lease);
  lease.token = 'mutated';
  assert.equal(state.lease.token, 'lease-a');
});


test('round checkpoint advances intent to sent to response-ready and commits atomically with round count', () => {
  let state = createExecutionState(task);
  state = checkpointRoundIntent(state, 'fix this bug');
  assert.deepEqual(state.in_flight_round, {
    round_number: 1,
    prompt: 'fix this bug',
    stage: 'READY_TO_SEND',
    assistant_text: null
  });
  assert.equal(state.task_round_count, 0);

  state = markRoundPromptSent(state);
  assert.equal(state.in_flight_round.stage, 'PROMPT_SENT');
  assert.equal(state.task_round_count, 0);

  state = markRoundResponseReady(state, '<TASK_STATUS>DONE</TASK_STATUS>');
  assert.equal(state.in_flight_round.stage, 'RESPONSE_READY');
  assert.equal(state.in_flight_round.assistant_text, '<TASK_STATUS>DONE</TASK_STATUS>');
  assert.equal(state.task_round_count, 0);

  state = completeRound(state, { status: 'DONE', fallbackCount: 0 });
  assert.equal(state.in_flight_round, null);
  assert.equal(state.task_round_count, 1);
  assert.equal(state.last_task_status, 'DONE');
  assert.equal(state.fallback_count, 0);
});

test('initialization Prompt checkpoints intent before send and clears after completion', () => {
  let state = createExecutionState({ ...task, resource: { url: 'https://assets.example.com/source.zip' } });
  state = checkpointInitializationPromptIntent(state);
  assert.deepEqual(state.initialization_prompt_checkpoint, { stage: 'READY_TO_SEND' });
  state = markInitializationPromptSent(state);
  assert.deepEqual(state.initialization_prompt_checkpoint, { stage: 'PROMPT_SENT' });
  state = markInitializationCompleted(state);
  assert.equal(state.initialization_prompt_checkpoint, null);
});

test('resource task checkpoints initialization completion separately from work rounds', () => {
  const resourceTask = { ...task, resource: { url: 'https://assets.example.com/source.zip' }, initialization_prompt: 'analyze' };
  let state = createExecutionState(resourceTask);
  assert.equal(state.initialization_completed, false);
  assert.equal(state.task_round_count, 0);
  state = markInitializationCompleted(state);
  assert.equal(state.initialization_completed, true);
  assert.equal(state.task_round_count, 0);

  const plain = createExecutionState(task);
  assert.equal(plain.initialization_completed, true);
});

test('round cannot be committed before assistant response is durably checkpointed', () => {
  let state = checkpointRoundIntent(createExecutionState(task), 'fix');
  state = markRoundPromptSent(state);
  assert.throws(() => completeRound(state, { status: 'DONE', fallbackCount: 0 }), /RESPONSE_READY/);
});

test('agent-control lineage and bootstrap are durably checkpointed with the execution state', () => {
  const controlledTask = {
    ...task,
    agent_control: { agent_id: 'agent-mac', assignment_id: 'assignment-1', execution_id: 'execution-1', execution_epoch: 9 },
    browser_execution_bootstrap: { project: { project_id: 'vetatool' }, recovery_policy: { version: 1, rules: [] } }
  };
  const lease = {
    token: 'lease-a', ttl_ms: 60000, expires_at: '2026-08-17T11:01:00.000Z',
    agent_id: 'agent-mac', assignment_id: 'assignment-1', execution_id: 'execution-1', execution_epoch: 9
  };
  const state = createExecutionState(controlledTask, { lease });
  assert.equal(state.agent_id, 'agent-mac');
  assert.equal(state.assignment_id, 'assignment-1');
  assert.equal(state.execution_id, 'execution-1');
  assert.equal(state.execution_epoch, 9);
  assert.equal(state.lease.execution_epoch, 9);
  assert.equal(state.lease_token, 'lease-a');
  assert.deepEqual(state.browser_execution_bootstrap, controlledTask.browser_execution_bootstrap);
});


test('source preparation checkpoints export identity and authoritative PatchSync session without persisting source bytes', () => {
  const controlledTask = {
    ...task,
    browser_execution_bootstrap: {
      patchsync: { base_url: 'https://patchsync.example', access_token: 'cap' }
    }
  };
  let state = beginSourcePreparation(createExecutionState(controlledTask));
  assert.equal(state.phase, 'PREPARING_SOURCE');
  state = recordPatchSyncExport(state, { exportId: 'exp-1' });
  assert.equal(state.source_preparation.export_id, 'exp-1');
  state = recordPreparedSource(state, {
    exportId: 'exp-1',
    patchSessionId: 'ps-20260817-abc123',
    source: { filename: 'source.zip', downloadUrl: 'https://patchsync.example/source.zip', sha256: 'abc', sizeBytes: 42 },
    rules: { filename: 'LLM_RULES.md', downloadUrl: 'https://patchsync.example/LLM_RULES.md', text: 'rules' }
  });
  assert.equal(state.source_preparation.status, 'succeeded');
  assert.equal(state.source_preparation.patch_session_id, 'ps-20260817-abc123');
  assert.equal(state.source_preparation.source.filename, 'source.zip');
  assert.equal(state.source_preparation.rules.text, 'rules');
  assert.equal('base64' in state.source_preparation.source, false);
});

test('source preparation durably tracks waiting-for-idle blocker diagnostics and clears them after the stage advances', () => {
  let state = recordPatchSyncExport(beginSourcePreparation(createExecutionState(task)), { exportId: 'exp-blocked' });
  state = recordPatchSyncExportStatus(state, {
    exportId: 'exp-blocked', status: 'running', stage: 'waiting_for_idle',
    waitStartedAt: '2026-09-05T12:00:00Z', waitDuration: 9,
    blockingProject: 'vetatool', blockingPid: 4242, blockingPhase: 'repairing session state 37/200 ps-test', blockingReason: 'worker_busy'
  });
  assert.equal(state.source_preparation.wait_started_at, '2026-09-05T12:00:00Z');
  assert.equal(state.source_preparation.wait_duration, 9);
  assert.equal(state.source_preparation.blocking_project, 'vetatool');
  assert.equal(state.source_preparation.blocking_pid, 4242);
  assert.equal(state.source_preparation.blocking_phase, 'repairing session state 37/200 ps-test');
  assert.equal(state.source_preparation.blocking_reason, 'worker_busy');

  state = recordPatchSyncExportStatus(state, { exportId: 'exp-blocked', status: 'running', stage: 'exporting' });
  for (const key of ['wait_started_at', 'wait_duration', 'blocking_project', 'blocking_pid', 'blocking_phase', 'blocking_reason']) {
    assert.equal(key in state.source_preparation, false);
  }

  state = recordPatchSyncExportStatus(state, { exportId: 'exp-blocked', status: 'running', stage: 'waiting_for_idle' });
  assert.equal('wait_duration' in state.source_preparation, false);
  assert.equal('blocking_pid' in state.source_preparation, false);
});

test('recovery state durably records action attempt and observation window then clears after meaningful progress', async () => {
  const { beginRecoveryAction, markMeaningfulProgress, clearRecoveryState } = await import('../src/shared/execution-state.js');
  let state = createExecutionState({ task_id: 't-recovery', project_id: 'vetatool' });
  state = beginRecoveryAction(state, {
    signal: 'GPT_RESPONSE_STALLED', ruleId: 'gpt-response-stalled', action: 'RELOAD_PAGE', attempt: 2,
    observationStartedAt: '2026-08-17T10:00:00.000Z', lastMeaningfulProgressAt: '2026-08-17T09:30:00.000Z', nextCheckAt: '2026-08-17T10:30:00.000Z'
  });
  assert.deepEqual(state.recovery_state, {
    signal: 'GPT_RESPONSE_STALLED', rule_id: 'gpt-response-stalled', action: 'RELOAD_PAGE', attempt: 2,
    observation_started_at: '2026-08-17T10:00:00.000Z', last_meaningful_progress_at: '2026-08-17T09:30:00.000Z', next_check_at: '2026-08-17T10:30:00.000Z'
  });
  state = markMeaningfulProgress(state, '2026-08-17T10:05:00.000Z');
  assert.equal(state.last_meaningful_progress_at, '2026-08-17T10:05:00.000Z');
  state = clearRecoveryState(state);
  assert.equal(state.recovery_state, null);
});

test('external wait checkpoints poll timing and lease loss preserves the workspace for control reconciliation', async () => {
  const { beginExternalWait, recordExternalWaitCheck, recordExternalResync, markLeaseLost } = await import('../src/shared/execution-state.js');
  let state = createExecutionState({ task_id: 't-wait', project_id: 'vetatool' }, {
    lease: { token: 'lease-a', ttl_ms: 90000, assignment_id: 'a1', execution_id: 'e1' }
  });
  state = recordCreatedWorkspace(state, { projectName: 'p1', browserWorkspaceId: 'a1', sessionId: 'ps-1' });
  state = beginExternalWait(state, {
    at: '2026-08-17T10:00:00.000Z',
    nextCheckAt: '2026-08-17T10:02:00.000Z',
    summary: 'CI pending'
  });
  assert.equal(state.phase, 'WAITING_EXTERNAL');
  assert.deepEqual(state.external_wait, {
    started_at: '2026-08-17T10:00:00.000Z',
    last_checked_at: null,
    next_check_at: '2026-08-17T10:02:00.000Z',
    query_count: 0,
    consecutive_query_errors: 0,
    last_query_at: null,
    last_result: null,
    last_patch_reconcile_at: null,
    last_patch_reconcile_result: null,
    last_completion_check_at: null,
    summary: 'CI pending',
    resync_count: 0,
    last_resync_at: null,
    escalated_at: null
  });

  state = recordExternalStatusQuery(state, {
    at: '2026-08-17T10:01:58.000Z',
    kind: 'patch_reconcile',
    result: 'reconcile:no_patch'
  });
  state = recordExternalStatusQuery(state, {
    at: '2026-08-17T10:01:59.000Z',
    kind: 'completion_check',
    result: 'completion:error'
  });
  assert.equal(state.external_wait.consecutive_query_errors, 1);
  state = recordExternalStatusQuery(state, {
    at: '2026-08-17T10:02:00.000Z',
    kind: 'completion_check',
    result: 'completion:WAIT_EXTERNAL'
  });
  assert.equal(state.external_wait.consecutive_query_errors, 0);
  state = recordExternalWaitCheck(state, {
    at: '2026-08-17T10:02:00.000Z',
    nextCheckAt: '2026-08-17T10:04:00.000Z',
    summary: 'still pending'
  });
  state = recordExternalResync(state, '2026-08-17T10:32:00.000Z');
  assert.equal(state.external_wait.last_checked_at, '2026-08-17T10:02:00.000Z');
  assert.equal(state.external_wait.query_count, 3);
  assert.equal(state.external_wait.last_query_at, '2026-08-17T10:02:00.000Z');
  assert.equal(state.external_wait.last_result, 'completion:WAIT_EXTERNAL');
  assert.equal(state.external_wait.last_patch_reconcile_at, '2026-08-17T10:01:58.000Z');
  assert.equal(state.external_wait.last_patch_reconcile_result, 'reconcile:no_patch');
  assert.equal(state.external_wait.last_completion_check_at, '2026-08-17T10:02:00.000Z');
  assert.equal(state.external_wait.resync_count, 1);
  assert.equal(state.external_wait.last_resync_at, '2026-08-17T10:32:00.000Z');

  state = markLeaseLost(state, {
    at: '2026-08-17T10:33:00.000Z',
    code: 'assignment_lease_expired',
    message: 'lease expired'
  });
  assert.equal(state.phase, 'LEASE_LOST');
  assert.equal(state.terminal_reason, 'LEASE_LOST');
  assert.equal(state.lease, null);
  assert.equal(state.lease_token, null);
  assert.equal(state.lease_loss.code, 'assignment_lease_expired');
  assert.equal(state.lease_loss.control_state, 'pending');
  assert.equal(state.task_project.status, 'active');
});

test('recordCreatedWorkspace clears stale Chat conversation identity when a replacement Chat is created', () => {
  let state = createExecutionState(task, { workspaceMode: 'chat' });
  state = recordCreatedWorkspace(state, {
    mode: 'chat', browserWorkspaceId: 'assignment-1', sessionId: 'ps-1', chatgptTabId: 10,
    conversationUrl: 'https://chatgpt.com/c/old-chat', conversationId: 'old-chat'
  });
  state = recordCreatedWorkspace(state, {
    mode: 'chat', browserWorkspaceId: 'assignment-1', sessionId: 'ps-1', chatgptTabId: 11
  });

  assert.equal(state.chatgpt_conversation_url, null);
  assert.equal(state.chatgpt_conversation_id, null);
  assert.equal(state.task_workspace.conversation_url ?? null, null);
  assert.equal(state.task_workspace.conversation_id ?? null, null);
});
