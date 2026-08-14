import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SELECTOR_CALIBRATION_DELTA_CODES,
  buildSelectorCalibrationDelta
} from '../src/shared/selector-calibration-delta.js';

function fp(overrides = {}) {
  return {
    tag: 'button',
    role: 'button',
    type: 'button',
    test_id_category: 'present_unknown',
    name_category: 'absent',
    semantic_hint: 'unknown',
    ancestor_roles: ['menu'],
    ...overrides
  };
}

function calibration(overrides = {}) {
  return {
    surfaces: {
      context_limit: { fingerprints: [] },
      patch_candidates: { fingerprints: [] },
      project_create: { fingerprints: [] },
      project_settings: { fingerprints: [] },
      resource_input: { fingerprints: [] },
      project_delete: { fingerprints: [] },
      ...overrides
    }
  };
}

test('selector delta marks a structurally matching resource input compatible', () => {
  const report = buildSelectorCalibrationDelta(calibration({
    resource_input: {
      fingerprints: [fp({ tag: 'input', role: null, type: 'file', semantic_hint: 'attach' })]
    }
  }), { now: () => new Date('2026-08-14T08:00:00.000Z') });

  const surface = report.surfaces.resource_input;
  assert.equal(report.version, 1);
  assert.equal(report.contract_version, 1);
  assert.equal(surface.result, 'compatible');
  assert.equal(surface.candidate_count, 1);
  assert.equal(surface.structural_match_count, 1);
  assert.deepEqual(surface.delta_codes, []);
});

test('selector delta separates missing evidence from structural mismatch', () => {
  const report = buildSelectorCalibrationDelta(calibration({
    project_create: { fingerprints: [] },
    resource_input: { fingerprints: [fp({ tag: 'button', role: 'button', type: 'button' })] }
  }));

  assert.equal(report.surfaces.project_create.result, 'missing_evidence');
  assert.deepEqual(report.surfaces.project_create.delta_codes, [
    SELECTOR_CALIBRATION_DELTA_CODES.NO_FINGERPRINT_EVIDENCE
  ]);

  assert.equal(report.surfaces.resource_input.result, 'incompatible');
  assert.equal(report.surfaces.resource_input.structural_match_count, 0);
  assert.ok(report.surfaces.resource_input.delta_codes.includes(SELECTOR_CALIBRATION_DELTA_CODES.NO_STRUCTURAL_CANDIDATE));
  assert.ok(report.surfaces.resource_input.delta_codes.includes(SELECTOR_CALIBRATION_DELTA_CODES.TAG_MISMATCH));
  assert.ok(report.surfaces.resource_input.delta_codes.includes(SELECTOR_CALIBRATION_DELTA_CODES.TYPE_MISMATCH));
});

test('selector delta flags multiple structural matches without inventing a selector', () => {
  const report = buildSelectorCalibrationDelta(calibration({
    project_settings: {
      fingerprints: [
        fp({ semantic_hint: 'project_settings' }),
        fp({ role: 'menuitem', semantic_hint: 'project_settings' })
      ]
    }
  }));

  const surface = report.surfaces.project_settings;
  assert.equal(surface.result, 'needs_review');
  assert.equal(surface.structural_match_count, 2);
  assert.ok(surface.delta_codes.includes(SELECTOR_CALIBRATION_DELTA_CODES.MULTIPLE_STRUCTURAL_MATCHES));
  assert.equal(JSON.stringify(report).includes('button['), false);
  assert.equal(JSON.stringify(report).includes('css'), false);
  assert.equal(JSON.stringify(report).includes('xpath'), false);
});

test('selector delta emits soft machine-id and semantic changes while keeping structural compatibility', () => {
  const report = buildSelectorCalibrationDelta(calibration({
    project_delete: {
      fingerprints: [fp({
        semantic_hint: 'unknown',
        test_id_category: 'present_unknown',
        name_category: 'present_unknown'
      })]
    }
  }));

  const surface = report.surfaces.project_delete;
  assert.equal(surface.result, 'compatible_with_changes');
  assert.equal(surface.structural_match_count, 1);
  assert.ok(surface.delta_codes.includes(SELECTOR_CALIBRATION_DELTA_CODES.MACHINE_ID_CATEGORY_CHANGED));
  assert.ok(surface.delta_codes.includes(SELECTOR_CALIBRATION_DELTA_CODES.SEMANTIC_HINT_MISMATCH));
});

test('selector delta sanitizes hostile fingerprints and emits only fixed fields', () => {
  const secret = 'SECRET_PROJECT_ALPHA https://example.test/private?token=abc';
  const report = buildSelectorCalibrationDelta(calibration({
    patch_candidates: {
      fingerprints: [{
        tag: 'a',
        role: 'link',
        type: null,
        test_id_category: 'patch_download',
        name_category: 'absent',
        semantic_hint: 'patch_download',
        ancestor_roles: ['main'],
        text: secret,
        href: secret,
        outerHTML: secret,
        token: secret,
        selector: `a[href="${secret}"]`
      }]
    }
  }));

  const json = JSON.stringify(report);
  assert.equal(json.includes(secret), false);
  assert.equal(json.includes('outerHTML'), false);
  assert.equal(json.includes('selector'), false);
  assert.deepEqual(Object.keys(report.surfaces.patch_candidates).sort(), [
    'candidate_count', 'delta_codes', 'result', 'structural_match_count'
  ]);
});
