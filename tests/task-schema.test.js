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

test('resource url must be an absolute http or https URL when present', () => {
  for (const url of ['', '/relative/source.zip', 'file:///tmp/source.zip', 'ftp://example.com/source.zip']) {
    const result = validateTask({ task_id: 'r1', project_id: 'vetatool', task_prompt: 'fix', resource: { url } });
    assert.equal(result.ok, false, `expected invalid resource url: ${url}`);
    assert.match(result.errors.join(' '), /resource\.url/);
  }
});

test('valid resource metadata and initialization prompt are preserved', () => {
  const task = normalizeTask({
    task_id: 'r2',
    project_id: 'vetatool',
    task_prompt: 'fix',
    resource: { url: 'https://assets.example.com/source.zip', filename: 'vetatool-source.zip' },
    initialization_prompt: '先分析资源包'
  });
  assert.deepEqual(task.resource, { url: 'https://assets.example.com/source.zip', filename: 'vetatool-source.zip' });
  assert.equal(task.initialization_prompt, '先分析资源包');
});

test('agent-control task metadata and browser execution bootstrap survive normalization', () => {
  const raw = {
    task_id: 'controlled-1', project_id: 'vetatool', task_prompt: 'Integrate browser execution',
    agent_control: { agent_id: 'agent-mac', assignment_id: 'assignment-1', execution_id: 'execution-1' },
    browser_execution_bootstrap: { project: { project_id: 'vetatool' }, recovery_policy: { version: 1, rules: [] } }
  };
  const task = normalizeTask(raw);
  assert.deepEqual(task.agent_control, raw.agent_control);
  assert.deepEqual(task.browser_execution_bootstrap, raw.browser_execution_bootstrap);
});
