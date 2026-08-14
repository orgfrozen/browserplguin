import test from 'node:test';
import assert from 'node:assert/strict';
import { buildValidationHandoffBundle, VALIDATION_NEXT_ACTIONS } from '../src/shared/validation-handoff.js';

function baseInput() {
  return {
    calibration: {
      ready_for_review: true,
      required_count: 6,
      covered_count: 6,
      needs_review_count: 0,
      missing_pass_count: 0,
      total_recorded_runs: 9,
      selector_profiles: [{ id: 'chatgpt-semantic-v1', version: 1 }],
      surfaces: {
        context_limit: { coverage: 'covered', total_runs: 2, pass_count: 1, unavailable_count: 1, incompatible_count: 0, latest_status: 'unavailable', latest_page_category: 'chat', last_seen_at: '2026-08-14T05:00:00.000Z', latest_fingerprints: [{ tag: 'div', role: 'alert', type: null, test_id_category: 'present_unknown', name_category: 'absent', semantic_hint: 'context_limit', ancestor_roles: ['main'], text: 'SECRET-CONTEXT', href: 'https://secret.invalid/context' }] },
        patch_candidates: { coverage: 'covered', total_runs: 1, pass_count: 1, unavailable_count: 0, incompatible_count: 0, latest_status: 'pass', latest_page_category: 'chat', last_seen_at: '2026-08-14T05:01:00.000Z' },
        project_create: { coverage: 'covered', total_runs: 1, pass_count: 1, unavailable_count: 0, incompatible_count: 0, latest_status: 'pass', latest_page_category: 'home', last_seen_at: '2026-08-14T05:02:00.000Z' },
        project_settings: { coverage: 'covered', total_runs: 1, pass_count: 1, unavailable_count: 0, incompatible_count: 0, latest_status: 'pass', latest_page_category: 'project', last_seen_at: '2026-08-14T05:03:00.000Z' },
        resource_input: { coverage: 'covered', total_runs: 1, pass_count: 1, unavailable_count: 0, incompatible_count: 0, latest_status: 'pass', latest_page_category: 'chat', last_seen_at: '2026-08-14T05:04:00.000Z' },
        project_delete: { coverage: 'covered', total_runs: 1, pass_count: 1, unavailable_count: 0, incompatible_count: 0, latest_status: 'pass', latest_page_category: 'project', last_seen_at: '2026-08-14T05:05:00.000Z' }
      },
      recent_runs: [{ prompt: 'secret' }]
    },
    resourceEvidence: { total_runs: 2, passed_runs: 1, failed_runs: 1, incomplete_runs: 0, last_run: { result: 'passed', failure_stage: 'none', resource_url: 'https://secret.example/a.zip' }, recent_runs: [{ filename: 'secret.zip' }] },
    remoteEvidence: { total_runs: 3, passed_runs: 1, failed_runs: 1, incomplete_runs: 1, last_run: { result: 'passed', failure_stage: 'none', local_path: '/secret/a.patch' }, recent_runs: [{ token: 'secret-token' }] },
    remoteProduction: { enabled: true, eligible_evidence: true, passed_runs: 1, patch_transfer_mode: 'remote', taskApiToken: 'secret-token' },
    remotePreflight: { ready_for_remote_e2e: true, blockers: [], checked_at: '2026-08-14T05:06:00.000Z', checks: { secret: 'x' } },
    releaseReadiness: { ready_for_release_review: true, status: 'ready_for_release_review', blockers: [], url: 'https://secret.example' }
  };
}

