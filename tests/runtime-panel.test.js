import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRuntimePanelSource } from '../src/ui/runtime-panel.js';

const pendingTrace = [
  'assignment','claim','execution','bootstrap','export','source','project','upload','prompt','patch','completion'
].map(id => ({ id, status: 'pending' }));

test('runtime panel prefers current active execution over stale lastRun while runner is running', () => {
  const liveTrace = pendingTrace.map((item, index) => ({ ...item, status: index < 6 ? 'passed' : 'pending' }));
  const selected = selectRuntimePanelSource({
    running: true,
    activeExecution: { task_id: 'task-live', error_code: null },
    activeTrace: liveTrace,
    lastRun: {
      status: 'released', taskId: 'task-old', error_code: 'UI_SELECTOR_INCOMPATIBLE',
      error: { code: 'UI_SELECTOR_INCOMPATIBLE', message: 'old failure' },
      trace: pendingTrace.map(item => ({ ...item, status: item.id === 'project' ? 'failed' : item.status }))
    }
  });

  assert.equal(selected.kind, 'current');
  assert.equal(selected.label, '当前执行');
  assert.equal(selected.taskId, 'task-live');
  assert.deepEqual(selected.trace, liveTrace);
  assert.equal(selected.error, null);
});

test('runtime panel shows pending current trace instead of stale result before activeExecution is persisted', () => {
  const selected = selectRuntimePanelSource({
    running: true,
    activeExecution: null,
    lastRun: { status: 'released', taskId: 'task-old', trace: [{ id: 'project', status: 'failed' }] }
  });
  assert.equal(selected.kind, 'current');
  assert.equal(selected.label, '当前执行');
  assert.deepEqual(selected.trace, pendingTrace);
});

test('runtime panel falls back to latest completed run when no execution is active', () => {
  const selected = selectRuntimePanelSource({
    running: false,
    activeExecution: null,
    lastRun: {
      status: 'released', taskId: 'task-old', error_code: 'PROJECT_CREATE_ERROR',
      error: { code: 'PROJECT_CREATE_ERROR', message: 'failed' },
      trace: [{ id: 'project', status: 'failed' }]
    }
  });
  assert.equal(selected.kind, 'last');
  assert.equal(selected.label, '上次结果');
  assert.equal(selected.taskId, 'task-old');
  assert.equal(selected.error.code, 'PROJECT_CREATE_ERROR');
});

test('runtime panel prefers a later recovery result for the same Task over the stale initial run result', () => {
  const selected = selectRuntimePanelSource({
    running: false,
    activeExecution: null,
    lastRun: {
      status: 'waiting_external', taskId: 'task-reconciled',
      trace: [{ id: 'patch', status: 'pending' }, { id: 'completion', status: 'pending' }]
    },
    lastRecovery: {
      status: 'completed', taskId: 'task-reconciled',
      trace: [{ id: 'patch', status: 'passed' }, { id: 'completion', status: 'passed' }]
    }
  });

  assert.equal(selected.taskId, 'task-reconciled');
  assert.equal(selected.trace.find(item => item.id === 'patch').status, 'passed');
  assert.equal(selected.trace.find(item => item.id === 'completion').status, 'passed');
});
