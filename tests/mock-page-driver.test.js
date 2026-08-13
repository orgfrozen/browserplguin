import test from 'node:test';
import assert from 'node:assert/strict';
import { MockPageDriver } from '../src/background/mock-page-driver.js';

test('mock page driver creates one project, returns scripted rounds, and deletes it', async () => {
  const task = {
    task_id: 't1', project_id: 'vetatool', task_prompt: 'x',
    mock_rounds: [
      { assistantText: '<TASK_STATUS>CONTINUE</TASK_STATUS>', patches: [{ filename: 'patch-s1-001.patch' }] },
      { contextLimit: true }
    ],
    mock_session: { projectName: 'vetatool2026081314', sessionId: 's1' }
  };
  const page = new MockPageDriver();
  assert.deepEqual(await page.createTaskProject({ task }), task.mock_session);
  assert.equal((await page.runRound({ task })).patches[0].filename, 'patch-s1-001.patch');
  assert.equal((await page.runRound({ task })).contextLimit, true);
  assert.deepEqual(await page.deleteTaskProject({ project: { project_name: task.mock_session.projectName, session_id: 's1' } }), { ok: true });
  assert.equal(typeof page.migrateTask, 'undefined');
});

test('mock page driver exposes a separate initialization response for resource tasks', async () => {
  const page = new MockPageDriver();
  const task = {
    task_id: 'resource-task', project_id: 'vetatool', task_prompt: 'fix',
    resource: { url: 'https://assets.example.com/source.zip' },
    mock_initialization: { contextLimit: false, assistantText: 'initialized' }
  };
  assert.deepEqual(await page.initializeTask({ task }), task.mock_initialization);
});
