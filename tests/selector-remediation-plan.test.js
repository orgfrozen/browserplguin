import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SELECTOR_REMEDIATION_ACTIONS,
  buildSelectorRemediationPlan
} from '../src/shared/selector-remediation-plan.js';

function delta(overrides = {}) {
  const empty = { result: 'compatible', candidate_count: 1, structural_match_count: 1, delta_codes: [] };
  return {
    version: 1,
    contract_version: 1,
    surfaces: {
      context_limit: { ...empty },
      patch_candidates: { ...empty },
      project_create: { ...empty },
      project_settings: { ...empty },
      resource_input: { ...empty },
      project_delete: { ...empty },
      ...overrides
    }
  };
}

test('remediation plan maps missing evidence to collect-more-evidence without selector output', () => {
  const report = buildSelectorRemediationPlan(delta({
    project_create: {
      result: 'missing_evidence',
      candidate_count: 0,
      structural_match_count: 0,
      delta_codes: ['NO_FINGERPRINT_EVIDENCE']
    }
  }), { now: () => new Date('2026-08-14T08:30:00.000Z') });

  const surface = report.surfaces.project_create;
  assert.equal(report.version, 1);
  assert.equal(report.generated_at, '2026-08-14T08:30:00.000Z');
  assert.equal(surface.status, 'collect_evidence');
  assert.deepEqual(surface.action_codes, [SELECTOR_REMEDIATION_ACTIONS.COLLECT_MORE_EVIDENCE]);
  assert.deepEqual(surface.review_targets, [
    'selector_profile.patterns.project.newProject',
    'selector_profile.selectors.semanticButtons'
  ]);
  const json = JSON.stringify(report);
  assert.equal(json.includes('button['), false);
  assert.equal(json.toLowerCase().includes('xpath'), false);
  assert.equal(json.toLowerCase().includes('regex'), false);
});

test('remediation plan maps hard structural deltas to review-required actions', () => {
  const report = buildSelectorRemediationPlan(delta({
    resource_input: {
      result: 'incompatible',
      candidate_count: 1,
      structural_match_count: 0,
      delta_codes: ['NO_STRUCTURAL_CANDIDATE', 'TAG_MISMATCH', 'TYPE_MISMATCH']
    }
  }));

  const surface = report.surfaces.resource_input;
  assert.equal(surface.status, 'review_required');
  assert.deepEqual(surface.action_codes, [
    SELECTOR_REMEDIATION_ACTIONS.REVIEW_SURFACE_CONTRACT,
    SELECTOR_REMEDIATION_ACTIONS.RETUNE_TAG_FILTER,
    SELECTOR_REMEDIATION_ACTIONS.RETUNE_TYPE_FILTER
  ]);
  assert.deepEqual(surface.review_targets, ['selector_profile.selectors.fileInputs']);
});

test('remediation plan separates soft retuning from ambiguity review', () => {
  const report = buildSelectorRemediationPlan(delta({
    project_settings: {
      result: 'compatible_with_changes',
      candidate_count: 1,
      structural_match_count: 1,
      delta_codes: ['MACHINE_ID_CATEGORY_CHANGED', 'SEMANTIC_HINT_MISMATCH', 'ANCESTOR_CONTEXT_CHANGED']
    },
    project_delete: {
      result: 'needs_review',
      candidate_count: 2,
      structural_match_count: 2,
      delta_codes: ['MULTIPLE_STRUCTURAL_MATCHES']
    }
  }));

  assert.equal(report.surfaces.project_settings.status, 'actionable');
  assert.deepEqual(report.surfaces.project_settings.action_codes, [
    SELECTOR_REMEDIATION_ACTIONS.RETUNE_MACHINE_ID_FILTER,
    SELECTOR_REMEDIATION_ACTIONS.RETUNE_SEMANTIC_HINT,
    SELECTOR_REMEDIATION_ACTIONS.RETUNE_ANCESTOR_CONTEXT
  ]);
  assert.equal(report.surfaces.project_delete.status, 'review_required');
  assert.deepEqual(report.surfaces.project_delete.action_codes, [
    SELECTOR_REMEDIATION_ACTIONS.ADD_DISAMBIGUATION_CONTEXT
  ]);
});

test('remediation plan exposes fixed code-owned targets for non-registry surfaces', () => {
  const report = buildSelectorRemediationPlan(delta({
    context_limit: { result: 'incompatible', delta_codes: ['ROLE_MISMATCH'] },
    patch_candidates: { result: 'compatible_with_changes', delta_codes: ['SEMANTIC_HINT_MISMATCH'] }
  }));

  assert.deepEqual(report.surfaces.context_limit.review_targets, [
    'conversation_manager.context_limit_detection',
    'calibration_matrix.context_limit_scope'
  ]);
  assert.deepEqual(report.surfaces.patch_candidates.review_targets, [
    'artifact_observer.patch_candidate_detection',
    'calibration_matrix.patch_candidate_scope'
  ]);
});

test('remediation plan ignores hostile and unknown input while preserving no-change surfaces', () => {
  const secret = 'SECRET_PROJECT_ALPHA https://example.test/private?token=abc';
  const report = buildSelectorRemediationPlan(delta({
    project_create: {
      result: secret,
      delta_codes: ['UNKNOWN_FREEFORM_CODE', 'ROLE_MISMATCH'],
      selector: `button[data-secret="${secret}"]`,
      recommendation: secret,
      regex: secret,
      css: secret
    }
  }));

  assert.equal(report.surfaces.project_create.status, 'review_required');
  assert.deepEqual(report.surfaces.project_create.action_codes, [SELECTOR_REMEDIATION_ACTIONS.RETUNE_ROLE_FILTER]);
  assert.equal(report.surfaces.context_limit.status, 'no_change');
  assert.deepEqual(report.surfaces.context_limit.action_codes, []);
  const json = JSON.stringify(report);
  assert.equal(json.includes(secret), false);
  assert.equal(json.includes('UNKNOWN_FREEFORM_CODE'), false);
  assert.equal(json.includes('selector'), true); // fixed target identifiers may contain the word selector
  assert.equal(json.includes('data-secret'), false);
  assert.equal(json.includes('recommendation'), false);
  assert.equal(json.includes('css'), false);
});
