import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReleaseReadiness, RELEASE_READINESS_BLOCKERS } from '../src/shared/release-readiness.js';

function baseInput() {
  return {
    calibration: {
      ready_for_review: true,
      required_count: 6,
      covered_count: 6,
      needs_review_count: 0,
      missing_pass_count: 0,
      total_recorded_runs: 8,
      recent_runs: [{ secret: 'cal-secret' }]
    },
    resourceEvidence: { total_runs: 2, passed_runs: 1, recent_runs: [{ resource_url: 'https://secret.example/a.zip' }] },
    remoteEvidence: { total_runs: 3, passed_runs: 1, recent_runs: [{ filename: 'secret.patch' }] },
    remoteProduction: { enabled: true, passed_runs: 1, taskApiToken: 'secret-token' },
    remotePreflight: { ready_for_remote_e2e: true, blockers: [], checks: { secret: 'secret-check' }, raw_error: 'secret-error' }
  };
}

test('release readiness emits stable blockers for every unmet production requirement', () => {
  const report = buildReleaseReadiness({
    calibration: { ready_for_review: false, required_count: 6, covered_count: 3, needs_review_count: 1, missing_pass_count: 2 },
    resourceEvidence: { total_runs: 1, passed_runs: 0 },
    remoteEvidence: { total_runs: 1, passed_runs: 0 },
    remoteProduction: { enabled: false },
    remotePreflight: { ready_for_remote_e2e: false, blockers: ['NATIVE_HELPER_UNAVAILABLE'] }
  }, { now: () => new Date('2026-08-14T05:20:00.000Z') });

  assert.equal(report.ready_for_release_review, false);
  assert.equal(report.status, 'blocked');
  assert.deepEqual(report.blockers, [
    RELEASE_READINESS_BLOCKERS.CALIBRATION_INCOMPLETE,
    RELEASE_READINESS_BLOCKERS.CALIBRATION_NEEDS_REVIEW,
    RELEASE_READINESS_BLOCKERS.RESOURCE_E2E_REQUIRED,
    RELEASE_READINESS_BLOCKERS.REMOTE_E2E_REQUIRED,
    RELEASE_READINESS_BLOCKERS.REMOTE_PRODUCTION_REQUIRED,
    RELEASE_READINESS_BLOCKERS.REMOTE_PREFLIGHT_BLOCKED
  ]);
  assert.deepEqual(report.remote_preflight.blockers, ['NATIVE_HELPER_UNAVAILABLE']);
});

test('release readiness becomes ready only when all evidence, production mode and fresh preflight are ready', () => {
  const report = buildReleaseReadiness(baseInput(), { now: () => new Date('2026-08-14T05:21:00.000Z') });
  assert.equal(report.status, 'ready_for_release_review');
  assert.equal(report.ready_for_release_review, true);
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.calibration, {
    satisfied: true,
    required_count: 6,
    covered_count: 6,
    needs_review_count: 0,
    missing_pass_count: 0
  });
  assert.deepEqual(report.resource_e2e, { satisfied: true, total_runs: 2, passed_runs: 1 });
  assert.deepEqual(report.remote_e2e, { satisfied: true, total_runs: 3, passed_runs: 1 });
  assert.deepEqual(report.remote_production, { satisfied: true, enabled: true });
  assert.deepEqual(report.remote_preflight, { satisfied: true, ready: true, blockers: [] });
});

test('release readiness is a strict privacy-safe whitelist projection', () => {
  const input = baseInput();
  input.task_id = 'secret-task';
  input.project_name = 'secret-project';
  input.url = 'https://secret.example/task';
  input.filename = 'secret.patch';
  input.local_path = '/secret/path';
  input.prompt = 'secret-prompt';
  input.token = 'secret-token';
  input.remotePreflight.blockers = ['NATIVE_HELPER_UNAVAILABLE', 'UNKNOWN_SECRET_BLOCKER'];
  const report = buildReleaseReadiness(input, { now: () => new Date('2026-08-14T05:22:00.000Z') });

  assert.deepEqual(Object.keys(report).sort(), [
    'blockers','calibration','generated_at','ready_for_release_review','remote_e2e','remote_preflight','remote_production','resource_e2e','status','version'
  ].sort());
  assert.deepEqual(report.remote_preflight.blockers, ['NATIVE_HELPER_UNAVAILABLE']);
  const serialized = JSON.stringify(report);
  for (const forbidden of ['cal-secret','secret.example','secret.patch','secret-task','secret-project','/secret/path','secret-prompt','secret-token','secret-check','secret-error','UNKNOWN_SECRET_BLOCKER']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
