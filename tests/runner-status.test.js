import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunnerStatusView } from '../src/shared/runner-status.js';

test('runner status keeps operational active Task fields without sensitive payloads or tokens', () => {
  const view = buildRunnerStatusView({
    running: true,
    settings: { mode: 'real', taskApiBaseUrl: 'https://tasks.example.test', taskApiToken: 'secret-api-token', cleanupLegacyProjects: true },
    activeExecution: {
      task_id: 'task-007',
      project_id: 'vetatool',
      phase: 'RUNNING',
      local_started_at: '2026-08-29T04:12:34.000Z',
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
      terminal_reason: 'CHAT_LENGTH_LIMIT',
      terminal_action: 'CONTEXT_LIMIT',
      recovery_error: { code: 'TASK_RECOVERY_BLOCKED', message: 'sensitive detail' }
    },
    lastRun: { status: 'completed', taskId: 'old-task', state: { task_snapshot: { task_prompt: 'old secret' } } },
    lastRecovery: { status: 'recovery_blocked', error: { code: 'TASK_RECOVERY_BLOCKED', message: 'private message' } }
  });

  assert.deepEqual(view.activeExecution, {
    task_id: 'task-007',
    project_id: 'vetatool',
    phase: 'RUNNING',
    local_started_at: '2026-08-29T04:12:34.000Z',
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
    terminal_reason: 'CHAT_LENGTH_LIMIT',
    terminal_action: 'CONTEXT_LIMIT',
    terminal_status: 'context_limit',
    lease: { present: true, ttl_ms: 90000, expires_at: '2026-08-13T19:00:00Z' },
    error_code: 'TASK_RECOVERY_BLOCKED'
  });
  assert.deepEqual(view.settings, { mode: 'real', task_api_configured: true, patch_transfer_mode: 'local', remote_e2e_test_mode: false, remote_production_mode: false, cleanup_legacy_projects: true });
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
  assert.deepEqual(view.settings, { mode: 'mock', task_api_configured: false, patch_transfer_mode: 'local', remote_e2e_test_mode: false, remote_production_mode: false, cleanup_legacy_projects: false });
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

test('runner status exposes only safe remote E2E test-mode settings metadata', () => {
  const view = buildRunnerStatusView({
    settings: {
      mode: 'real',
      taskApiBaseUrl: 'https://tasks.secret.example/api',
      taskApiToken: 'secret-token',
      patchTransferMode: 'remote',
      remoteE2eTestMode: true
    }
  });
  assert.deepEqual(view.settings, {
    mode: 'real',
    task_api_configured: true,
    patch_transfer_mode: 'remote',
    remote_e2e_test_mode: true,
    remote_production_mode: false,
    cleanup_legacy_projects: false
  });
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes('tasks.secret.example'), false);
  assert.equal(serialized.includes('secret-token'), false);
});


test('runner status exposes only safe production remote mode metadata', () => {
  const view = buildRunnerStatusView({
    settings: {
      mode: 'real', taskApiBaseUrl: 'https://private.example/api', taskApiToken: 'top-secret',
      patchTransferMode: 'remote', remoteE2eTestMode: false, remoteProductionMode: true
    }
  });
  assert.equal(view.settings.patch_transfer_mode, 'remote');
  assert.equal(view.settings.remote_e2e_test_mode, false);
  assert.equal(view.settings.remote_production_mode, true);
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes('private.example'), false);
  assert.equal(serialized.includes('top-secret'), false);
});

test('runner status exposes a live execution trace from active durable state before the run finishes', () => {
  const view = buildRunnerStatusView({
    running: true,
    activeExecution: {
      task_id: 'task-live',
      project_id: 'browserplguin',
      assignment_id: 'assignment-live',
      execution_id: 'execution-live',
      phase: 'PREPARING_SOURCE',
      source_preparation: {
        status: 'succeeded',
        export_id: 'exp-live',
        patch_session_id: 'ps-live',
        source: { filename: 'source.zip' },
        rules: { text: 'rules' }
      },
      patch_session_id: 'ps-live',
      task_round_count: 0,
      task_patch_count: 0,
      initialization_completed: false,
      business_completed: false
    },
    lastRun: {
      status: 'released',
      taskId: 'task-old',
      error: { safe: true, code: 'OLD_ERROR', message: 'old failure' },
      state: {
        task_id: 'task-old', assignment_id: 'assignment-old', execution_id: 'execution-old',
        source_preparation: { status: 'succeeded', export_id: 'exp-old' }
      }
    },
    settings: { mode: 'real' }
  });

  assert.deepEqual(view.activeTrace, [
    { id: 'assignment', status: 'passed' },
    { id: 'claim', status: 'passed' },
    { id: 'execution', status: 'passed' },
    { id: 'bootstrap', status: 'passed' },
    { id: 'export', status: 'passed' },
    { id: 'source', status: 'passed' },
    { id: 'project', status: 'pending' },
    { id: 'upload', status: 'pending' },
    { id: 'prompt', status: 'pending' },
    { id: 'patch', status: 'pending' },
    { id: 'completion', status: 'pending' }
  ]);
  assert.equal(view.lastRun.error_code, 'OLD_ERROR');
});

