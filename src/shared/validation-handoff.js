import { sanitizeCalibrationFingerprints } from './calibration-fingerprint.js';
import { buildSelectorCalibrationDelta } from './selector-calibration-delta.js';
import { buildSelectorRemediationPlan } from './selector-remediation-plan.js';

const REVIEW_SURFACES = Object.freeze([
  'context_limit',
  'patch_candidates',
  'new_chat',
  'project_create',
  'project_settings',
  'resource_input',
  'project_delete',
  'conversation_delete'
]);

const COVERAGES = new Set(['covered', 'needs_review', 'missing_pass']);
const CALIBRATION_STATUSES = new Set(['pass', 'unavailable', 'incompatible']);
const PAGE_CATEGORIES = new Set(['home', 'chat', 'project', 'login', 'challenge', 'other']);
const E2E_RESULTS = new Set(['passed', 'failed', 'incomplete']);
const RESOURCE_FAILURE_STAGES = new Set(['permission', 'download', 'attachment', 'initialization_prompt', 'initialization_persist', 'recovery', 'none']);
const REMOTE_FAILURE_STAGES = new Set(['remote_transfer', 'artifact_report', 'cleanup', 'terminal', 'task_result', 'recovery', 'none']);
const REMOTE_PREFLIGHT_BLOCKERS = new Set([
  'MODE_NOT_REAL',
  'TASK_API_URL_INVALID',
  'TASK_API_PERMISSION_MISSING',
  'NATIVE_MESSAGING_PERMISSION_MISSING',
  'NATIVE_HELPER_UNAVAILABLE',
  'HELPER_READ_PATCH_FILE_MISSING',
  'HELPER_CHUNKED_MISSING',
  'HELPER_MAX_PATCH_BYTES_INSUFFICIENT'
]);
const RELEASE_BLOCKERS = new Set([
  'CALIBRATION_INCOMPLETE',
  'CALIBRATION_NEEDS_REVIEW',
  'RESOURCE_E2E_REQUIRED',
  'REMOTE_E2E_REQUIRED',
  'REMOTE_PRODUCTION_REQUIRED',
  'REMOTE_PREFLIGHT_BLOCKED'
]);

export const VALIDATION_NEXT_ACTIONS = Object.freeze({
  CALIBRATE_UI: 'CALIBRATE_UI',
  RUN_RESOURCE_E2E: 'RUN_RESOURCE_E2E',
  FIX_REMOTE_PREFLIGHT: 'FIX_REMOTE_PREFLIGHT',
  RUN_REMOTE_E2E: 'RUN_REMOTE_E2E',
  PROMOTE_REMOTE: 'PROMOTE_REMOTE',
  RELEASE_REVIEW: 'RELEASE_REVIEW'
});

function safeCount(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function safeEnum(value, allowed, fallback = null) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

function safeTimestamp(value) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)) return null;
  return Number.isNaN(Date.parse(text)) ? null : text;
}

