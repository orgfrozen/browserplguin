import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionState, recordRound, recordCompletedPatch, recordCreatedWorkspace, markWorkspaceDeleted } from '../src/shared/execution-state.js';

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
