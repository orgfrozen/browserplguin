const STAGES = Object.freeze([
  Object.freeze({ id: 'new_chat', instruction_code: 'SHOW_NEW_CHAT_CONTROL', expected_page_categories: Object.freeze(['home', 'chat']) }),
  Object.freeze({ id: 'project_create', instruction_code: 'SHOW_PROJECT_CREATE_CONTROL', expected_page_categories: Object.freeze(['home', 'chat', 'project']) }),
  Object.freeze({ id: 'project_settings', instruction_code: 'OPEN_PROJECT_SETTINGS_CONTROL', expected_page_categories: Object.freeze(['project']) }),
  Object.freeze({ id: 'resource_input', instruction_code: 'SHOW_RESOURCE_INPUT_CONTROL', expected_page_categories: Object.freeze(['chat', 'project']) }),
  Object.freeze({ id: 'patch_candidates', instruction_code: 'SHOW_ASSISTANT_PATCH_CONTROL', expected_page_categories: Object.freeze(['chat', 'project']) }),
  Object.freeze({ id: 'context_limit', instruction_code: 'SHOW_CONTEXT_LIMIT_STATE', expected_page_categories: Object.freeze(['chat', 'project']) }),
  Object.freeze({ id: 'conversation_delete', instruction_code: 'OPEN_CONVERSATION_DELETE_CONTROL', expected_page_categories: Object.freeze(['home', 'chat']) }),
  Object.freeze({ id: 'project_delete', instruction_code: 'OPEN_PROJECT_DELETE_CONTROL', expected_page_categories: Object.freeze(['home', 'chat', 'project']) })
]);

const VALID_STATUSES = new Set(['pass', 'unavailable', 'incompatible']);
const VALID_PAGE_CATEGORIES = new Set(['home', 'chat', 'project', 'login', 'challenge', 'other']);

function safeCount(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function safeStatus(value) {
  const status = String(value ?? '').toLowerCase();
  return VALID_STATUSES.has(status) ? status : null;
}

function safePageCategory(value) {
  const category = String(value ?? '').toLowerCase();
  return VALID_PAGE_CATEGORIES.has(category) ? category : null;
}

function fingerprintCount(value) {
  return Math.min(3, Array.isArray(value) ? value.length : 0);
}

function buildStage(definition, source) {
  const passCount = safeCount(source?.pass_count);
  const latestStatus = safeStatus(source?.latest_status);
  let status = 'pending';
  if (latestStatus === 'incompatible') status = 'needs_review';
  else if (passCount > 0) status = 'observed';

  return {
    id: definition.id,
    instruction_code: definition.instruction_code,
    expected_page_categories: [...definition.expected_page_categories],
    status,
    total_runs: safeCount(source?.total_runs),
    pass_count: passCount,
    latest_status: latestStatus,
    latest_page_category: safePageCategory(source?.latest_page_category),
    fingerprint_count: fingerprintCount(source?.latest_fingerprints)
  };
}

export function buildCalibrationCampaign(summary, { now = () => new Date() } = {}) {
  const surfaces = summary?.surfaces && typeof summary.surfaces === 'object' ? summary.surfaces : {};
  const stages = STAGES.map(definition => buildStage(definition, surfaces[definition.id]));
  const completedCount = stages.filter(stage => stage.status === 'observed').length;
  const current = stages.find(stage => stage.status !== 'observed') ?? null;
  return {
    version: 1,
    generated_at: now().toISOString(),
    required_count: stages.length,
    completed_count: completedCount,
    complete: current === null,
    current_stage_id: current?.id ?? null,
    next_action: current === null ? 'CAMPAIGN_COMPLETE' : current.status === 'needs_review' ? 'REVIEW_CURRENT_STAGE' : 'CAPTURE_CURRENT_STAGE',
    stages
  };
}

export const CALIBRATION_CAMPAIGN_STAGES = STAGES;