function safeProfiles(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const id = String(value?.id ?? '');
    const version = value?.version;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id) || !Number.isInteger(version) || version < 1 || version > 10000) continue;
    const key = `${id}|${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ id, version });
  }
  return result;
}

function projectCalibration(calibration) {
  const surfaces = {};
  let coveredCount = 0;
  let needsReviewCount = 0;
  let missingPassCount = 0;

  for (const id of REVIEW_SURFACES) {
    const source = calibration?.surfaces?.[id] ?? {};
    const passCount = safeCount(source.pass_count);
    const latestStatus = safeEnum(source.latest_status, CALIBRATION_STATUSES);
    let coverage = 'missing_pass';
    if (passCount > 0) coverage = latestStatus === 'incompatible' || latestStatus === null ? 'needs_review' : 'covered';

    surfaces[id] = {
      coverage,
      total_runs: safeCount(source.total_runs),
      pass_count: passCount,
      unavailable_count: safeCount(source.unavailable_count),
      incompatible_count: safeCount(source.incompatible_count),
      latest_status: latestStatus,
      latest_page_category: safeEnum(source.latest_page_category, PAGE_CATEGORIES),
      last_seen_at: safeTimestamp(source.last_seen_at),
      fingerprints: sanitizeCalibrationFingerprints(source.latest_fingerprints ?? source.fingerprints)
    };
    if (coverage === 'covered') coveredCount += 1;
    else if (coverage === 'needs_review') needsReviewCount += 1;
    else missingPassCount += 1;
  }

  return {
    ready_for_review: coveredCount === REVIEW_SURFACES.length,
    required_count: REVIEW_SURFACES.length,
    covered_count: coveredCount,
    needs_review_count: needsReviewCount,
    missing_pass_count: missingPassCount,
    total_recorded_runs: safeCount(calibration?.total_recorded_runs),
    selector_profiles: safeProfiles(calibration?.selector_profiles),
    surfaces
  };
}

function projectEvidence(summary, failureStages) {
  return {
    total_runs: safeCount(summary?.total_runs),
    passed_runs: safeCount(summary?.passed_runs),
    failed_runs: safeCount(summary?.failed_runs),
    incomplete_runs: safeCount(summary?.incomplete_runs),
    last_result: safeEnum(summary?.last_run?.result, E2E_RESULTS),
    last_failure_stage: safeEnum(summary?.last_run?.failure_stage, failureStages)
  };
}

function safeBlockers(values, allowed) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (!allowed.has(value) || result.includes(value)) continue;
    result.push(value);
  }
  return result;
}

export function buildValidationHandoffBundle({
  calibration = {},
  resourceEvidence = {},
  remoteEvidence = {},
  remoteProduction = {},
  remotePreflight = {},
  releaseReadiness = {}
} = {}, { now = () => new Date() } = {}) {
  const generatedAt = now().toISOString();
  const safeCalibration = projectCalibration(calibration);
  const selectorCalibrationDelta = buildSelectorCalibrationDelta(safeCalibration, {
    now: () => new Date(generatedAt)
  });
  const selectorRemediationPlan = buildSelectorRemediationPlan(selectorCalibrationDelta, {
    now: () => new Date(generatedAt)
  });
  const resource = projectEvidence(resourceEvidence, RESOURCE_FAILURE_STAGES);
  const remote = projectEvidence(remoteEvidence, REMOTE_FAILURE_STAGES);
  const productionEnabled = remoteProduction?.enabled === true;
  const preflightReady = remotePreflight?.ready_for_remote_e2e === true;

  const calibrationReady = safeCalibration.ready_for_review === true
    && safeCalibration.required_count === REVIEW_SURFACES.length
    && safeCalibration.covered_count === REVIEW_SURFACES.length
    && safeCalibration.needs_review_count === 0
    && safeCalibration.missing_pass_count === 0;

  let nextAction = VALIDATION_NEXT_ACTIONS.RELEASE_REVIEW;
  if (!calibrationReady) nextAction = VALIDATION_NEXT_ACTIONS.CALIBRATE_UI;
  else if (resource.passed_runs < 1) nextAction = VALIDATION_NEXT_ACTIONS.RUN_RESOURCE_E2E;
  else if (!preflightReady) nextAction = VALIDATION_NEXT_ACTIONS.FIX_REMOTE_PREFLIGHT;
  else if (remote.passed_runs < 1) nextAction = VALIDATION_NEXT_ACTIONS.RUN_REMOTE_E2E;
  else if (!productionEnabled) nextAction = VALIDATION_NEXT_ACTIONS.PROMOTE_REMOTE;

  const ready = nextAction === VALIDATION_NEXT_ACTIONS.RELEASE_REVIEW;
  const releaseBlockers = [];
  if (!calibrationReady && (safeCalibration.missing_pass_count > 0 || safeCalibration.covered_count < safeCalibration.required_count || safeCalibration.required_count === 0)) {
    releaseBlockers.push('CALIBRATION_INCOMPLETE');
  }
  if (safeCalibration.needs_review_count > 0) releaseBlockers.push('CALIBRATION_NEEDS_REVIEW');
  if (resource.passed_runs < 1) releaseBlockers.push('RESOURCE_E2E_REQUIRED');
  if (remote.passed_runs < 1) releaseBlockers.push('REMOTE_E2E_REQUIRED');
  if (!productionEnabled) releaseBlockers.push('REMOTE_PRODUCTION_REQUIRED');
  if (!preflightReady) releaseBlockers.push('REMOTE_PREFLIGHT_BLOCKED');

  return {
    version: 1,
    generated_at: generatedAt,
    next_action: nextAction,
    ready_for_release_review: ready,
    calibration: safeCalibration,
    selector_calibration_delta: selectorCalibrationDelta,
    selector_remediation_plan: selectorRemediationPlan,
    resource_e2e: resource,
    remote_e2e: remote,
    remote_production: {
      enabled: productionEnabled,
      eligible_evidence: remoteProduction?.eligible_evidence === true,
      passed_runs: safeCount(remoteProduction?.passed_runs),
      patch_transfer_mode: remoteProduction?.patch_transfer_mode === 'remote' ? 'remote' : 'local'
    },
    remote_preflight: {
      ready: preflightReady,
      checked_at: safeTimestamp(remotePreflight?.checked_at),
      blockers: safeBlockers(remotePreflight?.blockers, REMOTE_PREFLIGHT_BLOCKERS)
    },
    release: {
      status: ready ? 'ready_for_release_review' : 'blocked',
      blockers: safeBlockers(releaseBlockers, RELEASE_BLOCKERS)
    }
  };
}