test('validation handoff chooses a deterministic next action in operational precedence', () => {
  const incompleteCalibration = baseInput().calibration;
  incompleteCalibration.surfaces.project_delete = {
    coverage: 'missing_pass', total_runs: 1, pass_count: 0, unavailable_count: 1,
    incompatible_count: 0, latest_status: 'unavailable', latest_page_category: 'project', last_seen_at: '2026-08-14T05:07:00.000Z'
  };
  const cases = [
    [{ calibration: incompleteCalibration }, VALIDATION_NEXT_ACTIONS.CALIBRATE_UI],
    [{ resourceEvidence: { ...baseInput().resourceEvidence, passed_runs: 0 } }, VALIDATION_NEXT_ACTIONS.RUN_RESOURCE_E2E],
    [{ remotePreflight: { ready_for_remote_e2e: false, blockers: ['NATIVE_HELPER_UNAVAILABLE'] } }, VALIDATION_NEXT_ACTIONS.FIX_REMOTE_PREFLIGHT],
    [{ remoteEvidence: { ...baseInput().remoteEvidence, passed_runs: 0 } }, VALIDATION_NEXT_ACTIONS.RUN_REMOTE_E2E],
    [{ remoteProduction: { ...baseInput().remoteProduction, enabled: false, patch_transfer_mode: 'local' } }, VALIDATION_NEXT_ACTIONS.PROMOTE_REMOTE],
    [{}, VALIDATION_NEXT_ACTIONS.RELEASE_REVIEW]
  ];

  for (const [override, expected] of cases) {
    const input = baseInput();
    Object.assign(input, override);
    const bundle = buildValidationHandoffBundle(input, { now: () => new Date('2026-08-14T05:10:00.000Z') });
    assert.equal(bundle.next_action, expected);
  }
});

