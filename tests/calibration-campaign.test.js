import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALIBRATION_CAMPAIGN_STAGES,
  buildCalibrationCampaign
} from '../src/shared/calibration-campaign.js';

function surface({ total = 0, pass = 0, unavailable = 0, incompatible = 0, latest = null, page = null, fingerprints = [] } = {}) {
  return {
    total_runs: total,
    pass_count: pass,
    unavailable_count: unavailable,
    incompatible_count: incompatible,
    latest_status: latest,
    latest_page_category: page,
    latest_fingerprints: fingerprints,
    text: 'TOP-SECRET-CHAT',
    href: 'https://secret.invalid/?token=abc',
    filename: 'secret.patch'
  };
}

function summary(overrides = {}) {
  return {
    version: 1,
    total_runs: 4,
    surfaces: {
      project_create: surface({ total: 1, pass: 1, latest: 'pass', page: 'home' }),
      project_settings: surface({ total: 2, pass: 1, incompatible: 1, latest: 'incompatible', page: 'project', fingerprints: [{ tag: 'button', text: 'DO-NOT-LEAK' }] }),
      resource_input: surface({ total: 1, latest: 'unavailable', unavailable: 1, page: 'project' }),
      patch_candidates: surface(),
      context_limit: surface(),
      project_delete: surface()
    },
    recent_runs: [{ prompt: 'SECRET-PROMPT' }],
    arbitrary: 'DROP-ME',
    ...overrides
  };
}

test('campaign uses a fixed workflow-oriented stage order and fixed instructions', () => {
  assert.deepEqual(CALIBRATION_CAMPAIGN_STAGES, [
    { id: 'project_create', instruction_code: 'SHOW_PROJECT_CREATE_CONTROL', expected_page_categories: ['home', 'chat', 'project'] },
    { id: 'project_settings', instruction_code: 'OPEN_PROJECT_SETTINGS_CONTROL', expected_page_categories: ['project'] },
    { id: 'resource_input', instruction_code: 'SHOW_RESOURCE_INPUT_CONTROL', expected_page_categories: ['chat', 'project'] },
    { id: 'patch_candidates', instruction_code: 'SHOW_ASSISTANT_PATCH_CONTROL', expected_page_categories: ['chat', 'project'] },
    { id: 'context_limit', instruction_code: 'SHOW_CONTEXT_LIMIT_STATE', expected_page_categories: ['chat', 'project'] },
    { id: 'project_delete', instruction_code: 'OPEN_PROJECT_DELETE_CONTROL', expected_page_categories: ['home', 'chat', 'project'] }
  ]);
});

test('latest incompatible becomes needs_review and blocks campaign progress even with historical pass', () => {
  const campaign = buildCalibrationCampaign(summary(), { now: () => new Date('2026-08-14T08:00:00.000Z') });
  assert.equal(campaign.version, 1);
  assert.equal(campaign.generated_at, '2026-08-14T08:00:00.000Z');
  assert.equal(campaign.completed_count, 1);
  assert.equal(campaign.required_count, 6);
  assert.equal(campaign.complete, false);
  assert.equal(campaign.current_stage_id, 'project_settings');
  assert.equal(campaign.next_action, 'REVIEW_CURRENT_STAGE');
  assert.equal(campaign.stages[0].status, 'observed');
  assert.equal(campaign.stages[1].status, 'needs_review');
  assert.equal(campaign.stages[1].pass_count, 1);
  assert.equal(campaign.stages[1].fingerprint_count, 1);
  assert.equal(campaign.stages[2].status, 'pending');
});

test('historical pass with latest unavailable remains observed and campaign advances to first pending stage', () => {
  const input = summary();
  input.surfaces.project_settings = surface({ total: 2, pass: 1, unavailable: 1, latest: 'unavailable', page: 'project' });
  input.surfaces.resource_input = surface({ total: 2, pass: 1, unavailable: 1, latest: 'unavailable', page: 'project' });
  const campaign = buildCalibrationCampaign(input);
  assert.equal(campaign.completed_count, 3);
  assert.equal(campaign.current_stage_id, 'patch_candidates');
  assert.equal(campaign.next_action, 'CAPTURE_CURRENT_STAGE');
  assert.equal(campaign.stages[1].status, 'observed');
  assert.equal(campaign.stages[2].status, 'observed');
});

test('all six observed stages complete the campaign without carrying arbitrary ledger data', () => {
  const surfaces = Object.fromEntries(CALIBRATION_CAMPAIGN_STAGES.map(({ id }) => [id, surface({ total: 2, pass: 1, unavailable: 1, latest: 'unavailable', page: id.includes('project') ? 'project' : 'chat' })]));
  const campaign = buildCalibrationCampaign(summary({ surfaces }));
  assert.equal(campaign.completed_count, 6);
  assert.equal(campaign.complete, true);
  assert.equal(campaign.current_stage_id, null);
  assert.equal(campaign.next_action, 'CAMPAIGN_COMPLETE');
  const serialized = JSON.stringify(campaign).toLowerCase();
  for (const secret of ['top-secret', 'secret.invalid', 'token=', 'secret.patch', 'secret-prompt', 'drop-me', 'do-not-leak']) {
    assert.equal(serialized.includes(secret), false, `campaign leaked ${secret}`);
  }
  assert.equal('recent_runs' in campaign, false);
});
