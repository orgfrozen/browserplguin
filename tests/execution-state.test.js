import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionState, recordRound, recordCompletedPatch, recordCreatedWorkspace, markWorkspaceDeleted, checkpointRoundIntent, markRoundPromptSent, markRoundResponseReady, completeRound, markInitializationCompleted } from '../src/shared/execution-state.js';

const task = { task_id: 't1', project_id: 'vetatool', task_prompt: 'fix' };

test('execution state owns exactly one task project and one session', () => {
  let state = createExecutionState(task);
  state = recordCreatedWorkspace(state, { projectName: 'vetatool2026081315-t1', sessionId: 's1' });
  assert.deepEqual(state.task_project, {
    project_name: 'vetatool2026081315-t1',
    session_id: 's1',
    status: 'active'
  });
  assert.equal(state.chatgpt_project_name, 'vetatool2026081315-t1');
  assert.equal(state.session_id, 's1');
  assert.equal('task_projects' in state, false);
  assert.equal('session_patch_count' in state, false);
  assert.equal('session_round_count' in state, false);
  assert.equal('project_round_count' in state, false);
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
    agent_control: { agent_id: 'agent-mac', assignment_id: 'assignment-1', execution_id: 'execution-1' },
    browser_execution_bootstrap: { project: { project_id: 'vetatool' }, recovery_policy: { version: 1, rules: [] } }
  };
  const lease = {
    token: 'lease-a', ttl_ms: 60000, expires_at: '2026-08-17T11:01:00.000Z',
    agent_id: 'agent-mac', assignment_id: 'assignment-1', execution_id: 'execution-1'
  };
  const state = createExecutionState(controlledTask, { lease });
  assert.equal(state.agent_id, 'agent-mac');
  assert.equal(state.assignment_id, 'assignment-1');
  assert.equal(state.execution_id, 'execution-1');
  assert.equal(state.lease_token, 'lease-a');
  assert.deepEqual(state.browser_execution_bootstrap, controlledTask.browser_execution_bootstrap);
});
