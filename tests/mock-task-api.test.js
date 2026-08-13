import test from 'node:test';
import assert from 'node:assert/strict';
import { MockTaskApi } from '../src/background/mock-task-api.js';

const tasks = [
  { task_id: 't1', project_id: 'vetatool', task_prompt: 'fix one' },
  { task_id: 't2', project_id: 'vetatool', task_prompt: 'fix two' }
];

test('claim locks one task and release makes it claimable again', async () => {
  const api = new MockTaskApi(tasks);
  const first = await api.claimTask();
  assert.equal(first.task_id, 't1');
  await api.releaseTask('t1', { code: 'TEST' });
  const second = await api.claimTask();
  assert.equal(second.task_id, 't1');
});

test('completed task is terminal and progress/artifact events are recorded', async () => {
  const api = new MockTaskApi(tasks);
  await api.claimTask();
  await api.reportProgress('t1', { type: 'ROUND_DONE', round: 1 });
  await api.reportArtifact('t1', { filename: 'patch-a-001.patch' });
  await api.completeTask('t1', { ok: true });
  const snapshot = api.getSnapshot();
  assert.equal(snapshot.tasks.t1.status, 'completed');
  assert.equal(snapshot.tasks.t1.events.length, 4);
  assert.equal((await api.claimTask()).task_id, 't2');
});