test('runner status exposes only the manual pause flag alongside safe runtime metadata', () => {
  const view = buildRunnerStatusView({
    running: false,
    manualPaused: true,
    settings: { mode: 'real', taskApiToken: 'secret-token' }
  });
  assert.equal(view.paused, true);
  assert.equal(JSON.stringify(view).includes('secret-token'), false);
});

test('runner status marks Patch passed when server reconciliation proves a successful Patch without a local download receipt', () => {
  const view = buildRunnerStatusView({
    running: false,
    activeExecution: {
      task_id: 'task-server-patch', project_id: 'browserplguin', assignment_id: 'a1', execution_id: 'e1',
      task_patch_count: 0, server_successful_patch_count: 1, initialization_completed: true, business_completed: true,
      source_preparation: { status: 'succeeded', export_id: 'exp1', patch_session_id: 'ps1' },
      chatgpt_project_name: 'browserplguin20260820', task_project: { project_name: 'browserplguin20260820', status: 'deleted' }
    },
    settings: { mode: 'real' }
  });

  assert.equal(view.activeExecution.task_patch_count, 1);
  assert.equal(view.activeExecution.local_task_patch_count, 0);
  assert.equal(view.activeExecution.server_successful_patch_count, 1);
  assert.equal(view.activeTrace.find(item => item.id === 'patch').status, 'passed');
  assert.equal(view.activeTrace.find(item => item.id === 'completion').status, 'passed');
});

test('runner status reports PatchSync as the effective transfer path for an active PatchSync-backed execution', () => {
  const view = buildRunnerStatusView({
    running: true,
    settings: { mode: 'real', patchTransferMode: 'local' },
    activeExecution: {
      task_id: 'task-patchsync-transfer',
      browser_execution_bootstrap: {
        patchsync: {
          base_url: 'https://patchsync.secret.example',
          access_token: 'secret-capability-token'
        }
      }
    }
  });

  assert.equal(view.settings.patch_transfer_mode, 'patchsync');
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes('patchsync.secret.example'), false);
  assert.equal(serialized.includes('secret-capability-token'), false);
});


test('runner status exposes compact WAITING_EXTERNAL status-check observability', () => {
  const view = buildRunnerStatusView({
    activeExecution: {
      task_id: 'task-observe',
      project_id: 'vetatool',
      phase: 'WAITING_EXTERNAL',
      next_recovery_at: '2026-08-22T01:37:00.000Z',
      external_wait: {
        started_at: '2026-08-22T01:30:00.000Z',
        last_checked_at: '2026-08-22T01:35:00.000Z',
        next_check_at: '2026-08-22T01:37:00.000Z',
        query_count: 4,
        last_query_at: '2026-08-22T01:35:00.000Z',
        last_result: 'completion:WAIT_EXTERNAL',
        last_patch_reconcile_at: '2026-08-22T01:34:59.000Z',
        last_patch_reconcile_result: 'reconcile:no_patch',
        last_completion_check_at: '2026-08-22T01:35:00.000Z',
        summary: 'must not leak this server summary'
      }
    }
  });

  assert.deepEqual(view.activeExecution.status_checks, {
    query_count: 4,
    last_query_at: '2026-08-22T01:35:00.000Z',
    next_query_at: '2026-08-22T01:37:00.000Z',
    last_result: 'completion:WAIT_EXTERNAL',
    last_patch_reconcile_at: '2026-08-22T01:34:59.000Z',
    last_patch_reconcile_result: 'reconcile:no_patch',
    last_completion_check_at: '2026-08-22T01:35:00.000Z'
  });
  assert.equal(JSON.stringify(view).includes('must not leak this server summary'), false);
});

