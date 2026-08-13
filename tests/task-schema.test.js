import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTask, validateTask } from '../src/shared/task-schema.js';

test('normal fix task is valid without patch_goal', () => {
  const raw = { task_id: 't1', project_id: 'vetatool', task_prompt: 'fix bug' };
  assert.deepEqual(validateTask(raw), { ok: true, errors: [] });
  assert.equal(normalizeTask(raw).patch_goal, null);
});

test('valid minimum patch goal is preserved', () => {
  const task = normalizeTask({ task_id: 't2', project_id: 'vetatool', task_prompt: 'seo', patch_goal: { minimum: 30 } });
  assert.deepEqual(task.patch_goal, { minimum: 30 });
});

test('non-positive patch goal is rejected', () => {
  const result = validateTask({ task_id: 't3', project_id: 'vetatool', task_prompt: 'seo', patch_goal: { minimum: 0 } });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /patch_goal\.minimum/);
});

test('required task fields are enforced', () => {
  const result = validateTask({ task_id: '', project_id: '', task_prompt: '' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /task_id/);
  assert.match(result.errors.join(' '), /project_id/);
  assert.match(result.errors.join(' '), /task_prompt/);
});
