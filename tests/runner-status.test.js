import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunnerStatusView } from '../src/shared/runner-status.js';

test('runner status keeps operational active Task fields without sensitive payloads or tokens', () => {
  const view = buildRunnerStatusView({
    running: true,
    settings: { mode: 'real', taskApiBaseUrl: 'https://tasks.example.test', taskApiToken: 'secret-api-token' },
    activeExecution: {
      task_id: 'task-007',
      project_id: 'vetatool',
      phase: 'RUNNING',
      task_round_count: 12,
      task_patch_count: 7,
      initialization_completed: true,
      session_id: 'abc123def456',
      chatgpt_project_name: 'vetatool2026081318',
      task_project: { project_name: 'vetatool2026081318', session_id: 'abc123def456', status: 'active' },
      task_snapshot: {
        task_id: 'task-007',
        project_id: 'vetatool',
        task_prompt: 'secret prompt body',
        project_constraints: 'secret constraints',
        patch_goal: { minimum: 30 },
        resource: { url: 'https://private.example/source.zip' }
      },
      lease: { token: 'secret-lease-token', ttl_ms: 90000, expires_at: '2026-08-13T19:00:00Z' },
      in_flight_round: { round_number: 13, stage: 'PROMPT_SENT', prompt: 'secret next prompt' },
      recovery_error: { code: 'TASK_RECOVERY_BLOCKED', message: 'sensitive detail' }
    },
    lastRun: { status: 'completed', taskId: 'old-task', state: { task_snapshot: { task_prompt: 'old secret' } } },
    lastRecovery: { status: 'recovery_blocked', error: { code: 'TASK_RECOVERY_BLOCKED', message: 'private message' } }
  });

  assert.deepEqual(view.activeExecution, {
    task_id: 'task-007',
    project_id: 'vetatool',
    phase: 'RUNNING',
    task_round_count: 12,
    task_patch_count: 7,
    patch_goal_minimum: 30,
    initialization_completed: true,
    project_name: 'vetatool2026081318',
    session_id: 'abc123def456',
    project_status: 'active',
    in_flight_round_number: 13,
    in_flight_stage: 'PROMPT_SENT',
    last_task_status: null,
    terminal_reason: null,
    terminal_action: null,
    lease: { present: true, ttl_ms: 90000, expires_at: '2026-08-13T19:00:00Z' },
    error_code: 'TASK_RECOVERY_BLOCKED'
  });
  assert.deepEqual(view.settings, { mode: 'real', task_api_configured: true });
  assert.deepEqual(view.selector_profile, { id: 'chatgpt-semantic-v1', version: 1 });
  assert.deepEqual(view.lastRun, { status: 'completed', taskId: 'old-task', error_code: null });
  assert.deepEqual(view.lastRecovery, { status: 'recovery_blocked', taskId: null, error_code: 'TASK_RECOVERY_BLOCKED' });

  const serialized = JSON.stringify(view);
  for (const secret of ['secret-api-token', 'secret-lease-token', 'secret prompt body', 'secret constraints', 'private.example', 'secret next prompt', 'sensitive detail', 'private message']) {
    assert.equal(serialized.includes(secret), false, `status leaked ${secret}`);
  }
});

test('runner status renders a stable idle shape when no active execution exists', () => {
  const view = buildRunnerStatusView({ running: false, activeExecution: null, lastRun: null, lastRecovery: null, settings: { mode: 'mock' } });
  assert.equal(view.running, false);
  assert.equal(view.activeExecution, null);
  assert.deepEqual(view.settings, { mode: 'mock', task_api_configured: false });
  assert.deepEqual(view.selector_profile, { id: 'chatgpt-semantic-v1', version: 1 });
  assert.equal(view.lastRun, null);
  assert.equal(view.lastRecovery, null);
});

test('runner status exposes only compact UI compatibility telemetry summary', () => {
  const view = buildRunnerStatusView({
    settings: { mode: 'real' },
    uiCompatibilityTelemetry: {
      version: 1,
      total_events: 7,
      buckets: [{ operation: 'CHATGPT_CREATE_PROJECT', count: 7, controls: ['secret-control'] }],
      last_event: {
        selector_profile: { id: 'chatgpt-semantic-v1', version: 1 },
        operation: 'CHATGPT_CREATE_PROJECT',
        error_code: 'UI_SELECTOR_INCOMPATIBLE',
        access_status: 'READY',
        page_category: 'chat',
        at: '2026-08-13T19:30:00.000Z',
        secret: 'must-not-leak'
      }
    }
  });

  assert.deepEqual(view.ui_compatibility, {
    total_events: 7,
    last_event: {
      selector_profile: { id: 'chatgpt-semantic-v1', version: 1 },
      operation: 'CHATGPT_CREATE_PROJECT',
      error_code: 'UI_SELECTOR_INCOMPATIBLE',
      access_status: 'READY',
      page_category: 'chat',
      at: '2026-08-13T19:30:00.000Z'
    }
  });
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes('secret-control'), false);
  assert.equal(serialized.includes('must-not-leak'), false);
});