test('runner status exposes safe Patch recovery checkpoints without Prompt, token, URL, or arbitrary recovery text', () => {
  const view = buildRunnerStatusView({
    running: false,
    settings: { mode: 'real' },
    activeExecution: {
      task_id: 'task-patch-recovery', project_id: 'vetatool', phase: 'RUNNING',
      task_round_count: 0, task_patch_count: 0,
      browser_slot_id: 'chatgpt-2', chatgpt_tab_id: 88,
      in_flight_round: { round_number: 1, stage: 'RESPONSE_READY', prompt: 'secret prompt', assistant_text: 'secret answer' },
      recovery_error: { code: 'TASK_RECOVERY_BLOCKED', message: 'Persisted sent Prompt is not the latest ChatGPT user message' },
      patch_delivery: {
        stage: 'DOWNLOAD_FAILED', round_number: 1, attempt: 1,
        filename: 'vetatool--ps-safe--001-fix.patch', error_code: 'PATCH_DOWNLOAD_FAILED',
        reason: 'download_interrupted', updated_at: '2026-08-27T10:00:00.000Z',
        source_url: 'https://secret.invalid/token=hidden'
      },
      next_recovery_at: '2026-08-27T10:00:10.000Z'
    }
  });

  assert.equal(view.activeExecution.browser_slot_id, 'chatgpt-2');
  assert.equal(view.activeExecution.chatgpt_tab_id, 88);
  assert.equal(view.activeExecution.recovery_reason, 'persisted_prompt_not_latest');
  assert.deepEqual(view.activeExecution.patch_delivery, {
    stage: 'DOWNLOAD_FAILED', round_number: 1, attempt: 1,
    filename: 'vetatool--ps-safe--001-fix.patch', error_code: 'PATCH_DOWNLOAD_FAILED',
    reason: 'download_interrupted', updated_at: '2026-08-27T10:00:00.000Z'
  });
  assert.equal(view.activeExecution.next_recovery_at, '2026-08-27T10:00:10.000Z');
  const serialized = JSON.stringify(view);
  for (const secret of ['secret prompt', 'secret answer', 'secret.invalid', 'token=hidden']) {
    assert.equal(serialized.includes(secret), false, `status leaked ${secret}`);
  }
});


test('runner status exposes only safe infrastructure wait metadata for the active Task', () => {
  const view = buildRunnerStatusView({
    activeExecution: {
      task_id: 'task-infra-wait',
      project_id: 'vetatool',
      phase: 'PREPARING_SOURCE',
      infrastructure_wait: {
        service: 'patchsync',
        operation: 'ensure_ready',
        started_at: '2026-08-29T04:30:00.000Z',
        next_retry_at: '2026-08-29T04:30:05.000Z',
        last_error_code: 'PATCHSYNC_UNREACHABLE',
        secret: 'must-not-leak'
      }
    }
  });

  assert.deepEqual(view.activeExecution.infrastructure_wait, {
    service: 'patchsync',
    operation: 'ensure_ready',
    started_at: '2026-08-29T04:30:00.000Z',
    next_retry_at: '2026-08-29T04:30:05.000Z',
    last_error_code: 'PATCHSYNC_UNREACHABLE'
  });
  assert.equal(JSON.stringify(view).includes('must-not-leak'), false);
});

test('runner status exposes safe PatchSync source diagnostics for the active Task', () => {
  const view = buildRunnerStatusView({
    running: true,
    activeExecution: {
      task_id: 'task-source-diag',
      project_id: 'vetatool',
      phase: 'PREPARING_SOURCE',
      source_preparation: {
        status: 'waiting',
        export_id: 'exp-source-diag',
        remote_status: 'running',
        stage: 'waiting_for_idle'
      },
      recovery_error: {
        code: 'PATCHSYNC_HTTP_ERROR',
        message: 'PatchSync request returned HTTP 503',
        details: {
          origin: 'http://127.0.0.1:8790',
          operation: 'export_status',
          status: 503,
          server_reason: 'temporarily unavailable',
          authorization: 'PatchSync secret-token',
          access_token: 'secret-token'
        }
      }
    },
    settings: { mode: 'real' }
  });

  assert.deepEqual(view.activeExecution.source_export, {
    export_id: 'exp-source-diag',
    status: 'running',
    stage: 'waiting_for_idle'
  });
  assert.deepEqual(view.activeExecution.recovery_error, {
    code: 'PATCHSYNC_HTTP_ERROR',
    message: 'PatchSync request returned HTTP 503',
    details: {
      origin: 'http://127.0.0.1:8790',
      operation: 'export_status',
      status: 503,
      server_reason: 'temporarily unavailable'
    }
  });
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal(serialized.includes('authorization'), false);
  assert.equal(serialized.includes('access_token'), false);
});

test('runner status marks the export trace failed when PatchSync source preparation has a structured error', () => {
  const view = buildRunnerStatusView({
    running: true,
    activeExecution: {
      task_id: 'task-export-error', project_id: 'vetatool', assignment_id: 'a1', execution_id: 'e1',
      phase: 'PREPARING_SOURCE',
      source_preparation: { status: 'waiting', export_id: 'exp-error', remote_status: 'running', stage: 'exporting' },
      recovery_error: { code: 'PATCHSYNC_HTTP_ERROR', message: 'PatchSync request returned HTTP 503', details: { status: 503 } }
    },
    settings: { mode: 'real' }
  });
  assert.equal(view.activeTrace.find(item => item.id === 'export').status, 'failed');
});
