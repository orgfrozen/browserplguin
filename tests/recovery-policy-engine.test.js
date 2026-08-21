import test from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryPolicyEngine } from '../src/background/recovery-policy-engine.js';
import { ERROR_CODES, RunnerError } from '../src/shared/errors.js';

function policy({ timeoutSeconds = 1800, reloads = 3, reopens = 1 } = {}) {
  return {
    version: 1,
    rules: [{
      id: 'gpt-response-stalled',
      signal: 'GPT_RESPONSE_STALLED',
      observation_timeout_seconds: timeoutSeconds,
      actions: [
        { type: 'HEALTH_CHECK' },
        { type: 'RELOAD_PAGE', max_attempts: reloads, observation_timeout_seconds: timeoutSeconds },
        { type: 'REOPEN_WORKSPACE', max_attempts: reopens, observation_timeout_seconds: timeoutSeconds },
        { type: 'ESCALATE' }
      ]
    }]
  };
}

function timeout(state) {
  const error = new RunnerError(ERROR_CODES.MODEL_RESPONSE_TIMEOUT, 'stalled');
  error.durableExecutionState = state;
  return error;
}

test('server recovery policy runs health check then reload/reopen with a fresh full observation window each time', async () => {
  const calls = [];
  const saved = [];
  const page = {
    async healthCheck() { calls.push('health'); return { state: 'GENERATING' }; },
    async reloadPage() { calls.push('reload'); },
    async reopenWorkspace() { calls.push('reopen'); }
  };
  let attempts = 0;
  const engine = new RecoveryPolicyEngine({
    page,
    taskStore: { async save(state) { saved.push(structuredClone(state)); } },
    now: (() => { let n = 0; return () => new Date(1_800_000_000_000 + n++ * 1000); })()
  });
  const initial = { task_id: 't1', task_project: { project_name: 'p1', status: 'active' }, recovery_state: null };
  const result = await engine.execute({
    task: { task_id: 't1' },
    state: initial,
    policy: policy({ timeoutSeconds: 30, reloads: 2, reopens: 1 }),
    operation: async ({ state, observationTimeoutMs, recover }) => {
      calls.push(`wait:${observationTimeoutMs}:${recover ? 'recover' : 'normal'}`);
      attempts += 1;
      if (attempts < 4) throw timeout(state);
      return { state, result: { assistantText: 'done' } };
    }
  });

  assert.deepEqual(calls, [
    'wait:30000:normal',
    'health',
    'reload', 'wait:30000:recover',
    'reload', 'wait:30000:recover',
    'reopen', 'wait:30000:recover'
  ]);
  assert.equal(result.result.assistantText, 'done');
  assert.equal(result.state.recovery_state, null);
  assert.ok(saved.some(state => state.recovery_state?.action === 'RELOAD_PAGE' && state.recovery_state.attempt === 2));
  assert.ok(saved.some(state => state.recovery_state?.action === 'REOPEN_WORKSPACE' && state.recovery_state.attempt === 1));
});

test('durable recovery attempt resumes from the persisted reload count instead of restarting at attempt one', async () => {
  const calls = [];
  const engine = new RecoveryPolicyEngine({
    page: {
      async healthCheck() { calls.push('health'); },
      async reloadPage() { calls.push('reload'); },
      async reopenWorkspace() { calls.push('reopen'); }
    },
    taskStore: { async save() {} },
    now: () => new Date('2026-08-17T12:00:00Z')
  });
  const state = {
    task_id: 't1',
    task_project: { project_name: 'p1', status: 'active' },
    recovery_state: {
      signal: 'GPT_RESPONSE_STALLED',
      rule_id: 'gpt-response-stalled',
      action: 'RELOAD_PAGE',
      attempt: 2,
      observation_started_at: '2026-08-17T11:30:00.000Z',
      last_meaningful_progress_at: '2026-08-17T11:00:00.000Z',
      next_check_at: '2026-08-17T12:00:00.000Z'
    }
  };
  let runs = 0;
  const result = await engine.execute({
    task: { task_id: 't1' }, state, policy: policy({ timeoutSeconds: 20, reloads: 3, reopens: 1 }),
    operation: async ({ state: current, observationTimeoutMs }) => {
      calls.push(`wait:${observationTimeoutMs}`);
      runs += 1;
      if (runs === 1) throw timeout(current);
      return { state: current, result: { ok: true } };
    }
  });
  assert.deepEqual(calls, ['wait:20000', 'reload', 'wait:20000']);
  assert.equal(result.state.recovery_state, null);
});

test('recovery exhaustion escalates instead of creating a replacement Project', async () => {
  const calls = [];
  const engine = new RecoveryPolicyEngine({
    page: {
      async healthCheck() { calls.push('health'); },
      async reloadPage() { calls.push('reload'); },
      async reopenWorkspace() { calls.push('reopen'); }
    },
    taskStore: { async save() {} }
  });
  await assert.rejects(
    engine.execute({
      task: { task_id: 't1' },
      state: { task_id: 't1', task_project: { project_name: 'p1', status: 'active' } },
      policy: policy({ timeoutSeconds: 1, reloads: 1, reopens: 1 }),
      operation: async ({ state }) => { throw timeout(state); }
    }),
    error => error instanceof RunnerError && error.code === ERROR_CODES.RECOVERY_EXHAUSTED
  );
  assert.deepEqual(calls, ['health', 'reload', 'reopen']);
});

test('explicit MODEL_RESPONSE_FAILED enters the existing server-driven reload/reopen recovery ladder', async () => {
  const calls = [];
  const engine = new RecoveryPolicyEngine({
    page: {
      async healthCheck() { calls.push('health'); },
      async reloadPage() { calls.push('reload'); },
      async reopenWorkspace() { calls.push('reopen'); }
    },
    taskStore: { async save() {} }
  });
  let attempts = 0;
  const result = await engine.execute({
    task: { task_id: 't-response-failed' },
    state: { task_id: 't-response-failed', task_project: { project_name: 'p1', status: 'active' } },
    policy: policy({ timeoutSeconds: 1, reloads: 1, reopens: 1 }),
    operation: async ({ state }) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new RunnerError(ERROR_CODES.MODEL_RESPONSE_FAILED, 'explicit response failure');
        error.durableExecutionState = state;
        throw error;
      }
      return { state, result: { assistantText: 'recovered' } };
    }
  });

  assert.equal(result.result.assistantText, 'recovered');
  assert.deepEqual(calls, ['health', 'reload']);
});