test('validation handoff is a strict safe whitelist and filters unknown blockers', () => {
  const input = baseInput();
  input.task_id = 'secret-task';
  input.project_name = 'secret-project';
  input.prompt = 'secret-prompt';
  input.filename = 'secret.patch';
  input.local_path = '/secret/path';
  input.token = 'secret-token';
  input.remotePreflight.ready_for_remote_e2e = false;
  input.remotePreflight.blockers = ['NATIVE_HELPER_UNAVAILABLE', 'UNKNOWN_SECRET_BLOCKER'];
  input.releaseReadiness.blockers = ['REMOTE_PREFLIGHT_BLOCKED', 'UNKNOWN_RELEASE_BLOCKER'];

  const bundle = buildValidationHandoffBundle(input, { now: () => new Date('2026-08-14T05:11:00.000Z') });
  assert.deepEqual(Object.keys(bundle).sort(), [
    'calibration','generated_at','next_action','ready_for_release_review','release','remote_e2e','remote_preflight','remote_production','resource_e2e','selector_calibration_delta','selector_remediation_plan','version'
  ].sort());
  assert.deepEqual(bundle.remote_preflight.blockers, ['NATIVE_HELPER_UNAVAILABLE']);
  assert.deepEqual(bundle.release.blockers, ['REMOTE_PREFLIGHT_BLOCKED']);
  assert.equal(bundle.calibration.surfaces.context_limit.coverage, 'covered');
  assert.deepEqual(bundle.calibration.surfaces.context_limit.fingerprints, [
    { tag: 'div', role: 'alert', type: null, test_id_category: 'present_unknown', name_category: 'absent', semantic_hint: 'context_limit', ancestor_roles: ['main'] }
  ]);
  assert.equal(bundle.remote_e2e.last_result, 'passed');
  assert.equal(bundle.resource_e2e.last_failure_stage, 'none');
  const serialized = JSON.stringify(bundle);
  for (const forbidden of ['secret-task','secret-project','secret-prompt','secret.patch','/secret/path','secret-token','secret.example','UNKNOWN_SECRET_BLOCKER','UNKNOWN_RELEASE_BLOCKER','SECRET-CONTEXT']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('validation handoff never marks release review ready from inconsistent hostile input', () => {
  const input = baseInput();
  input.releaseReadiness = { ready_for_release_review: true, status: 'ready_for_release_review', blockers: [] };
  input.remoteProduction.enabled = false;
  const bundle = buildValidationHandoffBundle(input, { now: () => new Date('2026-08-14T05:12:00.000Z') });
  assert.equal(bundle.ready_for_release_review, false);
  assert.equal(bundle.next_action, VALIDATION_NEXT_ACTIONS.PROMOTE_REMOTE);
  assert.deepEqual(bundle.release.blockers, ['REMOTE_PRODUCTION_REQUIRED']);
});

test('validation handoff recomputes calibration readiness from the six projected surfaces', () => {
  const input = baseInput();
  input.calibration.ready_for_review = true;
  input.calibration.covered_count = 6;
  input.calibration.missing_pass_count = 0;
  input.calibration.surfaces.project_delete = {
    coverage: 'missing_pass', total_runs: 4, pass_count: 0, unavailable_count: 4,
    incompatible_count: 0, latest_status: 'unavailable', latest_page_category: 'project', last_seen_at: '2026-08-14T05:15:00.000Z'
  };
  const bundle = buildValidationHandoffBundle(input, { now: () => new Date('2026-08-14T05:16:00.000Z') });
  assert.equal(bundle.calibration.covered_count, 5);
  assert.equal(bundle.calibration.missing_pass_count, 1);
  assert.equal(bundle.calibration.ready_for_review, false);
  assert.equal(bundle.next_action, VALIDATION_NEXT_ACTIONS.CALIBRATE_UI);
  assert.equal(bundle.ready_for_release_review, false);
});


test('validation handoff embeds selector calibration deltas without changing release semantics', () => {
  const input = baseInput();
  input.calibration.surfaces.resource_input.latest_fingerprints = [{
    tag: 'button', role: 'button', type: 'button', test_id_category: 'present_unknown', name_category: 'absent', semantic_hint: 'unknown', ancestor_roles: ['main'],
    text: 'TOP SECRET RESOURCE CONTROL', href: 'https://secret.invalid/resource?token=x'
  }];
  const bundle = buildValidationHandoffBundle(input, { now: () => new Date('2026-08-14T05:20:00.000Z') });

  assert.equal(bundle.next_action, VALIDATION_NEXT_ACTIONS.RELEASE_REVIEW);
  assert.equal(bundle.ready_for_release_review, true);
  assert.equal(bundle.selector_calibration_delta.generated_at, bundle.generated_at);
  assert.equal(bundle.selector_calibration_delta.contract_version, 1);
  assert.equal(bundle.selector_calibration_delta.surfaces.context_limit.result, 'compatible');
  assert.equal(bundle.selector_calibration_delta.surfaces.resource_input.result, 'incompatible');
  assert.ok(bundle.selector_calibration_delta.surfaces.resource_input.delta_codes.includes('NO_STRUCTURAL_CANDIDATE'));
  assert.ok(bundle.selector_calibration_delta.surfaces.resource_input.delta_codes.includes('TYPE_MISMATCH'));
  const serialized = JSON.stringify(bundle.selector_calibration_delta);
  assert.equal(serialized.includes('TOP SECRET RESOURCE CONTROL'), false);
  assert.equal(serialized.includes('secret.invalid'), false);
});

test('validation handoff embeds selector remediation plan without changing release semantics', () => {
  const input = {
    calibration: {
      surfaces: {
        context_limit: { pass_count: 1, total_runs: 1, latest_status: 'pass', latest_fingerprints: [] },
        patch_candidates: { pass_count: 1, total_runs: 1, latest_status: 'pass', latest_fingerprints: [] },
        project_create: {
          pass_count: 1,
          total_runs: 2,
          latest_status: 'incompatible',
          latest_fingerprints: [{
            tag: 'div', role: 'region', type: null,
            test_id_category: 'present_unknown', name_category: 'absent',
            semantic_hint: 'unknown', ancestor_roles: []
          }]
        },
        project_settings: { pass_count: 1, total_runs: 1, latest_status: 'pass', latest_fingerprints: [] },
        resource_input: { pass_count: 1, total_runs: 1, latest_status: 'pass', latest_fingerprints: [] },
        project_delete: { pass_count: 1, total_runs: 1, latest_status: 'pass', latest_fingerprints: [] }
      }
    },
    resourceEvidence: { passed_runs: 1 },
    remoteEvidence: { passed_runs: 1 },
    remoteProduction: { enabled: true, passed_runs: 1, patch_transfer_mode: 'remote' },
    remotePreflight: { ready_for_remote_e2e: true },
    releaseReadiness: {}
  };

  const report = buildValidationHandoffBundle(input, {
    now: () => new Date('2026-08-14T08:45:00.000Z')
  });

  assert.equal(report.selector_remediation_plan.generated_at, report.generated_at);
  assert.equal(report.selector_remediation_plan.version, 1);
  assert.equal(report.selector_remediation_plan.surfaces.project_create.status, 'review_required');
  assert.ok(report.selector_remediation_plan.surfaces.project_create.action_codes.includes('REVIEW_SURFACE_CONTRACT'));
  assert.equal(report.next_action, 'CALIBRATE_UI');
  assert.equal(report.ready_for_release_review, false);
  assert.ok(report.release.blockers.includes('CALIBRATION_NEEDS_REVIEW'));
});
