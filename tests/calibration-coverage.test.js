import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALIBRATION_REVIEW_SURFACES,
  buildCalibrationCoverage
} from '../src/shared/calibration-coverage.js';

function surface({ total = 1, pass = 0, unavailable = 0, incompatible = 0, latest = null, page = 'chat' } = {}) {
  return {
    total_runs: total,
    pass_count: pass,
    unavailable_count: unavailable,
    incompatible_count: incompatible,
    latest_status: latest,
    latest_page_category: page,
    last_seen_at: '2026-08-14T03:00:00.000Z',
    secret: 'TOP-SECRET'
  };
}

function summary(overrides = {}) {
  return {
    version: 1,
    total_runs: 7,
    selector_profiles: [{ id: 'chatgpt-semantic-v1', version: 1, secret: 'DROP-ME' }],
    surfaces: {
      context_limit: surface({ unavailable: 1, latest: 'unavailable' }),
      patch_candidates: surface({ pass: 1, latest: 'pass' }),
      project_create: surface({ pass: 1, latest: 'unavailable' }),
      project_settings: surface({ pass: 1, incompatible: 1, total: 2, latest: 'incompatible', page: 'project' }),
      resource_input: surface({ pass: 1, latest: 'pass' }),
      project_delete: surface({ pass: 1, latest: 'pass', page: 'project' }),
      composer: surface({ pass: 99, total: 99, latest: 'pass' })
    },
    recent_runs: [{ secret: 'RECENT-SECRET', url: 'https://secret.invalid/?token=abc' }],
    arbitrary: 'ARBITRARY-SECRET',
    ...overrides
  };
}

test('calibration coverage uses only the fixed open selector-calibration surfaces', () => {
  assert.deepEqual(CALIBRATION_REVIEW_SURFACES, [
    'context_limit',
    'patch_candidates',
    'project_create',
    'project_settings',
    'resource_input',
    'project_delete'
  ]);

  const report = buildCalibrationCoverage(summary(), { now: () => new Date('2026-08-14T04:00:00.000Z') });
  assert.equal(report.required_count, 6);
  assert.equal(report.covered_count, 4);
  assert.equal(report.needs_review_count, 1);
  assert.equal(report.missing_pass_count, 1);
  assert.equal(report.ready_for_review, false);
  assert.equal(report.surfaces.context_limit.coverage, 'missing_pass');
  assert.equal(report.surfaces.patch_candidates.coverage, 'covered');
  assert.equal(report.surfaces.project_create.coverage, 'covered');
  assert.equal(report.surfaces.project_settings.coverage, 'needs_review');
  assert.equal('composer' in report.surfaces, false);
});

test('historical pass plus latest unavailable stays covered while latest incompatible requires review', () => {
  const report = buildCalibrationCoverage(summary());
  assert.equal(report.surfaces.project_create.pass_count, 1);
  assert.equal(report.surfaces.project_create.latest_status, 'unavailable');
  assert.equal(report.surfaces.project_create.coverage, 'covered');
  assert.equal(report.surfaces.project_settings.pass_count, 1);
  assert.equal(report.surfaces.project_settings.latest_status, 'incompatible');
  assert.equal(report.surfaces.project_settings.coverage, 'needs_review');
});

test('all six required surfaces with pass evidence and no latest incompatible are ready for review', () => {
  const surfaces = Object.fromEntries(CALIBRATION_REVIEW_SURFACES.map(id => [id, surface({ pass: 1, latest: id === 'context_limit' ? 'unavailable' : 'pass' })]));
  const report = buildCalibrationCoverage(summary({ surfaces }));
  assert.equal(report.covered_count, 6);
  assert.equal(report.needs_review_count, 0);
  assert.equal(report.missing_pass_count, 0);
  assert.equal(report.ready_for_review, true);
});

test('handoff report is a fixed privacy-safe projection of the ledger', () => {
  const report = buildCalibrationCoverage(summary(), { now: () => new Date('2026-08-14T04:00:00.000Z') });
  assert.equal(report.version, 1);
  assert.equal(report.generated_at, '2026-08-14T04:00:00.000Z');
  assert.deepEqual(report.selector_profiles, [{ id: 'chatgpt-semantic-v1', version: 1 }]);
  assert.equal('recent_runs' in report, false);
  assert.equal('last_run' in report, false);
  const serialized = JSON.stringify(report).toLowerCase();
  for (const secret of ['top-secret', 'drop-me', 'recent-secret', 'secret.invalid', 'token=', 'arbitrary-secret', 'composer']) {
    assert.equal(serialized.includes(secret), false, `report leaked ${secret}`);
  }
});
